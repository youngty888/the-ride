-- DRAFT MIGRATION — NOT APPLIED. Requires shop-001-core.sql first and Tyler's
-- explicit approval before running against the live VPS.
--
-- Write functions. All of these are SECURITY DEFINER and check
-- shop_has_staff_access() themselves — no table in shop-001 has an
-- insert/update/delete RLS policy, so these functions are the only way in.
--
-- shop_submit_estimate is the single-entry-point function: Tyler's instruction
-- was "one section should capture the info for the next... the customer page
-- collects from the estimate" — so the staff UI's estimate form calls this ONE
-- function with customer + bike + job fields together, and it upserts all
-- three records (customer, bike, job) in one transaction. Staff never fill out
-- a separate "new customer" or "new bike" form first.

create or replace function public.shop_submit_estimate(
  p_job_id text,                 -- null/absent => new job
  p_customer_id text,            -- null => create new customer from p_customer fields
  p_customer jsonb,               -- {name, phone, email, address}
  p_bike_id text,                 -- null => create new bike from p_bike fields
  p_bike jsonb,                    -- {vin, make, model, year, mileage}
  p_job jsonb                      -- {invoice_number, status, payment_status, job_date, parts_amount, labor_amount, tax_amount, total_amount, parts_cost, notes}
) returns table (customer_id text, bike_id text, job_id text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_customer_id text := p_customer_id;
  v_bike_id text := p_bike_id;
  v_job_id text := coalesce(p_job_id, encode(gen_random_bytes(9), 'base64'));
begin
  if not shop_has_staff_access() then
    raise exception 'not authorized';
  end if;

  -- 1. Customer: update if an id was given, else insert a new one from p_customer.
  if v_customer_id is not null then
    update public.shop_customers set
      name = coalesce(p_customer->>'name', name),
      phone = coalesce(p_customer->>'phone', phone),
      email = coalesce(p_customer->>'email', email),
      address = coalesce(p_customer->>'address', address),
      updated_at = now(), updated_by = v_uid
    where id = v_customer_id;
  else
    v_customer_id := encode(gen_random_bytes(9), 'base64');
    insert into public.shop_customers (id, name, phone, email, address, created_by, updated_by)
    values (v_customer_id, p_customer->>'name', p_customer->>'phone',
            p_customer->>'email', p_customer->>'address', v_uid, v_uid);
  end if;

  -- 2. Bike: same upsert pattern, linked to the customer.
  if p_bike is not null then
    if v_bike_id is not null then
      update public.shop_bikes set
        vin = coalesce(p_bike->>'vin', vin),
        make = coalesce(p_bike->>'make', make),
        model = coalesce(p_bike->>'model', model),
        year = coalesce((p_bike->>'year')::int, year),
        mileage = coalesce((p_bike->>'mileage')::int, mileage),
        customer_id = v_customer_id,
        updated_at = now(), updated_by = v_uid
      where id = v_bike_id;
    else
      v_bike_id := encode(gen_random_bytes(9), 'base64');
      insert into public.shop_bikes (id, customer_id, vin, make, model, year, mileage, created_by, updated_by)
      values (v_bike_id, v_customer_id, p_bike->>'vin', p_bike->>'make', p_bike->>'model',
              (p_bike->>'year')::int, (p_bike->>'mileage')::int, v_uid, v_uid);
    end if;
  end if;

  -- 3. Job: upsert, linked to customer + bike.
  insert into public.shop_jobs (id, invoice_number, customer_id, bike_id, status,
      payment_status, job_date, parts_amount, labor_amount, tax_amount,
      total_amount, parts_cost, notes, created_by, updated_by)
  values (v_job_id, p_job->>'invoice_number', v_customer_id, v_bike_id,
      coalesce(p_job->>'status', 'estimate'), coalesce(p_job->>'payment_status', 'unpaid'),
      coalesce((p_job->>'job_date')::date, current_date),
      coalesce((p_job->>'parts_amount')::numeric, 0), coalesce((p_job->>'labor_amount')::numeric, 0),
      coalesce((p_job->>'tax_amount')::numeric, 0), coalesce((p_job->>'total_amount')::numeric, 0),
      coalesce((p_job->>'parts_cost')::numeric, 0), p_job->>'notes', v_uid, v_uid)
  on conflict (id) do update set
    invoice_number = excluded.invoice_number, bike_id = excluded.bike_id,
    status = excluded.status, payment_status = excluded.payment_status,
    job_date = excluded.job_date, parts_amount = excluded.parts_amount,
    labor_amount = excluded.labor_amount, tax_amount = excluded.tax_amount,
    total_amount = excluded.total_amount, parts_cost = excluded.parts_cost,
    notes = excluded.notes, updated_at = now(), updated_by = v_uid;

  -- 4. Roll up Customer.last_visit / invoice_count / lifetime_spend from jobs.
  update public.shop_customers c set
    last_visit = greatest(coalesce(c.last_visit, '1900-01-01'::date),
                           (select max(job_date) from public.shop_jobs where customer_id = c.id)),
    invoice_count = (select count(*) from public.shop_jobs where customer_id = c.id),
    lifetime_spend = (select coalesce(sum(total_amount), 0) from public.shop_jobs
                      where customer_id = c.id and status = 'complete')
  where c.id = v_customer_id;

  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_jobs', v_job_id, case when p_job_id is null then 'insert' else 'update' end,
          v_uid, jsonb_build_object('customer_id', v_customer_id, 'bike_id', v_bike_id));

  return query select v_customer_id, v_bike_id, v_job_id;
end;
$$;

create or replace function public.shop_set_job_line_items(p_job_id text, p_items jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_item jsonb;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  delete from public.shop_job_line_items where job_id = p_job_id;
  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.shop_job_line_items (id, job_id, kind, description, quantity, unit_price, unit_cost, created_by)
    values (encode(gen_random_bytes(9), 'base64'), p_job_id, v_item->>'kind', v_item->>'description',
            coalesce((v_item->>'quantity')::numeric, 1), coalesce((v_item->>'unit_price')::numeric, 0),
            coalesce((v_item->>'unit_cost')::numeric, 0), v_uid);
  end loop;
  insert into public.shop_audit_log (table_name, row_id, action, actor)
  values ('shop_job_line_items', p_job_id, 'update', v_uid);
end;
$$;

create or replace function public.shop_upsert_part_order(p_order jsonb)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_id text := coalesce(p_order->>'id', encode(gen_random_bytes(9), 'base64'));
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  insert into public.shop_part_orders (id, log_number, order_number, supplier_name, part_description,
      job_id, date_ordered, cost, tax, charged, received, received_at, created_by, updated_by)
  values (v_id, p_order->>'log_number', p_order->>'order_number', p_order->>'supplier_name',
      p_order->>'part_description', p_order->>'job_id', coalesce((p_order->>'date_ordered')::date, current_date),
      coalesce((p_order->>'cost')::numeric,0), coalesce((p_order->>'tax')::numeric,0),
      coalesce((p_order->>'charged')::numeric,0), coalesce((p_order->>'received')::boolean,false),
      case when (p_order->>'received')::boolean then now() else null end, v_uid, v_uid)
  on conflict (id) do update set log_number = excluded.log_number, order_number = excluded.order_number,
      supplier_name = excluded.supplier_name, part_description = excluded.part_description,
      job_id = excluded.job_id, date_ordered = excluded.date_ordered, cost = excluded.cost,
      tax = excluded.tax, charged = excluded.charged, received = excluded.received,
      received_at = coalesce(public.shop_part_orders.received_at, case when excluded.received then now() else null end),
      updated_at = now(), updated_by = v_uid;
  insert into public.shop_audit_log (table_name, row_id, action, actor)
  values ('shop_part_orders', v_id, 'upsert', v_uid);
  return v_id;
end;
$$;
