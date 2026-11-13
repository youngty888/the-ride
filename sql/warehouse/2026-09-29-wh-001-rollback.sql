-- Rollback for wh-001 and wh-002. ONLY for use before real inventory exists.
-- After the pilot starts, fix forward instead: never drop warehouse data.
-- Take a pg_dump first. Uploaded files in the two buckets must be removed through the
-- Storage API/Studio before the bucket rows can be deleted.

begin;
drop policy if exists wh_media_staff_read on storage.objects;
drop policy if exists wh_media_staff_upload on storage.objects;
delete from storage.buckets where id in ('wh-originals','wh-marketplace')
  and not exists (select 1 from storage.objects where bucket_id in ('wh-originals','wh-marketplace'));

drop table if exists public.wh_audit_log, public.wh_exports, public.wh_moves, public.wh_reviews, public.wh_media,
  public.wh_measurements, public.wh_fitments, public.wh_item_financials, public.wh_items, public.wh_locations,
  public.wh_category_measurements, public.wh_engine_families, public.wh_systems, public.wh_staff_roles,
  public.wh_staff, public.wh_schema_migrations cascade;
drop sequence if exists public.wh_sku_seq;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'wh\_%'
  loop execute format('drop function if exists %s cascade', f.sig); end loop;
end $$;
commit;
