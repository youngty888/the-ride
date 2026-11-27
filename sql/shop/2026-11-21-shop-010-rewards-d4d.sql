-- shop-010: rewards points and Dollars for Dads (D4D) donation ledger.
-- Requires shop-001..004 and 006. Independent of shop-007, 008 and 009.
-- ADDITIVE ONLY: new tables, views, functions and one trigger, plus four new
-- columns on shop_settings. Nothing existing is dropped or rewritten, except
-- that two old functions the app no longer uses are switched off for the app
-- (see LEGACY at the end). Safe to re-run.
-- NOT yet run on the live database: Tyler runs it in his server's SQL editor.
--
-- REWARDS POINTS
--   * One ledger, shop_reward_entries. Points are never typed into a balance;
--     the balance is the sum of the ledger, so it can always be explained.
--   * A customer earns points automatically when a job is marked Paid:
--     points = floor(job total before tax x points per dollar). If the job is
--     moved back to Unpaid/Part paid, or its total changes, a matching entry
--     corrects it. A job can never earn twice.
--   * Only jobs dated on or after rewards_start_date earn, so imported old
--     invoices don't flood the program. rewards_start_date starts as the day
--     this file is first run.
--   * Points NEVER turn into cash (Tyler, Nov 27). They redeem only for an item
--     on the rewards list, shop_reward_catalog: a prize (merch, gear) or a
--     discount (e.g. 10% off labor on one job), each with a points cost. Staff
--     add, change or switch off items on the Rewards page; items are never
--     deleted, so history keeps its meaning.
--   * Redeem: staff pick a reward; its points come off (never more than the
--     balance) and the reward's name is kept on the entry. Adjust: staff add or
--     remove points with a required reason. No entry can be edited or deleted.
--   Defaults (change them in shop_settings or the Rewards page):
--     1 point per $1 spent before tax, program on, empty rewards list.
--
-- DOLLARS FOR DADS (ManUp Movement Inc. fundraiser; SIC Cycles sponsors prizes)
--   * shop_d4d_donations: every donation, from the shop counter, an event, or a
--     Shopify order (shopify_order is unique, so an order can't be counted twice).
--   * Raffle entries: 1 per whole dollar a donor has given in the campaign.
--   * Tier prizes, by the donor's campaign total: $20+ neck gaiter, $50+
--     t-shirt, $100+ entry into the AZ Edition vest drawing. Handing a prize
--     out is recorded once per donor per item (shop_d4d_prizes_given).
--   * Forwarding: each donation tracks when it was passed on to ManUp and the
--     reference (check no., transfer id). Edits are refused once forwarded.
--   * Refunds are marked, never deleted, and drop out of every total.
--   * Flags any single donation over $75 (the plan's quid pro quo disclosure
--     note). This file gives no tax advice; it only flags.

-- ===================== SETTINGS =====================
alter table public.shop_settings add column if not exists rewards_enabled boolean not null default true;
alter table public.shop_settings add column if not exists rewards_points_per_dollar numeric(8,3) not null default 1;
alter table public.shop_settings add column if not exists rewards_start_date date not null default current_date;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shop_settings_rewards_rate_check') then
    alter table public.shop_settings add constraint shop_settings_rewards_rate_check
      check (rewards_points_per_dollar >= 0 and rewards_points_per_dollar <= 100);
  end if;
end $$;

-- ===================== REWARDS LIST (what points can be used for) =====================
create table if not exists public.shop_reward_catalog (
  id text primary key,
  name text not null check (btrim(name) <> ''),
  kind text not null check (kind in ('prize','discount')),
  points_cost integer not null check (points_cost > 0 and points_cost <= 1000000),
  details text,                          -- e.g. "10% off labor on one job, max one per visit"
  active boolean not null default true,  -- off = hidden from the redeem list, history kept
  sort_order integer not null default 0,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);
alter table public.shop_reward_catalog enable row level security;
drop policy if exists "Staff can view rewards list" on public.shop_reward_catalog;
create policy "Staff can view rewards list" on public.shop_reward_catalog
  for select using (public.shop_has_staff_access());
revoke all on public.shop_reward_catalog from public, anon, authenticated;
grant select on public.shop_reward_catalog to authenticated;

-- Add or change one reward. p_id is made by the app for a new item.
create or replace function public.shop_save_reward_item(p_id text, p_item jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_name text; v_kind text; v_cost numeric; v_new boolean;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if shop_clean(p_id) is null then raise exception 'Missing reward id'; end if;
  v_name := shop_clean(p_item->>'name');
  if v_name is null then raise exception 'Give the reward a name'; end if;
  v_kind := coalesce(shop_clean(p_item->>'kind'), 'prize');
  if v_kind not in ('prize','discount') then raise exception 'A reward is a prize or a discount'; end if;
  v_cost := shop_num(p_item->>'points_cost', 'Points cost', null);
  if v_cost is null or v_cost <> trunc(v_cost) or v_cost <= 0 or v_cost > 1000000 then
    raise exception 'Points cost must be a whole number above 0';
  end if;
  v_new := not exists (select 1 from public.shop_reward_catalog where id = p_id);
  insert into public.shop_reward_catalog (id, name, kind, points_cost, details, active, sort_order, created_by, updated_by)
  values (p_id, v_name, v_kind, v_cost::integer, shop_clean(p_item->>'details'),
          coalesce((p_item->>'active')::boolean, true), coalesce((p_item->>'sort_order')::integer, 0), v_uid, v_uid)
  on conflict (id) do update set name = excluded.name, kind = excluded.kind, points_cost = excluded.points_cost,
    details = excluded.details, active = coalesce((p_item->>'active')::boolean, shop_reward_catalog.active),
    sort_order = coalesce((p_item->>'sort_order')::integer, shop_reward_catalog.sort_order),
    updated_at = now(), updated_by = v_uid;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_reward_catalog', p_id, case when v_new then 'insert' else 'update' end, v_uid, p_item);
  return jsonb_build_object('id', p_id);
end $$;

-- ===================== REWARDS LEDGER =====================
create table if not exists public.shop_reward_entries (
  id text primary key,
  customer_id text not null references public.shop_customers(id),
  kind text not null check (kind in ('earn','reverse','redeem','adjust')),
  points integer not null check (points <> 0),
  job_id text references public.shop_jobs(id),
  reward_id text references public.shop_reward_catalog(id),  -- redeem only: what the points were used for
  reward_name text,                     -- redeem only: the reward's name at the time
  note text,
  created_at timestamptz not null default now(),
  created_by uuid,                      -- null = written by the database itself (job paid in SQL editor)
  check ((kind = 'earn' and points > 0) or (kind = 'reverse' and points < 0)
         or (kind = 'redeem' and points < 0) or kind = 'adjust'),
  check (kind not in ('earn','reverse') or job_id is not null),
  check (kind <> 'adjust' or nullif(btrim(note), '') is not null),
  check (kind <> 'redeem' or reward_id is not null)
);
create index if not exists shop_reward_entries_customer_idx on public.shop_reward_entries (customer_id, created_at);
create index if not exists shop_reward_entries_job_idx on public.shop_reward_entries (job_id);

alter table public.shop_reward_entries enable row level security;
drop policy if exists "Staff can view reward entries" on public.shop_reward_entries;
create policy "Staff can view reward entries" on public.shop_reward_entries
  for select using (public.shop_has_staff_access());
revoke all on public.shop_reward_entries from public, anon, authenticated;
grant select on public.shop_reward_entries to authenticated;

create or replace view public.shop_reward_balances
with (security_invoker = true) as
select c.id as customer_id, c.name, c.phone, c.email,
  coalesce(sum(e.points) filter (where e.kind in ('earn','reverse')), 0)::integer as points_earned,
  coalesce(-sum(e.points) filter (where e.kind = 'redeem'), 0)::integer as points_redeemed,
  coalesce(sum(e.points) filter (where e.kind = 'adjust'), 0)::integer as points_adjusted,
  coalesce(sum(e.points), 0)::integer as balance,
  max(e.created_at) as last_activity
from public.shop_customers c
left join public.shop_reward_entries e on e.customer_id = c.id
group by c.id, c.name, c.phone, c.email;
revoke all on public.shop_reward_balances from public, anon, authenticated;
grant select on public.shop_reward_balances to authenticated;

-- Points a job should hold right now (0 if not paid / not eligible).
create or replace function public.shop_rewards_target(p_job public.shop_jobs)
returns integer language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare s public.shop_settings%rowtype;
begin
  select * into s from public.shop_settings where id = 1;
  if p_job.payment_status <> 'paid' then return 0; end if;
  if p_job.job_date is not null and p_job.job_date < s.rewards_start_date then return 0; end if;
  return greatest(0, floor(greatest(coalesce(p_job.total_amount, 0) - coalesce(p_job.tax_amount, 0), 0)
                           * s.rewards_points_per_dollar))::integer;
end $$;
revoke all on function public.shop_rewards_target(public.shop_jobs) from public, anon, authenticated;

-- Trigger: keeps each job's earned points equal to its target.
create or replace function public.shop_rewards_sync_job()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_on boolean; v_target integer; v_have integer; v_diff integer; v_uid uuid := auth.uid(); v_id text;
begin
  select rewards_enabled into v_on from public.shop_settings where id = 1;
  if not coalesce(v_on, false) then return new; end if;
  -- Only act when something that affects points changed.
  if tg_op = 'UPDATE' and old.payment_status is not distinct from new.payment_status
     and old.total_amount is not distinct from new.total_amount
     and old.tax_amount is not distinct from new.tax_amount
     and old.job_date is not distinct from new.job_date
     and old.customer_id is not distinct from new.customer_id then
    return new;
  end if;
  -- If the job moved to another customer, take the points back from the old one first.
  if tg_op = 'UPDATE' and old.customer_id is distinct from new.customer_id then
    select coalesce(sum(points), 0) into v_have from public.shop_reward_entries
      where job_id = new.id and customer_id = old.customer_id and kind in ('earn','reverse');
    if v_have <> 0 then
      v_id := replace(gen_random_uuid()::text, '-', '');
      insert into public.shop_reward_entries (id, customer_id, kind, points, job_id, note, created_by)
      values (v_id, old.customer_id, 'reverse', -v_have, new.id, 'Job moved to another customer', v_uid);
    end if;
  end if;
  v_target := public.shop_rewards_target(new);
  select coalesce(sum(points), 0) into v_have from public.shop_reward_entries
    where job_id = new.id and customer_id = new.customer_id and kind in ('earn','reverse');
  v_diff := v_target - v_have;
  if v_diff <> 0 then
    v_id := replace(gen_random_uuid()::text, '-', '');
    insert into public.shop_reward_entries (id, customer_id, kind, points, job_id, note, created_by)
    values (v_id, new.customer_id, case when v_diff > 0 then 'earn' else 'reverse' end, v_diff, new.id,
      case when v_diff > 0 then 'Job paid' when v_target = 0 then 'Job no longer marked paid' else 'Job total changed' end,
      v_uid);
    if v_uid is not null then
      insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
      values ('shop_reward_entries', v_id, 'auto', v_uid, jsonb_build_object('job_id', new.id, 'points', v_diff));
    end if;
  end if;
  return new;
end $$;
revoke all on function public.shop_rewards_sync_job() from public, anon, authenticated;
drop trigger if exists shop_jobs_rewards_sync on public.shop_jobs;
create trigger shop_jobs_rewards_sync after insert or update on public.shop_jobs
  for each row execute function public.shop_rewards_sync_job();

create or replace function public.shop_reward_balance(p_customer_id text)
returns integer language sql stable security definer set search_path = public, pg_temp
as $$ select coalesce(sum(points), 0)::integer from public.shop_reward_entries where customer_id = p_customer_id $$;
revoke all on function public.shop_reward_balance(text) from public, anon, authenticated;

-- Use points on one reward from the list. p_entry_id is made by the app when
-- the form opens, so a double tap returns the first result instead of taking
-- points twice. Points never turn into cash: there is no other way to spend them.
drop function if exists public.shop_rewards_redeem(text, text, integer, text, text);  -- early draft, cash value
create or replace function public.shop_rewards_redeem(p_entry_id text, p_customer_id text, p_reward_id text,
  p_job_id text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_bal integer; r public.shop_reward_catalog%rowtype; v_prev public.shop_reward_entries%rowtype;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if shop_clean(p_entry_id) is null then raise exception 'Missing entry id'; end if;
  select * into v_prev from public.shop_reward_entries where id = p_entry_id;
  if found then
    if v_prev.kind <> 'redeem' or v_prev.customer_id <> p_customer_id or v_prev.reward_id is distinct from p_reward_id then
      raise exception 'That entry id was already used for something else';
    end if;
    return jsonb_build_object('entry_id', v_prev.id, 'balance', shop_reward_balance(p_customer_id), 'repeat', true);
  end if;
  select * into r from public.shop_reward_catalog where id = p_reward_id;
  if not found then raise exception 'Pick a reward from the list'; end if;
  if not r.active then raise exception 'That reward is switched off'; end if;
  perform 1 from public.shop_customers where id = p_customer_id for update;  -- one redeem at a time per customer
  if not found then raise exception 'Customer not found'; end if;
  if p_job_id is not null and not exists (select 1 from public.shop_jobs where id = p_job_id and customer_id = p_customer_id) then
    raise exception 'That job is not this customer''s';
  end if;
  v_bal := shop_reward_balance(p_customer_id);
  if r.points_cost > v_bal then raise exception 'Needs % points, only % available', r.points_cost, v_bal; end if;
  insert into public.shop_reward_entries (id, customer_id, kind, points, job_id, reward_id, reward_name, note, created_by)
  values (p_entry_id, p_customer_id, 'redeem', -r.points_cost, p_job_id, r.id, r.name, shop_clean(p_note), v_uid);
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_reward_entries', p_entry_id, 'redeem', v_uid,
          jsonb_build_object('customer_id', p_customer_id, 'reward_id', r.id, 'points', r.points_cost));
  return jsonb_build_object('entry_id', p_entry_id, 'balance', v_bal - r.points_cost, 'reward', r.name);
end $$;

-- Add or remove points by hand, with a reason (e.g. sign-up bonus, correction).
create or replace function public.shop_rewards_adjust(p_entry_id text, p_customer_id text, p_points integer, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_bal integer;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if shop_clean(p_entry_id) is null then raise exception 'Missing entry id'; end if;
  if exists (select 1 from public.shop_reward_entries where id = p_entry_id) then
    return jsonb_build_object('entry_id', p_entry_id, 'balance', shop_reward_balance(p_customer_id), 'repeat', true);
  end if;
  if p_points is null or p_points = 0 then raise exception 'Points must not be 0'; end if;
  if abs(p_points) > 100000 then raise exception 'That is too many points for one change'; end if;
  if shop_clean(p_note) is null then raise exception 'Say why the points are changing'; end if;
  perform 1 from public.shop_customers where id = p_customer_id for update;
  if not found then raise exception 'Customer not found'; end if;
  v_bal := shop_reward_balance(p_customer_id);
  if v_bal + p_points < 0 then raise exception 'That would leave % points (balance is %)', v_bal + p_points, v_bal; end if;
  insert into public.shop_reward_entries (id, customer_id, kind, points, note, created_by)
  values (p_entry_id, p_customer_id, 'adjust', p_points, shop_clean(p_note), v_uid);
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_reward_entries', p_entry_id, 'adjust', v_uid, jsonb_build_object('customer_id', p_customer_id, 'points', p_points));
  return jsonb_build_object('entry_id', p_entry_id, 'balance', v_bal + p_points);
end $$;

create or replace function public.shop_update_reward_settings(p_settings jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); s public.shop_settings%rowtype;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  update public.shop_settings set
    rewards_enabled = coalesce((p_settings->>'rewards_enabled')::boolean, rewards_enabled),
    rewards_points_per_dollar = shop_num(p_settings->>'rewards_points_per_dollar', 'Points per dollar', rewards_points_per_dollar),
    rewards_start_date = coalesce(nullif(p_settings->>'rewards_start_date', '')::date, rewards_start_date),
    updated_at = now(), updated_by = v_uid
  where id = 1 returning * into s;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_settings', '1', 'rewards_settings', v_uid, p_settings);
  return jsonb_build_object('rewards_enabled', s.rewards_enabled, 'rewards_points_per_dollar', s.rewards_points_per_dollar,
    'rewards_start_date', s.rewards_start_date);
end $$;

-- Award points for jobs that were already Paid before the program existed,
-- from a chosen date. Staff choose to run it; it is safe to run twice.
create or replace function public.shop_rewards_backfill(p_from date)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); j public.shop_jobs%rowtype; v_target integer; v_have integer; n integer := 0; pts integer := 0; v_id text;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_from is null then raise exception 'Pick a start date'; end if;
  update public.shop_settings set rewards_start_date = least(rewards_start_date, p_from), updated_at = now(), updated_by = v_uid where id = 1;
  for j in select * from public.shop_jobs where payment_status = 'paid' and job_date >= p_from loop
    v_target := public.shop_rewards_target(j);
    select coalesce(sum(points), 0) into v_have from public.shop_reward_entries
      where job_id = j.id and customer_id = j.customer_id and kind in ('earn','reverse');
    if v_target - v_have > 0 then
      v_id := replace(gen_random_uuid()::text, '-', '');
      insert into public.shop_reward_entries (id, customer_id, kind, points, job_id, note, created_by)
      values (v_id, j.customer_id, 'earn', v_target - v_have, j.id, 'Points for an earlier paid job', v_uid);
      n := n + 1; pts := pts + v_target - v_have;
    end if;
  end loop;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_reward_entries', 'backfill', 'backfill', v_uid, jsonb_build_object('from', p_from, 'jobs', n, 'points', pts));
  return jsonb_build_object('jobs', n, 'points', pts);
end $$;

-- ===================== DOLLARS FOR DADS =====================
create table if not exists public.shop_d4d_donations (
  id text primary key,
  campaign text not null default 'Dollars for Dads 2026',
  customer_id text references public.shop_customers(id),
  donor_name text not null check (btrim(donor_name) <> ''),
  donor_email text,
  donor_phone text,
  amount numeric(10,2) not null check (amount > 0 and amount <= 100000),
  donated_on date not null,
  source text not null default 'shop' check (source in ('shop','shopify','event','online','other')),
  method text,
  shopify_order text unique,
  note text,
  refunded_at timestamptz, refunded_by uuid, refund_reason text,
  forwarded_at timestamptz, forwarded_on date, forwarded_ref text, forwarded_by uuid,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);
create index if not exists shop_d4d_donations_campaign_idx on public.shop_d4d_donations (campaign, donated_on);

create table if not exists public.shop_d4d_prizes_given (
  campaign text not null,
  donor_key text not null,
  item text not null check (item in ('gaiter','shirt','vest_entry')),
  given_on date not null default current_date,
  given_by uuid,
  note text,
  created_at timestamptz not null default now(),
  primary key (campaign, donor_key, item)
);

alter table public.shop_d4d_donations enable row level security;
alter table public.shop_d4d_prizes_given enable row level security;
drop policy if exists "Staff can view D4D donations" on public.shop_d4d_donations;
create policy "Staff can view D4D donations" on public.shop_d4d_donations
  for select using (public.shop_has_staff_access());
drop policy if exists "Staff can view D4D prizes" on public.shop_d4d_prizes_given;
create policy "Staff can view D4D prizes" on public.shop_d4d_prizes_given
  for select using (public.shop_has_staff_access());
revoke all on public.shop_d4d_donations, public.shop_d4d_prizes_given from public, anon, authenticated;
grant select on public.shop_d4d_donations, public.shop_d4d_prizes_given to authenticated;

-- Who a donation belongs to, so several gifts from one person add up.
create or replace function public.shop_d4d_donor_key(p_customer_id text, p_email text, p_phone text, p_name text)
returns text language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(
    'c:' || nullif(btrim(p_customer_id), ''),
    'e:' || nullif(lower(btrim(p_email)), ''),
    'p:' || nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), ''),
    'n:' || lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')))
$$;

create or replace view public.shop_d4d_donor_totals
with (security_invoker = true) as
with d as (
  select *, public.shop_d4d_donor_key(customer_id, donor_email, donor_phone, donor_name) as donor_key
  from public.shop_d4d_donations where refunded_at is null
), t as (
  select campaign, donor_key,
    (array_agg(donor_name order by donated_on desc, created_at desc))[1] as donor_name,
    (array_agg(donor_email order by donated_on desc, created_at desc) filter (where donor_email is not null))[1] as donor_email,
    (array_agg(donor_phone order by donated_on desc, created_at desc) filter (where donor_phone is not null))[1] as donor_phone,
    (array_agg(customer_id) filter (where customer_id is not null))[1] as customer_id,
    count(*)::integer as donations, sum(amount) as total, max(amount) as largest,
    min(donated_on) as first_on, max(donated_on) as last_on
  from d group by campaign, donor_key
)
select t.*,
  floor(t.total)::integer as raffle_entries,
  t.total >= 20 as earned_gaiter, t.total >= 50 as earned_shirt, t.total >= 100 as earned_vest_entry,
  t.largest > 75 as over_75_disclosure,
  exists (select 1 from public.shop_d4d_prizes_given g where g.campaign = t.campaign and g.donor_key = t.donor_key and g.item = 'gaiter') as given_gaiter,
  exists (select 1 from public.shop_d4d_prizes_given g where g.campaign = t.campaign and g.donor_key = t.donor_key and g.item = 'shirt') as given_shirt,
  exists (select 1 from public.shop_d4d_prizes_given g where g.campaign = t.campaign and g.donor_key = t.donor_key and g.item = 'vest_entry') as given_vest_entry
from t;
revoke all on public.shop_d4d_donor_totals from public, anon, authenticated;
grant select on public.shop_d4d_donor_totals to authenticated;

create or replace view public.shop_d4d_campaign_summary
with (security_invoker = true) as
select campaign,
  count(*) filter (where refunded_at is null)::integer as donations,
  count(distinct public.shop_d4d_donor_key(customer_id, donor_email, donor_phone, donor_name)) filter (where refunded_at is null)::integer as donors,
  coalesce(sum(amount) filter (where refunded_at is null), 0) as total_raised,
  coalesce(sum(amount) filter (where refunded_at is null and forwarded_at is not null), 0) as forwarded,
  coalesce(sum(amount) filter (where refunded_at is null and forwarded_at is null), 0) as not_forwarded,
  coalesce(sum(amount) filter (where refunded_at is not null), 0) as refunded,
  coalesce(sum(amount) filter (where refunded_at is not null and forwarded_at is not null), 0) as refunded_after_forwarding,
  min(donated_on) as first_on, max(donated_on) as last_on
from public.shop_d4d_donations group by campaign;
revoke all on public.shop_d4d_campaign_summary from public, anon, authenticated;
grant select on public.shop_d4d_campaign_summary to authenticated;

-- Add or edit one donation. p_id is made by the app (double tap safe).
-- p_d: {campaign, customer_id, donor_name, donor_email, donor_phone, amount,
--       donated_on, source, method, shopify_order, note}
create or replace function public.shop_d4d_save_donation(p_id text, p_d jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_prev public.shop_d4d_donations%rowtype; v_amt numeric; v_date date;
  v_name text; v_cust text; v_order text; v_src text; v_camp text;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if shop_clean(p_id) is null then raise exception 'Missing donation id'; end if;
  v_amt := shop_num(p_d->>'amount', 'Amount', null);
  if v_amt is null or v_amt <= 0 then raise exception 'Amount must be more than $0'; end if;
  if v_amt <> round(v_amt, 2) then raise exception 'Amount can have at most 2 decimals'; end if;
  begin v_date := coalesce(nullif(p_d->>'donated_on', '')::date, current_date);
  exception when others then raise exception 'Date is not a valid date'; end;
  if v_date > current_date + 1 then raise exception 'Date can''t be in the future'; end if;
  v_cust := shop_clean(p_d->>'customer_id');
  if v_cust is not null and not exists (select 1 from public.shop_customers where id = v_cust) then raise exception 'Customer not found'; end if;
  v_name := coalesce(shop_clean(p_d->>'donor_name'), (select name from public.shop_customers where id = v_cust));
  if v_name is null then raise exception 'Donor name is required'; end if;
  v_order := shop_clean(p_d->>'shopify_order');
  v_src := coalesce(shop_clean(p_d->>'source'), case when v_order is not null then 'shopify' else 'shop' end);
  if v_src not in ('shop','shopify','event','online','other') then raise exception 'Unknown source'; end if;
  v_camp := coalesce(shop_clean(p_d->>'campaign'), 'Dollars for Dads 2026');
  if v_order is not null and exists (select 1 from public.shop_d4d_donations where shopify_order = v_order and id <> p_id) then
    raise exception 'Shopify order % is already recorded', v_order;
  end if;

  select * into v_prev from public.shop_d4d_donations where id = p_id for update;
  if found then
    if v_prev.forwarded_at is not null then raise exception 'This donation was already sent to ManUp, so it can''t be changed. Refund it instead.'; end if;
    if v_prev.refunded_at is not null then raise exception 'This donation was refunded, so it can''t be changed'; end if;
    update public.shop_d4d_donations set campaign = v_camp, customer_id = v_cust, donor_name = v_name,
      donor_email = shop_clean(p_d->>'donor_email'), donor_phone = shop_clean(p_d->>'donor_phone'),
      amount = v_amt, donated_on = v_date, source = v_src, method = shop_clean(p_d->>'method'),
      shopify_order = v_order, note = shop_clean(p_d->>'note'), updated_at = now(), updated_by = v_uid
    where id = p_id;
  else
    insert into public.shop_d4d_donations (id, campaign, customer_id, donor_name, donor_email, donor_phone, amount,
      donated_on, source, method, shopify_order, note, created_by, updated_by)
    values (p_id, v_camp, v_cust, v_name, shop_clean(p_d->>'donor_email'), shop_clean(p_d->>'donor_phone'), v_amt,
      v_date, v_src, shop_clean(p_d->>'method'), v_order, shop_clean(p_d->>'note'), v_uid, v_uid);
  end if;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_d4d_donations', p_id, case when v_prev.id is null then 'insert' else 'update' end, v_uid,
    jsonb_build_object('amount', v_amt, 'before', case when v_prev.id is null then null else v_prev.amount end));
  return jsonb_build_object('id', p_id, 'amount', v_amt, 'donor_key', shop_d4d_donor_key(v_cust, p_d->>'donor_email', p_d->>'donor_phone', v_name));
end $$;

create or replace function public.shop_d4d_refund(p_id text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v public.shop_d4d_donations%rowtype;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if shop_clean(p_reason) is null then raise exception 'Say why it was refunded'; end if;
  select * into v from public.shop_d4d_donations where id = p_id for update;
  if not found then raise exception 'Donation not found'; end if;
  if v.refunded_at is not null then return jsonb_build_object('id', p_id, 'repeat', true); end if;
  update public.shop_d4d_donations set refunded_at = now(), refunded_by = v_uid, refund_reason = shop_clean(p_reason),
    updated_at = now(), updated_by = v_uid where id = p_id;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_d4d_donations', p_id, 'refund', v_uid, jsonb_build_object('amount', v.amount, 'was_forwarded', v.forwarded_at is not null));
  return jsonb_build_object('id', p_id, 'was_forwarded', v.forwarded_at is not null);
end $$;

-- Mark donations as passed on to ManUp. Skips any that are refunded or already sent.
-- p_ids: a JSON list of donation ids, e.g. ["id1","id2"].
create or replace function public.shop_d4d_mark_forwarded(p_ids jsonb, p_forwarded_on date, p_ref text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); n integer; amt numeric; v_ids text[];
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_ids is null or jsonb_typeof(p_ids) <> 'array' or jsonb_array_length(p_ids) = 0 then raise exception 'Pick at least one donation'; end if;
  select array_agg(x) into v_ids from jsonb_array_elements_text(p_ids) x;
  if shop_clean(p_ref) is null then raise exception 'Add a reference (check number, transfer id or note)'; end if;
  with u as (
    update public.shop_d4d_donations set forwarded_at = now(), forwarded_on = coalesce(p_forwarded_on, current_date),
      forwarded_ref = shop_clean(p_ref), forwarded_by = v_uid, updated_at = now(), updated_by = v_uid
    where id = any(v_ids) and forwarded_at is null and refunded_at is null returning amount)
  select count(*), coalesce(sum(amount), 0) into n, amt from u;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_d4d_donations', 'batch', 'forwarded', v_uid, jsonb_build_object('ids', p_ids, 'count', n, 'amount', amt, 'ref', p_ref));
  return jsonb_build_object('count', n, 'amount', amt);
end $$;

-- Record that a tier prize was handed out. Refuses if the donor hasn't reached that tier.
create or replace function public.shop_d4d_give_prize(p_campaign text, p_donor_key text, p_item text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v public.shop_d4d_donor_totals%rowtype;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_item not in ('gaiter','shirt','vest_entry') then raise exception 'Unknown prize'; end if;
  select * into v from public.shop_d4d_donor_totals where campaign = p_campaign and donor_key = p_donor_key;
  if not found then raise exception 'Donor not found'; end if;
  if (p_item = 'gaiter' and not v.earned_gaiter) or (p_item = 'shirt' and not v.earned_shirt)
     or (p_item = 'vest_entry' and not v.earned_vest_entry) then
    raise exception 'This donor hasn''t reached that prize yet (total $%)', v.total;
  end if;
  insert into public.shop_d4d_prizes_given (campaign, donor_key, item, given_by, note)
  values (p_campaign, p_donor_key, p_item, v_uid, shop_clean(p_note)) on conflict do nothing;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_d4d_prizes_given', p_campaign || '/' || p_donor_key || '/' || p_item, 'give', v_uid, null);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.shop_d4d_undo_prize(p_campaign text, p_donor_key text, p_item text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if shop_clean(p_reason) is null then raise exception 'Say why'; end if;
  delete from public.shop_d4d_prizes_given where campaign = p_campaign and donor_key = p_donor_key and item = p_item;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_d4d_prizes_given', p_campaign || '/' || p_donor_key || '/' || p_item, 'undo', v_uid, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true);
end $$;

-- ===================== GRANTS =====================
do $$
declare f text;
begin
  foreach f in array array[
    'shop_rewards_redeem(text,text,text,text,text)', 'shop_save_reward_item(text,jsonb)', 'shop_rewards_adjust(text,text,integer,text)',
    'shop_update_reward_settings(jsonb)', 'shop_rewards_backfill(date)',
    'shop_d4d_save_donation(text,jsonb)', 'shop_d4d_refund(text,text)',
    'shop_d4d_mark_forwarded(jsonb,date,text)', 'shop_d4d_give_prize(text,text,text,text)',
    'shop_d4d_undo_prize(text,text,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  execute 'revoke all on function public.shop_d4d_donor_key(text,text,text,text) from public, anon';
  execute 'grant execute on function public.shop_d4d_donor_key(text,text,text,text) to authenticated';
end $$;

-- ===================== LEGACY =====================
-- shop_submit_estimate (002) zeroes a job's amounts when it is used to change
-- status, and shop_set_job_line_items (002) replaces lines without
-- recalculating totals. The app has used shop_save_estimate / shop_set_job_status
-- (004) instead since October. Switch the old two off for app accounts so they
-- can't damage invoice money. They still exist for the database owner.
-- To undo: grant execute on function ... to authenticated (see rollback file).
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('shop_submit_estimate', 'shop_set_job_line_items') loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;
