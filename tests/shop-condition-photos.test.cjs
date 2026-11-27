// Locked condition photos (shop-018): intake photos on a job, before-tow photos
// on a tow, server time stamps, no edit or delete, and no tow start without 4.
// Runs the real SQL in PGlite with Supabase-style roles. Sample data only.
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
const B = 'shop-condition-photos';
const upload = (user, name) => as(user, 'insert into storage.objects (bucket_id, name) values ($1, $2)', [B, name]);
const add = (user, id, kind, target, p, note) => rpc(user, 'shop_add_condition_photo', { p_id: id, p_kind: kind, p_target_id: target, p_path: p, p_note: note ?? null });
let towId;

before(async () => {
  if (skip) return;
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
    '2026-10-30-shop-004-estimates.sql', '2026-11-21-shop-008-tech-signoff.sql', '2026-11-25-shop-014-tow.sql',
    '2026-11-27-shop-018-condition-photos.sql', '2026-11-27-shop-018-condition-photos.sql']) await db.exec(sql(f)); // safe to re-run
  await db.query(`insert into public.shop_staff (user_id, display_name, payroll_manager) values ($1, 'Tyler', true), ($2, 'Fang', false)`, [U.tyler, U.fang]);
  await db.query(`insert into public.shop_tow_crew (user_id, display_name) values ($1, 'Garrett'), ($2, 'Chappie')`, [U.garrett, U.chappie]);
  await rpc('fang', 'shop_save_estimate', { p_job_id: 'job0001', p_customer_id: 'cust0001', p_customer: { name: 'Test Customer' },
    p_bike_id: null, p_bike: null, p_job: {}, p_items: [{ kind: 'labor', description: 'Inspect', quantity: '1', unit_price: '150' }] });
  const call = await rpc('garrett', 'shop_tow_add_call', { p: { source: 'phone', customer_name: 'Sam', phone: '5205550123',
    vehicle_type: 'motorcycle', pickup_address: 'Test pickup', zone: 'tucson', to_shop: true } });
  towId = call.id;
});

test('staff save intake photos on a job with the server time and who took them', { skip }, async () => {
  await upload('fang', 'job/job0001/front.jpg');
  const r = await add('fang', 'ph01', 'intake', 'job0001', 'job/job0001/front.jpg', 'Scratch on tank');
  assert.equal(r.count, 1);
  assert.equal((await add('fang', 'ph01', 'intake', 'job0001', 'job/job0001/front.jpg')).count, 1);  // retry saves once
  const [row] = await as('tyler', `select kind, job_id, note, taken_by::text, taken_at > now() - interval '1 minute' as fresh from public.shop_condition_photos where id = 'ph01'`);
  assert.deepEqual(row, { kind: 'intake', job_id: 'job0001', note: 'Scratch on tank', taken_by: U.fang, fresh: true });
  const [audit] = await as('tyler', `select action from public.shop_audit_log where row_id = 'ph01'`);
  assert.equal(audit.action, 'insert');
});

test('a photo must be uploaded, in the right folder, and not reuse an id', { skip }, async () => {
  await assert.rejects(add('fang', 'ph02', 'intake', 'job0001', 'job/job0001/missing.jpg'), /did not upload/);
  await upload('fang', 'job/job0001/side.jpg');
  await assert.rejects(add('fang', 'ph02', 'intake', 'job0002', 'job/job0001/side.jpg'), /Job not found/);
  await assert.rejects(add('fang', 'ph02', 'before_tow', towId, 'job/job0001/side.jpg'), /wrong folder/);
  await assert.rejects(add('fang', 'ph01', 'intake', 'job0001', 'job/job0001/side.jpg'), /already used/);
  await assert.rejects(add('fang', 'ph03', 'intake', 'job0001', 'job/job0001/front.jpg'), /duplicate|unique/);  // same file twice
  await assert.rejects(add('fang', 'ph04', 'bogus', 'job0001', 'job/job0001/side.jpg'), /Unknown photo kind/);
});

test('photos are locked: no edit, no delete, files cannot be replaced', { skip }, async () => {
  await assert.rejects(as('tyler', `update public.shop_condition_photos set note = 'x'`), /permission denied/);
  await assert.rejects(as('tyler', `delete from public.shop_condition_photos`), /permission denied/);
  const changed = await as('tyler', `update storage.objects set name = 'job/job0001/swapped.jpg' where bucket_id = $1 returning id`, [B]);
  assert.deepEqual(changed, []);   // no update rule on this bucket
  assert.equal((await as('tyler', 'select count(*)::int as n from public.shop_condition_photos'))[0].n, 1);
});

test('tow crew can add and see before-tow photos, but not shop job photos', { skip }, async () => {
  await assert.rejects(upload('garrett', 'job/job0001/sneak.jpg'), /row-level security/);
  assert.deepEqual(await as('garrett', `select id from public.shop_condition_photos where kind = 'intake'`), []);
  for (const side of ['front', 'back', 'left']) {
    await upload('garrett', `tow/${towId}/${side}.jpg`);
    await add('garrett', `tw-${side}`, 'before_tow', towId, `tow/${towId}/${side}.jpg`);
  }
  assert.equal((await as('garrett', `select count(*)::int as n from public.shop_condition_photos where tow_id = $1`, [towId]))[0].n, 3);
  const board = await rpc('garrett', 'shop_tow_board', { p_days: 30 });
  assert.equal(board.find(t => t.id === towId).before_photos, 3);
});

test('a tow will not start with fewer than 4 before-tow photos', { skip }, async () => {
  await rpc('garrett', 'shop_tow_claim', { p_id: towId, p_role: 'driver' });
  await rpc('garrett', 'shop_tow_mark_paid', { p_id: towId, p_method: 'Square', p_ref: 'SQ-1' });
  const token = await rpc('garrett', 'shop_tow_sign_link', { p_id: towId });
  await rpc(null, 'shop_tow_sign', { p_token: token, p_name: 'Sam Smith', p_signature: SIG, p_version: '2026-11-25' });
  await assert.rejects(rpc('garrett', 'shop_tow_start', { p_id: towId }), /at least 4 before-tow photos.*has 3/);
  await upload('garrett', `tow/${towId}/right.jpg`);
  await add('garrett', 'tw-right', 'before_tow', towId, `tow/${towId}/right.jpg`);
  const started = await rpc('garrett', 'shop_tow_start', { p_id: towId });
  assert.equal(started.status, 'en_route');
  await upload('garrett', `tow/${towId}/late.jpg`);
  await assert.rejects(add('garrett', 'tw-late', 'before_tow', towId, `tow/${towId}/late.jpg`), /before the tow starts/);
});

test('people with no shop or tow access get nothing', { skip }, async () => {
  assert.deepEqual(await as('rider', 'select * from public.shop_condition_photos'), []);
  assert.deepEqual(await as('rider', 'select name from storage.objects where bucket_id = $1', [B]), []);
  await assert.rejects(add('rider', 'x1', 'intake', 'job0001', 'job/job0001/side.jpg'), /not authorized/);
  await assert.rejects(as(null, `select public.shop_add_condition_photo('x', 'intake', 'job0001', 'job/job0001/side.jpg', null)`), /permission denied/);
});

test('rollback removes the photo rule from tow start and leaves the files', { skip }, async () => {
  await db.exec(sql('2026-11-27-shop-018-condition-photos-rollback.sql'));
  assert.equal((await db.query(`select to_regclass('public.shop_condition_photos') as t`)).rows[0].t, null);
  assert.ok((await db.query(`select count(*)::int as n from storage.objects where bucket_id = $1`, [B])).rows[0].n > 0);
  const board = await rpc('garrett', 'shop_tow_board', { p_days: 30 });
  assert.equal(board.find(t => t.id === towId).before_photos, undefined);
});
