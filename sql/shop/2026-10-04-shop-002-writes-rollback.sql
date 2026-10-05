-- Rollback for shop-002-writes.sql
drop function if exists public.shop_set_bike_photos(text, jsonb);
drop function if exists public.shop_upsert_part_order(jsonb);
drop function if exists public.shop_set_job_line_items(text, jsonb);
drop function if exists public.shop_submit_estimate(text, text, jsonb, text, jsonb, jsonb);
