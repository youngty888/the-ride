// Shop module database tests: runs sql/shop/*.sql against a real in-process
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

// shop_submit_estimate returns a row set (customer_id, bike_id, job_id), so it
// needs `select * from` rather than the single-column `select fn() as r` form
// the generic rpc() helper above uses.
const submitEstimate = async (user, args) => {
  const keys = Object.keys(args);
  const call = `select * from public.shop_submit_estimate(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
  const rows = await as(user, call, keys.map(k => args[k] === undefined ? null : args[k]));
  return rows[0];
};

before(async () => {
  if (skip) return;
  const { PGlite: PG } = await import('@electric-sql/pglite');
  db = new PG();
  await db.exec(STUB);
  for (const [name, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, `${name}@test.local`]);
  await db.exec(sql('2026-10-04-shop-001-core.sql'));
  await db.exec(sql('2026-10-04-shop-002-writes.sql'));
  await db.exec(sql('2026-10-04-shop-003-storage.sql'));
  await db.exec(sql('2026-10-30-shop-004-estimates.sql'));
  await db.exec(sql('2026-10-30-shop-004-estimates.sql')); // re-running is safe
  await db.query(`insert into public.shop_staff (user_id, display_name) values ($1, 'Tyler'), ($2, 'Garrett')`, [U.tyler, U.garrett]);
});

test('a rider (non-staff) can see nothing and can call nothing', { skip }, async () => {
  for (const t of ['shop_customers', 'shop_bikes', 'shop_jobs', 'shop_part_orders', 'shop_audit_log', 'shop_staff']) {
    assert.deepEqual(await as('rider', `select * from public.${t}`), [], `rider sees ${t}`);
  }
  await rejects(submitEstimate('rider', { p_job_id: null, p_customer_id: null,
    p_customer: { name: 'X' }, p_bike_id: null, p_bike: null, p_job: {} }), /not authorized/);
});

test('one estimate call creates the customer, bike and job together', { skip }, async () => {
  const r = await submitEstimate('tyler', {
    p_job_id: null, p_customer_id: null,
    p_customer: { name: 'Mike Rider', phone: '555-1212', email: 'mike@example.com', address: '12 Main St' },
    p_bike_id: null, p_bike: { vin: '1HD1KB4197Y000001', make: 'Harley-Davidson', model: 'Road King', year: 2015, mileage: 32000 },
    p_job: { invoice_number: 'INV-1001', status: 'estimate', parts_amount: 100, labor_amount: 150, tax_amount: 10, total_amount: 260, parts_cost: 60 },
  });
  assert.ok(r.customer_id && r.bike_id && r.job_id);
  const [customer] = await as('garrett', 'select * from public.shop_customers where id = $1', [r.customer_id]);
  assert.equal(customer.name, 'Mike Rider');
  assert.equal(customer.invoice_count, 1);
  const [bike] = await as('garrett', 'select * from public.shop_bikes where id = $1', [r.bike_id]);
  assert.equal(bike.vin, '1HD1KB4197Y000001'); assert.equal(bike.customer_id, r.customer_id);
  const [job] = await as('garrett', 'select * from public.shop_jobs where id = $1', [r.job_id]);
  assert.equal(job.status, 'estimate'); assert.equal(Number(job.part_profit), 40); assert.equal(Number(job.total_profit), 200);
  // lifetime_spend only counts completed jobs, so it's still 0 at the estimate stage
  assert.equal(Number(customer.lifetime_spend), 0);
  return r;
});

test('re-submitting the same job id updates it and the customer rollups, without creating duplicates', { skip }, async () => {
  const first = await submitEstimate('tyler', {
    p_job_id: null, p_customer_id: null, p_customer: { name: 'Second Customer' },
    p_bike_id: null, p_bike: { make: 'Yamaha', model: 'FZ6' },
    p_job: { status: 'estimate', total_amount: 300, parts_cost: 50 },
  });
  await submitEstimate('garrett', {
    p_job_id: first.job_id, p_customer_id: first.customer_id, p_customer: null,
    p_bike_id: first.bike_id, p_bike: null,
    p_job: { status: 'complete', total_amount: 300, parts_cost: 50 },
  });
  const jobs = await as('tyler', 'select * from public.shop_jobs where id = $1', [first.job_id]);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'complete'); assert.equal(jobs[0].updated_by, U.garrett);
  const [customer] = await as('tyler', 'select * from public.shop_customers where id = $1', [first.customer_id]);
  assert.equal(customer.invoice_count, 1); assert.equal(Number(customer.lifetime_spend), 300);
});

test('every write is recorded in the audit log', { skip }, async () => {
  const r = await submitEstimate('garrett', {
    p_job_id: null, p_customer_id: null, p_customer: { name: 'Audit Test' },
    p_bike_id: null, p_bike: null, p_job: { status: 'estimate', total_amount: 50 },
  });
  const log = await as('tyler', `select actor, action from public.shop_audit_log where row_id = $1`, [r.job_id]);
  assert.equal(log.length, 1); assert.equal(log[0].actor, U.garrett);
  for (const who of ['tyler', 'garrett']) {
    await rejects(as(who, 'delete from public.shop_audit_log'), /permission denied/);
  }
});

// ===================== 004: itemized estimates =====================
const C = require('../shop/sh-calc.js');
let n = 0;
const id = p => `${p}${Date.now().toString(36)}${(++n).toString().padStart(4, '0')}`;
const save = (user, a) => rpc(user, 'shop_save_estimate', {
  p_job_id: a.job, p_customer_id: a.customer, p_customer: a.c || { name: 'Test Customer' },
  p_bike_id: a.bike ?? null, p_bike: a.b ?? null, p_job: a.j || {}, p_items: a.items || [] });
const ITEMS = [
  { kind: 'part', description: 'Oil filter', quantity: '1', unit_price: '18.95', unit_cost: '9.10' },
  { kind: 'part', description: 'Oil 1 qt', quantity: '4', unit_price: '12.50', unit_cost: '7.25' },
  { kind: 'labor', description: 'Oil change', quantity: '1.5', unit_price: '95' },
];

test('save estimate: customer, bike, 2 parts + labor in one call; totals are calculated by the database', { skip }, async () => {
  const a = { job: id('j'), customer: id('c'), bike: id('b'),
    c: { name: 'TEST — Estimate Customer', phone: '520-555-0100', email: '', address: '  ' },
    b: { vin: '1hd1kb4197y000002', make: 'Harley-Davidson', model: 'Street Glide', year: '2018', mileage: '', photos: ['x/1.jpg'] },
    j: { job_date: '2026-10-30', work_description: 'Oil service', customer_notes: 'Ready Friday', notes: 'internal only', tax_rate: '8.7', tax_applies_to: 'parts',
         total_amount: 1, parts_amount: 999 }, // client-supplied money is ignored
    items: ITEMS };
  const r = await save('tyler', a);
  assert.equal(r.job_id, a.job); assert.ok(Number(r.estimate_number) >= 1001);
  const [job] = await as('garrett', 'select * from public.shop_jobs where id = $1', [a.job]);
  const calc = C.calculate(ITEMS, { rate: '8.7', appliesTo: 'parts' });
  assert.equal(Number(job.parts_amount), calc.parts); assert.equal(Number(job.labor_amount), calc.labor);
  assert.equal(Number(job.tax_amount), calc.tax); assert.equal(Number(job.total_amount), calc.total);
  assert.equal(Number(job.total_amount), 217.45); assert.equal(Number(job.parts_cost), 38.1);
  assert.equal(job.customer_notes, 'Ready Friday'); assert.equal(job.notes, 'internal only');
  const [cust] = await as('garrett', 'select * from public.shop_customers where id = $1', [a.customer]);
  assert.equal(cust.email, null); assert.equal(cust.address, null); // blanks stored as empty, not ''
  const [bike] = await as('garrett', 'select * from public.shop_bikes where id = $1', [a.bike]);
  assert.equal(bike.vin, '1HD1KB4197Y000002'); assert.equal(bike.year, 2018); assert.equal(bike.mileage, null);
  assert.deepEqual(bike.photo_urls, ['x/1.jpg']);
  const lines = await as('garrett', 'select kind, description, quantity, unit_price, unit_cost from public.shop_job_line_items where job_id = $1 order by sort_order', [a.job]);
  assert.deepEqual(lines.map(l => l.description), ['Oil filter', 'Oil 1 qt', 'Oil change']);
});

test('reopen and edit: bike, photos and lines survive; double-save never duplicates', { skip }, async () => {
  const a = { job: id('j'), customer: id('c'), bike: id('b'), b: { make: 'Yamaha', model: 'FZ-09', photos: ['b/1.jpg', 'b/2.jpg'] }, items: ITEMS, j: { tax_rate: '8.7' } };
  await save('tyler', a); await save('tyler', a); // double tap on Save
  const [{ count }] = await as('tyler', 'select count(*)::int as count from public.shop_jobs where id = $1', [a.job]);
  assert.equal(count, 1);
  const [{ lc }] = await as('tyler', 'select count(*)::int as lc from public.shop_job_line_items where job_id = $1', [a.job]);
  assert.equal(lc, 3);
  const [job] = await as('tyler', 'select * from public.shop_jobs where id = $1', [a.job]);
  // edit: change a price, drop a line, add one, keep bike and photos as reopened
  const edited = [ITEMS[0], { kind: 'labor', description: 'Oil change', quantity: '2', unit_price: '95' }, { kind: 'part', description: 'Drain plug washer', quantity: '1', unit_price: '2.50' }];
  await save('garrett', { ...a, b: { make: 'Yamaha', model: 'FZ-09', year: '2021', photos: ['b/1.jpg', 'b/2.jpg'] }, items: edited, j: { tax_rate: '8.7', expected_updated_at: job.updated_at } });
  const [after] = await as('tyler', 'select * from public.shop_jobs where id = $1', [a.job]);
  assert.equal(after.estimate_number, job.estimate_number);
  assert.equal(Number(after.total_amount), C.calculate(edited, { rate: '8.7' }).total);
  const [bike] = await as('tyler', 'select * from public.shop_bikes where id = $1', [a.bike]);
  assert.equal(bike.make, 'Yamaha'); assert.equal(bike.year, 2021); assert.deepEqual(bike.photo_urls, ['b/1.jpg', 'b/2.jpg']);
  const lines = await as('tyler', 'select description from public.shop_job_line_items where job_id = $1 order by sort_order', [a.job]);
  assert.deepEqual(lines.map(l => l.description), ['Oil filter', 'Oil change', 'Drain plug washer']);
  // a stale editor (old updated_at) is refused instead of overwriting
  await rejects(save('tyler', { ...a, items: ITEMS, j: { expected_updated_at: job.updated_at } }), /changed by someone else/);
});

test('status moves estimate -> in progress -> complete without touching amounts', { skip }, async () => {
  const a = { job: id('j'), customer: id('c'), items: ITEMS, j: { tax_rate: '8.7', invoice_number: id('INV') } };
  await save('tyler', a);
  await rpc('garrett', 'shop_set_job_status', { p_job_id: a.job, p_status: 'in_progress' });
  await rejects(rpc('garrett', 'shop_set_job_status', { p_job_id: a.job, p_status: 'bogus' }), /invalid status/);
  await rpc('garrett', 'shop_set_job_status', { p_job_id: a.job, p_status: 'complete' });
  const [job] = await as('tyler', 'select * from public.shop_jobs where id = $1', [a.job]);
  assert.equal(job.status, 'complete'); assert.equal(Number(job.total_amount), 217.45); assert.equal(job.invoice_number, a.j.invoice_number);
  const [cust] = await as('tyler', 'select lifetime_spend from public.shop_customers where id = $1', [a.customer]);
  assert.equal(Number(cust.lifetime_spend), 217.45);
  await rejects(rpc('garrett', 'shop_set_job_status', { p_job_id: a.job, p_status: 'estimate' }), /one step/);
  // editing keeps the status it has
  await save('tyler', { ...a, j: { ...a.j, status: 'complete' } });
  assert.equal((await as('tyler', 'select status from public.shop_jobs where id = $1', [a.job]))[0].status, 'complete');
});

test('validation: blank year/mileage are fine, bad values give readable errors', { skip }, async () => {
  await save('tyler', { job: id('j'), customer: id('c'), bike: id('b'), b: { make: 'KTM', year: '', mileage: '' } });
  await rejects(save('tyler', { job: id('j'), customer: id('c'), bike: id('b'), b: { year: '20x5' } }), /Year must be a whole number/);
  await rejects(save('tyler', { job: id('j'), customer: id('c'), c: { name: '  ' } }), /Customer name is required/);
  await rejects(save('tyler', { job: id('j'), customer: id('c'), items: [{ kind: 'part', description: 'x', quantity: '1.234', unit_price: '1' }] }), /2 decimal/);
  await rejects(save('tyler', { job: id('j'), customer: id('c'), items: [{ kind: 'fee', description: 'x' }] }), /part or labor/);
  await rejects(save('tyler', { job: id('j'), customer: id('c'), j: { tax_rate: '150' } }), /Tax rate/);
  // a bike already on another customer's record can't be silently moved
  const a = { job: id('j'), customer: id('c'), bike: id('b'), b: { make: 'BMW' } };
  await save('tyler', a);
  await rejects(save('tyler', { job: id('j'), customer: id('c'), bike: a.bike, b: { make: 'BMW' } }), /different customer/);
});

test('database math matches the screen math across many random estimates', { skip }, async () => {
  let seed = 7; const rnd = m => (seed = (seed * 1103515245 + 12345) % 2147483648) % m;
  for (let k = 0; k < 25; k++) {
    const items = Array.from({ length: 1 + rnd(5) }, (_, i) => ({ kind: rnd(2) ? 'part' : 'labor', description: `L${i}`,
      quantity: (1 + rnd(1000)) / 100 + '', unit_price: (rnd(100000) / 100).toFixed(2), unit_cost: (rnd(5000) / 100).toFixed(2) }));
    const tax = { rate: rnd(4) ? (rnd(12000) / 1000).toFixed(3) : '', appliesTo: ['parts', 'parts_labor', 'none'][rnd(3)] };
    const r = await save('tyler', { job: id('j'), customer: id('c'), items, j: { tax_rate: tax.rate, tax_applies_to: tax.appliesTo } });
    const calc = C.calculate(items, tax);
    assert.equal(Number(r.total_amount), calc.total, JSON.stringify({ items, tax }));
    assert.equal(Number(r.tax_amount), calc.tax);
  }
});

test('settings: tax rate starts empty; staff can set it; non-staff cannot', { skip }, async () => {
  const [s0] = await as('tyler', 'select * from public.shop_settings');
  assert.equal(s0.default_tax_rate, null); assert.equal(s0.business_name, 'SIC Cycles');
  await rpc('garrett', 'shop_update_settings', { p_settings: { business_name: 'SIC Cycles', phone: '520-420-4214', default_tax_rate: '8.7', default_tax_applies_to: 'parts' } });
  assert.equal(Number((await as('tyler', 'select default_tax_rate from public.shop_settings'))[0].default_tax_rate), 8.7);
  await rejects(rpc('rider', 'shop_update_settings', { p_settings: { default_tax_rate: '0' } }), /not authorized/);
  await rpc('tyler', 'shop_update_settings', { p_settings: { business_name: 'SIC Cycles', default_tax_rate: '' } }); // back to empty
});

test('non-staff and signed-out users cannot read or change any estimate data', { skip }, async () => {
  const a = { job: id('j'), customer: id('c'), bike: id('b'), b: { make: 'Honda' }, items: ITEMS };
  await save('tyler', a);
  for (const who of ['rider', null]) {
    for (const t of ['shop_jobs', 'shop_job_line_items', 'shop_customers', 'shop_bikes', 'shop_settings']) {
      const rows = await as(who, `select * from public.${t}`).catch(e => e);
      assert.ok(rows instanceof Error ? /permission denied/.test(rows.message) : rows.length === 0, `${who || 'anon'} read ${t}`);
    }
  }
  await rejects(save('rider', { ...a, c: { name: 'Hijack' } }), /not authorized/);
  await rejects(save(null, { ...a, c: { name: 'Hijack' } }), /permission denied|not authorized/);
  await rejects(rpc('rider', 'shop_set_job_status', { p_job_id: a.job, p_status: 'in_progress' }), /not authorized/);
  for (const sqlText of [`update public.shop_jobs set total_amount = 0`, `delete from public.shop_job_line_items`, `insert into public.shop_customers (id, name, created_by, updated_by) values ('x','x','${U.rider}','${U.rider}')`]) {
    await rejects(as('rider', sqlText), /permission denied/);
    await rejects(as('tyler', sqlText), /permission denied/); // even staff only write through the checked functions
  }
  assert.equal((await as('tyler', 'select customer_id from public.shop_jobs where id = $1', [a.job]))[0].customer_id, a.customer);
  assert.equal((await as('tyler', 'select name from public.shop_customers where id = $1', [a.customer]))[0].name, 'Test Customer');
});

test('bike photos are private: only staff can view or upload', { skip }, async () => {
  await db.query(`insert into storage.objects (bucket_id, name) values ('shop-bike-photos', 'b1/p.jpg')`);
  assert.equal((await db.query(`select public from storage.buckets where id = 'shop-bike-photos'`)).rows[0].public, false);
  assert.equal((await as('tyler', `select name from storage.objects where bucket_id = 'shop-bike-photos'`)).length >= 1, true);
  assert.deepEqual(await as('rider', `select name from storage.objects where bucket_id = 'shop-bike-photos'`), []);
  assert.deepEqual(await as(null, `select name from storage.objects where bucket_id = 'shop-bike-photos'`), []);
  await rejects(as('rider', `insert into storage.objects (bucket_id, name) values ('shop-bike-photos', 'evil.jpg')`), /row-level security/);
  await as('garrett', `insert into storage.objects (bucket_id, name) values ('shop-bike-photos', 'b1/q.jpg')`);
});

test('existing jobs get an estimate number when 004 is applied to a database that already has jobs', { skip }, async () => {
  const { PGlite: PG } = await import('@electric-sql/pglite');
  const d2 = new PG();
  await d2.exec(STUB);
  await d2.query('insert into auth.users values ($1, $2)', [U.tyler, 't@x']);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql']) await d2.exec(sql(f));
  await d2.exec(`insert into public.shop_customers (id, name, created_by, updated_by) values ('c1','Old', '${U.tyler}', '${U.tyler}');
    insert into public.shop_jobs (id, customer_id, total_amount, created_by, updated_by) values ('j1','c1', 50, '${U.tyler}', '${U.tyler}'), ('j2','c1', 70, '${U.tyler}', '${U.tyler}');`);
  await d2.exec(sql('2026-10-30-shop-004-estimates.sql'));
  const rows = (await d2.query('select id, estimate_number, total_amount from public.shop_jobs order by id')).rows;
  assert.deepEqual(rows.map(r => [r.id, Number(r.total_amount)]), [['j1', 50], ['j2', 70]]);
  assert.ok(rows.every(r => Number(r.estimate_number) >= 1001));
  assert.notEqual(rows[0].estimate_number, rows[1].estimate_number);
  await d2.close();
});

test('imported invoices keep their numbers; new estimates continue after the highest; edits never skip numbers', { skip }, async () => {
  const { PGlite: PG } = await import('@electric-sql/pglite');
  const old = db; db = new PG();
  try {
    await db.exec(STUB);
    await db.query('insert into auth.users values ($1, $2)', [U.tyler, 't@x']);
    for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql', '2026-10-30-shop-004-estimates.sql']) await db.exec(sql(f));
    await db.query(`insert into public.shop_staff (user_id, display_name) values ($1, 'Tyler')`, [U.tyler]);
    const imp = async (num, job = id('j')) => save('tyler', { job, customer: id('c'), items: ITEMS, j: { estimate_number: String(num), tax_rate: '8.7' } });
    assert.equal(Number((await imp(1036)).estimate_number), 1036);
    assert.equal(Number((await imp(1004)).estimate_number), 1004); // out of order is fine
    await rejects(imp(1036), /Estimate number 1036 is already used/);
    const fresh = { job: id('j'), customer: id('c'), items: ITEMS };
    const r = await save('tyler', fresh);
    assert.equal(Number(r.estimate_number), 1037);
    await save('tyler', fresh); await save('tyler', fresh); // edits
    // an edit cannot renumber an existing job
    await save('tyler', { ...fresh, j: { estimate_number: '5000' } });
    assert.equal(Number((await as('tyler', 'select estimate_number from public.shop_jobs where id = $1', [fresh.job]))[0].estimate_number), 1037);
    assert.equal(Number((await save('tyler', { job: id('j'), customer: id('c') })).estimate_number), 1038);
  } finally { await db.close(); db = old; }
});
