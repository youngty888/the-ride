-- Rollback for shop-003-storage.sql
drop policy if exists "Anyone can view bike photos" on storage.objects;
drop policy if exists "Staff can update bike photos" on storage.objects;
drop policy if exists "Staff can upload bike photos" on storage.objects;
delete from storage.buckets where id = 'shop-bike-photos';
