// Shopify plan payments (shop-013): the pay link with the loan number, the
// webhook function's checks (supabase/functions/shopify-orders-paid/lib.mjs),
// and the database rules for crediting an order. Uses sample data only.
// Database part needs PGlite: `npm i --no-save @electric-sql/pglite`. Skipped without it.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../shop/pp-calc.js');

let hasPg = false;
try { require.resolve('@electric-sql/pglite'); hasPg = true; } catch { /* skipped below */ }
const skip = hasPg ? false : 'PGlite not installed (npm i --no-save @electric-sql/pglite)';
const sql = f => fs.readFileSync(path.join(__dirname, '..', 'sql', 'shop', f), 'utf8');
const lib = () => import(path.join(__dirname, '..', 'supabase', 'functions', 'shopify-orders-paid', 'lib.mjs'));
const U = { tyler: '00000000-0000-4000-9000-000000000001', rider: '00000000-0000-4000-9000-000000000003',
  buyer: '00000000-0000-4000-9000-000000000004' };
const CART = 'https://www.example-shop.test/cart/111222333:1';
const VARIANT = 111222333;
const SECRET = 'test-signing-secret';
let db;

const STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$
  select nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant select, insert, update on storage.objects to anon, authenticated;
`;
async function as(role, text, params) {
  await db.exec('reset role');
  const user = U[role];
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [user ? JSON.stringify({ sub: user, role: 'authenticated' }) : '']);
  await db.exec(user ? 'set role authenticated' : role === 'server' ? 'set role service_role' : 'set role anon');
  try { return (await db.query(text, params)).rows; } finally { await db.exec('reset role'); }
}
const rpc = async (role, fn, args) => {
  const keys = Object.keys(args);
  return (await as(role, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map(k => args[k])))[0].r;
};
const record = o => rpc('server', 'shop_record_shopify_order', { p_order: o });
const PLAN = {
  customer_id: 'cust-test-01', bike_id: 'bike-test-01', item: '2023 Harley-Davidson Low Rider S',
  sale_date: '2026-11-15', sale_price: '11000', down_payment: '0', schedule: 'monthly', payment_amount: '500',
  due_day: '18', first_due_date: '2026-12-18', apr: '0', pay_provider: 'shopify', pay_link_url: CART,
};

// --- pay link -----------------------------------------------------------------
test('a Shopify cart link gets the loan number and VIN (last 6) added', () => {
  const p = { pay_provider: 'shopify', pay_ref: 'SIC-ABC234', pay_link_url: CART };
  assert.equal(C.payHref(p, '1HD1TESTVIN062429'), `${CART}?attributes[Loan]=SIC-ABC234&attributes[VIN]=062429`);
  assert.equal(C.payHref(p, ''), `${CART}?attributes[Loan]=SIC-ABC234`);
  assert.equal(C.isShopifyCart(p), true);
});

test('other links are used as saved, and bad links are never used', () => {
  assert.equal(C.payHref({ pay_provider: 'stripe', pay_ref: 'SIC-ABC234', pay_link_url: 'https://buy.stripe.com/x' }), 'https://buy.stripe.com/x');
  assert.equal(C.payHref({ pay_provider: 'shopify', pay_ref: 'SIC-ABC234', pay_link_url: 'https://www.example-shop.test/products/pay' }), 'https://www.example-shop.test/products/pay');
  assert.equal(C.payHref({ pay_provider: 'shopify', pay_ref: null, pay_link_url: CART }), CART);
  assert.equal(C.payHref({ pay_provider: 'shopify', pay_ref: 'bad ref"', pay_link_url: CART }), CART);
  assert.equal(C.payHref({ pay_provider: 'shopify', pay_ref: 'SIC-ABC234', pay_link_url: 'javascript:alert(1)' }), '');
  assert.equal(C.payHref({ pay_provider: 'shopify', pay_ref: 'SIC-ABC234', pay_link_url: '' }), '');
});

// --- webhook function -----------------------------------------------------------
const sign = body => crypto.createHmac('sha256', SECRET).update(body).digest('base64');
const order = over => ({ id: 5550001, name: '#1042', currency: 'USD', processed_at: '2026-12-18T10:00:00-07:00', test: false,
  note_attributes: [{ name: 'Loan', value: 'SIC-ABC234' }, { name: 'VIN', value: '062429' }],
  line_items: [{ variant_id: VARIANT, price: '500.00', quantity: 1, discount_allocations: [] }], ...over });
function req(body, headers = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://fn.test/shopify-orders-paid', { method: 'POST', body: raw,
    headers: { 'x-shopify-hmac-sha256': sign(raw), 'x-shopify-topic': 'orders/paid', 'x-shopify-shop-domain': 'shop.test', ...headers } });
}

test('the function checks Shopify\'s signature on the exact body', async () => {
  const { verifyShopifyHmac } = await lib();
  const raw = new TextEncoder().encode('{"id":1}');
  assert.equal(await verifyShopifyHmac(raw, sign('{"id":1}'), SECRET), true);
  assert.equal(await verifyShopifyHmac(raw, sign('{"id":2}'), SECRET), false);
  assert.equal(await verifyShopifyHmac(raw, sign('{"id":1}'), 'other-secret'), false);
  assert.equal(await verifyShopifyHmac(raw, null, SECRET), false);
  assert.equal(await verifyShopifyHmac(raw, sign('{"id":1}'), ''), false);
});

test('only the plan-payment lines count, and the loan number is read from the order', async () => {
  const { orderToRecord } = await lib();
  assert.deepEqual(orderToRecord(order(), [VARIANT]), { order_id: '5550001', order_name: '#1042', pay_ref: 'SIC-ABC234',
    amount: '500.00', currency: 'USD', ordered_at: '2026-12-18T10:00:00-07:00', test: false });
  const mixed = order({ line_items: [{ variant_id: VARIANT, price: '500.00', quantity: 2, discount_allocations: [{ amount: '25.00' }] },
    { variant_id: 999, price: '40.00', quantity: 1 }] });
  assert.equal(orderToRecord(mixed, [VARIANT]).amount, '975.00');
  assert.equal(orderToRecord(order({ line_items: [{ variant_id: 999, price: '40.00', quantity: 1 }] }), [VARIANT]), null);
  const viaProps = order({ note_attributes: [], line_items: [{ variant_id: VARIANT, price: '500', quantity: 1, properties: [{ name: 'Loan number', value: 'sic-abc234' }] }] });
  assert.equal(orderToRecord(viaProps, [VARIANT]).pay_ref, 'SIC-ABC234');
  assert.equal(orderToRecord(order({ note_attributes: [] }), [VARIANT]).pay_ref, null);
});

test('the function refuses unsigned or unconfigured calls and ignores other orders', async () => {
  const { handleShopifyWebhook } = await lib();
  const seen = [];
  const cfg = { secret: SECRET, variantIds: [String(VARIANT)], shopDomain: 'shop.test', record: async r => { seen.push(r); return { status: 'credited' }; } };
  assert.equal((await handleShopifyWebhook(new Request('https://fn.test/', { method: 'GET' }), cfg)).status, 405);
  assert.equal((await handleShopifyWebhook(req(order(), { 'x-shopify-hmac-sha256': 'forged' }), cfg)).status, 401);
  assert.equal((await handleShopifyWebhook(req(order(), { 'x-shopify-shop-domain': 'other.test' }), cfg)).status, 401);
  assert.equal((await handleShopifyWebhook(req(order(), {}), { ...cfg, secret: '' })).status, 500);
  assert.equal((await handleShopifyWebhook(req(order(), {}), { ...cfg, variantIds: [] })).status, 500);
  const other = await handleShopifyWebhook(req(order(), { 'x-shopify-topic': 'orders/create' }), cfg);
  assert.equal(other.status, 200); assert.match((await other.json()).ignored, /topic/);
  const store = await handleShopifyWebhook(req(order({ line_items: [{ variant_id: 999, price: '40', quantity: 1 }] })), cfg);
  assert.equal(store.status, 200); assert.match((await store.json()).ignored, /no plan payment/);
  assert.equal(seen.length, 0);
  const ok = await handleShopifyWebhook(req(order()), cfg);
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { status: 'credited' });
  assert.equal(seen.length, 1); assert.equal(seen[0].pay_ref, 'SIC-ABC234');
  const down = await handleShopifyWebhook(req(order()), { ...cfg, record: async () => { throw new Error('db down'); } });
  assert.equal(down.status, 500); // Shopify sends it again later
});

// --- database -------------------------------------------------------------------
before(async () => {
  if (skip) return;
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
    '2026-10-30-shop-004-estimates.sql', '2026-11-21-shop-009-payment-plans.sql', '2026-11-22-shop-012-my-payments.sql']) await db.exec(sql(f));
  await db.query(`insert into public.shop_staff (user_id, display_name) values ($1, 'Tyler')`, [U.tyler]);
  // a plan made BEFORE shop-013 gets a loan number when it runs
  await rpc('tyler', 'shop_save_customer', { p_customer_id: 'cust-test-01', p_customer: { name: 'SAMPLE BUYER', email: 'buyer@test.local' },
    p_bike_id: 'bike-test-01', p_bike: { vin: '1HD1TESTVIN062429', make: 'Harley-Davidson', model: 'Low Rider S', year: '2023' } });
  await rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-test-01', p_plan: PLAN });
  await db.exec(sql('2026-11-23-shop-013-shopify-payments.sql'));
  await db.exec(sql('2026-11-23-shop-013-shopify-payments.sql')); // safe to re-run
});
const ref = async id => (await db.query('select pay_ref from public.shop_payment_plans where id = $1', [id])).rows[0].pay_ref;
const balance = async id => Number((await as('tyler', 'select balance from public.shop_payment_plan_summary where id = $1', [id]))[0].balance);

test('every plan has its own loan number, old and new', { skip }, async () => {
  const a = await ref('plan-test-01');
  assert.match(a, /^SIC-[A-HJ-NP-Z2-9]{6}$/);
  await rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-test-02', p_plan: { ...PLAN, payment_amount: '250' } });
  const b = await ref('plan-test-02');
  assert.match(b, /^SIC-[A-HJ-NP-Z2-9]{6}$/); assert.notEqual(a, b);
  await rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-test-01', p_plan: { ...PLAN, notes: 'edited' } });
  assert.equal(await ref('plan-test-01'), a, 'editing a plan keeps its loan number');
  await assert.rejects(db.query(`update public.shop_payment_plans set pay_ref = $1 where id = 'plan-test-02'`, [a]), /duplicate|unique/);
});

test('the buyer sees their loan number; nobody but the server can record an order', { skip }, async () => {
  const mine = await rpc('buyer', 'shop_my_payment_plans', {});
  assert.equal(mine.length, 2);
  assert.ok(mine.every(p => /^SIC-/.test(p.pay_ref)));
  const o = { order_id: '900', amount: '500', currency: 'USD', pay_ref: await ref('plan-test-01') };
  for (const who of ['buyer', 'tyler', 'rider', 'anon']) await assert.rejects(rpc(who, 'shop_record_shopify_order', { p_order: o }), /permission denied/);
  assert.deepEqual(await as('rider', 'select * from public.shop_shopify_orders'), []);
  await assert.rejects(rpc('rider', 'shop_handle_shopify_order', { p_order_id: '900', p_note: 'x' }), /not authorized/);
});

test('a paid order with the plan\'s loan number comes off the balance, once', { skip }, async () => {
  const loan = await ref('plan-test-01');
  const before = await balance('plan-test-01');
  const o = { order_id: '5550001', order_name: '#1042', pay_ref: loan.toLowerCase(), amount: '500.00', currency: 'USD', ordered_at: '2026-12-18T23:30:00Z' };
  const r = await record(o);
  assert.equal(r.status, 'credited'); assert.equal(r.plan_id, 'plan-test-01');
  assert.equal(await balance('plan-test-01'), before - 500);
  const [pay] = await as('tyler', `select * from public.shop_plan_payments where id = 'shopify-5550001'`);
  assert.equal(pay.method, 'Shopify order #1042');
  assert.equal(pay.received_date.toISOString().slice(0, 10), '2026-12-18', 'dated in Arizona time');
  assert.equal(pay.received_by, '00000000-0000-0000-0000-000000000000');
  // Shopify sends the same webhook again: nothing changes
  assert.equal((await record(o)).duplicate, true);
  assert.equal(await balance('plan-test-01'), before - 500);
  const shown = await rpc('buyer', 'shop_my_payment_plans', {});
  assert.ok(shown.find(p => p.id === 'plan-test-01').payments.some(x => x.method === 'Shopify order #1042'));
});

test('orders that do not clearly belong to a plan are held, not credited', { skip }, async () => {
  const loan = await ref('plan-test-01');
  const before = await balance('plan-test-01');
  const cases = [
    [{ order_id: '6001', amount: '500', currency: 'USD' }, /No loan number/],
    [{ order_id: '6002', amount: '500', currency: 'USD', pay_ref: 'SIC-ZZZZZZ' }, /does not match/],
    [{ order_id: '6003', amount: '500', currency: 'CAD', pay_ref: loan }, /US dollars/],
    [{ order_id: '6004', amount: '500', currency: 'USD', pay_ref: loan, test: true }, /Test order/],
    [{ order_id: '6005', amount: '99999', currency: 'USD', pay_ref: loan }, /More than the balance/],
    [{ order_id: '6006', amount: '0', currency: 'USD', pay_ref: loan }, /Nothing paid/],
  ];
  for (const [o, why] of cases) {
    const r = await record(o);
    assert.equal(r.status, 'held', o.order_id); assert.match(r.reason, why);
  }
  assert.equal(await balance('plan-test-01'), before);
  const held = await as('tyler', `select order_id from public.shop_shopify_orders where status = 'held' order by order_id`);
  assert.deepEqual(held.map(h => h.order_id), ['6001', '6002', '6003', '6004', '6005', '6006']);
  await assert.rejects(record({ order_id: 'abc', amount: '1', currency: 'USD' }), /invalid order id/);

  const r = await rpc('tyler', 'shop_handle_shopify_order', { p_order_id: '6001', p_note: 'Refunded in Shopify' });
  assert.equal(r.status, 'handled');
  const [h] = await as('tyler', `select * from public.shop_shopify_orders where order_id = '6001'`);
  assert.equal(h.handled_by, U.tyler); assert.equal(h.handled_note, 'Refunded in Shopify');
  await assert.rejects(rpc('tyler', 'shop_handle_shopify_order', { p_order_id: '6001', p_note: '' }), /not found/);
});

test('a cancelled plan is not credited', { skip }, async () => {
  await rpc('tyler', 'shop_save_payment_plan', { p_plan_id: 'plan-test-02', p_plan: { ...PLAN, payment_amount: '250', status: 'cancelled' } });
  const r = await record({ order_id: '7001', amount: '250', currency: 'USD', pay_ref: await ref('plan-test-02') });
  assert.equal(r.status, 'held'); assert.match(r.reason, /cancelled/);
});

test('the rollback removes shop-013 and the buyer page still works', { skip }, async () => {
  await db.exec(sql('2026-11-23-shop-013-shopify-payments-rollback.sql'));
  const cols = await db.query(`select 1 from information_schema.columns where table_name = 'shop_payment_plans' and column_name = 'pay_ref'`);
  assert.equal(cols.rows.length, 0);
  const mine = await rpc('buyer', 'shop_my_payment_plans', {});
  assert.ok(mine.length >= 1); assert.equal(mine[0].pay_ref, undefined);
  // payments already credited from Shopify stay
  assert.equal((await db.query(`select 1 from public.shop_plan_payments where id = 'shopify-5550001'`)).rows.length, 1);
  await db.exec(sql('2026-11-23-shop-013-shopify-payments.sql')); // and it can go back on
});
