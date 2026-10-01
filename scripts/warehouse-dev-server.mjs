#!/usr/bin/env node
/* Local test server for the Fangs Warehouse page. Runs the real sql/warehouse migrations in
   an in-memory Postgres (PGlite) and answers the small part of the Supabase API the page uses
   (password sign-in, REST selects with eq filters, RPC calls, storage upload/public read).
   Nothing here talks to the live backend. Test accounts (password: warehouse-test-1):
     tyler@test.local  owner          jake@test.local  intake
     rev@test.local    fitment reviewer
   Usage: npm i --no-save @electric-sql/pglite && node scripts/warehouse-dev-server.mjs [port]
   Then open http://localhost:PORT/warehouse/  */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8787);
const PASSWORD = 'warehouse-test-1';
const db = new PGlite();
const files = new Map(); // "bucket/path" -> {type, body}

const USERS = {
  'tyler@test.local': '11111111-1111-4111-8111-111111111111',
  'jake@test.local': '22222222-2222-4222-8222-222222222222',
  'rev@test.local': '33333333-3333-4333-8333-333333333333',
};

async function setup() {
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text unique);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated; grant select, insert on storage.objects to authenticated;`);
  for (const [email, id] of Object.entries(USERS)) await db.query('insert into auth.users values ($1,$2)', [id, email]);
  for (const f of fs.readdirSync(path.join(root, 'sql/warehouse')).filter(f => /wh-\d{3}-(core|storage)\.sql$/.test(f)).sort()) {
    await db.exec(fs.readFileSync(path.join(root, 'sql/warehouse', f), 'utf8'));
  }
  await db.query(`select public.wh_bootstrap_owner('tyler@test.local', 'Tyler')`);
  await asUser(USERS['tyler@test.local'], async () => {
    await db.query(`select public.wh_set_staff('tyler@test.local','Tyler', array['owner','intake','listing_approver','fulfillment'])`);
    await db.query(`select public.wh_set_staff('jake@test.local','Jake', array['intake'])`);
    await db.query(`select public.wh_set_staff('rev@test.local','Rev', array['fitment_reviewer'])`);
    await db.query(`select public.wh_upsert_location('WH1',3,2,7)`);
  });
}

let chain = Promise.resolve();
function asUser(uid, fn) {  // serialize: PGlite has one connection
  const run = chain.then(async () => {
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid, role: 'authenticated' }) : '']);
    await db.exec(uid ? 'set role authenticated' : 'set role anon');
    try { return await fn(); } finally { await db.exec('reset role'); }
  });
  chain = run.catch(() => {});
  return run;
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = uid => `${b64({ alg: 'none' })}.${b64({ sub: uid, exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
const uidOf = req => { try { return JSON.parse(Buffer.from((req.headers.authorization || '').split(' ')[1].split('.')[1], 'base64url')).sub; } catch { return null; } };
const ident = s => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Object.assign(new Error('bad identifier'), { code: '400' }); return `"${s}"`; };
const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
  res.end(body === undefined ? '' : type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const pgErr = (res, e) => send(res, e.code === '42501' ? 403 : 400, { message: e.message, code: e.code });

async function rest(req, res, url) {
  const table = url.pathname.split('/')[3];
  const q = url.searchParams, where = [], params = [];
  let cols = '*', order = '', limit = '', offset = '';
  for (const [k, v] of q) {
    if (k === 'select') cols = v === '*' ? '*' : v.split(',').map(ident).join(',');
    else if (k === 'order') order = ' order by ' + v.split(',').map(p => { const [c, d] = p.split('.'); return ident(c) + (d === 'desc' ? ' desc' : ' asc'); }).join(',');
    else if (k === 'limit') limit = ` limit ${Number(v)}`;
    else if (k === 'offset') offset = ` offset ${Number(v)}`;
    else { const m = v.match(/^eq\.(.*)$/); if (!m) return send(res, 400, { message: `unsupported filter ${k}=${v}` }); params.push(m[1]); where.push(`${ident(k)}::text = $${params.length}`); }
  }
  const sql = `select ${cols} from public.${ident(table)}${where.length ? ' where ' + where.join(' and ') : ''}${order}${limit}${offset}`;
  try { send(res, 200, (await asUser(uidOf(req), () => db.query(sql, params))).rows); } catch (e) { pgErr(res, e); }
}

async function rpc(req, res, url) {
  const fn = url.pathname.split('/')[4];
  const args = JSON.parse((await readBody(req)).toString() || '{}');
  const meta = (await db.query(`select p.proretset, p.proargnames, array(select format_type(t, null) from unnest(p.proargtypes) t) types,
    (select typtype from pg_type where oid = p.prorettype) rettyp from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = $1 limit 1`, [fn])).rows[0];
  if (!meta) return send(res, 404, { message: `function ${fn} not found` });
  const names = Object.keys(args), vals = [], parts = names.map((k, i) => {
    const type = meta.types[(meta.proargnames || []).indexOf(k)] || 'text';
    const v = args[k];
    vals.push(v === null ? null : type === 'jsonb' ? JSON.stringify(v) : Array.isArray(v) ? `{${v.map(x => `"${String(x).replace(/"/g, '\\"')}"`).join(',')}}` : v);
    return `${ident(k)} => $${i + 1}::${type}`;
  });
  const call = `public.${ident(fn)}(${parts.join(', ')})`;
  try {
    const out = await asUser(uidOf(req), () => db.query(meta.proretset || meta.rettyp === 'c' ? `select * from ${call}` : `select ${call} as v`, vals));
    send(res, 200, meta.proretset ? out.rows : meta.rettyp === 'c' ? out.rows[0] : out.rows[0].v);
  } catch (e) { pgErr(res, e); }
}

async function storage(req, res, url) {
  const parts = decodeURIComponent(url.pathname).split('/').slice(3); // ['object', ...]
  if (req.method === 'GET' && parts[1] === 'public') {
    const [bucket, ...p] = parts.slice(2);
    const b = (await db.query('select public from storage.buckets where id = $1', [bucket])).rows[0];
    const f = files.get(`${bucket}/${p.join('/')}`);
    if (!b?.public || !f) return send(res, 404, { message: 'not found' });
    return send(res, 200, f.body, f.type);
  }
  if (req.method === 'POST') {
    const [bucket, ...p] = parts.slice(1), name = p.join('/'), body = await readBody(req);
    if (files.has(`${bucket}/${name}`)) return send(res, 409, { message: 'The resource already exists' });
    try { await asUser(uidOf(req), () => db.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [bucket, name])); }
    catch (e) { return send(res, 403, { message: 'new row violates row-level security policy' }); }
    files.set(`${bucket}/${name}`, { type: req.headers['content-type'], body });
    return send(res, 200, { Key: `${bucket}/${name}` });
  }
  send(res, 404, { message: 'not supported in dev server' });
}

async function auth(req, res, url) {
  const p = url.pathname;
  if (p === '/auth/v1/token') {
    const b = JSON.parse((await readBody(req)).toString() || '{}');
    let uid = null, email = null;
    if (url.searchParams.get('grant_type') === 'password') { email = b.email; uid = b.password === PASSWORD ? USERS[b.email] : null; }
    else { uid = Buffer.from(String(b.refresh_token || ''), 'base64url').toString(); email = Object.keys(USERS).find(k => USERS[k] === uid); }
    if (!uid) return send(res, 400, { error_description: 'Invalid login credentials' });
    return send(res, 200, { access_token: token(uid), refresh_token: Buffer.from(uid).toString('base64url'), token_type: 'bearer', expires_in: 3600, user: { id: uid, email } });
  }
  if (p === '/auth/v1/user') { const uid = uidOf(req); return uid ? send(res, 200, { id: uid, email: Object.keys(USERS).find(k => USERS[k] === uid) }) : send(res, 401, { msg: 'no' }); }
  if (p === '/auth/v1/logout') return send(res, 204);
  send(res, 404, {});
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
await setup();
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') return send(res, 204);
  try {
    if (url.pathname.startsWith('/rest/v1/rpc/')) return await rpc(req, res, url);
    if (url.pathname.startsWith('/rest/v1/')) return await rest(req, res, url);
    if (url.pathname.startsWith('/storage/v1/')) return await storage(req, res, url);
    if (url.pathname.startsWith('/auth/v1/')) return await auth(req, res, url);
    if (url.pathname === '/supabase-config.js') return send(res, 200, `window.SICC_RIDE_SUPABASE=Object.freeze({url:'http://localhost:${PORT}',anonKey:'dev'});`, 'text/javascript');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) return send(res, 403, {});
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) { send(res, 500, { message: e.message }); }
}).listen(PORT, () => console.log(`Fangs Warehouse dev server: http://localhost:${PORT}/warehouse/  (password ${PASSWORD})`));
