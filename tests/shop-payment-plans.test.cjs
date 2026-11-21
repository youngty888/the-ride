// Payment plans (shop-009): database rules and the plan math in shop/pp-calc.js.
// Database part needs PGlite: `npm i --no-save @electric-sql/pglite`. Skipped without it.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PpCalc = require('../shop/pp-calc.js');

let hasPg = false;
try { require.resolve('@electric-sql/pglite'); hasPg = true; } catch { /* skipped below */ }
const skip = hasPg ? false : 'PGlite not installed (npm i --no-save @electric-sql/pglite)';
const sql = f => fs.readFileSync(path.join(__dirname, '..', 'sql', 'shop', f), 'utf8');
const U = { tyler: '00000000-0000-4000-9000-000000000001', rider: '00000000-0000-4000-9000-000000000003' };
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
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [user ? JSON.stringify({ sub: U[user], role: 'authenticated' }) : '']);
  await db.exec(user ? 'set role authenticated' : 'set role anon');
  try { return (await db.query(text, params)).rows; } finally { await db.exec('reset role'); }
}
const rpc = async (user, fn, args) => {
  const keys = Object.keys(args);
  return (await as(user, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map(k => args[k])))[0].r;
};

const PLAN = {
  customer_id: 'cust-test-01', bike_id: 'bike-test-01', item: '2023 Harley-Davidson Low Rider S',
  sale_date: '2026-11-15', sale_price: '11000', down_payment: '0', monthly_payment: '500',
  due_day: '18', first_due_date: '2026-12-18',
};

before(async () => {
  if (skip) return;
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
    '2026-10-30-shop-004-estimates.sql', '2026-11-21-shop-009-payment-plans.sql', '2026-11-21-shop-009-payment-plans.sql']) await db.exec(sql(f));
  await db.query(`insert into public.shop_staff (user_id, display_name) values ($1, 'Tyler')`, [U.tyler]);
});

test('non-staff cannot see or change payment plans', { skip }, async () => {
  for (const t of ['shop_payment_plans', 'shop_plan_payments', 'shop_payment_plan_summary']) {
    assert.deepEqual(await as('rider', `select * from public.${t}`), []);
  }
  await assert.rejects(rpc('rider', 'shop_save_customer', { p_customer_id: 'cust-x-000', p_customer: { name: 'X' }, p_bike_id: null, p_bike: null }), /not authorized/);
  await assert.rejects(rpc('rider', 'shop_save_payment_plan', { p_plan_id: 'plan-x-000', p_plan: PLAN }), /not authorized/);
  await assert.rejects(as(null, `select public.shop_record_plan_payment('pay-x-000', '{}'::jsonb)`), /permission denied/);
});

test('staff add a customer with a bike, then a plan; payments bring the balance down', { skip }, async () => {
  await rpc('tyler', 'shop_save_customer', { p_customer_id: 'cust-test-01', p_customer: { name: 'Jamie', phone: '555-0100' },
    p_bike_id: 'bike-test-01', p_bike: { vin: '1hd1test', make: 'Harley-Davidson', model: 'Low Rider S', year: '2023', mileage: '28,000' } });
  const [bike] = await as('tyler', `select * from public.shop_bikes where id = 'bike-test-01'`);
  assert.equal(bike.mileage, 28000); assert.equal(bike.vin, '1HD1TEST'); assert.equal(bike.customer_id, 'cust-test-01');

  await rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-test-01', p_plan: PLAN });
  await rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-test-01', p_plan: PLAN }); // saving twice makes no copy
  let [s] = await as('tyler', `select * from public.shop_payment_plan_summary`);
  assert.equal(Number(s.balance), 11000); assert.equal(s.status, 'active');

  const r = await rpc('tyler', 'shop_record_plan_payment', { p_payment_id: 'pay-test-01', p_payment: { plan_id: 'plan-test-01', amount: '500', received_date: '2026-12-18', method: 'Cash' } });
  assert.equal(Number(r.balance), 10500);
  const dup = await rpc('tyler', 'shop_record_plan_payment', { p_payment_id: 'pay-test-01', p_payment: { plan_id: 'plan-test-01', amount: '500', received_date: '2026-12-18' } });
  assert.equal(dup.duplicate, true); // a double tap never counts the money twice
  [s] = await as('tyler', `select * from public.shop_payment_plan_summary`);
  assert.equal(Number(s.balance), 10500); assert.equal(Number(s.payment_count), 1);
  const [p] = await as('tyler', `select received_by from public.shop_plan_payments where id = 'pay-test-01'`);
  assert.equal(p.received_by, U.tyler); // who marked it received comes from the sign-in
});

test('overpaying is refused; paying the balance marks the plan paid off; deleting reopens it', { skip }, async () => {
  await assert.rejects(rpc('tyler', 'shop_record_plan_payment', { p_payment_id: 'pay-test-02', p_payment: { plan_id: 'plan-test-01', amount: '10500.01', received_date: '2027-01-18' } }), /more than the balance/);
  await rpc('tyler', 'shop_record_plan_payment', { p_payment_id: 'pay-test-03', p_payment: { plan_id: 'plan-test-01', amount: '10500', received_date: '2027-01-18' } });
  let [s] = await as('tyler', `select * from public.shop_payment_plan_summary`);
  assert.equal(Number(s.balance), 0); assert.equal(s.status, 'paid_off');
  await rpc('tyler', 'shop_delete_plan_payment', { p_payment_id: 'pay-test-03' });
  [s] = await as('tyler', `select * from public.shop_payment_plan_summary`);
  assert.equal(Number(s.balance), 10500); assert.equal(s.status, 'active');
  const log = await as('tyler', `select action from public.shop_audit_log where row_id = 'pay-test-03' order by id`);
  assert.deepEqual(log.map(x => x.action), ['insert', 'delete']);
});

test('a bike on another customer cannot be put on this plan', { skip }, async () => {
  await rpc('tyler', 'shop_save_customer', { p_customer_id: 'cust-test-02', p_customer: { name: 'Someone' }, p_bike_id: null, p_bike: null });
  await assert.rejects(rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-test-02', p_plan: { ...PLAN, customer_id: 'cust-test-02' } }), /different customer/);
});

// ---------- plan math (matches the tracker sheet) ----------
const plan = { sale_price: 11000, down_payment: 0, monthly_payment: 500, due_day: 18, first_due_date: '2026-12-18' };

test('nothing paid yet: 22 payments, next due Dec 18 2026, payoff Sep 18 2028 (same as the sheet)', () => {
  const s = PpCalc.summary(plan, [], '2026-11-21');
  assert.equal(s.balanceCents, 1100000); assert.equal(s.paymentsLeft, 22);
  assert.equal(s.nextDue, '2026-12-18'); assert.equal(s.payoff, '2028-09-18'); assert.equal(s.late, false);
});

test('paid early counts for the coming due date', () => {
  const s = PpCalc.summary(plan, [{ amount: 500, received_date: '2026-12-10' }], '2026-12-12');
  assert.equal(s.nextDue, '2027-01-18'); assert.equal(s.paymentsLeft, 21); assert.equal(s.payoff, '2028-09-18');
});

test('an extra payment comes off the balance and moves payoff earlier, but next month is still due', () => {
  const s = PpCalc.summary(plan, [{ amount: 1000, received_date: '2026-12-18' }], '2026-12-20');
  assert.equal(s.nextDue, '2027-01-18'); assert.equal(s.paymentsLeft, 20); assert.equal(s.payoff, '2028-08-18');
});

test('a missed payment shows late with the amount past due', () => {
  const s = PpCalc.summary(plan, [{ amount: 500, received_date: '2026-12-18' }], '2027-02-20');
  assert.equal(s.late, true); assert.equal(s.pastDueCents, 100000); assert.equal(s.nextDue, '2027-01-18');
});

test('down payment and paid off', () => {
  const s = PpCalc.summary({ ...plan, down_payment: 1000 }, [{ amount: 10000, received_date: '2027-01-01' }], '2027-01-02');
  assert.equal(s.paidOff, true); assert.equal(s.totalPaidCents, 1100000); assert.equal(s.nextDue, null);
});
