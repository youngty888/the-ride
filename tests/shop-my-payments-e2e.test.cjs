// Buyer's payment page (/pay/) in a real browser against the LOCAL fake
// backend (real shop SQL and permissions in PGlite). Does not touch
// ride.siccycles.com or the live database.
// Needs @electric-sql/pglite and playwright. Skipped without them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium = null;
try { require.resolve('@electric-sql/pglite'); ({ chromium } = require('playwright')); } catch { /* skipped */ }
const skip = chromium ? false : 'needs @electric-sql/pglite and playwright';
const OUT = process.env.SHOP_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'shop-my-'));
const PW = 'test-password-123';
const iso = d => d.toISOString().slice(0, 10);
const daysFrom = n => iso(new Date(Date.now() + n * 86400000));
let backend, browser;

before(async () => {
  if (skip) return;
  const { startFakeBackend } = require('./support/shop-fake-backend.cjs');
  backend = await startFakeBackend({ users: [{ email: 'tyler@test.local', password: PW }, { email: 'buyer@test.local', password: PW },
    { email: 'late@test.local', password: PW }, { email: 'rider@test.local', password: PW }],
    staff: [{ email: 'tyler@test.local', name: 'Tyler' }] });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await backend?.close(); });

async function page(width = 1100) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await ctx.newPage(); p.errors = [];
  p.on('pageerror', e => p.errors.push(e.message));
  return p;
}
async function signInAtPay(p, email) {
  await p.goto(`${backend.origin}/pay/`);
  await p.waitForSelector('#mySignIn:not([hidden])');
  await p.fill('#myEmail', email); await p.fill('#myPassword', PW);
  await p.click('#mySignInForm button[type=submit]');
}

test('staff set up two sample plans', { skip }, async () => {
  const p = await page();
  await p.goto(`${backend.origin}/shop/`);
  await p.waitForSelector('#shSignIn:not([hidden])');
  await p.fill('#shSignInEmail', 'tyler@test.local'); await p.fill('#shSignInPassword', PW);
  await p.click('#shSignInForm button[type=submit]');
  await p.waitForSelector('#shList:not([hidden])');
  const plan = (c, first, link) => ({ customer_id: c, item: '2023 Harley-Davidson Low Rider S', sale_date: daysFrom(-40), sale_price: '11000', down_payment: '0',
    schedule: 'monthly', payment_amount: '500', due_day: '18', first_due_date: first, apr: '0', late_fee_per_day: '0', late_fee_waived: true,
    pay_provider: 'stripe', pay_link_url: link, autopay: 'off', notes: 'SHOP PRIVATE NOTE' });
  await p.evaluate(async ({ a, b }) => {
    await ShApi.rpc('shop_save_customer', { p_customer_id: 'cust-buyer-01', p_customer: { name: 'SAMPLE BUYER', email: 'buyer@test.local' }, p_bike_id: null, p_bike: null });
    await ShApi.rpc('shop_save_customer', { p_customer_id: 'cust-late-01', p_customer: { name: 'LATE BUYER', email: 'LATE@test.local' }, p_bike_id: null, p_bike: null });
    await ShApi.rpc('shop_save_payment_plan', { p_plan_id: 'plan-buyer-01', p_plan: a });
    await ShApi.rpc('shop_save_payment_plan', { p_plan_id: 'plan-late-01', p_plan: b });
    await ShApi.rpc('shop_record_plan_payment', { p_payment_id: 'pay-buyer-01', p_payment: { plan_id: 'plan-buyer-01', amount: '500', received_date: new Date().toISOString().slice(0, 10), method: 'Card (pay link)' } });
  }, { a: plan('cust-buyer-01', daysFrom(-3), 'https://buy.stripe.com/test_SAMPLE'), b: { ...plan('cust-late-01', daysFrom(-10), ''), due_day: String(new Date(Date.now() - 10 * 86400000).getUTCDate() > 28 ? 28 : new Date(Date.now() - 10 * 86400000).getUTCDate()) } });
  await p.context().close();
});

test('buyer signs in, sees the balance, the next due date and a Make a payment button', { skip }, async () => {
  const p = await page();
  await signInAtPay(p, 'buyer@test.local');
  await p.waitForSelector('#myPlans:not([hidden])');
  const text = await p.locator('#myPlans').innerText();
  assert.match(text, /2023 Harley-Davidson Low Rider S/);
  assert.match(text, /\$10,500\.00/); assert.match(text, /On track/);
  assert.match(text, /Card \(pay link\)/);
  assert.doesNotMatch(text, /late fee/i); assert.doesNotMatch(text, /SHOP PRIVATE NOTE/);
  assert.equal(await p.getAttribute('.my-paybtn', 'href'), 'https://buy.stripe.com/test_SAMPLE');
  assert.equal(await p.getAttribute('.my-paybtn', 'rel'), 'noopener noreferrer');
  await p.screenshot({ path: path.join(OUT, 'pay-buyer.png'), fullPage: true });
  // still signed in after a reload
  await p.reload(); await p.waitForSelector('#myPlans:not([hidden])');
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test('a late buyer with no pay link sees what is past due, no late fee, and to call the shop', { skip }, async () => {
  const p = await page(375);
  await signInAtPay(p, 'late@test.local');
  await p.waitForSelector('#myPlans:not([hidden])');
  const text = await p.locator('#myPlans').innerText();
  assert.match(text, /Past due/); assert.match(text, /\$500\.00 is past due/);
  assert.doesNotMatch(text, /late fee/i);
  assert.match(text, /Online payment is not set up yet/);
  assert.equal(await p.isHidden('.my-paybtn'), true);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `page scrolls sideways by ${overflow}px at 375px`);
  await p.screenshot({ path: path.join(OUT, 'pay-late-375.png'), fullPage: true });
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test('a login with no plan sees "No payment plan found"; a wrong password is refused', { skip }, async () => {
  const p = await page();
  await p.goto(`${backend.origin}/pay/`);
  await p.waitForSelector('#mySignIn:not([hidden])');
  await p.fill('#myEmail', 'buyer@test.local'); await p.fill('#myPassword', 'wrong-password');
  await p.click('#mySignInForm button[type=submit]');
  await p.waitForSelector('#myMsg:not([hidden])');
  assert.equal(await p.isVisible('#myPlans'), false);
  await signInAtPay(p, 'rider@test.local');
  await p.waitForSelector('#myNone:not([hidden])');
  assert.match(await p.locator('#myNoneEmail').innerText(), /rider@test\.local/);
  await p.click('#myOut'); await p.waitForSelector('#mySignIn:not([hidden])');
  await p.context().close();
});

test('a failed load says so and can be retried; it never claims there is no plan', { skip }, async () => {
  const p = await page(375);
  let fail = 'server';
  await p.route('**/rest/v1/rpc/shop_my_payment_plans', route => fail === 'server' ? route.fulfill({ status: 500, body: '{"message":"boom"}', contentType: 'application/json' }) : route.continue());
  await p.route('**/auth/v1/user', route => fail === 'offline' ? route.abort() : route.continue());
  await signInAtPay(p, 'buyer@test.local');
  await p.waitForSelector('#myError:not([hidden])');
  assert.equal(await p.isVisible('#myNone'), false);
  fail = 'offline';
  await p.reload();
  await p.waitForSelector('#myError:not([hidden])');
  assert.equal(await p.isVisible('#mySignIn'), false);
  fail = '';
  await p.click('#myRetry');
  await p.waitForSelector('#myPlans:not([hidden])');
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test('Shopify checkout: the button carries the loan number, a paid order shows up, an odd one is held for staff', { skip }, async () => {
  const CART = 'https://www.example-shop.test/cart/111222333:1';
  const st = await page();
  await st.goto(`${backend.origin}/shop/`);
  await st.waitForSelector('#shSignIn:not([hidden])');
  await st.fill('#shSignInEmail', 'tyler@test.local'); await st.fill('#shSignInPassword', PW);
  await st.click('#shSignInForm button[type=submit]');
  await st.waitForSelector('#shList:not([hidden])');
  await st.evaluate(async cart => {
    await ShApi.rpc('shop_save_payment_plan', { p_plan_id: 'plan-buyer-01', p_plan: { customer_id: 'cust-buyer-01', item: '2023 Harley-Davidson Low Rider S',
      sale_date: new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10), sale_price: '11000', down_payment: '0', schedule: 'monthly', payment_amount: '500',
      due_day: '18', first_due_date: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), apr: '0', late_fee_per_day: '0', late_fee_waived: true,
      pay_provider: 'shopify', pay_link_url: cart, autopay: 'off', notes: 'SHOP PRIVATE NOTE' } });
  }, CART);
  const [{ pay_ref: ref }] = await backend.sql(`select pay_ref from public.shop_payment_plans where id = 'plan-buyer-01'`);
  assert.match(ref, /^SIC-[A-Z0-9]{6}$/);

  const p = await page(375);
  await signInAtPay(p, 'buyer@test.local');
  await p.waitForSelector('#myPlans:not([hidden])');
  assert.equal(await p.getAttribute('.my-paybtn', 'href'), `${CART}?attributes[Loan]=${ref}`);
  const text = await p.locator('#myPlans').innerText();
  assert.match(text, new RegExp(`Loan number ${ref}`));
  assert.match(text, /Use this same button every time/);

  // the server (webhook) reports one good order and one with no loan number
  const rec = o => backend.sql('select public.shop_record_shopify_order($1::jsonb) as r', [JSON.stringify(o)]);
  assert.equal((await rec({ order_id: '5550001', order_name: '#1042', pay_ref: ref, amount: '500.00', currency: 'USD' }))[0].r.status, 'credited');
  assert.equal((await rec({ order_id: '5550002', order_name: '#1043', amount: '500.00', currency: 'USD' }))[0].r.status, 'held');
  await p.reload(); await p.waitForSelector('#myPlans:not([hidden])');
  const after = await p.locator('#myPlans').innerText();
  assert.match(after, /Shopify order #1042/); assert.match(after, /\$10,000\.00/);
  await p.screenshot({ path: path.join(OUT, 'pay-shopify-375.png'), fullPage: true });
  assert.deepEqual(p.errors, []);
  await p.context().close();

  await st.goto(`${backend.origin}/shop/payments.html`);
  await st.waitForSelector('#ppHeld:not([hidden])');
  assert.match(await st.locator('#ppHeld').innerText(), /#1043.*\$500\.00.*No loan number/s);
  await st.goto(`${backend.origin}/shop/payments.html?plan=plan-buyer-01`);
  await st.waitForSelector('#ppDetail:not([hidden])');
  const detail = await st.locator('#ppDetail').innerText();
  assert.match(detail, new RegExp(`Loan number\\s+${ref}`));
  assert.match(detail, /Shopify \(automatic\)/);
  assert.equal(await st.getAttribute('#ppPayLinkOpen', 'href'), `${CART}?attributes[Loan]=${ref}`);
  await st.screenshot({ path: path.join(OUT, 'staff-shopify-plan.png'), fullPage: true });
  await st.click('#ppBack');
  st.once('dialog', d => d.accept('Refunded in Shopify'));
  await st.click('#ppHeldRows button');
  await st.waitForSelector('#ppHeld', { state: 'hidden' });
  const [h] = await backend.sql(`select status, handled_note from public.shop_shopify_orders where order_id = '5550002'`);
  assert.deepEqual(h, { status: 'handled', handled_note: 'Refunded in Shopify' });
  assert.deepEqual(st.errors, []);
  await st.context().close();
});
