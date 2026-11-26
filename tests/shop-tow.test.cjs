// Moto Tow board (sql/shop/2026-11-25-shop-014-tow.sql) against a real in-process
// Postgres (PGlite) with Supabase-style roles. Also checks that the price and
// crew-pay math in shop/tow-calc.js matches the database.
// Needs PGlite: `npm i --no-save @electric-sql/pglite`. Skipped without it.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TowCalc = require('../shop/tow-calc.js');

let hasPg = false;
try { require.resolve('@electric-sql/pglite'); hasPg = true; } catch { /* skipped below */ }
const skip = hasPg ? false : 'PGlite not installed (npm i --no-save @electric-sql/pglite)';

const sql = f => fs.readFileSync(path.join(__dirname, '..', 'sql', 'shop', f), 'utf8');
const U = {
  tyler: '00000000-0000-4000-9000-000000000001',   // payroll manager (tow admin)
  garrett: '00000000-0000-4000-9000-000000000002', // tow crew
  chappie: '00000000-0000-4000-9000-000000000003', // tow crew
  fang: '00000000-0000-4000-9000-000000000004',    // shop staff, not tow crew
  rider: '00000000-0000-4000-9000-000000000005',   // nobody
};
const SIG = 'data:image/png;base64,' + 'A'.repeat(400);
let db;

const STUB = `
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text unique);
create function auth.uid() returns uuid language sql stable as $$
  select nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant select, insert, update on storage.objects to anon, authenticated;
`;

async function as(user, text, params) {
  await db.exec('reset role');
  if (user) {
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U[user], role: 'authenticated' })]);
    await db.exec('set role authenticated');
  } else {
    await db.query(`select set_config('request.jwt.claims', '', false)`);
    await db.exec('set role anon');
  }
  try { return (await db.query(text, params)).rows; } finally { await db.exec('reset role'); }
}
const rpc = async (user, fn, args = {}) => {
  const keys = Object.keys(args);
  const call = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  return (await as(user, call, keys.map(k => args[k])))[0].r;
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });

const webRequest = (over = {}) => ({
  customer_name: 'Pat Rider', phone: '520-555-0101', vehicle_type: 'motorcycle', vehicle: '2019 Road Glide',
  pickup_address: 'Speedway and Campbell', zone: 'tucson', to_shop: true, agree: true,
  waiver_name: 'Pat Rider', signature: SIG, waiver_version: '2026-11-25', ...over,
});

before(async () => {
  if (skip) return;
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
    '2026-10-30-shop-004-estimates.sql', '2026-11-21-shop-008-tech-signoff.sql',
    '2026-11-25-shop-014-tow.sql', '2026-11-25-shop-014-tow.sql']) await db.exec(sql(f));  // re-running is safe
  await db.query(`insert into public.shop_staff (user_id, display_name, payroll_manager) values ($1, 'Tyler', true), ($2, 'Fang', false)`, [U.tyler, U.fang]);
  await db.query(`insert into public.shop_tow_crew (user_id, display_name) values ($1, 'Garrett'), ($2, 'Chappie')`, [U.garrett, U.chappie]);
});

test('tow-calc.js prices match the database for every zone', { skip }, async () => {
  for (const zone of ['tucson', 'sierra_vista', 'phoenix', 'other']) {
    for (const toShop of [false, true]) {
      for (const miles of [0, 10, 15, 15.2, 22, 40]) {
        const [{ q }] = await as(null, 'select public.shop_tow_quote($1, $2, $3) as q', [zone, toShop, miles]);
        const js = TowCalc.quote(zone, { toShop, miles });
        assert.equal(q === null ? null : Number(q), js, `${zone} toShop=${toShop} miles=${miles}`);
      }
    }
  }
  assert.equal(TowCalc.quote('tucson', { miles: 22 }), 125 + 7 * 3.5);
  assert.equal(TowCalc.quote('phoenix', { toShop: true }), 375);
});

test('tow-calc.js crew pay matches the database, even and uneven splits', { skip }, async () => {
  for (const price of [100, 125, 295, 425, 137.5]) {
    for (const nav of [false, true]) {
      for (const driverPct of [50, 60, 65]) {
        const [r] = await as('tyler', 'select * from public.shop_tow_crew_pay($1, $2, 30, 40, $3)', [price, nav, driverPct]).catch(() => [null]);
        // The function is server-only; check it as the database owner instead.
        const [own] = (await db.query('select * from public.shop_tow_crew_pay($1, $2, 30, 40, $3)', [price, nav, driverPct])).rows;
        assert.equal(r, null);
        const js = TowCalc.crewPay(price, { navigator: nav, solo_pct: 30, pair_pct: 40, driver_pct: driverPct });
        assert.equal(Number(own.driver), js.driver); assert.equal(Number(own.navigator), js.navigator);
        if (nav) assert.equal(Math.round((js.driver + js.navigator) * 100), Math.round(js.pool * 100));
      }
    }
  }
  assert.deepEqual(TowCalc.crewPay(425, { navigator: true }), { pool: 170, driver: 85, navigator: 85 });
  assert.deepEqual(TowCalc.crewPay(425, { navigator: true, driver_pct: 60 }), { pool: 170, driver: 102, navigator: 68 });
});

test('nobody outside the crew can read tows or the tables', { skip }, async () => {
  for (const who of ['rider', 'fang', null]) {
    await assert.rejects(as(who, 'select * from public.shop_tow_requests'), /permission denied/);
    if (who) await assert.rejects(rpc(who, 'shop_tow_board', { p_days: 7 }), /not authorized/);
  }
  assert.equal(await rpc('fang', 'shop_tow_me'), null);
  await assert.rejects(rpc(null, 'shop_tow_alert_targets'), /permission denied/);
  await assert.rejects(rpc('tyler', 'shop_tow_inbound', { p: { phone: '5205550199', message: 'hi' } }), /permission denied/);
});

test('a customer asks on the public page: price set by the server, waiver stored', { skip }, async () => {
  const r = await rpc(null, 'shop_tow_request', { p: webRequest({ price: 1 }) });
  assert.match(r.ref, /^TOW-[0-9A-F]{6}$/);
  assert.equal(Number(r.price), 100);   // to SIC Cycles, Tucson
  const board = await rpc('garrett', 'shop_tow_board', { p_days: 7 });
  const t = board.find(x => x.ref === r.ref);
  assert.equal(t.status, 'new'); assert.equal(t.waiver_signed, true); assert.equal(t.phone, '(520) 555-0101');
  assert.equal(t.waiver_signature, undefined, 'signature image stays off the board list');
  const w = await rpc('chappie', 'shop_tow_waiver', { p_id: t.id });
  assert.equal(w.name, 'Pat Rider'); assert.equal(w.signature, SIG); assert.match(w.body, /No pickup until paid/);
});

test('the public page refuses cars, missing waiver, bad signature and floods', { skip }, async () => {
  await assert.rejects(rpc(null, 'shop_tow_request', { p: webRequest({ vehicle_type: 'car' }) }), /motorcycles, ATVs/);
  await assert.rejects(rpc(null, 'shop_tow_request', { p: webRequest({ agree: false }) }), /agree to the waiver/);
  await assert.rejects(rpc(null, 'shop_tow_request', { p: webRequest({ signature: 'data:image/png;base64,AA' }) }), /Sign in the box/);
  await assert.rejects(rpc(null, 'shop_tow_request', { p: webRequest({ phone: '555' }) }), /10-digit/);
  await assert.rejects(rpc(null, 'shop_tow_request', { p: webRequest({ to_shop: false }) }), /where it goes/);
  const p = webRequest({ phone: '520-555-0177' });
  for (let i = 0; i < 3; i++) await rpc(null, 'shop_tow_request', { p });
  await assert.rejects(rpc(null, 'shop_tow_request', { p }), /already have your request/);
});

test('pay first: no start until paid and signed; crew pay frozen at delivery', { skip }, async () => {
  const call = await rpc('garrett', 'shop_tow_add_call', { p: { source: 'phone', customer_name: 'Sam', phone: '5205550123',
    vehicle_type: 'side_by_side', pickup_address: 'Mt Lemmon Hwy', zone: 'tucson', miles: '25', dropoff_address: 'Home' } });
  assert.equal(Number(call.price), 125 + 10 * 3.5);
  assert.equal(call.waiver_signed, false);
  await rpc('garrett', 'shop_tow_claim', { p_id: call.id, p_role: 'driver' });
  await assert.rejects(rpc('chappie', 'shop_tow_claim', { p_id: call.id, p_role: 'driver' }), /Garrett is already driving/);
  await rpc('chappie', 'shop_tow_claim', { p_id: call.id, p_role: 'navigator' });
  await assert.rejects(rpc('tyler', 'shop_tow_claim', { p_id: call.id, p_role: 'navigator' }), /Only tow crew/);
  await assert.rejects(rpc('garrett', 'shop_tow_start', { p_id: call.id }), /No pickup until it is paid/);
  await assert.rejects(rpc('garrett', 'shop_tow_mark_paid', { p_id: call.id, p_method: 'Square', p_ref: '' }), /payment or receipt number/);
  await rpc('garrett', 'shop_tow_mark_paid', { p_id: call.id, p_method: 'Square', p_ref: 'SQ-1' });
  await assert.rejects(rpc('garrett', 'shop_tow_set_price', { p_id: call.id, p_price: '50', p_miles: null }), /Ask Tyler/);
  await assert.rejects(rpc('garrett', 'shop_tow_start', { p_id: call.id }), /waiver is not signed/);
  const token = await rpc('garrett', 'shop_tow_sign_link', { p_id: call.id });
  assert.equal((await rpc(null, 'shop_tow_sign_info', { p_token: token })).signed, false);
  await assert.rejects(rpc(null, 'shop_tow_sign', { p_token: 'x'.repeat(32), p_name: 'Sam', p_signature: SIG, p_version: '2026-11-25' }), /not valid/);
  await rpc(null, 'shop_tow_sign', { p_token: token, p_name: 'Sam Smith', p_signature: SIG, p_version: '2026-11-25' });
  await assert.rejects(rpc(null, 'shop_tow_sign', { p_token: token, p_name: 'Sam Smith', p_signature: SIG, p_version: '2026-11-25' }), /already signed/);
  await rpc('chappie', 'shop_tow_start', { p_id: call.id });
  const done = await rpc('garrett', 'shop_tow_deliver', { p_id: call.id });
  // 160 x 40% = 64, split 50/50
  assert.equal(Number(done.driver_pay), 32); assert.equal(Number(done.navigator_pay), 32);
  // Changing the split later does not change this tow.
  await rpc('tyler', 'shop_tow_save_settings', { p: { solo_pct: '30', pair_pct: '40', driver_pct: '60' } });
  const after = (await rpc('tyler', 'shop_tow_board', { p_days: 7 })).find(x => x.id === call.id);
  assert.equal(Number(after.driver_pay), 32);
});

test('a solo tow pays the driver the solo share; pay page shows own pay, Tyler sees all', { skip }, async () => {
  const r = await rpc(null, 'shop_tow_request', { p: webRequest({ phone: '520-555-0200', zone: 'phoenix', to_shop: true }) });
  const id = (await rpc('chappie', 'shop_tow_board', { p_days: 7 })).find(x => x.ref === r.ref).id;
  await rpc('chappie', 'shop_tow_claim', { p_id: id, p_role: 'driver' });
  await rpc('tyler', 'shop_tow_mark_paid', { p_id: id, p_method: 'Stripe', p_ref: 'pi_1' });
  await rpc('chappie', 'shop_tow_start', { p_id: id });
  const done = await rpc('chappie', 'shop_tow_deliver', { p_id: id });
  assert.equal(Number(done.driver_pay), 112.5); assert.equal(done.navigator_pay, null);   // 375 x 30%
  const mine = await rpc('chappie', 'shop_tow_pay', { p_from: today(), p_to: today() });
  assert.equal(mine.people.length, 1); assert.equal(mine.people[0].name, 'Chappie');
  assert.equal(Number(mine.people[0].pay), 112.5 + 32); assert.equal(mine.people[0].drove, 1); assert.equal(mine.people[0].rode, 1);
  assert.equal(mine.revenue, null);
  const all = await rpc('tyler', 'shop_tow_pay', { p_from: today(), p_to: today() });
  assert.deepEqual(all.people.map(p => p.name), ['Chappie', 'Garrett']);
  assert.equal(Number(all.revenue), 160 + 375); assert.equal(Number(all.crew_pay), 64 + 112.5);
});

test('duty, settings and assign are limited to the right people', { skip }, async () => {
  await assert.rejects(rpc('garrett', 'shop_tow_set_duty', { p_on: true, p_phone: '', p_email: '' }), /phone or email/);
  const me = await rpc('garrett', 'shop_tow_set_duty', { p_on: true, p_phone: '520 555 0111', p_email: '' });
  assert.equal(me.on_duty, true); assert.deepEqual(me.on_duty_names, ['Garrett']);
  const [{ t }] = (await db.query('select public.shop_tow_alert_targets() as t')).rows;
  assert.deepEqual(t, [{ name: 'Garrett', phone: '(520) 555-0111', email: null }]);
  await assert.rejects(rpc('garrett', 'shop_tow_save_settings', { p: { driver_pct: '90' } }), /Only Tyler/);
  await assert.rejects(rpc('tyler', 'shop_tow_save_settings', { p: { pay_link_tucson: 'javascript:alert(1)' } }), /https/);
  await assert.rejects(rpc('garrett', 'shop_tow_assign', { p_id: 'x', p_driver: U.garrett, p_navigator: null }), /Tow not found|Only Tyler/);
  await assert.rejects(rpc('tyler', 'shop_tow_assign', { p_id: (await rpc('tyler', 'shop_tow_board', { p_days: 7 }))[0].id,
    p_driver: U.fang, p_navigator: null }), /not on the tow crew/);
});

test('an inbound text opens one tow per number and adds later texts to it', { skip }, async () => {
  const [{ a }] = (await db.query(`select public.shop_tow_inbound('{"source":"text","phone":"+15205550333","message":"bike died on I-10"}') as a`)).rows;
  const [{ b }] = (await db.query(`select public.shop_tow_inbound('{"source":"text","phone":"+15205550333","message":"near Ina exit"}') as b`)).rows;
  assert.equal(a.new, true); assert.equal(b.new, false); assert.equal(a.ref, b.ref);
  const t = (await rpc('garrett', 'shop_tow_board', { p_days: 7 })).find(x => x.ref === a.ref);
  assert.equal(t.notes, 'bike died on I-10\nnear Ina exit'); assert.equal(t.source, 'text');
});
