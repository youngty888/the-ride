-- Rollback for shop-010-documents.sql. Drops the document library table and
-- its functions. Files in the shop-documents bucket are left in place;
-- remove them in the storage dashboard if wanted.
drop function if exists public.shop_archive_document(text, boolean);
drop function if exists public.shop_save_intake(text, text, jsonb, text, jsonb, jsonb);
drop function if exists public.shop_save_document(text, text, jsonb);
drop function if exists public.shop_put_document(text, text, jsonb, text, text);
drop table if exists public.shop_documents;
drop policy if exists "Staff can upload shop documents" on storage.objects;
drop policy if exists "Staff can view shop documents" on storage.objects;
