-- shop-012: riders see their own payment plan (loan) in the RIDE Garage, attached to the bike.
-- A rider signs in to RIDE with the same email the shop has on their customer
-- record and can see ONLY their own plan and the payments staff marked received.
-- Read-only: no customer can change anything. Staff access is unchanged.
--
-- Safety:
--   * matched on the sign-in's email, and only when that email is CONFIRMED
--     (auth.users.email_confirmed_at), so nobody can sign up with someone
--     else's email and read their loan
--   * returns a fixed list of fields; never notes, staff ids or other customers
--   * no table or view is opened to customers; the only door is this function
-- Run AFTER shop-009 (payment plans). Rollback: 2026-11-21-shop-012-customer-loan-rollback.sql

create or replace function public.shop_my_payment_plans()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_email text;
begin
  if v_uid is null then raise exception 'Sign in to continue.' using errcode = '28000'; end if;
  select lower(btrim(u.email)) into v_email from auth.users u
    where u.id = v_uid and u.email_confirmed_at is not null;
  if v_email is null or v_email = '' then return '[]'::jsonb; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'item', s.item, 'status', s.status,
      'sale_date', s.sale_date, 'sale_price', s.sale_price, 'down_payment', s.down_payment,
      'schedule', s.schedule, 'payment_amount', s.payment_amount, 'due_day', s.due_day,
      'first_due_date', s.first_due_date, 'interest_note', s.interest_note,
      'total_owed', s.total_owed, 'total_paid', s.total_paid, 'balance', s.balance,
      'payment_count', s.payment_count, 'last_payment_date', s.last_payment_date,
      'title_held', s.title_held, 'pay_link_url', s.pay_link_url,
      'customer_name', c.name,
      'bike', case when b.id is null then null else jsonb_build_object(
        'make', b.make, 'model', b.model, 'year', b.year, 'mileage', b.mileage) end,
      'payments', coalesce((
        select jsonb_agg(jsonb_build_object('received_date', p.received_date, 'amount', p.amount, 'method', p.method)
                         order by p.received_date desc, p.created_at desc)
        from public.shop_plan_payments p where p.plan_id = s.id), '[]'::jsonb)
    ) order by s.sale_date desc)
    from public.shop_payment_plan_summary s
    join public.shop_customers c on c.id = s.customer_id
    left join public.shop_bikes b on b.id = s.bike_id
    where lower(btrim(c.email)) = v_email
  ), '[]'::jsonb);
end $$;

revoke all on function public.shop_my_payment_plans() from public, anon;
grant execute on function public.shop_my_payment_plans() to authenticated;
