// shop-016 database tests (PGlite): Parts on order (tracking, ETA, received) and
// the Closed folder (close / reopen an estimate). Same harness as shop-sql.test.cjs.
// Needs PGlite: `npm i --no-save @electric-sql/pglite`. Skipped without it.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let PGlite = null;
try { require.resolve('@electric-sql/pglite'); PGlite = true; } catch { /* skipped below */ }
const skip = PGlite ? false : 'PGlite not installed (npm i --no-save @electric-sql/pglite)';

const sql = f => fs.readFileSync(path.join(__dirname, '..', 'sql', 'shop', f), 'utf8');
const U = {
  tyler: '00000000-0000-4000-9000-000000000001',
  garrett: '00000000-0000-4000-9000-000000000002',
  rider: '00000000-0000-4000-9000-000000000003',
};
let db;

const STUB = `
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text unique);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant select, insert, update on storage.objects to anon, authenticated;
`;

async function as(user, text, params) {
  await db.exec('reset role');
  if (user) {
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U[user], role: 'authenticated' })]);
    await db.exec('set role authenticated');
  } else {
    await db.query(`select set_config('request.jwt.claims', '', false)`);
    await db.exec('set role anon');
  }
  try { return (await db.query(text, params)).rows; } finally { await db.exec('reset role'); }
}
const rpc = async (user, fn, args) => {
  const keys = Object.keys(args);
  const call = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  return (await as(user, call, keys.map(k => args[k])))[0].r;
};
const rejects = (p, re) => assert.rejects(p, re);

before(async () => {
  if (skip) return;
  const { PGlite: PG } = await import('@electric-sql/pglite');
  db = new PG();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql', '2026-10-30-shop-004-estimates.sql', '2026-11-15-shop-006-payment-status.sql']) await db.exec(sql(f));
  // an existing part order from before shop-016 keeps working
  await db.query(`insert into public.shop_part_orders (id, part_description, cost, created_by, updated_by) values ('old1', 'Fork seals', 29, $1, $1)`, [U.tyler]);
  await db.exec(sql('2026-11-26-shop-016-parts-on-order-closed.sql'));
  await db.exec(sql('2026-11-26-shop-016-parts-on-order-closed.sql')); // re-running is safe
  await db.query(`insert into public.shop_staff (user_id, display_name) values ($1, 'Tyler'), ($2, 'Garrett')`, [U.tyler, U.garrett]);
});

let seq = 0;
const newEstimate = async name => {
  const id = `job${++seq}`;
  await db.query(`insert into public.shop_customers (id, name, created_by, updated_by) values ($1, $2, $3, $3)`, [`c${id}`, name, U.tyler]);
  await db.query(`insert into public.shop_jobs (id, customer_id, total_amount, created_by, updated_by) values ($1, $2, 180, $3, $3)`, [id, `c${id}`, U.tyler]);
  return id;
};

test('precheck in the file header passes once 001-004 are in', { skip }, async () => {
  const [r] = (await db.query(`select to_regclass('public.shop_jobs') is not null as a, to_regclass('public.shop_part_orders') is not null as b,
    to_regprocedure('public.shop_clean(text)') is not null as c, to_regprocedure('public.shop_num(text, text, numeric)') is not null as d,
    to_regprocedure('public.shop_has_staff_access()') is not null as e`)).rows;
  assert.deepEqual(r, { a: true, b: true, c: true, d: true, e: true });
  const [old] = (await db.query(`select part_description, received, tracking_number, eta from public.shop_part_orders where id = 'old1'`)).rows;
  assert.deepEqual(old, { part_description: 'Fork seals', received: false, tracking_number: null, eta: null });
});

test('a part order saves vendor, cost, tracking and ETA; edits never un-receive it', { skip }, async () => {
  const job = await newEstimate('Parts SQL Customer');
  const saved = await rpc('garrett', 'shop_save_part_order', { p_order: JSON.stringify({ job_id: job, part_description: ' Clutch pack ', supplier_name: 'JP Cycles',
    cost: '144.00', tracking_number: '1Z999', eta: '2026-12-01', order_number: '55158798', date_ordered: '' }) });
  assert.equal(saved.part_description, 'Clutch pack'); assert.equal(saved.supplier_name, 'JP Cycles');
  assert.equal(Number(saved.cost), 144); assert.equal(saved.eta, '2026-12-01'); assert.equal(saved.received, false);
  const got = await rpc('tyler', 'shop_set_part_received', { p_id: saved.id, p_received: true });
  assert.equal(got.received, true); assert.ok(got.received_at);
  const edited = await rpc('tyler', 'shop_save_part_order', { p_order: JSON.stringify({ id: saved.id, job_id: job, part_description: 'Clutch pack', cost: '150', eta: '' }) });
  assert.equal(edited.received, true, 'still received after an edit'); assert.equal(edited.eta, null); assert.equal(Number(edited.cost), 150);
  const back = await rpc('tyler', 'shop_set_part_received', { p_id: saved.id, p_received: false });
  assert.equal(back.received, false); assert.equal(back.received_at, null);
  const stock = await rpc('tyler', 'shop_save_part_order', { p_order: JSON.stringify({ part_description: 'Shop rags', cost: '' }) });
  assert.equal(stock.job_id, null); assert.equal(Number(stock.cost), 0);
});

test('part orders reject bad input with a plain reason', { skip }, async () => {
  const bad = o => rpc('tyler', 'shop_save_part_order', { p_order: JSON.stringify(o) });
  await rejects(bad({ part_description: '  ' }), /description is required/);
  await rejects(bad({ part_description: 'x', cost: '-1' }), /cannot be negative/);
  await rejects(bad({ part_description: 'x', cost: '1.234' }), /2 decimal places/);
  await rejects(bad({ part_description: 'x', cost: 'abc' }), /Cost must be a number/);
  await rejects(bad({ part_description: 'x', eta: '12/1/2026' }), /ETA must be a date/);
  await rejects(bad({ part_description: 'x', eta: '2026-02-31' }), /ETA must be a real date/);
  await rejects(bad({ part_description: 'x', job_id: 'nope' }), /Job not found/);
  await rejects(rpc('tyler', 'shop_set_part_received', { p_id: 'nope', p_received: true }), /not found/);
});

test('only an estimate can be closed by hand; reopen clears it; status and amounts untouched', { skip }, async () => {
  const job = await newEstimate('Close SQL Customer');
  const [before] = (await db.query('select total_amount, status from public.shop_jobs where id = $1', [job])).rows;
  const c = await rpc('garrett', 'shop_set_job_closed', { p_job_id: job, p_closed: true });
  assert.ok(c.closed_at);
  const again = await rpc('tyler', 'shop_set_job_closed', { p_job_id: job, p_closed: true });
  assert.equal(again.closed_at, c.closed_at, 'closing twice keeps the first time');
  const [after] = (await db.query('select total_amount, status, closed_by from public.shop_jobs where id = $1', [job])).rows;
  assert.deepEqual({ t: after.total_amount, s: after.status }, { t: before.total_amount, s: before.status }); assert.equal(after.closed_by, U.garrett);
  const r = await rpc('tyler', 'shop_set_job_closed', { p_job_id: job, p_closed: false });
  assert.equal(r.closed_at, null);
  await rpc('tyler', 'shop_set_job_status', { p_job_id: job, p_status: 'in_progress' });
  await rejects(rpc('tyler', 'shop_set_job_closed', { p_job_id: job, p_closed: true }), /Only an estimate can be closed/);
  await rejects(rpc('tyler', 'shop_set_job_closed', { p_job_id: 'nope', p_closed: true }), /Job not found/);
  const log = (await db.query(`select action from public.shop_audit_log where row_id = $1 and action in ('close','reopen') order by changed_at, id`, [job])).rows.map(x => x.action);
  assert.deepEqual(log.sort(), ['close', 'close', 'reopen']);
});

test('riders and signed-out visitors can call none of the new functions', { skip }, async () => {
  for (const who of ['rider', null]) {
    await rejects(rpc(who, 'shop_save_part_order', { p_order: JSON.stringify({ part_description: 'x' }) }), /not authorized|permission denied/);
    await rejects(rpc(who, 'shop_set_part_received', { p_id: 'old1', p_received: true }), /not authorized|permission denied/);
    await rejects(rpc(who, 'shop_set_job_closed', { p_job_id: 'x', p_closed: true }), /not authorized|permission denied/);
  }
  assert.deepEqual(await as('rider', 'select id from public.shop_part_orders'), []);
});

test('rollback removes the functions and keeps the saved data', { skip }, async () => {
  await db.exec(sql('2026-11-26-shop-016-parts-on-order-closed-rollback.sql'));
  const [r] = (await db.query(`select to_regprocedure('public.shop_save_part_order(jsonb)') as f, count(*)::int as n from public.shop_part_orders`)).rows;
  assert.equal(r.f, null); assert.ok(r.n >= 3);
  await db.exec(sql('2026-11-26-shop-016-parts-on-order-closed.sql')); // and it can go back on
});
