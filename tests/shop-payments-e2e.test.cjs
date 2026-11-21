// Payment plans page in a real browser (Chromium via Playwright) against the
// LOCAL fake backend, which runs the real shop SQL and permissions in PGlite.
// Does not touch ride.siccycles.com or the live database.
// Needs @electric-sql/pglite and playwright. Skipped without them.
// Set SHOP_E2E_OUT=<folder> to keep screenshots.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium = null;
try { require.resolve('@electric-sql/pglite'); ({ chromium } = require('playwright')); } catch { /* skipped */ }
const skip = chromium ? false : 'needs @electric-sql/pglite and playwright';
const OUT = process.env.SHOP_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'shop-pp-'));
const PW = 'test-password-123';
let backend, browser;

before(async () => {
  if (skip) return;
  const { startFakeBackend } = require('./support/shop-fake-backend.cjs');
  backend = await startFakeBackend({ users: [{ email: 'tyler@test.local', password: PW }, { email: 'rider@test.local', password: PW }],
    staff: [{ email: 'tyler@test.local', name: 'Tyler' }] });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await backend?.close(); });

async function signedInPage(email, width = 1100) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(`${backend.origin}/shop/`);
  await page.waitForSelector('#shSignIn:not([hidden])');
  await page.fill('#shSignInEmail', email); await page.fill('#shSignInPassword', PW);
  await page.click('#shSignInForm button[type=submit]');
  return page;
}

test('non-staff get no payment plan data', { skip }, async () => {
  const page = await signedInPage('rider@test.local');
  await page.waitForSelector('#shNoAccess:not([hidden])');
  await page.goto(`${backend.origin}/shop/payments.html`);
  await page.waitForSelector('#ppSignedOut:not([hidden])');
  assert.match(await page.locator('#ppSignedOutText').innerText(), /not on the shop staff list/);
  await page.context().close();
});

test('staff add a customer, bike and plan, record a payment, and see the balance', { skip }, async () => {
  const page = await signedInPage('tyler@test.local');
  await page.waitForSelector('#shList:not([hidden])');
  await page.click('a[href="payments.html"]');
  await page.waitForSelector('#ppList:not([hidden])');
  await page.click('#ppNewBtn');
  await page.selectOption('#ppCustomer', '__new');
  await page.fill('#ppCName', 'TEST BUYER'); await page.fill('#ppCPhone', '555-0100');
  await page.selectOption('#ppBike', '__new');
  await page.fill('#ppBYear', '2023'); await page.fill('#ppBMake', 'Harley-Davidson'); await page.fill('#ppBModel', 'Low Rider S');
  await page.fill('#ppBVin', 'TESTVIN0000000001'); await page.fill('#ppBMileage', '28000');
  await page.fill('#ppItem', '2023 Harley-Davidson Low Rider S');
  await page.fill('#ppSaleDate', '2026-11-15'); await page.fill('#ppPrice', '11,000'); await page.fill('#ppMonthly', '500');
  await page.fill('#ppDueDay', '18'); await page.fill('#ppFirstDue', '2099-12-18');
  await page.click('#ppPlanSave');
  await page.waitForSelector('#ppDetail:not([hidden])');
  assert.equal(await page.locator('#ppBalance').innerText(), '$11,000.00');
  assert.equal(await page.locator('#ppLeft').innerText(), '22');
  assert.equal(await page.locator('#ppNext').innerText(), 'Dec 18, 2099');
  assert.equal(await page.locator('#ppPayoff').innerText(), 'Sep 18, 2101');
  await page.screenshot({ path: path.join(OUT, 'plan-new.png'), fullPage: true });

  await page.fill('#ppPayAmount', '750'); await page.click('#ppPaySave');
  await page.waitForFunction(() => document.getElementById('ppBalance').textContent === '$10,250.00');
  assert.match(await page.locator('#ppRows').innerText(), /\$750\.00[\s\S]*Tyler[\s\S]*\$10,250\.00/);
  assert.equal(await page.locator('#ppNext').innerText(), 'Jan 18, 2100'); // paid early counts for Dec
  await page.screenshot({ path: path.join(OUT, 'plan-paid.png'), fullPage: true });

  const [bike] = await backend.sql(`select b.mileage, b.year, c.name from public.shop_bikes b join public.shop_customers c on c.id = b.customer_id`);
  assert.deepEqual([bike.mileage, bike.year, bike.name], [28000, 2023, 'TEST BUYER']);

  await page.click('#ppBack');
  await page.waitForSelector('#ppList:not([hidden])');
  assert.match(await page.locator('#ppPlans').innerText(), /TEST BUYER[\s\S]*\$10,250\.00/);
  // phone width: no sideways scrolling
  await page.setViewportSize({ width: 375, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
