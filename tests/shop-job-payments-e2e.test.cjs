// Payments on invoices (shop-017) in a real browser (Chromium via Playwright)
// against the LOCAL fake backend, which runs the real shop SQL in PGlite.
// Does not touch ride.siccycles.com or the live database. Sample data only.
// Needs @electric-sql/pglite and playwright. Skipped without them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let chromium = null;
try { require.resolve('@electric-sql/pglite'); ({ chromium } = require('playwright')); } catch { /* skipped */ }
const skip = chromium ? false : 'needs @electric-sql/pglite and playwright';
const PW = 'test-password-123';
let withPay, withoutPay, browser;
const TYLER = { email: 'tyler@test.local', password: PW };

async function backendWith(extraSql) {
  const { startFakeBackend } = require('./support/shop-fake-backend.cjs');
  const users = [{ ...TYLER }];
  const b = await startFakeBackend({ users, staff: [{ email: TYLER.email, name: 'Tyler' }], extraSql });
  await b.sql(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: users[0].id, role: 'authenticated' })]);
  await b.sql(`select public.shop_save_estimate('jobpay0001', 'custpay001', '{"name":"TEST CUSTOMER"}'::jsonb, null, null, '{}'::jsonb,
    '[{"kind":"labor","description":"Fork rebuild","quantity":"2","unit_price":"150"}]'::jsonb)`);
  await b.sql(`select public.shop_set_job_status('jobpay0001', 'in_progress')`);
  await b.sql(`select public.shop_set_job_status('jobpay0001', 'complete')`);
  await b.sql(`select set_config('request.jwt.claims', '', false)`);
  return b;
}

before(async () => {
  if (skip) return;
  withPay = await backendWith(['2026-11-27-shop-017-job-payments.sql']);
  withoutPay = await backendWith([]);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await withPay?.close(); await withoutPay?.close(); });

async function signedInPage(backend) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', d => d.type() === 'prompt' ? d.accept('Typed the wrong amount') : d.accept());
  await page.goto(`${backend.origin}/shop/`);
  await page.waitForSelector('#shSignIn:not([hidden])');
  await page.fill('#shSignInEmail', TYLER.email); await page.fill('#shSignInPassword', PW);
  await page.click('#shSignInForm button[type=submit]');
  await page.waitForSelector('#shList:not([hidden])');
  await page.click('button[data-filter="closed"]');   // finished jobs live under Closed
  await page.waitForSelector('.sh-job');
  return page;
}
const card = page => page.locator('.sh-job', { hasText: 'TEST CUSTOMER' });

test('record a part payment and the rest: board, payments list and invoice show the money', { skip }, async () => {
  const page = await signedInPage(withPay);
  await card(page).getByRole('button', { name: 'Payments' }).click();
  await page.waitForSelector('#shPayments:not([hidden])');
  const total = await page.locator('#shPayTotals strong').first().innerText();
  assert.equal(await page.inputValue('#shPayAmount'), total.replace(/[$,]/g, ''));  // defaults to what's owed
  await page.fill('#shPayAmount', '100');
  await page.selectOption('#shPayMethod', 'cash');
  await page.fill('#shPayNote', 'Deposit');
  await page.click('#shPaySave');
  await page.waitForFunction(() => /Paid\n?\$100\.00/.test(document.querySelector('#shPayTotals').innerText));
  assert.match(await page.locator('#shPayList').innerText(), /\$100\.00 · Cash/);
  await page.click('#shPayBack');
  await page.waitForSelector('#shList:not([hidden])');
  assert.match(await card(page).innerText(), /Paid \$100\.00 of \$/);
  assert.equal(await card(page).locator('.sh-pay-select').count(), 0);   // status now follows the money

  await card(page).getByRole('button', { name: 'Payments' }).click();
  await page.waitForSelector('#shPayments:not([hidden])');
  await page.selectOption('#shPayMethod', 'zelle');
  await page.click('#shPaySave');                                        // amount was prefilled with the rest
  await page.waitForSelector('#shPayDone:not([hidden])');
  assert.equal(await page.locator('#shPayDue').innerText(), '$0.00');
  await page.click('#shPayBack');
  await page.waitForSelector('#shList:not([hidden])');
  assert.match(await card(page).innerText(), /\bPaid\b/);

  await card(page).getByRole('button', { name: 'View / Print' }).click();
  await page.waitForSelector('#shPrintView:not([hidden])');
  const doc = await page.locator('#shDoc').innerText();
  assert.match(doc, /Paid .*\(Cash\)\s+-\$100\.00/);
  assert.match(doc, /\(Zelle\)/);
  assert.match(doc, /Balance due\s+\$0\.00/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('voiding a payment puts the balance back', { skip }, async () => {
  const page = await signedInPage(withPay);
  await card(page).getByRole('button', { name: 'Payments' }).click();
  await page.waitForSelector('#shPayments:not([hidden])');
  await page.locator('.sh-pay-row', { hasText: 'Zelle' }).getByRole('button', { name: 'Void' }).click();
  await page.waitForSelector('.sh-pay-void');
  assert.match(await page.locator('.sh-pay-void').innerText(), /Void: Typed the wrong amount/);
  assert.equal(await page.isVisible('#shPayForm'), true);
  const [row] = await withPay.sql(`select payment_status from public.shop_jobs where id = 'jobpay0001'`);
  assert.equal(row.payment_status, 'partial');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('before shop-017 is run, the old label dropdown still works and no Payments button shows', { skip }, async () => {
  const page = await signedInPage(withoutPay);
  assert.equal(await card(page).getByRole('button', { name: 'Payments' }).count(), 0);
  await card(page).locator('.sh-pay-select').selectOption('partial');
  await page.waitForFunction(() => /Part paid/.test(document.querySelector('.sh-job').innerText));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
