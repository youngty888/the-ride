// Tech sign-off tests (shop-008): runs sql/shop/*.sql against a real in-process
// Postgres (PGlite) with Supabase-style roles, then checks permissions and the
// single-entry-point estimate flow. Mirrors tests/warehouse-sql.test.cjs.
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
  fang: '00000000-0000-4000-9000-000000000004',
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

// shop_submit_estimate returns a row set (customer_id, bike_id, job_id), so it
// needs `select * from` rather than the single-column `select fn() as r` form
// the generic rpc() helper above uses.
const submitEstimate = async (user, args) => {
  const keys = Object.keys(args);
  const call = `select * from public.shop_submit_estimate(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
  const rows = await as(user, call, keys.map(k => args[k] === undefined ? null : args[k]));
  return rows[0];
};


const save = (user, a) => rpc(user, 'shop_save_estimate', {
  p_job_id: a.job, p_customer_id: a.customer, p_customer: { name: 'Test Customer' },
  p_bike_id: null, p_bike: null, p_job: {}, p_items: a.items });
const ITEMS = [
  { kind: 'part', description: 'Fork seal kit', quantity: '1', unit_price: '60', unit_cost: '30' },
  { kind: 'labor', description: 'Fork rebuild', quantity: '3', unit_price: '150' },
  { kind: 'labor', description: 'Brake pads', quantity: '1', unit_price: '150' },
];
const sign = (u, job, step, hours) => rpc(u, 'shop_sign_step', { p_job_id: job, p_step: step, p_hours: String(hours) });
const mine = async job => (await as('tyler', 'select s.display_name, l.step_name, l.hours::text, l.disputed, l.resolved_at is not null as settled from public.shop_labor_signoffs l join public.shop_staff s on s.user_id = l.tech_id where job_id = $1 order by step_name, display_name', [job]));

before(async () => {
  if (skip) return;
  const { PGlite: PG } = await import('@electric-sql/pglite');
  db = new PG();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
    '2026-10-30-shop-004-estimates.sql', '2026-11-15-shop-006-payment-status.sql',
    '2026-11-19-shop-007-saved-jobs.sql', '2026-11-21-shop-008-tech-signoff.sql', '2026-11-21-shop-008-tech-signoff.sql']) await db.exec(sql(f));
  await db.query(`insert into public.shop_staff (user_id, display_name, payroll_manager) values ($1, 'Tyler', true), ($2, 'Garrett', false), ($3, 'Fang', false)`, [U.tyler, U.garrett, U.fang]);
  await save('tyler', { job: 'job0001', customer: 'cust0001', items: ITEMS });
});

test('two techs can split a step, but never past the bid hours', { skip }, async () => {
  await sign('garrett', 'job0001', 'Fork rebuild', 2);
  await sign('fang', 'job0001', 'fork rebuild', 1);            // name match ignores case
  await rejects(sign('fang', 'job0001', 'Fork rebuild', 1.5), /Only 1 of the 3 bid hours are left/);
  await rejects(sign('tyler', 'job0001', 'Fork rebuild', 0.25), /Only 0 of the 3/);
  assert.deepEqual((await mine('job0001')).map(r => [r.display_name, r.hours]), [['Fang', '1.00'], ['Garrett', '2.00']]);
});

test('a step that is not on the estimate, bad hours, and non-staff are refused', { skip }, async () => {
  await rejects(sign('garrett', 'job0001', 'Paint tank', 1), /no labor hours/);
  await rejects(sign('garrett', 'job0001', 'Fork seal kit', 1), /no labor hours/);   // a part, not labor
  await rejects(sign('garrett', 'job0001', 'Brake pads', -1), /Hours/);
  await rejects(sign('rider', 'job0001', 'Brake pads', 1), /not authorized/);
  assert.deepEqual(await as('rider', 'select * from public.shop_labor_signoffs'), []);
  await rejects(as('garrett', `insert into public.shop_labor_signoffs (job_id, step_key, step_name, tech_id, hours) values ('job0001','brake pads','Brake pads', $1, 9)`, [U.garrett]), /permission denied/);
});

test('sign-offs survive re-saving the estimate', { skip }, async () => {
  await save('tyler', { job: 'job0001', customer: 'cust0001', items: ITEMS });
  assert.equal((await mine('job0001')).length, 2);
});

test('a tech can take back their own sign-off', { skip }, async () => {
  await sign('tyler', 'job0001', 'Brake pads', 1);
  await sign('tyler', 'job0001', 'Brake pads', 0);
  assert.equal((await mine('job0001')).filter(r => r.step_name === 'Brake pads').length, 0);
});

test('disputes: anyone flags, only the payroll manager settles, cap still holds', { skip }, async () => {
  assert.equal(await rpc('fang', 'shop_dispute_step', { p_job_id: 'job0001', p_step: 'Fork rebuild', p_note: 'I did the seals' }), 2);
  assert.ok((await mine('job0001')).every(r => r.disputed));
  const splits = [{ tech_id: U.garrett, hours: '1.5' }, { tech_id: U.fang, hours: '1.5' }];
  await rejects(rpc('garrett', 'shop_settle_step', { p_job_id: 'job0001', p_step: 'Fork rebuild', p_splits: splits }), /Only the payroll manager/);
  await rejects(rpc('tyler', 'shop_settle_step', { p_job_id: 'job0001', p_step: 'Fork rebuild', p_splits: [{ tech_id: U.garrett, hours: '2' }, { tech_id: U.fang, hours: '1.5' }] }), /adds up to 3.5 hours but the bid is 3/);
  await rpc('tyler', 'shop_settle_step', { p_job_id: 'job0001', p_step: 'Fork rebuild', p_splits: splits });
  assert.deepEqual((await mine('job0001')).map(r => [r.display_name, r.hours, r.disputed, r.settled]), [['Fang', '1.50', false, true], ['Garrett', '1.50', false, true]]);
  await rejects(sign('garrett', 'job0001', 'Fork rebuild', 1), /payroll manager already settled/);
  assert.equal(await as('garrett', 'select public.shop_is_payroll_manager() as r').then(r => r[0].r), false);
});

test('logins are logged once per 10 minutes and visible to staff', { skip }, async () => {
  assert.equal(await rpc('garrett', 'shop_log_login', {}), true);
  assert.equal(await rpc('garrett', 'shop_log_login', {}), true);
  assert.equal(await rpc('rider', 'shop_log_login', {}), false);
  assert.equal((await as('tyler', 'select * from public.shop_staff_logins')).length, 1);
});

test('rollback removes everything shop-008 added', { skip }, async () => {
  await db.exec(sql('2026-11-21-shop-008-tech-signoff-rollback.sql'));
  const t = await db.query(`select to_regclass('public.shop_labor_signoffs') as a, to_regclass('public.shop_staff_logins') as b`);
  assert.deepEqual(t.rows[0], { a: null, b: null });
  await db.exec(sql('2026-11-21-shop-008-tech-signoff.sql'));   // and it can be put back
});
