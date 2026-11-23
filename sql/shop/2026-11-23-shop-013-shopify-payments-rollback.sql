-- Undo shop-013: Shopify plan payments.
-- Payments already credited from Shopify stay on their plans (they are normal
-- shop_plan_payments rows). Removes the order log, the record functions and the
-- loan numbers, and puts the buyer's page back to shop-012.
drop function if exists public.shop_handle_shopify_order(text, text);
drop function if exists public.shop_record_shopify_order(jsonb);
drop table if exists public.shop_shopify_orders;
drop index if exists public.shop_payment_plans_pay_ref_key;
alter table public.shop_payment_plans drop constraint if exists shop_payment_plans_pay_ref_format;
alter table public.shop_payment_plans drop column if exists pay_ref;
drop function if exists public.shop_new_pay_ref();
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
