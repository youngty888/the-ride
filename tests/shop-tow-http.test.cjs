// Moto Tow over HTTP against the LOCAL fake backend (real shop SQL in PGlite):
// the calls the public tow page and the tow board make, with the same
// argument shapes. Does not touch ride.siccycles.com or the live database.
// Needs @electric-sql/pglite. Skipped without it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let hasPg = false;
try { require.resolve('@electric-sql/pglite'); hasPg = true; } catch { /* skipped */ }
const skip = hasPg ? false : 'needs @electric-sql/pglite';
const PW = 'test-password-123';
const SIG = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(40);
let backend;

before(async () => {
  if (skip) return;
  const { startFakeBackend } = require('./support/shop-fake-backend.cjs');
  backend = await startFakeBackend({
    users: [{ email: 'tyler@test.local', password: PW }, { email: 'garrett@test.local', password: PW }, { email: 'chappie@test.local', password: PW }],
    staff: [{ email: 'tyler@test.local', name: 'Tyler' }],
    extraSql: ['2026-11-21-shop-008-tech-signoff.sql', '2026-11-25-shop-014-tow.sql'],
  });
  await backend.sql(`update public.shop_staff set payroll_manager = true`);
  await backend.sql(`insert into public.shop_tow_crew (user_id, display_name) select id, initcap(split_part(email, '@', 1)) from auth.users where email in ('garrett@test.local', 'chappie@test.local')`);
});
after(async () => { await backend?.close(); });

async function call(fn, args, email) {
  const token = email ? backend.sessionFor(email).access_token : 'local-test-anon-key';
  const res = await fetch(`${backend.origin}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: 'local-test-anon-key', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message || res.status);
  return body;
}

test('pages are served', { skip }, async () => {
  for (const p of ['/tow/', '/tow/tow.js', '/tow/tow.css', '/tow/moto-tow-logo.png', '/shop/tow.html', '/shop/tow-app.js', '/shop/tow-calc.js']) {
    assert.equal((await fetch(backend.origin + p)).status, 200, p);
  }
});

test('the whole tow over HTTP: book, price, pay, two-person crew, deliver, pay page', { skip }, async () => {
  const w = await call('shop_tow_waiver_text');
  const booked = await call('shop_tow_request', { p: { customer_name: 'Lee', phone: '(520) 555-0400', vehicle_type: 'golf_cart',
    pickup_address: 'Oracle and Ina', zone: 'tucson', to_shop: false, dropoff_address: 'Home', ride_along: true, agree: true,
    vehicle_runs: false, waiver_name: 'Lee Park', signature: SIG, waiver_version: w.version } });
  assert.equal(Number(booked.price), 125); assert.equal(booked.price_is_start, true); assert.equal(booked.pay_link, null);

  const me = await call('shop_tow_set_duty', { p_on: true, p_phone: '5205550500', p_email: '' }, 'garrett@test.local');
  assert.equal(me.on_duty, true);
  const board = await call('shop_tow_board', { p_days: 30 }, 'garrett@test.local');
  const t = board.find(x => x.ref === booked.ref);
  assert.equal(t.rider_count, 1); assert.equal(t.vehicle_runs, false);

  await call('shop_tow_set_price', { p_id: t.id, p_price: '', p_miles: '19' }, 'garrett@test.local');
  await call('shop_tow_claim', { p_id: t.id, p_role: 'driver' }, 'garrett@test.local');
  await call('shop_tow_claim', { p_id: t.id, p_role: 'navigator' }, 'chappie@test.local');
  await call('shop_tow_mark_paid', { p_id: t.id, p_method: 'Square', p_ref: 'SQ-77' }, 'chappie@test.local');
  await call('shop_tow_start', { p_id: t.id }, 'garrett@test.local');
  const done = await call('shop_tow_deliver', { p_id: t.id }, 'garrett@test.local');
  assert.equal(Number(done.price), 125 + 4 * 3.5);   // 139, 40% = 55.60 split 50/50
  assert.equal(Number(done.driver_pay), 27.8); assert.equal(Number(done.navigator_pay), 27.8);

  // Tyler moves the navigator off after the fact: Garrett gets the solo 30%.
  const fixed = await call('shop_tow_assign', { p_id: t.id, p_driver: done.driver_id, p_navigator: null }, 'tyler@test.local');
  assert.equal(Number(fixed.driver_pay), 41.7); assert.equal(fixed.navigator_pay, null);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
  const all = await call('shop_tow_pay', { p_from: today, p_to: today }, 'tyler@test.local');
  assert.equal(all.people.length, 1); assert.equal(Number(all.crew_pay), 41.7);
  const mine = await call('shop_tow_pay', { p_from: today, p_to: today }, 'chappie@test.local');
  assert.deepEqual(mine.people, []);
  await assert.rejects(call('shop_tow_board', { p_days: 30 }), /permission denied/);   // anonymous: no access at all
});
