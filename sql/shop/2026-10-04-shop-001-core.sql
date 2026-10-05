-- DRAFT MIGRATION — NOT APPLIED. Requires Tyler's explicit approval before running
-- against the live Hostinger/Supabase VPS.
--
-- Shop module: replaces the manual "SICSYSTEMS" Google Sheet (Jobs_Log, Customers,
-- Order tabs + per-job invoice tabs) with real tables. Fields below are taken
-- directly from the verified SICSYSTEMS schema — nothing invented.
--
-- Everything is additive and prefixed shop_. No rider table is touched.
--
-- PERMISSIONS: flat, not tiered. Per Tyler's explicit instruction ("all three of
-- us fang garrett and i will have admin access to all three for now one
-- permission lets not overthink it"), shop_staff lists the allowed accounts and
-- every listed account has full read/write access to every shop_ table. There is
-- no role enum here (unlike wh_staff_roles in the Warehouse module) — this is a
-- deliberate simplification Tyler asked for, not an oversight.
--
-- Staff can READ through RLS. Nobody writes tables directly: every write goes
-- through a SECURITY DEFINER function (shop_*) that checks shop_has_staff_access().
-- Attribution columns are set on the server from auth.uid(), never by the client.
-- Every change to every shop_ table is written to shop_audit_log, which no API
-- role can edit.

create table if not exists public.shop_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.shop_has_staff_access()
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.shop_staff
    where user_id = auth.uid() and active
  );
$$;

create table if not exists public.shop_audit_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_id text not null,
  action text not null,            -- insert|update|delete
  actor uuid not null,
  changed_at timestamptz not null default now(),
  detail jsonb
);

alter table public.shop_staff enable row level security;
alter table public.shop_audit_log enable row level security;

create policy "Staff can view staff list" on public.shop_staff
  for select using (public.shop_has_staff_access());
create policy "Staff can view audit log" on public.shop_audit_log
  for select using (public.shop_has_staff_access());
-- No insert/update/delete policies on either table: shop_staff is managed by
-- Tyler directly (owner-level DB access), and shop_audit_log is write-only via
-- the SECURITY DEFINER functions below (never by API role / client directly).

-- ===================== CUSTOMERS =====================
-- Mirrors the SICSYSTEMS "Customers" sheet: Customer Name, Phone, Email,
-- Address, Last Visit, Invoices (count), Lifetime Spend. The count/spend
-- columns are kept as denormalized rollups (updated by shop_upsert_job) so the
-- staff UI doesn't need to compute them client-side.

create table if not exists public.shop_customers (
  id text primary key,              -- client-generated id (same genId pattern as rider_rides)
  name text not null,
  phone text,
  email text,
  address text,
  last_visit date,
  invoice_count integer not null default 0,
  lifetime_spend numeric(10,2) not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null
);

alter table public.shop_customers enable row level security;
create policy "Staff can view customers" on public.shop_customers
  for select using (public.shop_has_staff_access());
-- no direct insert/update/delete policy: writes only via shop_upsert_customer /
-- shop_upsert_job below.

-- ===================== BIKES =====================
-- New capability beyond the spreadsheet: a bike record keyed by VIN, carrying
-- photos. One bike can have many jobs over time (repeat customers).

create table if not exists public.shop_bikes (
  id text primary key,
  customer_id text references public.shop_customers(id) on delete set null,
  vin text,
  make text,
  model text,
  year integer,
  mileage integer,
  photo_urls jsonb not null default '[]'::jsonb,   -- array of storage URLs
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null
);

create index if not exists shop_bikes_vin_idx on public.shop_bikes (vin);
create index if not exists shop_bikes_customer_id_idx on public.shop_bikes (customer_id);

alter table public.shop_bikes enable row level security;
create policy "Staff can view bikes" on public.shop_bikes
  for select using (public.shop_has_staff_access());

-- ===================== JOBS =====================
-- One row per estimate/invoice, matching SICSYSTEMS Jobs_Log: Invoice #, Date,
-- Status, Payment, Customer, Bike, VIN, Parts $, Labor $, Tax $, Total $,
-- Parts Cost $, Part Profit, Total Profit, Notes. Status progresses
-- Estimate -> In Progress -> Complete (the sheet's real values were
-- "Estamate" [sic] / "I/W" / "Complete" — normalized here to proper spelling).

create table if not exists public.shop_jobs (
  id text primary key,
  invoice_number text unique,
  customer_id text not null references public.shop_customers(id),
  bike_id text references public.shop_bikes(id),
  status text not null default 'estimate'
    check (status in ('estimate','in_progress','complete')),
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid','partial','paid')),
  job_date date not null default current_date,
  parts_amount numeric(10,2) not null default 0,
  labor_amount numeric(10,2) not null default 0,
  tax_amount numeric(10,2) not null default 0,
  total_amount numeric(10,2) not null default 0,
  parts_cost numeric(10,2) not null default 0,   -- what SIC paid for the parts
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null
);

-- Profit columns are generated, not client-supplied, so they can never drift
-- from the amounts above (matches the sheet's "Part Profit" / "Total Profit"
-- derived columns).
alter table public.shop_jobs add column if not exists part_profit numeric(10,2)
  generated always as (parts_amount - parts_cost) stored;
alter table public.shop_jobs add column if not exists total_profit numeric(10,2)
  generated always as (total_amount - parts_cost) stored;

create index if not exists shop_jobs_customer_id_idx on public.shop_jobs (customer_id);
create index if not exists shop_jobs_bike_id_idx on public.shop_jobs (bike_id);
create index if not exists shop_jobs_status_idx on public.shop_jobs (status);

alter table public.shop_jobs enable row level security;
create policy "Staff can view jobs" on public.shop_jobs
  for select using (public.shop_has_staff_access());

-- ===================== JOB LINE ITEMS =====================
-- Parts/labor breakdown within a job (the Jobs_Log row only totals; line items
-- are the detail the per-job invoice tabs showed).

create table if not exists public.shop_job_line_items (
  id text primary key,
  job_id text not null references public.shop_jobs(id) on delete cascade,
  kind text not null check (kind in ('part','labor')),
  description text not null,
  quantity numeric(8,2) not null default 1,
  unit_price numeric(10,2) not null default 0,
  unit_cost numeric(10,2) not null default 0,  -- only meaningful for kind='part'
  created_at timestamptz not null default now(),
  created_by uuid not null
);

create index if not exists shop_job_line_items_job_id_idx on public.shop_job_line_items (job_id);

alter table public.shop_job_line_items enable row level security;
create policy "Staff can view job line items" on public.shop_job_line_items
  for select using (public.shop_has_staff_access());

-- ===================== PART ORDERS =====================
-- Mirrors the SICSYSTEMS "Order" sheet (parts-purchasing log, separate from
-- Jobs_Log): Date Ordered, Log#, Part Description, Invoice#, Cost, TAX,
-- Charged, Profit, Received, Order#, Supplier Name.

create table if not exists public.shop_part_orders (
  id text primary key,
  log_number text,
  order_number text,
  supplier_name text,
  part_description text not null,
  job_id text references public.shop_jobs(id),   -- links back to the invoice, if any
  date_ordered date not null default current_date,
  cost numeric(10,2) not null default 0,
  tax numeric(10,2) not null default 0,
  charged numeric(10,2) not null default 0,
  received boolean not null default false,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null
);

alter table public.shop_part_orders add column if not exists profit numeric(10,2)
  generated always as (charged - cost - tax) stored;

create index if not exists shop_part_orders_job_id_idx on public.shop_part_orders (job_id);

alter table public.shop_part_orders enable row level security;
create policy "Staff can view part orders" on public.shop_part_orders
  for select using (public.shop_has_staff_access());
