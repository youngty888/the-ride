-- shop-011: admin home page for each signed-in staff member.
--   * Shop calendar: public shop appointments everyone on staff sees, plus
--     personal appointments only the person who made them can see.
--   * Receipts: any staff member uploads a receipt (picture or document)
--     with the amount, vendor and an optional job to bill it to.
--   * Pay stubs: the payroll manager files a pay stub for a staff member.
--     Only that staff member and the payroll manager can see it or its file.
--   * Consignment agreements (a bike or an item) linked to the consignor's
--     customer record.
--   * Money in vs out for a date range, and each tech's own hours earned
--     this week, month and year (from tech sign-off, shop-008).
--   * Money is only for the payroll manager or staff given money access:
--       update public.shop_staff set money_access = true where display_name = 'Tyler';
-- All of these live in the same document library and private file store as
-- shop-010. Nothing is deleted from the app; appointments are cancelled and
-- documents archived. Additive and safe to re-run. Run AFTER shop-004,
-- shop-008 and shop-010. Uses shop-009 payment plan payments if installed.
-- Week, month and year are counted in Tucson time (America/Phoenix).
-- NOT yet run on the live database: Tyler runs it.

alter table public.shop_staff add column if not exists money_access boolean not null default false;

create or replace function public.shop_can_see_money()
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.shop_staff where user_id = auth.uid() and active and (payroll_manager or money_access));
$$;
revoke all on function public.shop_can_see_money() from public, anon;
grant execute on function public.shop_can_see_money() to authenticated;

-- ---------- documents: new kinds, owner and amount ----------
alter table public.shop_documents drop constraint if exists shop_documents_doc_type_check;
alter table public.shop_documents add constraint shop_documents_doc_type_check
  check (doc_type in ('meeting', 'intake', 'legal', 'other', 'receipt', 'paystub', 'consignment'));
alter table public.shop_documents add column if not exists owner_user_id uuid;   -- pay stub: whose; receipt: who turned it in
alter table public.shop_documents add column if not exists amount numeric(10,2);  -- receipt or pay stub amount
create index if not exists shop_documents_owner on public.shop_documents (owner_user_id);

-- Pay stubs are private to the staff member and the payroll manager.
create or replace function public.shop_can_read_document(p_type text, p_owner uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select shop_has_staff_access() and (p_type <> 'paystub' or p_owner = auth.uid() or shop_is_payroll_manager());
$$;
revoke all on function public.shop_can_read_document(text, uuid) from public, anon;
grant execute on function public.shop_can_read_document(text, uuid) to authenticated;

drop policy if exists "Staff can view shop documents" on public.shop_documents;
create policy "Staff can view shop documents" on public.shop_documents
  for select using (public.shop_can_read_document(doc_type, owner_user_id));

-- Files follow the same rule: a file under docs/<id>/ of a pay stub is only
-- readable by its owner and the payroll manager. Pay stub rows are made
-- before their file is uploaded, so a pay stub file is never readable by
-- other staff, even for a moment.
create or replace function public.shop_can_read_document_file(p_name text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select shop_has_staff_access() and coalesce((
    select shop_can_read_document(d.doc_type, d.owner_user_id) from shop_documents d
    where d.id = split_part(p_name, '/', 2) and split_part(p_name, '/', 1) = 'docs'), true);
$$;
revoke all on function public.shop_can_read_document_file(text) from public, anon;
grant execute on function public.shop_can_read_document_file(text) to authenticated;

drop policy if exists "Staff can view shop documents" on storage.objects;
create policy "Staff can view shop documents" on storage.objects for select
  using (bucket_id = 'shop-documents' and public.shop_can_read_document_file(name));
-- Only the payroll manager may add a file to a pay stub.
create or replace function public.shop_can_upload_document_file(p_name text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select shop_has_staff_access() and (shop_is_payroll_manager() or not exists (
    select 1 from shop_documents d where d.id = split_part(p_name, '/', 2) and d.doc_type = 'paystub'));
$$;
revoke all on function public.shop_can_upload_document_file(text) from public, anon;
grant execute on function public.shop_can_upload_document_file(text) to authenticated;
drop policy if exists "Staff can upload shop documents" on storage.objects;
create policy "Staff can upload shop documents" on storage.objects for insert
  with check (bucket_id = 'shop-documents' and public.shop_can_upload_document_file(name));

-- The general save takes only the simple kinds; the others have their own checks.
create or replace function public.shop_save_document(p_id text, p_type text, p_doc jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.shop_documents;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_type not in ('meeting', 'legal', 'other') then raise exception 'Use the % form to save this kind of document', p_type; end if;
  v_row := shop_put_document(p_id, p_type, p_doc, shop_clean(p_doc->>'customer_id'), shop_clean(p_doc->>'bike_id'));
  return to_jsonb(v_row);
end $$;

create or replace function public.shop_doc_amount(p_value text, p_required boolean)
returns numeric
language plpgsql immutable set search_path = public, pg_temp
as $$
declare v numeric;
begin
  if shop_clean(p_value) is null then
    if p_required then raise exception 'Enter the amount'; end if;
    return null;
  end if;
  begin v := round(replace(replace(p_value, '$', ''), ',', '')::numeric, 2);
  exception when others then raise exception 'Amount is not a number'; end;
  if v < 0 or v > 1000000 then raise exception 'Amount must be between 0 and 1,000,000'; end if;
  return v;
end $$;
revoke all on function public.shop_doc_amount(text, boolean) from public, anon, authenticated;

-- Receipt: any staff member. A receipt needs a picture or document attached.
create or replace function public.shop_save_receipt(p_id text, p_doc jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.shop_documents; v_amount numeric; v_old public.shop_documents;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  v_amount := shop_doc_amount(p_doc->>'amount', true);
  if v_amount <= 0 then raise exception 'Amount must be more than 0'; end if;
  select * into v_old from shop_documents where id = p_id;
  if shop_clean(p_doc->>'file_path') is null and (v_old.id is null or v_old.file_path is null) then
    raise exception 'Attach a picture or document of the receipt';
  end if;
  v_row := shop_put_document(p_id, 'receipt', p_doc, shop_clean(p_doc->>'customer_id'), shop_clean(p_doc->>'bike_id'));
  update shop_documents set amount = v_amount, owner_user_id = coalesce(v_old.owner_user_id, auth.uid())
   where id = p_id returning * into v_row;
  return to_jsonb(v_row);
end $$;
revoke all on function public.shop_save_receipt(text, jsonb) from public, anon;
grant execute on function public.shop_save_receipt(text, jsonb) to authenticated;

-- Pay stub: payroll manager only, for an active staff member.
create or replace function public.shop_save_paystub(p_id text, p_owner uuid, p_doc jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.shop_documents;
begin
  if not shop_is_payroll_manager() then raise exception 'Only the payroll manager can file pay stubs'; end if;
  if not exists (select 1 from shop_staff where user_id = p_owner and active) then raise exception 'Pick a staff member'; end if;
  if exists (select 1 from shop_documents where id = p_id and owner_user_id is distinct from p_owner) then
    raise exception 'A pay stub cannot move to another person. Archive it and file a new one.';
  end if;
  v_row := shop_put_document(p_id, 'paystub', p_doc - 'customer_id' - 'bike_id' - 'job_id', null, null);
  update shop_documents set owner_user_id = p_owner, amount = shop_doc_amount(p_doc->>'amount', false)
   where id = p_id returning * into v_row;
  return to_jsonb(v_row);
end $$;
revoke all on function public.shop_save_paystub(text, uuid, jsonb) from public, anon;
grant execute on function public.shop_save_paystub(text, uuid, jsonb) to authenticated;

-- Customer and bike upsert shared by the intake and consignment forms.
create or replace function public.shop_upsert_customer_bike(p_customer_id text, p_customer jsonb, p_bike_id text, p_bike jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_owner text; v_found boolean;
begin
  if p_customer_id is null or p_customer_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'invalid customer id'; end if;
  if p_customer is null or shop_clean(p_customer->>'name') is null then raise exception 'Customer name is required'; end if;
  if p_bike is not null and (p_bike_id is null or p_bike_id !~ '^[A-Za-z0-9_-]{6,64}$') then raise exception 'invalid bike id'; end if;
  insert into shop_customers (id, name, phone, email, address, created_by, updated_by)
  values (p_customer_id, shop_clean(p_customer->>'name'), shop_clean(p_customer->>'phone'),
          shop_clean(p_customer->>'email'), shop_clean(p_customer->>'address'), v_uid, v_uid)
  on conflict (id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email,
    address = excluded.address, updated_at = now(), updated_by = v_uid;
  if p_bike is not null then
    select customer_id, true into v_owner, v_found from shop_bikes where id = p_bike_id;
    if v_found and v_owner is not null and v_owner <> p_customer_id then
      raise exception 'That bike is on a different customer''s record';
    end if;
    insert into shop_bikes (id, customer_id, vin, make, model, year, mileage, created_by, updated_by)
    values (p_bike_id, p_customer_id, upper(shop_clean(p_bike->>'vin')), shop_clean(p_bike->>'make'),
            shop_clean(p_bike->>'model'), shop_int(p_bike->>'year', 'Year'), shop_int(p_bike->>'mileage', 'Mileage'), v_uid, v_uid)
    on conflict (id) do update set customer_id = excluded.customer_id, vin = excluded.vin, make = excluded.make,
      model = excluded.model, year = excluded.year, mileage = excluded.mileage, updated_at = now(), updated_by = v_uid;
  end if;
end $$;
revoke all on function public.shop_upsert_customer_bike(text, jsonb, text, jsonb) from public, anon, authenticated;

-- Consignment agreement: the consignor is a customer record; a consigned
-- bike gets a bike record. An item (parts, gear) has no bike record.
create or replace function public.shop_save_consignment(p_doc_id text, p_customer_id text, p_customer jsonb,
  p_bike_id text, p_bike jsonb, p_doc jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.shop_documents;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if exists (select 1 from shop_documents where id = p_doc_id and doc_type <> 'consignment') then raise exception 'A document cannot change type'; end if;
  if shop_clean(p_doc->'data'->>'kind') not in ('bike', 'item') then raise exception 'Pick bike or item'; end if;
  perform shop_doc_amount(p_doc->'data'->>'asking_price', false);
  perform shop_doc_amount(p_doc->'data'->>'minimum_price', false);
  perform shop_upsert_customer_bike(p_customer_id, p_customer, p_bike_id, p_bike);
  v_row := shop_put_document(p_doc_id, 'consignment', p_doc, p_customer_id, case when p_bike is null then null else p_bike_id end);
  update shop_documents set amount = shop_doc_amount(p_doc->'data'->>'asking_price', false) where id = p_doc_id returning * into v_row;
  return to_jsonb(v_row);
end $$;
revoke all on function public.shop_save_consignment(text, text, jsonb, text, jsonb, jsonb) from public, anon;
grant execute on function public.shop_save_consignment(text, text, jsonb, text, jsonb, jsonb) to authenticated;

-- Archive: pay stubs only by the payroll manager; everything else by staff.
create or replace function public.shop_archive_document(p_id text, p_archived boolean)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_type text;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  select doc_type into v_type from shop_documents where id = p_id;
  if v_type is null then raise exception 'Document not found'; end if;
  if v_type = 'paystub' and not shop_is_payroll_manager() then raise exception 'Only the payroll manager can archive pay stubs'; end if;
  update shop_documents set archived = coalesce(p_archived, true), updated_at = now(), updated_by = auth.uid() where id = p_id;
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_documents', p_id, case when coalesce(p_archived, true) then 'archive' else 'unarchive' end, auth.uid(), '{}'::jsonb);
  return true;
end $$;

-- ---------- calendar ----------
create table if not exists public.shop_appointments (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{6,64}$'),
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  visibility text not null default 'public' check (visibility in ('public', 'personal')),
  owner_user_id uuid not null,              -- who made it; a personal one is only theirs
  customer_id text references public.shop_customers(id) on delete set null,
  bike_id text references public.shop_bikes(id) on delete set null,
  job_id text references public.shop_jobs(id) on delete set null,
  notes text,
  cancelled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid not null,
  check (ends_at is null or ends_at >= starts_at)
);
create index if not exists shop_appointments_starts on public.shop_appointments (starts_at);

alter table public.shop_appointments enable row level security;
drop policy if exists "Staff see public and their own appointments" on public.shop_appointments;
create policy "Staff see public and their own appointments" on public.shop_appointments
  for select using (public.shop_has_staff_access() and (visibility = 'public' or owner_user_id = auth.uid()));
revoke all on public.shop_appointments from anon;
revoke all on public.shop_appointments from authenticated;
grant select on public.shop_appointments to authenticated;

-- Save one appointment. Any staff member can add or change a public one; a
-- personal one only by the person who made it. p_appt keys: title, starts_at,
-- ends_at, all_day, visibility, customer_id, bike_id, job_id, notes, cancelled,
-- expected_updated_at.
create or replace function public.shop_save_appointment(p_id text, p_appt jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_old public.shop_appointments; v_row public.shop_appointments;
  v_vis text := coalesce(shop_clean(p_appt->>'visibility'), 'public');
  v_title text := left(shop_clean(p_appt->>'title'), 200);
  v_start timestamptz; v_end timestamptz;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_id is null or p_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'invalid id'; end if;
  if v_title is null then raise exception 'Enter what the appointment is for'; end if;
  if v_vis not in ('public', 'personal') then raise exception 'Pick shop or personal'; end if;
  begin v_start := (p_appt->>'starts_at')::timestamptz; exception when others then raise exception 'Start time is not a date and time'; end;
  if v_start is null then raise exception 'Enter the start date and time'; end if;
  if shop_clean(p_appt->>'ends_at') is not null then
    begin v_end := (p_appt->>'ends_at')::timestamptz; exception when others then raise exception 'End time is not a date and time'; end;
    if v_end < v_start then raise exception 'End time is before the start time'; end if;
  end if;
  if shop_clean(p_appt->>'customer_id') is not null and not exists (select 1 from shop_customers where id = p_appt->>'customer_id') then raise exception 'Customer not found'; end if;
  if shop_clean(p_appt->>'bike_id') is not null and not exists (select 1 from shop_bikes where id = p_appt->>'bike_id') then raise exception 'Bike not found'; end if;
  if shop_clean(p_appt->>'job_id') is not null and not exists (select 1 from shop_jobs where id = p_appt->>'job_id') then raise exception 'Job not found'; end if;

  select * into v_old from shop_appointments where id = p_id for update;
  if v_old.id is not null then
    if (v_old.visibility = 'personal' or v_vis = 'personal') and v_old.owner_user_id <> v_uid then
      raise exception 'Only the person who made a personal appointment can change it';
    end if;
    if shop_clean(p_appt->>'expected_updated_at') is not null
       and date_trunc('milliseconds', v_old.updated_at) <> date_trunc('milliseconds', (p_appt->>'expected_updated_at')::timestamptz) then
      raise exception 'This appointment was changed by someone else. Reload it and try again.';
    end if;
    update shop_appointments set title = v_title, starts_at = v_start, ends_at = v_end,
      all_day = coalesce((p_appt->>'all_day')::boolean, false), visibility = v_vis,
      customer_id = shop_clean(p_appt->>'customer_id'), bike_id = shop_clean(p_appt->>'bike_id'), job_id = shop_clean(p_appt->>'job_id'),
      notes = left(shop_clean(p_appt->>'notes'), 2000), cancelled = coalesce((p_appt->>'cancelled')::boolean, false),
      updated_at = now(), updated_by = v_uid
     where id = p_id returning * into v_row;
  else
    insert into shop_appointments (id, title, starts_at, ends_at, all_day, visibility, owner_user_id, customer_id, bike_id, job_id, notes, cancelled, updated_by)
    values (p_id, v_title, v_start, v_end, coalesce((p_appt->>'all_day')::boolean, false), v_vis, v_uid,
      shop_clean(p_appt->>'customer_id'), shop_clean(p_appt->>'bike_id'), shop_clean(p_appt->>'job_id'),
      left(shop_clean(p_appt->>'notes'), 2000), coalesce((p_appt->>'cancelled')::boolean, false), v_uid)
    returning * into v_row;
  end if;
  -- Personal appointments are kept out of the shared audit detail.
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_appointments', p_id, case when v_old.id is null then 'create' else 'update' end, v_uid,
    case when v_vis = 'public' then jsonb_build_object('title', v_title, 'starts_at', v_start, 'cancelled', v_row.cancelled) else '{}'::jsonb end);
  return to_jsonb(v_row);
end $$;
revoke all on function public.shop_save_appointment(text, jsonb) from public, anon;
grant execute on function public.shop_save_appointment(text, jsonb) to authenticated;

-- ---------- my hours (from tech sign-off) ----------
create or replace function public.shop_my_hours()
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with t as (select (now() at time zone 'America/Phoenix') as n),
  b as (select date_trunc('week', n) w, date_trunc('month', n) m, date_trunc('year', n) y from t),
  s as (select hours, (signed_at at time zone 'America/Phoenix') ts, disputed and resolved_at is null as open_dispute
          from shop_labor_signoffs where tech_id = auth.uid())
  select case when not shop_has_staff_access() then null else jsonb_build_object(
    'week', coalesce((select sum(hours) from s, b where ts >= b.w), 0),
    'month', coalesce((select sum(hours) from s, b where ts >= b.m), 0),
    'year', coalesce((select sum(hours) from s, b where ts >= b.y), 0),
    'disputed', (select count(*) from s, b where ts >= b.y and open_dispute)) end;
$$;
revoke all on function public.shop_my_hours() from public, anon;
grant execute on function public.shop_my_hours() to authenticated;

-- ---------- money in vs out ----------
-- In: jobs marked paid (by job date) and payment plan payments received
-- (shop-009, if installed). Out: receipts turned in (by receipt date).
-- Part-paid jobs are counted separately because the shop doesn't record how
-- much of them was paid.
create or replace function public.shop_money_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_jobs numeric; v_jobs_n int; v_part numeric; v_part_n int; v_plans numeric := 0; v_plans_n int := 0;
  v_out numeric; v_out_n int; v_cats jsonb; v_has_plans boolean;
begin
  if not shop_can_see_money() then raise exception 'Only the payroll manager or staff with money access can see money'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Pick a date range'; end if;
  select coalesce(sum(total_amount), 0), count(*) into v_jobs, v_jobs_n from shop_jobs
   where payment_status = 'paid' and job_date between p_from and p_to;
  select coalesce(sum(total_amount), 0), count(*) into v_part, v_part_n from shop_jobs
   where payment_status = 'partial' and job_date between p_from and p_to;
  v_has_plans := to_regclass('public.shop_plan_payments') is not null;
  if v_has_plans then
    execute 'select coalesce(sum(amount), 0), count(*) from public.shop_plan_payments where received_date between $1 and $2'
      into v_plans, v_plans_n using p_from, p_to;
  end if;
  select coalesce(sum(amount), 0), count(*) into v_out, v_out_n from shop_documents
   where doc_type = 'receipt' and not archived and doc_date between p_from and p_to;
  select coalesce(jsonb_agg(jsonb_build_object('category', c, 'amount', a, 'count', n) order by a desc), '[]'::jsonb) into v_cats
    from (select coalesce(nullif(data->>'category', ''), 'Other') c, sum(amount) a, count(*) n from shop_documents
           where doc_type = 'receipt' and not archived and doc_date between p_from and p_to group by 1) x;
  return jsonb_build_object('from', p_from, 'to', p_to,
    'in_jobs', v_jobs, 'in_jobs_count', v_jobs_n, 'part_paid_total', v_part, 'part_paid_count', v_part_n,
    'in_plans', v_plans, 'in_plans_count', v_plans_n, 'plans_installed', v_has_plans,
    'money_in', v_jobs + v_plans, 'money_out', v_out, 'out_count', v_out_n, 'out_by_category', v_cats,
    'net', v_jobs + v_plans - v_out);
end $$;
revoke all on function public.shop_money_summary(date, date) from public, anon;
grant execute on function public.shop_money_summary(date, date) to authenticated;

-- Who am I on the shop staff list (name and what I may see), for the home page.
create or replace function public.shop_me()
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('user_id', user_id, 'name', display_name, 'payroll_manager', payroll_manager,
    'money', payroll_manager or money_access)
  from shop_staff where user_id = auth.uid() and active;
$$;
revoke all on function public.shop_me() from public, anon;
grant execute on function public.shop_me() to authenticated;

notify pgrst, 'reload schema';
