-- DRAFT MIGRATION — NOT APPLIED. Requires Tyler's explicit approval before running
-- against the live Hostinger/Supabase VPS. Mirrors the ownership-based RLS pattern
-- already used for the other 7 rider tables (Section 2 of the build checklist).
--
-- Adds a table for completed-ride history (Section 4: "Connect profiles, motorcycles,
-- rides, stops, and service history" — profiles/bikes are already connected via
-- rider_app_state; this is the next piece, rides). Each row is one completed ride,
-- written once by the rider's own device and never edited by anyone else, so this
-- is a simple append-only, owner-scoped table — no revision/conflict columns needed.

create table if not exists public.rider_rides (
  id text primary key,                                  -- client-generated id (Storage.genId(), not a uuid)
  owner_id uuid not null references auth.users(id) on delete cascade,
  bike_id text,                                          -- references a bike id from the rider's Garage (app-side only; not FK'd, bikes are stored client-side)
  ride_date date not null,
  distance_miles numeric(8,2) not null,
  duration_seconds integer,
  created_at timestamptz not null default now()
);

create index if not exists rider_rides_owner_id_idx on public.rider_rides (owner_id);

alter table public.rider_rides enable row level security;

-- Ownership-based RLS: a rider can only see and write their own ride rows.
-- No anonymous access, matching every other rider table.
create policy "Riders can view own rides"
  on public.rider_rides for select
  using (auth.uid() = owner_id);

create policy "Riders can insert own rides"
  on public.rider_rides for insert
  with check (auth.uid() = owner_id);

create policy "Riders can delete own rides"
  on public.rider_rides for delete
  using (auth.uid() = owner_id);

-- No update policy: ride rows are treated as immutable once synced. If a rider
-- deletes a ride locally (Storage.deleteRide), the client currently does NOT
-- propagate that delete to the cloud yet — known gap, flagged in CHANGES.md,
-- not silently assumed away.
