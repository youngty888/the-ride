-- Rollback for shop-011-admin-home.sql. Removes the calendar, receipts,
-- pay stubs, consignment, money and hours functions, and puts the document
-- library back to how shop-010 left it. Keeps saved data: the appointments
-- table is dropped only here, so export it first if it holds anything you
-- need. Receipt, pay stub and consignment rows stay in shop_documents (the
-- extra columns and allowed types are left in place so nothing is lost),
-- but pay stubs become visible to all staff again, so archive or remove
-- them before rolling back if that matters. Files stay in the bucket.
drop function if exists public.shop_money_summary(date, date);
drop function if exists public.shop_my_hours();
drop function if exists public.shop_me();
drop function if exists public.shop_save_appointment(text, jsonb);
drop table if exists public.shop_appointments;
drop function if exists public.shop_save_consignment(text, text, jsonb, text, jsonb, jsonb);
drop function if exists public.shop_upsert_customer_bike(text, jsonb, text, jsonb);
drop function if exists public.shop_save_paystub(text, uuid, jsonb);
drop function if exists public.shop_save_receipt(text, jsonb);
drop function if exists public.shop_doc_amount(text, boolean);

drop policy if exists "Staff can upload shop documents" on storage.objects;
create policy "Staff can upload shop documents" on storage.objects for insert
  with check (bucket_id = 'shop-documents' and public.shop_has_staff_access());
drop policy if exists "Staff can view shop documents" on storage.objects;
create policy "Staff can view shop documents" on storage.objects for select
  using (bucket_id = 'shop-documents' and public.shop_has_staff_access());
drop policy if exists "Staff can view shop documents" on public.shop_documents;
create policy "Staff can view shop documents" on public.shop_documents
  for select using (public.shop_has_staff_access());
drop function if exists public.shop_can_upload_document_file(text);
drop function if exists public.shop_can_read_document_file(text);
drop function if exists public.shop_can_read_document(text, uuid);
drop function if exists public.shop_can_see_money();

create or replace function public.shop_save_document(p_id text, p_type text, p_doc jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.shop_documents;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_type = 'intake' then raise exception 'Save intake forms with the intake form'; end if;
  if p_type not in ('meeting', 'legal', 'other') then raise exception 'Unknown document type'; end if;
  v_row := shop_put_document(p_id, p_type, p_doc, shop_clean(p_doc->>'customer_id'), shop_clean(p_doc->>'bike_id'));
  return to_jsonb(v_row);
end $$;

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

notify pgrst, 'reload schema';
