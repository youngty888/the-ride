-- shop-008: tech sign-off and hours split.
--   * Each tech checks off the labor steps they did on a job, with their hours.
--     A step is a labor job name on the estimate ("Brake pads"); its bid hours
--     are the labor hours on the estimate for that name.
--   * Two or more techs can sign the same step, but the hours signed for a step
--     can never add up to more than its bid hours (Tyler's rule).
--   * Any staff member can flag a split as disputed. The payroll manager
--     settles it and has the final say on each tech's hours.
--   * Every time a staff member opens the shop app it is logged.
-- Sign-offs are keyed by job + step name, not by line id, so they survive the
-- estimate being re-saved (re-saving replaces line rows with new ids).
-- Additive and safe to re-run. Run AFTER shop-004. NOT yet run on the live
-- database: Tyler runs it. Make someone payroll manager with:
--   update public.shop_staff set payroll_manager = true where display_name = 'Tyler';

alter table public.shop_staff add column if not exists payroll_manager boolean not null default false;

create table if not exists public.shop_labor_signoffs (
  id bigint generated always as identity primary key,
  job_id text not null references public.shop_jobs(id) on delete cascade,
  step_key text not null,                -- lower(trim(labor job name))
  step_name text not null,
  tech_id uuid not null,
  hours numeric(6,2) not null check (hours > 0 and hours <= 999),
  signed_at timestamptz not null default now(),
  disputed boolean not null default false,
  dispute_note text,
  disputed_by uuid,
  disputed_at timestamptz,
  resolved_by uuid,                      -- payroll manager who set the final hours
  resolved_at timestamptz,
  unique (job_id, step_key, tech_id)
);
create index if not exists shop_labor_signoffs_signed_at on public.shop_labor_signoffs (signed_at);

create table if not exists public.shop_staff_logins (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  logged_at timestamptz not null default now()
);
create index if not exists shop_staff_logins_logged_at on public.shop_staff_logins (logged_at);

alter table public.shop_labor_signoffs enable row level security;
alter table public.shop_staff_logins enable row level security;
drop policy if exists "Staff can view labor signoffs" on public.shop_labor_signoffs;
create policy "Staff can view labor signoffs" on public.shop_labor_signoffs
  for select using (public.shop_has_staff_access());
drop policy if exists "Staff can view staff logins" on public.shop_staff_logins;
create policy "Staff can view staff logins" on public.shop_staff_logins
  for select using (public.shop_has_staff_access());
revoke all on public.shop_labor_signoffs, public.shop_staff_logins from anon;
revoke all on public.shop_labor_signoffs, public.shop_staff_logins from authenticated;
grant select on public.shop_labor_signoffs, public.shop_staff_logins to authenticated;

create or replace function public.shop_is_payroll_manager()
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.shop_staff where user_id = auth.uid() and active and payroll_manager);
$$;
revoke all on function public.shop_is_payroll_manager() from public, anon;
grant execute on function public.shop_is_payroll_manager() to authenticated;

-- Bid hours for one step of one job: the labor hours on the estimate for that name.
create or replace function public.shop_step_bid_hours(p_job_id text, p_step_key text)
returns numeric
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(sum(quantity), 0) from public.shop_job_line_items
  where job_id = p_job_id and kind = 'labor' and lower(trim(description)) = p_step_key;
$$;
revoke all on function public.shop_step_bid_hours(text, text) from public, anon, authenticated;

-- The signed-in tech signs (or changes) their own hours on one step.
-- p_hours null or 0 takes their sign-off back. A step the payroll manager
-- already settled can only be changed by the payroll manager.
create or replace function public.shop_sign_step(p_job_id text, p_step text, p_hours text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_key text; v_name text; v_hours numeric; v_bid numeric;
  v_others numeric; v_row public.shop_labor_signoffs;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  v_name := left(trim(coalesce(p_step, '')), 120); v_key := lower(v_name);
  if v_name = '' then raise exception 'Pick a step to sign'; end if;
  if not exists (select 1 from public.shop_jobs where id = p_job_id) then raise exception 'job not found'; end if;
  v_hours := shop_num(p_hours, 'Hours', 0);
  if v_hours < 0 or v_hours <> round(v_hours, 2) then raise exception 'Hours must be 0 or more, up to 2 decimals'; end if;
  v_bid := shop_step_bid_hours(p_job_id, v_key);
  if v_bid <= 0 then raise exception 'That step has no labor hours on the estimate'; end if;
  select trim(description) into v_name from public.shop_job_line_items   -- the estimate's spelling
    where job_id = p_job_id and kind = 'labor' and lower(trim(description)) = v_key order by sort_order limit 1;
  select * into v_row from public.shop_labor_signoffs where job_id = p_job_id and step_key = v_key and tech_id = v_uid;
  if v_row.resolved_at is not null and not shop_is_payroll_manager() then
    raise exception 'The payroll manager already settled this step. Ask them to change it.';
  end if;
  if v_hours = 0 then
    delete from public.shop_labor_signoffs where id = v_row.id;
    insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
    values ('shop_labor_signoffs', p_job_id, 'unsign', v_uid, jsonb_build_object('step', v_name));
    return jsonb_build_object('job_id', p_job_id, 'step', v_name, 'hours', 0, 'bid_hours', v_bid);
  end if;
  select coalesce(sum(hours), 0) into v_others from public.shop_labor_signoffs
    where job_id = p_job_id and step_key = v_key and tech_id <> v_uid;
  if v_others + v_hours > v_bid then
    raise exception 'Only % of the % bid hours are left on "%"', trim_scale(greatest(v_bid - v_others, 0)), trim_scale(v_bid), v_name;
  end if;
  insert into public.shop_labor_signoffs (job_id, step_key, step_name, tech_id, hours)
  values (p_job_id, v_key, v_name, v_uid, v_hours)
  on conflict (job_id, step_key, tech_id) do update set hours = excluded.hours, step_name = excluded.step_name, signed_at = now();
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_labor_signoffs', p_job_id, 'sign', v_uid, jsonb_build_object('step', v_name, 'hours', v_hours));
  return jsonb_build_object('job_id', p_job_id, 'step', v_name, 'hours', v_hours, 'bid_hours', v_bid);
end $$;
revoke all on function public.shop_sign_step(text, text, text) from public, anon;
grant execute on function public.shop_sign_step(text, text, text) to authenticated;

-- Any staff member flags a step's split as disputed.
create or replace function public.shop_dispute_step(p_job_id text, p_step text, p_note text)
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_key text := lower(trim(coalesce(p_step, ''))); n integer;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  update public.shop_labor_signoffs set disputed = true, dispute_note = left(shop_clean(p_note), 500),
    disputed_by = v_uid, disputed_at = now(), resolved_by = null, resolved_at = null
  where job_id = p_job_id and step_key = v_key;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Nobody has signed that step yet'; end if;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_labor_signoffs', p_job_id, 'dispute', v_uid, jsonb_build_object('step', p_step, 'note', left(p_note, 500)));
  return n;
end $$;
revoke all on function public.shop_dispute_step(text, text, text) from public, anon;
grant execute on function public.shop_dispute_step(text, text, text) to authenticated;

-- Payroll manager settles a step: sets every tech's final hours.
-- p_splits: [{"tech_id": "<uuid>", "hours": "1.5"}, ...]. Techs left out are
-- removed from the step. The total still cannot pass the bid hours.
create or replace function public.shop_settle_step(p_job_id text, p_step text, p_splits jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_name text := left(trim(coalesce(p_step, '')), 120); v_key text;
  v_bid numeric; v_total numeric := 0; s jsonb; v_tech uuid; v_h numeric; v_techs uuid[] := '{}';
begin
  if not shop_is_payroll_manager() then raise exception 'Only the payroll manager can settle hours'; end if;
  v_key := lower(v_name);
  if p_splits is null or jsonb_typeof(p_splits) <> 'array' then raise exception 'splits must be a list'; end if;
  v_bid := shop_step_bid_hours(p_job_id, v_key);
  if v_bid <= 0 then raise exception 'That step has no labor hours on the estimate'; end if;
  select trim(description) into v_name from public.shop_job_line_items   -- the estimate's spelling
    where job_id = p_job_id and kind = 'labor' and lower(trim(description)) = v_key order by sort_order limit 1;
  for s in select * from jsonb_array_elements(p_splits) loop
    v_tech := (s->>'tech_id')::uuid;
    if not exists (select 1 from public.shop_staff where user_id = v_tech) then raise exception 'unknown tech'; end if;
    if v_tech = any(v_techs) then raise exception 'a tech is listed twice'; end if;
    v_h := shop_num(s->>'hours', 'Hours', 0);
    if v_h <= 0 or v_h <> round(v_h, 2) then raise exception 'Each tech needs hours above 0 (up to 2 decimals)'; end if;
    v_techs := v_techs || v_tech; v_total := v_total + v_h;
  end loop;
  if v_total > v_bid then raise exception 'Split adds up to % hours but the bid is % hours', trim_scale(v_total), trim_scale(v_bid); end if;
  delete from public.shop_labor_signoffs where job_id = p_job_id and step_key = v_key and not (tech_id = any(v_techs));
  for s in select * from jsonb_array_elements(p_splits) loop
    insert into public.shop_labor_signoffs (job_id, step_key, step_name, tech_id, hours, resolved_by, resolved_at)
    values (p_job_id, v_key, v_name, (s->>'tech_id')::uuid, shop_num(s->>'hours', 'Hours', 0), v_uid, now())
    on conflict (job_id, step_key, tech_id) do update set hours = excluded.hours, step_name = excluded.step_name,
      disputed = false, resolved_by = v_uid, resolved_at = now();
  end loop;
  insert into public.shop_audit_log (table_name, row_id, action, actor, detail)
  values ('shop_labor_signoffs', p_job_id, 'settle', v_uid, jsonb_build_object('step', v_name, 'splits', p_splits));
  return jsonb_build_object('job_id', p_job_id, 'step', v_name, 'total_hours', v_total, 'bid_hours', v_bid);
end $$;
revoke all on function public.shop_settle_step(text, text, jsonb) from public, anon;
grant execute on function public.shop_settle_step(text, text, jsonb) to authenticated;

-- Called by the shop app when a staff member opens it (at most once per 10 minutes each).
create or replace function public.shop_log_login()
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not shop_has_staff_access() then return false; end if;
  if exists (select 1 from public.shop_staff_logins where user_id = auth.uid() and logged_at > now() - interval '10 minutes') then
    return true;
  end if;
  insert into public.shop_staff_logins (user_id) values (auth.uid());
  return true;
end $$;
revoke all on function public.shop_log_login() from public, anon;
grant execute on function public.shop_log_login() to authenticated;
notify pgrst, 'reload schema';
