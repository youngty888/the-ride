// Signed-in riders on the tow page (sql/shop/2026-11-26-shop-015-tow-riders.sql):
// a rider gets only their own name, email, last phone and Garage bikes back,
// their tow is saved with their account, and they still cannot see the board.
// Needs PGlite: `npm i --no-save @electric-sql/pglite`. Skipped without it.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let hasPg = false;
try { require.resolve('@electric-sql/pglite'); hasPg = true; } catch { /* skipped below */ }
const skip = hasPg ? false : 'PGlite not installed (npm i --no-save @electric-sql/pglite)';

const sql = f => fs.readFileSync(path.join(__dirname, '..', 'sql', 'shop', f), 'utf8');
const U = {
  tyler: '00000000-0000-4000-9000-000000000001',
  garrett: '00000000-0000-4000-9000-000000000002',
  rider: '00000000-0000-4000-9000-000000000005',
  other: '00000000-0000-4000-9000-000000000006',
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
create table public.rider_app_state (owner_id uuid primary key, payload jsonb, revision integer default 0);
alter table public.rider_app_state enable row level security;
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
const request = (over = {}) => ({
  customer_name: 'Pat Rider', phone: '520-555-0101', vehicle_type: 'motorcycle', vehicle: '2019 Harley-Davidson Road Glide (Black)',
  pickup_address: 'Speedway and Campbell', zone: 'tucson', to_shop: true, agree: true,
  waiver_name: 'Pat Rider', signature: SIG, waiver_version: '2026-11-25', ...over,
});

before(async () => {
  if (skip) return;
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  await db.query('insert into public.rider_app_state (owner_id, payload) values ($1, $2)', [U.rider, JSON.stringify({
    profile: { name: 'Pat Rider' },
    bikes: [{ id: 'b1', year: 2019, make: 'Harley-Davidson', model: 'Road Glide', color: 'Black', nickname: 'Big Red', photo: 'data:image/png;base64,AAAA' },
      { id: 'b2', make: 'Honda', model: 'Grom' }],
  })]);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
    '2026-10-30-shop-004-estimates.sql', '2026-11-21-shop-008-tech-signoff.sql', '2026-11-25-shop-014-tow.sql',
    '2026-11-26-shop-015-tow-riders.sql', '2026-11-26-shop-015-tow-riders.sql']) await db.exec(sql(f));  // re-running is safe
  await db.query(`insert into public.shop_staff (user_id, display_name, payroll_manager) values ($1, 'Tyler', true)`, [U.tyler]);
  await db.query(`insert into public.shop_tow_crew (user_id, display_name) values ($1, 'Garrett')`, [U.garrett]);
});

test('a signed-in rider gets their own details and Garage bikes, no photos', { skip }, async () => {
  const me = await rpc('rider', 'shop_tow_my_info');
  assert.equal(me.name, 'Pat Rider'); assert.equal(me.email, 'rider@test.local'); assert.equal(me.phone, null);
  assert.deepEqual(me.bikes.map(b => b.id), ['b1', 'b2']);
  assert.equal(me.bikes[0].nickname, 'Big Red'); assert.equal(me.bikes[0].year, 2019);
  assert.ok(!('photo' in me.bikes[0]));
  const other = await rpc('other', 'shop_tow_my_info');
  assert.deepEqual(other.bikes, []); assert.equal(other.name, null);
  await assert.rejects(rpc(null, 'shop_tow_my_info'), /permission denied/);
});

test('a rider tow is saved with their account and bike; a guest tow is not', { skip }, async () => {
  await rpc('rider', 'shop_tow_request', { p: request({ bike_id: 'b1' }) });
  await rpc(null, 'shop_tow_request', { p: request({ customer_name: 'Lee', phone: '520-555-0400', bike_id: 'b9' }) });
  const rows = (await db.query('select customer_name, rider_id, bike_id from public.shop_tow_requests order by created_at')).rows;
  assert.deepEqual(rows, [{ customer_name: 'Pat Rider', rider_id: U.rider, bike_id: 'b1' }, { customer_name: 'Lee', rider_id: null, bike_id: null }]);
  assert.equal((await rpc('rider', 'shop_tow_my_info')).phone, '(520) 555-0101');   // next tow fills in the phone
  assert.equal((await rpc('other', 'shop_tow_my_info')).phone, null);              // and nobody else's
});

test('only the tow admin and crew see the board; riders and guests never do', { skip }, async () => {
  await assert.rejects(rpc('rider', 'shop_tow_board', { p_days: 30 }), /not authorized/);
  await assert.rejects(rpc(null, 'shop_tow_board', { p_days: 30 }), /permission denied/);
  await assert.rejects(as('rider', 'select * from public.shop_tow_requests'), /permission denied/);
  await assert.rejects(as(null, 'select * from public.shop_tow_requests'), /permission denied/);
  assert.equal((await rpc('tyler', 'shop_tow_board', { p_days: 30 })).length, 2);
  const crew = await rpc('garrett', 'shop_tow_board', { p_days: 30 });
  assert.equal(crew.filter(t => t.rider_id === U.rider).length, 1);
});
