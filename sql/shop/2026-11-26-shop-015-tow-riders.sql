-- shop-015: tow requests from signed-in RIDE riders. Tyler runs it in the
-- server's Supabase SQL editor. Needs shop-014 first. Additive and safe to re-run.
--   * Anyone can still ask for a tow on ride.siccycles.com/tow/ without an account.
--   * A signed-in rider gets the form filled in: name, email and phone, and a
--     pick list of the bikes in their Garage. The tow is saved with their
--     account, so the next tow fills in their phone too.
--   * Riders only ever get their OWN details back. They never see the board or
--     anyone else's tow: the board is still only for the tow admin (Tyler) and
--     the people on the tow crew list, checked in the database, not just hidden
--     on the page.
--
-- PRECHECK (run first, on its own). Every line should say true:
--   select to_regprocedure('public.shop_tow_request(jsonb)') is not null as tow_board_installed,
--          to_regprocedure('public.shop_clean(text)') is not null as shop_clean_installed,
--          to_regclass('public.rider_app_state') is not null as garage_table_found;
--
-- AFTER (optional checks):
--   -- Both of these should return 0 rows: nobody but the board functions can read tows.
--   select * from pg_policies where tablename = 'shop_tow_requests';
--   select grantee, privilege_type from information_schema.role_table_grants
--     where table_name = 'shop_tow_requests' and grantee in ('anon', 'authenticated');
--   -- The latest tows, to see that a test request landed:
--   select ref, created_at, customer_name, source, status, rider_id is not null as from_rider_account
--     from public.shop_tow_requests order by created_at desc limit 5;

-- ===================== COLUMNS =====================
alter table public.shop_tow_requests add column if not exists rider_id uuid references auth.users(id) on delete set null;
alter table public.shop_tow_requests add column if not exists bike_id text;   -- Garage bike id (app-side id, not a key)
create index if not exists shop_tow_requests_rider_idx on public.shop_tow_requests (rider_id, created_at desc);

-- Same lock as shop-014, said again so this file alone leaves it locked:
-- no direct reads or writes from the browser, only the checked functions.
alter table public.shop_tow_requests enable row level security;
revoke all on public.shop_tow_requests from anon, authenticated;

-- ===================== MY DETAILS =====================
-- For the signed-in rider only: their name, email, last phone used on a tow,
-- and their Garage bikes (just the fields a tow needs, no photos).
create or replace function public.shop_tow_my_info()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_email text; v_payload jsonb; v_last shop_tow_requests; v_bikes jsonb := '[]'::jsonb;
begin
  if v_uid is null then return null; end if;
  select email into v_email from auth.users where id = v_uid;
  if to_regclass('public.rider_app_state') is not null then
    execute 'select payload from public.rider_app_state where owner_id = $1 limit 1' into v_payload using v_uid;
  end if;
  if jsonb_typeof(v_payload -> 'bikes') = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', left(shop_clean(b ->> 'id'), 64),
        'year', case when (b ->> 'year') ~ '^\d{4}$' then (b ->> 'year')::int end,
        'make', left(shop_clean(b ->> 'make'), 60),
        'model', left(shop_clean(b ->> 'model'), 60),
        'color', left(shop_clean(b ->> 'color'), 40),
        'nickname', left(shop_clean(b ->> 'nickname'), 60)) order by n), '[]'::jsonb)
      into v_bikes
    from jsonb_array_elements(v_payload -> 'bikes') with ordinality as t(b, n)
    where jsonb_typeof(b) = 'object' and n <= 25;
  end if;
  select * into v_last from shop_tow_requests where rider_id = v_uid order by created_at desc limit 1;
  return jsonb_build_object(
    'email', coalesce(v_last.email, v_email),
    'name', coalesce(v_last.customer_name, nullif(left(shop_clean(v_payload -> 'profile' ->> 'name'), 120), 'Rider')),
    'phone', v_last.phone,
    'bikes', v_bikes);
end $$;
revoke all on function public.shop_tow_my_info() from public, anon;
grant execute on function public.shop_tow_my_info() to authenticated;

-- ===================== ASK FOR A TOW =====================
-- Same as shop-014, plus: a signed-in rider's tow is saved with their account
-- and the Garage bike they picked.
create or replace function public.shop_tow_request(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_phone text; v_type text := shop_clean(p->>'vehicle_type'); v_zone text := shop_clean(p->>'zone');
  v_to_shop boolean := coalesce((p->>'to_shop')::boolean, false); v_drop text := left(shop_clean(p->>'dropoff_address'), 300);
  v_row shop_tow_requests; v_link text; v_uid uuid := auth.uid();
begin
  if shop_clean(p->>'customer_name') is null then raise exception 'Enter your name'; end if;
  v_phone := shop_tow_phone(p->>'phone');
  if v_type is null or v_type not in ('motorcycle', 'atv', 'golf_cart', 'side_by_side') then
    raise exception 'We tow motorcycles, ATVs, golf carts and side-by-sides only'; end if;
  if v_zone is null or v_zone not in ('tucson', 'sierra_vista', 'phoenix', 'other') then raise exception 'Pick the area for pickup'; end if;
  if shop_clean(p->>'pickup_address') is null then raise exception 'Enter where to pick it up'; end if;
  if not v_to_shop and v_drop is null then raise exception 'Enter where it goes, or pick SIC Cycles'; end if;
  if coalesce((p->>'agree')::boolean, false) is not true then raise exception 'Read and agree to the waiver to continue'; end if;
  -- Keep the page from being flooded.
  if (select count(*) from shop_tow_requests where phone = v_phone and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'We already have your request. Call or text us if you need to change it.'; end if;
  if (select count(*) from shop_tow_requests where created_by is null and created_at > now() - interval '10 minutes') >= 20 then
    raise exception 'Too many requests right now. Call or text us.'; end if;
  insert into shop_tow_requests (source, customer_name, phone, email, vehicle_type, vehicle, vehicle_runs,
    pickup_address, dropoff_address, to_shop, zone, price, rider_count, notes, status, rider_id, bike_id)
  values ('web', left(shop_clean(p->>'customer_name'), 120), v_phone, left(shop_clean(p->>'email'), 200), v_type,
    left(shop_clean(p->>'vehicle'), 120), (p->>'vehicle_runs')::boolean,
    left(shop_clean(p->>'pickup_address'), 300), case when v_to_shop then null else v_drop end, v_to_shop, v_zone,
    shop_tow_quote(v_zone, v_to_shop, 0), case when coalesce((p->>'ride_along')::boolean, false) then 1 else 0 end,
    left(shop_clean(p->>'notes'), 1000), 'new',
    v_uid, case when v_uid is not null then left(shop_clean(p->>'bike_id'), 64) end)
  returning * into v_row;
  perform shop_tow_put_waiver(v_row.id, p->>'waiver_name', p->>'signature', p->>'waiver_version');
  select case v_zone when 'tucson' then pay_link_tucson when 'sierra_vista' then pay_link_sierra_vista
    when 'phoenix' then pay_link_phoenix end into v_link from shop_tow_settings where id = 1;
  return jsonb_build_object('ref', v_row.ref, 'price', v_row.price, 'zone', v_zone,
    'price_is_start', v_zone = 'tucson', 'pay_link', v_link);
end $$;
revoke all on function public.shop_tow_request(jsonb) from public;
grant execute on function public.shop_tow_request(jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
