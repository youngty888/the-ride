// Customer "My loan" sign-in (shop-012): a customer sees only their own plan, only with a confirmed email.
// Needs PGlite: `npm i --no-save @electric-sql/pglite`. Skipped without it.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let hasPg = false;
try { require.resolve('@electric-sql/pglite'); hasPg = true; } catch { /* skipped below */ }
const skip = hasPg ? false : 'PGlite not installed (npm i --no-save @electric-sql/pglite)';
const sql = f => fs.readFileSync(path.join(__dirname, '..', 'sql', 'shop', f), 'utf8');
const U = {
  tyler: '00000000-0000-4000-9000-000000000001',
  jamie: '00000000-0000-4000-9000-000000000003',
  unconfirmed: '00000000-0000-4000-9000-000000000004',
  other: '00000000-0000-4000-9000-000000000005',
};
let db;

const STUB = `
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz);
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
  customer_id: 'cust-jamie-01', bike_id: 'bike-jamie-01', item: '2023 Harley-Davidson Low Rider S',
  sale_date: '2026-11-15', sale_price: '11000', down_payment: '0', schedule: 'monthly', payment_amount: '500',
  due_day: '18', first_due_date: '2026-12-18', apr: '0', notes: 'staff only note',
};

before(async () => {
  if (skip) return;
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(STUB);
  const emails = { tyler: 'tyler@test.local', jamie: 'Jamie@Test.Local', unconfirmed: 'jamie@test.local ', other: 'other@test.local' };
  for (const [name, id] of Object.entries(U)) {
    // "unconfirmed" signed up with Jamie's email address (case/space differences) but never confirmed it
    await db.query('insert into auth.users values ($1, $2, $3)', [id, name === 'unconfirmed' ? 'jamie2@test.local' : emails[name], name === 'unconfirmed' ? null : new Date().toISOString()]);
  }
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
    '2026-10-30-shop-004-estimates.sql', '2026-11-21-shop-009-payment-plans.sql', '2026-11-21-shop-012-customer-loan.sql']) await db.exec(sql(f));
  await db.query(`insert into public.shop_staff (user_id, display_name) values ($1, 'Tyler')`, [U.tyler]);
  await rpc('tyler', 'shop_save_customer', { p_customer_id: 'cust-jamie-01', p_customer: { name: 'Jamie', email: ' JAMIE@test.local' },
    p_bike_id: 'bike-jamie-01', p_bike: { vin: '1hd1test', make: 'Harley-Davidson', model: 'Low Rider S', year: '2023', mileage: '28000' } });
  await rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-jamie-01', p_plan: PLAN });
  await rpc('tyler', 'shop_record_plan_payment', { p_payment_id: 'pay-jamie-01', p_payment: { plan_id: 'plan-jamie-01', amount: '600', received_date: '2026-12-18', method: 'Cash' } });
});

test('a confirmed sign-in with the customer email sees only their own loan', { skip }, async () => {
  const plans = await rpc('jamie', 'shop_my_payment_plans', {});
  assert.equal(plans.length, 1);
  assert.equal(Number(plans[0].balance), 10400);
  assert.equal(plans[0].payments.length, 1);
  assert.equal(Number(plans[0].payments[0].amount), 600);
  assert.equal(plans[0].title_held, true);
  assert.equal('notes' in plans[0], false); // staff notes are never sent
  assert.equal('created_by' in plans[0], false);
});

test('other riders, unconfirmed emails and signed-out visitors see nothing', { skip }, async () => {
  assert.deepEqual(await rpc('other', 'shop_my_payment_plans', {}), []);
  assert.deepEqual(await rpc('unconfirmed', 'shop_my_payment_plans', {}), []);
  await assert.rejects(as(null, 'select public.shop_my_payment_plans()'), /permission denied/);
});

test('customers cannot read the plan tables directly', { skip }, async () => {
  for (const t of ['shop_payment_plans', 'shop_plan_payments', 'shop_payment_plan_summary']) {
    assert.deepEqual(await as('jamie', `select * from public.${t}`), []);
  }
});

test('an unconfirmed account with a matching email is rejected even if the address matches', { skip }, async () => {
  await db.query(`update auth.users set email = 'jamie@test.local' where id = $1`, [U.unconfirmed]);
  assert.deepEqual(await rpc('unconfirmed', 'shop_my_payment_plans', {}), []);
});
