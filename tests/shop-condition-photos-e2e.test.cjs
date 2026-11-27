// Locked condition photos (shop-018) in a real browser (Chromium via Playwright)
// against the LOCAL fake backend, which runs the real shop SQL in PGlite.
// Does not touch ride.siccycles.com or the live database. Sample data only.
// Needs @electric-sql/pglite and playwright. Skipped without them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let chromium = null;
try { require.resolve('@electric-sql/pglite'); ({ chromium } = require('playwright')); } catch { /* skipped */ }
const skip = chromium ? false : 'needs @electric-sql/pglite and playwright';
const PW = 'test-password-123';
// A 1x1 PNG, so the test needs no image files.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const files = n => Array.from({ length: n }, (_, i) => ({ name: `side${i + 1}.png`, mimeType: 'image/png', buffer: PNG }));
let backend, browser, towId;

before(async () => {
  if (skip) return;
  const { startFakeBackend } = require('./support/shop-fake-backend.cjs');
  const users = [{ email: 'tyler@test.local', password: PW }, { email: 'garrett@test.local', password: PW }];
  backend = await startFakeBackend({ users, staff: [{ email: 'tyler@test.local', name: 'Tyler' }],
    extraSql: ['2026-11-21-shop-008-tech-signoff.sql', '2026-11-25-shop-014-tow.sql', '2026-11-27-shop-018-condition-photos.sql'] });
  await backend.sql(`insert into public.shop_tow_crew (user_id, display_name) values ($1, 'Garrett')`, [users[1].id]);
  await backend.sql(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: users[0].id, role: 'authenticated' })]);
  await backend.sql(`select public.shop_save_estimate('jobph0001', 'custph001', '{"name":"TEST CUSTOMER"}'::jsonb, null, null, '{}'::jsonb,
    '[{"kind":"labor","description":"Inspect","quantity":"1","unit_price":"150"}]'::jsonb)`);
  await backend.sql(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: users[1].id, role: 'authenticated' })]);
  [{ id: towId }] = await backend.sql(`select (public.shop_tow_add_call('{"source":"phone","customer_name":"Test Rider","phone":"5205550199",
    "vehicle_type":"motorcycle","pickup_address":"Test pickup","zone":"tucson","to_shop":true}'::jsonb))->>'id' as id`);
  await backend.sql(`select set_config('request.jwt.claims', '', false)`);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await backend?.close(); });

async function page(path, email, form) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const p = await ctx.newPage(); p.errors = []; p.dialogs = [];
  p.on('pageerror', e => p.errors.push(e.message));
  p.on('dialog', d => { p.dialogs.push(d.message()); d.dismiss(); });
  await p.goto(`${backend.origin}${path}`);
  await p.waitForSelector(`#${form.view}:not([hidden])`);
  await p.fill(form.email, email); await p.fill(form.pass, PW);
  await p.click(`${form.form} button[type=submit]`);
  return p;
}
const SHOP = { view: 'shSignIn', email: '#shSignInEmail', pass: '#shSignInPassword', form: '#shSignInForm' };
const TOW = { view: 'twSignIn', email: '#twEmail', pass: '#twPassword', form: '#twSignInForm' };

test('intake photos: start job warns until 4 are saved, and saved photos show with a time', { skip }, async () => {
  const p = await page('/shop/', 'tyler@test.local', SHOP);
  await p.waitForSelector('#shList:not([hidden])');
  const card = p.locator('.sh-job', { hasText: 'TEST CUSTOMER' });
  assert.match(await card.innerText(), /0 intake photos/);
  await card.getByRole('button', { name: 'Start job' }).click();          // dismissed: job stays an estimate
  assert.match(p.dialogs.at(-1), /has 0 intake photos.*at least 4/);
  assert.match(await card.innerText(), /Estimate/);

  await card.getByRole('button', { name: 'Intake photos' }).click();
  await p.waitForSelector('#shIntake:not([hidden])');
  await p.setInputFiles('#shInFiles', files(4));
  await p.fill('#shInNote', 'Scratch on left mirror');
  await p.click('#shInSave');
  await p.waitForFunction(() => document.querySelectorAll('#shInGrid img').length === 4);
  assert.match(await p.locator('#shInCount').innerText(), /4 photos saved/);
  await p.waitForFunction(() => [...document.querySelectorAll('#shInGrid img')].every(i => i.complete && i.naturalWidth === 1));
  assert.match(await p.locator('#shInGrid figcaption').first().innerText(), /Scratch on left mirror/);
  const [{ n }] = await backend.sql(`select count(*)::int as n from public.shop_condition_photos where job_id = 'jobph0001'`);
  assert.equal(n, 4);

  await p.click('#shInBack');
  await p.waitForSelector('#shList:not([hidden])');
  assert.match(await card.innerText(), /4 intake photos/);
  const before = p.dialogs.length;
  await card.getByRole('button', { name: 'Start job' }).click();          // only the normal flow now, no photo warning
  await p.waitForFunction(() => /In progress/.test(document.querySelector('.sh-job').innerText));
  assert.equal(p.dialogs.slice(before).some(m => /intake photos/.test(m)), false);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test('before-tow photos: the tow crew saves them on the tow card', { skip }, async () => {
  const p = await page('/shop/tow.html', 'garrett@test.local', TOW);
  await p.waitForSelector('#twMain:not([hidden])');
  const card = p.locator('#twOpenList > *', { hasText: 'Test Rider' });
  assert.match(await card.innerText(), /Before-tow photos\s+0 of 4 needed before the tow starts/);
  await card.getByRole('button', { name: 'Before-tow photos' }).click();
  await card.locator('.tw-photos input[type=file]').setInputFiles(files(4));
  await card.getByRole('button', { name: 'Save photos' }).click();
  await p.waitForFunction(() => /Before-tow photos\s*4 of 4/.test(document.querySelector('#twOpenList').innerText));
  const [{ n }] = await backend.sql(`select count(*)::int as n from public.shop_condition_photos where tow_id = $1`, [towId]);
  assert.equal(n, 4);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});
