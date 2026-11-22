// Admin home tests (shop-011): calendar, receipts, pay stubs, consignment,
// money in vs out and my hours. Runs sql/shop/*.sql in an in-process Postgres
// (PGlite) with Supabase-style roles and checks who can see and do what.
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
const appt = (u, id, a) => rpc(u, 'shop_save_appointment', { p_id: id, p_appt: a });
const upload = (u, name) => as(u, `insert into storage.objects (bucket_id, name) values ('shop-documents', $1)`, [name]);
const files = async (u, name) => (await as(u, `select name from storage.objects where bucket_id = 'shop-documents' and name = $1`, [name])).length;
const docs = async (u, type) => as(u, 'select * from public.shop_documents where doc_type = $1 order by id', [type]);
const FILES = ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
  '2026-10-30-shop-004-estimates.sql', '2026-11-15-shop-006-payment-status.sql', '2026-11-19-shop-007-saved-jobs.sql',
  '2026-11-21-shop-008-tech-signoff.sql', '2026-11-21-shop-010-documents.sql'];

before(async () => {
  if (skip) return;
  const { PGlite: PG } = await import('@electric-sql/pglite');
  db = new PG();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  for (const f of FILES) await db.exec(sql(f));
  await db.exec(sql('2026-11-21-shop-011-admin-home.sql'));
  await db.exec(sql('2026-11-21-shop-011-admin-home.sql'));        // twice: safe to re-run
  await db.query(`insert into public.shop_staff (user_id, display_name, payroll_manager) values ($1, 'Tyler', true), ($2, 'Garrett', false), ($3, 'Fang', false)`, [U.tyler, U.garrett, U.fang]);
  await save('tyler', { job: 'job0001', customer: 'cust0001' });
});

test('calendar: shop appointments are shared, personal ones stay with their owner', { skip }, async () => {
  const pub = await appt('garrett', 'appt0001', { title: 'Road Glide drop-off', starts_at: '2026-11-24T16:00:00Z', ends_at: '2026-11-24T17:00:00Z', customer_id: 'cust0001', job_id: 'job0001' });
  assert.equal(pub.visibility, 'public'); assert.equal(pub.owner_user_id, U.garrett);
  await appt('tyler', 'appt0002', { title: 'Dentist', starts_at: '2026-11-25T18:00:00Z', visibility: 'personal' });
  const mine = async u => (await as(u, 'select id from public.shop_appointments order by id')).map(r => r.id);
  assert.deepEqual(await mine('tyler'), ['appt0001', 'appt0002']);
  assert.deepEqual(await mine('garrett'), ['appt0001']);
  assert.deepEqual(await mine('fang'), ['appt0001']);
  assert.deepEqual(await mine('rider'), []);
  // Anyone on staff can change a shop appointment; only the owner a personal one.
  const moved = await appt('fang', 'appt0001', { title: 'Road Glide drop-off', starts_at: '2026-11-24T17:00:00Z', expected_updated_at: pub.updated_at });
  assert.equal(new Date(moved.starts_at).toISOString(), '2026-11-24T17:00:00.000Z');
  assert.equal(moved.owner_user_id, U.garrett, 'owner stays the person who made it');
  await rejects(appt('garrett', 'appt0002', { title: 'Hijack', starts_at: '2026-11-25T18:00:00Z' }), /Only the person who made a personal appointment/);
  await rejects(appt('fang', 'appt0001', { title: 'x', starts_at: '2026-11-24T17:00:00Z', visibility: 'personal' }), /Only the person who made/);
  await rejects(appt('garrett', 'appt0001', { title: 'x', starts_at: '2026-11-24T17:00:00Z', expected_updated_at: pub.updated_at }), /changed by someone else/);
  await rejects(appt('tyler', 'appt0003', { title: '', starts_at: '2026-11-24T17:00:00Z' }), /Enter what the appointment is for/);
  await rejects(appt('tyler', 'appt0003', { title: 'x', starts_at: 'soon' }), /not a date and time/);
  await rejects(appt('tyler', 'appt0003', { title: 'x', starts_at: '2026-11-24T17:00:00Z', ends_at: '2026-11-24T16:00:00Z' }), /before the start/);
  await rejects(appt('tyler', 'appt0003', { title: 'x', starts_at: '2026-11-24T17:00:00Z', customer_id: 'nope00' }), /Customer not found/);
  await rejects(appt('rider', 'appt0003', { title: 'x', starts_at: '2026-11-24T17:00:00Z' }), /not authorized/);
  await rejects(as('garrett', `insert into public.shop_appointments (id, title, starts_at, owner_user_id, updated_by) values ('appt0009', 'x', now(), $1, $1)`, [U.garrett]), /permission denied/);
  // Cancel keeps the row. The audit log never holds a personal appointment's details.
  const c = await appt('garrett', 'appt0001', { title: 'Road Glide drop-off', starts_at: '2026-11-24T17:00:00Z', cancelled: true });
  assert.equal(c.cancelled, true);
  const audit = (await db.query(`select detail from public.shop_audit_log where table_name = 'shop_appointments' and row_id = 'appt0002'`)).rows;
  assert.deepEqual(audit.map(a => a.detail), [{}]);
});

test('receipts: any staff member turns one in with a picture; money is checked', { skip }, async () => {
  await rejects(rpc('garrett', 'shop_save_receipt', { p_id: 'rcpt0001', p_doc: { title: 'Parts run', amount: '42.10' } }), /Attach a picture/);
  await upload('garrett', 'docs/rcpt0001/1-receipt.jpg');
  const r = await rpc('garrett', 'shop_save_receipt', { p_id: 'rcpt0001', p_doc: { title: 'Drag Specialties order', doc_date: '2026-11-20', amount: '$1,234.50',
    job_id: 'job0001', file_path: 'docs/rcpt0001/1-receipt.jpg', file_name: 'receipt.jpg', file_type: 'image/jpeg', data: { vendor: 'Drag Specialties', category: 'Parts', bill_customer: true } } });
  assert.equal(Number(r.amount), 1234.5); assert.equal(r.owner_user_id, U.garrett); assert.equal(r.job_id, 'job0001');
  assert.equal((await docs('fang', 'receipt')).length, 1, 'other staff can see receipts');
  assert.equal(await files('fang', 'docs/rcpt0001/1-receipt.jpg'), 1);
  // Re-save keeps the file and who turned it in.
  const r2 = await rpc('tyler', 'shop_save_receipt', { p_id: 'rcpt0001', p_doc: { title: 'Drag Specialties order', doc_date: '2026-11-20', amount: '1234.50', data: { vendor: 'Drag Specialties', category: 'Parts' } } });
  assert.equal(r2.file_path, 'docs/rcpt0001/1-receipt.jpg'); assert.equal(r2.owner_user_id, U.garrett);
  await rejects(rpc('garrett', 'shop_save_receipt', { p_id: 'rcpt0001', p_doc: { title: 'x', amount: '0' } }), /more than 0/);
  await rejects(rpc('garrett', 'shop_save_receipt', { p_id: 'rcpt0001', p_doc: { title: 'x', amount: 'lots' } }), /not a number/);
  await rejects(rpc('garrett', 'shop_save_receipt', { p_id: 'rcpt0001', p_doc: { title: 'x' } }), /Enter the amount/);
  await rejects(rpc('garrett', 'shop_save_document', { p_id: 'rcpt0002', p_type: 'receipt', p_doc: { title: 'x' } }), /Use the receipt form/);
  await rejects(rpc('rider', 'shop_save_receipt', { p_id: 'rcpt0002', p_doc: { title: 'x', amount: '5' } }), /not authorized/);
});

test('pay stubs: only the payroll manager files them; only the owner and payroll see them', { skip }, async () => {
  await rejects(rpc('garrett', 'shop_save_paystub', { p_id: 'stub0001', p_owner: U.garrett, p_doc: { title: 'Week of Nov 16' } }), /Only the payroll manager/);
  await rejects(rpc('tyler', 'shop_save_paystub', { p_id: 'stub0001', p_owner: U.rider, p_doc: { title: 'x' } }), /Pick a staff member/);
  await rpc('tyler', 'shop_save_paystub', { p_id: 'stub0001', p_owner: U.garrett, p_doc: { title: 'Pay stub · week of Nov 16', doc_date: '2026-11-21', amount: '912.40' } });
  // Nobody but payroll can put a file on a pay stub.
  await rejects(upload('garrett', 'docs/stub0001/fake.pdf'), /row-level security|permission/);
  await rejects(upload('fang', 'docs/stub0001/fake.pdf'), /row-level security|permission/);
  await upload('tyler', 'docs/stub0001/1-stub.pdf');
  const s = await rpc('tyler', 'shop_save_paystub', { p_id: 'stub0001', p_owner: U.garrett, p_doc: { title: 'Pay stub · week of Nov 16', doc_date: '2026-11-21', amount: '912.40', file_path: 'docs/stub0001/1-stub.pdf', file_name: 'stub.pdf', file_type: 'application/pdf' } });
  assert.equal(s.owner_user_id, U.garrett); assert.equal(Number(s.amount), 912.4); assert.equal(s.customer_id, null);
  assert.equal((await docs('garrett', 'paystub')).length, 1);
  assert.equal((await docs('tyler', 'paystub')).length, 1);
  assert.equal((await docs('fang', 'paystub')).length, 0, 'other staff cannot see it');
  assert.equal(await files('garrett', 'docs/stub0001/1-stub.pdf'), 1);
  assert.equal(await files('fang', 'docs/stub0001/1-stub.pdf'), 0, 'other staff cannot open the file');
  assert.equal(await files('rider', 'docs/stub0001/1-stub.pdf'), 0);
  await rejects(rpc('tyler', 'shop_save_paystub', { p_id: 'stub0001', p_owner: U.fang, p_doc: { title: 'x' } }), /cannot move to another person/);
  await rejects(rpc('garrett', 'shop_save_document', { p_id: 'stub0001', p_type: 'paystub', p_doc: { title: 'x' } }), /Use the paystub form/);
  await rejects(rpc('garrett', 'shop_archive_document', { p_id: 'stub0001', p_archived: true }), /Only the payroll manager can archive pay stubs/);
  assert.equal(await rpc('tyler', 'shop_archive_document', { p_id: 'stub0001', p_archived: true }), true);
  assert.equal(await rpc('garrett', 'shop_archive_document', { p_id: 'rcpt0001', p_archived: false }), true, 'other documents: any staff');
});

test('consignment: a bike or an item, linked to the consignor', { skip }, async () => {
  const save = a => rpc('fang', 'shop_save_consignment', { p_doc_id: a.id, p_customer_id: a.cust, p_customer: { name: 'Consignor One', phone: '520-555-0199' },
    p_bike_id: a.bikeId ?? null, p_bike: a.bike ?? null, p_doc: { title: a.title, doc_date: '2026-11-21', data: a.data } });
  const b = await save({ id: 'cons0001', cust: 'cust0101', bikeId: 'bike0101', bike: { year: '2016', make: 'Harley-Davidson', model: 'Street Bob', vin: '1hd1abc' },
    title: 'Consignment · 2016 Street Bob', data: { kind: 'bike', asking_price: '9,500', minimum_price: '8500', commission_pct: '10', term_days: '90' } });
  assert.equal(b.customer_id, 'cust0101'); assert.equal(b.bike_id, 'bike0101'); assert.equal(Number(b.amount), 9500);
  assert.equal((await db.query(`select vin from public.shop_bikes where id = 'bike0101'`)).rows[0].vin, '1HD1ABC');
  const i = await save({ id: 'cons0002', cust: 'cust0101', title: 'Consignment · exhaust', data: { kind: 'item', item_description: 'Vance & Hines pipes', asking_price: '400' } });
  assert.equal(i.bike_id, null);
  await rejects(save({ id: 'cons0003', cust: 'cust0101', title: 'x', data: { kind: 'boat' } }), /Pick bike or item/);
  await rejects(save({ id: 'cons0003', cust: 'cust0101', title: 'x', data: { kind: 'item', asking_price: 'cheap' } }), /not a number/);
  await rejects(save({ id: 'rcpt0001', cust: 'cust0101', title: 'x', data: { kind: 'item' } }), /cannot change type/);
  await rejects(rpc('rider', 'shop_save_consignment', { p_doc_id: 'cons0004', p_customer_id: 'cust0102', p_customer: { name: 'x' }, p_bike_id: null, p_bike: null, p_doc: { title: 'x', data: { kind: 'item' } } }), /not authorized/);
  await rejects(as('fang', `select public.shop_upsert_customer_bike('cust0103', '{"name":"x"}', null, null)`), /permission denied/);
});

test('my hours: each tech sees their own week, month and year', { skip }, async () => {
  const add = (tech, step, hours, ago) => db.query(`insert into public.shop_labor_signoffs (job_id, step_key, step_name, tech_id, hours, signed_at)
    values ('job0001', $1, $1, $2, $3, now() - $4::interval)`, [step, U[tech], hours, ago]);
  await add('garrett', 'a', 2.5, '1 minute'); await add('garrett', 'b', 1, '2 minutes');
  await add('garrett', 'c', 4, '400 days'); await add('fang', 'd', 3, '1 minute');
  const h = await rpc('garrett', 'shop_my_hours', {});
  assert.equal(Number(h.week), 3.5); assert.equal(Number(h.month), 3.5); assert.equal(Number(h.year), 3.5);
  assert.equal(Number((await rpc('fang', 'shop_my_hours', {})).week), 3);
  assert.equal(Number((await rpc('tyler', 'shop_my_hours', {})).year), 0);
  assert.equal(await rpc('rider', 'shop_my_hours', {}), null);
});

test('money in vs out: payroll or money access only', { skip }, async () => {
  await db.query(`update public.shop_jobs set payment_status = 'paid', job_date = '2026-11-18' where id = 'job0001'`);
  const total = Number((await db.query(`select total_amount from public.shop_jobs where id = 'job0001'`)).rows[0].total_amount);
  await upload('fang', 'docs/rcpt0003/1-r.jpg');
  await rpc('fang', 'shop_save_receipt', { p_id: 'rcpt0003', p_doc: { title: 'Shop rags', doc_date: '2026-11-19', amount: '25', file_path: 'docs/rcpt0003/1-r.jpg', data: { category: 'Supplies' } } });
  const m = await rpc('tyler', 'shop_money_summary', { p_from: '2026-11-01', p_to: '2026-11-30' });
  assert.equal(Number(m.in_jobs), total); assert.equal(Number(m.money_out), 1259.5); assert.equal(Number(m.net), total - 1259.5);
  assert.deepEqual(m.out_by_category.map(c => c.category), ['Parts', 'Supplies']);
  assert.equal(m.plans_installed, false);
  const oct = await rpc('tyler', 'shop_money_summary', { p_from: '2026-10-01', p_to: '2026-10-31' });
  assert.equal(Number(oct.money_in), 0); assert.equal(Number(oct.money_out), 0);
  await rejects(rpc('garrett', 'shop_money_summary', { p_from: '2026-11-01', p_to: '2026-11-30' }), /money access/);
  await rejects(rpc('tyler', 'shop_money_summary', { p_from: '2026-11-30', p_to: '2026-11-01' }), /Pick a date range/);
  await db.query(`update public.shop_staff set money_access = true where user_id = $1`, [U.garrett]);
  assert.equal(Number((await rpc('garrett', 'shop_money_summary', { p_from: '2026-11-01', p_to: '2026-11-30' })).money_out), 1259.5);
  assert.deepEqual(await rpc('garrett', 'shop_me', {}), { user_id: U.garrett, name: 'Garrett', payroll_manager: false, money: true });
  assert.equal(await rpc('rider', 'shop_me', {}), null);
});

test('re-running shop-010 after shop-011 is refused; rollback then reinstall works', { skip }, async () => {
  await rejects(db.exec(sql('2026-11-21-shop-010-documents.sql')), /shop-011 is already installed/);
  assert.equal((await docs('fang', 'paystub')).length, 0, 'pay stubs still private');
  await db.exec(sql('2026-11-21-shop-011-admin-home-rollback.sql'));
  assert.equal((await db.query(`select to_regclass('public.shop_appointments') t`)).rows[0].t, null);
  assert.equal((await db.query(`select count(*)::int n from pg_proc where proname in ('shop_save_receipt','shop_save_paystub','shop_money_summary','shop_my_hours','shop_save_appointment')`)).rows[0].n, 0);
  assert.equal((await docs('tyler', 'receipt')).length, 2, 'receipts are kept');
  await db.exec(sql('2026-11-21-shop-011-admin-home.sql'));
  assert.equal((await docs('fang', 'paystub')).length, 0);
});
