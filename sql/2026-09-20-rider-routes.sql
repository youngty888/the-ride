-- Saved routes, one row per route, owned by one rider. NOT YET APPLIED to the live
-- database: run it on the Supabase VPS before deploying routes-sync.js.
--
-- The whole route object (geometry, stops, notes...) is kept in `data` so the client
-- can add fields without a migration. The most recent edit wins: the client compares
-- updated_ms (route.updatedAt) and only writes when its copy is newer. Ride ids are
-- only random per device, so the key is (owner_id, id).

create table if not exists public.rider_routes (
  id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  data jsonb not null,
  updated_ms bigint not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  constraint rider_routes_data_size check (octet_length(data::text) <= 1000000)
);

alter table public.rider_routes enable row level security;

create policy "Riders can view own routes"
  on public.rider_routes for select
  using (auth.uid() = owner_id);

create policy "Riders can insert own routes"
  on public.rider_routes for insert
  with check (auth.uid() = owner_id);

create policy "Riders can update own routes"
  on public.rider_routes for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "Riders can delete own routes"
  on public.rider_routes for delete
  using (auth.uid() = owner_id);
