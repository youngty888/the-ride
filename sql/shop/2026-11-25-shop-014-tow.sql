-- shop-014: Moto Tow board. DRAFT, NOT YET RUN on the live database: Tyler runs it.
--   * Customers ask for a tow on the public page (ride.siccycles.com/tow/),
--     read the waiver and sign it there. Calls that come in by phone, text or
--     email are added on the board by the crew, and the customer signs the
--     waiver from a link.
--   * Motorcycles, ATVs, golf carts and side-by-sides only.
--   * Pay first: nobody can start a tow until it is marked paid AND the waiver
--     is signed.
--   * Tow crew: people on shop_tow_crew can sign in, see the board, go on duty,
--     claim a tow as driver, or ride along as navigator. The crew list is its
--     own list, so a tow driver does not get to see the rest of the shop.
--   * Crew pay is worked out when a tow is marked delivered and frozen on the
--     tow, so a later change to the percents never changes past pay. The pay
--     page totals it for any date range, for writing checks / pay stubs.
--   * Tyler (the shop payroll manager, shop-008) runs the settings and sees
--     everyone's pay. Each crew member sees only their own.
--   * Prices are worked out here, never taken from the browser. The same math
--     is in shop/tow-calc.js and the tests keep them the same.
-- Needs shop-001, shop-004 and shop-008 first. Additive and safe to re-run.
--
-- Add a crew member (they need a RIDE login first: Supabase > Authentication >
-- Users > Add user, tick Auto Confirm). Replace the email and name:
--   insert into public.shop_tow_crew (user_id, display_name)
--     select id, 'Garrett' from auth.users where lower(email) = lower('<email>')
--     on conflict (user_id) do update set active = true, display_name = excluded.display_name;
-- Remove later (keeps their history):
--   update public.shop_tow_crew set active = false where display_name = '<name>';

-- ===================== TABLES =====================
create table if not exists public.shop_tow_crew (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  active boolean not null default true,
  on_duty boolean not null default false,
  alert_phone text,                 -- texted when a new tow comes in while on duty
  alert_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shop_tow_settings (
  id integer primary key default 1 check (id = 1),
  solo_pct numeric(5,2) not null default 30 check (solo_pct between 0 and 100),   -- crew share, one person
  pair_pct numeric(5,2) not null default 40 check (pair_pct between 0 and 100),   -- crew share, driver + navigator
  driver_pct numeric(5,2) not null default 50 check (driver_pct between 0 and 100), -- driver's part of the pair share
  pay_link_tucson text,             -- fixed payment links shown after a request (Square / Stripe / PayPal)
  pay_link_sierra_vista text,
  pay_link_phoenix text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.shop_tow_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.shop_tow_waivers (
  version text primary key,
  body text not null,
  created_at timestamptz not null default now()
);
-- DRAFT wording. Have a lawyer read it before the page goes live.
insert into public.shop_tow_waivers (version, body) values ('2026-11-25', $w$Moto Tow transport agreement and release

1. I own this vehicle or have the owner's permission to have it towed.
2. Moto Tow tows motorcycles, ATVs, golf carts and side-by-sides only. Payment is due in full before pickup. No pickup until paid.
3. I have told Moto Tow about any damage, leaks, missing parts or loose items I know of. Moto Tow is not responsible for damage that was already there, for items left on or in the vehicle, or for mechanical problems that come from the vehicle's own condition.
4. Moto Tow will strap and secure the vehicle with care. Its liability for damage caused during loading, transport or unloading is limited to the amount its insurance pays.
5. If I ride along, I do so at my own risk.
6. If the pickup or drop-off spot cannot be reached safely, Moto Tow may stop and call me. A cancelled tow is refunded except for any distance already driven.
7. I agree that typing my name and signing below is my signature.$w$)
on conflict (version) do nothing;

create table if not exists public.shop_tow_requests (
  id text primary key default replace(gen_random_uuid()::text, '-', ''),
  ref text not null unique default ('TOW-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6))),
  status text not null default 'new'
    check (status in ('new', 'quoted', 'paid', 'en_route', 'delivered', 'cancelled')),
  source text not null default 'web' check (source in ('web', 'phone', 'text', 'email')),
  customer_name text not null,
  phone text not null,
  email text,
  vehicle_type text not null check (vehicle_type in ('motorcycle', 'atv', 'golf_cart', 'side_by_side')),
  vehicle text,                      -- year make model
  vehicle_runs boolean,
  pickup_address text not null,
  dropoff_address text,              -- null when going to SIC Cycles
  to_shop boolean not null default false,
  zone text not null check (zone in ('tucson', 'sierra_vista', 'phoenix', 'other')),
  miles numeric(6,1),                -- one-way miles from the shop, set by crew
  price numeric(10,2),               -- null until known (other zone)
  rider_count integer not null default 0 check (rider_count between 0 and 1),   -- customer rides along
  notes text,
  -- waiver
  sign_token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  waiver_version text references public.shop_tow_waivers(version),
  waiver_name text,
  waiver_signature text,             -- PNG data URL from the signature pad
  waiver_signed_at timestamptz,
  waiver_ip text,
  waiver_agent text,
  -- payment
  paid_at timestamptz,
  paid_method text,
  paid_ref text,
  marked_paid_by uuid,
  refund_due boolean not null default false,
  -- crew
  driver_id uuid references auth.users(id),
  navigator_id uuid references auth.users(id),
  driver_pay numeric(10,2),          -- frozen at delivery
  navigator_pay numeric(10,2),
  started_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,                   -- null for the public page
  updated_at timestamptz not null default now(),
  check (driver_id is null or navigator_id is null or driver_id <> navigator_id)
);
create index if not exists shop_tow_requests_status_idx on public.shop_tow_requests (status);
create index if not exists shop_tow_requests_delivered_idx on public.shop_tow_requests (delivered_at);
create index if not exists shop_tow_requests_phone_idx on public.shop_tow_requests (phone, created_at);

-- Nobody reads or writes these tables directly. Everything goes through the
-- functions below, which check who is asking.
alter table public.shop_tow_crew enable row level security;
alter table public.shop_tow_settings enable row level security;
alter table public.shop_tow_waivers enable row level security;
alter table public.shop_tow_requests enable row level security;
revoke all on public.shop_tow_crew, public.shop_tow_settings, public.shop_tow_waivers, public.shop_tow_requests from anon, authenticated;

-- ===================== WHO MAY DO WHAT =====================
create or replace function public.shop_tow_is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select shop_is_payroll_manager() $$;

create or replace function public.shop_tow_access()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from shop_tow_crew where user_id = auth.uid() and active) or shop_is_payroll_manager();
$$;
revoke all on function public.shop_tow_is_admin(), public.shop_tow_access() from public, anon;
grant execute on function public.shop_tow_is_admin(), public.shop_tow_access() to authenticated;

create or replace function public.shop_tow_name(p uuid)
returns text language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select display_name from shop_tow_crew where user_id = p),
                  (select display_name from shop_staff where user_id = p));
$$;
revoke all on function public.shop_tow_name(uuid) from public, anon, authenticated;

-- ===================== PRICE =====================
-- Same math as shop/tow-calc.js quote().
create or replace function public.shop_tow_quote(p_zone text, p_to_shop boolean, p_miles numeric)
returns numeric language sql immutable set search_path = public, pg_temp
as $$
  select case p_zone
    when 'tucson' then (case when p_to_shop then 100 else 125 end)
                       + greatest(0, ceil(coalesce(p_miles, 0)) - 15) * 3.50
    when 'sierra_vista' then case when p_to_shop then 250 else 295 end
    when 'phoenix' then case when p_to_shop then 375 else 425 end
    else null end::numeric(10,2);
$$;
grant execute on function public.shop_tow_quote(text, boolean, numeric) to anon, authenticated;

-- Same math as shop/tow-calc.js crewPay().
create or replace function public.shop_tow_crew_pay(p_price numeric, p_navigator boolean,
  p_solo numeric, p_pair numeric, p_driver numeric, out driver numeric, out navigator numeric)
language plpgsql immutable set search_path = public, pg_temp
as $$
declare v_pool numeric;
begin
  if not p_navigator then
    driver := round(coalesce(p_price, 0) * p_solo / 100, 2); navigator := 0; return;
  end if;
  v_pool := round(coalesce(p_price, 0) * p_pair / 100, 2);
  driver := round(v_pool * p_driver / 100, 2);
  navigator := v_pool - driver;
end $$;
revoke all on function public.shop_tow_crew_pay(numeric, boolean, numeric, numeric, numeric) from public, anon, authenticated;

-- ===================== HELPERS =====================
create or replace function public.shop_tow_phone(p text)
returns text language plpgsql immutable set search_path = public, pg_temp
as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if length(d) = 11 and left(d, 1) = '1' then d := substr(d, 2); end if;
  if length(d) <> 10 then raise exception 'Enter a 10-digit phone number'; end if;
  return '(' || substr(d, 1, 3) || ') ' || substr(d, 4, 3) || '-' || substr(d, 7);
end $$;

create or replace function public.shop_tow_header(p_name text)
returns text language plpgsql stable set search_path = public, pg_temp
as $$
begin
  return left(nullif(current_setting('request.headers', true), '')::json ->> p_name, 200);
exception when others then return null;
end $$;

-- Checks a signature and stores it on one request.
create or replace function public.shop_tow_put_waiver(p_id text, p_name text, p_signature text, p_version text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_name text := left(shop_clean(p_name), 120);
begin
  if v_name is null then raise exception 'Type your full name to sign'; end if;
  if p_signature is null or p_signature !~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' then raise exception 'Sign in the box'; end if;
  if length(p_signature) < 200 then raise exception 'Sign in the box'; end if;
  if length(p_signature) > 300000 then raise exception 'That signature is too large. Clear it and sign again.'; end if;
  if not exists (select 1 from shop_tow_waivers where version = p_version) then raise exception 'The waiver was updated. Reload the page.'; end if;
  update shop_tow_requests set waiver_version = p_version, waiver_name = v_name, waiver_signature = p_signature,
    waiver_signed_at = now(), waiver_ip = shop_tow_header('x-forwarded-for'), waiver_agent = shop_tow_header('user-agent'),
    updated_at = now()
  where id = p_id;
end $$;
revoke all on function public.shop_tow_put_waiver(text, text, text, text) from public, anon, authenticated;

-- ===================== PUBLIC PAGE =====================
-- The current waiver, for the public page.
create or replace function public.shop_tow_waiver_text()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$ select jsonb_build_object('version', version, 'body', body) from shop_tow_waivers order by version desc limit 1 $$;
revoke all on function public.shop_tow_waiver_text() from public;
grant execute on function public.shop_tow_waiver_text() to anon, authenticated;

-- A customer asks for a tow and signs the waiver in one step.
create or replace function public.shop_tow_request(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_phone text; v_type text := shop_clean(p->>'vehicle_type'); v_zone text := shop_clean(p->>'zone');
  v_to_shop boolean := coalesce((p->>'to_shop')::boolean, false); v_drop text := left(shop_clean(p->>'dropoff_address'), 300);
  v_row shop_tow_requests; v_link text;
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
    pickup_address, dropoff_address, to_shop, zone, price, rider_count, notes, status)
  values ('web', left(shop_clean(p->>'customer_name'), 120), v_phone, left(shop_clean(p->>'email'), 200), v_type,
    left(shop_clean(p->>'vehicle'), 120), (p->>'vehicle_runs')::boolean,
    left(shop_clean(p->>'pickup_address'), 300), case when v_to_shop then null else v_drop end, v_to_shop, v_zone,
    shop_tow_quote(v_zone, v_to_shop, 0), case when coalesce((p->>'ride_along')::boolean, false) then 1 else 0 end,
    left(shop_clean(p->>'notes'), 1000), 'new')
  returning * into v_row;
  perform shop_tow_put_waiver(v_row.id, p->>'waiver_name', p->>'signature', p->>'waiver_version');
  select case v_zone when 'tucson' then pay_link_tucson when 'sierra_vista' then pay_link_sierra_vista
    when 'phoenix' then pay_link_phoenix end into v_link from shop_tow_settings where id = 1;
  return jsonb_build_object('ref', v_row.ref, 'price', v_row.price, 'zone', v_zone,
    'price_is_start', v_zone = 'tucson', 'pay_link', v_link);
end $$;
revoke all on function public.shop_tow_request(jsonb) from public;
grant execute on function public.shop_tow_request(jsonb) to anon, authenticated;

-- A customer signs the waiver from the link the crew sent (calls by phone, text or email).
create or replace function public.shop_tow_sign_info(p_token text)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('ref', ref, 'first_name', split_part(customer_name, ' ', 1),
    'vehicle_type', vehicle_type, 'signed', waiver_signed_at is not null)
  from shop_tow_requests where sign_token = p_token and status <> 'cancelled' and length(coalesce(p_token, '')) >= 24;
$$;
revoke all on function public.shop_tow_sign_info(text) from public;
grant execute on function public.shop_tow_sign_info(text) to anon, authenticated;

create or replace function public.shop_tow_sign(p_token text, p_name text, p_signature text, p_version text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row shop_tow_requests;
begin
  select * into v_row from shop_tow_requests where sign_token = p_token and length(coalesce(p_token, '')) >= 24;
  if v_row.id is null or v_row.status = 'cancelled' then raise exception 'This link is not valid. Call or text us.'; end if;
  if v_row.waiver_signed_at is not null then raise exception 'This waiver is already signed. Thank you.'; end if;
  perform shop_tow_put_waiver(v_row.id, p_name, p_signature, p_version);
  return jsonb_build_object('ref', v_row.ref);
end $$;
revoke all on function public.shop_tow_sign(text, text, text, text) from public;
grant execute on function public.shop_tow_sign(text, text, text, text) to anon, authenticated;

-- ===================== BOARD =====================
create or replace function public.shop_tow_json(r shop_tow_requests)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select to_jsonb(r) - 'waiver_signature' - 'waiver_ip' - 'waiver_agent'
    || jsonb_build_object('waiver_signed', r.waiver_signed_at is not null,
         'driver_name', shop_tow_name(r.driver_id), 'navigator_name', shop_tow_name(r.navigator_id),
         'mine', auth.uid() in (r.driver_id, r.navigator_id));
$$;
revoke all on function public.shop_tow_json(shop_tow_requests) from public, anon, authenticated;

-- Who I am on the tow crew and the settings, for the board header.
create or replace function public.shop_tow_me()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select case when not shop_tow_access() then null else jsonb_build_object(
    'user_id', auth.uid(), 'name', shop_tow_name(auth.uid()), 'admin', shop_tow_is_admin(),
    'on_duty', coalesce(c.on_duty, false), 'alert_phone', c.alert_phone, 'alert_email', c.alert_email,
    'crew_member', c.user_id is not null,
    'settings', (select to_jsonb(s) - 'id' - 'updated_by' from shop_tow_settings s where id = 1),
    'on_duty_names', (select coalesce(jsonb_agg(display_name order by display_name), '[]'::jsonb)
                       from shop_tow_crew where active and on_duty)) end
  from (select 1) one left join shop_tow_crew c on c.user_id = auth.uid() and c.active;
$$;
revoke all on function public.shop_tow_me() from public, anon;
grant execute on function public.shop_tow_me() to authenticated;

-- Open tows, plus delivered or cancelled ones from the last p_days days.
create or replace function public.shop_tow_board(p_days integer)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not shop_tow_access() then raise exception 'not authorized'; end if;
  return (select coalesce(jsonb_agg(shop_tow_json(r) order by r.created_at desc), '[]'::jsonb)
    from shop_tow_requests r
    where r.status not in ('delivered', 'cancelled')
       or coalesce(r.delivered_at, r.cancelled_at) > now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 366)));
end $$;
revoke all on function public.shop_tow_board(integer) from public, anon;
grant execute on function public.shop_tow_board(integer) to authenticated;

-- The signed waiver of one tow (for the crew to show if asked).
create or replace function public.shop_tow_waiver(p_id text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not shop_tow_access() then raise exception 'not authorized'; end if;
  return (select jsonb_build_object('ref', r.ref, 'name', r.waiver_name, 'signature', r.waiver_signature,
      'signed_at', r.waiver_signed_at, 'ip', r.waiver_ip, 'version', r.waiver_version, 'body', w.body)
    from shop_tow_requests r left join shop_tow_waivers w on w.version = r.waiver_version where r.id = p_id);
end $$;
revoke all on function public.shop_tow_waiver(text) from public, anon;
grant execute on function public.shop_tow_waiver(text) to authenticated;

create or replace function public.shop_tow_log(p_id text, p_action text, p_detail jsonb)
returns void language sql security definer set search_path = public, pg_temp
as $$
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_tow_requests', p_id, p_action, coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'), p_detail);
$$;
revoke all on function public.shop_tow_log(text, text, jsonb) from public, anon, authenticated;

create or replace function public.shop_tow_get(p_id text)
returns shop_tow_requests language plpgsql security definer set search_path = public, pg_temp
as $$
declare v shop_tow_requests;
begin
  if not shop_tow_access() then raise exception 'not authorized'; end if;
  select * into v from shop_tow_requests where id = p_id for update;
  if v.id is null then raise exception 'Tow not found'; end if;
  return v;
end $$;
revoke all on function public.shop_tow_get(text) from public, anon, authenticated;

-- The crew adds a tow that came in by phone, text or email. The customer
-- still has to sign the waiver from the link (sign_token) before pickup.
create or replace function public.shop_tow_add_call(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row shop_tow_requests; v_zone text := shop_clean(p->>'zone'); v_to_shop boolean := coalesce((p->>'to_shop')::boolean, false);
  v_source text := coalesce(shop_clean(p->>'source'), 'phone'); v_type text := shop_clean(p->>'vehicle_type'); v_miles numeric;
begin
  if not shop_tow_access() then raise exception 'not authorized'; end if;
  if v_source not in ('phone', 'text', 'email') then raise exception 'Pick how the call came in'; end if;
  if shop_clean(p->>'customer_name') is null then raise exception 'Enter the customer name'; end if;
  if v_type is null or v_type not in ('motorcycle', 'atv', 'golf_cart', 'side_by_side') then
    raise exception 'Motorcycles, ATVs, golf carts and side-by-sides only'; end if;
  if v_zone is null or v_zone not in ('tucson', 'sierra_vista', 'phoenix', 'other') then raise exception 'Pick the area'; end if;
  if shop_clean(p->>'pickup_address') is null then raise exception 'Enter the pickup spot'; end if;
  v_miles := shop_num(p->>'miles', 'Miles', null);
  insert into shop_tow_requests (source, customer_name, phone, email, vehicle_type, vehicle, vehicle_runs, pickup_address,
    dropoff_address, to_shop, zone, miles, price, rider_count, notes, created_by)
  values (v_source, left(shop_clean(p->>'customer_name'), 120), shop_tow_phone(p->>'phone'), left(shop_clean(p->>'email'), 200),
    v_type, left(shop_clean(p->>'vehicle'), 120), (p->>'vehicle_runs')::boolean, left(shop_clean(p->>'pickup_address'), 300),
    case when v_to_shop then null else left(shop_clean(p->>'dropoff_address'), 300) end, v_to_shop, v_zone, v_miles,
    shop_tow_quote(v_zone, v_to_shop, v_miles), case when coalesce((p->>'ride_along')::boolean, false) then 1 else 0 end,
    left(shop_clean(p->>'notes'), 1000), auth.uid())
  returning * into v_row;
  perform shop_tow_log(v_row.id, 'add_call', jsonb_build_object('ref', v_row.ref, 'source', v_source));
  return shop_tow_json(v_row) || jsonb_build_object('sign_token', v_row.sign_token);
end $$;
revoke all on function public.shop_tow_add_call(jsonb) from public, anon;
grant execute on function public.shop_tow_add_call(jsonb) to authenticated;

-- The waiver link for a tow that still needs signing.
create or replace function public.shop_tow_sign_link(p_id text)
returns text language plpgsql security definer set search_path = public, pg_temp
as $$
declare v shop_tow_requests := shop_tow_get(p_id);
begin
  if v.waiver_signed_at is not null then raise exception 'The waiver is already signed'; end if;
  return v.sign_token;
end $$;
revoke all on function public.shop_tow_sign_link(text) from public, anon;
grant execute on function public.shop_tow_sign_link(text) to authenticated;

-- Set or change the price (and miles). Only before it is paid, unless Tyler.
create or replace function public.shop_tow_set_price(p_id text, p_price text, p_miles text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v shop_tow_requests := shop_tow_get(p_id); v_price numeric; v_miles numeric;
begin
  if v.status in ('delivered', 'cancelled') then raise exception 'This tow is closed'; end if;
  if v.paid_at is not null and not shop_tow_is_admin() then raise exception 'It is already paid. Ask Tyler to change the price.'; end if;
  v_miles := shop_num(p_miles, 'Miles', v.miles);
  v_price := coalesce(shop_num(p_price, 'Price', null), shop_tow_quote(v.zone, v.to_shop, v_miles));
  if v_price is null or v_price <= 0 or v_price > 5000 then raise exception 'Enter a price'; end if;
  update shop_tow_requests set price = round(v_price, 2), miles = v_miles,
    status = case when status = 'new' then 'quoted' else status end, updated_at = now()
  where id = p_id returning * into v;
  perform shop_tow_log(p_id, 'price', jsonb_build_object('price', v.price, 'miles', v.miles));
  return shop_tow_json(v);
end $$;
revoke all on function public.shop_tow_set_price(text, text, text) from public, anon;
grant execute on function public.shop_tow_set_price(text, text, text) to authenticated;

-- Mark it paid. Needs a price and a payment reference.
create or replace function public.shop_tow_mark_paid(p_id text, p_method text, p_ref text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v shop_tow_requests := shop_tow_get(p_id);
begin
  if v.status in ('delivered', 'cancelled') then raise exception 'This tow is closed'; end if;
  if v.paid_at is not null then raise exception 'It is already marked paid'; end if;
  if v.price is null then raise exception 'Set the price first'; end if;
  if shop_clean(p_method) is null then raise exception 'Pick how they paid'; end if;
  if shop_clean(p_ref) is null then raise exception 'Enter the payment or receipt number'; end if;
  update shop_tow_requests set paid_at = now(), paid_method = left(shop_clean(p_method), 40), paid_ref = left(shop_clean(p_ref), 120),
    marked_paid_by = auth.uid(), status = case when status in ('new', 'quoted') then 'paid' else status end, updated_at = now()
  where id = p_id returning * into v;
  perform shop_tow_log(p_id, 'paid', jsonb_build_object('method', v.paid_method, 'ref', v.paid_ref, 'price', v.price));
  return shop_tow_json(v);
end $$;
revoke all on function public.shop_tow_mark_paid(text, text, text) from public, anon;
grant execute on function public.shop_tow_mark_paid(text, text, text) to authenticated;

-- Claim a tow: p_role 'driver' (runs the truck) or 'navigator' (rides along).
create or replace function public.shop_tow_claim(p_id text, p_role text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v shop_tow_requests := shop_tow_get(p_id); v_uid uuid := auth.uid();
begin
  if not exists (select 1 from shop_tow_crew where user_id = v_uid and active) then raise exception 'Only tow crew can take a tow'; end if;
  if v.status in ('delivered', 'cancelled') then raise exception 'This tow is closed'; end if;
  if p_role = 'driver' then
    if v.driver_id is not null and v.driver_id <> v_uid then raise exception '% is already driving this one', shop_tow_name(v.driver_id); end if;
    if v.navigator_id = v_uid then raise exception 'You are the navigator on this one'; end if;
    update shop_tow_requests set driver_id = v_uid, updated_at = now() where id = p_id returning * into v;
  elsif p_role = 'navigator' then
    if v.navigator_id is not null and v.navigator_id <> v_uid then raise exception '% is already riding along', shop_tow_name(v.navigator_id); end if;
    if v.driver_id = v_uid then raise exception 'You are the driver on this one'; end if;
    update shop_tow_requests set navigator_id = v_uid, updated_at = now() where id = p_id returning * into v;
  else raise exception 'Pick driver or navigator'; end if;
  perform shop_tow_log(p_id, 'claim', jsonb_build_object('role', p_role));
  return shop_tow_json(v);
end $$;
revoke all on function public.shop_tow_claim(text, text) from public, anon;
grant execute on function public.shop_tow_claim(text, text) to authenticated;

-- Drop off a tow you claimed (before it starts).
create or replace function public.shop_tow_unclaim(p_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v shop_tow_requests := shop_tow_get(p_id); v_uid uuid := auth.uid();
begin
  if v.status in ('en_route', 'delivered', 'cancelled') then raise exception 'It already started. Ask Tyler to change the crew.'; end if;
  update shop_tow_requests set driver_id = case when driver_id = v_uid then null else driver_id end,
    navigator_id = case when navigator_id = v_uid then null else navigator_id end, updated_at = now()
  where id = p_id returning * into v;
  perform shop_tow_log(p_id, 'unclaim', '{}'::jsonb);
  return shop_tow_json(v);
end $$;
revoke all on function public.shop_tow_unclaim(text) from public, anon;
grant execute on function public.shop_tow_unclaim(text) to authenticated;

-- Tyler sets who drove and who rode along (any time, also after delivery).
create or replace function public.shop_tow_assign(p_id text, p_driver uuid, p_navigator uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v shop_tow_requests := shop_tow_get(p_id); s shop_tow_settings; d numeric; n numeric;
begin
  if not shop_tow_is_admin() then raise exception 'Only Tyler can change the crew'; end if;
  if p_driver is null and p_navigator is not null then raise exception 'Pick a driver first'; end if;
  if p_driver is not null and p_driver = p_navigator then raise exception 'The driver and navigator must be different people'; end if;
  if exists (select 1 from unnest(array[p_driver, p_navigator]) u where u is not null
             and not exists (select 1 from shop_tow_crew c where c.user_id = u)) then raise exception 'That person is not on the tow crew'; end if;
  update shop_tow_requests set driver_id = p_driver, navigator_id = p_navigator, updated_at = now() where id = p_id returning * into v;
  if v.status = 'delivered' then   -- already delivered: pay follows the new crew, at today's percents
    select * into s from shop_tow_settings where id = 1;
    select driver, navigator into d, n from shop_tow_crew_pay(v.price, p_navigator is not null, s.solo_pct, s.pair_pct, s.driver_pct);
    update shop_tow_requests set driver_pay = d, navigator_pay = case when p_navigator is null then null else n end where id = p_id returning * into v;
  end if;
  perform shop_tow_log(p_id, 'assign', jsonb_build_object('driver', p_driver, 'navigator', p_navigator));
  return shop_tow_json(v);
end $$;
revoke all on function public.shop_tow_assign(text, uuid, uuid) from public, anon;
grant execute on function public.shop_tow_assign(text, uuid, uuid) to authenticated;

-- Start the tow. PAY FIRST: only when paid, the waiver is signed and a driver is set.
create or replace function public.shop_tow_start(p_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v shop_tow_requests := shop_tow_get(p_id);
begin
  if v.status <> 'paid' then raise exception 'Not paid yet. No pickup until it is paid.'; end if;
  if v.waiver_signed_at is null then raise exception 'The waiver is not signed yet. Send them the waiver link.'; end if;
  if v.driver_id is null then raise exception 'Someone has to take it as driver first'; end if;
  if auth.uid() not in (v.driver_id, coalesce(v.navigator_id, v.driver_id)) and not shop_tow_is_admin() then
    raise exception 'Only the crew on this tow can start it'; end if;
  update shop_tow_requests set status = 'en_route', started_at = now(), updated_at = now() where id = p_id returning * into v;
  perform shop_tow_log(p_id, 'start', '{}'::jsonb);
  return shop_tow_json(v);
end $$;
revoke all on function public.shop_tow_start(text) from public, anon;
grant execute on function public.shop_tow_start(text) to authenticated;

-- Delivered: work out the crew pay and freeze it on the tow.
create or replace function public.shop_tow_deliver(p_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v shop_tow_requests := shop_tow_get(p_id); s shop_tow_settings; d numeric; n numeric;
begin
  if v.status <> 'en_route' then raise exception 'Start the tow first'; end if;
  if auth.uid() not in (v.driver_id, coalesce(v.navigator_id, v.driver_id)) and not shop_tow_is_admin() then
    raise exception 'Only the crew on this tow can finish it'; end if;
  select * into s from shop_tow_settings where id = 1;
  select driver, navigator into d, n from shop_tow_crew_pay(v.price, v.navigator_id is not null, s.solo_pct, s.pair_pct, s.driver_pct);
  update shop_tow_requests set status = 'delivered', delivered_at = now(), driver_pay = d,
    navigator_pay = case when v.navigator_id is null then null else n end, updated_at = now()
  where id = p_id returning * into v;
  perform shop_tow_log(p_id, 'deliver', jsonb_build_object('driver_pay', v.driver_pay, 'navigator_pay', v.navigator_pay));
  return shop_tow_json(v);
end $$;
revoke all on function public.shop_tow_deliver(text) from public, anon;
grant execute on function public.shop_tow_deliver(text) to authenticated;

create or replace function public.shop_tow_cancel(p_id text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v shop_tow_requests := shop_tow_get(p_id);
begin
  if v.status in ('delivered', 'cancelled') then raise exception 'This tow is closed'; end if;
  if shop_clean(p_reason) is null then raise exception 'Say why it was cancelled'; end if;
  update shop_tow_requests set status = 'cancelled', cancelled_at = now(), cancel_reason = left(shop_clean(p_reason), 300),
    refund_due = paid_at is not null, updated_at = now()
  where id = p_id returning * into v;
  perform shop_tow_log(p_id, 'cancel', jsonb_build_object('reason', v.cancel_reason, 'refund_due', v.refund_due));
  return shop_tow_json(v);
end $$;
revoke all on function public.shop_tow_cancel(text, text) from public, anon;
grant execute on function public.shop_tow_cancel(text, text) to authenticated;

-- ===================== DUTY AND SETTINGS =====================
create or replace function public.shop_tow_set_duty(p_on boolean, p_phone text, p_email text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_phone text := case when shop_clean(p_phone) is null then null else shop_tow_phone(p_phone) end;
begin
  if not exists (select 1 from shop_tow_crew where user_id = auth.uid() and active) then raise exception 'Only tow crew can go on duty'; end if;
  if p_on and v_phone is null and shop_clean(p_email) is null then raise exception 'Add a phone or email so we can alert you'; end if;
  update shop_tow_crew set on_duty = coalesce(p_on, false), alert_phone = v_phone, alert_email = left(shop_clean(p_email), 200),
    updated_at = now() where user_id = auth.uid();
  return shop_tow_me();
end $$;
revoke all on function public.shop_tow_set_duty(boolean, text, text) from public, anon;
grant execute on function public.shop_tow_set_duty(boolean, text, text) to authenticated;

create or replace function public.shop_tow_save_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare k text;
begin
  if not shop_tow_is_admin() then raise exception 'Only Tyler can change tow settings'; end if;
  foreach k in array array['pay_link_tucson', 'pay_link_sierra_vista', 'pay_link_phoenix'] loop
    if shop_clean(p->>k) is not null and shop_clean(p->>k) !~ '^https://[^\s<>"]+$' then raise exception 'Payment links must start with https://'; end if;
  end loop;
  update shop_tow_settings set
    solo_pct = shop_num(p->>'solo_pct', 'Solo share', solo_pct),
    pair_pct = shop_num(p->>'pair_pct', 'Two-person share', pair_pct),
    driver_pct = shop_num(p->>'driver_pct', 'Driver part', driver_pct),
    pay_link_tucson = shop_clean(p->>'pay_link_tucson'),
    pay_link_sierra_vista = shop_clean(p->>'pay_link_sierra_vista'),
    pay_link_phoenix = shop_clean(p->>'pay_link_phoenix'),
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
  perform shop_tow_log('settings', 'settings', p);
  return shop_tow_me();
end $$;
revoke all on function public.shop_tow_save_settings(jsonb) from public, anon;
grant execute on function public.shop_tow_save_settings(jsonb) to authenticated;

-- Tow crew list for Tyler (to assign).
create or replace function public.shop_tow_crew_list()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not shop_tow_is_admin() then raise exception 'not authorized'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'name', display_name, 'active', active, 'on_duty', on_duty)
    order by display_name), '[]'::jsonb) from shop_tow_crew);
end $$;
revoke all on function public.shop_tow_crew_list() from public, anon;
grant execute on function public.shop_tow_crew_list() to authenticated;

-- ===================== PAY =====================
-- Crew pay from tows delivered between p_from and p_to (Arizona dates).
-- Tyler sees everyone; anyone else sees only their own.
create or replace function public.shop_tow_pay(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_admin boolean := shop_tow_is_admin();
begin
  if not shop_tow_access() then raise exception 'not authorized'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Pick a date range'; end if;
  return (with d as (
      select r.*, (r.delivered_at at time zone 'America/Phoenix')::date as day from shop_tow_requests r
      where r.status = 'delivered' and (r.delivered_at at time zone 'America/Phoenix')::date between p_from and p_to),
    lines as (
      select driver_id as uid, 'driver' as role, ref, day, price, driver_pay as pay from d where driver_id is not null
      union all
      select navigator_id, 'navigator', ref, day, price, navigator_pay from d where navigator_id is not null),
    people as (
      select uid, shop_tow_name(uid) as name, count(*) filter (where role = 'driver') as drove,
        count(*) filter (where role = 'navigator') as rode, coalesce(sum(pay), 0) as pay,
        jsonb_agg(jsonb_build_object('ref', ref, 'day', day, 'role', role, 'price', price, 'pay', pay) order by day, ref) as tows
      from lines where v_admin or uid = auth.uid() group by uid)
    select jsonb_build_object('from', p_from, 'to', p_to, 'admin', v_admin,
      'people', coalesce((select jsonb_agg(to_jsonb(people) - 'uid' order by name) from people), '[]'::jsonb),
      'tows', case when v_admin then (select count(*) from d) end,
      'revenue', case when v_admin then (select coalesce(sum(price), 0) from d) end,
      'crew_pay', case when v_admin then (select coalesce(sum(coalesce(driver_pay, 0) + coalesce(navigator_pay, 0)), 0) from d) end));
end $$;
revoke all on function public.shop_tow_pay(date, date) from public, anon;
grant execute on function public.shop_tow_pay(date, date) to authenticated;

-- ===================== SERVER-ONLY (alerts and inbound texts) =====================
-- Used by the tow-alert edge function with the service key. No browser can call these.
create or replace function public.shop_tow_alert_targets()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', display_name, 'phone', alert_phone, 'email', alert_email)), '[]'::jsonb)
  from shop_tow_crew where active and on_duty;
$$;
revoke all on function public.shop_tow_alert_targets() from public, anon, authenticated;

-- A text or email to the tow number. Kept as a 'new' tow with what we know;
-- the crew fills in the rest on the board.
create or replace function public.shop_tow_inbound(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row shop_tow_requests; v_source text := coalesce(shop_clean(p->>'source'), 'text'); v_phone text;
begin
  if v_source not in ('text', 'email') then raise exception 'bad source'; end if;
  begin v_phone := shop_tow_phone(p->>'phone'); exception when others then v_phone := coalesce(left(shop_clean(p->>'phone'), 40), 'unknown'); end;
  -- One open tow per number: later texts add to its notes.
  select * into v_row from shop_tow_requests where phone = v_phone and status in ('new', 'quoted')
    and created_at > now() - interval '12 hours' order by created_at desc limit 1;
  if v_row.id is not null then
    update shop_tow_requests set notes = left(coalesce(notes || E'\n', '') || coalesce(shop_clean(p->>'message'), ''), 2000), updated_at = now()
    where id = v_row.id returning * into v_row;
    return jsonb_build_object('ref', v_row.ref, 'new', false);
  end if;
  insert into shop_tow_requests (source, customer_name, phone, email, vehicle_type, pickup_address, zone, notes)
  values (v_source, coalesce(left(shop_clean(p->>'name'), 120), 'Unknown (' || v_source || ')'), v_phone,
    left(shop_clean(p->>'email'), 200), 'motorcycle', 'Ask the customer', 'other', left(shop_clean(p->>'message'), 2000))
  returning * into v_row;
  perform shop_tow_log(v_row.id, 'inbound', jsonb_build_object('source', v_source));
  return jsonb_build_object('ref', v_row.ref, 'new', true);
end $$;
revoke all on function public.shop_tow_inbound(jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';
