-- Undo shop-016 (Dads Don't Quit points). Deletes every point, held order and
-- gift record it made. Run only if you want them gone.
drop function if exists public.ride_dads_handle_order(text, text);
drop function if exists public.ride_dads_members();
drop function if exists public.ride_dads_give_gift(text, numeric, text);
drop function if exists public.ride_dads_add(text, text, numeric, int, text);
drop function if exists public.ride_record_dads_order(jsonb);
drop function if exists public.ride_my_dads();
drop function if exists public.ride_dads_standing(uuid);
drop table if exists public.ride_dads_gifts_given;
drop table if exists public.ride_dads_orders_held;
drop table if exists public.ride_dads_points;
drop table if exists public.ride_dads_tiers;
