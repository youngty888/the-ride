-- shop-017: payments on invoices (amount, date, method), not just a label.
--   * shop_job_payments: one row per payment a customer makes on a job:
--     amount, date paid, how they paid (cash, card, Zelle...), an optional
--     reference (check no. or transaction id) and a note.
--   * Payments are never edited or deleted. A wrong one is voided with a
--     reason and drops out of every total.
--   * Once a job has any payment recorded, its Unpaid / Part paid / Paid
--     status follows the money: nothing paid = Unpaid, some = Part paid,
--     all of the total = Paid. If the job's total changes later, the status
--     follows that too. Jobs with no payments recorded keep the old label
--     dropdown, so the imported invoices still work as before.
--   * A payment can't be more than what is still owed, so totals can't go
--     below zero by mistake.
--   * A reference that looks like a card or bank account number is refused,
--     so nobody stores one by accident.
-- Additive and safe to re-run. Run AFTER shop-004 and shop-006.
-- NOT yet run on the live database: Tyler runs it in the server's SQL editor.

create table if not exists public.shop_job_payments (
  id text primary key,                     -- made by the app, so a double tap saves once
  job_id text not null references public.shop_jobs(id),
  amount numeric(10,2) not null check (amount > 0 and amount <= 1000000),
  paid_on date not null,
  method text not null check (method in ('cash','card','zelle','cash_app','venmo','paypal','check','shopify','financing','other')),
  reference text check (reference is null or reference !~ '\d{12,}'),
  note text,
  voided_at timestamptz, voided_by uuid, void_reason text,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  check (voided_at is null or nullif(btrim(void_reason), '') is not null)
);
create index if not exists shop_job_payments_job_idx on public.shop_job_payments (job_id, paid_on);

alter table public.shop_job_payments enable row level security;
drop policy if exists "Staff can view job payments" on public.shop_job_payments;
create policy "Staff can view job payments" on public.shop_job_payments
  for select using (public.shop_has_staff_access());
revoke all on public.shop_job_payments from public, anon, authenticated;
grant select on public.shop_job_payments to authenticated;

-- Paid so far and balance due for every job (jobs with no payments show 0 paid).
create or replace view public.shop_job_balances
with (security_invoker = true) as
select j.id as job_id,
  coalesce(sum(p.amount) filter (where p.voided_at is null), 0)::numeric(10,2) as amount_paid,
  (j.total_amount - coalesce(sum(p.amount) filter (where p.voided_at is null), 0))::numeric(10,2) as balance_due,
  count(p.id) filter (where p.voided_at is null)::integer as payment_count,
  (count(p.id) > 0) as has_payments,
  max(p.paid_on) filter (where p.voided_at is null) as last_paid_on
from public.shop_jobs j
left join public.shop_job_payments p on p.job_id = j.id
group by j.id, j.total_amount;
revoke all on public.shop_job_balances from public, anon, authenticated;
grant select on public.shop_job_balances to authenticated;

-- What the status should be for a total and an amount paid.
create or replace function public.shop_payment_status_for(p_total numeric, p_paid numeric)
returns text language sql immutable set search_path = public, pg_temp
as $$ select case when coalesce(p_paid, 0) <= 0 then 'unpaid'
                  when coalesce(p_paid, 0) >= coalesce(p_total, 0) then 'paid'
                  else 'partial' end $$;

-- Keeps payment_status in step with the money on any job that has payments,
-- whoever changes the job (the app or the SQL editor).
create or replace function public.shop_jobs_payment_sync()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_paid numeric;
begin
  if not exists (select 1 from public.shop_job_payments where job_id = new.id) then return new; end if;
  select coalesce(sum(amount), 0) into v_paid from public.shop_job_payments where job_id = new.id and voided_at is null;
  new.payment_status := public.shop_payment_status_for(new.total_amount, v_paid);
  return new;
end $$;
revoke all on function public.shop_jobs_payment_sync() from public, anon, authenticated;
drop trigger if exists shop_jobs_payment_sync on public.shop_jobs;
create trigger shop_jobs_payment_sync before insert or update on public.shop_jobs
  for each row execute function public.shop_jobs_payment_sync();

-- Record one payment on a job.
create or replace function public.shop_record_job_payment(p_id text, p_job_id text, p_payment jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); j public.shop_jobs%rowtype; v_prev public.shop_job_payments%rowtype;
  v_amount numeric; v_paid numeric; v_on date; v_method text; v_ref text;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if shop_clean(p_id) is null then raise exception 'Missing payment id'; end if;
  select * into v_prev from public.shop_job_payments where id = p_id;
  if found then
    if v_prev.job_id <> p_job_id then raise exception 'That payment id was already used for something else'; end if;
    select * into j from public.shop_jobs where id = p_job_id;
    return jsonb_build_object('payment_id', p_id, 'payment_status', j.payment_status, 'repeat', true);
  end if;
  select * into j from public.shop_jobs where id = p_job_id for update;   -- one payment at a time per job
  if not found then raise exception 'Job not found'; end if;
  v_amount := shop_num(p_payment->>'amount', 'Amount', null);
  if v_amount is null or v_amount <= 0 then raise exception 'Amount must be more than $0'; end if;
  if v_amount <> round(v_amount, 2) then raise exception 'Amount can only have cents (two decimals)'; end if;
  select coalesce(sum(amount), 0) into v_paid from public.shop_job_payments where job_id = p_job_id and voided_at is null;
  if v_paid + v_amount > j.total_amount then
    raise exception 'That is more than the $% still owed on this job', to_char(greatest(j.total_amount - v_paid, 0), 'FM999999990.00');
  end if;
  v_on := coalesce(nullif(btrim(coalesce(p_payment->>'paid_on', '')), '')::date, current_date);
  if v_on > current_date + 1 then raise exception 'The payment date can''t be in the future'; end if;
  v_method := lower(coalesce(shop_clean(p_payment->>'method'), ''));
  if v_method not in ('cash','card','zelle','cash_app','venmo','paypal','check','shopify','financing','other') then
    raise exception 'Pick how they paid';
  end if;
  v_ref := shop_clean(p_payment->>'reference');
  if v_ref ~ '\d{12,}' then raise exception 'Don''t save card or bank numbers. Use a check number or the last 4 only'; end if;
  insert into public.shop_job_payments (id, job_id, amount, paid_on, method, reference, note, created_by)
  values (p_id, p_job_id, v_amount, v_on, v_method, v_ref, shop_clean(p_payment->>'note'), v_uid);
  update public.shop_jobs set updated_at = now(), updated_by = v_uid where id = p_job_id returning * into j;  -- trigger sets the status
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_job_payments', p_id, 'insert', v_uid, jsonb_build_object('job_id', p_job_id, 'amount', v_amount, 'method', v_method, 'paid_on', v_on));
  return jsonb_build_object('payment_id', p_id, 'payment_status', j.payment_status,
    'amount_paid', v_paid + v_amount, 'balance_due', j.total_amount - v_paid - v_amount);
end $$;

-- Void a payment entered by mistake (it stays on record, marked void).
create or replace function public.shop_void_job_payment(p_id text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); p public.shop_job_payments%rowtype; j public.shop_jobs%rowtype;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if shop_clean(p_reason) is null then raise exception 'Say why this payment is being voided'; end if;
  select * into p from public.shop_job_payments where id = p_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if p.voided_at is not null then raise exception 'That payment was already voided'; end if;
  perform 1 from public.shop_jobs where id = p.job_id for update;
  update public.shop_job_payments set voided_at = now(), voided_by = v_uid, void_reason = shop_clean(p_reason) where id = p_id;
  update public.shop_jobs set updated_at = now(), updated_by = v_uid where id = p.job_id returning * into j;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_job_payments', p_id, 'void', v_uid, jsonb_build_object('job_id', p.job_id, 'amount', p.amount, 'reason', shop_clean(p_reason)));
  return jsonb_build_object('payment_id', p_id, 'payment_status', j.payment_status);
end $$;

-- The old label dropdown still works for jobs with no payments recorded.
-- Once a job has payments, its status follows them, so a hand change is refused.
create or replace function public.shop_set_payment_status(p_job_id text, p_payment_status text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_job public.shop_jobs%rowtype;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_payment_status is null or p_payment_status not in ('unpaid','partial','paid') then
    raise exception 'invalid payment status';
  end if;
  if exists (select 1 from public.shop_job_payments where job_id = p_job_id) then
    raise exception 'This job has payments recorded, so its status follows them. Add or void a payment instead';
  end if;
  update public.shop_jobs set payment_status = p_payment_status, updated_at = now(), updated_by = v_uid
  where id = p_job_id returning * into v_job;
  if not found then raise exception 'Job not found'; end if;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_jobs', p_job_id, 'payment', v_uid, jsonb_build_object('to', p_payment_status));
  return jsonb_build_object('job_id', v_job.id, 'payment_status', v_job.payment_status, 'updated_at', v_job.updated_at);
end $$;

do $$
declare f text;
begin
  foreach f in array array['shop_record_job_payment(text,text,jsonb)', 'shop_void_job_payment(text,text)', 'shop_set_payment_status(text,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  execute 'revoke all on function public.shop_payment_status_for(numeric,numeric) from public, anon';
  execute 'grant execute on function public.shop_payment_status_for(numeric,numeric) to authenticated';
end $$;
