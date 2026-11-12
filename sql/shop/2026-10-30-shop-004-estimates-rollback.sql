-- Rollback for shop-004-estimates.sql. Removes the new functions and settings
-- table. The added job columns are LEFT IN PLACE on purpose (dropping them
-- would delete estimate numbers, work descriptions and customer notes).
-- Restores 003's public photo read policy.
drop function if exists public.shop_save_estimate(text, text, jsonb, text, jsonb, jsonb, jsonb);
drop function if exists public.shop_set_job_status(text, text);
drop function if exists public.shop_update_settings(jsonb);
drop function if exists public.shop_refresh_customer_rollup(text);
drop function if exists public.shop_int(text, text);
drop function if exists public.shop_num(text, text, numeric);
drop function if exists public.shop_clean(text);
drop table if exists public.shop_settings;
drop policy if exists "Staff can view bike photos" on storage.objects;
create policy "Anyone can view bike photos" on storage.objects for select using (bucket_id = 'shop-bike-photos');
update storage.buckets set public = true where id = 'shop-bike-photos';
