-- shop-016: Parts on order list + Closed folder for the shop job board.
-- Tyler runs it in the server's Supabase SQL editor. Needs shop-001 to shop-004.
-- Additive and safe to re-run. Nothing is deleted and no amounts change.
--   * Part orders get a tracking number and an ETA. A part ordered for a job
--     shows on the "Parts on order" list until someone marks it received.
--   * An estimate can be closed (done, declined or quote only). Closed estimates
--     and completed work orders leave the job board and live in "Closed".
--     A closed estimate can be reopened.
--
-- PRECHECK (run first, on its own). Every line should say true:
--   select to_regclass('public.shop_jobs') is not null as jobs_table_found,
--          to_regclass('public.shop_part_orders') is not null as part_orders_table_found,
--          to_regprocedure('public.shop_clean(text)') is not null as shop_004_installed,
--          to_regprocedure('public.shop_num(text, text, numeric)') is not null as shop_num_installed,
--          to_regprocedure('public.shop_has_staff_access()') is not null as staff_check_installed;
--
-- AFTER (optional checks):
--   select column_name from information_schema.columns
--    where table_name in ('shop_jobs', 'shop_part_orders')
--      and column_name in ('closed_at', 'closed_by', 'tracking_number', 'eta');      -- 4 rows
--   select count(*) as parts_on_order from public.shop_part_orders where not received;

-- ===================== COLUMNS =====================
alter table public.shop_jobs add column if not exists closed_at timestamptz;
alter table public.shop_jobs add column if not exists closed_by uuid;
alter table public.shop_part_orders add column if not exists tracking_number text;
alter table public.shop_part_orders add column if not exists eta date;
create index if not exists shop_part_orders_open_idx on public.shop_part_orders (eta) where not received;

-- 'YYYY-MM-DD' or blank -> date or null. Anything else gets a readable error.
create or replace function public.shop_date(p text, p_label text)
returns date language plpgsql immutable set search_path = public, pg_temp
as $$
declare v text := nullif(btrim(coalesce(p, '')), '');
begin
  if v is null then return null; end if;
  if v !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '% must be a date', p_label; end if;
  begin return v::date; exception when others then raise exception '% must be a real date', p_label; end;
end $$;

-- ===================== CLOSE / REOPEN AN ESTIMATE =====================
-- Only an estimate can be closed by hand. A work order closes when it is marked
-- complete (the page treats complete as closed), so its status is never touched here.
create or replace function public.shop_set_job_closed(p_job_id text, p_closed boolean)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_job public.shop_jobs%rowtype; v_close boolean := coalesce(p_closed, true);
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  select * into v_job from public.shop_jobs where id = p_job_id for update;
  if not found then raise exception 'Job not found'; end if;
  if v_close and v_job.status <> 'estimate' then
    raise exception 'Only an estimate can be closed. A work order closes when it is marked complete.';
  end if;
  update public.shop_jobs
     set closed_at = case when v_close then coalesce(closed_at, now()) else null end,
         closed_by = case when v_close then coalesce(closed_by, v_uid) else null end,
         updated_at = now(), updated_by = v_uid
   where id = p_job_id returning * into v_job;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_jobs', p_job_id, case when v_close then 'close' else 'reopen' end, v_uid, '{}'::jsonb);
  return jsonb_build_object('job_id', v_job.id, 'closed_at', v_job.closed_at, 'updated_at', v_job.updated_at);
end $$;
revoke all on function public.shop_set_job_closed(text, boolean) from public, anon;
grant execute on function public.shop_set_job_closed(text, boolean) to authenticated;

-- ===================== PART ORDERS =====================
-- p_order: {id?, job_id?, part_description, supplier_name, cost, order_number,
--           tracking_number, eta, date_ordered}. Blank job_id = shop stock / tools.
-- Received is changed only by shop_set_part_received, so an edit never un-receives a part.
create or replace function public.shop_save_part_order(p_order jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id text := coalesce(shop_clean(p_order->>'id'), replace(gen_random_uuid()::text, '-', ''));
  v_job text := shop_clean(p_order->>'job_id');
  v_desc text := shop_clean(p_order->>'part_description');
  v_cost numeric := shop_num(p_order->>'cost', 'Cost', 0);
  v_eta date := shop_date(p_order->>'eta', 'ETA');
  v_ordered date := coalesce(shop_date(p_order->>'date_ordered', 'Date ordered'), current_date);
  v_row public.shop_part_orders%rowtype;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if v_desc is null then raise exception 'Part description is required'; end if;
  if length(v_desc) > 500 then raise exception 'Part description is too long'; end if;
  if v_cost < 0 then raise exception 'Cost cannot be negative'; end if;
  if v_cost <> round(v_cost, 2) then raise exception 'Cost can have at most 2 decimal places'; end if;
  if v_job is not null and not exists (select 1 from public.shop_jobs where id = v_job) then raise exception 'Job not found'; end if;
  insert into public.shop_part_orders (id, job_id, part_description, supplier_name, cost, order_number,
      tracking_number, eta, date_ordered, created_by, updated_by)
  values (v_id, v_job, v_desc, shop_clean(p_order->>'supplier_name'), v_cost, shop_clean(p_order->>'order_number'),
      shop_clean(p_order->>'tracking_number'), v_eta, v_ordered, v_uid, v_uid)
  on conflict (id) do update set job_id = excluded.job_id, part_description = excluded.part_description,
      supplier_name = excluded.supplier_name, cost = excluded.cost, order_number = excluded.order_number,
      tracking_number = excluded.tracking_number, eta = excluded.eta, date_ordered = excluded.date_ordered,
      updated_at = now(), updated_by = v_uid
  returning * into v_row;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_part_orders', v_id, 'save', v_uid, jsonb_build_object('job_id', v_job));
  return to_jsonb(v_row);
end $$;
revoke all on function public.shop_save_part_order(jsonb) from public, anon;
grant execute on function public.shop_save_part_order(jsonb) to authenticated;

create or replace function public.shop_set_part_received(p_id text, p_received boolean)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_row public.shop_part_orders%rowtype; v_rec boolean := coalesce(p_received, true);
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  update public.shop_part_orders
     set received = v_rec, received_at = case when v_rec then coalesce(received_at, now()) else null end,
         updated_at = now(), updated_by = v_uid
   where id = p_id returning * into v_row;
  if not found then raise exception 'Part order not found'; end if;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_part_orders', p_id, case when v_rec then 'received' else 'not_received' end, v_uid, '{}'::jsonb);
  return to_jsonb(v_row);
end $$;
revoke all on function public.shop_set_part_received(text, boolean) from public, anon;
grant execute on function public.shop_set_part_received(text, boolean) to authenticated;
