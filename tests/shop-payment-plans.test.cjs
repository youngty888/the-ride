// Payment plans (shop-009): database rules and the plan math in shop/pp-calc.js.
// Database part needs PGlite: `npm i --no-save @electric-sql/pglite`. Skipped without it.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PpCalc = require('../shop/pp-calc.js');
const PpContract = require('../shop/pp-contract.js');

let hasPg = false;
try { require.resolve('@electric-sql/pglite'); hasPg = true; } catch { /* skipped below */ }
const skip = hasPg ? false : 'PGlite not installed (npm i --no-save @electric-sql/pglite)';
const sql = f => fs.readFileSync(path.join(__dirname, '..', 'sql', 'shop', f), 'utf8');
const U = { tyler: '00000000-0000-4000-9000-000000000001', rider: '00000000-0000-4000-9000-000000000003',
  buyer: '00000000-0000-4000-9000-000000000004', unconfirmed: '00000000-0000-4000-9000-000000000005' };
let db;

const STUB = `
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz default now());
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
  sale_date: '2026-11-15', sale_price: '11000', down_payment: '0', schedule: 'monthly', payment_amount: '500',
  due_day: '18', first_due_date: '2026-12-18', apr: '0',
};

before(async () => {
  if (skip) return;
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
    '2026-10-30-shop-004-estimates.sql', '2026-11-21-shop-009-payment-plans.sql', '2026-11-21-shop-009-payment-plans.sql',
    '2026-11-22-shop-012-my-payments.sql', '2026-11-22-shop-012-my-payments.sql']) await db.exec(sql(f));
  await db.query('update auth.users set email_confirmed_at = null where id = $1', [U.unconfirmed]);
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

test('an interest plan every two weeks: the finance charge is owed, overpaying is checked against it', { skip }, async () => {
  const r = PpCalc.amortize({ financedCents: 700000, apr: 20, payments: 52, schedule: 'biweekly' });
  await rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-test-03', p_plan: { ...PLAN, schedule: 'biweekly', due_day: null,
    sale_price: '8000', down_payment: '1000', first_due_date: '2026-12-04', apr: '20', term_payments: '52',
    payment_amount: (r.paymentCents / 100).toFixed(2), finance_charge: (r.financeChargeCents / 100).toFixed(2),
    late_fee_per_day: '50', late_fee_grace_days: '2', missed_limit: '3', pay_provider: 'stripe', pay_link_url: 'https://pay.example.com/link/SAMPLE123', autopay: 'pending' } });
  const [s] = await as('tyler', `select * from public.shop_payment_plan_summary where id = 'plan-test-03'`);
  assert.equal(Number(s.balance), 8519.61); assert.equal(Number(s.total_owed), 8519.61);
  assert.equal(s.schedule, 'biweekly'); assert.equal(s.due_day, null); assert.equal(s.autopay, 'pending'); assert.equal(s.pay_provider, 'stripe');
  await assert.rejects(rpc('tyler', 'shop_record_plan_payment', { p_payment_id: 'pay-test-31', p_payment: { plan_id: 'plan-test-03', amount: '8519.62', received_date: '2026-12-04' } }), /more than the balance/);
  const ok = await rpc('tyler', 'shop_record_plan_payment', { p_payment_id: 'pay-test-32', p_payment: { plan_id: 'plan-test-03', amount: '7500', received_date: '2026-12-04' } });
  assert.equal(Number(ok.balance), 1019.61); // more than the old price-minus-down would allow
});

test('bad plans are refused: unsafe pay link, interest with no term, monthly with no due day', { skip }, async () => {
  for (const link of ['javascript:alert(1)', 'http://pay.example.com/x', 'https://pay.example.com/x"onmouseover=1', 'https://a b.com']) {
    await assert.rejects(rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-test-04', p_plan: { ...PLAN, pay_link_url: link } }), /https/);
  }
  await assert.rejects(rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-test-04', p_plan: { ...PLAN, apr: '20' } }), /number of payments/);
  await assert.rejects(rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-test-04', p_plan: { ...PLAN, pay_provider: 'venmo' } }), /pay_provider/);
  await assert.rejects(rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-test-04', p_plan: { ...PLAN, due_day: null } }), /due day/);
  assert.deepEqual(await as('tyler', `select id from public.shop_payment_plans where id = 'plan-test-04'`), []);
});

// ---------- plan math (matches the tracker sheet) ----------
const plan = { sale_price: 11000, down_payment: 0, payment_amount: 500, schedule: 'monthly', due_day: 18, first_due_date: '2026-12-18' };

test('a buyer sees only their own plan, by confirmed email, and never the shop notes', { skip }, async () => {
  await rpc('tyler', 'shop_save_customer', { p_customer_id: 'cust-buyer-01', p_customer: { name: 'Test Buyer', email: ' Buyer@Test.local ' },
    p_bike_id: 'bike-buyer-01', p_bike: { vin: 'TESTVIN0000000009', make: 'Harley-Davidson', model: 'Street Bob', year: '2021' } });
  await rpc('tyler', 'shop_save_customer', { p_customer_id: 'cust-unconf-01', p_customer: { name: 'Not Yet', email: 'unconfirmed@test.local' }, p_bike_id: null, p_bike: null });
  for (const [id, c] of [['plan-buyer-01', 'cust-buyer-01'], ['plan-unconf-01', 'cust-unconf-01']]) {
    await rpc('tyler', 'shop_save_payment_plan', { p_plan_id: id, p_plan: { ...PLAN, customer_id: c, bike_id: c === 'cust-buyer-01' ? 'bike-buyer-01' : null,
      late_fee_per_day: '0', pay_provider: 'stripe', pay_link_url: 'https://buy.stripe.com/test_SAMPLE', notes: 'SHOP PRIVATE NOTE' } });
  }
  await rpc('tyler', 'shop_record_plan_payment', { p_payment_id: 'pay-buyer-01', p_payment: { plan_id: 'plan-buyer-01', amount: '500', received_date: '2026-12-18', method: 'Card (pay link)', notes: 'SHOP PRIVATE NOTE' } });
  const mine = await rpc('buyer', 'shop_my_payment_plans', {});
  assert.equal(mine.length, 1);
  const p = mine[0];
  assert.equal(p.id, 'plan-buyer-01'); assert.equal(Number(p.balance), 10500); assert.equal(p.pay_link_url, 'https://buy.stripe.com/test_SAMPLE');
  assert.equal(p.bike.vin_last6, '000009'); assert.deepEqual(p.payments.map(x => Number(x.amount)), [500]);
  assert.equal(JSON.stringify(mine).includes('SHOP PRIVATE NOTE'), false); // shop notes never reach the buyer
  assert.equal(JSON.stringify(mine).includes(U.tyler), false);             // nor who marked the payment
  assert.deepEqual(await rpc('rider', 'shop_my_payment_plans', {}), []);   // a login with no plan sees nothing
  assert.deepEqual(await rpc('unconfirmed', 'shop_my_payment_plans', {}), []); // an unconfirmed email sees nothing
  await assert.rejects(as(null, 'select public.shop_my_payment_plans()'), /permission denied/);
  await assert.rejects(rpc('buyer', 'shop_record_plan_payment', { p_payment_id: 'pay-buyer-99', p_payment: { plan_id: 'plan-buyer-01', amount: '500', received_date: '2026-12-19' } }), /not authorized|permission denied/);
  assert.deepEqual(await as('buyer', 'select * from public.shop_payment_plans'), []); // still no direct table access
});

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

// ---------- interest, every two weeks, late fees, default ----------
test('amortize: 20% APR matches the standard loan payment; 0% is a flat split', () => {
  const m = PpCalc.amortize({ financedCents: 1000000, apr: 20, payments: 36, schedule: 'monthly' });
  assert.equal(m.paymentCents, 37164); // $10,000 at 20% for 36 months = $371.64 (standard table)
  assert.equal(m.paymentCents * 35 + m.lastPaymentCents, m.totalCents);
  assert.equal(m.financeChargeCents, m.totalCents - 1000000);
  const z = PpCalc.amortize({ financedCents: 1100000, apr: 0, payments: 22, schedule: 'monthly' });
  assert.deepEqual([z.paymentCents, z.lastPaymentCents, z.financeChargeCents], [50000, 50000, 0]);
  const odd = PpCalc.amortize({ financedCents: 100001, apr: 0, payments: 3, schedule: 'monthly' });
  assert.equal(odd.paymentCents * 2 + odd.lastPaymentCents, 100001);
});

test('every two weeks: due dates are 14 days apart and payoff follows them', () => {
  const b = { sale_price: 8000, down_payment: 1000, schedule: 'biweekly', first_due_date: '2026-12-04' };
  const r = PpCalc.amortize({ financedCents: 700000, apr: 20, payments: 52, schedule: 'biweekly' });
  Object.assign(b, { payment_amount: r.paymentCents / 100, finance_charge: r.financeChargeCents / 100 });
  assert.equal(PpCalc.dueDate(b, 2), '2026-12-18'); assert.equal(PpCalc.dueDate(b, 3), '2027-01-01');
  const s = PpCalc.summary(b, [], '2026-11-21');
  assert.equal(s.balanceCents, 851961); assert.equal(s.paymentsLeft, 52); assert.equal(s.payoff, PpCalc.dueDate(b, 52));
  const paid = PpCalc.summary(b, [{ amount: r.paymentCents / 100, received_date: '2026-12-04' }], '2026-12-05');
  assert.equal(paid.nextDue, '2026-12-18'); assert.equal(paid.late, false);
});

const late = { ...plan, late_fee_per_day: 50, late_fee_grace_days: 2, missed_limit: 3 };
test('late fee: $50 a day once more than 2 days late; nothing in the grace days; waived means none', () => {
  assert.equal(PpCalc.summary(late, [], '2026-12-20').lateFeeCents, 0);       // 2 days late
  const s = PpCalc.summary(late, [], '2026-12-25');                           // 7 days late
  assert.equal(s.lateDays, 7); assert.equal(s.lateFeeCents, 25000); assert.equal(s.lateFeeStarts, '2026-12-21');
  assert.equal(PpCalc.summary({ ...late, late_fee_waived: true }, [], '2026-12-25').lateFeeCents, 0);
  assert.equal(PpCalc.summary({ ...late, late_fee_per_day: 0 }, [], '2026-12-25').lateFeeCents, 0);
});

test('missed payments: 3 in a row is the last chance, the 4th is a default; paying catches up', () => {
  assert.equal(PpCalc.summary(late, [], '2027-01-19').standing, 'late');
  const three = PpCalc.summary(late, [], '2027-02-19');
  assert.deepEqual([three.missed, three.standing], [3, 'last_chance']);
  const four = PpCalc.summary(late, [], '2027-03-19');
  assert.deepEqual([four.missed, four.standing], [4, 'default']);
  const caught = PpCalc.summary(late, [{ amount: 2000, received_date: '2027-03-19' }], '2027-03-19');
  assert.deepEqual([caught.late, caught.missed, caught.standing], [false, 0, 'ok']);
});

// ---------- contract fill-in ----------
const SAMPLE = { seller: { name: 'SIC Cycles' }, sample: true,
  buyer: { name: 'Sample Buyer', address: '123 Example St, Tucson, AZ 85700', phone: '555-0100', email: 'buyer@example.com' },
  vehicle: { year: 2021, make: 'Harley-Davidson', model: 'Street Bob', vin: 'SAMPLEVIN00000000', mileage: 12000 } };
const text = d => JSON.stringify(d);
test('contract fills in the plan: TILA box, schedule, insurance, registration, default terms', () => {
  const r = PpCalc.amortize({ financedCents: 700000, apr: 20, payments: 52, schedule: 'biweekly' });
  const d = PpContract.build({ ...SAMPLE, plan: { sale_date: '2026-11-21', sale_price: 8000, down_payment: 1000, schedule: 'biweekly',
    first_due_date: '2026-12-04', apr: 20, term_payments: 52, payment_amount: r.paymentCents / 100, finance_charge: r.financeChargeCents / 100,
    late_fee_per_day: 50, late_fee_grace_days: 2, missed_limit: 3, title_held: true } });
  const t = text(d);
  assert.match(d.status, /DRAFT FOR ATTORNEY REVIEW/); assert.match(d.status, /SAMPLE/);
  for (const want of ['20.00%', '$1,519.61', '$7,000.00', '$8,519.61', '$9,519.61', '51 payments of $163.84 and a final payment of $163.77',
    'every 14 days', 'Sample Buyer', 'SAMPLEVIN00000000', '12,000 miles', 'loss payee', 'Motor Vehicle Division', '$50.00 per day',
    'more than 3 consecutive', 'before your 4th consecutive payment', 'ANY HOLDER OF THIS CONSUMER CREDIT CONTRACT']) assert.ok(t.includes(want), want);
  assert.equal(d.numbers.lastPaymentCents, r.lastPaymentCents);
  assert.doesNotMatch(t, /undefined|NaN|null/);
});

test('contract for a 0% monthly plan with no late fee (like the first test plan)', () => {
  const d = PpContract.build({ ...SAMPLE, plan: { ...plan, sale_date: '2026-11-15', apr: 0, finance_charge: 0, missed_limit: 3 } });
  const t = text(d);
  assert.ok(t.includes('0.00%')); assert.ok(t.includes('21 payments of $500.00 and a final payment of $500.00'));
  assert.ok(t.includes('on the 18th day of each month')); assert.ok(t.includes('No late charge applies'));
  assert.ok(t.includes('Final payment due September 18, 2028'));
  assert.doesNotMatch(t, /undefined|NaN|null/);
});

test('attorney list covers licence, rate, late fee, repossession and TILA', () => {
  const topics = PpContract.ATTORNEY_QUESTIONS.map(q => q[0]).join(' ');
  for (const t of ['Licensing', 'Interest rate', 'Late fee', 'Repossession', 'Truth in Lending']) assert.ok(topics.includes(t), t);
});
