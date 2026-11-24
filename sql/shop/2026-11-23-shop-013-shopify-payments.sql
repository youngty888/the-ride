-- shop-013: plan payments made through the SIC Cycles Shopify checkout.
--   * Every payment plan gets a loan number (pay_ref, e.g. SIC-7KQ3MP). It is
--     made by the database, never typed, and never reused.
--   * The buyer's pay page adds the loan number (and the bike's VIN, last 6) to
--     the Shopify cart link as order notes, so each order says which plan it pays.
--   * When Shopify reports an order as paid, the shop server's webhook function
--     (supabase/functions/shopify-orders-paid) calls shop_record_shopify_order.
--     It credits the plan only when the order carries a loan number that matches
--     an active plan, in US dollars, and not more than the balance left. Anything
--     else is kept as "held" for staff to check (and refund in Shopify if needed).
--   * The same Shopify order is never counted twice (order id is the key).
--   * Only the server (service role) can record an order. Staff can see orders
--     and mark a held one as handled. Buyers see only their own loan number.
-- Additive and safe to re-run. Run AFTER shop-009 and shop-012.

-- 1. Loan numbers --------------------------------------------------------------
create or replace function public.shop_new_pay_ref()
returns text
language plpgsql volatile
set search_path = public, pg_temp
as $$
declare
  v_abc constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- no 0/O, 1/I/L
  v_ref text; v_bytes bytea; i int;
begin
  loop
    v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    v_ref := 'SIC-';
    for i in 0..5 loop
      v_ref := v_ref || substr(v_abc, 1 + (get_byte(v_bytes, i) % length(v_abc)), 1);
    end loop;
    exit when not exists (select 1 from public.shop_payment_plans where pay_ref = v_ref);
  end loop;
  return v_ref;
end $$;
revoke all on function public.shop_new_pay_ref() from public, anon, authenticated;

alter table public.shop_payment_plans add column if not exists pay_ref text;
update public.shop_payment_plans set pay_ref = public.shop_new_pay_ref() where pay_ref is null;
alter table public.shop_payment_plans alter column pay_ref set default public.shop_new_pay_ref();
alter table public.shop_payment_plans alter column pay_ref set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shop_payment_plans_pay_ref_format') then
    alter table public.shop_payment_plans add constraint shop_payment_plans_pay_ref_format check (pay_ref ~ '^SIC-[A-Z0-9]{6,12}$');
  end if;
end $$;
create unique index if not exists shop_payment_plans_pay_ref_key on public.shop_payment_plans (pay_ref);

-- 2. Shopify orders the webhook saw -------------------------------------------
create table if not exists public.shop_shopify_orders (
  order_id text primary key check (order_id ~ '^[0-9]{1,20}$'),   -- Shopify's order id
  order_name text,                                                 -- e.g. #1042
  pay_ref text,                                                    -- loan number on the order, as sent
  plan_id text references public.shop_payment_plans(id) on delete set null,
  payment_id text,                                                 -- the shop_plan_payments row it made
  amount numeric(10,2) not null,
  currency text,
  status text not null check (status in ('credited','held','handled')),
  reason text,                                                     -- why it was held
  ordered_at timestamptz,
  received_at timestamptz not null default now(),
  handled_by uuid,
  handled_at timestamptz,
  handled_note text
);
create index if not exists shop_shopify_orders_status_idx on public.shop_shopify_orders (status, received_at);
alter table public.shop_shopify_orders enable row level security;
drop policy if exists "Staff can view Shopify orders" on public.shop_shopify_orders;
create policy "Staff can view Shopify orders" on public.shop_shopify_orders
  for select using (public.shop_has_staff_access());
revoke all on public.shop_shopify_orders from anon, authenticated;
grant select on public.shop_shopify_orders to authenticated;

-- 3. Record one paid order (server only) --------------------------------------
-- p_order: {order_id, order_name, pay_ref, amount, currency, ordered_at, test}
-- amount is only the plan-payment lines of the order (worked out by the function).
create or replace function public.shop_record_shopify_order(p_order jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_auto constant uuid := '00000000-0000-0000-0000-000000000000';  -- "Shopify (automatic)"
  v_order_id text := btrim(coalesce(p_order->>'order_id', ''));
  v_name text := left(nullif(btrim(coalesce(p_order->>'order_name', '')), ''), 40);
  v_ref text := upper(left(nullif(btrim(coalesce(p_order->>'pay_ref', '')), ''), 40));
  v_cur text := upper(left(nullif(btrim(coalesce(p_order->>'currency', '')), ''), 8));
  v_at timestamptz;
  v_amount numeric; v_plan public.shop_payment_plans%rowtype;
  v_paid numeric; v_balance numeric; v_reason text; v_pay_id text;
  v_row public.shop_shopify_orders%rowtype;
begin
  if v_order_id !~ '^[0-9]{1,20}$' then raise exception 'invalid order id'; end if;
  select * into v_row from shop_shopify_orders where order_id = v_order_id;
  if found then
    return jsonb_build_object('order_id', v_order_id, 'status', v_row.status, 'duplicate', true);
  end if;
  begin v_at := (p_order->>'ordered_at')::timestamptz; exception when others then v_at := null; end;
  begin v_amount := round((p_order->>'amount')::numeric, 2); exception when others then v_amount := null; end;
  if v_amount is null then raise exception 'invalid amount'; end if;

  if v_ref is not null then
    select * into v_plan from shop_payment_plans where pay_ref = v_ref for update;
  end if;
  if coalesce((p_order->>'test')::boolean, false) then v_reason := 'Test order';
  elsif v_ref is null then v_reason := 'No loan number on the order';
  elsif v_plan.id is null then v_reason := 'Loan number does not match a plan';
  elsif v_plan.status <> 'active' then v_reason := 'Plan is ' || replace(v_plan.status, '_', ' ');
  elsif coalesce(v_cur, '') <> 'USD' then v_reason := 'Not paid in US dollars';
  elsif v_amount <= 0 then v_reason := 'Nothing paid toward the plan';
  else
    select coalesce(sum(amount), 0) into v_paid from shop_plan_payments where plan_id = v_plan.id;
    v_balance := v_plan.sale_price - v_plan.down_payment + v_plan.finance_charge - v_paid;
    if v_amount > v_balance then
      v_reason := 'More than the balance left (' || to_char(v_balance, 'FM$999,999,990.00') || ')';
    end if;
  end if;

  if v_reason is null then
    v_pay_id := 'shopify-' || v_order_id;
    insert into shop_plan_payments (id, plan_id, received_date, amount, method, notes, received_by)
    values (v_pay_id, v_plan.id, coalesce((v_at at time zone 'America/Phoenix')::date, (now() at time zone 'America/Phoenix')::date),
            v_amount, 'Shopify order ' || coalesce(v_name, v_order_id), 'Recorded automatically when Shopify reported it paid', v_auto);
    v_balance := v_balance - v_amount;
    update shop_payment_plans set status = case when v_balance = 0 then 'paid_off' else status end,
      updated_at = now(), updated_by = v_auto where id = v_plan.id;
    insert into shop_audit_log (table_name, row_id, action, actor, detail)
    values ('shop_plan_payments', v_pay_id, 'insert', v_auto,
            jsonb_build_object('plan_id', v_plan.id, 'amount', v_amount, 'shopify_order', v_order_id));
  end if;

  insert into shop_shopify_orders (order_id, order_name, pay_ref, plan_id, payment_id, amount, currency, status, reason, ordered_at)
  values (v_order_id, v_name, v_ref, v_plan.id, v_pay_id, v_amount, v_cur,
          case when v_reason is null then 'credited' else 'held' end, v_reason, v_at);
  return jsonb_build_object('order_id', v_order_id, 'status', case when v_reason is null then 'credited' else 'held' end,
                            'reason', v_reason, 'plan_id', v_plan.id, 'balance', case when v_reason is null then v_balance end);
end $$;
revoke all on function public.shop_record_shopify_order(jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.shop_record_shopify_order(jsonb) to service_role';
  end if;
end $$;

-- 4. Staff mark a held order as handled (refunded, recorded by hand, ...) -----
create or replace function public.shop_handle_shopify_order(p_order_id text, p_note text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  update shop_shopify_orders set status = 'handled', handled_by = v_uid, handled_at = now(),
    handled_note = left(nullif(btrim(coalesce(p_note, '')), ''), 500)
  where order_id = p_order_id and status = 'held';
  if not found then raise exception 'Held order not found'; end if;
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_shopify_orders', p_order_id, 'update', v_uid, jsonb_build_object('status', 'handled', 'note', p_note));
  return jsonb_build_object('order_id', p_order_id, 'status', 'handled');
end $$;
revoke all on function public.shop_handle_shopify_order(text, text) from public, anon;
grant execute on function public.shop_handle_shopify_order(text, text) to authenticated;

-- 5. The buyer's page also gets the loan number (same as shop-012 plus pay_ref) -
create or replace function public.shop_my_payment_plans()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to see your payments.' using errcode = '28000';
  end if;
  select lower(btrim(u.email)) into v_email
  from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null;
  if coalesce(v_email, '') = '' then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id,
      'customer_name', c.name,
      'item', s.item,
      'bike', case when b.id is null then null else jsonb_build_object('year', b.year, 'make', b.make, 'model', b.model, 'vin_last6', right(b.vin, 6)) end,
      'sale_date', s.sale_date,
      'sale_price', s.sale_price,
      'down_payment', s.down_payment,
      'schedule', s.schedule,
      'payment_amount', s.payment_amount,
      'due_day', s.due_day,
      'first_due_date', s.first_due_date,
      'apr', s.apr,
      'finance_charge', s.finance_charge,
      'late_fee_per_day', s.late_fee_per_day,
      'late_fee_grace_days', s.late_fee_grace_days,
      'late_fee_waived', s.late_fee_waived,
      'missed_limit', s.missed_limit,
      'pay_provider', s.pay_provider,
      'pay_link_url', s.pay_link_url,
      'pay_ref', pl.pay_ref,
      'autopay', s.autopay,
      'title_held', s.title_held,
      'status', s.status,
      'balance', s.balance,
      'total_paid', s.total_paid,
      'payments', coalesce((
        select jsonb_agg(jsonb_build_object('received_date', pp.received_date, 'amount', pp.amount, 'method', pp.method)
                         order by pp.received_date, pp.created_at)
        from public.shop_plan_payments pp where pp.plan_id = s.id), '[]'::jsonb)
    ) order by s.sale_date desc, s.id)
    from public.shop_payment_plan_summary s
    join public.shop_payment_plans pl on pl.id = s.id
    join public.shop_customers c on c.id = s.customer_id
    left join public.shop_bikes b on b.id = s.bike_id
    where lower(btrim(c.email)) = v_email
      and s.status <> 'cancelled'
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.shop_my_payment_plans() from public, anon;
grant execute on function public.shop_my_payment_plans() to authenticated;
