-- Shop 004: itemized estimates. Requires 001, 002 and 003 first.
-- ADDITIVE ONLY: new columns, one new settings table, new functions, and a
-- tightened photo-bucket read policy. No table or column is dropped and no
-- existing row is changed except that existing jobs receive an estimate number.
-- Safe to re-run.
--
-- What this adds
--   * shop_settings: one row of shop details printed on estimates, plus the
--     default tax rate / tax treatment. The tax rate starts EMPTY on purpose —
--     staff must enter the shop's real rate; nothing is guessed.
--   * shop_jobs: estimate_number (auto, unique), work_description,
--     customer_notes (printed), tax_rate / tax_applies_to snapshot per estimate.
--     The existing `notes` column stays as INTERNAL notes (never printed).
--   * shop_job_line_items: sort_order so lines reopen in the order entered.
--   * shop_save_estimate: one call saves customer + bike + job + line items in
--     one transaction. Money is calculated HERE from the line items, so the
--     totals can never disagree with the lines.
--   * shop_set_job_status: estimate -> in_progress -> complete (one step at a
--     time) without touching any amounts. (The older shop_submit_estimate wiped
--     amounts when used for this.)
--   * shop_update_settings.
--   * Bike photos become staff-only to view (bucket no longer public).

-- ===================== SETTINGS =====================
create table if not exists public.shop_settings (
  id integer primary key default 1 check (id = 1),
  business_name text not null default 'SIC Cycles',
  phone text,
  email text,
  address text,
  default_tax_rate numeric(6,3) check (default_tax_rate is null or (default_tax_rate >= 0 and default_tax_rate < 100)),
  default_tax_applies_to text not null default 'parts'
    check (default_tax_applies_to in ('none','parts','parts_labor')),
  estimate_terms text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.shop_settings (id) values (1) on conflict (id) do nothing;

alter table public.shop_settings enable row level security;
drop policy if exists "Staff can view shop settings" on public.shop_settings;
create policy "Staff can view shop settings" on public.shop_settings
  for select using (public.shop_has_staff_access());

-- ===================== JOB / LINE ITEM COLUMNS =====================
create sequence if not exists public.shop_estimate_number_seq start with 1001;
alter table public.shop_jobs add column if not exists estimate_number bigint
  default nextval('public.shop_estimate_number_seq');
create unique index if not exists shop_jobs_estimate_number_key on public.shop_jobs (estimate_number);
alter table public.shop_jobs add column if not exists work_description text;
alter table public.shop_jobs add column if not exists customer_notes text;
alter table public.shop_jobs add column if not exists tax_rate numeric(6,3);
alter table public.shop_jobs add column if not exists tax_applies_to text not null default 'parts';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shop_jobs_tax_applies_to_check') then
    alter table public.shop_jobs add constraint shop_jobs_tax_applies_to_check
      check (tax_applies_to in ('none','parts','parts_labor'));
  end if;
end $$;
alter table public.shop_job_line_items add column if not exists sort_order integer not null default 0;

-- ===================== HELPERS =====================
create or replace function public.shop_clean(p text)
returns text language sql immutable set search_path = public, pg_temp
as $$ select nullif(btrim(p), '') $$;

-- Whole number or null. Rejects anything else with a readable message.
create or replace function public.shop_int(p text, p_label text)
returns integer language plpgsql immutable set search_path = public, pg_temp
as $$
declare v text := nullif(btrim(coalesce(p, '')), '');
begin
  if v is null then return null; end if;
  v := replace(v, ',', '');
  if v !~ '^\d{1,9}$' then raise exception '% must be a whole number', p_label; end if;
  return v::integer;
end $$;

create or replace function public.shop_num(p text, p_label text, p_default numeric)
returns numeric language plpgsql immutable set search_path = public, pg_temp
as $$
declare v text := nullif(btrim(coalesce(p, '')), '');
begin
  if v is null then return p_default; end if;
  if v !~ '^-?\d{0,9}(\.\d+)?$' or v in ('-', '.', '-.') then
    raise exception '% must be a number', p_label;
  end if;
  return v::numeric;
end $$;

create or replace function public.shop_refresh_customer_rollup(p_customer_id text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  update public.shop_customers c set
    last_visit = (select max(j.job_date) from public.shop_jobs j where j.customer_id = c.id),
    invoice_count = (select count(*) from public.shop_jobs j where j.customer_id = c.id),
    lifetime_spend = (select coalesce(sum(j.total_amount), 0) from public.shop_jobs j
                      where j.customer_id = c.id and j.status = 'complete')
  where c.id = p_customer_id;
end $$;

-- ===================== SAVE ESTIMATE =====================
-- p_job_id / p_customer_id / p_bike_id are ids made by the app when the form
-- opens. If the row exists it is updated, otherwise it is created with that id,
-- so a double-tap on Save can never create a duplicate customer, bike or job.
-- p_bike may be null (no bike on this job).
-- p_job: {status, job_date, invoice_number, work_description, customer_notes,
--         notes (internal), tax_rate, tax_applies_to, expected_updated_at,
--         estimate_number (optional, new jobs only; for importing old invoices)}
-- p_items: [{kind: part|labor, description, quantity, unit_price, unit_cost}]
create or replace function public.shop_save_estimate(
  p_job_id text, p_customer_id text, p_customer jsonb,
  p_bike_id text, p_bike jsonb, p_job jsonb, p_items jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_job public.shop_jobs%rowtype;
  v_job_exists boolean;
  v_bike_owner text;
  v_bike_exists boolean;
  v_old_customer text;
  v_item jsonb;
  v_i integer := 0;
  v_kind text; v_desc text; v_qty numeric; v_price numeric; v_cost numeric;
  v_parts numeric := 0; v_labor numeric := 0; v_parts_cost numeric := 0;
  v_rate numeric; v_applies text; v_taxable numeric; v_tax numeric;
  v_status text; v_photos jsonb; v_number bigint; v_fixed boolean := false;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_job_id is null or p_job_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'invalid job id'; end if;
  if p_customer_id is null or p_customer_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'invalid customer id'; end if;
  if p_bike is not null and (p_bike_id is null or p_bike_id !~ '^[A-Za-z0-9_-]{6,64}$') then raise exception 'invalid bike id'; end if;
  if shop_clean(p_customer->>'name') is null then raise exception 'Customer name is required'; end if;
  if p_items is null then p_items := '[]'::jsonb; end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'line items must be a list'; end if;
  if jsonb_array_length(p_items) > 200 then raise exception 'Too many line items (200 max)'; end if;

  select * into v_job from public.shop_jobs where id = p_job_id for update;
  v_job_exists := found;
  if v_job_exists and shop_clean(p_job->>'expected_updated_at') is not null
     and v_job.updated_at <> (p_job->>'expected_updated_at')::timestamptz then
    raise exception 'This estimate was changed by someone else. Close it, reload, and try again.';
  end if;
  v_old_customer := v_job.customer_id;

  -- 1. Customer
  insert into public.shop_customers (id, name, phone, email, address, created_by, updated_by)
  values (p_customer_id, shop_clean(p_customer->>'name'), shop_clean(p_customer->>'phone'),
          shop_clean(p_customer->>'email'), shop_clean(p_customer->>'address'), v_uid, v_uid)
  on conflict (id) do update set
    name = excluded.name, phone = excluded.phone, email = excluded.email,
    address = excluded.address, updated_at = now(), updated_by = v_uid;

  -- 2. Bike (must belong to this customer if it already exists)
  if p_bike is not null then
    select customer_id, true into v_bike_owner, v_bike_exists from public.shop_bikes where id = p_bike_id;
    if v_bike_exists and v_bike_owner is not null and v_bike_owner <> p_customer_id then
      raise exception 'That bike is on a different customer''s record';
    end if;
    v_photos := case when p_bike ? 'photos' then p_bike->'photos' else null end;
    if v_photos is not null and (jsonb_typeof(v_photos) <> 'array' or jsonb_array_length(v_photos) > 40) then
      raise exception 'invalid photo list';
    end if;
    insert into public.shop_bikes (id, customer_id, vin, make, model, year, mileage, photo_urls, created_by, updated_by)
    values (p_bike_id, p_customer_id, upper(shop_clean(p_bike->>'vin')), shop_clean(p_bike->>'make'),
            shop_clean(p_bike->>'model'), shop_int(p_bike->>'year', 'Year'),
            shop_int(p_bike->>'mileage', 'Mileage'), coalesce(v_photos, '[]'::jsonb), v_uid, v_uid)
    on conflict (id) do update set
      customer_id = excluded.customer_id, vin = excluded.vin, make = excluded.make,
      model = excluded.model, year = excluded.year, mileage = excluded.mileage,
      photo_urls = coalesce(v_photos, public.shop_bikes.photo_urls),
      updated_at = now(), updated_by = v_uid;
  end if;

  -- 3. Line items -> money. Line total = round(qty * unit price, 2).
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_i := v_i + 1;
    v_kind := v_item->>'kind';
    if v_kind not in ('part','labor') then raise exception 'Line %: type must be part or labor', v_i; end if;
    v_desc := shop_clean(v_item->>'description');
    if v_desc is null then raise exception 'Line %: description is required', v_i; end if;
    v_qty := shop_num(v_item->>'quantity', format('Line %s quantity', v_i), 1);
    v_price := shop_num(v_item->>'unit_price', format('Line %s price', v_i), 0);
    v_cost := case when v_kind = 'part' then shop_num(v_item->>'unit_cost', format('Line %s cost', v_i), 0) else 0 end;
    if v_qty <= 0 or v_qty > 9999 then raise exception 'Line %: quantity must be above 0', v_i; end if;
    if v_price < 0 or v_cost < 0 then raise exception 'Line %: amounts cannot be negative', v_i; end if;
    if v_qty <> round(v_qty, 2) or v_price <> round(v_price, 2) or v_cost <> round(v_cost, 2) then
      raise exception 'Line %: use at most 2 decimal places', v_i;
    end if;
    if v_kind = 'part' then
      v_parts := v_parts + round(v_qty * v_price, 2);
      v_parts_cost := v_parts_cost + round(v_qty * v_cost, 2);
    else
      v_labor := v_labor + round(v_qty * v_price, 2);
    end if;
  end loop;

  v_rate := shop_num(p_job->>'tax_rate', 'Tax rate', null);
  if v_rate is not null and (v_rate < 0 or v_rate >= 100 or v_rate <> round(v_rate, 3)) then
    raise exception 'Tax rate must be a percent between 0 and 100 (up to 3 decimals)';
  end if;
  v_applies := coalesce(shop_clean(p_job->>'tax_applies_to'), 'parts');
  if v_applies not in ('none','parts','parts_labor') then raise exception 'invalid tax setting'; end if;
  v_taxable := case v_applies when 'parts' then v_parts when 'parts_labor' then v_parts + v_labor else 0 end;
  v_tax := case when v_rate is null then 0 else round(v_taxable * v_rate / 100, 2) end;

  v_status := coalesce(shop_clean(p_job->>'status'), v_job.status, 'estimate');
  if v_status not in ('estimate','in_progress','complete') then raise exception 'invalid status'; end if;

  -- Optional fixed estimate number, only when creating a job (used to import
  -- old invoices with their real numbers). New estimates then continue after
  -- the highest number in use.
  if not v_job_exists and shop_clean(p_job->>'estimate_number') is not null then
    v_number := shop_int(p_job->>'estimate_number', 'Estimate number');
    if v_number < 1 then raise exception 'Estimate number must be above 0'; end if;
    if exists (select 1 from public.shop_jobs where estimate_number = v_number) then
      raise exception 'Estimate number % is already used', v_number;
    end if;
    v_fixed := true;
  elsif not v_job_exists then
    v_number := nextval('public.shop_estimate_number_seq');
  else
    v_number := v_job.estimate_number;
  end if;

  -- 4. Job
  insert into public.shop_jobs (id, estimate_number, invoice_number, customer_id, bike_id, status, job_date,
      parts_amount, labor_amount, tax_amount, total_amount, parts_cost, notes,
      work_description, customer_notes, tax_rate, tax_applies_to, created_by, updated_by)
  values (p_job_id, v_number,
      shop_clean(p_job->>'invoice_number'), p_customer_id,
      case when p_bike is null then null else p_bike_id end, v_status,
      coalesce(nullif(p_job->>'job_date', '')::date, current_date),
      v_parts, v_labor, v_tax, v_parts + v_labor + v_tax, v_parts_cost,
      shop_clean(p_job->>'notes'), shop_clean(p_job->>'work_description'),
      shop_clean(p_job->>'customer_notes'), v_rate, v_applies, v_uid, v_uid)
  on conflict (id) do update set
    invoice_number = excluded.invoice_number, customer_id = excluded.customer_id,
    bike_id = excluded.bike_id, status = excluded.status, job_date = excluded.job_date,
    parts_amount = excluded.parts_amount, labor_amount = excluded.labor_amount,
    tax_amount = excluded.tax_amount, total_amount = excluded.total_amount,
    parts_cost = excluded.parts_cost, notes = excluded.notes,
    work_description = excluded.work_description, customer_notes = excluded.customer_notes,
    tax_rate = excluded.tax_rate, tax_applies_to = excluded.tax_applies_to,
    updated_at = now(), updated_by = v_uid;

  if v_fixed then
    perform setval('public.shop_estimate_number_seq', greatest(v_number,
      (select case when is_called then last_value else last_value - 1 end from public.shop_estimate_number_seq)), true);
  end if;

  -- 5. Replace line items in entered order
  delete from public.shop_job_line_items where job_id = p_job_id;
  v_i := 0;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_i := v_i + 1;
    insert into public.shop_job_line_items (id, job_id, kind, description, quantity, unit_price, unit_cost, sort_order, created_by)
    values (replace(gen_random_uuid()::text, '-', ''), p_job_id, v_item->>'kind', shop_clean(v_item->>'description'),
            shop_num(v_item->>'quantity', 'quantity', 1), shop_num(v_item->>'unit_price', 'price', 0),
            case when v_item->>'kind' = 'part' then shop_num(v_item->>'unit_cost', 'cost', 0) else 0 end,
            v_i, v_uid);
  end loop;

  perform shop_refresh_customer_rollup(p_customer_id);
  if v_old_customer is not null and v_old_customer <> p_customer_id then
    perform shop_refresh_customer_rollup(v_old_customer);
  end if;

  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_jobs', p_job_id, case when v_job_exists then 'update' else 'insert' end, v_uid,
          jsonb_build_object('customer_id', p_customer_id, 'bike_id', case when p_bike is null then null else p_bike_id end,
                             'lines', jsonb_array_length(p_items), 'total', v_parts + v_labor + v_tax));

  select * into v_job from public.shop_jobs where id = p_job_id;
  return jsonb_build_object('job_id', v_job.id, 'customer_id', v_job.customer_id, 'bike_id', v_job.bike_id,
    'estimate_number', v_job.estimate_number, 'updated_at', v_job.updated_at,
    'parts_amount', v_job.parts_amount, 'labor_amount', v_job.labor_amount,
    'tax_amount', v_job.tax_amount, 'total_amount', v_job.total_amount);
end;
$$;

-- ===================== STATUS =====================
create or replace function public.shop_set_job_status(p_job_id text, p_status text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_job public.shop_jobs%rowtype; v_from int; v_to int;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  select * into v_job from public.shop_jobs where id = p_job_id for update;
  if not found then raise exception 'Job not found'; end if;
  v_from := array_position(array['estimate','in_progress','complete'], v_job.status);
  v_to := array_position(array['estimate','in_progress','complete'], p_status);
  if v_to is null then raise exception 'invalid status'; end if;
  if abs(v_to - v_from) <> 1 then raise exception 'A job moves one step at a time (estimate, in progress, complete)'; end if;
  update public.shop_jobs set status = p_status, updated_at = now(), updated_by = v_uid where id = p_job_id
  returning * into v_job;
  perform shop_refresh_customer_rollup(v_job.customer_id);
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_jobs', p_job_id, 'status', v_uid, jsonb_build_object('to', p_status));
  return jsonb_build_object('job_id', v_job.id, 'status', v_job.status, 'updated_at', v_job.updated_at);
end $$;

-- ===================== SETTINGS WRITE =====================
create or replace function public.shop_update_settings(p_settings jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_rate numeric; v_applies text; r public.shop_settings%rowtype;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  v_rate := shop_num(p_settings->>'default_tax_rate', 'Tax rate', null);
  if v_rate is not null and (v_rate < 0 or v_rate >= 100) then raise exception 'Tax rate must be a percent between 0 and 100'; end if;
  v_applies := coalesce(shop_clean(p_settings->>'default_tax_applies_to'), 'parts');
  if v_applies not in ('none','parts','parts_labor') then raise exception 'invalid tax setting'; end if;
  update public.shop_settings set
    business_name = coalesce(shop_clean(p_settings->>'business_name'), 'SIC Cycles'),
    phone = shop_clean(p_settings->>'phone'), email = shop_clean(p_settings->>'email'),
    address = shop_clean(p_settings->>'address'), default_tax_rate = v_rate,
    default_tax_applies_to = v_applies, estimate_terms = shop_clean(p_settings->>'estimate_terms'),
    updated_at = now(), updated_by = v_uid
  where id = 1 returning * into r;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_settings', '1', 'update', v_uid, to_jsonb(r));
  return to_jsonb(r);
end $$;

-- ===================== PHOTOS: staff-only viewing =====================
-- 003 made the bucket public. Customer bike photos (plates, VINs) should not be
-- viewable by anyone with a link, so make it private and allow staff only.
-- Existing files are untouched; the app now loads them with the staff sign-in.
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    update storage.buckets set public = false where id = 'shop-bike-photos';
  end if;
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'objects') then
    execute 'drop policy if exists "Anyone can view bike photos" on storage.objects';
    execute 'drop policy if exists "Staff can view bike photos" on storage.objects';
    execute $p$create policy "Staff can view bike photos" on storage.objects for select
      using (bucket_id = 'shop-bike-photos' and public.shop_has_staff_access())$p$;
  end if;
end $$;

-- ===================== GRANTS (same sweep as 002) =====================
do $$
declare t text; f record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename like 'shop\_%' loop
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  revoke all on sequence public.shop_estimate_number_seq from anon, authenticated;
  for f in select p.oid::regprocedure::text as sig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'shop\_%' loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
  -- The storage photo policy calls shop_has_staff_access() for every caller,
  -- including signed-out ones. Let anon run it (it simply returns false for
  -- them) so their storage requests are denied cleanly instead of erroring.
  grant execute on function public.shop_has_staff_access() to anon;
end $$;
