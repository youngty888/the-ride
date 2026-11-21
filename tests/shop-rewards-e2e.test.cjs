// Rewards + Dollars for Dads page in a real browser (Chromium via Playwright)
// against the LOCAL fake backend (real shop SQL + shop-010 in PGlite).
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
const OUT = process.env.SHOP_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'shop-rw-'));
const PW = 'test-password-123';
const EVIL = '<img src=x onerror="window.__pwned=1">TEST Rider';
let backend, browser;

before(async () => {
  if (skip) return;
  const { startFakeBackend } = require('./support/shop-fake-backend.cjs');
  backend = await startFakeBackend({ users: [{ email: 'tyler@test.local', password: PW }, { email: 'rider@test.local', password: PW }],
    staff: [{ email: 'tyler@test.local', name: 'Tyler' }] });
  await backend.db.exec(fs.readFileSync(path.join(__dirname, '..', 'sql', 'shop', '2026-11-21-shop-010-rewards-d4d.sql'), 'utf8'));
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await backend?.close(); });

async function signedInPage(email, width = 1100) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', d => d.type() === 'prompt' ? d.accept(page.promptAnswer || 'TEST reason') : d.accept());
  await page.goto(`${backend.origin}/shop/`);
  await page.waitForSelector('#shSignIn:not([hidden])');
  await page.fill('#shSignInEmail', email); await page.fill('#shSignInPassword', PW);
  await page.click('#shSignInForm button[type=submit]');
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: true });

test('non-staff get no rewards or donation data', { skip }, async () => {
  const page = await signedInPage('rider@test.local');
  await page.waitForSelector('#shNoAccess:not([hidden])');
  await page.goto(`${backend.origin}/shop/rewards.html`);
  await page.waitForSelector('#rwSignedOut:not([hidden])');
  assert.match(await page.locator('#rwSignedOutText').innerText(), /not on the shop staff list/);
  await page.context().close();
});

test('marking a job Paid in the shop gives the customer points; staff use points and see the history', { skip }, async () => {
  const page = await signedInPage('tyler@test.local');
  await page.waitForSelector('#shList:not([hidden])');
  // A completed $300 (before tax) job for a customer whose name holds page code.
  const [t] = await backend.sql(`select id from auth.users where email = 'tyler@test.local'`);
  await backend.sql(`insert into public.shop_customers (id, name, phone, created_by, updated_by) values ('c-e2e', $1, '555-0100', $2, $2)`, [EVIL, t.id]);
  await backend.sql(`insert into public.shop_jobs (id, customer_id, status, payment_status, job_date, parts_amount, labor_amount, tax_amount, total_amount, created_by, updated_by)
                     values ('j-e2e', 'c-e2e', 'complete', 'unpaid', current_date, 100, 200, 8.70, 308.70, $1, $1)`, [t.id]);
  await page.reload(); await page.waitForSelector('#shList:not([hidden])');
  await page.locator('select.sh-pay-select').first().selectOption('paid');
  await page.waitForSelector('#shMsg:not([hidden])');
  await page.click('a[href="rewards.html"]');
  await page.waitForSelector('#rwRewards:not([hidden])');
  assert.match(await page.locator('#rwRule').innerText(), /1 point per \$1/);
  const row = page.locator('.rw-row', { hasText: 'TEST Rider' });
  assert.match(await row.innerText(), /300 pts/);
  assert.match(await row.innerText(), /Worth \$15\.00/);
  await row.click();
  await page.waitForSelector('#rwCustomer:not([hidden])');
  assert.equal(await page.locator('#rwCBal').innerText(), '300');
  assert.match(await page.locator('#rwCRows').innerText(), /Earned/);
  assert.match(await page.locator('#rwCRows').innerText(), /Automatic|Tyler/);
  await page.fill('#rwRedeemPts', '400'); await page.click('#rwRedeemSave');
  await page.waitForSelector('#rwMsg.sh-msg-error:not([hidden])');
  assert.match(await page.locator('#rwMsg').innerText(), /Only 300 points available/);
  await page.fill('#rwRedeemPts', '100');
  assert.match(await page.locator('#rwRedeemWorth').innerText(), /\$5\.00 off/);
  await page.selectOption('#rwRedeemJob', 'j-e2e'); await page.fill('#rwRedeemNote', 'TEST took $5 off');
  await page.click('#rwRedeemSave');
  await page.waitForFunction(() => document.getElementById('rwCBal').textContent === '200');
  assert.match(await page.locator('#rwMsg').innerText(), /Used 100 points \(\$5\.00 off\)\. 200 left/);
  await page.fill('#rwAdjPts', '25'); await page.click('#rwAdjSave');
  assert.match(await page.locator('#rwMsg').innerText(), /Say why/);
  await page.fill('#rwAdjNote', 'TEST sign-up bonus'); await page.click('#rwAdjSave');
  await page.waitForFunction(() => document.getElementById('rwCBal').textContent === '225');
  await shot(page, 'rewards-customer.png');
  const entries = await backend.sql(`select kind, points from public.shop_reward_entries where customer_id = 'c-e2e' order by created_at`);
  assert.deepEqual(entries.map(e => [e.kind, e.points]), [['earn', 300], ['redeem', -100], ['adjust', 25]]);
  assert.equal(await page.evaluate(() => window.__pwned), undefined, 'customer text is never run as page code');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Dollars for Dads: add donations, see raffle entries and prizes, mark sent to ManUp, refund', { skip }, async () => {
  const page = await signedInPage('tyler@test.local', 390);
  await page.waitForSelector('#shList:not([hidden])');
  await page.goto(`${backend.origin}/shop/rewards.html#d4d`);
  await page.waitForSelector('#rwD4d:not([hidden])');
  assert.equal(await page.locator('#rwSRaised').innerText(), '$0.00');
  // Validation
  await page.fill('#rwDonName', 'TEST Donor'); await page.fill('#rwDonAmount', '0'); await page.click('#rwDonSave');
  await page.waitForSelector('#rwDonErrors:not([hidden])');
  // Two gifts from the same email add up: $15 + $10 = $25 -> 25 entries, gaiter earned.
  for (const amt of ['15', '10']) {
    await page.fill('#rwDonName', 'TEST Donor'); await page.fill('#rwDonEmail', 'donor@example.com'); await page.fill('#rwDonAmount', amt);
    await page.click('#rwDonSave'); await page.waitForSelector(`#rwMsg:has-text("Saved $${amt}.00 donation")`);
  }
  await page.fill('#rwDonName', 'TEST Web'); await page.fill('#rwDonOrder', '#9001'); await page.fill('#rwDonAmount', '80');
  await page.click('#rwDonSave'); await page.waitForSelector('#rwMsg:has-text("Saved $80.00 donation")');
  assert.equal(await page.locator('#rwSRaised').innerText(), '$105.00');
  assert.equal(await page.locator('#rwSOwed').innerText(), '$105.00');
  const donor = page.locator('#rwDonors .sh-job', { hasText: 'TEST Donor' });
  assert.match(await donor.innerText(), /25 raffle entries/);
  assert.match(await donor.innerText(), /Give Gaiter/);
  assert.doesNotMatch(await donor.innerText(), /T-shirt/);
  const web = page.locator('#rwDonors .sh-job', { hasText: 'TEST Web' });
  assert.match(await web.innerText(), /⚠/);
  assert.match(await web.innerText(), /Give T-shirt/);
  await donor.getByRole('button', { name: 'Give Gaiter' }).click();
  await page.waitForSelector('#rwDonors .rw-given');
  assert.match(await page.locator('#rwDonors .sh-job', { hasText: 'TEST Donor' }).innerText(), /✓ Gaiter given/);
  // Same Shopify order again is refused.
  await page.fill('#rwDonName', 'TEST Web'); await page.fill('#rwDonOrder', '#9001'); await page.fill('#rwDonAmount', '80');
  await page.click('#rwDonSave'); await page.waitForSelector('#rwMsg.sh-msg-error:has-text("already recorded")');
  // Mark the two TEST Donor gifts as sent to ManUp.
  const boxes = page.locator('#rwDonRows tr', { hasText: 'TEST Donor' }).locator('input[type=checkbox]');
  assert.equal(await boxes.count(), 2);
  await boxes.nth(0).check(); await boxes.nth(1).check();
  await page.click('#rwFwdSave'); await page.waitForSelector('#rwMsg:has-text("Add a reference")');
  await page.locator('#rwDonRows tr', { hasText: 'TEST Donor' }).locator('input[type=checkbox]').nth(0).check();
  await page.locator('#rwDonRows tr', { hasText: 'TEST Donor' }).locator('input[type=checkbox]').nth(1).check();
  await page.fill('#rwFwdRef', 'TEST check 101'); await page.click('#rwFwdSave');
  await page.waitForSelector('#rwMsg:has-text("Marked 2 donations ($25.00) as sent to ManUp")');
  assert.equal(await page.locator('#rwSSent').innerText(), '$25.00');
  assert.equal(await page.locator('#rwSOwed').innerText(), '$80.00');
  // Refund the web gift.
  page.promptAnswer = 'TEST charged back';
  await page.locator('#rwDonRows tr', { hasText: 'TEST Web' }).getByRole('button', { name: 'Refund' }).click();
  await page.waitForSelector('#rwMsg:has-text("Refunded.")');
  assert.equal(await page.locator('#rwSRaised').innerText(), '$25.00');
  assert.equal(await page.locator('#rwSOwed').innerText(), '$0.00');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll on a phone');
  await shot(page, 'd4d-phone.png');
  const rows = await backend.sql(`select count(*)::int as n from public.shop_d4d_donations`);
  assert.equal(rows[0].n, 3, 'refund keeps the record');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
