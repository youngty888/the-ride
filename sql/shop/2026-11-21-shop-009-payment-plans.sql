-- shop-009: payment plans. Tracks a bike (or anything) sold to a customer on
-- payments (monthly or every two weeks): sale terms, interest, late-fee terms,
-- the card pay link, every payment received, and the balance left.
-- Replaces the per-customer Google Sheet payment trackers.
-- Additive and safe to re-run. Run AFTER shop-004. Does not touch any other table.
-- (008 is held for tech sign-off work on another branch.)
-- NOT yet run on the live database: Tyler runs it.
--
-- Rules (Low Rider S tracker sheet, plus Tyler's financing terms of Nov 21):
--   * a set payment due monthly (one day of the month) or every 14 days
--   * interest is optional (apr 0 = flat price). With interest the finance
--     charge is worked out once when the plan is saved (pp-calc.js amortize)
--     and stored, so the balance is price - down + finance charge - paid
--   * late fees and missed-payment counts are SHOWN, never charged by the database
--   * the pay link belongs to a processor that deposits straight to the shop's
--     bank account (Tyler's pick: Stripe, card or bank autopay, paying out to the shop's bank). The provider is a
--     field, so it can be swapped (Stripe, Square...) without other changes.
--     No bank account or routing numbers are ever stored here.
--     Payments made through the link are still marked received by staff.
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
  schedule text not null default 'monthly' check (schedule in ('monthly','biweekly')),
  payment_amount numeric(10,2) not null check (payment_amount > 0),
  due_day integer check (due_day between 1 and 28),   -- monthly plans only
  first_due_date date not null,
  apr numeric(6,3) not null default 0 check (apr >= 0 and apr <= 100),
  term_payments integer check (term_payments between 1 and 520),
  finance_charge numeric(10,2) not null default 0 check (finance_charge >= 0),
  interest_note text not null default 'None, flat price',
  late_fee_per_day numeric(8,2) not null default 0 check (late_fee_per_day >= 0),
  late_fee_grace_days integer not null default 2 check (late_fee_grace_days between 0 and 60),
  late_fee_waived boolean not null default false,     -- an arrangement was made: no late fees
  missed_limit integer not null default 3 check (missed_limit between 1 and 24),
  pay_provider text check (pay_provider in ('chase','stripe','square','shopify','bank','other')), -- who deposits the money to the bank
  pay_link_url text check (pay_link_url ~ '^https://[A-Za-z0-9.-]+(/[^[:space:]"''<>]*)?$'),
  autopay text not null default 'off' check (autopay in ('off','pending','on')),
  autopay_note text,
  title_held boolean not null default true,  -- seller holds title until paid off
  status text not null default 'active' check (status in ('active','paid_off','cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,
  check (down_payment < sale_price),
  check ((schedule = 'monthly') = (due_day is not null)),
  check (apr = 0 or (term_payments is not null and finance_charge > 0))
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
  p.sale_price - p.down_payment + p.finance_charge as total_owed,
  greatest(p.sale_price - p.down_payment + p.finance_charge - coalesce(r.paid, 0), 0) as balance,
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
-- sale_price, down_payment, down_payment_date, schedule, payment_amount, due_day,
-- first_due_date, apr, term_payments, finance_charge, interest_note,
-- late_fee_per_day, late_fee_grace_days, late_fee_waived, missed_limit,
-- pay_provider, pay_link_url, autopay, autopay_note, title_held, status, notes}
create or replace function public.shop_save_payment_plan(p_plan_id text, p_plan jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_row public.shop_payment_plans%rowtype; v_exists boolean;
  v_cust text := shop_clean(p_plan->>'customer_id'); v_bike text := shop_clean(p_plan->>'bike_id');
  v_owner text; v_sched text := coalesce(shop_clean(p_plan->>'schedule'), 'monthly');
  v_link text := shop_clean(p_plan->>'pay_link_url');
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_plan_id is null or p_plan_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'invalid plan id'; end if;
  if v_sched not in ('monthly','biweekly') then raise exception 'Schedule must be monthly or every two weeks'; end if;
  if v_sched = 'monthly' and shop_clean(p_plan->>'due_day') is null then raise exception 'Monthly plans need a due day'; end if;
  if v_link is not null and v_link !~ '^https://[A-Za-z0-9.-]+(/[^[:space:]"''<>]*)?$' then
    raise exception 'Pay link must be a full https:// link';
  end if;
  if coalesce(shop_num(p_plan->>'apr', 'APR', 0), 0) > 0 and shop_clean(p_plan->>'term_payments') is null then
    raise exception 'Plans with interest need the number of payments';
  end if;
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
    down_payment_date, schedule, payment_amount, due_day, first_due_date, apr, term_payments, finance_charge,
    interest_note, late_fee_per_day, late_fee_grace_days, late_fee_waived, missed_limit,
    pay_provider, pay_link_url, autopay, autopay_note, title_held, status, notes, created_by, updated_by)
  values (p_plan_id, v_cust, v_bike, shop_clean(p_plan->>'item'), (p_plan->>'sale_date')::date,
    shop_num(p_plan->>'sale_price', 'Sale price', null), shop_num(p_plan->>'down_payment', 'Down payment', 0),
    nullif(shop_clean(p_plan->>'down_payment_date'), '')::date, v_sched,
    shop_num(p_plan->>'payment_amount', 'Payment amount', null),
    case when v_sched = 'monthly' then shop_int(p_plan->>'due_day', 'Due day') end,
    (p_plan->>'first_due_date')::date, shop_num(p_plan->>'apr', 'APR', 0),
    shop_int(p_plan->>'term_payments', 'Number of payments'), shop_num(p_plan->>'finance_charge', 'Finance charge', 0),
    coalesce(shop_clean(p_plan->>'interest_note'), case when coalesce(shop_num(p_plan->>'apr', 'APR', 0), 0) = 0 then 'None, flat price' else 'Simple interest' end),
    shop_num(p_plan->>'late_fee_per_day', 'Late fee', 0), coalesce(shop_int(p_plan->>'late_fee_grace_days', 'Grace days'), 2),
    coalesce((p_plan->>'late_fee_waived')::boolean, false), coalesce(shop_int(p_plan->>'missed_limit', 'Missed payments'), 3),
    shop_clean(p_plan->>'pay_provider'), v_link, coalesce(shop_clean(p_plan->>'autopay'), 'off'), shop_clean(p_plan->>'autopay_note'),
    coalesce((p_plan->>'title_held')::boolean, true), coalesce(shop_clean(p_plan->>'status'), 'active'),
    shop_clean(p_plan->>'notes'), v_uid, v_uid)
  on conflict (id) do update set
    customer_id = excluded.customer_id, bike_id = excluded.bike_id, item = excluded.item,
    sale_date = excluded.sale_date, sale_price = excluded.sale_price, down_payment = excluded.down_payment,
    down_payment_date = excluded.down_payment_date, schedule = excluded.schedule, payment_amount = excluded.payment_amount,
    due_day = excluded.due_day, first_due_date = excluded.first_due_date, apr = excluded.apr,
    term_payments = excluded.term_payments, finance_charge = excluded.finance_charge,
    interest_note = excluded.interest_note, late_fee_per_day = excluded.late_fee_per_day,
    late_fee_grace_days = excluded.late_fee_grace_days, late_fee_waived = excluded.late_fee_waived,
    missed_limit = excluded.missed_limit, pay_provider = excluded.pay_provider, pay_link_url = excluded.pay_link_url, autopay = excluded.autopay,
    autopay_note = excluded.autopay_note, title_held = excluded.title_held, status = excluded.status,
    notes = excluded.notes, updated_at = now(), updated_by = v_uid
  returning * into v_row;

  insert into shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_payment_plans', p_plan_id, case when v_exists then 'update' else 'insert' end, v_uid,
          jsonb_build_object('sale_price', v_row.sale_price, 'payment_amount', v_row.payment_amount, 'apr', v_row.apr,
            'schedule', v_row.schedule, 'status', v_row.status));
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
  v_balance := v_plan.sale_price - v_plan.down_payment + v_plan.finance_charge - v_paid;
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
