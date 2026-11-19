// Shop estimate acceptance test in a real browser (Chromium via Playwright),
// against the LOCAL fake backend (tests/support/shop-fake-backend.cjs), which
// runs the real shop SQL and permission rules in an in-process Postgres.
// This is a local test. It does not touch ride.siccycles.com or the live DB.
// Needs: npm i --no-save @electric-sql/pglite, and Playwright (preinstalled in
// Claude Code cloud sessions). Skipped without them.
// Set SHOP_E2E_OUT=<folder> to keep screenshots and the PDF.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium = null;
try { require.resolve('@electric-sql/pglite'); ({ chromium } = require('playwright')); } catch { /* skipped */ }
const skip = chromium ? false : 'needs @electric-sql/pglite and playwright';
const OUT = process.env.SHOP_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'shop-e2e-'));
const PW = 'test-password-123';
const USERS = [
  { email: 'tyler@test.local', password: PW }, { email: 'garrett@test.local', password: PW },
  { email: 'fang@test.local', password: PW }, { email: 'rider@test.local', password: PW },
];
const TEST_NAME = 'TEST ESTIMATE – Do Not Use';
let backend, browser;

before(async () => {
  if (skip) return;
  const { startFakeBackend } = require('./support/shop-fake-backend.cjs');
  backend = await startFakeBackend({ users: USERS, staff: [
    { email: 'tyler@test.local', name: 'Tyler' }, { email: 'garrett@test.local', name: 'Garrett' }, { email: 'fang@test.local', name: 'Fang' }] });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await backend?.close(); });

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(`${backend.origin}/shop/`);
  return page;
}
async function signIn(page, email) {
  await page.waitForSelector('#shSignIn:not([hidden])');
  await page.fill('#shSignInEmail', email); await page.fill('#shSignInPassword', PW);
  await page.click('#shSignInForm button[type=submit]');
}
const text = (page, sel) => page.locator(sel).innerText();
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, name), fullPage: true, ...opts });
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR42mP8z8Dwn4EIwMQwasCoAaMGjBowasCoAaMGjBpACgAAiuYP8a1h0H0AAAAASUVORK5CYII=', 'base64');

test('signed-out and non-staff users get no shop data', { skip }, async () => {
  const page = await newPage();
  await signIn(page, 'tyler@test.local'); await page.waitForSelector('#shList:not([hidden])'); // seed nothing, just prove staff sign-in works
  await page.click('#shSignOutBtn'); await page.waitForSelector('#shSignIn:not([hidden])');
  await page.fill('#shSignInEmail', 'tyler@test.local'); await page.fill('#shSignInPassword', 'wrong-password');
  await page.click('#shSignInForm button[type=submit]');
  await page.waitForSelector('#shMsg:not([hidden])');
  assert.match(await text(page, '#shMsg'), /Email or password is not right/);
  await signIn(page, 'rider@test.local');
  await page.waitForSelector('#shNoAccess:not([hidden])');
  assert.match(await text(page, '#shNoAccess'), /rider@test\.local/);
  assert.equal(await page.locator('#shNav').isHidden(), true);
  await page.context().close();
});

test('acceptance: create, verify math, save, reload, reopen, edit, status, print, phone', { skip }, async () => {
  const page = await newPage();
  await signIn(page, 'tyler@test.local');
  await page.waitForSelector('#shList:not([hidden])');
  assert.equal(await page.locator('#shTaxWarning').isVisible(), true, 'warns that tax rate is not set');

  // Settings: test tax rate (a test value, not the shop's real rate)
  await page.click('#shSettingsBtn'); await page.waitForSelector('#shSettings:not([hidden])');
  await page.fill('#shSetPhone', '(520) 420-4214'); await page.fill('#shSetTaxRate', '8.7');
  await page.click('#shSetSave'); await page.waitForSelector('#shList:not([hidden])');
  assert.equal(await page.locator('#shTaxWarning').isVisible(), false);

  // New estimate
  await page.click('#shNewJobBtn'); await page.waitForSelector('#shEditor:not([hidden])');
  await page.fill('#shName', TEST_NAME); await page.fill('#shPhone', '520-555-0100'); await page.fill('#shEmail', 'test@example.com');
  await page.fill('#shYear', '2018'); await page.fill('#shMake', 'Harley-Davidson'); await page.fill('#shModel', 'Street Glide');
  await page.fill('#shVin', '1hd1kb4197y000002'); await page.fill('#shMileage', '23,456');
  await page.setInputFiles('#shPhotoFiles', { name: 'bike.png', mimeType: 'image/png', buffer: PNG });
  const jobs = page.locator('#shJobLines .sh-line');
  await jobs.nth(0).locator('.sh-l-desc').fill('Oil filter'); await jobs.nth(0).locator('.sh-l-parts').fill('18.95'); await jobs.nth(0).locator('.sh-l-cost').fill('9.10');
  await page.click('#shAddJob');
  await jobs.nth(1).locator('.sh-l-desc').fill('Oil change'); await jobs.nth(1).locator('.sh-l-parts').fill('50'); await jobs.nth(1).locator('.sh-l-cost').fill('29'); await jobs.nth(1).locator('.sh-l-hours').fill('1.5');
  await page.fill('#shCustomerNotes', 'Customer will pick up Friday.'); await page.fill('#shNotes', 'INTERNAL-SECRET-NOTE');
  assert.equal(await jobs.nth(1).locator('.sh-l-labor').innerText(), '$225.00'); // 1.5 h x $150
  assert.equal(await jobs.nth(1).locator('.sh-l-total').innerText(), '$275.00');
  assert.equal(await text(page, '#shTotParts'), '$68.95');
  assert.equal(await text(page, '#shTotLabor'), '$225.00');
  assert.equal(await text(page, '#shTotTax'), '$6.00');
  assert.equal(await text(page, '#shTotTotal'), '$299.95');
  assert.match(await text(page, '#shTotInternal'), /\$38\.10.*\$30\.85/);
  await shot(page, '1-editor-desktop.png');

  // Double-tap Save: must create exactly one job
  await page.locator('#shSaveBtn').dblclick();
  await page.waitForSelector('#shPrintView:not([hidden])');
  assert.equal((await backend.sql('select count(*)::int as n from public.shop_jobs'))[0].n, 1);
  const [saved] = await backend.sql('select * from public.shop_jobs');
  assert.equal(Number(saved.total_amount), 299.95); assert.equal(Number(saved.estimate_number), 1001); assert.equal(saved.work_description, 'Oil filter, Oil change');

  // Customer copy: right content, no internal numbers
  const doc = await text(page, '#shDoc');
  for (const s of [TEST_NAME, 'IV#1001', '2018 Harley-Davidson Street Glide', 'VIN 1HD1KB4197Y000002', '23,456 mi', 'Oil filter', 'Oil change', 'WORK TO BE DONE',
    '$68.95', '$225.00', '1.5 hr', '$6.00', '$299.95', 'Tax 8.7% on parts', 'Customer will pick up Friday.', '(520) 420-4214']) assert.ok(doc.includes(s), `doc shows ${s}`);
  for (const s of ['9.10', '29.00', '38.10', '30.85', 'INTERNAL-SECRET-NOTE', 'Our cost', 'profit', 'null', 'undefined']) assert.ok(!doc.includes(s), `doc hides ${s}`);
  await shot(page, '2-customer-copy-desktop.png');

  // Print / PDF: app chrome hidden, document visible
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('.sh-header').isVisible(), false);
  assert.equal(await page.locator('.sh-print-tools').isVisible(), false);
  assert.equal(await page.locator('#shDoc').isVisible(), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
  await page.pdf({ path: path.join(OUT, 'estimate-1001.pdf'), format: 'Letter', printBackground: true });
  assert.ok(fs.statSync(path.join(OUT, 'estimate-1001.pdf')).size > 5000);
  await page.emulateMedia({ media: 'screen' });

  // Reload the page: still signed in, job listed
  await page.reload(); await page.waitForSelector('#shList:not([hidden])');
  const card = page.locator('.sh-job').first();
  assert.match(await card.innerText(), /TEST ESTIMATE[\s\S]*\$299\.95[\s\S]*IV#1001[\s\S]*Estimate/);

  // Reopen: every field comes back, including bike fields, photo and lines
  await card.getByRole('button', { name: 'Edit' }).click(); await page.waitForSelector('#shEditor:not([hidden])');
  assert.equal(await page.inputValue('#shName'), TEST_NAME);
  assert.equal(await page.inputValue('#shYear'), '2018'); assert.equal(await page.inputValue('#shMake'), 'Harley-Davidson');
  assert.equal(await page.inputValue('#shModel'), 'Street Glide'); assert.equal(await page.inputValue('#shVin'), '1HD1KB4197Y000002');
  assert.equal(await page.inputValue('#shMileage'), '23456');
  assert.equal(await page.inputValue('#shNotes'), 'INTERNAL-SECRET-NOTE');
  assert.equal(await page.inputValue('#shTaxRate'), '8.7');
  await page.waitForFunction(() => { const i = document.querySelector('#shPhotoPreview img'); return i && i.complete && i.naturalWidth > 0; });
  assert.equal(await page.locator('#shPhotoPreview img').count(), 1);
  assert.equal(await jobs.count(), 2);
  assert.equal(await jobs.nth(1).locator('.sh-l-hours').inputValue(), '1.5');
  assert.equal(await jobs.nth(1).locator('.sh-l-parts').inputValue(), '50.00');
  assert.equal(await jobs.nth(1).locator('.sh-l-cost').inputValue(), '29.00');
  assert.equal(await text(page, '#shTotTotal'), '$299.95');

  // Edit: 2 hours labor, add a part; save; totals recalculated
  await jobs.nth(1).locator('.sh-l-hours').fill('2');
  await page.click('#shAddJob'); await jobs.nth(2).locator('.sh-l-desc').fill('Drain plug washer'); await jobs.nth(2).locator('.sh-l-parts').fill('2.50');
  assert.equal(await text(page, '#shTotTotal'), '$377.67'); // parts 71.45 + labor 300 + tax 6.22
  await page.click('#shSaveBtn'); await page.waitForSelector('#shPrintView:not([hidden])');
  assert.ok((await text(page, '#shDoc')).includes('$377.67'));

  // Reload + reopen again after edit
  await page.reload(); await page.waitForSelector('#shList:not([hidden])');
  await page.locator('.sh-job').first().getByRole('button', { name: 'Edit' }).click(); await page.waitForSelector('#shEditor:not([hidden])');
  assert.equal(await page.inputValue('#shYear'), '2018'); assert.equal(await jobs.count(), 3);
  assert.equal(await jobs.nth(1).locator('.sh-l-hours').inputValue(), '2');
  await page.waitForFunction(() => document.querySelector('#shPhotoPreview img')?.naturalWidth > 0);
  assert.equal(await text(page, '#shTotTotal'), '$377.67');
  await page.click('#shCancelBtn'); await page.waitForSelector('#shList:not([hidden])');

  // Workflow: estimate -> in progress -> complete, amounts unchanged
  await page.locator('.sh-job').first().getByRole('button', { name: 'Start job' }).click();
  await page.waitForFunction(() => /In progress/.test(document.querySelector('.sh-job')?.innerText));
  await page.locator('.sh-job').first().getByRole('button', { name: 'Mark complete' }).click();
  await page.waitForFunction(() => /Complete/.test(document.querySelector('.sh-job')?.innerText));
  const [done] = await backend.sql('select status, total_amount from public.shop_jobs');
  assert.equal(done.status, 'complete'); assert.equal(Number(done.total_amount), 377.67);
  // payment status: new jobs show Unpaid; staff can mark Paid; amounts untouched
  await page.waitForSelector('#shList:not([hidden])');
  assert.match(await page.locator('.sh-job').first().innerText(), /Unpaid/);
  await page.locator('.sh-job').first().getByRole('combobox').selectOption('paid');
  await page.waitForFunction(() => /Paid/.test(document.querySelector('.sh-job .sh-pay-paid')?.textContent || ''));
  const [paid] = await backend.sql('select payment_status, total_amount from public.shop_jobs');
  assert.equal(paid.payment_status, 'paid'); assert.equal(Number(paid.total_amount), 377.67);
  assert.deepEqual(page.errors, []);

  // Garrett (other staff) sees the same job and photo
  const g = await newPage(); await signIn(g, 'garrett@test.local'); await g.waitForSelector('#shList:not([hidden])');
  assert.match(await g.locator('.sh-job').first().innerText(), /TEST ESTIMATE[\s\S]*\$377\.67/);
  await g.context().close();

  // Phone layout (iPhone-sized)
  const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await signIn(phone, 'fang@test.local'); await phone.waitForSelector('#shList:not([hidden])');
  assert.ok(await noSideScroll(phone), 'list fits phone'); await shot(phone, '3-phone-list.png');
  await phone.locator('.sh-job').first().getByRole('button', { name: 'Edit' }).click(); await phone.waitForSelector('#shEditor:not([hidden])');
  await phone.waitForFunction(() => document.querySelector('#shPhotoPreview img')?.naturalWidth > 0);
  assert.ok(await noSideScroll(phone), 'editor fits phone'); await shot(phone, '4-phone-editor.png');
  await phone.click('#shCancelBtn');
  await phone.locator('.sh-job').first().getByRole('button', { name: 'View / Print' }).click(); await phone.waitForSelector('#shPrintView:not([hidden])');
  assert.ok(await noSideScroll(phone), 'customer copy fits phone'); await shot(phone, '5-phone-customer-copy.png');
  assert.deepEqual(phone.errors, []);
  await phone.context().close();
  await page.context().close();
});

test('customer text is shown as text, never run as page code', { skip }, async () => {
  const page = await newPage();
  await signIn(page, 'tyler@test.local'); await page.waitForSelector('#shList:not([hidden])');
  await page.click('#shNewJobBtn'); await page.waitForSelector('#shEditor:not([hidden])');
  const evil = '<img src=x onerror="window.__xss=1">Bob';
  await page.fill('#shName', evil); await page.fill('#shNotes', '<script>window.__xss=2</script>');
  await page.locator('#shJobLines .sh-line').nth(0).locator('.sh-l-desc').fill('<b onmouseover=window.__xss=3>x</b>');
  await page.click('#shSaveBtn'); await page.waitForSelector('#shPrintView:not([hidden])');
  assert.ok((await text(page, '#shDoc')).includes(evil));
  assert.ok((await text(page, '#shDoc')).includes('Authorized by'));
  await page.click('#shPrintBack'); await page.waitForSelector('#shList:not([hidden])');
  assert.ok((await text(page, '#shJobsList')).includes(evil));
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('#shJobsList img, #shDoc img:not(.sh-doc-logo), #shDoc b').count(), 0);
  await page.context().close();
});

test('failed save shows the reason and keeps everything typed; nothing half-saved', { skip }, async () => {
  const page = await newPage();
  await signIn(page, 'tyler@test.local'); await page.waitForSelector('#shList:not([hidden])');
  await page.click('#shNewJobBtn'); await page.waitForSelector('#shEditor:not([hidden])');
  await page.click('#shSaveBtn');
  assert.match(await text(page, '#shFormErrors'), /Customer name is required/);
  await page.fill('#shName', 'Retry Customer');
  await page.locator('#shJobLines .sh-line').nth(0).locator('.sh-l-desc').fill('Chain');
  await page.locator('#shJobLines .sh-line').nth(0).locator('.sh-l-parts').fill('89.99');
  const before = (await backend.sql('select count(*)::int as n from public.shop_jobs'))[0].n;
  await page.route('**/rest/v1/rpc/shop_save_estimate', r => r.abort('internetdisconnected'));
  await page.click('#shSaveBtn');
  await page.waitForSelector('#shFormErrors:not([hidden])');
  assert.match(await text(page, '#shFormErrors'), /Not saved/);
  assert.equal(await page.inputValue('#shName'), 'Retry Customer');
  assert.equal(await page.locator('#shSaveBtn').isEnabled(), true);
  assert.equal((await backend.sql('select count(*)::int as n from public.shop_jobs'))[0].n, before);
  await page.unroute('**/rest/v1/rpc/shop_save_estimate');
  await page.click('#shSaveBtn'); await page.waitForSelector('#shPrintView:not([hidden])');
  assert.equal((await backend.sql('select count(*)::int as n from public.shop_jobs'))[0].n, before + 1);
  await page.context().close();
});

test('saved jobs: names are offered, hours are remembered and refill next time', { skip }, async () => {
  const page = await newPage();
  await signIn(page, 'tyler@test.local'); await page.waitForSelector('#shList:not([hidden])');
  await page.click('#shNewJobBtn'); await page.waitForSelector('#shEditor:not([hidden])');
  const names = await page.$$eval('#shJobNames option', o => o.map(x => x.value));
  for (const n of ['Brake pads', 'Tires', 'Mounting']) assert.ok(names.includes(n), `offers ${n}`);
  let row = page.locator('#shJobLines .sh-line').nth(0);
  await row.locator('.sh-l-desc').fill('Brake pads'); await row.locator('.sh-l-desc').blur();
  assert.equal(await row.locator('.sh-l-hours').inputValue(), '', 'no hours are invented for a name that has none saved');
  await page.fill('#shName', 'Saved Jobs Customer');
  await row.locator('.sh-l-parts').fill('80'); await row.locator('.sh-l-hours').fill('1.5');
  await page.click('#shSaveBtn'); await page.waitForSelector('#shPrintView:not([hidden])');
  const [saved] = await backend.sql(`select name, hours::float as hours, use_count from public.shop_saved_jobs where name_key = 'brake pads'`);
  assert.deepEqual(saved, { name: 'Brake pads', hours: 1.5, use_count: 1 });
  // next estimate: picking the saved job refills the hours, parts stay empty
  await page.click('#shPrintBack'); await page.waitForSelector('#shList:not([hidden])');
  await page.click('#shNewJobBtn'); await page.waitForSelector('#shEditor:not([hidden])');
  row = page.locator('#shJobLines .sh-line').nth(0);
  await row.locator('.sh-l-desc').fill('brake PADS'); await row.locator('.sh-l-desc').blur();
  assert.equal(await row.locator('.sh-l-hours').inputValue(), '1.5');
  assert.equal(await row.locator('.sh-l-parts').inputValue(), '');
  assert.equal(await row.locator('.sh-l-labor').innerText(), '$225.00');
  // a different job is not filled; typing hours first is never overwritten
  await page.click('#shAddJob'); const r2 = page.locator('#shJobLines .sh-line').nth(1);
  await r2.locator('.sh-l-hours').fill('3'); await r2.locator('.sh-l-desc').fill('Brake pads'); await r2.locator('.sh-l-desc').blur();
  assert.equal(await r2.locator('.sh-l-hours').inputValue(), '3');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('direct API calls by a non-staff account are refused', { skip }, async () => {
  const s = backend.sessionFor('rider@test.local');
  const call = (p, opts = {}) => fetch(backend.origin + p, { ...opts, headers: { apikey: 'k', Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' } });
  for (const t of ['shop_jobs', 'shop_customers', 'shop_bikes', 'shop_job_line_items', 'shop_settings', 'shop_saved_jobs']) {
    assert.deepEqual(await (await call(`/rest/v1/${t}?select=*`)).json(), [], t);
  }
  const [job] = await backend.sql('select id, customer_id from public.shop_jobs limit 1');
  const r = await call('/rest/v1/rpc/shop_save_estimate', { method: 'POST', body: JSON.stringify({ p_job_id: job.id, p_customer_id: job.customer_id, p_customer: { name: 'Hijack' }, p_bike_id: null, p_bike: null, p_job: {}, p_items: [] }) });
  assert.equal(r.status, 400); assert.match((await r.json()).message, /not authorized/);
  const rm = await call('/rest/v1/rpc/shop_remember_jobs', { method: 'POST', body: JSON.stringify({ p_jobs: [{ name: 'Hijack', hours: '1' }] }) });
  assert.match((await rm.json()).message, /not authorized/);
  const st = await call('/rest/v1/rpc/shop_set_job_status', { method: 'POST', body: JSON.stringify({ p_job_id: job.id, p_status: 'estimate' }) });
  assert.match((await st.json()).message, /not authorized/);
  const [{ path: photo }] = await backend.sql(`select name as path from storage.objects where bucket_id = 'shop-bike-photos' limit 1`);
  assert.equal((await call(`/storage/v1/object/authenticated/shop-bike-photos/${photo}`)).status, 400);
  const up = await call('/storage/v1/object/shop-bike-photos/evil/x.png', { method: 'POST', body: 'x' });
  assert.equal(up.status, 403);
  assert.notEqual((await backend.sql('select name from public.shop_customers where id = $1', [job.customer_id]))[0].name, 'Hijack');
});
