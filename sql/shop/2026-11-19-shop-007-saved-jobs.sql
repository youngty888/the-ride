-- shop-007: saved jobs. Remembers each job name and the hours it usually takes,
-- so picking "Brake pads" on an estimate refills the same hours. Parts are NOT
-- saved (they differ by bike). Additive and safe to re-run. Run AFTER shop-004.
-- NOT yet run on the live database: Tyler runs it.
create table if not exists public.shop_saved_jobs (
  name_key text primary key,                       -- lower(trim(name))
  name text not null check (length(trim(name)) between 1 and 80),
  hours numeric(6,2) check (hours is null or (hours > 0 and hours <= 99)),
  use_count integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.shop_saved_jobs enable row level security;
drop policy if exists "Staff can view saved jobs" on public.shop_saved_jobs;
create policy "Staff can view saved jobs" on public.shop_saved_jobs
  for select using (public.shop_has_staff_access());
revoke all on public.shop_saved_jobs from anon;
revoke all on public.shop_saved_jobs from authenticated;
grant select on public.shop_saved_jobs to authenticated;

-- Job names Tyler named (hours are learned from real estimates, never guessed).
insert into public.shop_saved_jobs (name_key, name) values
  ('brake pads', 'Brake pads'), ('tires', 'Tires'), ('mounting', 'Mounting')
on conflict (name_key) do nothing;

-- p_jobs: [{"name": "Brake pads", "hours": "1.5"}, ...]. Called after an estimate
-- is saved. The most recent hours win; a row without hours only saves the name.
create or replace function public.shop_remember_jobs(p_jobs jsonb)
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare j jsonb; v_name text; v_hours numeric; n integer := 0;
begin
  if not shop_has_staff_access() then raise exception 'not authorized'; end if;
  if p_jobs is null or jsonb_typeof(p_jobs) <> 'array' then raise exception 'jobs must be a list'; end if;
  for j in select * from jsonb_array_elements(p_jobs) loop
    v_name := left(trim(coalesce(j->>'name', '')), 80);
    if v_name = '' then continue; end if;
    begin v_hours := nullif(trim(coalesce(j->>'hours', '')), '')::numeric; exception when others then v_hours := null; end;
    if v_hours is not null and (v_hours <= 0 or v_hours > 99) then v_hours := null; end if;
    insert into public.shop_saved_jobs (name_key, name, hours, use_count, updated_by)
      values (lower(v_name), v_name, round(v_hours, 2), 1, auth.uid())
    on conflict (name_key) do update set
      name = excluded.name, hours = coalesce(excluded.hours, public.shop_saved_jobs.hours),
      use_count = public.shop_saved_jobs.use_count + 1, updated_at = now(), updated_by = auth.uid();
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.shop_remember_jobs(jsonb) from public, anon;
grant execute on function public.shop_remember_jobs(jsonb) to authenticated;
notify pgrst, 'reload schema';
