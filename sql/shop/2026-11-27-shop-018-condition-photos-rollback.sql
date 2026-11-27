-- Rollback for shop-018 (locked condition photos).
-- WARNING: this removes the photo list. The photo files stay in the
-- shop-condition-photos bucket; this does not delete them.
-- Put back the shop-014 tow start (no photo rule) and board json.
create or replace function public.shop_tow_start(p_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v shop_tow_requests := shop_tow_get(p_id);
begin
  if v.status <> 'paid' then raise exception 'Not paid yet. No pickup until it is paid.'; end if;
  if v.waiver_signed_at is null then raise exception 'The waiver is not signed yet. Send them the waiver link.'; end if;
  if v.driver_id is null then raise exception 'Someone has to take it as driver first'; end if;
  if auth.uid() not in (v.driver_id, coalesce(v.navigator_id, v.driver_id)) and not shop_tow_is_admin() then
    raise exception 'Only the crew on this tow can start it'; end if;
  update shop_tow_requests set status = 'en_route', started_at = now(), updated_at = now() where id = p_id returning * into v;
  perform shop_tow_log(p_id, 'start', '{}'::jsonb);
  return shop_tow_json(v);
end $$;
revoke all on function public.shop_tow_start(text) from public, anon;
grant execute on function public.shop_tow_start(text) to authenticated;

create or replace function public.shop_tow_json(r shop_tow_requests)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select to_jsonb(r) - 'waiver_signature' - 'waiver_ip' - 'waiver_agent'
    || jsonb_build_object('waiver_signed', r.waiver_signed_at is not null,
         'driver_name', shop_tow_name(r.driver_id), 'navigator_name', shop_tow_name(r.navigator_id),
         'mine', auth.uid() in (r.driver_id, r.navigator_id));
$$;
revoke all on function public.shop_tow_json(shop_tow_requests) from public, anon, authenticated;

drop function if exists public.shop_add_condition_photo(text, text, text, text, text);
drop table if exists public.shop_condition_photos;
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'objects') then
    execute 'drop policy if exists "Staff and tow crew add condition photos" on storage.objects';
    execute 'drop policy if exists "Staff and tow crew view condition photos" on storage.objects';
  end if;
end $$;
