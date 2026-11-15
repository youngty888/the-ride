-- shop-006: let staff mark a job Unpaid / Partial / Paid.
-- Additive and safe to re-run. Changes only payment_status (no amounts).
-- Run AFTER shop-004 is applied. NOT yet run on the live database: Tyler runs it.
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
  update public.shop_jobs set payment_status = p_payment_status, updated_at = now(), updated_by = v_uid
  where id = p_job_id returning * into v_job;
  if not found then raise exception 'Job not found'; end if;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_jobs', p_job_id, 'payment', v_uid, jsonb_build_object('to', p_payment_status));
  return jsonb_build_object('job_id', v_job.id, 'payment_status', v_job.payment_status, 'updated_at', v_job.updated_at);
end $$;
revoke all on function public.shop_set_payment_status(text, text) from public, anon;
grant execute on function public.shop_set_payment_status(text, text) to authenticated;
