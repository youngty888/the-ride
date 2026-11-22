-- shop-012: a buyer sees their own payment plan in the RIDE app (ride.siccycles.com/pay/).
--   * The buyer signs in with a normal RIDE login. Sign-ups are off, so the
--     shop makes the login in the server's Supabase dashboard
--     (Authentication > Users > Add user, tick Auto Confirm).
--   * A login is matched to a shop customer by email: the login's confirmed
--     email must be the same as the email on the customer record (case and
--     spaces ignored). A login with an unconfirmed email sees nothing.
--   * The buyer sees only their own plans, the payments the shop marked as
--     received, and the plan's pay link. Never the shop's private notes, who
--     marked a payment, or anyone else's records.
--   * The buyer cannot change anything. Staff still mark every payment.
-- Additive and safe to re-run. Run AFTER shop-009.

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
    join public.shop_customers c on c.id = s.customer_id
    left join public.shop_bikes b on b.id = s.bike_id
    where lower(btrim(c.email)) = v_email
      and s.status <> 'cancelled'
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.shop_my_payment_plans() from public, anon;
grant execute on function public.shop_my_payment_plans() to authenticated;
