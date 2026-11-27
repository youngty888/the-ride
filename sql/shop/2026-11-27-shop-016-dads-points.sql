-- shop-016: Dads Don't Quit points (Dollars for Dads, ManUp Movement).
--   * A RIDE rider earns 1 point for every $1 donated to Dollars for Dads and
--     1 point for every $1 spent on ManUp merch.
--   * Gifts made in RIDE go through the SIC Cycles store (the "Dollars for Dads
--     Donation" product on siccycles.com). When Shopify reports the order paid,
--     the shop server's webhook (supabase/functions/shopify-orders-paid) calls
--     ride_record_dads_order. The order is matched to a rider by the RIDE member
--     id the app puts on the cart, or else by the order email (a confirmed RIDE
--     login email). An order that matches nobody is kept for staff to check.
--   * The same Shopify order is never counted twice.
--   * Staff add points by hand for gifts made elsewhere (the PayPal button on
--     manup-movement.org, cash at an event) and ManUp gear bought on
--     manup-movement.org: ride_dads_add.
--   * Thank-you gifts go by the total donated (ride_dads_tiers). The amounts and
--     names are a first proposal; change them here and in d4d.js together.
--   * Riders see only their own points. Only the server records orders.
-- Additive and safe to re-run. Needs shop-001 (staff list and audit log).

-- 1. Tiers -----------------------------------------------------------------------
create table if not exists public.ride_dads_tiers (
  min_donated numeric(10,2) primary key check (min_donated > 0),
  name text not null check (length(name) between 1 and 60),
  gift text not null check (length(gift) between 1 and 120)
);
insert into public.ride_dads_tiers (min_donated, name, gift) values
  (25, 'Supporter Brother', 'Thank-you merch item'),
  (50, 'Riding Brother', 'Thank-you T-shirt'),
  (100, 'Iron Brother', 'Thank-you hoodie')
on conflict (min_donated) do nothing;
alter table public.ride_dads_tiers enable row level security;
drop policy if exists "Anyone signed in can see the tiers" on public.ride_dads_tiers;
create policy "Anyone signed in can see the tiers" on public.ride_dads_tiers for select using (auth.uid() is not null);
revoke all on public.ride_dads_tiers from anon, authenticated;
grant select on public.ride_dads_tiers to authenticated;

-- 2. Points ledger ------------------------------------------------------------------
create table if not exists public.ride_dads_points (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  kind text not null check (kind in ('donation','merch','adjust')),
  amount numeric(10,2) not null default 0 check (amount >= 0 and amount <= 100000),  -- dollars behind the points
  points integer not null check (points between -100000 and 100000),
  source text not null check (source in ('shopify','staff')),
  order_id text check (order_id is null or order_id ~ '^[0-9]{1,20}$'),
  order_name text,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid
);
create unique index if not exists ride_dads_points_order_kind_key on public.ride_dads_points (order_id, kind) where order_id is not null;
create index if not exists ride_dads_points_user_idx on public.ride_dads_points (user_id, created_at desc);
alter table public.ride_dads_points enable row level security;
drop policy if exists "Riders see their own points" on public.ride_dads_points;
create policy "Riders see their own points" on public.ride_dads_points for select using (user_id = auth.uid());
drop policy if exists "Staff see all points" on public.ride_dads_points;
create policy "Staff see all points" on public.ride_dads_points for select using (public.shop_has_staff_access());
revoke all on public.ride_dads_points from anon, authenticated;
grant select on public.ride_dads_points to authenticated;

-- 3. Orders that matched no rider (or were not counted) -----------------------------
create table if not exists public.ride_dads_orders_held (
  order_id text primary key check (order_id ~ '^[0-9]{1,20}$'),
  order_name text,
  email text,
  donation numeric(10,2) not null default 0,
  merch numeric(10,2) not null default 0,
  reason text not null,
  status text not null default 'held' check (status in ('held','handled')),
  received_at timestamptz not null default now(),
  handled_by uuid, handled_at timestamptz, handled_note text
);
alter table public.ride_dads_orders_held enable row level security;
drop policy if exists "Staff see held Dads orders" on public.ride_dads_orders_held;
create policy "Staff see held Dads orders" on public.ride_dads_orders_held for select using (public.shop_has_staff_access());
revoke all on public.ride_dads_orders_held from anon, authenticated;
grant select on public.ride_dads_orders_held to authenticated;

-- 4. Thank-you gifts handed out (once per rider per tier) ---------------------------
create table if not exists public.ride_dads_gifts_given (
  user_id uuid not null,
  min_donated numeric(10,2) not null,
  given_at timestamptz not null default now(),
  given_by uuid,
  note text,
  primary key (user_id, min_donated)
);
alter table public.ride_dads_gifts_given enable row level security;
drop policy if exists "Riders see their own gifts" on public.ride_dads_gifts_given;
create policy "Riders see their own gifts" on public.ride_dads_gifts_given for select using (user_id = auth.uid());
drop policy if exists "Staff see all gifts" on public.ride_dads_gifts_given;
create policy "Staff see all gifts" on public.ride_dads_gifts_given for select using (public.shop_has_staff_access());
revoke all on public.ride_dads_gifts_given from anon, authenticated;
grant select on public.ride_dads_gifts_given to authenticated;

-- 5. One rider's standing (used by the rider's own view and by staff) --------------
create or replace function public.ride_dads_standing(p_user uuid)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  with t as (
    select coalesce(sum(points), 0)::int as points,
           coalesce(sum(amount) filter (where kind = 'donation'), 0) as donated,
           coalesce(sum(amount) filter (where kind = 'merch'), 0) as merch
    from ride_dads_points where user_id = p_user
  )
  select jsonb_build_object(
    'points', t.points, 'donated', t.donated, 'merch', t.merch,
    'tiers', coalesce((select jsonb_agg(jsonb_build_object(
        'min', r.min_donated, 'name', r.name, 'gift', r.gift,
        'earned', t.donated >= r.min_donated,
        'given', exists (select 1 from ride_dads_gifts_given g where g.user_id = p_user and g.min_donated = r.min_donated))
        order by r.min_donated) from ride_dads_tiers r), '[]'::jsonb))
  from t
$$;
revoke all on function public.ride_dads_standing(uuid) from public, anon, authenticated;

-- 6. The rider's own points (Profile screen) ------------------------------------------
create or replace function public.ride_my_dads()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  return ride_dads_standing(v_uid) || jsonb_build_object('history', coalesce((
    select jsonb_agg(jsonb_build_object('at', h.created_at, 'kind', h.kind, 'amount', h.amount,
                                         'points', h.points, 'order_name', h.order_name, 'note', h.note) order by h.created_at desc)
    from (select * from ride_dads_points where user_id = v_uid order by created_at desc limit 20) h), '[]'::jsonb));
end $$;
revoke all on function public.ride_my_dads() from public, anon;
grant execute on function public.ride_my_dads() to authenticated;

-- 7. Record one paid Shopify order (server only) --------------------------------------
-- p_order: {order_id, order_name, email, ride_member, donation, merch, currency, test}
-- donation / merch are the order's Dollars for Dads lines and ManUp merch lines
-- (worked out by the webhook function), in dollars.
create or replace function public.ride_record_dads_order(p_order jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_auto constant uuid := '00000000-0000-0000-0000-000000000000';  -- "Shopify (automatic)"
  v_order_id text := btrim(coalesce(p_order->>'order_id', ''));
  v_name text := left(nullif(btrim(coalesce(p_order->>'order_name', '')), ''), 40);
  v_email text := lower(left(nullif(btrim(coalesce(p_order->>'email', '')), ''), 200));
  v_member text := lower(btrim(coalesce(p_order->>'ride_member', '')));
  v_cur text := upper(left(nullif(btrim(coalesce(p_order->>'currency', '')), ''), 8));
  v_don numeric; v_merch numeric; v_user uuid; v_reason text; v_pts int := 0;
begin
  if v_order_id !~ '^[0-9]{1,20}$' then raise exception 'invalid order id'; end if;
  if exists (select 1 from ride_dads_points where order_id = v_order_id)
     or exists (select 1 from ride_dads_orders_held where order_id = v_order_id) then
    return jsonb_build_object('order_id', v_order_id, 'duplicate', true);
  end if;
  begin v_don := round(coalesce((p_order->>'donation')::numeric, 0), 2); exception when others then v_don := null; end;
  begin v_merch := round(coalesce((p_order->>'merch')::numeric, 0), 2); exception when others then v_merch := null; end;
  if v_don is null or v_merch is null or v_don < 0 or v_merch < 0 or v_don > 100000 or v_merch > 100000 then
    raise exception 'invalid amount';
  end if;
  if v_don = 0 and v_merch = 0 then
    return jsonb_build_object('order_id', v_order_id, 'status', 'ignored', 'reason', 'Nothing for Dads in this order');
  end if;

  if v_member ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select id into v_user from auth.users where id = v_member::uuid;
  end if;
  if v_user is null and v_email is not null then
    select id into v_user from auth.users where lower(email) = v_email and email_confirmed_at is not null;
  end if;

  if coalesce((p_order->>'test')::boolean, false) then v_reason := 'Test order';
  elsif coalesce(v_cur, '') <> 'USD' then v_reason := 'Not paid in US dollars';
  elsif v_user is null then v_reason := 'No RIDE account for this order';
  end if;

  if v_reason is not null then
    insert into ride_dads_orders_held (order_id, order_name, email, donation, merch, reason)
    values (v_order_id, v_name, v_email, v_don, v_merch, v_reason);
    return jsonb_build_object('order_id', v_order_id, 'status', 'held', 'reason', v_reason);
  end if;

  if v_don > 0 then
    insert into ride_dads_points (user_id, kind, amount, points, source, order_id, order_name, created_by)
    values (v_user, 'donation', v_don, floor(v_don)::int, 'shopify', v_order_id, v_name, v_auto);
    v_pts := v_pts + floor(v_don)::int;
  end if;
  if v_merch > 0 then
    insert into ride_dads_points (user_id, kind, amount, points, source, order_id, order_name, created_by)
    values (v_user, 'merch', v_merch, floor(v_merch)::int, 'shopify', v_order_id, v_name, v_auto);
    v_pts := v_pts + floor(v_merch)::int;
  end if;
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('ride_dads_points', v_order_id, 'insert', v_auto,
          jsonb_build_object('user_id', v_user, 'donation', v_don, 'merch', v_merch, 'points', v_pts));
  return jsonb_build_object('order_id', v_order_id, 'status', 'credited', 'points', v_pts);
end $$;
revoke all on function public.ride_record_dads_order(jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.ride_record_dads_order(jsonb) to service_role';
  end if;
end $$;

-- 8. Staff: add points by hand (gifts made elsewhere, ManUp gear sold on
--    manup-movement.org, corrections). p_points null = 1 per whole dollar.
create or replace function public.ride_dads_add(p_email text, p_kind text, p_amount numeric, p_points int, p_note text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_user uuid; v_pts int; v_amt numeric := round(coalesce(p_amount, 0), 2);
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_kind not in ('donation','merch','adjust') then raise exception 'Kind must be donation, merch or adjust'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Say where this came from'; end if;
  if v_amt < 0 or v_amt > 100000 then raise exception 'invalid amount'; end if;
  select id into v_user from auth.users where lower(email) = lower(btrim(coalesce(p_email, ''))) and email_confirmed_at is not null;
  if v_user is null then raise exception 'No RIDE account with that email'; end if;
  v_pts := coalesce(p_points, floor(v_amt)::int);
  if p_kind = 'adjust' and v_amt <> 0 then raise exception 'An adjustment changes points only; leave the amount at 0'; end if;
  if v_pts = 0 and v_amt = 0 then raise exception 'Nothing to add'; end if;
  insert into ride_dads_points (user_id, kind, amount, points, source, note, created_by)
  values (v_user, p_kind, v_amt, v_pts, 'staff', left(btrim(p_note), 300), v_uid);
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('ride_dads_points', v_user::text, 'insert', v_uid,
          jsonb_build_object('kind', p_kind, 'amount', v_amt, 'points', v_pts, 'note', p_note));
  return ride_dads_standing(v_user);
end $$;
revoke all on function public.ride_dads_add(text, text, numeric, int, text) from public, anon;
grant execute on function public.ride_dads_add(text, text, numeric, int, text) to authenticated;

-- 9. Staff: record that a thank-you gift was handed out --------------------------------
create or replace function public.ride_dads_give_gift(p_email text, p_min numeric, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_user uuid; v_don numeric;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  select id into v_user from auth.users where lower(email) = lower(btrim(coalesce(p_email, ''))) and email_confirmed_at is not null;
  if v_user is null then raise exception 'No RIDE account with that email'; end if;
  if not exists (select 1 from ride_dads_tiers where min_donated = p_min) then raise exception 'No tier at that amount'; end if;
  select coalesce(sum(amount), 0) into v_don from ride_dads_points where user_id = v_user and kind = 'donation';
  if v_don < p_min then raise exception 'This rider has not reached that tier yet (donated $%)', v_don; end if;
  insert into ride_dads_gifts_given (user_id, min_donated, given_by, note)
  values (v_user, p_min, v_uid, left(nullif(btrim(coalesce(p_note, '')), ''), 300))
  on conflict (user_id, min_donated) do nothing;
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('ride_dads_gifts_given', v_user::text || '/' || p_min::text, 'give', v_uid, jsonb_build_object('note', p_note));
  return ride_dads_standing(v_user);
end $$;
revoke all on function public.ride_dads_give_gift(text, numeric, text) from public, anon;
grant execute on function public.ride_dads_give_gift(text, numeric, text) to authenticated;

-- 10. Staff: everyone's standing, most points first -------------------------------------
create or replace function public.ride_dads_members()
returns table (email text, points int, donated numeric, merch numeric, tier text, gifts_to_hand_out text[])
language sql stable security definer
set search_path = public, pg_temp
as $$
  with per as (
    select p.user_id, sum(p.points)::int as points,
           coalesce(sum(p.amount) filter (where p.kind = 'donation'), 0) as donated,
           coalesce(sum(p.amount) filter (where p.kind = 'merch'), 0) as merch
    from ride_dads_points p group by p.user_id
  )
  select u.email::text, per.points, per.donated, per.merch,
         (select r.name from ride_dads_tiers r where per.donated >= r.min_donated order by r.min_donated desc limit 1),
         array(select r.gift from ride_dads_tiers r where per.donated >= r.min_donated
               and not exists (select 1 from ride_dads_gifts_given g where g.user_id = per.user_id and g.min_donated = r.min_donated)
               order by r.min_donated)
  from per join auth.users u on u.id = per.user_id
  where public.shop_has_staff_access()
  order by per.points desc
$$;
revoke all on function public.ride_dads_members() from public, anon;
grant execute on function public.ride_dads_members() to authenticated;

-- 11. Staff: mark a held order as handled (points added by hand, refunded, ...) -------
create or replace function public.ride_dads_handle_order(p_order_id text, p_note text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  update ride_dads_orders_held set status = 'handled', handled_by = v_uid, handled_at = now(),
    handled_note = left(nullif(btrim(coalesce(p_note, '')), ''), 500)
  where order_id = p_order_id and status = 'held';
  if not found then raise exception 'Held order not found'; end if;
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('ride_dads_orders_held', p_order_id, 'update', v_uid, jsonb_build_object('status', 'handled', 'note', p_note));
  return jsonb_build_object('order_id', p_order_id, 'status', 'handled');
end $$;
revoke all on function public.ride_dads_handle_order(text, text) from public, anon;
grant execute on function public.ride_dads_handle_order(text, text) to authenticated;
