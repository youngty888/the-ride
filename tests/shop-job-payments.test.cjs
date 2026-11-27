// Payments on invoices (shop-017): amount, date and method per payment, and the
// Unpaid / Part paid / Paid status following the money. Runs the real SQL in
// PGlite with Supabase-style roles. Sample data only.
// Needs PGlite: `npm i --no-save @electric-sql/pglite`. Skipped without it.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let hasPg = false;
try { require.resolve('@electric-sql/pglite'); hasPg = true; } catch { /* skipped below */ }
const skip = hasPg ? false : 'PGlite not installed (npm i --no-save @electric-sql/pglite)';
const sql = f => fs.readFileSync(path.join(__dirname, '..', 'sql', 'shop', f), 'utf8');
const U = { tyler: '00000000-0000-4000-9000-000000000001', rider: '00000000-0000-4000-9000-000000000003' };
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
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [user ? JSON.stringify({ sub: U[user], role: 'authenticated' }) : '']);
  await db.exec(user ? 'set role authenticated' : 'set role anon');
  try { return (await db.query(text, params)).rows; } finally { await db.exec('reset role'); }
}
const rpc = async (user, fn, args) => {
  const keys = Object.keys(args);
  return (await as(user, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map(k => args[k])))[0].r;
};
const save = (job, items) => rpc('tyler', 'shop_save_estimate', {
  p_job_id: job, p_customer_id: 'cust0001', p_customer: { name: 'Test Customer' },
  p_bike_id: null, p_bike: null, p_job: {}, p_items: items });
const ITEMS = [
  { kind: 'part', description: 'Fork seal kit', quantity: '1', unit_price: '100', unit_cost: '40' },
  { kind: 'labor', description: 'Fork rebuild', quantity: '2', unit_price: '150' },
];
const pay = (id, job, p, user = 'tyler') => rpc(user, 'shop_record_job_payment', { p_id: id, p_job_id: job, p_payment: p });
const job = async id => (await as('tyler', `select j.payment_status, j.total_amount::text as total, b.amount_paid::text as paid,
  b.balance_due::text as due, b.payment_count from public.shop_jobs j join public.shop_job_balances b on b.job_id = j.id where j.id = $1`, [id]))[0];

before(async () => {
  if (skip) return;
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
    '2026-10-30-shop-004-estimates.sql', '2026-11-15-shop-006-payment-status.sql',
    '2026-11-27-shop-017-job-payments.sql', '2026-11-27-shop-017-job-payments.sql']) await db.exec(sql(f)); // safe to re-run
  await db.query(`insert into public.shop_staff (user_id, display_name) values ($1, 'Tyler')`, [U.tyler]);
  await save('job0001', ITEMS);
  await save('job0002', ITEMS);
});

test('a part payment saves amount, date and method, and the job shows Part paid', { skip }, async () => {
  const before = await job('job0001');
  assert.equal(before.payment_status, 'unpaid');
  assert.equal(before.paid, '0.00');
  const r = await pay('pay0001', 'job0001', { amount: '150', paid_on: '2026-11-20', method: 'cash', note: 'Deposit' });
  assert.equal(r.payment_status, 'partial');
  const after = await job('job0001');
  assert.equal(after.payment_status, 'partial');
  assert.equal(after.paid, '150.00');
  assert.equal(Number(after.due), Number(after.total) - 150);
  const [row] = await as('tyler', `select amount::text, paid_on::text, method, note from public.shop_job_payments where id = 'pay0001'`);
  assert.deepEqual(row, { amount: '150.00', paid_on: '2026-11-20', method: 'cash', note: 'Deposit' });
  const [audit] = await as('tyler', `select action, actor::text from public.shop_audit_log where row_id = 'pay0001'`);
  assert.deepEqual(audit, { action: 'insert', actor: U.tyler });
});

test('a double tap with the same id records the payment once', { skip }, async () => {
  const r = await pay('pay0001', 'job0001', { amount: '150', paid_on: '2026-11-20', method: 'cash' });
  assert.equal(r.repeat, true);
  assert.equal((await job('job0001')).payment_count, 1);
  await assert.rejects(pay('pay0001', 'job0002', { amount: '5', method: 'cash' }), /already used/);
});

test('paying the rest marks it Paid, and more than is owed is refused', { skip }, async () => {
  const { due } = await job('job0001');
  await assert.rejects(pay('pay0002', 'job0001', { amount: String(Number(due) + 1), method: 'card' }), /more than the \$[\d.]+ still owed/);
  await pay('pay0002', 'job0001', { amount: due, method: 'zelle', reference: 'Z-4471' });
  const j = await job('job0001');
  assert.equal(j.payment_status, 'paid');
  assert.equal(j.due, '0.00');
  assert.equal(j.payment_count, 2);
});

test('voiding a payment keeps the record and puts the balance back', { skip }, async () => {
  await assert.rejects(rpc('tyler', 'shop_void_job_payment', { p_id: 'pay0002', p_reason: ' ' }), /Say why/);
  await rpc('tyler', 'shop_void_job_payment', { p_id: 'pay0002', p_reason: 'Entered on the wrong job' });
  const j = await job('job0001');
  assert.equal(j.payment_status, 'partial');
  assert.equal(j.paid, '150.00');
  const [row] = await as('tyler', `select voided_at is not null as voided, void_reason from public.shop_job_payments where id = 'pay0002'`);
  assert.deepEqual(row, { voided: true, void_reason: 'Entered on the wrong job' });
  await assert.rejects(rpc('tyler', 'shop_void_job_payment', { p_id: 'pay0002', p_reason: 'again' }), /already voided/);
});

test('once a job has payments, the hand-set label is refused; jobs without payments keep it', { skip }, async () => {
  await assert.rejects(rpc('tyler', 'shop_set_payment_status', { p_job_id: 'job0001', p_payment_status: 'paid' }), /status follows them/);
  const r = await rpc('tyler', 'shop_set_payment_status', { p_job_id: 'job0002', p_payment_status: 'partial' });
  assert.equal(r.payment_status, 'partial');
  await rpc('tyler', 'shop_set_payment_status', { p_job_id: 'job0002', p_payment_status: 'unpaid' });
});

test('if the job total changes, the status follows the money', { skip }, async () => {
  await save('job0001', [{ kind: 'labor', description: 'Small fix', quantity: '1', unit_price: '100' }]);
  const j = await job('job0001');
  assert.equal(Number(j.total) <= 150, true);
  assert.equal(j.payment_status, 'paid');
});

test('bad amounts, methods, dates and card-like references are refused', { skip }, async () => {
  await assert.rejects(pay('pay0010', 'job0002', { amount: '0', method: 'cash' }), /more than \$0/);
  await assert.rejects(pay('pay0011', 'job0002', { amount: '-5', method: 'cash' }));
  await assert.rejects(pay('pay0012', 'job0002', { amount: '10.005', method: 'cash' }), /two decimals/);
  await assert.rejects(pay('pay0013', 'job0002', { amount: '10', method: 'bitcoin' }), /Pick how they paid/);
  await assert.rejects(pay('pay0014', 'job0002', { amount: '10', method: 'cash', paid_on: '2099-01-01' }), /future/);
  await assert.rejects(pay('pay0015', 'job0002', { amount: '10', method: 'card', reference: '4111111111111111' }), /card or bank numbers/);
  await assert.rejects(pay('pay0016', 'nope', { amount: '10', method: 'cash' }), /Job not found/);
  assert.equal((await job('job0002')).payment_count, 0);
});

test('non-staff cannot see or record payments', { skip }, async () => {
  assert.deepEqual(await as('rider', 'select * from public.shop_job_payments'), []);
  await assert.rejects(pay('pay0020', 'job0002', { amount: '10', method: 'cash' }, 'rider'), /not authorized/);
  await assert.rejects(rpc('rider', 'shop_void_job_payment', { p_id: 'pay0001', p_reason: 'x' }), /not authorized/);
  await assert.rejects(as('tyler', `insert into public.shop_job_payments (id, job_id, amount, paid_on, method, created_by) values ('x','job0002',1,current_date,'cash',$1)`, [U.tyler]), /permission denied/);
  await assert.rejects(as('tyler', `delete from public.shop_job_payments`), /permission denied/);
  await assert.rejects(as(null, `select public.shop_record_job_payment('x', 'job0002', '{}'::jsonb)`), /permission denied/);
});

test('rollback removes payments and puts the plain label back', { skip }, async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const d = new PGlite();
  const prev = db; db = d;
  try {
    await d.exec(STUB);
    await d.query('insert into auth.users values ($1, $2)', [U.tyler, 'tyler@test.local']);
    for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
      '2026-10-30-shop-004-estimates.sql', '2026-11-15-shop-006-payment-status.sql', '2026-11-27-shop-017-job-payments.sql',
      '2026-11-27-shop-017-job-payments-rollback.sql']) await d.exec(sql(f));
    await d.query(`insert into public.shop_staff (user_id, display_name) values ($1, 'Tyler')`, [U.tyler]);
    await save('job0009', ITEMS);
    const r = await rpc('tyler', 'shop_set_payment_status', { p_job_id: 'job0009', p_payment_status: 'paid' });
    assert.equal(r.payment_status, 'paid');
    assert.equal((await d.query(`select to_regclass('public.shop_job_payments') as t`)).rows[0].t, null);
  } finally { db = prev; }
});
