-- Completed-ride history (Section 4: connect profiles, motorcycles, rides, stops,
-- and service history). APPLIED to the live Supabase VPS on 2026-09-19 with a
-- single-column primary key (id); 2026-09-20-rider-rides-composite-key.sql then
-- changed it to (owner_id, id). This file shows the final schema.
--
-- Each row is one completed ride, written once by the rider's own device.
-- Rows are never edited, so there are no revision/conflict columns and no update
-- policy. Ownership-based RLS matches the other rider tables.

create table if not exists public.rider_rides (
  id text not null,                                     -- client-generated id (Storage.genId(), not a uuid; only unique per rider)
  owner_id uuid not null references auth.users(id) on delete cascade,
  bike_id text,                                         -- bike id from the rider's Garage (app-side only; not FK'd, bikes are stored client-side)
  ride_date date not null,
  distance_miles numeric(8,2) not null,
  duration_seconds integer,
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);

create index if not exists rider_rides_owner_id_idx on public.rider_rides (owner_id);

alter table public.rider_rides enable row level security;

create policy "Riders can view own rides"
  on public.rider_rides for select
  using (auth.uid() = owner_id);

create policy "Riders can insert own rides"
  on public.rider_rides for insert
  with check (auth.uid() = owner_id);

create policy "Riders can delete own rides"
  on public.rider_rides for delete
  using (auth.uid() = owner_id);

-- No update policy: ride rows are immutable once synced. A ride deleted on the
-- device is deleted here by RidesCloud.pushDeletes() (see rides-sync.js).
