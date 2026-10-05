-- DRAFT — NOT APPLIED. Creates the storage bucket bike photos upload to.
-- Public read (photos are shown in the staff UI via plain <img> tags), write
-- restricted to staff via the policy below. Mirrors how Warehouse's listing
-- photos bucket is set up (wh-002-storage.sql), not yet read in this session
-- but same Supabase storage pattern.

insert into storage.buckets (id, name, public)
values ('shop-bike-photos', 'shop-bike-photos', true)
on conflict (id) do nothing;

create policy "Staff can upload bike photos"
  on storage.objects for insert
  with check (bucket_id = 'shop-bike-photos' and public.shop_has_staff_access());

create policy "Staff can update bike photos"
  on storage.objects for update
  using (bucket_id = 'shop-bike-photos' and public.shop_has_staff_access());

create policy "Anyone can view bike photos"
  on storage.objects for select
  using (bucket_id = 'shop-bike-photos');
