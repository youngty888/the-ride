-- Rollback for shop-016-parts-on-order-closed.sql.
-- Removes the new functions. The new columns (closed_at, closed_by,
-- tracking_number, eta) are left in place so no saved data is lost; the older
-- page simply ignores them.
drop function if exists public.shop_set_part_received(text, boolean);
drop function if exists public.shop_save_part_order(jsonb);
drop function if exists public.shop_set_job_closed(text, boolean);
drop function if exists public.shop_date(text, text);
drop index if exists public.shop_part_orders_open_idx;
