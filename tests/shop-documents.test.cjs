// Document library tests (shop-010): runs sql/shop/*.sql against a real in-process
// Postgres (PGlite) with Supabase-style roles, then checks permissions and the
// single-entry-point estimate flow. Mirrors tests/warehouse-sql.test.cjs.
// Needs PGlite: `npm i --no-save @electric-sql/pglite`. Skipped without it.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let PGlite = null;
try { require.resolve('@electric-sql/pglite'); PGlite = true; } catch { /* skipped below */ }
const skip = PGlite ? false : 'PGlite not installed (npm i --no-save @electric-sql/pglite)';

const sql = f => fs.readFileSync(path.join(__dirname, '..', 'sql', 'shop', f), 'utf8');
const U = {
  tyler: '00000000-0000-4000-9000-000000000001',
  garrett: '00000000-0000-4000-9000-000000000002',
  rider: '00000000-0000-4000-9000-000000000003',
  fang: '00000000-0000-4000-9000-000000000004',
};
let db;

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
const rpc = async (user, fn, args) => {
  const keys = Object.keys(args);
  const call = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  return (await as(user, call, keys.map(k => args[k])))[0].r;
};
const rejects = (p, re) => assert.rejects(p, re);


const save = (user, a) => rpc(user, 'shop_save_estimate', {
  p_job_id: a.job, p_customer_id: a.customer, p_customer: { name: 'Test Customer' },
  p_bike_id: null, p_bike: null, p_job: {}, p_items: [{ kind: 'labor', description: 'Oil change', quantity: '1', unit_price: '150' }] });
const doc = (u, id, type, d) => rpc(u, 'shop_save_document', { p_id: id, p_type: type, p_doc: d });
const intake = (u, a) => rpc(u, 'shop_save_intake', { p_doc_id: a.id, p_customer_id: a.cust, p_customer: a.customer,
  p_bike_id: a.bikeId ?? null, p_bike: a.bike ?? null, p_doc: a.doc });

before(async () => {
  if (skip) return;
  const { PGlite: PG } = await import('@electric-sql/pglite');
  db = new PG();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
    '2026-10-30-shop-004-estimates.sql', '2026-11-15-shop-006-payment-status.sql', '2026-11-19-shop-007-saved-jobs.sql',
    '2026-11-21-shop-010-documents.sql', '2026-11-21-shop-010-documents.sql']) await db.exec(sql(f));   // twice: safe to re-run
  await db.query(`insert into public.shop_staff (user_id, display_name) values ($1, 'Tyler'), ($2, 'Garrett')`, [U.tyler, U.garrett]);
  await save('tyler', { job: 'job0001', customer: 'cust0001' });
});

test('staff save a meeting form and update it; others cannot see or write', { skip }, async () => {
  const r = await doc('tyler', 'doc0001', 'meeting', { title: 'Syndicate meeting Nov 23', doc_date: '2026-11-23', data: { notes: 'Sell 3 bikes' } });
  assert.equal(r.title, 'Syndicate meeting Nov 23');
  const r2 = await doc('garrett', 'doc0001', 'meeting', { title: 'Syndicate meeting Nov 23', doc_date: '2026-11-23', data: { notes: 'Sell 4 bikes' }, expected_updated_at: r.updated_at });
  assert.equal(r2.data.notes, 'Sell 4 bikes');
  await rejects(doc('tyler', 'doc0001', 'meeting', { title: 'x', data: {}, expected_updated_at: r.updated_at }), /changed by someone else/);
  await rejects(doc('tyler', 'doc0001', 'legal', { title: 'x', data: {} }), /cannot change type/);
  await rejects(doc('rider', 'doc0002', 'meeting', { title: 'x', data: {} }), /not authorized/);
  assert.deepEqual(await as('rider', 'select id from public.shop_documents'), []);
  assert.deepEqual(await as(null, 'select id from public.shop_documents').catch(() => []), []);
  await rejects(as('garrett', `insert into public.shop_documents (id, doc_type, title, created_by, updated_by) values ('doc0099','other','x',$1,$1)`, [U.garrett]), /permission denied/);
  const log = await as('tyler', `select action from public.shop_audit_log where table_name = 'shop_documents' and row_id = 'doc0001' order by id`);
  assert.deepEqual(log.map(x => x.action), ['create', 'update']);
});

test('bad input is refused', { skip }, async () => {
  await rejects(doc('tyler', 'bad', 'meeting', { title: 'x' }), /invalid document id/);
  await rejects(doc('tyler', 'doc0003', 'recipe', { title: 'x' }), /Unknown document type/);
  await rejects(doc('tyler', 'doc0003', 'legal', { title: '  ' }), /title/);
  await rejects(doc('tyler', 'doc0003', 'legal', { title: 'x', customer_id: 'nobody01' }), /customer not found/);
  await rejects(doc('tyler', 'doc0003', 'legal', { title: 'x', job_id: 'nojob001' }), /job not found/);
  await rejects(doc('tyler', 'doc0003', 'legal', { title: 'x', doc_date: 'soon' }), /not a date/);
  await rejects(doc('tyler', 'doc0003', 'legal', { title: 'x', data: { body: 'a'.repeat(200001) } }), /too long/);
  await rejects(doc('tyler', 'doc0003', 'intake', { title: 'x' }), /intake form/);
});

test('a legal document can link a job and carry an uploaded file, only one that was uploaded', { skip }, async () => {
  await rejects(doc('tyler', 'doc0004', 'legal', { title: 'Repair authorization', file_path: 'docs/doc0004/auth.pdf' }), /not uploaded/);
  await rejects(doc('tyler', 'doc0004', 'legal', { title: 'Repair authorization', file_path: 'docs/other01/auth.pdf' }), /invalid file path/);
  await rejects(as('rider', `insert into storage.objects (bucket_id, name) values ('shop-documents', 'docs/doc0004/x.pdf')`), /row-level security/);
  await as('garrett', `insert into storage.objects (bucket_id, name) values ('shop-documents', 'docs/doc0004/auth.pdf')`);
  const r = await doc('garrett', 'doc0004', 'legal', { title: 'Repair authorization', customer_id: 'cust0001', job_id: 'job0001',
    file_path: 'docs/doc0004/auth.pdf', file_name: 'auth.pdf', file_type: 'application/pdf', data: { body: 'I authorize the work.' } });
  assert.equal(r.file_path, 'docs/doc0004/auth.pdf'); assert.equal(r.job_id, 'job0001');
  const r2 = await doc('garrett', 'doc0004', 'legal', { title: 'Repair authorization (signed)', customer_id: 'cust0001', data: {} });
  assert.equal(r2.file_path, 'docs/doc0004/auth.pdf');   // saving again keeps the file
  assert.deepEqual(await as('rider', `select name from storage.objects where bucket_id = 'shop-documents'`), []);
  const b = (await db.query(`select public from storage.buckets where id = 'shop-documents'`)).rows;
  assert.equal(b[0].public, false);
});

test('an intake form creates the customer and bike and links them', { skip }, async () => {
  const r = await intake('garrett', { id: 'doc0005', cust: 'cust0005', customer: { name: 'Jane Rider', phone: '520-555-0100', email: 'jane@test.local', address: '1 Main St' },
    bikeId: 'bike0005', bike: { year: '2019', make: 'Harley-Davidson', model: 'Road Glide', vin: '1hd1abc', mileage: '22000' },
    doc: { title: 'Intake: Jane Rider', doc_date: '2026-11-21', data: { insurance: 'Progressive', heard: 'Instagram', consent: true } } });
  assert.equal(r.customer_id, 'cust0005'); assert.equal(r.bike_id, 'bike0005'); assert.equal(r.doc_type, 'intake');
  const c = await as('tyler', `select name, phone from public.shop_customers where id = 'cust0005'`);
  assert.deepEqual(c[0], { name: 'Jane Rider', phone: '520-555-0100' });
  const b = await as('tyler', `select vin, year, mileage, customer_id from public.shop_bikes where id = 'bike0005'`);
  assert.deepEqual(b[0], { vin: '1HD1ABC', year: 2019, mileage: 22000, customer_id: 'cust0005' });
  // A returning customer: the form updates the same record.
  await intake('tyler', { id: 'doc0006', cust: 'cust0005', customer: { name: 'Jane Rider', phone: '520-555-0199' }, doc: { title: 'Intake: Jane Rider' } });
  assert.equal((await as('tyler', `select phone from public.shop_customers where id = 'cust0005'`))[0].phone, '520-555-0199');
  await rejects(intake('tyler', { id: 'doc0007', cust: 'cust0001', customer: { name: 'Someone' }, bikeId: 'bike0005', bike: { make: 'X' }, doc: { title: 'x' } }), /different customer/);
  await rejects(intake('tyler', { id: 'doc0007', cust: 'cust0007', customer: { name: '' }, doc: { title: 'x' } }), /name is required/);
  await rejects(intake('tyler', { id: 'doc0001', cust: 'cust0007', customer: { name: 'A' }, doc: { title: 'x' } }), /cannot change type/);
  await rejects(intake('rider', { id: 'doc0008', cust: 'cust0008', customer: { name: 'A' }, doc: { title: 'x' } }), /not authorized/);
  await rejects(as('garrett', `select public.shop_put_document('doc0009','other','{"title":"x"}'::jsonb,null,null)`), /permission denied/);
});

test('archive hides a document without deleting it', { skip }, async () => {
  await rpc('tyler', 'shop_archive_document', { p_id: 'doc0004', p_archived: true });
  assert.equal((await as('tyler', `select archived from public.shop_documents where id = 'doc0004'`))[0].archived, true);
  await rpc('tyler', 'shop_archive_document', { p_id: 'doc0004', p_archived: false });
  assert.equal((await as('tyler', `select archived from public.shop_documents where id = 'doc0004'`))[0].archived, false);
  await rejects(rpc('rider', 'shop_archive_document', { p_id: 'doc0004', p_archived: true }), /not authorized/);
});

test('rollback removes it cleanly', { skip }, async () => {
  await db.exec(sql('2026-11-21-shop-010-documents-rollback.sql'));
  assert.equal((await db.query(`select to_regclass('public.shop_documents') as t`)).rows[0].t, null);
  await db.exec(sql('2026-11-21-shop-010-documents.sql'));
});
