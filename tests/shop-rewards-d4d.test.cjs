// Rewards points + Dollars for Dads (shop-010) database tests. Runs the real
// shop SQL (001-004, 006, 010) in an in-process Postgres (PGlite) with
// Supabase-style roles. Needs PGlite: `npm i --no-save @electric-sql/pglite`.
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
let db; let n = 0;
const id = p => `${p}${++n}x${Date.now().toString(36)}`;

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
const owner = async (text, params) => { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); return (await db.query(text, params)).rows; };

// One job: $200 labor + $100 parts, 8.7% tax on parts -> subtotal 300, tax 8.70, total 308.70.
const ITEMS = [
  { kind: 'part', description: 'Brake pads', quantity: '1', unit_price: '100', unit_cost: '60' },
  { kind: 'labor', description: 'Brake job', quantity: '1', unit_price: '200' },
];
async function newJob(user, customer, { name = 'Rewards Customer', date } = {}) {
  const job = id('j');
  await rpc(user, 'shop_save_estimate', { p_job_id: job, p_customer_id: customer, p_customer: { name },
    p_bike_id: null, p_bike: null, p_job: { tax_rate: '8.7', tax_applies_to: 'parts', ...(date ? { job_date: date } : {}) }, p_items: ITEMS });
  return job;
}
const balance = async (user, c) => (await as(user, 'select * from public.shop_reward_balances where customer_id = $1', [c]))[0];
const pay = (user, job, s) => rpc(user, 'shop_set_payment_status', { p_job_id: job, p_payment_status: s });

before(async () => {
  if (skip) return;
  const { PGlite: PG } = await import('@electric-sql/pglite');
  db = new PG();
  await db.exec(STUB);
  for (const [name, uid] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [uid, `${name}@test.local`]);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
    '2026-10-30-shop-004-estimates.sql', '2026-11-15-shop-006-payment-status.sql']) await db.exec(sql(f));
  await db.query(`insert into public.shop_staff (user_id, display_name) values ($1, 'Tyler'), ($2, 'Garrett')`, [U.tyler, U.garrett]);
  // An invoice that was already paid before the program existed (like the 33 imported ones).
  await rpc('tyler', 'shop_save_estimate', { p_job_id: 'old-job', p_customer_id: 'old-cust', p_customer: { name: 'Old Customer' },
    p_bike_id: null, p_bike: null, p_job: { job_date: '2026-03-01' }, p_items: ITEMS });
  await pay('tyler', 'old-job', 'paid');
  await db.exec(sql('2026-11-21-shop-010-rewards-d4d.sql'));
  await db.exec(sql('2026-11-21-shop-010-rewards-d4d.sql')); // re-running is safe
});

// ---------------------------------------------------------------- rewards
test('rewards: a rider (non-staff) and signed-out users see nothing and can change nothing', { skip }, async () => {
  for (const who of ['rider', null]) {
    for (const t of ['shop_reward_entries', 'shop_reward_balances', 'shop_d4d_donations', 'shop_d4d_donor_totals', 'shop_d4d_campaign_summary', 'shop_d4d_prizes_given']) {
      const rows = await as(who, `select * from public.${t}`).catch(e => e);
      assert.ok(rows instanceof Error ? /permission denied/.test(rows.message) : rows.length === 0, `${who || 'anon'} sees ${t}`);
    }
  }
  await assert.rejects(rpc('rider', 'shop_rewards_adjust', { p_entry_id: 'x', p_customer_id: 'old-cust', p_points: 50, p_note: 'hack' }), /not authorized/);
  await assert.rejects(rpc('rider', 'shop_d4d_save_donation', { p_id: 'x', p_d: { donor_name: 'X', amount: '5' } }), /not authorized/);
  await assert.rejects(rpc(null, 'shop_rewards_redeem', { p_entry_id: 'x', p_customer_id: 'old-cust', p_points: 1, p_job_id: null, p_note: null }), /permission denied/);
  for (const who of ['tyler', 'garrett']) {
    await assert.rejects(as(who, `insert into public.shop_reward_entries (id, customer_id, kind, points, note) values ('z', 'old-cust', 'adjust', 999, 'x')`), /permission denied/);
    await assert.rejects(as(who, `update public.shop_d4d_donations set amount = 1`), /permission denied/);
    await assert.rejects(as(who, `delete from public.shop_reward_entries`), /permission denied/);
  }
});

test('rewards: defaults are on, 1 point per $1, 100 points = $5, and jobs paid before the program earn nothing', { skip }, async () => {
  const [s] = await owner('select * from public.shop_settings where id = 1');
  assert.equal(s.rewards_enabled, true); assert.equal(Number(s.rewards_points_per_dollar), 1); assert.equal(Number(s.rewards_point_value_cents), 5);
  assert.equal((await balance('tyler', 'old-cust')).balance, 0);
});

test('rewards: marking a job Paid earns points on the total before tax, once; unpaid takes them back', { skip }, async () => {
  const c = id('c'); const job = await newJob('garrett', c);
  const [j] = await owner('select total_amount, tax_amount from public.shop_jobs where id = $1', [job]);
  assert.equal(Number(j.total_amount), 308.7); assert.equal(Number(j.tax_amount), 8.7);
  assert.equal((await balance('tyler', c)).balance, 0, 'an estimate earns nothing');
  await pay('garrett', job, 'partial');
  assert.equal((await balance('tyler', c)).balance, 0, 'part paid earns nothing');
  await pay('garrett', job, 'paid');
  assert.equal((await balance('tyler', c)).balance, 300);
  await pay('garrett', job, 'paid'); await pay('tyler', job, 'paid');
  assert.equal((await balance('tyler', c)).balance, 300, 'paid twice still earns once');
  await pay('tyler', job, 'unpaid');
  assert.equal((await balance('tyler', c)).balance, 0, 'moved back to unpaid takes the points back');
  await pay('tyler', job, 'paid');
  const b = await balance('tyler', c);
  assert.equal(b.balance, 300); assert.equal(b.points_earned, 300); assert.equal(Number(b.balance_value), 15);
  const entries = await as('tyler', 'select kind, points, created_by from public.shop_reward_entries where job_id = $1 order by created_at, id', [job]);
  assert.deepEqual(entries.map(e => [e.kind, e.points]).sort(), [['earn', 300], ['earn', 300], ['reverse', -300]].sort());
  assert.ok(entries.every(e => e.created_by === U.garrett || e.created_by === U.tyler), 'who marked it is recorded');
  const log = await as('tyler', `select count(*)::int as n from public.shop_audit_log where table_name = 'shop_reward_entries'`);
  assert.ok(log[0].n >= 3);
});

test('rewards: changing a paid job\'s total corrects the points', { skip }, async () => {
  const c = id('c'); const job = await newJob('tyler', c);
  await pay('tyler', job, 'paid');
  const [j] = await owner('select updated_at from public.shop_jobs where id = $1', [job]);
  await rpc('tyler', 'shop_save_estimate', { p_job_id: job, p_customer_id: c, p_customer: { name: 'Rewards Customer' }, p_bike_id: null, p_bike: null,
    p_job: { tax_rate: '8.7', tax_applies_to: 'parts', expected_updated_at: j.updated_at },
    p_items: [{ kind: 'labor', description: 'Brake job', quantity: '1', unit_price: '150' }] });
  assert.equal((await balance('tyler', c)).balance, 150);
});

test('rewards: redeem takes points off, never more than the balance, and a double tap only counts once', { skip }, async () => {
  const c = id('c'); const job = await newJob('tyler', c); await pay('tyler', job, 'paid');
  const e = id('r');
  const r = await rpc('garrett', 'shop_rewards_redeem', { p_entry_id: e, p_customer_id: c, p_points: 100, p_job_id: job, p_note: 'Took $5 off' });
  assert.equal(r.balance, 200); assert.equal(Number(r.dollar_value), 5);
  const again = await rpc('garrett', 'shop_rewards_redeem', { p_entry_id: e, p_customer_id: c, p_points: 100, p_job_id: job, p_note: 'Took $5 off' });
  assert.equal(again.repeat, true);
  assert.equal((await balance('tyler', c)).balance, 200);
  assert.equal((await balance('tyler', c)).points_redeemed, 100);
  await assert.rejects(rpc('garrett', 'shop_rewards_redeem', { p_entry_id: id('r'), p_customer_id: c, p_points: 201, p_job_id: null, p_note: null }), /Only 200 points available/);
  await assert.rejects(rpc('garrett', 'shop_rewards_redeem', { p_entry_id: id('r'), p_customer_id: c, p_points: 0, p_job_id: null, p_note: null }), /more than 0/);
  await assert.rejects(rpc('garrett', 'shop_rewards_redeem', { p_entry_id: id('r'), p_customer_id: c, p_points: 5, p_job_id: 'old-job', p_note: null }), /not this customer/);
  await assert.rejects(rpc('garrett', 'shop_rewards_redeem', { p_entry_id: e, p_customer_id: c, p_points: 50, p_job_id: null, p_note: null }), /already used/);
});

test('rewards: adjust needs a reason and can\'t push a balance below zero', { skip }, async () => {
  const c = id('c'); await newJob('tyler', c);
  await assert.rejects(rpc('tyler', 'shop_rewards_adjust', { p_entry_id: id('a'), p_customer_id: c, p_points: 50, p_note: ' ' }), /Say why/);
  const r = await rpc('tyler', 'shop_rewards_adjust', { p_entry_id: id('a'), p_customer_id: c, p_points: 50, p_note: 'Sign-up bonus' });
  assert.equal(r.balance, 50);
  await assert.rejects(rpc('tyler', 'shop_rewards_adjust', { p_entry_id: id('a'), p_customer_id: c, p_points: -51, p_note: 'Fix' }), /would leave -1/);
  await assert.rejects(rpc('tyler', 'shop_rewards_adjust', { p_entry_id: id('a'), p_customer_id: 'nobody', p_points: 5, p_note: 'x' }), /Customer not found/);
});

test('rewards: settings change the earn rate; turning rewards off stops new points; backfill gives old paid jobs points once', { skip }, async () => {
  await rpc('tyler', 'shop_update_reward_settings', { p_settings: { rewards_points_per_dollar: '2' } });
  const c = id('c'); const job = await newJob('tyler', c); await pay('tyler', job, 'paid');
  assert.equal((await balance('tyler', c)).balance, 600);
  await rpc('tyler', 'shop_update_reward_settings', { p_settings: { rewards_points_per_dollar: '1', rewards_enabled: false } });
  const c2 = id('c'); const job2 = await newJob('tyler', c2); await pay('tyler', job2, 'paid');
  assert.equal((await balance('tyler', c2)).balance, 0, 'off = no new points');
  await assert.rejects(rpc('tyler', 'shop_update_reward_settings', { p_settings: { rewards_points_per_dollar: 'lots' } }), /must be a number/);
  await assert.rejects(rpc('tyler', 'shop_update_reward_settings', { p_settings: { rewards_point_value_cents: '500' } }), /check/);
  await rpc('tyler', 'shop_update_reward_settings', { p_settings: { rewards_enabled: true } });
  const r = await rpc('tyler', 'shop_rewards_backfill', { p_from: '2026-01-01' });
  assert.ok(r.jobs >= 2, 'old-job and job2 get their points');
  assert.equal((await balance('tyler', 'old-cust')).balance, 300);
  assert.equal((await balance('tyler', c2)).balance, 300);
  const r2 = await rpc('tyler', 'shop_rewards_backfill', { p_from: '2026-01-01' });
  assert.equal(r2.jobs, 0, 'running it twice gives nothing twice');
  await assert.rejects(rpc('rider', 'shop_rewards_backfill', { p_from: '2026-01-01' }), /not authorized/);
});

test('rewards: importing an old paid invoice in the SQL editor does not award points', { skip }, async () => {
  await owner(`insert into public.shop_customers (id, name, created_by, updated_by) values ('imp-c', 'Imported', '00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000001')`);
  await owner(`insert into public.shop_jobs (id, invoice_number, customer_id, status, payment_status, job_date, total_amount, created_by, updated_by)
               values ('imp-j', 'IMP-1', 'imp-c', 'complete', 'paid', '2025-06-01', 500, '00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000001')`);
  assert.equal((await balance('tyler', 'imp-c')).balance, 0);
});

// ---------------------------------------------------------- Dollars for Dads
const D = (amount, extra = {}) => ({ donor_name: 'Dana Donor', donor_email: 'Dana@Example.com', amount: String(amount), donated_on: '2026-11-21', ...extra });

test('D4D: donations add up per donor; raffle entries are 1 per dollar; tiers at $20, $50 and $100', { skip }, async () => {
  const a = id('d'); const b = id('d'); const c = id('d');
  await rpc('garrett', 'shop_d4d_save_donation', { p_id: a, p_d: D(10, { method: 'Cash' }) });
  let [t] = await as('tyler', `select * from public.shop_d4d_donor_totals where donor_key = 'e:dana@example.com'`);
  assert.equal(t.raffle_entries, 10); assert.equal(t.earned_gaiter, false);
  await rpc('garrett', 'shop_d4d_save_donation', { p_id: b, p_d: D(15, { donor_email: ' dana@example.com ' }) });
  [t] = await as('tyler', `select * from public.shop_d4d_donor_totals where donor_key = 'e:dana@example.com'`);
  assert.equal(Number(t.total), 25); assert.equal(t.donations, 2); assert.equal(t.raffle_entries, 25);
  assert.equal(t.earned_gaiter, true); assert.equal(t.earned_shirt, false);
  await rpc('garrett', 'shop_d4d_save_donation', { p_id: c, p_d: D(80.5) });
  [t] = await as('tyler', `select * from public.shop_d4d_donor_totals where donor_key = 'e:dana@example.com'`);
  assert.equal(Number(t.total), 105.5); assert.equal(t.raffle_entries, 105);
  assert.equal(t.earned_shirt, true); assert.equal(t.earned_vest_entry, true); assert.equal(t.over_75_disclosure, true);
  // Double tap: same id saves once.
  await rpc('garrett', 'shop_d4d_save_donation', { p_id: c, p_d: D(80.5) });
  [t] = await as('tyler', `select * from public.shop_d4d_donor_totals where donor_key = 'e:dana@example.com'`);
  assert.equal(t.donations, 3);
});

test('D4D: bad amounts and missing names are refused with a clear reason', { skip }, async () => {
  await assert.rejects(rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: D(0) }), /more than \$0/);
  await assert.rejects(rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: D(-5) }), /more than \$0/);
  await assert.rejects(rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: D('ten') }), /must be a number/);
  await assert.rejects(rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: D('1.005') }), /2 decimals/);
  await assert.rejects(rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: D(5, { donor_name: '' }) }), /Donor name is required/);
  await assert.rejects(rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: D(5, { donated_on: '2099-01-01' }) }), /future/);
  await assert.rejects(rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: D(5, { donated_on: 'soon' }) }), /valid date/);
});

test('D4D: a Shopify order can only be counted once', { skip }, async () => {
  await rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: D(25, { donor_name: 'Web Donor', donor_email: 'web@example.com', shopify_order: '#2001' }) });
  await assert.rejects(rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: D(25, { donor_name: 'Web Donor', shopify_order: '#2001' }) }), /already recorded/);
  const [row] = await as('tyler', `select source from public.shop_d4d_donations where shopify_order = '#2001'`);
  assert.equal(row.source, 'shopify');
});

test('D4D: forwarding to ManUp is tracked, locks the donation, and the summary splits sent vs not sent', { skip }, async () => {
  const camp = 'TEST campaign'; const ids = [id('d'), id('d'), id('d')];
  for (const [i, amt] of [[0, 20], [1, 30], [2, 50]]) await rpc('tyler', 'shop_d4d_save_donation', { p_id: ids[i], p_d: D(amt, { campaign: camp, donor_email: `p${i}@example.com` }) });
  await assert.rejects(rpc('tyler', 'shop_d4d_mark_forwarded', { p_ids: JSON.stringify([ids[0]]), p_forwarded_on: '2026-11-21', p_ref: '' }), /reference/);
  const f = await rpc('tyler', 'shop_d4d_mark_forwarded', { p_ids: JSON.stringify([ids[0], ids[1]]), p_forwarded_on: '2026-11-21', p_ref: 'Check 1001' });
  assert.equal(f.count, 2); assert.equal(Number(f.amount), 50);
  const again = await rpc('tyler', 'shop_d4d_mark_forwarded', { p_ids: JSON.stringify([ids[0]]), p_forwarded_on: '2026-11-21', p_ref: 'Check 1001' });
  assert.equal(again.count, 0, 'already sent is not sent twice');
  await assert.rejects(rpc('tyler', 'shop_d4d_save_donation', { p_id: ids[0], p_d: D(999, { campaign: camp }) }), /already sent to ManUp/);
  let [s] = await as('garrett', 'select * from public.shop_d4d_campaign_summary where campaign = $1', [camp]);
  assert.equal(Number(s.total_raised), 100); assert.equal(Number(s.forwarded), 50); assert.equal(Number(s.not_forwarded), 50); assert.equal(s.donors, 3);
  // Refund one that was sent and one that wasn't: both drop out of the totals, and the sent one is flagged.
  await assert.rejects(rpc('tyler', 'shop_d4d_refund', { p_id: ids[1], p_reason: '' }), /Say why/);
  const r1 = await rpc('tyler', 'shop_d4d_refund', { p_id: ids[1], p_reason: 'Card charged back' });
  assert.equal(r1.was_forwarded, true);
  await rpc('tyler', 'shop_d4d_refund', { p_id: ids[2], p_reason: 'Asked for it back' });
  [s] = await as('garrett', 'select * from public.shop_d4d_campaign_summary where campaign = $1', [camp]);
  assert.equal(Number(s.total_raised), 20); assert.equal(Number(s.forwarded), 20); assert.equal(Number(s.not_forwarded), 0);
  assert.equal(Number(s.refunded), 80); assert.equal(Number(s.refunded_after_forwarding), 30);
  const still = await as('tyler', 'select count(*)::int as n from public.shop_d4d_donations where campaign = $1', [camp]);
  assert.equal(still[0].n, 3, 'refunds are marked, never deleted');
  const f2 = await rpc('tyler', 'shop_d4d_mark_forwarded', { p_ids: JSON.stringify([ids[2]]), p_forwarded_on: null, p_ref: 'x' });
  assert.equal(f2.count, 0, 'a refunded donation is never sent');
});

test('D4D: prizes can only be handed out once a donor reaches that tier, and only once', { skip }, async () => {
  const camp = 'TEST prizes';
  await rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: D(20, { campaign: camp, donor_email: 'gaiter@example.com' }) });
  const key = 'e:gaiter@example.com';
  await assert.rejects(rpc('tyler', 'shop_d4d_give_prize', { p_campaign: camp, p_donor_key: key, p_item: 'shirt', p_note: null }), /hasn't reached/);
  await rpc('tyler', 'shop_d4d_give_prize', { p_campaign: camp, p_donor_key: key, p_item: 'gaiter', p_note: 'Handed at counter' });
  await rpc('tyler', 'shop_d4d_give_prize', { p_campaign: camp, p_donor_key: key, p_item: 'gaiter', p_note: null });
  const given = await as('tyler', 'select * from public.shop_d4d_prizes_given where campaign = $1', [camp]);
  assert.equal(given.length, 1); assert.equal(given[0].given_by, U.tyler);
  const [t] = await as('tyler', 'select given_gaiter from public.shop_d4d_donor_totals where campaign = $1', [camp]);
  assert.equal(t.given_gaiter, true);
  await rpc('tyler', 'shop_d4d_undo_prize', { p_campaign: camp, p_donor_key: key, p_item: 'gaiter', p_reason: 'Wrong person' });
  assert.equal((await as('tyler', 'select * from public.shop_d4d_prizes_given where campaign = $1', [camp])).length, 0);
});

test('D4D: a donation can be linked to a shop customer, and several gifts from that customer add up', { skip }, async () => {
  const c = id('c'); await newJob('tyler', c, { name: 'Linked Donor' });
  const camp = 'TEST linked';
  await rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: { campaign: camp, customer_id: c, amount: '30' } });
  await rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: { campaign: camp, customer_id: c, amount: '25', donor_email: 'other@example.com' } });
  const rows = await as('tyler', 'select * from public.shop_d4d_donor_totals where campaign = $1', [camp]);
  assert.equal(rows.length, 1); assert.equal(rows[0].donor_name, 'Linked Donor'); assert.equal(Number(rows[0].total), 55); assert.equal(rows[0].earned_shirt, true);
  await assert.rejects(rpc('tyler', 'shop_d4d_save_donation', { p_id: id('d'), p_d: { customer_id: 'nobody', amount: '5' } }), /Customer not found/);
});

// ------------------------------------------------------------------ legacy
test('legacy: the two old functions that could wipe invoice money are switched off for app accounts', { skip }, async () => {
  for (const who of ['tyler', 'garrett']) {
    await assert.rejects(as(who, `select * from public.shop_submit_estimate(null, null, '{"name":"x"}'::jsonb, null, null, '{}'::jsonb)`), /permission denied/);
    await assert.rejects(as(who, `select public.shop_set_job_line_items('old-job', '[]'::jsonb)`), /permission denied/);
  }
  const [j] = await owner(`select total_amount from public.shop_jobs where id = 'old-job'`);
  assert.equal(Number(j.total_amount), 300, 'old job untouched');
});

test('rollback file removes everything shop-010 added and gives the old functions back', { skip }, async () => {
  const { PGlite: PG } = await import('@electric-sql/pglite');
  const fresh = new PG();
  await fresh.exec(STUB);
  for (const f of ['2026-10-04-shop-001-core.sql', '2026-10-04-shop-002-writes.sql', '2026-10-04-shop-003-storage.sql',
    '2026-10-30-shop-004-estimates.sql', '2026-11-15-shop-006-payment-status.sql', '2026-11-21-shop-010-rewards-d4d.sql',
    '2026-11-21-shop-010-rewards-d4d-rollback.sql']) await fresh.exec(sql(f));
  const left = (await fresh.query(`select table_name from information_schema.tables where table_schema = 'public' and (table_name like 'shop_reward%' or table_name like 'shop_d4d%')`)).rows;
  assert.deepEqual(left, []);
  await fresh.exec(sql('2026-11-21-shop-010-rewards-d4d.sql')); // and it can be applied again
  await fresh.close();
});
