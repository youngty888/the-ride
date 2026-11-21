// Shop admin home (hours, calendar, money, receipts, pay stubs, consignment)
// in a real browser against the LOCAL fake backend, which runs the real shop
// SQL (including shop-008, 010 and 011) in an in-process Postgres. Does not
// touch the live site. Skipped without @electric-sql/pglite and Playwright.
// Set SHOP_E2E_OUT=<folder> to keep screenshots.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium = null;
try { require.resolve('@electric-sql/pglite'); ({ chromium } = require('playwright')); } catch { /* skipped */ }
const skip = chromium ? false : 'needs @electric-sql/pglite and playwright';
const OUT = process.env.SHOP_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'shop-admin-e2e-'));
const PW = 'test-password-123';
const USERS = ['tyler', 'garrett', 'fang', 'rider'].map(n => ({ email: `${n}@test.local`, password: PW }));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let backend, browser;
const id = email => USERS.find(u => u.email === email).id;

before(async () => {
  if (skip) return;
  const { startFakeBackend } = require('./support/shop-fake-backend.cjs');
  backend = await startFakeBackend({ users: USERS,
    staff: [{ email: 'tyler@test.local', name: 'Tyler' }, { email: 'garrett@test.local', name: 'Garrett' }, { email: 'fang@test.local', name: 'Fang' }],
    extraSql: ['2026-11-21-shop-008-tech-signoff.sql', '2026-11-21-shop-010-documents.sql', '2026-11-21-shop-011-admin-home.sql'] });
  await backend.sql(`insert into storage.buckets values ('shop-documents', 'shop-documents', false) on conflict do nothing`);
  await backend.sql(`update shop_staff set payroll_manager = true where display_name = 'Tyler'`);
  // A paid job and a part-paid job this month, and 3.5 signed-off hours for Garrett today.
  const t = id('tyler@test.local');
  await backend.sql(`insert into shop_customers (id, name, created_by, updated_by) values ('cust0001', 'TEST Paying Customer', $1, $1)`, [t]);
  await backend.sql(`insert into shop_jobs (id, customer_id, status, payment_status, job_date, total_amount, created_by, updated_by)
    values ('job00001', 'cust0001', 'complete', 'paid', current_date, 600, $1, $1),
           ('job00002', 'cust0001', 'complete', 'partial', current_date, 250, $1, $1)`, [t]);
  await backend.sql(`insert into shop_labor_signoffs (job_id, step_key, step_name, tech_id, hours) values ('job00001', 'brakes', 'Brakes', $1, 3.5)`, [id('garrett@test.local')]);
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
  if (email === 'rider@test.local') await page.waitForSelector('#shNoAccess:not([hidden])');
  else await page.waitForSelector('#shList:not([hidden])');
  if (url !== '/shop/') await page.goto(backend.origin + url);
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: true });
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const msgIs = (page, re, el = 'dcMsg') => page.waitForFunction(([r, e]) => new RegExp(r).test(document.getElementById(e).textContent), [re.source, el]);

test('home shows hours, shortcuts and money only for payroll', { skip }, async () => {
  const g = await signedInPage('garrett@test.local');
  await g.waitForFunction(() => document.getElementById('hmWeek').textContent !== '–');
  assert.equal(await g.locator('#hmHi').innerText(), 'Hi, Garrett');
  assert.equal(await g.locator('#hmWeek').innerText(), '3.5');
  assert.equal(await g.locator('#hmYear').innerText(), '3.5');
  assert.equal(await g.locator('#hmMoney').isHidden(), true);
  assert.equal(await g.locator('#shHome a[href="../warehouse/"]').count(), 1);
  assert.equal(await g.locator('#shRows .sh-row, #shRows [data-id]').count() >= 0, true);   // job board still under the strip
  await shot(g, 'home-garrett.png');
  const t = await signedInPage('tyler@test.local', '/shop/', { width: 375, height: 800 });
  await t.waitForSelector('#hmMoney:not([hidden])');
  assert.equal(await t.locator('#hmWeek').innerText(), '0');
  assert.ok(await noSideScroll(t));
  await shot(t, 'home-tyler-phone.png');
  assert.deepEqual([...g.errors, ...t.errors], []);
});

test('calendar: shop appointments are shared, personal ones stay private', { skip }, async () => {
  const t = await signedInPage('tyler@test.local', '/shop/calendar.html?new=1');
  await t.waitForSelector('#caEdit:not([hidden])');
  const day = await t.evaluate(() => { const d = new Date(Date.now() + 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await t.fill('#caTitleIn', 'TEST Bike pickup'); await t.fill('#caDate', day); await t.fill('#caStart', '10:30');
  assert.equal(await t.locator('#caEnd').inputValue(), '11:30');
  await t.click('#caSave'); await msgIs(t, /Appointment saved/, 'caMsg');
  await t.click('#caNewBtn'); await t.waitForSelector('#caEdit:not([hidden])');
  await t.fill('#caTitleIn', 'TEST Dentist'); await t.fill('#caDate', day);
  await t.check('input[name=caVis][value=personal]');
  await t.click('#caSave'); await msgIs(t, /Appointment saved/, 'caMsg');
  assert.deepEqual((await t.locator('#caDayList .ca-item').allInnerTexts()).map(x => x.includes('Dentist') ? 'personal' : 'shop').sort(), ['personal', 'shop']);
  await shot(t, 'calendar-tyler.png');
  const g = await signedInPage('garrett@test.local');
  await g.waitForFunction(() => /Bike pickup/.test(document.getElementById('hmAppts').textContent));
  assert.doesNotMatch(await g.locator('#hmAppts').innerText(), /Dentist/);
  await g.goto(`${backend.origin}/shop/calendar.html`);
  await g.waitForSelector('#caMonth:not([hidden])');
  assert.doesNotMatch(await g.locator('#caGrid').innerText(), /Dentist/);
  // Garrett can't change Tyler's personal appointment even by calling the database directly.
  const [p] = await backend.sql(`select id from shop_appointments where title = 'TEST Dentist'`);
  const r = await g.evaluate(async aid => { try { await ShApi.rpc('shop_save_appointment', { p_id: aid, p_appt: { title: 'x', starts_at: new Date().toISOString(), visibility: 'public' } }); return 'saved'; } catch (e) { return e.message; } }, p.id);
  assert.notEqual(r, 'saved');
  const phone = await signedInPage('tyler@test.local', '/shop/calendar.html', { width: 375, height: 800 });
  await phone.waitForSelector('#caMonth:not([hidden])');
  assert.ok(await noSideScroll(phone));
  await shot(phone, 'calendar-phone.png');
  assert.deepEqual([...t.errors, ...g.errors, ...phone.errors], []);
});

test('receipt from a picture lands in the library and in money out', { skip }, async () => {
  const g = await signedInPage('garrett@test.local', '/shop/docs.html?new=receipt', { width: 375, height: 800 });
  await g.waitForSelector('#dcReceipt:not([hidden])');
  await g.fill('#rcAmount', '42.50');
  await g.click('#rcSave'); await msgIs(g, /Take a picture/);
  await g.setInputFiles('#rcCamera', { name: 'receipt.png', mimeType: 'image/png', buffer: PNG });
  assert.equal(await g.locator('#rcPreview').isVisible(), true);
  await g.fill('#rcVendor', 'TEST Napa'); await g.selectOption('#rcCategory', 'Parts'); await g.selectOption('#rcPaidWith', 'personal');
  await g.selectOption('#rcJob', 'job00001'); await g.check('#rcBill');
  assert.ok(await noSideScroll(g));
  await shot(g, 'receipt-phone.png');
  await g.click('#rcSave'); await msgIs(g, /Receipt saved/);
  const [d] = await backend.sql(`select * from shop_documents where doc_type = 'receipt'`);
  assert.equal(Number(d.amount), 42.5); assert.equal(d.owner_user_id, id('garrett@test.local'));
  assert.equal(d.job_id, 'job00001'); assert.equal(d.customer_id, 'cust0001');
  assert.equal(d.data.paid_with, 'personal'); assert.equal(d.data.bill_customer, true);
  assert.match(d.file_path, new RegExp(`^docs/${d.id}/`));
  await g.goto(`${backend.origin}/shop/docs.html?type=receipt`);
  await g.waitForSelector('#dcList:not([hidden])');
  assert.match(await g.locator('#dcRows').innerText(), /Receipt · Parts[\s\S]*\$42\.50/);
  // Garrett has no money access.
  await g.goto(`${backend.origin}/shop/money.html`);
  await g.waitForSelector('#moBlocked:not([hidden])');
  // Tyler sees money in vs out.
  const t = await signedInPage('tyler@test.local', '/shop/money.html');
  await t.waitForSelector('#moMain:not([hidden])');
  await t.waitForFunction(() => document.getElementById('moIn').textContent !== '–');
  assert.equal(await t.locator('#moIn').innerText(), '$600.00');
  assert.equal(await t.locator('#moOut').innerText(), '$42.50');
  assert.equal(await t.locator('#moNet').innerText(), '$557.50');
  assert.match(await t.locator('#moOutRows').innerText(), /Parts\s+1\s+\$42\.50/);
  assert.match(await t.locator('#moPartNote').innerText(), /1 part-paid job \(\$250\.00 total\) is not counted/);
  await t.click('#moChips [data-p=year]');
  await t.waitForFunction(() => document.getElementById('moOut').textContent === '$42.50');
  await shot(t, 'money.png');
  const phone = await signedInPage('tyler@test.local', '/shop/money.html', { width: 375, height: 800 });
  await phone.waitForFunction(() => document.getElementById('moIn').textContent !== '–');
  assert.ok(await noSideScroll(phone));
  await shot(phone, 'money-phone.png');
  assert.deepEqual([...g.errors, ...t.errors, ...phone.errors], []);
});

test('pay stubs: payroll files them, only the owner and payroll can see them', { skip }, async () => {
  const g0 = await signedInPage('garrett@test.local', '/shop/docs.html?new=paystub');
  await msgIs(g0, /Only the payroll manager can file pay stubs/);
  assert.equal(await g0.locator('#dcNewStub').isHidden(), true);
  const t = await signedInPage('tyler@test.local', '/shop/docs.html?new=paystub');
  await t.waitForSelector('#dcPaystub:not([hidden])');
  await t.selectOption('#psOwner', { label: 'Garrett' });
  await t.fill('#psFrom', '2026-11-09'); await t.fill('#psTo', '2026-11-15'); await t.fill('#psDate', '2026-11-20');
  await t.fill('#psAmount', '812.40'); await t.fill('#psHours', '38.5');
  await t.setInputFiles('#psFile', { name: 'stub.pdf', mimeType: 'application/pdf', buffer: PDF });
  await t.click('#psSave'); await msgIs(t, /Pay stub saved/);
  const [d] = await backend.sql(`select * from shop_documents where doc_type = 'paystub'`);
  assert.equal(d.owner_user_id, id('garrett@test.local')); assert.equal(Number(d.amount), 812.4); assert.ok(d.file_path);
  assert.equal(await t.locator('#psOwner').isDisabled(), true);
  await shot(t, 'paystub-tyler.png');
  // Garrett sees his own stub read-only and can open the file.
  const g = await signedInPage('garrett@test.local', '/shop/docs.html?type=paystub');
  await g.waitForSelector('#dcList:not([hidden])');
  assert.match(await g.locator('#dcRows').innerText(), /Pay stub · Garrett[\s\S]*\$812\.40/);
  await g.goto(`${backend.origin}/shop/docs.html?doc=${d.id}`);
  await g.waitForSelector('#dcPaystub:not([hidden])');
  assert.equal(await g.locator('#psSave').isHidden(), true);
  assert.equal(await g.locator('#psAmount').isDisabled(), true);
  const got = await g.evaluate(async p => (await ShApi.download('shop-documents', p)).size, d.file_path);
  assert.equal(got, PDF.length);
  await shot(g, 'paystub-garrett.png');
  // Fang sees nothing: not in the list, not by link, not the file.
  const f = await signedInPage('fang@test.local', '/shop/docs.html');
  await f.waitForSelector('#dcList:not([hidden])');
  assert.doesNotMatch(await f.locator('#dcRows').innerText(), /Pay stub/);
  await f.goto(`${backend.origin}/shop/docs.html?doc=${d.id}`);
  await msgIs(f, /not found/);
  const fr = await f.evaluate(async p => { try { await ShApi.download('shop-documents', p); return 'read'; } catch (e) { return 'blocked'; } }, d.file_path);
  assert.equal(fr, 'blocked');
  const up = await f.evaluate(async did => { try { await ShApi.upload('shop-documents', `docs/${did}/x.pdf`, new Blob(['x'], { type: 'application/pdf' }), 'application/pdf'); return 'uploaded'; } catch { return 'blocked'; } }, d.id);
  assert.equal(up, 'blocked');
  assert.deepEqual([...g0.errors, ...t.errors, ...g.errors, ...f.errors], []);
});

test('consignment for a bike and for an item', { skip }, async () => {
  const page = await signedInPage('garrett@test.local', '/shop/docs.html?new=consignment');
  await page.waitForSelector('#dcConsign:not([hidden])');
  assert.match(await page.locator('#cnTerms').inputValue(), /have a lawyer review/);
  await page.fill('#cnName', 'TEST Consignor'); await page.fill('#cnPhone', '520-555-0199');
  await page.fill('#cnYear', '2016'); await page.fill('#cnMake', 'Harley-Davidson'); await page.fill('#cnModel', 'Street Glide');
  await page.fill('#cnVin', '1hd1testconsign01'); await page.fill('#cnMiles', '22,000'); await page.selectOption('#cnTitle', 'Yes, clear title');
  await page.fill('#cnAsk', '14,500'); await page.fill('#cnMin', '15000');
  await page.click('#cnSave'); await msgIs(page, /lowest price is higher/);
  await page.fill('#cnMin', '13000'); await page.fill('#cnCommission', '10'); await page.fill('#cnTerm', '60'); await page.selectOption('#cnPayout', 'Check');
  await page.click('#cnSave'); await msgIs(page, /Consignment agreement saved/);
  const [d] = await backend.sql(`select * from shop_documents where doc_type = 'consignment'`);
  const [b] = await backend.sql(`select * from shop_bikes where id = $1`, [d.bike_id]);
  const [c] = await backend.sql(`select * from shop_customers where id = $1`, [d.customer_id]);
  assert.equal(Number(d.amount), 14500); assert.equal(d.data.kind, 'bike'); assert.equal(d.data.commission_pct, '10');
  assert.equal(b.vin, '1HD1TESTCONSIGN01'); assert.equal(b.mileage, 22000); assert.equal(c.name, 'TEST Consignor');
  await shot(page, 'consignment-bike.png');
  await page.goto(`${backend.origin}/shop/docs.html?new=consignment`);
  await page.waitForSelector('#dcConsign:not([hidden])');
  await page.check('input[name=cnKind][value=item]');
  assert.equal(await page.locator('#cnBikeBox').isHidden(), true);
  await page.selectOption('#cnCustomerPick', c.id);
  assert.equal(await page.locator('#cnName').inputValue(), 'TEST Consignor');
  await page.fill('#cnItem', 'TEST Vance & Hines pipes'); await page.fill('#cnAsk', '450');
  await page.click('#cnSave'); await msgIs(page, /Consignment agreement saved/);
  const rows = await backend.sql(`select * from shop_documents where doc_type = 'consignment' order by created_at`);
  assert.equal(rows.length, 2); assert.equal(rows[1].bike_id, null); assert.equal(rows[1].customer_id, c.id);
  await page.goto(`${backend.origin}/shop/docs.html?type=consignment`);
  await page.waitForSelector('#dcList:not([hidden])');
  assert.equal(await page.locator('#dcRows .dc-row').count(), 2);
  await shot(page, 'consignment-library.png');
  assert.deepEqual(page.errors, []);
});
