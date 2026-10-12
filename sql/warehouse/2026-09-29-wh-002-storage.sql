-- Fangs Warehouse — photo storage buckets. NOT YET APPLIED. Run after wh-001.
--
-- wh-originals   private. Untouched phone photos and video. Staff read only.
-- wh-marketplace public read. Resized copies with EXIF/GPS removed (the phone re-encodes
--                them). These URLs never change and are what Shopify imports.
-- Paths: items/{SKU}/{slot}/{media_id}.{ext}. Files are never overwritten or deleted by
-- the app: a replacement is a new file, and the old one is hidden in wh_media.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('wh-originals', 'wh-originals', false, 209715200,
     array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime']),
  ('wh-marketplace', 'wh-marketplace', true, 10485760, array['image/jpeg','image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists wh_media_staff_read on storage.objects;
create policy wh_media_staff_read on storage.objects for select to authenticated
  using (bucket_id in ('wh-originals','wh-marketplace') and public.wh_is_staff());

drop policy if exists wh_media_staff_upload on storage.objects;
create policy wh_media_staff_upload on storage.objects for insert to authenticated
  with check (
    bucket_id in ('wh-originals','wh-marketplace')
    and public.wh_is_staff()
    and name ~ '^items/SIC-[0-9]{6,}/[a-z_]+/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif|mp4|mov)$'
  );
-- No update or delete policy: stored files are permanent.

insert into public.wh_schema_migrations (name) values ('2026-09-29-wh-002-storage') on conflict do nothing;

commit;
