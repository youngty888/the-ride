-- Undo shop-015 (tow requests from signed-in riders). Keeps every tow.
-- After this, run the shop_tow_request function from shop-014 again
-- (sql/shop/2026-11-25-shop-014-tow.sql) so the page keeps working.
drop function if exists public.shop_tow_my_info();
drop index if exists public.shop_tow_requests_rider_idx;
alter table public.shop_tow_requests drop column if exists bike_id;
alter table public.shop_tow_requests drop column if exists rider_id;
notify pgrst, 'reload schema';
