-- shop-010: one document library for every shop form.
--   * shop_documents holds the forms that have no table of their own:
--     Syndicate meeting notes, customer intake forms, legal documents and
--     anything added later. Estimates (shop_jobs) and payment plans /
--     finance agreements (shop_payment_plans, shop-009) stay in their own
--     tables; the library page lists them beside these, so nothing is
--     stored twice.
--   * A legal document can be typed from a template, have a file attached
--     (PDF or picture in the private shop-documents bucket), or both.
--   * A customer intake form creates or updates the customer and bike
--     records in the same save, and links the form to them.
--   * Documents are never deleted from the app, only archived.
-- Additive and safe to re-run. Run AFTER shop-004 (needs shop_clean,
-- shop_int). Does not need shop-008 or shop-009. NOT yet run on the live
-- database: Tyler runs it.

-- Private bucket for attached files. Staff only; never public.
insert into storage.buckets (id, name, public)
values ('shop-documents', 'shop-documents', false)
on conflict (id) do update set public = false;

drop policy if exists "Staff can upload shop documents" on storage.objects;
create policy "Staff can upload shop documents" on storage.objects for insert
  with check (bucket_id = 'shop-documents' and public.shop_has_staff_access());
drop policy if exists "Staff can view shop documents" on storage.objects;
create policy "Staff can view shop documents" on storage.objects for select
  using (bucket_id = 'shop-documents' and public.shop_has_staff_access());

create table if not exists public.shop_documents (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{6,64}$'),
  doc_type text not null check (doc_type in ('meeting', 'intake', 'legal', 'other')),
  title text not null,
  customer_id text references public.shop_customers(id) on delete set null,
  bike_id text references public.shop_bikes(id) on delete set null,
  job_id text references public.shop_jobs(id) on delete set null,
  doc_date date,
  data jsonb not null default '{}'::jsonb,
  file_path text,
  file_name text,
  file_type text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null
);
create index if not exists shop_documents_type_date on public.shop_documents (doc_type, doc_date desc);
create index if not exists shop_documents_customer on public.shop_documents (customer_id);

alter table public.shop_documents enable row level security;
drop policy if exists "Staff can view shop documents" on public.shop_documents;
create policy "Staff can view shop documents" on public.shop_documents
  for select using (public.shop_has_staff_access());
revoke all on public.shop_documents from anon;
revoke all on public.shop_documents from authenticated;
grant select on public.shop_documents to authenticated;

-- Shared checks and upsert for one document. Internal: called only by the
-- two functions below.
create or replace function public.shop_put_document(p_id text, p_type text, p_doc jsonb,
  p_customer_id text, p_bike_id text)
returns public.shop_documents
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_row public.shop_documents; v_found boolean;
  v_title text; v_data jsonb; v_job text; v_date date; v_file text; v_fname text; v_ftype text;
begin
  if p_id is null or p_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'invalid document id'; end if;
  if p_type not in ('meeting', 'intake', 'legal', 'other') then raise exception 'Unknown document type'; end if;
  if p_doc is null or jsonb_typeof(p_doc) <> 'object' then raise exception 'document must be an object'; end if;
  v_title := left(shop_clean(p_doc->>'title'), 200);
  if v_title is null then raise exception 'Give the document a title'; end if;
  v_data := coalesce(p_doc->'data', '{}'::jsonb);
  if jsonb_typeof(v_data) <> 'object' then raise exception 'document data must be an object'; end if;
  if length(v_data::text) > 200000 then raise exception 'This document is too long to save (200,000 characters max)'; end if;
  v_job := shop_clean(p_doc->>'job_id');
  if p_customer_id is not null and not exists (select 1 from shop_customers where id = p_customer_id) then raise exception 'customer not found'; end if;
  if p_bike_id is not null and not exists (select 1 from shop_bikes where id = p_bike_id) then raise exception 'bike not found'; end if;
  if v_job is not null and not exists (select 1 from shop_jobs where id = v_job) then raise exception 'job not found'; end if;
  if shop_clean(p_doc->>'doc_date') is not null then
    begin v_date := (p_doc->>'doc_date')::date; exception when others then raise exception 'Document date is not a date'; end;
  end if;
  v_file := shop_clean(p_doc->>'file_path');
  if v_file is not null then
    if v_file !~ ('^docs/' || p_id || '/[A-Za-z0-9._-]{1,120}$') then raise exception 'invalid file path'; end if;
    if not exists (select 1 from storage.objects where bucket_id = 'shop-documents' and name = v_file) then
      raise exception 'The attached file was not uploaded';
    end if;
    v_fname := left(shop_clean(p_doc->>'file_name'), 200);
    v_ftype := left(shop_clean(p_doc->>'file_type'), 100);
  end if;

  select * into v_row from shop_documents where id = p_id for update;
  v_found := found;
  if v_found then
    if v_row.doc_type <> p_type then raise exception 'A document cannot change type'; end if;
    if shop_clean(p_doc->>'expected_updated_at') is not null
       and date_trunc('milliseconds', v_row.updated_at) <> date_trunc('milliseconds', (p_doc->>'expected_updated_at')::timestamptz) then
      raise exception 'This document was changed by someone else. Reload it and try again.';
    end if;
    update shop_documents set title = v_title, customer_id = p_customer_id, bike_id = p_bike_id, job_id = v_job,
      doc_date = v_date, data = v_data,
      file_path = coalesce(v_file, file_path), file_name = case when v_file is null then file_name else v_fname end,
      file_type = case when v_file is null then file_type else v_ftype end,
      updated_at = now(), updated_by = v_uid
    where id = p_id returning * into v_row;
  else
    insert into shop_documents (id, doc_type, title, customer_id, bike_id, job_id, doc_date, data,
      file_path, file_name, file_type, created_by, updated_by)
    values (p_id, p_type, v_title, p_customer_id, p_bike_id, v_job, v_date, v_data, v_file, v_fname, v_ftype, v_uid, v_uid)
    returning * into v_row;
  end if;
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_documents', p_id, case when v_found then 'update' else 'create' end, v_uid,
          jsonb_build_object('type', p_type, 'title', v_title));
  return v_row;
end $$;
revoke all on function public.shop_put_document(text, text, jsonb, text, text) from public, anon, authenticated;

-- Save a meeting form, legal document or other document.
-- p_doc: {title, doc_date, customer_id, bike_id, job_id, data, file_path,
--         file_name, file_type, expected_updated_at}
create or replace function public.shop_save_document(p_id text, p_type text, p_doc jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.shop_documents;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_type = 'intake' then raise exception 'Save intake forms with the intake form'; end if;
  v_row := shop_put_document(p_id, p_type, p_doc, shop_clean(p_doc->>'customer_id'), shop_clean(p_doc->>'bike_id'));
  return to_jsonb(v_row);
end $$;
revoke all on function public.shop_save_document(text, text, jsonb) from public, anon;
grant execute on function public.shop_save_document(text, text, jsonb) to authenticated;

-- Save a customer intake form. Creates or updates the customer (and the
-- bike, when one is given) and links the form to them, all in one step.
create or replace function public.shop_save_intake(p_doc_id text, p_customer_id text, p_customer jsonb,
  p_bike_id text, p_bike jsonb, p_doc jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_owner text; v_bike_found boolean; v_row public.shop_documents;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_customer_id is null or p_customer_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'invalid customer id'; end if;
  if p_customer is null or shop_clean(p_customer->>'name') is null then raise exception 'Customer name is required'; end if;
  if p_bike is not null and (p_bike_id is null or p_bike_id !~ '^[A-Za-z0-9_-]{6,64}$') then raise exception 'invalid bike id'; end if;
  if exists (select 1 from shop_documents where id = p_doc_id and doc_type <> 'intake') then raise exception 'A document cannot change type'; end if;

  insert into shop_customers (id, name, phone, email, address, created_by, updated_by)
  values (p_customer_id, shop_clean(p_customer->>'name'), shop_clean(p_customer->>'phone'),
          shop_clean(p_customer->>'email'), shop_clean(p_customer->>'address'), v_uid, v_uid)
  on conflict (id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email,
    address = excluded.address, updated_at = now(), updated_by = v_uid;

  if p_bike is not null then
    select customer_id, true into v_owner, v_bike_found from shop_bikes where id = p_bike_id;
    if v_bike_found and v_owner is not null and v_owner <> p_customer_id then
      raise exception 'That bike is on a different customer''s record';
    end if;
    insert into shop_bikes (id, customer_id, vin, make, model, year, mileage, created_by, updated_by)
    values (p_bike_id, p_customer_id, upper(shop_clean(p_bike->>'vin')), shop_clean(p_bike->>'make'),
            shop_clean(p_bike->>'model'), shop_int(p_bike->>'year', 'Year'), shop_int(p_bike->>'mileage', 'Mileage'), v_uid, v_uid)
    on conflict (id) do update set customer_id = excluded.customer_id, vin = excluded.vin, make = excluded.make,
      model = excluded.model, year = excluded.year, mileage = excluded.mileage, updated_at = now(), updated_by = v_uid;
  end if;

  v_row := shop_put_document(p_doc_id, 'intake', p_doc, p_customer_id, case when p_bike is null then null else p_bike_id end);
  return to_jsonb(v_row);
end $$;
revoke all on function public.shop_save_intake(text, text, jsonb, text, jsonb, jsonb) from public, anon;
grant execute on function public.shop_save_intake(text, text, jsonb, text, jsonb, jsonb) to authenticated;

-- Archive or bring back a document. Nothing is deleted from the app.
create or replace function public.shop_archive_document(p_id text, p_archived boolean)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  update shop_documents set archived = coalesce(p_archived, true), updated_at = now(), updated_by = auth.uid() where id = p_id;
  if not found then raise exception 'document not found'; end if;
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_documents', p_id, case when coalesce(p_archived, true) then 'archive' else 'unarchive' end, auth.uid(), '{}'::jsonb);
  return true;
end $$;
revoke all on function public.shop_archive_document(text, boolean) from public, anon;
grant execute on function public.shop_archive_document(text, boolean) to authenticated;
notify pgrst, 'reload schema';
