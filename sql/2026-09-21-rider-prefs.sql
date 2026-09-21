-- Stop preferences, one row per rider. NOT YET APPLIED to the live database: run it on
-- the Supabase VPS before (or right after) deploying prefs-sync.js. Until it exists the
-- Stop Preferences screen shows "Cloud unavailable (404)" and everything keeps working
-- on the device.
--
-- The whole preferences object (favorites, blocked brands, start group, detour limit and
-- the learned usual stops) is kept in `data`. The client compares updated_ms
-- (prefs.updatedAt) and only writes when its copy is newer.

create table if not exists public.rider_prefs (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_ms bigint not null,
  created_at timestamptz not null default now(),
  constraint rider_prefs_data_size check (octet_length(data::text) <= 100000)
);

alter table public.rider_prefs enable row level security;

create policy "Riders can view own prefs"
  on public.rider_prefs for select
  using (auth.uid() = owner_id);

create policy "Riders can insert own prefs"
  on public.rider_prefs for insert
  with check (auth.uid() = owner_id);

create policy "Riders can update own prefs"
  on public.rider_prefs for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "Riders can delete own prefs"
  on public.rider_prefs for delete
  using (auth.uid() = owner_id);
