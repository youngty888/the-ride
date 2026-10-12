-- Fangs Warehouse (Parts Warehouse) — core schema. NOT YET APPLIED to the live database.
--
-- Staff-only inventory for used/take-off motorcycle parts. The wh_items table is the
-- "Bible": one row per permanent SKU. Spreadsheets and Shopify CSV files are exports.
--
-- Design rules (see docs/warehouse/PHASE0.md):
--  * Everything is additive and prefixed wh_. No rider table is touched.
--  * Permissions come from wh_staff_roles, which only an owner can change. The
--    user_metadata "role" that signup writes is user-editable and is never trusted.
--  * Staff can READ through RLS. Nobody writes tables directly: every write goes through a
--    SECURITY DEFINER function (wh_*) that checks roles, the item version and the status
--    rules. Attribution columns are set on the server from auth.uid(), never by the client.
--  * Every change to every wh_ table is written to wh_audit_log, which no API role can edit.
--  * A part cannot reach ready_to_publish without fitment status + evidence, a fitment
--    reviewer's approval, every required measurement taken by hand (not a photo estimate),
--    the required photos, price, weight, dimensions, shipping class and a location.
--    AI suggestions can never satisfy fitment.
--
-- Apply after a fresh pg_dump. Rollback before real inventory exists:
--   sql/warehouse/2026-09-29-wh-001-rollback.sql

begin;

-- ---------------------------------------------------------------- staff and roles
create table if not exists public.wh_staff (
  user_id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null check (length(display_name) between 1 and 60),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.wh_staff_roles (
  user_id uuid not null references public.wh_staff(user_id) on delete cascade,
  role text not null check (role in ('owner','intake','fitment_reviewer','listing_approver','fulfillment')),
  granted_by uuid,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

create or replace function public.wh_has_role(p_role text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.wh_staff s join public.wh_staff_roles r using (user_id)
    where s.user_id = auth.uid() and s.active and (r.role = p_role or r.role = 'owner')
  );
$$;

create or replace function public.wh_is_staff()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.wh_staff s join public.wh_staff_roles r using (user_id)
    where s.user_id = auth.uid() and s.active
  );
$$;

-- ---------------------------------------------------------------- reference data
create table if not exists public.wh_systems (
  code text primary key,
  label text not null,
  sort int not null
);
insert into public.wh_systems (code, label, sort) values
  ('engine','Engine',1), ('fuel_intake','Fuel and intake',2), ('exhaust','Exhaust',3),
  ('primary_drivetrain','Primary and drivetrain',4), ('transmission','Transmission',5),
  ('electrical_ignition','Electrical and ignition',6), ('front_suspension','Front suspension and steering',7),
  ('rear_suspension','Rear suspension',8), ('wheels_tires','Wheels and tires',9), ('brakes','Brakes',10),
  ('controls','Hand and foot controls',11), ('frame_chassis','Frame and chassis',12),
  ('tanks_bodywork','Tanks and bodywork',13), ('seats_luggage','Seats and luggage',14),
  ('lighting','Lighting',15), ('hardware_misc','Hardware and miscellaneous',16)
on conflict (code) do nothing;

create table if not exists public.wh_engine_families (
  code text primary key,
  label text not null,
  sort int not null
);
insert into public.wh_engine_families (code, label, sort) values
  ('knucklehead','Knucklehead',1), ('panhead','Panhead',2), ('shovelhead','Shovelhead',3),
  ('ironhead','Ironhead Sportster',4), ('evolution','Evolution (Evo)',5), ('evo_sportster','Evo Sportster',6),
  ('twin_cam_88','Twin Cam 88',7), ('twin_cam_96','Twin Cam 96',8), ('twin_cam_103','Twin Cam 103',9),
  ('twin_cam_110','Twin Cam 110',10), ('milwaukee_eight','Milwaukee-Eight (M8)',11),
  ('revolution','Revolution',12), ('japanese','Japanese / metric',13), ('other','Other',14),
  ('universal','Universal',15)
on conflict (code) do nothing;

-- Measurements a category needs before an item can be published. Owners can add rows.
create table if not exists public.wh_category_measurements (
  system_code text not null references public.wh_systems(code),
  key text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  label text not null,
  unit text not null check (unit in ('in','mm','oz','lb','teeth','splines','count')),
  required boolean not null default true,
  primary key (system_code, key)
);
insert into public.wh_category_measurements (system_code, key, label, unit) values
  ('wheels_tires','rim_diameter','Rim diameter','in'),
  ('wheels_tires','rim_width','Rim width','in'),
  ('wheels_tires','axle_diameter','Axle bore diameter','mm'),
  ('brakes','rotor_diameter','Rotor diameter','in'),
  ('front_suspension','fork_tube_diameter','Fork tube diameter','mm'),
  ('rear_suspension','eye_to_eye','Shock eye-to-eye length','in'),
  ('exhaust','head_pipe_od','Head pipe outside diameter','in'),
  ('primary_drivetrain','sprocket_teeth','Sprocket/pulley teeth','teeth'),
  ('controls','bore_diameter','Master cylinder bore','in')
on conflict do nothing;

-- ---------------------------------------------------------------- locations
create table if not exists public.wh_locations (
  warehouse text not null check (warehouse ~ '^WH[0-9]{1,2}$'),
  row_no int not null check (row_no between 1 and 99),
  shelf_no int not null check (shelf_no between 1 and 99),
  bin_no int not null check (bin_no between 1 and 99),
  code text generated always as (
    warehouse || '-R' || lpad(row_no::text, 2, '0') || '-S' || lpad(shelf_no::text, 2, '0') || '-B' || lpad(bin_no::text, 2, '0')
  ) stored primary key,
  label text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (warehouse, row_no, shelf_no, bin_no)
);

-- ---------------------------------------------------------------- items (the Bible)
create sequence if not exists public.wh_sku_seq start 1;

create table if not exists public.wh_items (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique check (sku ~ '^SIC-[0-9]{6,}$'),
  status text not null default 'draft' check (status in (
    'draft','research_draft','fitment_review','needs_info','listing_review','ready_to_publish',
    'published','reserved','sold','shipped','installed','on_hold','archived')),

  title text check (length(title) <= 255),
  description text,
  brand text,
  oem_aftermarket text check (oem_aftermarket in ('oem','aftermarket','unknown')),
  oem_part_number text,
  casting_numbers text[] not null default '{}',
  system_code text references public.wh_systems(code),
  color text,
  material text,
  quantity int not null default 1 check (quantity >= 0),

  condition_grade text check (condition_grade in ('new_nos','excellent','good','fair','core_parts')),
  condition_notes text,
  tested_status text check (tested_status in ('tested_working','untested','known_issue','not_applicable')),

  bare_length_in numeric(8,2) check (bare_length_in > 0),
  bare_width_in numeric(8,2) check (bare_width_in > 0),
  bare_height_in numeric(8,2) check (bare_height_in > 0),
  packed_length_in numeric(8,2) check (packed_length_in > 0),
  packed_width_in numeric(8,2) check (packed_width_in > 0),
  packed_height_in numeric(8,2) check (packed_height_in > 0),
  weight_oz numeric(10,2) check (weight_oz > 0),
  weight_source text check (weight_source in ('scale','estimated','photo_estimate')),
  shipping_class text check (shipping_class in ('small_parcel','medium_parcel','large_parcel','oversize','freight','local_pickup')),
  is_oversize boolean not null default false,
  is_hazmat boolean not null default false,
  local_pickup_only boolean not null default false,

  location_code text references public.wh_locations(code),
  asking_price numeric(10,2) check (asking_price >= 0),

  fitment_status text check (fitment_status in ('verified_exact','verified_conditions','probable','universal','unknown')),
  fitment_evidence_level text check (fitment_evidence_level in (
    'part_number_match','catalog_reference','physical_test_fit','measurement_match','seller_claim','ai_suggestion')),
  fitment_evidence_source text,
  fitment_disposition text check (fitment_disposition in ('approved','needs_info','rejected')),
  ai_suggestion jsonb,  -- reference only; never copied into fitment by the database

  shopify_product_id text,
  shopify_variant_id text,
  ebay_item_id text,
  source text not null default 'intake' check (source in ('intake','ebay_import')),
  ebay_import jsonb,  -- the imported eBay row, kept for reference (title, price, category, condition)

  version int not null default 1,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  fitment_verified_by uuid, fitment_verified_at timestamptz,
  condition_graded_by uuid, condition_graded_at timestamptz,
  listing_approved_by uuid, listing_approved_at timestamptz,
  published_by uuid, published_at timestamptz,
  picked_by uuid, picked_at timestamptz,
  packed_by uuid, packed_at timestamptz
);
create index if not exists wh_items_status_idx on public.wh_items (status);
create index if not exists wh_items_created_by_idx on public.wh_items (created_by);
create index if not exists wh_items_location_idx on public.wh_items (location_code);
create unique index if not exists wh_items_ebay_item_idx on public.wh_items (ebay_item_id) where ebay_item_id is not null;

create table if not exists public.wh_item_financials (
  item_id uuid primary key references public.wh_items(id) on delete cascade,
  cost numeric(10,2) check (cost >= 0),
  consignor text,
  min_approved_price numeric(10,2) check (min_approved_price >= 0),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- Many fitment applications per item (years, models, engine families).
create table if not exists public.wh_fitments (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.wh_items(id) on delete cascade,
  make text not null default 'Harley-Davidson',
  engine_family text references public.wh_engine_families(code),
  platform text,      -- e.g. FLH Touring, FXR, Softail, Dyna, Sportster
  model_codes text,   -- e.g. FLHTC, FXST
  start_year int check (start_year between 1900 and 2100),
  end_year int check (end_year between 1900 and 2100),
  conditions text,
  exclusions text,
  created_by uuid,
  created_at timestamptz not null default now(),
  check (end_year is null or start_year is null or end_year >= start_year)
);
create index if not exists wh_fitments_item_idx on public.wh_fitments (item_id);
create index if not exists wh_fitments_family_idx on public.wh_fitments (engine_family);

create table if not exists public.wh_measurements (
  item_id uuid not null references public.wh_items(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  value numeric(12,3) not null,
  unit text not null check (unit in ('in','mm','oz','lb','teeth','splines','count')),
  method text not null check (method in ('caliper','tape','scale','count','photo_estimate')),
  measured_by uuid,
  measured_at timestamptz not null default now(),
  primary key (item_id, key)
);

create table if not exists public.wh_media (
  id uuid primary key,  -- generated on the phone so a retried upload can't duplicate
  item_id uuid not null references public.wh_items(id) on delete cascade,
  slot text not null check (slot in ('sku_card','overall_front','overall_back','part_number','casting_mark',
    'mounting_point','connector','defect','measurement','scale_weight','other','video')),
  kind text not null check (kind in ('photo','video')),
  bucket text not null check (bucket in ('wh-originals','wh-marketplace','external')),  -- external = the seller's existing eBay photo (path holds its https URL)
  path text not null,
  bytes bigint check (bytes > 0),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  derived_from uuid references public.wh_media(id),
  position int not null default 0,
  hidden boolean not null default false,
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  unique (bucket, path)
);
create index if not exists wh_media_item_idx on public.wh_media (item_id);

create table if not exists public.wh_reviews (
  id bigint generated always as identity primary key,
  item_id uuid not null references public.wh_items(id) on delete cascade,
  from_status text not null,
  to_status text not null,
  notes text,
  reviewer uuid,
  at timestamptz not null default now()
);
create index if not exists wh_reviews_item_idx on public.wh_reviews (item_id);

create table if not exists public.wh_moves (
  id bigint generated always as identity primary key,
  item_id uuid not null references public.wh_items(id) on delete cascade,
  from_code text,
  to_code text not null,
  qty int not null default 1,
  reason text,
  moved_by uuid,
  moved_at timestamptz not null default now()
);
create index if not exists wh_moves_item_idx on public.wh_moves (item_id);

create table if not exists public.wh_exports (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('master_csv','master_xlsx','worker_csv','worker_xlsx','shopify_csv',
    'missing_info','fitment_review','location_report','ebay_csv')),
  filters jsonb not null default '{}',
  row_count int not null,
  sha256 text,
  created_by uuid,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- audit
create table if not exists public.wh_audit_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_pk text,
  action text not null,
  actor uuid,
  at timestamptz not null default now(),
  old_row jsonb,
  new_row jsonb,
  changed text[]
);
create index if not exists wh_audit_row_idx on public.wh_audit_log (table_name, row_pk);

create or replace function public.wh_audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare o jsonb; n jsonb; pk text;
begin
  if tg_op <> 'INSERT' then o := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then n := to_jsonb(new); end if;
  pk := coalesce(n, o) ->> coalesce(tg_argv[0], 'id');
  insert into public.wh_audit_log (table_name, row_pk, action, actor, old_row, new_row, changed)
  values (tg_table_name, pk, lower(tg_op), auth.uid(), o, n,
    case when tg_op = 'UPDATE' then
      array(select e.key from jsonb_each(n) e where o -> e.key is distinct from e.value order by e.key)
    end);
  return null;
end $$;

do $$
declare t text; k text;
begin
  for t, k in select * from (values
    ('wh_items','id'), ('wh_item_financials','item_id'), ('wh_fitments','item_id'),
    ('wh_measurements','item_id'), ('wh_media','item_id'), ('wh_locations','code'),
    ('wh_staff','user_id'), ('wh_staff_roles','user_id'), ('wh_category_measurements','system_code')) v(t, k)
  loop
    execute format('drop trigger if exists wh_audit on public.%I', t);
    execute format('create trigger wh_audit after insert or update or delete on public.%I
                    for each row execute function public.wh_audit(%L)', t, k);
  end loop;
end $$;

-- Version, updated_by and updated_at are always set here, never by the client.
create or replace function public.wh_items_touch()
returns trigger language plpgsql as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), old.updated_by);
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.sku := old.sku;
  return new;
end $$;
drop trigger if exists wh_items_touch on public.wh_items;
create trigger wh_items_touch before update on public.wh_items
  for each row execute function public.wh_items_touch();

-- ---------------------------------------------------------------- helpers
create or replace function public.wh_require(p_ok boolean, p_message text)
returns void language plpgsql immutable as $$
begin
  if not p_ok then raise exception using errcode = '42501', message = p_message; end if;
end $$;

create or replace function public.wh_me()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'staff', public.wh_is_staff(),
    'display_name', (select display_name from public.wh_staff where user_id = auth.uid() and active),
    'roles', coalesce((select jsonb_agg(r.role order by r.role) from public.wh_staff_roles r
                       join public.wh_staff s using (user_id) where r.user_id = auth.uid() and s.active), '[]'::jsonb));
$$;

-- Everything missing before an item may become ready_to_publish. Empty array = passes.
create or replace function public.wh_publish_blockers(p_item uuid)
returns text[] language plpgsql stable security definer set search_path = public, pg_temp as $$
declare i public.wh_items; b text[] := '{}'; m record;
begin
  if not public.wh_is_staff() then return array['warehouse staff only']; end if;
  select * into i from public.wh_items where id = p_item;
  if not found then return array['item not found']; end if;
  if coalesce(trim(i.title), '') = '' then b := array_append(b, 'title'); end if;
  if coalesce(trim(i.description), '') = '' then b := array_append(b, 'description'); end if;
  if i.system_code is null then b := array_append(b, 'system/category'); end if;
  if i.fitment_status is null or i.fitment_status = 'unknown' then b := array_append(b, 'fitment status (not unknown)'); end if;
  if i.fitment_evidence_level is null then b := array_append(b, 'fitment evidence level'); end if;
  if i.fitment_evidence_level = 'ai_suggestion' then b := array_append(b, 'fitment evidence cannot be an AI suggestion'); end if;
  if coalesce(i.fitment_disposition, '') <> 'approved' then b := array_append(b, 'fitment reviewer approval'); end if;
  if i.fitment_status in ('verified_exact','verified_conditions','probable')
     and not exists (select 1 from public.wh_fitments f where f.item_id = i.id) then
    b := array_append(b, 'at least one fitment application (make/family/years)');
  end if;
  if i.condition_grade is null then b := array_append(b, 'condition grade'); end if;
  if i.tested_status is null then b := array_append(b, 'tested status'); end if;
  if i.asking_price is null then b := array_append(b, 'asking price'); end if;
  if i.weight_oz is null or i.weight_source is null then b := array_append(b, 'weight and weight source'); end if;
  if i.bare_length_in is null or i.bare_width_in is null or i.bare_height_in is null then b := array_append(b, 'bare dimensions'); end if;
  if i.shipping_class is null then b := array_append(b, 'shipping class'); end if;
  if i.location_code is null then b := array_append(b, 'warehouse location'); end if;
  if i.quantity < 1 then b := array_append(b, 'quantity'); end if;
  for m in
    select c.key, c.label from public.wh_category_measurements c
    where c.system_code = i.system_code and c.required
      and not exists (select 1 from public.wh_measurements x
                      where x.item_id = i.id and x.key = c.key and x.method <> 'photo_estimate')
  loop
    b := b || ('measurement: ' || m.label || ' (by hand, not photo)');
  end loop;
  b := b || public.wh_photo_blockers(p_item, true);
  return b;
end $$;

-- Photos needed to submit for review (p_full = false) or to publish (p_full = true).
create or replace function public.wh_photo_blockers(p_item uuid, p_full boolean)
returns text[] language plpgsql stable security definer set search_path = public, pg_temp as $$
declare i public.wh_items; b text[] := '{}'; s text;
begin
  select * into i from public.wh_items where id = p_item;
  -- Parts imported from eBay reuse the eBay photos; they only need a new SKU-card photo
  -- (proof the part is physically here and labelled). New intake needs the full set.
  foreach s in array case when i.source = 'ebay_import' then array['sku_card'] else array['sku_card','overall_front','overall_back'] end loop
    if not exists (select 1 from public.wh_media where item_id = p_item and slot = s and not hidden and bucket = 'wh-originals') then
      b := b || ('photo: ' || s);
    end if;
  end loop;
  if p_full and i.source = 'ebay_import' then
    if not exists (select 1 from public.wh_media where item_id = p_item and bucket in ('wh-marketplace','external') and not hidden) then
      b := array_append(b, 'marketplace image');
    end if;
  elsif p_full then
    if (i.oem_part_number is not null or cardinality(i.casting_numbers) > 0)
       and not exists (select 1 from public.wh_media where item_id = p_item and slot in ('part_number','casting_mark') and not hidden) then
      b := array_append(b, 'photo: part_number or casting_mark');
    end if;
    if i.condition_grade in ('fair','core_parts')
       and not exists (select 1 from public.wh_media where item_id = p_item and slot = 'defect' and not hidden) then
      b := array_append(b, 'photo: defect');
    end if;
    if exists (select 1 from public.wh_category_measurements c where c.system_code = i.system_code and c.required)
       and not exists (select 1 from public.wh_media where item_id = p_item and slot = 'measurement' and not hidden) then
      b := array_append(b, 'photo: measurement');
    end if;
    if not exists (select 1 from public.wh_media where item_id = p_item and bucket in ('wh-marketplace','external') and not hidden) then
      b := array_append(b, 'marketplace image');
    end if;
  end if;
  return b;
end $$;

-- ---------------------------------------------------------------- write functions
-- Editable fields. Status, stamps, SKU, location and attribution are not in this list.
create or replace function public.wh_editable_fields()
returns text[] language sql immutable as $$
  select array['title','description','brand','oem_aftermarket','oem_part_number','casting_numbers','system_code',
    'color','material','quantity','condition_grade','condition_notes','tested_status',
    'bare_length_in','bare_width_in','bare_height_in','packed_length_in','packed_width_in','packed_height_in',
    'weight_oz','weight_source','shipping_class','is_oversize','is_hazmat','local_pickup_only','asking_price',
    'fitment_status','fitment_evidence_level','fitment_evidence_source','ai_suggestion',
    'shopify_product_id','shopify_variant_id','ebay_item_id'];
$$;

-- Who may edit an item in its current status.
create or replace function public.wh_can_edit(p_status text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_status in ('draft','research_draft','needs_info') then
      public.wh_has_role('intake') or public.wh_has_role('fitment_reviewer') or public.wh_has_role('listing_approver')
    when p_status in ('fitment_review') then public.wh_has_role('fitment_reviewer') or public.wh_has_role('listing_approver')
    when p_status in ('listing_review','ready_to_publish','published','reserved') then public.wh_has_role('listing_approver')
    else public.wh_has_role('owner')
  end;
$$;

-- Optimistic-lock update. Returns {"ok":true,"item":{...}} or, when someone else saved
-- first, {"ok":false,"conflict":true,"current":{...}} so the phone can show both copies.
create or replace function public.wh_update_item(p_id uuid, p_expected_version int, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.wh_items; n public.wh_items; bad text[];
begin
  perform public.wh_require(public.wh_is_staff(), 'Warehouse staff only.');
  select * into r from public.wh_items where id = p_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Item not found.'; end if;
  if r.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'conflict', true, 'current', to_jsonb(r));
  end if;
  bad := array(select k from jsonb_object_keys(coalesce(p_changes, '{}'::jsonb)) k
               where k <> all(public.wh_editable_fields()));
  perform public.wh_require(cardinality(bad) = 0, 'These fields cannot be edited here: ' || array_to_string(bad, ', '));
  perform public.wh_require(public.wh_can_edit(r.status), 'You cannot edit an item in status ' || r.status || '.');
  if (p_changes ? 'shopify_product_id' or p_changes ? 'shopify_variant_id' or p_changes ? 'ebay_item_id') then
    perform public.wh_require(public.wh_has_role('listing_approver'), 'Only listing approvers can set channel ids.');
  end if;

  n := jsonb_populate_record(r, p_changes);

  if r.status not in ('draft','research_draft','needs_info','fitment_review') and (
       n.fitment_status is distinct from r.fitment_status or
       n.fitment_evidence_level is distinct from r.fitment_evidence_level or
       n.fitment_evidence_source is distinct from r.fitment_evidence_source) then
    perform public.wh_require(false, 'Fitment is locked after fitment review. Send the item back to fitment review to change it.');
  end if;

  update public.wh_items set
    title = n.title, description = n.description, brand = n.brand, oem_aftermarket = n.oem_aftermarket,
    oem_part_number = n.oem_part_number, casting_numbers = coalesce(n.casting_numbers, '{}'),
    system_code = n.system_code, color = n.color, material = n.material, quantity = n.quantity,
    condition_grade = n.condition_grade, condition_notes = n.condition_notes, tested_status = n.tested_status,
    bare_length_in = n.bare_length_in, bare_width_in = n.bare_width_in, bare_height_in = n.bare_height_in,
    packed_length_in = n.packed_length_in, packed_width_in = n.packed_width_in, packed_height_in = n.packed_height_in,
    weight_oz = n.weight_oz, weight_source = n.weight_source, shipping_class = n.shipping_class,
    is_oversize = n.is_oversize, is_hazmat = n.is_hazmat, local_pickup_only = n.local_pickup_only,
    asking_price = n.asking_price, fitment_status = n.fitment_status,
    fitment_evidence_level = n.fitment_evidence_level, fitment_evidence_source = n.fitment_evidence_source,
    ai_suggestion = n.ai_suggestion, shopify_product_id = n.shopify_product_id,
    shopify_variant_id = n.shopify_variant_id, ebay_item_id = n.ebay_item_id
  where id = p_id returning * into n;
  return jsonb_build_object('ok', true, 'item', to_jsonb(n));
end $$;

-- Create an item and fill its first fields in one call.
create or replace function public.wh_create_item(p_fields jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.wh_items; v_sku text;
begin
  perform public.wh_require(public.wh_has_role('intake'), 'Only intake staff can create items.');
  v_sku := 'SIC-' || lpad(nextval('public.wh_sku_seq')::text, 6, '0');
  insert into public.wh_items (sku, created_by, updated_by) values (v_sku, auth.uid(), auth.uid())
  returning * into r;
  if p_fields is null or p_fields = '{}'::jsonb then
    return jsonb_build_object('ok', true, 'item', to_jsonb(r));
  end if;
  return public.wh_update_item(r.id, r.version, p_fields);
end $$;

create or replace function public.wh_fitment_open(p_status text)
returns boolean language sql immutable as $$
  select p_status in ('draft','research_draft','needs_info','fitment_review');
$$;

-- Replace the fitment applications of an item (bumps the item version).
create or replace function public.wh_save_fitments(p_item uuid, p_expected_version int, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.wh_items; x jsonb;
begin
  perform public.wh_require(public.wh_is_staff(), 'Warehouse staff only.');
  select * into r from public.wh_items where id = p_item for update;
  if not found then raise exception using errcode = 'P0002', message = 'Item not found.'; end if;
  if r.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'conflict', true, 'current', to_jsonb(r));
  end if;
  perform public.wh_require(public.wh_fitment_open(r.status) and public.wh_can_edit(r.status),
    'Fitment is locked in status ' || r.status || '.');
  perform public.wh_require(jsonb_typeof(p_rows) = 'array' and jsonb_array_length(p_rows) <= 50, 'Fitments must be a list (max 50).');
  delete from public.wh_fitments where item_id = p_item;
  for x in select * from jsonb_array_elements(p_rows) loop
    insert into public.wh_fitments (item_id, make, engine_family, platform, model_codes, start_year, end_year,
      conditions, exclusions, created_by)
    values (p_item, coalesce(nullif(trim(x->>'make'), ''), 'Harley-Davidson'), nullif(x->>'engine_family', ''),
      nullif(x->>'platform', ''), nullif(x->>'model_codes', ''), (nullif(x->>'start_year', ''))::int,
      (nullif(x->>'end_year', ''))::int, nullif(x->>'conditions', ''), nullif(x->>'exclusions', ''), auth.uid());
  end loop;
  update public.wh_items set updated_at = now() where id = p_item returning * into r;
  return jsonb_build_object('ok', true, 'item', to_jsonb(r));
end $$;

create or replace function public.wh_save_measurement(p_item uuid, p_key text, p_value numeric, p_unit text, p_method text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.wh_items;
begin
  perform public.wh_require(public.wh_is_staff(), 'Warehouse staff only.');
  select * into r from public.wh_items where id = p_item for update;
  if not found then raise exception using errcode = 'P0002', message = 'Item not found.'; end if;
  perform public.wh_require(public.wh_can_edit(r.status), 'You cannot edit an item in status ' || r.status || '.');
  if p_value is null then
    delete from public.wh_measurements where item_id = p_item and key = p_key;
  else
    insert into public.wh_measurements (item_id, key, value, unit, method, measured_by)
    values (p_item, p_key, p_value, p_unit, p_method, auth.uid())
    on conflict (item_id, key) do update set value = excluded.value, unit = excluded.unit,
      method = excluded.method, measured_by = excluded.measured_by, measured_at = now();
  end if;
end $$;

create or replace function public.wh_set_financials(p_item uuid, p_cost numeric, p_consignor text, p_min_price numeric)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.wh_require(public.wh_has_role('listing_approver'), 'Only listing approvers and owners can set cost or minimum price.');
  insert into public.wh_item_financials (item_id, cost, consignor, min_approved_price, updated_by)
  values (p_item, p_cost, nullif(trim(p_consignor), ''), p_min_price, auth.uid())
  on conflict (item_id) do update set cost = excluded.cost, consignor = excluded.consignor,
    min_approved_price = excluded.min_approved_price, updated_by = excluded.updated_by, updated_at = now();
end $$;

-- Register an uploaded file. Idempotent on the phone-generated id.
create or replace function public.wh_add_media(p_id uuid, p_item uuid, p_slot text, p_kind text, p_bucket text,
  p_path text, p_bytes bigint, p_sha256 text, p_derived_from uuid default null, p_position int default 0)
returns public.wh_media language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.wh_items; m public.wh_media;
begin
  perform public.wh_require(public.wh_is_staff(), 'Warehouse staff only.');
  select * into r from public.wh_items where id = p_item;
  if not found then raise exception using errcode = 'P0002', message = 'Item not found.'; end if;
  perform public.wh_require(public.wh_can_edit(r.status), 'You cannot add photos to an item in status ' || r.status || '.');
  if p_bucket = 'external' then
    perform public.wh_require(p_path ~ '^https://i\.ebayimg\.com/[A-Za-z0-9/_.~%-]+$', 'External photos must be eBay image links (https://i.ebayimg.com/...).');
  else
    perform public.wh_require(p_path like 'items/' || r.sku || '/%' and p_path !~ '\.\.', 'File path must be under items/' || r.sku || '/.');
  end if;
  insert into public.wh_media (id, item_id, slot, kind, bucket, path, bytes, sha256, derived_from, position, uploaded_by)
  values (p_id, p_item, p_slot, p_kind, p_bucket, p_path, p_bytes, lower(p_sha256), p_derived_from, p_position, auth.uid())
  on conflict (id) do nothing;
  select * into m from public.wh_media where id = p_id;
  return m;
end $$;

create or replace function public.wh_hide_media(p_id uuid, p_hidden boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare s text;
begin
  select i.status into s from public.wh_media m join public.wh_items i on i.id = m.item_id where m.id = p_id;
  perform public.wh_require(s is not null and public.wh_can_edit(s), 'You cannot change photos on this item.');
  update public.wh_media set hidden = p_hidden where id = p_id;
end $$;

create or replace function public.wh_upsert_location(p_warehouse text, p_row int, p_shelf int, p_bin int, p_label text default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare c text;
begin
  perform public.wh_require(public.wh_is_staff(), 'Warehouse staff only.');
  insert into public.wh_locations (warehouse, row_no, shelf_no, bin_no, label)
  values (upper(p_warehouse), p_row, p_shelf, p_bin, p_label)
  on conflict (warehouse, row_no, shelf_no, bin_no) do nothing;
  select code into c from public.wh_locations
  where warehouse = upper(p_warehouse) and row_no = p_row and shelf_no = p_shelf and bin_no = p_bin;
  return c;
end $$;

-- Move an item (also used for its first shelf assignment). Every move is logged.
create or replace function public.wh_move_item(p_item uuid, p_to_code text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.wh_items;
begin
  perform public.wh_require(public.wh_has_role('intake') or public.wh_has_role('fulfillment'), 'Only intake or fulfillment staff can move items.');
  perform public.wh_require(exists (select 1 from public.wh_locations where code = p_to_code and active), 'Unknown or inactive location ' || coalesce(p_to_code, '') || '.');
  select * into r from public.wh_items where id = p_item for update;
  if not found then raise exception using errcode = 'P0002', message = 'Item not found.'; end if;
  perform public.wh_require(r.status not in ('shipped','installed','archived'), 'Item has left the warehouse.');
  if r.location_code is not distinct from p_to_code then
    return jsonb_build_object('ok', true, 'item', to_jsonb(r));
  end if;
  insert into public.wh_moves (item_id, from_code, to_code, qty, reason, moved_by)
  values (p_item, r.location_code, p_to_code, r.quantity, p_reason, auth.uid());
  update public.wh_items set location_code = p_to_code where id = p_item returning * into r;
  return jsonb_build_object('ok', true, 'item', to_jsonb(r));
end $$;

-- The only way to change status. Checks the role for each step and the publish gate.
create or replace function public.wh_transition(p_item uuid, p_to text, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.wh_items; need text; blockers text[];
begin
  perform public.wh_require(public.wh_is_staff(), 'Warehouse staff only.');
  select * into r from public.wh_items where id = p_item for update;
  if not found then raise exception using errcode = 'P0002', message = 'Item not found.'; end if;

  need := case r.status || '>' || p_to
    when 'draft>research_draft' then 'intake'
    when 'research_draft>draft' then 'intake'
    when 'draft>fitment_review' then 'intake'
    when 'needs_info>fitment_review' then 'intake'
    when 'fitment_review>listing_review' then 'fitment_reviewer'
    when 'fitment_review>needs_info' then 'fitment_reviewer'
    when 'fitment_review>research_draft' then 'fitment_reviewer'
    when 'listing_review>ready_to_publish' then 'listing_approver'
    when 'listing_review>needs_info' then 'listing_approver'
    when 'listing_review>fitment_review' then 'listing_approver'
    when 'ready_to_publish>published' then 'listing_approver'
    when 'ready_to_publish>listing_review' then 'listing_approver'
    when 'published>listing_review' then 'listing_approver'
    when 'published>reserved' then 'fulfillment'
    when 'reserved>published' then 'fulfillment'
    when 'published>sold' then 'fulfillment'
    when 'reserved>sold' then 'fulfillment'
    when 'sold>shipped' then 'fulfillment'
    when 'sold>installed' then 'fulfillment'
    when 'on_hold>draft' then 'owner'
    else case when p_to in ('on_hold','archived') and r.status not in ('archived') then 'owner' end
  end;
  perform public.wh_require(need is not null, 'Cannot move an item from ' || r.status || ' to ' || p_to || '.');
  perform public.wh_require(public.wh_has_role(need), 'This step needs the ' || need || ' role.');

  if p_to = 'fitment_review' then
    blockers := public.wh_photo_blockers(p_item, false);
    if coalesce(trim(r.title), '') = '' then blockers := array_append(blockers, 'title'); end if;
    if r.system_code is null then blockers := array_append(blockers, 'system/category'); end if;
    if r.location_code is null then blockers := array_append(blockers, 'warehouse location'); end if;
    perform public.wh_require(cardinality(blockers) = 0, 'Missing before review: ' || array_to_string(blockers, '; '));
  end if;

  if r.status = 'fitment_review' and p_to = 'listing_review' then
    perform public.wh_require(r.fitment_status is not null and r.fitment_status <> 'unknown',
      'Unknown fitment cannot pass review. Send it to research instead.');
    perform public.wh_require(r.fitment_evidence_level is not null and r.fitment_evidence_level <> 'ai_suggestion',
      'Fitment needs real evidence; an AI suggestion is not evidence.');
    perform public.wh_require(r.condition_grade is not null, 'Grade the condition first.');
    update public.wh_items set fitment_disposition = 'approved', fitment_verified_by = auth.uid(), fitment_verified_at = now(),
      condition_graded_by = auth.uid(), condition_graded_at = now() where id = p_item;
  elsif r.status = 'fitment_review' and p_to in ('needs_info','research_draft') then
    update public.wh_items set fitment_disposition = case when p_to = 'needs_info' then 'needs_info' else 'rejected' end
    where id = p_item;
  elsif p_to = 'fitment_review' then
    update public.wh_items set fitment_disposition = null, fitment_verified_by = null, fitment_verified_at = null
    where id = p_item;
  end if;

  if p_to = 'ready_to_publish' then
    blockers := public.wh_publish_blockers(p_item);
    perform public.wh_require(cardinality(blockers) = 0, 'Not ready to publish. Missing: ' || array_to_string(blockers, '; '));
    update public.wh_items set listing_approved_by = auth.uid(), listing_approved_at = now() where id = p_item;
  elsif p_to = 'published' then
    blockers := public.wh_publish_blockers(p_item);
    perform public.wh_require(cardinality(blockers) = 0, 'Not ready to publish. Missing: ' || array_to_string(blockers, '; '));
    update public.wh_items set published_by = auth.uid(), published_at = now() where id = p_item;
  elsif p_to = 'shipped' then
    update public.wh_items set packed_by = auth.uid(), packed_at = now() where id = p_item;
  elsif p_to = 'sold' then
    update public.wh_items set picked_by = auth.uid(), picked_at = now() where id = p_item;
  end if;

  insert into public.wh_reviews (item_id, from_status, to_status, notes, reviewer)
  values (p_item, r.status, p_to, nullif(trim(p_notes), ''), auth.uid());
  update public.wh_items set status = p_to where id = p_item returning * into r;
  return jsonb_build_object('ok', true, 'item', to_jsonb(r));
end $$;

create or replace function public.wh_log_export(p_kind text, p_filters jsonb, p_row_count int, p_sha256 text)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v bigint;
begin
  perform public.wh_require(public.wh_is_staff(), 'Warehouse staff only.');
  if p_kind = 'shopify_csv' then
    perform public.wh_require(public.wh_has_role('listing_approver'), 'Only listing approvers can export for Shopify.');
  end if;
  insert into public.wh_exports (kind, filters, row_count, sha256, created_by)
  values (p_kind, coalesce(p_filters, '{}'), p_row_count, p_sha256, auth.uid()) returning id into v;
  return v;
end $$;

-- Missing-information report: every open item and what still blocks publishing.
create or replace function public.wh_blockers_report()
returns table (item_id uuid, sku text, title text, status text, created_by uuid, location_code text, blockers text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.wh_require(public.wh_is_staff(), 'Warehouse staff only.');
  return query
    select i.id, i.sku, i.title, i.status, i.created_by, i.location_code, public.wh_publish_blockers(i.id)
    from public.wh_items i
    where i.status in ('draft','research_draft','needs_info','fitment_review','listing_review')
    order by i.created_at;
end $$;

-- Import active eBay listings (from a Seller Hub "active listings" report) as drafts.
-- Read-only toward eBay: nothing is sent to eBay. Each listing gets a permanent SIC SKU and
-- keeps its eBay item number, so it can't be imported twice. Parsed hints (part number,
-- engine family) go into ai_suggestion only; they never set fitment.
create or replace function public.wh_import_ebay(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare x jsonb; v_id text; created int := 0; skipped jsonb := '[]'::jsonb; r public.wh_items;
begin
  perform public.wh_require(public.wh_has_role('intake'), 'Only intake staff can import.');
  perform public.wh_require(jsonb_typeof(p_rows) = 'array' and jsonb_array_length(p_rows) <= 500, 'Import at most 500 rows at a time.');
  for x in select * from jsonb_array_elements(p_rows) loop
    v_id := nullif(regexp_replace(coalesce(x->>'ebay_item_id', ''), '[^0-9]', '', 'g'), '');
    if v_id is null or coalesce(trim(x->>'title'), '') = '' then
      skipped := skipped || jsonb_build_object('ebay_item_id', x->>'ebay_item_id', 'reason', 'missing item number or title');
      continue;
    end if;
    if exists (select 1 from public.wh_items where ebay_item_id = v_id) then
      skipped := skipped || jsonb_build_object('ebay_item_id', v_id, 'reason', 'already imported');
      continue;
    end if;
    insert into public.wh_items (sku, created_by, updated_by, source, ebay_item_id, ebay_import, title, asking_price,
      quantity, oem_part_number, system_code, condition_notes, ai_suggestion)
    values ('SIC-' || lpad(nextval('public.wh_sku_seq')::text, 6, '0'), auth.uid(), auth.uid(), 'ebay_import', v_id, x,
      left(trim(x->>'title'), 255),
      case when coalesce(x->>'price', '') ~ '^[0-9]+(\.[0-9]{1,2})?$' then (x->>'price')::numeric end,
      greatest(1, coalesce(case when coalesce(x->>'quantity', '') ~ '^[0-9]+$' then (x->>'quantity')::int end, 1)),
      nullif(trim(x->>'part_number'), ''),
      case when (x->>'system_code') in (select code from public.wh_systems) then x->>'system_code' end,
      nullif(trim('eBay condition: ' || coalesce(x->>'condition', '')), 'eBay condition:'),
      x->'hints')
    returning * into r;
    if jsonb_typeof(x->'image_urls') = 'array' then
      insert into public.wh_media (id, item_id, slot, kind, bucket, path, position, uploaded_by)
      select gen_random_uuid(), r.id, case when u.n = 1 then 'overall_front' else 'other' end, 'photo', 'external', u.url, u.n::int, auth.uid()
      from jsonb_array_elements_text(x->'image_urls') with ordinality u(url, n)
      where u.url ~ '^https://i\.ebayimg\.com/[A-Za-z0-9/_.~%-]+$' and u.n <= 24
      on conflict do nothing;
    end if;
    created := created + 1;
  end loop;
  return jsonb_build_object('ok', true, 'created', created, 'skipped', skipped);
end $$;

-- ---------------------------------------------------------------- staff admin
create or replace function public.wh_set_staff(p_email text, p_display_name text, p_roles text[], p_active boolean default true)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid;
begin
  perform public.wh_require(public.wh_has_role('owner'), 'Only an owner can change staff.');
  select id into u from auth.users where lower(email) = lower(trim(p_email));
  perform public.wh_require(u is not null, 'No Ride account uses that email. Have them sign up first.');
  perform public.wh_require(u <> auth.uid() or 'owner' = any(p_roles), 'You cannot remove your own owner role.');
  insert into public.wh_staff (user_id, display_name, active) values (u, trim(p_display_name), p_active)
  on conflict (user_id) do update set display_name = excluded.display_name, active = excluded.active;
  delete from public.wh_staff_roles where user_id = u and role <> all(p_roles);
  insert into public.wh_staff_roles (user_id, role, granted_by)
  select u, x, auth.uid() from unnest(p_roles) x on conflict do nothing;
  return jsonb_build_object('ok', true, 'user_id', u);
end $$;

-- Run ONCE from the database console (not callable from the app) to create the first owner.
create or replace function public.wh_bootstrap_owner(p_email text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid;
begin
  if exists (select 1 from public.wh_staff_roles where role = 'owner') then
    raise exception 'An owner already exists; use wh_set_staff from the app.';
  end if;
  select id into u from auth.users where lower(email) = lower(trim(p_email));
  if u is null then raise exception 'No account with email %', p_email; end if;
  insert into public.wh_staff (user_id, display_name) values (u, p_display_name)
  on conflict (user_id) do update set active = true;
  insert into public.wh_staff_roles (user_id, role) values (u, 'owner') on conflict do nothing;
  return u;
end $$;

-- ---------------------------------------------------------------- row level security
do $$
declare t text;
begin
  foreach t in array array['wh_staff','wh_staff_roles','wh_systems','wh_engine_families','wh_category_measurements',
    'wh_locations','wh_items','wh_item_financials','wh_fitments','wh_measurements','wh_media','wh_reviews',
    'wh_moves','wh_exports','wh_audit_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
      execute format('grant select on public.%I to authenticated', t);
    end if;
    execute format('drop policy if exists wh_staff_read on public.%I', t);
    if t = 'wh_item_financials' then
      execute format('create policy wh_staff_read on public.%I for select using (public.wh_has_role(''listing_approver''))', t);
    elsif t = 'wh_audit_log' then
      -- history of private pricing is only visible to those who can see the pricing itself
      execute format('create policy wh_staff_read on public.%I for select using (public.wh_is_staff() and (table_name <> ''wh_item_financials'' or public.wh_has_role(''listing_approver'')))', t);
    else
      execute format('create policy wh_staff_read on public.%I for select using (public.wh_is_staff())', t);
    end if;
  end loop;
end $$;

revoke all on sequence public.wh_sku_seq from public;

-- Functions: nothing is callable by anonymous visitors; staff checks happen inside.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'wh\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') and f.proname not in ('wh_bootstrap_owner','wh_audit','wh_items_touch') then
      execute format('grant execute on function %s to authenticated', f.sig);
    elsif exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', f.sig);
    end if;
  end loop;
end $$;

create table if not exists public.wh_schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
alter table public.wh_schema_migrations enable row level security;
revoke all on public.wh_schema_migrations from public;
insert into public.wh_schema_migrations (name) values ('2026-09-29-wh-001-core') on conflict do nothing;

commit;
