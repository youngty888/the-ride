-- Follow-up to 2026-09-19-rider-rides.sql (already applied live).
-- Storage.genId() ids are only random per device, so two riders could collide on a
-- global primary key and the second rider's ride would be silently dropped by
-- "resolution=ignore-duplicates". Scope uniqueness to the rider instead.
-- Safe to run before any rider data exists; also fine after (ids are already unique).

begin;
alter table public.rider_rides drop constraint if exists rider_rides_pkey;
alter table public.rider_rides add primary key (owner_id, id);
commit;
