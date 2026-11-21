-- shop-009: payment plans. Tracks a bike (or anything) sold to a customer on
-- monthly payments: sale terms, every payment received, and the balance left.
-- Replaces the per-customer Google Sheet payment trackers.
-- Additive and safe to re-run. Run AFTER shop-004. Does not touch any other table.
-- (008 is held for tech sign-off work on another branch.)
-- NOT yet run on the live database: Tyler runs it.
--
-- Rules carried over from the Low Rider S tracker sheet:
--   * flat price, no interest; a set monthly payment due on one day of the month
--   * extra money comes off the balance and moves the payoff date earlier
--   * only payments staff marked as received count (the sheet's "TY" initials);
--     the database records who marked it, from the sign-in, never from the client
--   * the seller keeps the title until the balance is 0
-- Balance, payments left, next due date and payoff are worked out from the rows,
-- never typed in, so they cannot drift.

create table if not exists public.shop_payment_plans (
  id text primary key,
  customer_id text not null references public.shop_customers(id),
  bike_id text references public.shop_bikes(id) on delete set null,
  item text not null,                         -- what was sold, e.g. "2023 Harley-Davidson Low Rider S"
  sale_date date not null,
  sale_price numeric(10,2) not null check (sale_price > 0),
  down_payment numeric(10,2) not null default 0 check (down_payment >= 0),
  down_payment_date date,
  monthly_payment numeric(10,2) not null check (monthly_payment > 0),
  due_day integer not null check (due_day between 1 and 28),
  first_due_date date not null,
  interest_note text not null default 'None, flat price',
  title_held boolean not null default true,  -- seller holds title until paid off
  status text not null default 'active' check (status in ('active','paid_off','cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,
  check (down_payment < sale_price)
);
create index if not exists shop_payment_plans_customer_idx on public.shop_payment_plans (customer_id);

create table if not exists public.shop_plan_payments (
  id text primary key,
  plan_id text not null references public.shop_payment_plans(id) on delete cascade,
  received_date date not null,
  amount numeric(10,2) not null check (amount > 0),
  method text,
  notes text,
  received_by uuid not null,                 -- the staff sign-in that marked it received
  created_at timestamptz not null default now()
);
create index if not exists shop_plan_payments_plan_idx on public.shop_plan_payments (plan_id, received_date);

alter table public.shop_payment_plans enable row level security;
alter table public.shop_plan_payments enable row level security;
drop policy if exists "Staff can view payment plans" on public.shop_payment_plans;
create policy "Staff can view payment plans" on public.shop_payment_plans
  for select using (public.shop_has_staff_access());
drop policy if exists "Staff can view plan payments" on public.shop_plan_payments;
create policy "Staff can view plan payments" on public.shop_plan_payments
  for select using (public.shop_has_staff_access());
revoke all on public.shop_payment_plans, public.shop_plan_payments from anon, authenticated;
grant select on public.shop_payment_plans, public.shop_plan_payments to authenticated;

-- One row per plan with the money worked out. Runs as the caller, so RLS on
-- the tables above still applies (non-staff see nothing).
create or replace view public.shop_payment_plan_summary
with (security_invoker = true) as
select p.*,
  coalesce(r.paid, 0) as payments_received,
  p.down_payment + coalesce(r.paid, 0) as total_paid,
  greatest(p.sale_price - p.down_payment - coalesce(r.paid, 0), 0) as balance,
  coalesce(r.count, 0) as payment_count,
  r.last_date as last_payment_date
from public.shop_payment_plans p
left join (
  select plan_id, sum(amount) as paid, count(*) as count, max(received_date) as last_date
  from public.shop_plan_payments group by plan_id
) r on r.plan_id = p.id;
revoke all on public.shop_payment_plan_summary from anon, authenticated;
grant select on public.shop_payment_plan_summary to authenticated;

-- Add or update a customer and (optionally) their bike without an estimate,
-- e.g. someone who bought a bike on payments. Same id rules as shop_save_estimate:
-- the app makes the ids, so saving twice never makes a copy.
-- p_customer: {name, phone, email, address}; p_bike: {vin, make, model, year, mileage} or null
create or replace function public.shop_save_customer(p_customer_id text, p_customer jsonb, p_bike_id text, p_bike jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_owner text; v_bike_exists boolean := false;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_customer_id is null or p_customer_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'invalid customer id'; end if;
  if shop_clean(p_customer->>'name') is null then raise exception 'Customer name is required'; end if;
  insert into shop_customers (id, name, phone, email, address, created_by, updated_by)
  values (p_customer_id, shop_clean(p_customer->>'name'), shop_clean(p_customer->>'phone'),
          shop_clean(p_customer->>'email'), shop_clean(p_customer->>'address'), v_uid, v_uid)
  on conflict (id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email,
    address = excluded.address, updated_at = now(), updated_by = v_uid;
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_customers', p_customer_id, 'upsert', v_uid, jsonb_build_object('via', 'shop_save_customer'));
  if p_bike is not null then
    if p_bike_id is null or p_bike_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'invalid bike id'; end if;
    select customer_id, true into v_owner, v_bike_exists from shop_bikes where id = p_bike_id;
    if v_bike_exists and v_owner is not null and v_owner <> p_customer_id then
      raise exception 'That bike is on a different customer''s record';
    end if;
    insert into shop_bikes (id, customer_id, vin, make, model, year, mileage, created_by, updated_by)
    values (p_bike_id, p_customer_id, upper(shop_clean(p_bike->>'vin')), shop_clean(p_bike->>'make'),
            shop_clean(p_bike->>'model'), shop_int(p_bike->>'year', 'Year'), shop_int(p_bike->>'mileage', 'Mileage'), v_uid, v_uid)
    on conflict (id) do update set customer_id = excluded.customer_id, vin = excluded.vin, make = excluded.make,
      model = excluded.model, year = excluded.year, mileage = excluded.mileage, updated_at = now(), updated_by = v_uid;
    insert into shop_audit_log (table_name, row_id, action, actor, detail)
    values ('shop_bikes', p_bike_id, 'upsert', v_uid, jsonb_build_object('via', 'shop_save_customer'));
  end if;
  return jsonb_build_object('customer_id', p_customer_id, 'bike_id', case when p_bike is null then null else p_bike_id end);
end $$;

-- Create or update a plan. The customer and bike must already exist (made on an
-- estimate, with shop_save_customer, or by a seed file). p_plan: {customer_id, bike_id, item, sale_date,
-- sale_price, down_payment, down_payment_date, monthly_payment, due_day,
-- first_due_date, interest_note, title_held, status, notes}
create or replace function public.shop_save_payment_plan(p_plan_id text, p_plan jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_row public.shop_payment_plans%rowtype; v_exists boolean;
  v_cust text := shop_clean(p_plan->>'customer_id'); v_bike text := shop_clean(p_plan->>'bike_id');
  v_owner text;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_plan_id is null or p_plan_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'invalid plan id'; end if;
  if v_cust is null or not exists (select 1 from shop_customers where id = v_cust) then raise exception 'Pick a customer'; end if;
  if v_bike is not null then
    select customer_id into v_owner from shop_bikes where id = v_bike;
    if not found then raise exception 'Bike not found'; end if;
    if v_owner is distinct from v_cust then raise exception 'That bike is on a different customer''s record'; end if;
  end if;
  if shop_clean(p_plan->>'item') is null then raise exception 'Say what was sold'; end if;
  if shop_clean(p_plan->>'sale_date') is null then raise exception 'Sale date is required'; end if;
  if shop_clean(p_plan->>'first_due_date') is null then raise exception 'First due date is required'; end if;
  select exists (select 1 from shop_payment_plans where id = p_plan_id) into v_exists;

  insert into shop_payment_plans (id, customer_id, bike_id, item, sale_date, sale_price, down_payment,
    down_payment_date, monthly_payment, due_day, first_due_date, interest_note, title_held, status, notes,
    created_by, updated_by)
  values (p_plan_id, v_cust, v_bike, shop_clean(p_plan->>'item'), (p_plan->>'sale_date')::date,
    shop_num(p_plan->>'sale_price', 'Sale price', null), shop_num(p_plan->>'down_payment', 'Down payment', 0),
    nullif(shop_clean(p_plan->>'down_payment_date'), '')::date,
    shop_num(p_plan->>'monthly_payment', 'Monthly payment', null), shop_int(p_plan->>'due_day', 'Due day'),
    (p_plan->>'first_due_date')::date, coalesce(shop_clean(p_plan->>'interest_note'), 'None, flat price'),
    coalesce((p_plan->>'title_held')::boolean, true), coalesce(shop_clean(p_plan->>'status'), 'active'),
    shop_clean(p_plan->>'notes'), v_uid, v_uid)
  on conflict (id) do update set
    customer_id = excluded.customer_id, bike_id = excluded.bike_id, item = excluded.item,
    sale_date = excluded.sale_date, sale_price = excluded.sale_price, down_payment = excluded.down_payment,
    down_payment_date = excluded.down_payment_date, monthly_payment = excluded.monthly_payment,
    due_day = excluded.due_day, first_due_date = excluded.first_due_date,
    interest_note = excluded.interest_note, title_held = excluded.title_held, status = excluded.status,
    notes = excluded.notes, updated_at = now(), updated_by = v_uid
  returning * into v_row;

  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_payment_plans', p_plan_id, case when v_exists then 'update' else 'insert' end, v_uid,
          jsonb_build_object('sale_price', v_row.sale_price, 'monthly_payment', v_row.monthly_payment, 'status', v_row.status));
  return jsonb_build_object('plan_id', v_row.id, 'updated_at', v_row.updated_at);
end $$;

-- Mark a payment received. The same id twice is a no-op, so a double tap never
-- records the money twice. Paying more than the balance is refused. When the
-- balance reaches 0 the plan is marked paid off (title can be signed over).
create or replace function public.shop_record_plan_payment(p_payment_id text, p_payment jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_plan public.shop_payment_plans%rowtype;
  v_plan_id text := shop_clean(p_payment->>'plan_id');
  v_amount numeric; v_paid numeric; v_balance numeric;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_payment_id is null or p_payment_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'invalid payment id'; end if;
  if exists (select 1 from shop_plan_payments where id = p_payment_id) then
    return jsonb_build_object('payment_id', p_payment_id, 'duplicate', true);
  end if;
  select * into v_plan from shop_payment_plans where id = v_plan_id for update;
  if not found then raise exception 'Payment plan not found'; end if;
  if v_plan.status = 'cancelled' then raise exception 'This plan is cancelled'; end if;
  v_amount := shop_num(p_payment->>'amount', 'Amount', null);
  if v_amount is null or v_amount <= 0 then raise exception 'Amount must be above 0'; end if;
  if v_amount <> round(v_amount, 2) then raise exception 'Amount: use at most 2 decimal places'; end if;
  if shop_clean(p_payment->>'received_date') is null then raise exception 'Date received is required'; end if;
  select coalesce(sum(amount), 0) into v_paid from shop_plan_payments where plan_id = v_plan_id;
  v_balance := v_plan.sale_price - v_plan.down_payment - v_paid;
  if v_amount > v_balance then
    raise exception 'That is more than the balance left (%)', to_char(v_balance, 'FM$999,999,990.00');
  end if;

  insert into shop_plan_payments (id, plan_id, received_date, amount, method, notes, received_by)
  values (p_payment_id, v_plan_id, (p_payment->>'received_date')::date, v_amount,
          shop_clean(p_payment->>'method'), shop_clean(p_payment->>'notes'), v_uid);
  v_balance := v_balance - v_amount;
  update shop_payment_plans set status = case when v_balance = 0 then 'paid_off' else status end,
    updated_at = now(), updated_by = v_uid where id = v_plan_id;
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_plan_payments', p_payment_id, 'insert', v_uid,
          jsonb_build_object('plan_id', v_plan_id, 'amount', v_amount, 'received_date', p_payment->>'received_date'));
  return jsonb_build_object('payment_id', p_payment_id, 'balance', v_balance);
end $$;

-- Take back a payment entered by mistake. Kept in the audit log.
create or replace function public.shop_delete_plan_payment(p_payment_id text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_row public.shop_plan_payments%rowtype;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  delete from shop_plan_payments where id = p_payment_id returning * into v_row;
  if not found then raise exception 'Payment not found'; end if;
  update shop_payment_plans set status = 'active', updated_at = now(), updated_by = v_uid
    where id = v_row.plan_id and status = 'paid_off';
  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_plan_payments', p_payment_id, 'delete', v_uid, to_jsonb(v_row));
  return jsonb_build_object('payment_id', p_payment_id, 'deleted', true);
end $$;

revoke all on function public.shop_save_customer(text, jsonb, text, jsonb) from public, anon;
revoke all on function public.shop_save_payment_plan(text, jsonb) from public, anon;
revoke all on function public.shop_record_plan_payment(text, jsonb) from public, anon;
revoke all on function public.shop_delete_plan_payment(text) from public, anon;
grant execute on function public.shop_save_customer(text, jsonb, text, jsonb) to authenticated;
grant execute on function public.shop_save_payment_plan(text, jsonb) to authenticated;
grant execute on function public.shop_record_plan_payment(text, jsonb) to authenticated;
grant execute on function public.shop_delete_plan_payment(text) to authenticated;
