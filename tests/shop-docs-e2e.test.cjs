// Shop "+ New" menu and document library in a real browser (Chromium via
// Playwright), against the LOCAL fake backend, which runs the real shop SQL
// (including shop-010) in an in-process Postgres. Does not touch the live site.
// Needs: npm i --no-save @electric-sql/pglite, and Playwright. Skipped without them.
// Set SHOP_E2E_OUT=<folder> to keep screenshots.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium = null;
try { require.resolve('@electric-sql/pglite'); ({ chromium } = require('playwright')); } catch { /* skipped */ }
const skip = chromium ? false : 'needs @electric-sql/pglite and playwright';
const OUT = process.env.SHOP_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'shop-docs-e2e-'));
const PW = 'test-password-123';
const USERS = [{ email: 'tyler@test.local', password: PW }, { email: 'rider@test.local', password: PW }];
let backend, browser;

before(async () => {
  if (skip) return;
  const { startFakeBackend } = require('./support/shop-fake-backend.cjs');
  backend = await startFakeBackend({ users: USERS, staff: [{ email: 'tyler@test.local', name: 'Tyler' }],
    extraSql: ['2026-11-21-shop-010-documents.sql'] });
  await backend.sql(`insert into storage.buckets values ('shop-documents', 'shop-documents', false) on conflict do nothing`);
  browser = await chromium.launch(process.env.SHOP_E2E_CHROME ? { executablePath: process.env.SHOP_E2E_CHROME } : {});
});
after(async () => { await browser?.close(); await backend?.close(); });

async function signedInPage(email, url = '/shop/', viewport = { width: 1100, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(`${backend.origin}/shop/`);
  await page.waitForSelector('#shSignIn:not([hidden])');
  await page.fill('#shSignInEmail', email); await page.fill('#shSignInPassword', PW);
  await page.click('#shSignInForm button[type=submit]');
  if (email === 'tyler@test.local') await page.waitForSelector('#shList:not([hidden])');
  else await page.waitForSelector('#shNoAccess:not([hidden])');
  if (url !== '/shop/') await page.goto(backend.origin + url);
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: true });
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('+ New menu lists every form and each item opens it', { skip }, async () => {
  const page = await signedInPage('tyler@test.local');
  assert.equal(await page.locator('#shNewList').isHidden(), true);
  await page.click('#shNewMenuBtn');
  const items = await page.locator('#shNewList [role=menuitem]').allInnerTexts();
  assert.deepEqual(items, ['Estimate sheet', 'Customer intake form', 'Syndicate meeting form', 'Tech sign-off', 'Finance agreement / payment plan', 'Legal document']);
  await shot(page, 'new-menu.png');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#shNewList').isHidden(), true);
  await page.click('#shNewMenuBtn'); await page.click('#shNewJobBtn');
  await page.waitForSelector('#shEditor:not([hidden])');
  await page.click('#shCancelBtn'); await page.waitForSelector('#shList:not([hidden])');
  await page.click('#shNewMenuBtn'); await page.click('#shNewSignoff');
  assert.match(await page.locator('#shMsg').innerText(), /Pick the job, then press Tech sign-off/);
  assert.equal(await page.locator('#shFilter button.on').innerText(), 'In progress');
  await page.click('#shNewMenuBtn'); await page.click('#shNewList a[href="docs.html?new=intake"]');
  await page.waitForSelector('#dcIntake:not([hidden])');
  // Phone width: menu fits, no sideways scroll.
  const phone = await signedInPage('tyler@test.local', '/shop/', { width: 375, height: 800 });
  await phone.click('#shNewMenuBtn');
  assert.ok(await noSideScroll(phone));
  const box = await phone.locator('#shNewList').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 376, 'menu stays on screen');
  await shot(phone, 'new-menu-phone.png');
  assert.deepEqual([...page.errors, ...phone.errors], []);
});

test('customer intake creates the customer and bike, then shows in the library', { skip }, async () => {
  const page = await signedInPage('tyler@test.local', '/shop/docs.html?new=intake');
  await page.waitForSelector('#dcIntake:not([hidden])');
  await page.fill('#inName', 'TEST Intake Rider'); await page.fill('#inPhone', '520-555-0101');
  await page.fill('#inYear', '2019'); await page.fill('#inMake', 'Harley-Davidson'); await page.fill('#inModel', 'Road Glide');
  await page.fill('#inVin', '1hd1test0000intake'); await page.fill('#inMiles', '12,500');
  await page.fill('#inInsCo', 'Progressive'); await page.selectOption('#inHeard', 'Instagram');
  await page.fill('#inReason', 'Rear brake squeal'); await page.check('#inConsent'); await page.fill('#inSignName', 'TEST Intake Rider');
  await page.click('#inSave');
  await page.waitForFunction(() => /Intake saved/.test(document.getElementById('dcMsg').textContent));
  assert.match(page.url(), /docs\.html\?doc=/);
  const [c] = await backend.sql(`select * from shop_customers where name = 'TEST Intake Rider'`);
  const [b] = await backend.sql(`select * from shop_bikes where customer_id = $1`, [c.id]);
  assert.equal(c.phone, '520-555-0101');
  assert.equal(b.vin, '1HD1TEST0000INTAKE'); assert.equal(b.mileage, 12500); assert.equal(b.year, 2019);
  const [d] = await backend.sql(`select * from shop_documents where doc_type = 'intake'`);
  assert.equal(d.customer_id, c.id); assert.equal(d.bike_id, b.id);
  assert.equal(d.data.insurance_company, 'Progressive'); assert.equal(d.data.consent, true); assert.equal(d.data.heard_about, 'Instagram');
  await shot(page, 'intake.png');
  await page.emulateMedia({ media: 'print' }); await shot(page, 'intake-print.png'); await page.emulateMedia({ media: 'screen' });
  // The customer now shows on the estimate form's customer list too.
  await page.goto(`${backend.origin}/shop/`); await page.waitForSelector('#shList:not([hidden])');
  await page.click('#shNewMenuBtn'); await page.click('#shNewJobBtn');
  assert.ok((await page.locator('#shCustomerPick option').allInnerTexts()).some(t => t.includes('TEST Intake Rider')));
  // Library: filter by type and search.
  await page.goto(`${backend.origin}/shop/docs.html`); await page.waitForSelector('#dcList:not([hidden])');
  await page.fill('#dcSearch', 'road glide');
  assert.equal(await page.locator('.dc-row').count(), 1);
  assert.match(await page.locator('.dc-row').innerText(), /Intake form[\s\S]*TEST Intake Rider/);
  await page.fill('#dcSearch', ''); await page.selectOption('#dcType', 'legal');
  assert.equal(await page.locator('.dc-row').count(), 0);
  assert.deepEqual(page.errors, []);
});

test('legal document from a template with a PDF attached, archived not deleted', { skip }, async () => {
  const page = await signedInPage('tyler@test.local', '/shop/docs.html?new=legal');
  await page.waitForSelector('#dcLegal:not([hidden])');
  await page.selectOption('#lgTemplate', 'storage');
  assert.match(await page.inputValue('#lgBody'), /STORAGE POLICY \(sample wording/);
  assert.equal(await page.inputValue('#lgTitle'), 'Storage policy');
  await page.selectOption('#lgCustomer', { label: 'TEST Intake Rider · 520-555-0101' });
  await page.setInputFiles('#lgFile', { name: 'signed policy (1).pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
  await page.click('#lgSave');
  await page.waitForFunction(() => /Document saved/.test(document.getElementById('dcMsg').textContent));
  const [d] = await backend.sql(`select * from shop_documents where doc_type = 'legal'`);
  assert.match(d.file_path, /^docs\/[A-Za-z0-9_-]+\/\d+-signed-policy-1-.pdf$/);
  assert.equal(d.file_name, 'signed policy (1).pdf'); assert.equal(d.data.category, 'Storage policy');
  assert.ok(backend.files.has(`shop-documents/${d.file_path}`));
  assert.match(await page.locator('#lgFileNow').innerText(), /signed policy \(1\)\.pdf/);
  await shot(page, 'legal.png');
  // Re-save without a new file keeps the attachment.
  await page.fill('#lgBody', 'Edited text'); await page.click('#lgSave');
  await page.waitForFunction(() => /Document saved/.test(document.getElementById('dcMsg').textContent));
  const [d2] = await backend.sql(`select * from shop_documents where id = $1`, [d.id]);
  assert.equal(d2.file_path, d.file_path); assert.equal(d2.data.body, 'Edited text');
  await page.click('#lgArchive');
  await page.waitForFunction(() => /Archived/.test(document.getElementById('dcMsg').textContent));
  assert.equal((await backend.sql(`select archived from shop_documents where id = $1`, [d.id]))[0].archived, true);
  await page.goto(`${backend.origin}/shop/docs.html?type=legal`); await page.waitForSelector('#dcList:not([hidden])');
  assert.equal(await page.locator('.dc-row').count(), 0);
  await page.check('#dcArchived');
  assert.equal(await page.locator('.dc-row').count(), 1);
  assert.deepEqual(page.errors, []);
});

test('Syndicate meeting saves to the library and opens again', { skip }, async () => {
  const page = await signedInPage('tyler@test.local', '/shop/syndicate.html');
  await page.waitForFunction(() => /Filled from the shop/.test(document.getElementById('syAsOf').textContent));
  await page.fill('[name=goals_notes]', 'Sell 3 bikes this month');
  await page.click('#sySave');
  await page.waitForFunction(() => /Saved to the shop document library/.test(document.getElementById('syMsg').textContent));
  const [d] = await backend.sql(`select * from shop_documents where doc_type = 'meeting'`);
  assert.match(d.id, /^meet-\d{4}-\d{2}-\d{2}$/);
  assert.equal(d.data.goals_notes, 'Sell 3 bikes this month');
  assert.ok(d.data.snapshot.tables.syBoard, 'job board copy kept');
  // Open it fresh in another browser (no local notes): fields come from the library.
  const other = await signedInPage('tyler@test.local', `/shop/syndicate.html?doc=${d.id}`);
  await other.waitForFunction(() => /Saved copy from/.test(document.getElementById('syAsOf').textContent));
  assert.equal(await other.inputValue('[name=goals_notes]'), 'Sell 3 bikes this month');
  await other.fill('[name=goals_notes]', 'Sell 4 bikes'); await other.click('#sySave');
  await other.waitForFunction(() => /Saved to the shop document library/.test(document.getElementById('syMsg').textContent));
  assert.equal((await backend.sql(`select data from shop_documents where id = $1`, [d.id]))[0].data.goals_notes, 'Sell 4 bikes');
  assert.equal((await backend.sql(`select count(*)::int n from shop_documents where doc_type = 'meeting'`))[0].n, 1);
  // It is listed in the library and links back to the meeting form.
  await other.goto(`${backend.origin}/shop/docs.html?type=meeting`); await other.waitForSelector('#dcList:not([hidden])');
  assert.equal(await other.locator('.dc-row').getAttribute('href'), `syndicate.html?doc=${d.id}`);
  await shot(other, 'library.png');
  assert.deepEqual([...page.errors, ...other.errors], []);
});

test('a non-staff account sees no documents', { skip }, async () => {
  const page = await signedInPage('rider@test.local', '/shop/docs.html');
  await page.waitForSelector('#dcSignedOut:not([hidden])');
  assert.match(await page.locator('#dcSignedOutText').innerText(), /not on the shop staff list/);
  assert.equal(await page.locator('.dc-row').count(), 0);
});
