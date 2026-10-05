// Shop module database tests: runs sql/shop/*.sql against a real in-process
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

before(async () => {
  if (skip) return;
  const { PGlite: PG } = await import('@electric-sql/pglite');
  db = new PG();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  await db.exec(sql('2026-10-04-shop-001-core.sql'));
  await db.exec(sql('2026-10-04-shop-002-writes.sql'));
  await db.query(`insert into public.shop_staff (user_id, display_name) values ($1, 'Tyler'), ($2, 'Garrett')`, [U.tyler, U.garrett]);
});

test('a rider (non-staff) can see nothing and can call nothing', { skip }, async () => {
  for (const t of ['shop_customers', 'shop_bikes', 'shop_jobs', 'shop_part_orders', 'shop_audit_log', 'shop_staff']) {
    assert.deepEqual(await as('rider', `select * from public.${t}`), [], `rider sees ${t}`);
  }
  await rejects(submitEstimate('rider', { p_job_id: null, p_customer_id: null,
    p_customer: { name: 'X' }, p_bike_id: null, p_bike: null, p_job: {} }), /not authorized/);
});

test('one estimate call creates the customer, bike and job together', { skip }, async () => {
  const r = await submitEstimate('tyler', {
    p_job_id: null, p_customer_id: null,
    p_customer: { name: 'Mike Rider', phone: '555-1212', email: 'mike@example.com', address: '12 Main St' },
    p_bike_id: null, p_bike: { vin: '1HD1KB4197Y000001', make: 'Harley-Davidson', model: 'Road King', year: 2015, mileage: 32000 },
    p_job: { invoice_number: 'INV-1001', status: 'estimate', parts_amount: 100, labor_amount: 150, tax_amount: 10, total_amount: 260, parts_cost: 60 },
  });
  assert.ok(r.customer_id && r.bike_id && r.job_id);
  const [customer] = await as('garrett', 'select * from public.shop_customers where id = $1', [r.customer_id]);
  assert.equal(customer.name, 'Mike Rider');
  assert.equal(customer.invoice_count, 1);
  const [bike] = await as('garrett', 'select * from public.shop_bikes where id = $1', [r.bike_id]);
  assert.equal(bike.vin, '1HD1KB4197Y000001'); assert.equal(bike.customer_id, r.customer_id);
  const [job] = await as('garrett', 'select * from public.shop_jobs where id = $1', [r.job_id]);
  assert.equal(job.status, 'estimate'); assert.equal(Number(job.part_profit), 40); assert.equal(Number(job.total_profit), 200);
  // lifetime_spend only counts completed jobs, so it's still 0 at the estimate stage
  assert.equal(Number(customer.lifetime_spend), 0);
  return r;
});

test('re-submitting the same job id updates it and the customer rollups, without creating duplicates', { skip }, async () => {
  const first = await submitEstimate('tyler', {
    p_job_id: null, p_customer_id: null, p_customer: { name: 'Second Customer' },
    p_bike_id: null, p_bike: { make: 'Yamaha', model: 'FZ6' },
    p_job: { status: 'estimate', total_amount: 300, parts_cost: 50 },
  });
  await submitEstimate('garrett', {
    p_job_id: first.job_id, p_customer_id: first.customer_id, p_customer: null,
    p_bike_id: first.bike_id, p_bike: null,
    p_job: { status: 'complete', total_amount: 300, parts_cost: 50 },
  });
  const jobs = await as('tyler', 'select * from public.shop_jobs where id = $1', [first.job_id]);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'complete'); assert.equal(jobs[0].updated_by, U.garrett);
  const [customer] = await as('tyler', 'select * from public.shop_customers where id = $1', [first.customer_id]);
  assert.equal(customer.invoice_count, 1); assert.equal(Number(customer.lifetime_spend), 300);
});

test('every write is recorded in the audit log', { skip }, async () => {
  const r = await submitEstimate('garrett', {
    p_job_id: null, p_customer_id: null, p_customer: { name: 'Audit Test' },
    p_bike_id: null, p_bike: null, p_job: { status: 'estimate', total_amount: 50 },
  });
  const log = await as('tyler', `select actor, action from public.shop_audit_log where row_id = $1`, [r.job_id]);
  assert.equal(log.length, 1); assert.equal(log[0].actor, U.garrett);
  for (const who of ['tyler', 'garrett']) {
    await rejects(as(who, 'delete from public.shop_audit_log'), /permission denied/);
  }
});
