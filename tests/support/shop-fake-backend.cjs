// LOCAL TEST ONLY. A tiny stand-in for the Supabase server, used by
// tests/shop-e2e.test.cjs to drive the real shop page in a real browser.
// It runs the real sql/shop/*.sql in an in-process Postgres (PGlite) and
// executes every request as the signed-in user's role with their JWT claims,
// so the real row-level security and function permission checks decide what
// each user can see and do. It implements only the small subset of the
// Auth / PostgREST / Storage HTTP API that the shop page uses.
// This is NOT the production server and proves nothing about it.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const STUB = `
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text unique);
create function auth.uid() returns uuid language sql stable as $$
  select nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, unique (bucket_id, name));
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant select, insert, update on storage.objects to anon, authenticated;
`;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const ident = s => /^[a-z_][a-z0-9_]*$/.test(s);

async function startFakeBackend({ users, staff }) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(STUB);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql', '2026-10-30-shop-004-estimates.sql']) {
    await db.exec(fs.readFileSync(path.join(ROOT, 'sql', 'shop', f), 'utf8'));
  }
  const byEmail = new Map();
  for (const u of users) { u.id = u.id || crypto.randomUUID(); byEmail.set(u.email, u); await db.query('insert into auth.users values ($1, $2)', [u.id, u.email]); }
  for (const s of staff) await db.query('insert into public.shop_staff (user_id, display_name) values ($1, $2)', [byEmail.get(s.email).id, s.name]);

  const tokens = new Map(); const refresh = new Map(); const files = new Map();
  const stats = { requests: 0 };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  function issue(u) {
    const access = `${b64({ alg: 'none' })}.${b64({ sub: u.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, n: crypto.randomUUID() })}.x`;
    const rt = crypto.randomUUID(); tokens.set(access, u); refresh.set(rt, u);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, refresh_token: rt, user: { id: u.id, email: u.email } };
  }

  // One request at a time (single Postgres session).
  let queue = Promise.resolve();
  const serial = fn => (queue = queue.then(fn, fn));
  async function as(user, text, params) {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [user ? JSON.stringify({ sub: user.id, role: 'authenticated' }) : '']);
    await db.exec(user ? 'set role authenticated' : 'set role anon');
    try { return (await db.query(text, params)).rows; } finally { await db.exec('reset role'); }
  }

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body === undefined ? '' : (Buffer.isBuffer(body) || typeof body === 'string') ? body : JSON.stringify(body));
  };
  const pgError = (res, e) => {
    const msg = e.message || String(e);
    send(res, /permission denied|row-level security/.test(msg) ? 403 : 400, { message: msg, code: e.code });
  };
  const readBody = req => new Promise((ok, bad) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', bad); });

  async function handle(req, res) {
    stats.requests++;
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const user = tokens.get(bearer) || null;

    if (p === '/auth/v1/token') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (url.searchParams.get('grant_type') === 'password') {
        const u = byEmail.get(String(body.email || '').toLowerCase());
        if (!u || u.password !== body.password) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return send(res, 200, issue(u));
      }
      const u = refresh.get(body.refresh_token);
      if (!u) return send(res, 400, { error_description: 'Invalid Refresh Token' });
      refresh.delete(body.refresh_token); return send(res, 200, issue(u));
    }
    if (p === '/auth/v1/user') return user ? send(res, 200, { id: user.id, email: user.email }) : send(res, 401, { msg: 'invalid JWT' });
    if (p === '/auth/v1/logout') { tokens.delete(bearer); return send(res, 204); }
    if (bearer && !user && (p.startsWith('/rest/') || p.startsWith('/storage/'))) return send(res, 401, { message: 'JWT expired' });

    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.slice('/rest/v1/rpc/'.length);
      if (!ident(fn)) return send(res, 404, { message: 'not found' });
      const args = JSON.parse((await readBody(req)).toString() || '{}');
      return serial(async () => {
        const meta = (await db.query(`select proargnames as names, array(select format_type(t, null) from unnest(proargtypes) t) as types
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname = $1`, [fn])).rows[0];
        if (!meta) return send(res, 404, { message: `function ${fn} not found` });
        const names = meta.names || []; const keys = Object.keys(args);
        if (keys.some(k => !names.includes(k))) return send(res, 400, { message: 'unknown argument' });
        const params = keys.map(k => { const v = args[k]; return v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v); });
        const call = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}::${meta.types[names.indexOf(k)]}`).join(', ')}) as r`;
        try { const rows = await as(user, call, params); send(res, 200, rows[0].r === undefined ? null : rows[0].r); }
        catch (e) { pgError(res, e); }
      });
    }
    if (p.startsWith('/rest/v1/')) {
      const table = p.slice('/rest/v1/'.length);
      if (!ident(table) || req.method !== 'GET') return send(res, 404, { message: 'not found' });
      const cols = (url.searchParams.get('select') || '*').split(',');
      if (!cols.every(c => c === '*' || ident(c))) return send(res, 400, { message: 'bad select' });
      const where = []; const params = []; let order = '';
      for (const [k, v] of url.searchParams) {
        if (k === 'select') continue;
        if (k === 'order') {
          const parts = v.split(',').map(o => o.split('.'));
          if (!parts.every(([c, d]) => ident(c) && (!d || d === 'asc' || d === 'desc'))) return send(res, 400, { message: 'bad order' });
          order = ' order by ' + parts.map(([c, d]) => `${c} ${d || 'asc'}`).join(', ');
        } else if (ident(k) && v.startsWith('eq.')) { params.push(v.slice(3)); where.push(`${k}::text = $${params.length}`); }
        else return send(res, 400, { message: 'unsupported filter' });
      }
      return serial(async () => {
        try { send(res, 200, await as(user, `select ${cols.join(', ')} from public.${table}${where.length ? ' where ' + where.join(' and ') : ''}${order}`, params)); }
        catch (e) { pgError(res, e); }
      });
    }
    let m = /^\/storage\/v1\/object\/authenticated\/([^/]+)\/(.+)$/.exec(p);
    if (m && req.method === 'GET') {
      return serial(async () => {
        try {
          const rows = await as(user, 'select name from storage.objects where bucket_id = $1 and name = $2', [m[1], m[2]]);
          const f = files.get(`${m[1]}/${m[2]}`);
          if (!rows.length || !f) return send(res, 400, { message: 'Object not found' });
          send(res, 200, f.data, f.type);
        } catch (e) { pgError(res, e); }
      });
    }
    m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(p);
    if (m && req.method === 'POST') {
      const data = await readBody(req);
      return serial(async () => {
        try {
          await as(user, 'insert into storage.objects (bucket_id, name) values ($1, $2)', [m[1], m[2]]);
          files.set(`${m[1]}/${m[2]}`, { data, type: req.headers['content-type'] });
          send(res, 200, { Key: `${m[1]}/${m[2]}` });
        } catch (e) { pgError(res, e); }
      });
    }
    if (m && req.method === 'GET') return send(res, 400, { message: 'Bucket is not public' });

    // Static files from the repo. supabase-config.js is replaced so the page
    // talks to this fake backend instead of production.
    if (p === '/supabase-config.js') {
      return send(res, 200, `window.SICC_RIDE_SUPABASE = Object.freeze({ url: location.origin, anonKey: 'local-test-anon-key' });`, MIME['.js']);
    }
    const file = path.normalize(path.join(ROOT, p.endsWith('/') ? p + 'index.html' : p));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  }

  const server = http.createServer((req, res) => handle(req, res).catch(e => { try { send(res, 500, { message: e.message }); } catch { /* closed */ } }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, db, stats, files, sessionFor: email => issue(byEmail.get(email)),
    sql: (text, params) => serial(async () => { await db.exec('reset role'); return (await db.query(text, params)).rows; }),
    close: async () => { await new Promise(ok => server.close(ok)); await db.close(); },
  };
}

module.exports = { startFakeBackend };
