// Dads Don't Quit (Dollars for Dads, ManUp Movement): the giving and round-up
// links (d4d.js), the webhook's reading of gift and ManUp merch lines
// (supabase/functions/shopify-orders-paid/lib.mjs), and the points database
// (sql/shop/2026-11-27-shop-016-dads-points.sql). Uses sample data only.
// Database part needs PGlite: `npm i --no-save @electric-sql/pglite`. Skipped without it.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../d4d.js');

let hasPg = false;
try { require.resolve('@electric-sql/pglite'); hasPg = true; } catch { /* skipped below */ }
const skip = hasPg ? false : 'PGlite not installed (npm i --no-save @electric-sql/pglite)';
const root = path.join(__dirname, '..');
const sql = f => fs.readFileSync(path.join(root, 'sql', 'shop', f), 'utf8');
const lib = () => import(path.join(root, 'supabase', 'functions', 'shopify-orders-paid', 'lib.mjs'));
const U = { tyler: '00000000-0000-4000-9000-000000000001', rider: '00000000-0000-4000-9000-000000000003',
  buyer: '00000000-0000-4000-9000-000000000004' };
const MEMBER = '00000000-0000-4000-9000-000000000003';
const [V100, V50, V25, V20, V10, V5, V1] = D.VARIANTS.map(v => v[1]);

// --- links ----------------------------------------------------------------------
test('a gift is split into the fewest donation lines', () => {
  assert.deepEqual(D.lines(35), [[V25, 1], [V10, 1]]);
  assert.deepEqual(D.lines(100), [[V100, 1]]);
  assert.deepEqual(D.lines(45), [[V25, 1], [V20, 1]]);
  assert.deepEqual(D.lines(18), [[V10, 1], [V5, 1], [V1, 3]]);
  for (const bad of [0, -5, 2.5, 'x', null, D.MAX_GIFT + 1]) assert.deepEqual(D.lines(bad), []);
});

test('round-up gives whole dollars to the next $1, $5 and $10', () => {
  assert.equal(D.roundUp('37.40', 1), 1);
  assert.equal(D.roundUp('37.40', 5), 3);
  assert.equal(D.roundUp('37.40', 10), 3);
  assert.equal(D.roundUp(40, 5), 0);
  assert.deepEqual(D.roundUpChoices('$37.40'), [{ step: 1, add: 1, total: 38.4 }, { step: 5, add: 3, total: 40.4 }]);
  assert.deepEqual(D.roundUpChoices(500), []);
  assert.deepEqual(D.roundUpChoices(''), []);
  assert.deepEqual(D.roundUpChoices(42), [{ step: 5, add: 3, total: 45 }, { step: 10, add: 8, total: 50 }]);
});

test('the give link goes to the SIC Cycles store with the rider id, never anything else', () => {
  assert.equal(D.donateLink(35, { member: MEMBER }),
    `https://www.siccycles.com/cart/${V25}:1,${V10}:1?attributes[Dollars%20for%20Dads]=RIDE%20app&attributes[RIDE%20member]=${MEMBER}`);
  assert.equal(D.donateLink(5, { member: 'not-a-uuid"><script>' }), `https://www.siccycles.com/cart/${V5}:1?attributes[Dollars%20for%20Dads]=RIDE%20app`);
  assert.equal(D.donateLink(0), '');
});

test('a round-up joins a SIC Cycles cart and leaves every other link alone', () => {
  const cart = 'https://www.siccycles.com/cart/111222333:1?attributes[Loan]=SIC-ABC234';
  assert.equal(D.addToCart(cart, 3, { member: MEMBER }),
    `https://www.siccycles.com/cart/111222333:1,${V1}:3?attributes[Loan]=SIC-ABC234&attributes[Dollars%20for%20Dads]=Round-up&attributes[RIDE%20member]=${MEMBER}`);
  assert.equal(D.addToCart('https://www.siccycles.com/cart/111222333:1', 5), `https://www.siccycles.com/cart/111222333:1,${V5}:1?attributes[Dollars%20for%20Dads]=Round-up`);
  for (const other of ['https://evil.test/cart/111222333:1', 'https://www.siccycles.com.evil.test/cart/1:1',
    'https://buy.stripe.com/x', 'javascript:alert(1)', '']) assert.equal(D.addToCart(other, 5), other);
  assert.equal(D.addToCart(cart, 0), cart);
  assert.equal(D.canAddTo(cart), true);
  assert.equal(D.canAddTo('https://buy.stripe.com/x'), false);
});

test('tiers and points follow the total given', () => {
  assert.equal(D.tierFor(0).current, null);
  assert.equal(D.tierFor(0).next.min, 30);
  assert.equal(D.tierFor(29.5).toNext, 0.5);
  assert.deepEqual(D.TIERS.map(t => [t.min, t.gift]), [[30, 'ManUp T-shirt'], [50, 'ManUp long sleeve shirt'], [100, 'ManUp hoodie']]);
  assert.equal(D.tierFor(60).current.min, 50);
  assert.equal(D.tierFor(150).next, null);
  assert.equal(D.pointsFor(37.9), 37);
});

test('the profile, the shop and the bike payment page all offer Dollars for Dads', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /id="shopDads"/);
  assert.ok(html.indexOf('d4d.js') < html.indexOf('app.js?'), 'd4d.js loads before app.js');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(app, /id="dadsCard"/);
  assert.match(app, /renderDads\(document\.getElementById\('shopDads'\)/);
  assert.match(app, /rpc\/ride_my_dads/);
  const pay = fs.readFileSync(path.join(root, 'pay', 'index.html'), 'utf8');
  assert.match(pay, /data-k="dadsPick"/);
  assert.ok(pay.indexOf('d4d.js') < pay.indexOf('pay.js?'), 'd4d.js loads before pay.js');
});

test('a points tally shows on the Shop header, the profile and next to the round-up', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const header = html.slice(html.indexOf('class="screen-header shop-header"'), html.indexOf('class="shop-content"'));
  assert.match(header, /data-dads-tally[^>]*data-dads-goto="shopDads"/);
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const at = app.indexOf('<div class="profile-header">'); const profile = app.slice(at, app.indexOf('<div class="profile-stats">', at));
  assert.match(profile, /data-dads-tally[^>]*data-dads-goto="dadsCard"/);
  assert.match(app, /screenName === 'shop' \|\| screenName === 'profile'\) this\.refreshDadsTally\(\)/);
  const pay = fs.readFileSync(path.join(root, 'pay', 'index.html'), 'utf8');
  assert.match(pay, /data-k="dadsPoints"/);
  assert.match(fs.readFileSync(path.join(root, 'pay', 'pay.js'), 'utf8'), /rpc\('ride_my_dads'/);
});

test('the database starts with the same tiers as the app', () => {
  const text = sql('2026-11-27-shop-016-dads-points.sql');
  for (const t of D.TIERS) assert.ok(text.includes(`(${t.min}, '${t.name}', '${t.gift}')`), `tier ${t.min} in shop-016`);
});

// --- webhook --------------------------------------------------------------------
const SECRET = 'test-signing-secret';
const PLAN_VARIANT = 111222333;
const DADS = { donationVariantIds: D.VARIANTS.map(v => v[1]), manupVendors: ['manup'], manupProductIds: ['777'] };
const sign = body => crypto.createHmac('sha256', SECRET).update(body).digest('base64');
const order = over => ({ id: 6660001, name: '#2001', currency: 'USD', email: 'Buyer@Test.Local', test: false,
  note_attributes: [{ name: 'Dollars for Dads', value: 'RIDE app' }, { name: 'RIDE member', value: MEMBER.toUpperCase() }],
  line_items: [{ variant_id: Number(V25), price: '25.00', quantity: 1 }, { variant_id: Number(V5), price: '5.00', quantity: 2 },
    { variant_id: 42, product_id: 9, vendor: 'ManUp Movement', price: '30.00', quantity: 1, discount_allocations: [{ amount: '3.00' }] },
    { variant_id: 43, product_id: 777, vendor: 'Other', price: '10.00', quantity: 1 },
    { variant_id: 44, product_id: 8, vendor: 'Daytona', price: '199.00', quantity: 1 }], ...over });
function req(body, headers = {}) {
  const raw = JSON.stringify(body);
  return new Request('https://fn.test/shopify-orders-paid', { method: 'POST', body: raw,
    headers: { 'x-shopify-hmac-sha256': sign(raw), 'x-shopify-topic': 'orders/paid', 'x-shopify-shop-domain': 'shop.test', ...headers } });
}

test('the webhook counts gift lines and ManUp merch lines, nothing else', async () => {
  const { orderToDads } = await lib();
  assert.deepEqual(orderToDads(order(), DADS), { order_id: '6660001', order_name: '#2001', email: 'buyer@test.local',
    ride_member: MEMBER, donation: '35.00', merch: '37.00', currency: 'USD', test: false });
  assert.equal(orderToDads(order({ line_items: [{ variant_id: 44, vendor: 'Daytona', price: '199', quantity: 1 }] }), DADS), null);
  const viaProps = order({ note_attributes: [], line_items: [{ variant_id: Number(V10), price: '10', quantity: 1, properties: [{ name: 'RIDE member', value: MEMBER }] }] });
  assert.equal(orderToDads(viaProps, DADS).ride_member, MEMBER);
  assert.equal(orderToDads(order({ note_attributes: [] }), DADS).ride_member, null);
  assert.equal(orderToDads(order({ line_items: [{ variant_id: 42, vendor: 'The Man-Up Movement', price: '20', quantity: 1 }] }), DADS).merch, '20.00');
});

test('one order can pay a bike plan and give to Dads; plan-only orders answer as before', async () => {
  const { handleShopifyWebhook } = await lib();
  const plans = []; const gifts = [];
  const base = { secret: SECRET, variantIds: [String(PLAN_VARIANT)], shopDomain: 'shop.test', record: async r => { plans.push(r); return { status: 'credited' }; } };
  const cfg = { ...base, dads: { ...DADS, record: async r => { gifts.push(r); return { status: 'credited', points: Number(r.donation) | 0 }; } } };
  const planLine = { variant_id: PLAN_VARIANT, price: '500.00', quantity: 1 };
  const loan = { name: 'Loan', value: 'SIC-ABC234' };

  // plan only, Dads off: the exact old answer
  const old = await handleShopifyWebhook(req(order({ note_attributes: [loan], line_items: [planLine] })), base);
  assert.deepEqual(await old.json(), { status: 'credited' });

  // round-up on a bike payment: both recorded, the plan sees only its own line
  const both = await handleShopifyWebhook(req(order({ note_attributes: [loan, { name: 'RIDE member', value: MEMBER }],
    line_items: [planLine, { variant_id: Number(V1), price: '1.00', quantity: 3 }] })), cfg);
  assert.equal(both.status, 200);
  assert.deepEqual(await both.json(), { status: 'credited', dads: { status: 'credited', points: 3 } });
  assert.equal(plans.at(-1).amount, '500.00');
  assert.equal(gifts.at(-1).donation, '3.00');

  // a gift alone works even with no plan product set up
  const alone = await handleShopifyWebhook(req(order()), { ...cfg, variantIds: [] });
  assert.equal(alone.status, 200); assert.deepEqual(await alone.json(), { dads: { status: 'credited', points: 35 } });

  // a normal store order is ignored
  const store = await handleShopifyWebhook(req(order({ line_items: [{ variant_id: 44, vendor: 'Daytona', price: '199', quantity: 1 }] })), cfg);
  assert.match((await store.json()).ignored, /no plan payment or Dads gift/);

  // the points database down: 500 so Shopify sends it again
  const down = await handleShopifyWebhook(req(order()), { ...cfg, dads: { ...cfg.dads, record: async () => { throw new Error('db down'); } } });
  assert.equal(down.status, 500);
  // a forged call never records anything
  const n = gifts.length;
  assert.equal((await handleShopifyWebhook(req(order(), { 'x-shopify-hmac-sha256': 'forged' }), cfg)).status, 401);
  assert.equal(gifts.length, n);
});

// --- database -------------------------------------------------------------------
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
const rpc = async (role, fn, args = {}) => {
  const keys = Object.keys(args);
  return (await as(role, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map(k => args[k])))[0].r;
};
const record = o => rpc('server', 'ride_record_dads_order', { p_order: o });
const gift = over => ({ order_id: '7000001', order_name: '#3001', email: 'rider@test.local', ride_member: null,
  donation: '35.00', merch: '0.00', currency: 'USD', test: false, ...over });

before(async () => {
  if (skip) return;
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${name}@test.local`]);
  await db.exec(sql('2026-10-04-shop-001-core.sql'));
  await db.query(`insert into public.shop_staff (user_id, display_name) values ($1, 'Tyler')`, [U.tyler]);
  await db.exec(sql('2026-11-27-shop-016-dads-points.sql'));
  await db.exec(sql('2026-11-27-shop-016-dads-points.sql')); // safe to re-run
});

test('a paid gift lands on the rider by RIDE id, or by confirmed email, once', { skip }, async () => {
  assert.equal((await record(gift({ ride_member: U.rider, email: 'someone-else@test.local' }))).status, 'credited');
  assert.equal((await record(gift())).duplicate, true);
  assert.equal((await record(gift({ order_id: '7000002', donation: '0', merch: '37.90' }))).points, 37);
  const mine = await rpc('rider', 'ride_my_dads');
  assert.equal(mine.points, 72);
  assert.equal(Number(mine.donated), 35);
  assert.equal(Number(mine.merch), 37.9);
  assert.deepEqual(mine.tiers.map(t => [Number(t.min), t.earned]), [[30, true], [50, false], [100, false]]);
  assert.equal(mine.history.length, 2);
  assert.equal((await rpc('buyer', 'ride_my_dads')).points, 0);
});

test('test, foreign-currency and unmatched orders are held, not credited', { skip }, async () => {
  assert.equal((await record(gift({ order_id: '7000010', test: true }))).reason, 'Test order');
  assert.equal((await record(gift({ order_id: '7000011', currency: 'CAD' }))).status, 'held');
  assert.equal((await record(gift({ order_id: '7000012', email: 'nobody@test.local' }))).status, 'held');
  await db.query(`update auth.users set email_confirmed_at = null where id = $1`, [U.buyer]);
  assert.equal((await record(gift({ order_id: '7000013', email: 'buyer@test.local' }))).status, 'held');
  assert.equal((await rpc('buyer', 'ride_my_dads')).points, 0);
  await assert.rejects(record(gift({ order_id: 'abc' })), /invalid order id/);
  await assert.rejects(record(gift({ order_id: '7000014', donation: '-5' })), /invalid amount/);
});

test('only the server records orders, and only staff add points or hand out gifts', { skip }, async () => {
  await assert.rejects(rpc('rider', 'ride_record_dads_order', { p_order: gift({ order_id: '7000020' }) }), /permission denied/);
  await assert.rejects(rpc('anon', 'ride_my_dads'), /permission denied/);
  await assert.rejects(rpc('rider', 'ride_dads_add', { p_email: 'rider@test.local', p_kind: 'donation', p_amount: 100, p_points: null, p_note: 'x' }), /not authorized/);
  await assert.rejects(rpc('rider', 'ride_dads_give_gift', { p_email: 'rider@test.local', p_min: 25, p_note: null }), /not authorized/);
  await assert.rejects(as('rider', 'insert into public.ride_dads_points (user_id, kind, amount, points, source) values ($1, $2, 1, 1000, $3)', [U.rider, 'adjust', 'staff']));
  const others = await as('rider', 'select user_id from public.ride_dads_points');
  assert.ok(others.length > 0 && others.every(r => r.user_id === U.rider));
});

test('staff add a gift made on manup-movement.org and hand out the thank-you gift', { skip }, async () => {
  await rpc('tyler', 'ride_dads_add', { p_email: 'rider@test.local', p_kind: 'donation', p_amount: 20, p_points: null, p_note: 'PayPal gift on manup-movement.org' });
  await assert.rejects(rpc('tyler', 'ride_dads_give_gift', { p_email: 'rider@test.local', p_min: 100, p_note: null }), /not reached/);
  await rpc('tyler', 'ride_dads_give_gift', { p_email: 'rider@test.local', p_min: 50, p_note: 'Black shirt, size L' });
  const mine = await rpc('rider', 'ride_my_dads');
  assert.equal(Number(mine.donated), 55);
  assert.equal(mine.points, 92);
  const t50 = mine.tiers.find(t => Number(t.min) === 50);
  assert.equal(t50.earned, true); assert.equal(t50.given, true);
  const list = await as('tyler', 'select * from public.ride_dads_members()');
  const row = list.find(r => r.email === 'rider@test.local');
  assert.deepEqual(row.gifts_to_hand_out, ['ManUp T-shirt']); assert.equal(row.tier, 'Riding Brother');
});
