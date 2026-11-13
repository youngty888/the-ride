// Fangs Warehouse database tests: runs sql/warehouse/*.sql against a real in-process
// Postgres (PGlite) with Supabase-style roles, then checks permissions, locking, the
// publish gate and the audit log.
// Needs PGlite, which is not a Ride dependency: `npm i --no-save @electric-sql/pglite`.
// Without it these tests are skipped (the rest of `npm test` still runs).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let PGlite = null;
try { require.resolve('@electric-sql/pglite'); PGlite = true; } catch { /* skipped below */ }
const skip = PGlite ? false : 'PGlite not installed (npm i --no-save @electric-sql/pglite)';

const sql = f => fs.readFileSync(path.join(__dirname, '..', 'sql', 'warehouse', f), 'utf8');
const U = {
  owner: '00000000-0000-4000-8000-000000000001',
  intake: '00000000-0000-4000-8000-000000000002',
  intake2: '00000000-0000-4000-8000-000000000003',
  reviewer: '00000000-0000-4000-8000-000000000004',
  approver: '00000000-0000-4000-8000-000000000005',
  rider: '00000000-0000-4000-8000-000000000006',
};
let db;

// Supabase pieces the migration relies on: roles, auth.users, auth.uid(), storage tables.
const STUB = `
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text unique);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert on storage.objects to authenticated;
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
const rpc = async (user, fn, args) => {
  const keys = Object.keys(args);
  const call = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  return (await as(user, call, keys.map(k => args[k])))[0].r;
};
const rejects = (p, re) => assert.rejects(p, re);

before(async () => {
  if (skip) return;
  const { PGlite: PG } = await import('@electric-sql/pglite');
  db = new PG();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  await db.exec(sql('2026-09-29-wh-001-core.sql'));
  await db.exec(sql('2026-09-29-wh-002-storage.sql'));
  await db.query(`select public.wh_bootstrap_owner('owner@test.local', 'Tyler')`);
  await rpc('owner', 'wh_set_staff', { p_email: 'intake@test.local', p_display_name: 'Jake', p_roles: ['intake'] });
  await rpc('owner', 'wh_set_staff', { p_email: 'intake2@test.local', p_display_name: 'Maria', p_roles: ['intake'] });
  await rpc('owner', 'wh_set_staff', { p_email: 'reviewer@test.local', p_display_name: 'Rev', p_roles: ['fitment_reviewer'] });
  await rpc('owner', 'wh_set_staff', { p_email: 'approver@test.local', p_display_name: 'App', p_roles: ['listing_approver', 'fulfillment'] });
  await rpc('owner', 'wh_upsert_location', { p_warehouse: 'WH1', p_row: 3, p_shelf: 2, p_bin: 7 });
  await rpc('owner', 'wh_upsert_location', { p_warehouse: 'WH1', p_row: 1, p_shelf: 1, p_bin: 1 });
});

const newItem = async (user = 'intake', fields = {}) => {
  const r = await rpc(user, 'wh_create_item', { p_fields: fields });
  assert.equal(r.ok, true);
  return r.item;
};
const photo = (item, slot, bucket = 'wh-originals') => {
  const id = crypto.randomUUID();
  return rpc('intake', 'wh_add_media', { p_id: id, p_item: item.id, p_slot: slot, p_kind: 'photo', p_bucket: bucket,
    p_path: `items/${item.sku}/${slot}/${id}.jpg`, p_bytes: 1000, p_sha256: 'a'.repeat(64) });
};

test('anonymous visitors and plain riders see nothing and can call nothing', { skip }, async () => {
  await newItem();
  for (const t of ['wh_items', 'wh_item_financials', 'wh_staff', 'wh_audit_log', 'wh_media']) {
    await rejects(as(null, `select * from public.${t}`), /permission denied/);
    assert.deepEqual(await as('rider', `select * from public.${t}`), [], `rider sees ${t}`);
  }
  await rejects(rpc('rider', 'wh_create_item', { p_fields: {} }), /Only intake/);
  await rejects(as(null, `select public.wh_create_item('{}')`), /permission denied/);
  await rejects(as('rider', `insert into public.wh_items (sku, created_by) values ('SIC-999999', $1)`, [U.rider]), /permission denied/);
});

test('signup user_metadata role cannot grant access; only the owner can add staff', { skip }, async () => {
  await rejects(rpc('intake', 'wh_set_staff', { p_email: 'rider@test.local', p_display_name: 'X', p_roles: ['owner'] }), /Only an owner/);
  await rejects(as('owner', `select public.wh_bootstrap_owner('rider@test.local','X')`), /permission denied/);
  const me = await rpc('rider', 'wh_me', {});
  assert.equal(me.staff, false);
});

test('SKUs are permanent, sequential and unique; attribution is set by the server', { skip }, async () => {
  const items = await Promise.all([1, 2, 3, 4, 5].map(() => newItem()));
  assert.equal(new Set(items.map(i => i.sku)).size, 5);
  items.forEach(i => { assert.match(i.sku, /^SIC-\d{6}$/); assert.equal(i.created_by, U.intake); });
  const r = await rpc('intake2', 'wh_update_item', { p_id: items[0].id, p_expected_version: items[0].version, p_changes: { title: 'Evo rocker box' } });
  assert.equal(r.item.updated_by, U.intake2);
  assert.equal(r.item.created_by, U.intake);
  await rejects(rpc('intake', 'wh_update_item', { p_id: items[0].id, p_expected_version: r.item.version, p_changes: { created_by: U.rider } }), /cannot be edited/);
  await rejects(rpc('intake', 'wh_update_item', { p_id: items[0].id, p_expected_version: r.item.version, p_changes: { status: 'published' } }), /cannot be edited/);
  await rejects(as('intake', `update public.wh_items set title = 'x'`), /permission denied/);
});

test('two workers editing the same item: the second save gets a conflict, nothing is lost', { skip }, async () => {
  const item = await newItem('intake', { title: 'Shovelhead cylinder' });
  const a = await rpc('intake', 'wh_update_item', { p_id: item.id, p_expected_version: item.version, p_changes: { color: 'Black' } });
  assert.equal(a.ok, true);
  const b = await rpc('intake2', 'wh_update_item', { p_id: item.id, p_expected_version: item.version, p_changes: { material: 'Cast iron' } });
  assert.equal(b.ok, false); assert.equal(b.conflict, true);
  assert.equal(b.current.color, 'Black');
  const c = await rpc('intake2', 'wh_update_item', { p_id: item.id, p_expected_version: b.current.version, p_changes: { material: 'Cast iron' } });
  assert.equal(c.item.color, 'Black'); assert.equal(c.item.material, 'Cast iron');
});

test('intake cannot see or set cost, consignor or minimum price', { skip }, async () => {
  const item = await newItem();
  await rejects(rpc('intake', 'wh_set_financials', { p_item: item.id, p_cost: 10, p_consignor: 'X', p_min_price: 20 }), /Only listing approvers/);
  await rpc('approver', 'wh_set_financials', { p_item: item.id, p_cost: 10, p_consignor: 'Fang', p_min_price: 20 });
  assert.deepEqual(await as('intake', 'select * from public.wh_item_financials'), []);
  assert.deepEqual(await as('intake', `select * from public.wh_audit_log where table_name = 'wh_item_financials'`), [], 'no pricing leak through history');
  assert.equal((await as('approver', `select * from public.wh_audit_log where table_name = 'wh_item_financials' and row_pk = $1`, [item.id])).length, 1);
  assert.deepEqual(await rpc('rider', 'wh_publish_blockers', { p_item: item.id }), ['warehouse staff only']);
  assert.equal((await as('approver', 'select * from public.wh_item_financials where item_id = $1', [item.id])).length, 1);
});

async function readyItem(opts = {}) {
  const item = await newItem('intake', {
    title: 'Harley Evo Rocker Box Set', description: 'Lower rocker boxes', system_code: 'engine', brand: 'Harley-Davidson',
    oem_aftermarket: 'oem', oem_part_number: '17540-84', condition_grade: 'good', tested_status: 'not_applicable',
    bare_length_in: 9, bare_width_in: 5, bare_height_in: 3, weight_oz: 40, weight_source: 'scale',
    shipping_class: 'small_parcel', asking_price: 149.99, fitment_status: 'verified_exact',
    fitment_evidence_level: opts.evidence || 'part_number_match', fitment_evidence_source: 'HD parts catalog 1984-1999',
  });
  await rpc('intake', 'wh_move_item', { p_item: item.id, p_to_code: 'WH1-R03-S02-B07', p_reason: 'intake' });
  for (const s of ['sku_card', 'overall_front', 'overall_back', 'part_number']) await photo(item, s);
  await photo(item, 'overall_front', 'wh-marketplace');
  const cur = (await as('intake', 'select * from public.wh_items where id = $1', [item.id]))[0];
  await rpc('intake', 'wh_save_fitments', { p_item: item.id, p_expected_version: cur.version,
    p_rows: [{ engine_family: 'evolution', platform: 'FLH Touring', start_year: 1984, end_year: 1999 }] });
  return item;
}

test('full path: intake → fitment review → listing review → ready → published, with stamps', { skip }, async () => {
  const item = await readyItem();
  await rpc('intake', 'wh_transition', { p_item: item.id, p_to: 'fitment_review' });
  await rejects(rpc('intake', 'wh_transition', { p_item: item.id, p_to: 'listing_review' }), /fitment_reviewer/);
  await rpc('reviewer', 'wh_transition', { p_item: item.id, p_to: 'listing_review', p_notes: 'PN verified' });
  await rejects(rpc('reviewer', 'wh_transition', { p_item: item.id, p_to: 'ready_to_publish' }), /listing_approver/);
  await rpc('approver', 'wh_transition', { p_item: item.id, p_to: 'ready_to_publish' });
  const r = await rpc('approver', 'wh_transition', { p_item: item.id, p_to: 'published' });
  const i = r.item;
  assert.equal(i.status, 'published');
  assert.equal(i.fitment_verified_by, U.reviewer);
  assert.equal(i.condition_graded_by, U.reviewer);
  assert.equal(i.listing_approved_by, U.approver);
  assert.equal(i.published_by, U.approver);
  const reviews = await as('owner', 'select from_status, to_status from public.wh_reviews where item_id = $1 order by id', [item.id]);
  assert.deepEqual(reviews.map(x => x.to_status), ['fitment_review', 'listing_review', 'ready_to_publish', 'published']);
});

test('publish gate: missing hand measurements, AI-only fitment and unknown fitment are refused', { skip }, async () => {
  // AI suggestion as evidence
  const ai = await readyItem({ evidence: 'ai_suggestion' });
  await rpc('intake', 'wh_transition', { p_item: ai.id, p_to: 'fitment_review' });
  await rejects(rpc('reviewer', 'wh_transition', { p_item: ai.id, p_to: 'listing_review' }), /AI suggestion is not evidence/);

  // Wheel with only a photo-estimated rim diameter
  const w = await readyItem();
  let cur = (await as('intake', 'select * from public.wh_items where id = $1', [w.id]))[0];
  await rpc('intake', 'wh_update_item', { p_id: w.id, p_expected_version: cur.version, p_changes: { system_code: 'wheels_tires' } });
  await rpc('intake', 'wh_save_measurement', { p_item: w.id, p_key: 'rim_diameter', p_value: 16, p_unit: 'in', p_method: 'photo_estimate' });
  await rpc('intake', 'wh_transition', { p_item: w.id, p_to: 'fitment_review' });
  await rpc('reviewer', 'wh_transition', { p_item: w.id, p_to: 'listing_review' });
  await rejects(rpc('approver', 'wh_transition', { p_item: w.id, p_to: 'ready_to_publish' }), /Rim diameter \(by hand/);
  const blockers = await rpc('approver', 'wh_publish_blockers', { p_item: w.id });
  assert.ok(blockers.some(b => /Axle bore/.test(b)) && blockers.includes('photo: measurement'));

  // Unknown fitment stays a research draft
  const u = await newItem('intake', { title: 'Mystery bracket', system_code: 'hardware_misc', fitment_status: 'unknown' });
  await rpc('intake', 'wh_transition', { p_item: u.id, p_to: 'research_draft' });
  await rejects(rpc('intake', 'wh_transition', { p_item: u.id, p_to: 'fitment_review' }), /Cannot move an item from research_draft/);
});

test('missing-information report lists open items with their blockers, staff only', { skip }, async () => {
  const item = await newItem('intake', { title: 'Report me' });
  const rows = await as('intake2', 'select sku, blockers from public.wh_blockers_report() where item_id = $1', [item.id]);
  assert.equal(rows[0].sku, item.sku);
  assert.ok(rows[0].blockers.includes('photo: sku_card') && rows[0].blockers.includes('asking price'));
  await rejects(as('rider', 'select * from public.wh_blockers_report()'), /Warehouse staff only/);
});

test('eBay import: listings become drafts with SKUs, never twice, hints never set fitment', { skip }, async () => {
  const rows = [
    { ebay_item_id: '188814198230', title: 'Harley Evolution Cam Cover Nose Cone Satin OEM 25266-93B', price: '42.00', quantity: '1',
      condition: 'Used', part_number: '25266-93B', system_code: 'engine', hints: { engine_family: 'evolution', source: 'title_parse' } },
    { ebay_item_id: '178454336035', title: 'Harley Davidson Shovelhead OEM Banana Brake Caliper', price: '70.00' },
    { ebay_item_id: '', title: 'no number' },
  ];
  const r = await rpc('intake', 'wh_import_ebay', { p_rows: rows });
  assert.equal(r.created, 2);
  assert.equal(r.skipped[0].reason, 'missing item number or title');
  const again = await rpc('intake2', 'wh_import_ebay', { p_rows: rows.slice(0, 1) });
  assert.equal(again.created, 0); assert.equal(again.skipped[0].reason, 'already imported');
  const [i] = await as('intake', `select * from public.wh_items where ebay_item_id = '188814198230'`);
  assert.equal(i.status, 'draft'); assert.equal(i.source, 'ebay_import'); assert.equal(Number(i.asking_price), 42);
  assert.equal(i.oem_part_number, '25266-93B'); assert.equal(i.fitment_status, null);
  assert.equal(i.ai_suggestion.engine_family, 'evolution');
  assert.match(i.sku, /^SIC-\d{6}$/);
  await rejects(rpc('reviewer', 'wh_import_ebay', { p_rows: rows }), /Only intake/);
});

test('eBay-imported part reuses eBay photos: only a SKU-card photo and location are added to publish', { skip }, async () => {
  const img = 'https://i.ebayimg.com/images/g/EIYAAeSwv8xqePGX/s-l1600.webp';
  const r = await rpc('intake', 'wh_import_ebay', { p_rows: [{ ebay_item_id: '900000000001', title: 'Harley Evo Cam Cover 25266-93B',
    price: '42.00', system_code: 'engine', part_number: '25266-93B', image_urls: [img, 'https://evil.example/x.jpg'] }] });
  assert.equal(r.created, 1);
  const [item] = await as('intake', `select * from public.wh_items where ebay_item_id = '900000000001'`);
  const media = await as('intake', 'select bucket, path, slot from public.wh_media where item_id = $1', [item.id]);
  assert.deepEqual(media, [{ bucket: 'external', path: img, slot: 'overall_front' }], 'only eBay image hosts are accepted');
  let cur = (await rpc('intake', 'wh_update_item', { p_id: item.id, p_expected_version: item.version, p_changes: {
    description: 'Satin cam cover', brand: 'Harley-Davidson', condition_grade: 'good', tested_status: 'not_applicable',
    bare_length_in: 8, bare_width_in: 5, bare_height_in: 2, weight_oz: 20, weight_source: 'scale', shipping_class: 'small_parcel',
    fitment_status: 'verified_exact', fitment_evidence_level: 'part_number_match', fitment_evidence_source: 'HD catalog' } })).item;
  await rejects(rpc('intake', 'wh_transition', { p_item: item.id, p_to: 'fitment_review' }), /photo: sku_card; warehouse location$/);
  await photo(item, 'sku_card');
  await rpc('intake', 'wh_move_item', { p_item: item.id, p_to_code: 'WH1-R01-S01-B01' });
  cur = (await as('intake', 'select * from public.wh_items where id = $1', [item.id]))[0];
  await rpc('intake', 'wh_save_fitments', { p_item: item.id, p_expected_version: cur.version, p_rows: [{ engine_family: 'evolution', start_year: 1993, end_year: 1998 }] });
  await rpc('intake', 'wh_transition', { p_item: item.id, p_to: 'fitment_review' });
  await rpc('reviewer', 'wh_transition', { p_item: item.id, p_to: 'listing_review' });
  const done = await rpc('approver', 'wh_transition', { p_item: item.id, p_to: 'ready_to_publish' });
  assert.equal(done.item.status, 'ready_to_publish');
  await rejects(rpc('intake', 'wh_add_media', { p_id: crypto.randomUUID(), p_item: item.id, p_slot: 'other', p_kind: 'photo',
    p_bucket: 'external', p_path: 'https://evil.example/x.jpg', p_bytes: null, p_sha256: null }), /cannot add photos|eBay image links/);
});

test('submitting for review needs the SKU card, front and back photos and a location', { skip }, async () => {
  const item = await newItem('intake', { title: 'Twin Cam cam cover', system_code: 'engine' });
  await rejects(rpc('intake', 'wh_transition', { p_item: item.id, p_to: 'fitment_review' }), /photo: sku_card.*warehouse location/);
});

test('fitment is locked after review and media paths must belong to the item', { skip }, async () => {
  const item = await readyItem();
  await rpc('intake', 'wh_transition', { p_item: item.id, p_to: 'fitment_review' });
  const r = await rpc('reviewer', 'wh_transition', { p_item: item.id, p_to: 'listing_review' });
  await rejects(rpc('approver', 'wh_update_item', { p_id: item.id, p_expected_version: r.item.version, p_changes: { fitment_status: 'probable' } }), /Fitment is locked/);
  await rejects(rpc('intake', 'wh_update_item', { p_id: item.id, p_expected_version: r.item.version, p_changes: { title: 'x' } }), /cannot edit an item in status listing_review/);
  const other = await newItem();
  const id = crypto.randomUUID();
  await rejects(rpc('intake', 'wh_add_media', { p_id: id, p_item: other.id, p_slot: 'other', p_kind: 'photo', p_bucket: 'wh-originals',
    p_path: `items/${item.sku}/other/${id}.jpg`, p_bytes: 1, p_sha256: 'b'.repeat(64) }), /must be under/);
});

test('moves are logged with from, to, who and when', { skip }, async () => {
  const item = await newItem();
  await rpc('intake', 'wh_move_item', { p_item: item.id, p_to_code: 'WH1-R01-S01-B01' });
  await rpc('intake2', 'wh_move_item', { p_item: item.id, p_to_code: 'WH1-R03-S02-B07', p_reason: 'reshelved' });
  const moves = await as('owner', 'select from_code, to_code, moved_by from public.wh_moves where item_id = $1 order by id', [item.id]);
  assert.deepEqual(moves, [
    { from_code: null, to_code: 'WH1-R01-S01-B01', moved_by: U.intake },
    { from_code: 'WH1-R01-S01-B01', to_code: 'WH1-R03-S02-B07', moved_by: U.intake2 },
  ]);
  await rejects(rpc('intake', 'wh_move_item', { p_item: item.id, p_to_code: 'WH9-R99-S99-B99' }), /Unknown or inactive location/);
});

test('audit log records every change with the actor and cannot be edited by anyone in the app', { skip }, async () => {
  const item = await newItem('intake', { title: 'Before' });
  await rpc('intake2', 'wh_update_item', { p_id: item.id, p_expected_version: item.version, p_changes: { title: 'After' } });
  const log = await as('owner', `select actor, action, changed, old_row->>'title' o, new_row->>'title' n from public.wh_audit_log
    where table_name = 'wh_items' and row_pk = $1 order by id`, [item.id]);
  const last = log.at(-1);
  assert.equal(last.actor, U.intake2); assert.equal(last.o, 'Before'); assert.equal(last.n, 'After');
  assert.ok(last.changed.includes('title'));
  for (const who of ['owner', 'intake']) {
    await rejects(as(who, 'delete from public.wh_audit_log'), /permission denied/);
    await rejects(as(who, `update public.wh_audit_log set actor = null`), /permission denied/);
  }
});

test('storage: staff can upload only under items/SKU/..., riders cannot', { skip }, async () => {
  const ok = `items/SIC-000001/overall_front/${crypto.randomUUID()}.jpg`;
  await as('intake', `insert into storage.objects (bucket_id, name) values ('wh-originals', $1)`, [ok]);
  await rejects(as('intake', `insert into storage.objects (bucket_id, name) values ('wh-originals', 'other/x.jpg')`), /row-level security/);
  await rejects(as('rider', `insert into storage.objects (bucket_id, name) values ('wh-originals', $1)`, [ok.replace('front', 'back')]), /row-level security/);
  const b = (await db.query(`select id, public from storage.buckets order by id`)).rows;
  assert.deepEqual(b, [{ id: 'wh-marketplace', public: true }, { id: 'wh-originals', public: false }]);
});
