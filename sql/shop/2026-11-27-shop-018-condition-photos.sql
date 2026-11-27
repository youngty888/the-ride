-- shop-018: locked condition photos, so a customer can't say we did the damage.
--   * Intake photos: taken when a bike comes into the shop, saved on its job.
--   * Before-tow photos: taken at the pickup spot before it goes on the trailer,
--     saved on the tow.
--   * Each photo gets the server's own time stamp and who took it. Photos can't
--     be edited, replaced or deleted from the app: the files sit in their own
--     private bucket with no update or delete rule, and the photo list has no
--     edit or delete function.
--   * A tow can't be started until it has at least 4 before-tow photos
--     (front, back and both sides).
-- Additive and safe to re-run. Run AFTER shop-004 and shop-014.
-- NOT yet run on the live database: Tyler runs it in the server's SQL editor.

-- ===================== FILES =====================
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public) values ('shop-condition-photos', 'shop-condition-photos', false)
    on conflict (id) do update set public = false;
  end if;
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'objects') then
    execute 'drop policy if exists "Staff and tow crew add condition photos" on storage.objects';
    execute $p$create policy "Staff and tow crew add condition photos" on storage.objects for insert
      with check (bucket_id = 'shop-condition-photos' and (
        (split_part(name, '/', 1) = 'job' and public.shop_has_staff_access()) or
        (split_part(name, '/', 1) = 'tow' and (public.shop_tow_access() or public.shop_has_staff_access()))))$p$;
    execute 'drop policy if exists "Staff and tow crew view condition photos" on storage.objects';
    execute $p$create policy "Staff and tow crew view condition photos" on storage.objects for select
      using (bucket_id = 'shop-condition-photos' and (public.shop_has_staff_access() or
        (split_part(name, '/', 1) = 'tow' and public.shop_tow_access())))$p$;
    -- No update or delete rule on purpose: these files are locked.
  end if;
end $$;

-- ===================== PHOTO LIST =====================
create table if not exists public.shop_condition_photos (
  id text primary key,                                   -- made by the app, so a retry saves once
  kind text not null check (kind in ('intake', 'before_tow')),
  job_id text references public.shop_jobs(id),
  tow_id text references public.shop_tow_requests(id),
  storage_path text not null unique,
  note text,
  taken_at timestamptz not null default now(),           -- server time, not the phone's
  taken_by uuid not null,
  check ((kind = 'intake' and job_id is not null and tow_id is null)
      or (kind = 'before_tow' and tow_id is not null and job_id is null))
);
create index if not exists shop_condition_photos_job_idx on public.shop_condition_photos (job_id, taken_at);
create index if not exists shop_condition_photos_tow_idx on public.shop_condition_photos (tow_id, taken_at);

alter table public.shop_condition_photos enable row level security;
drop policy if exists "Staff and tow crew view condition photos" on public.shop_condition_photos;
create policy "Staff and tow crew view condition photos" on public.shop_condition_photos
  for select using (public.shop_has_staff_access() or (kind = 'before_tow' and public.shop_tow_access()));
revoke all on public.shop_condition_photos from public, anon, authenticated;
grant select on public.shop_condition_photos to authenticated;

-- Save one photo that was just uploaded. The file must already be in the bucket
-- under job/<job id>/ or tow/<tow id>/.
create or replace function public.shop_add_condition_photo(p_id text, p_kind text, p_target_id text, p_path text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_prev shop_condition_photos%rowtype; v_status text; v_count integer;
  v_folder text := case when p_kind = 'intake' then 'job' else 'tow' end;
begin
  if shop_clean(p_id) is null then raise exception 'Missing photo id'; end if;
  if p_kind = 'intake' then
    if not shop_has_staff_access() then raise exception 'not authorized'; end if;
    perform 1 from shop_jobs where id = p_target_id for update;
    if not found then raise exception 'Job not found'; end if;
  elsif p_kind = 'before_tow' then
    if not (shop_tow_access() or shop_has_staff_access()) then raise exception 'not authorized'; end if;
    select status into v_status from shop_tow_requests where id = p_target_id for update;
    if v_status is null then raise exception 'Tow not found'; end if;
    if v_status in ('en_route', 'delivered', 'cancelled') then raise exception 'Before-tow photos are taken before the tow starts'; end if;
  else
    raise exception 'Unknown photo kind';
  end if;
  select * into v_prev from shop_condition_photos where id = p_id;
  if found then
    if v_prev.storage_path <> p_path then raise exception 'That photo id was already used for something else'; end if;
  else
    if p_path is null or position('..' in p_path) > 0
       or split_part(p_path, '/', 1) <> v_folder
       or split_part(p_path, '/', 2) <> p_target_id or split_part(p_path, '/', 3) = '' then
      raise exception 'Photo is in the wrong folder';
    end if;
    if not exists (select 1 from storage.objects where bucket_id = 'shop-condition-photos' and name = p_path) then
      raise exception 'The photo did not upload. Try again';
    end if;
    insert into shop_condition_photos (id, kind, job_id, tow_id, storage_path, note, taken_by)
    values (p_id, p_kind, case when p_kind = 'intake' then p_target_id end, case when p_kind = 'before_tow' then p_target_id end,
            p_path, left(shop_clean(p_note), 200), v_uid);
    insert into shop_audit_log (table_name, row_id, action, actor, detail)
    values ('shop_condition_photos', p_id, 'insert', v_uid, jsonb_build_object('kind', p_kind, 'target', p_target_id));
  end if;
  select count(*) into v_count from shop_condition_photos
  where (p_kind = 'intake' and job_id = p_target_id) or (p_kind = 'before_tow' and tow_id = p_target_id);
  return jsonb_build_object('photo_id', p_id, 'count', v_count);
end $$;
revoke all on function public.shop_add_condition_photo(text, text, text, text, text) from public, anon;
grant execute on function public.shop_add_condition_photo(text, text, text, text, text) to authenticated;

-- ===================== TOWS =====================
-- The tow board shows how many before-tow photos each tow has.
create or replace function public.shop_tow_json(r shop_tow_requests)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select to_jsonb(r) - 'waiver_signature' - 'waiver_ip' - 'waiver_agent'
    || jsonb_build_object('waiver_signed', r.waiver_signed_at is not null,
         'driver_name', shop_tow_name(r.driver_id), 'navigator_name', shop_tow_name(r.navigator_id),
         'mine', auth.uid() in (r.driver_id, r.navigator_id),
         'before_photos', (select count(*) from shop_condition_photos p where p.tow_id = r.id));
$$;
revoke all on function public.shop_tow_json(shop_tow_requests) from public, anon, authenticated;

-- Start the tow. PAY FIRST, waiver signed, a driver set, and now 4 before-tow photos.
create or replace function public.shop_tow_start(p_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v shop_tow_requests := shop_tow_get(p_id); v_photos integer;
begin
  if v.status <> 'paid' then raise exception 'Not paid yet. No pickup until it is paid.'; end if;
  if v.waiver_signed_at is null then raise exception 'The waiver is not signed yet. Send them the waiver link.'; end if;
  if v.driver_id is null then raise exception 'Someone has to take it as driver first'; end if;
  if auth.uid() not in (v.driver_id, coalesce(v.navigator_id, v.driver_id)) and not shop_tow_is_admin() then
    raise exception 'Only the crew on this tow can start it'; end if;
  select count(*) into v_photos from shop_condition_photos where tow_id = p_id;
  if v_photos < 4 then
    raise exception 'Take at least 4 before-tow photos first (front, back and both sides). This tow has %.', v_photos;
  end if;
  update shop_tow_requests set status = 'en_route', started_at = now(), updated_at = now() where id = p_id returning * into v;
  perform shop_tow_log(p_id, 'start', '{}'::jsonb);
  return shop_tow_json(v);
end $$;
revoke all on function public.shop_tow_start(text) from public, anon;
grant execute on function public.shop_tow_start(text) to authenticated;
