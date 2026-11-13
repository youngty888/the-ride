Parts Warehouse — Phase 0 Architecture Report
Sep 22, 2026 · @Tyler Young
Recommendation: build the Warehouse as a staff-only page in the existing Ride repo, on the existing Supabase database in its own warehouse schema. Inspected youngty888/the-ride @ main 115c36e (2026-09-21), 136/136 tests passing, plus read-only checks of the Shopify store and Supabase account. Nothing was changed anywhere.
Headline findings
1. There is no service side in Ride yet. Ride is rider-facing only. It has no staff area, customer table, work orders, parts catalog or inventory. The only service pieces are rider-entered service notes on Garage bikes and a Shop screen with two hard-coded products that opens a mailto: quote email. The Warehouse becomes the first staff module and lays the service-side foundation.
2. The current role flag can't be trusted. Signup writes role: 'rider' into Supabase user_metadata, which any user can edit about themselves. Warehouse permissions need a staff-role table that only the Owner can change.
3. The live schema is only partly in the repo. rider_app_state and its save_rider_app_state RPC are live but not committed. Release notes mention "existing normalized rider tables" that also aren't committed. rider_routes and rider_prefs are marked "NOT YET APPLIED". The live schema must be dumped before any warehouse migration.
4. The Shopify catalog is dropship-style, not used parts. Store "SicCycles" (www.siccycles.com, Basic plan). The newest 50 products (there are more) look imported: supplier-style SKUs, the same SKU on several products (e.g. 14193), and stock counts like 9,999 and 86,643. Warehouse parts need their own SKU namespace and must stay clear of whatever app syncs those counts.
5. Ride has no Shopify or eBay code. Nobody has identified yet how eBay listings are made today. That must be answered before any eBay work.
1. Current technology stack
Ride is a no-build vanilla JS static site on a self-hosted Supabase backend.
Layer
What it is
Frontend
Vanilla HTML/CSS/JS, no framework, no build step; global modules loaded by <script> tags with ?v= cache-busting
Maps and data
Leaflet + OSM tiles, OSRM routing, Nominatim geocoding, Overpass places, NWS weather, bundled NHTSA FARS JSON
Backend
Supabase (GoTrue auth, PostgREST, Postgres), self-hosted on a VPS at api.ride.siccycles.com
Tooling
Node 18+ helpers only: npm test (16 test files, node:test) and npm run bump (cache-bust stamps)
Client storage
localStorage keys rideflow_*; sign-in session in localStorage
2. Current database and storage location
There is one Postgres database, behind Supabase on the VPS, with owner-only RLS on every rider table. No object storage is in use.
• rider_app_state stores one JSON snapshot per rider: Profile plus all Garage bikes, with photos embedded as data URLs (8 MiB cap). Writes are revision-checked through rpc/save_rider_app_state. Its DDL is not in the repo.
• rider_rides was applied 2026-09-19/20.
• rider_routes and rider_prefs are committed but marked not yet applied. Their live status needs checking.
• The "existing normalized rider tables" are referenced in the release notes but not in the repo.
• Files: images are base64 inside JSON or browser storage. It's unknown whether Supabase Storage is enabled on the VPS.
• The Supabase cloud account has one project, "2TS" (us-east-2, paused). It is not Ride's backend and shouldn't be used for this.
3. Authentication and user-role design
Auth is solid for riders, but there is no real role system.
• Supabase email/password: 12-character minimum, public rider signup, password recovery, and a "private admin invite" set-password screen.
• auth-guard.js refreshes the session and verifies the token against /auth/v1/user on every page load.
• Roles: the only one is user_metadata.role = 'rider', set at signup. There is no admin UI, no role table and no server-side role check. The invite page says admin access is assigned separately, but no code reads or enforces it.
• The Warehouse needs a real role model (Section 8), enforced in Postgres RLS and database functions, never only in the browser.
4. Current hosting and deployment
Deploys are manual and happen in two separate places.
• Frontend: GitHub Pages from main, with CNAME pointing to ride.siccycles.com. Merging to main deploys. There is no CI; tests run by hand, and npm run bump must run before pushing script or CSS changes.
• Backend: SQL files are applied by hand on the VPS. There is no migration runner or applied-migrations table.
• Hostinger: its role is unknown, possibly domain/DNS or the siccycles.com site.
• Repo is public: it cloned without credentials. That's fine as long as no secret is ever committed (the anon key in it is public by design), but warehouse code and schema will be public too.
5. Existing customer, motorcycle, service and work-order models
Only rider-owned data exists. Staff can't see any of it, and there is no work order.
Concept
Exists?
Where and shape
Customer
Only as a rider account
auth.users + profile JSON inside rider_app_state
Motorcycle
Yes, rider-owned
JSON in the snapshot: client-generated id (not globally unique), make, model, year, engineSize, mileage, mods, serviceRecords[]
Service history
Rider self-logged
serviceRecords[] {type, date, miles, cost}; drives oil/tire/brake reminders
Install or quote request
Email only
Shop cart → mailto:info@siccycles.com; a copy stays only in that browser
Work order
No
—
Staff-visible data
No
RLS is owner-only
6. Existing Shopify or eBay integrations
Ride's code has no integrations. Shopify exists as a separate store; eBay is unknown.
• In code: none. The Shop screen is hard-coded (ThunderMax ECM kit and a service request).
• Shopify (read-only check):
    ◦ Store "SicCycles", Basic plan, USD.
    ◦ Store timezone is EDT even though the shop is in Arizona. The warehouse should keep all timestamps in UTC, and the store setting should be confirmed.
    ◦ Every product has vendor "SicCycles". SKUs aren't unique, many product types are blank, and there's a mix of Active, Draft and Archived.
• eBay: no code and no connector. We need to learn how listings are made today: by hand in Seller Hub, through a multichannel tool, or through a Shopify eBay app.
7. Recommended attachment point
Use the same repo, domain and Supabase backend, with a separate staff page rather than a separate app.
• New page: warehouse.html plus warehouse/*.js at ride.siccycles.com/warehouse.html. It reuses supabase-config.js, session-store.js, auth-guard.js and the CloudRest pattern. Staff sign in with their normal Ride account.
• Access: the page isn't linked from rider navigation and checks staff role on load, but security is enforced in RLS.
• Data: all warehouse tables go in a new Postgres schema warehouse in the existing database. That's no second database, and a clean boundary from rider tables.
• Server-side layer: needed for secrets, webhooks and exports. Use Supabase Edge Functions if the VPS stack has them, otherwise a small Node service on the same VPS. The service-role key and Shopify/eBay tokens live only there.
• Code style: stay no-build and vanilla. Any library (spreadsheet grid, QR reader) is vendored into the repo, not loaded from a CDN.
Why not a separate app: accounts, auth, bikes and the domain already live here. A separate app would duplicate auth and split the customer and bike data that install-at-SIC needs.
8. Proposed database tables and relationships
All tables live in schema warehouse. items is the Bible: one row per permanent SKU, and every other table hangs off it.
Group
Table
Key fields and relationships
Access
staff_members
user_id PK → auth.users, display_name, active
Access
staff_roles
user_id, role: owner_admin / intake / fitment_reviewer / listing_approver / fulfillment; a person can hold several; Owner-only writes
Places
warehouses
code WH1, name, address
Places
locations
warehouse_id, row, shelf, bin, generated unique code like WH1-R03-S02-B07
Places
inventory_moves
item_id, from/to location, qty, moved_by, moved_at, reason; append-only
Items
items
sku (SIC-000123 from a sequence, never reused), title, description, brand, OEM/aftermarket, OEM part number, casting_numbers[], system_category (16-value enum), condition grade and notes, tested status, color, material, quantity ≥ 0, bare and packed dimensions, weight + weight_source, shipping class, oversize/hazmat/pickup flags, location_id, asking_price, status, version, and all attribution columns
Items
item_financials
item_id PK, cost, consignor_id, min_approved_price; split out so intake can't see them
Items
consignors
name, contact, terms
Fitment
fitment_applications
item_id, make, engine_family (Knuckle, Pan, Shovel, Evo, Evo Sportster, Twin Cam 88/96/103/110, M8 107/114/117/121, Revolution, Japanese/other), platform, model codes, start/end year, conditions, exclusions; many per item
Fitment
fitment_assessments
item_id, status (the 5), evidence_level, evidence_source, evidence media, disposition, reviewed_by/at; history kept
Fitment
ai_suggestions
item_id, kind, payload, model; reference only, cannot set fitment status
Fitment
category_measurements, item_measurements
required measurements per category; value, unit, method (caliper/tape/scale/photo-estimate), measured_by
Media
media
item_id, photo/video, slot (sku_card, front, back, part_number, casting, mounting, connector, defect, measurement, scale), bucket, path, sha256, captured_by/at, is_marketplace, position
Channels
channel_listings
item_id, shopify/ebay, external product/variant/inventory-item/listing ids, state, last_synced
Orders
orders, order_lines
channel + external_order_id (unique), fulfillment_path ship/install, customer ref or snapshot
Orders
reservations
item_id, qty, reason order/install/hold, order_line_id or work_order_id, status active/released/consumed
Orders
fulfillment_events
order_id, step picked/packed/shipped/installed, by, at, tracking
Service
work_orders
minimal and new: customer (rider id or walk-in details), bike snapshot, status, notes
Sync
webhook_events
source + external_event_id unique (dedupe), payload, processed status
Sync
sync_exceptions
kind, item, channel, detail, resolution
Reports
export_batches
kind, filters, row_count, file path, sha256, created_by/at
Audit
audit_log
see Section 11
The channel, order, reservation and work-order tables are created in Phase 1 but used in Phase 2. The bike is copied as a snapshot into orders and work orders because Garage bike ids are client-side and not unique.
Item lifecycle. A database function enforces every transition, not the UI.
stateDiagram-v2
    [*] --> Draft
    Draft --> ResearchDraft: fitment unknown
    ResearchDraft --> Draft
    Draft --> IntakeComplete
    IntakeComplete --> FitmentReview
    FitmentReview --> ListingReview: reviewer disposition
    ListingReview --> ReadyToPublish: approver sign-off
    ReadyToPublish --> Published
    Published --> Reserved: paid order or install
    Reserved --> Published: released
    Reserved --> Sold
    Sold --> Shipped
    Sold --> Installed
The gate into Ready to Publish refuses unless the item has: a fitment status, an evidence level, every required category measurement taken by a non-photo method, a Fitment Reviewer disposition, and Listing Approver sign-off. On Hold and Archived are reachable from any state; items are never hard-deleted.
9. Proposed media-storage structure
Use Supabase Storage on the VPS, ideally backed by S3-compatible storage (Backblaze B2 or Cloudflare R2) so photos don't live only on the VPS disk.
Bucket
Access
Path pattern
Holds
wh-originals
Private, signed URLs
items/{sku}/{slot}/{media_id}.{ext}
Untouched originals and video
wh-marketplace
Public read
items/{sku}/{position}-{media_id}.jpg
Edited, resized, EXIF-stripped listing images; these are the stable URLs in exports and Shopify CSV
wh-exports
Private
exports/{yyyy}/{mm}/{batch_id}-{kind}.xlsx
Every generated export
wh-labels
Private
labels/{batch_id}.pdf
SKU card and bin label sheets
• Phones upload straight to storage with a signed upload URL, then register the file in media.
• Paths never change. Replacing an image writes a new file, so old export links keep working.
• GPS EXIF is stripped from marketplace copies. Video is capped (e.g. 200 MB / 60 s) and kept in originals only.
10. Multi-user concurrency approach
Five users is a light load. The risk is silent overwrites, and these rules prevent them.
• Optimistic locking. Every editable row has a version. Saves go through warehouse.update_item(id, expected_version, changes), which rejects a stale version and returns the current row. The UI then shows who changed which field so the worker can keep theirs or keep the other. Ride already uses this pattern in save_rider_app_state.
• SKUs from a database sequence, so two workers can never get the same one. Pre-printed SKU card batches reserve ranges.
• Locked database functions handle quantity, reservations, moves and status changes (SELECT … FOR UPDATE), so two simultaneous sales or moves can't both succeed.
• Attribution set by triggers from auth.uid(). The client has no write grant on those columns.
• Queues refresh on focus and every 30–60 s, or live via Supabase Realtime if the VPS runs it.
• Personal views are filtered queries on the one items table (created_by = me), never separate copies.
11. Audit-history approach
One generic trigger records every change to every warehouse table, and nobody can alter the log.
• warehouse.audit_log stores: table, row id, insert/update/delete, actor (auth.uid() or the integration's service identity), timestamp, old row, new row, and changed columns.
• It is append-only. Only the trigger can insert, and no one can update or delete, including the Owner.
• Items are archived, never hard-deleted, so their history stays attached.
• The item screen shows a readable timeline ("Weight 3.2 lb → 3.4 lb by Jake, 9:14 AM") built from audit_log, inventory_moves and fitment_assessments.
• The named "by" fields from the brief (created, edited, fitment verified, condition graded, listing approved, published, picked, packed) are also stored as columns for fast views.
12. Shopify CSV and export strategy
Exports are generated server-side, saved, and logged, so every file traces to who ran it, when, and with what filters.
• Formats:
    ◦ Master XLSX, with one sheet per view: all, drafts, fitment queue, listing queue, published, sold, discrepancies
    ◦ Worker XLSX
    ◦ Missing-info, fitment-review and location/bin reports
    ◦ Shopify CSV now; eBay CSV later
• Images are wh-marketplace URLs, never embedded files.
• Formula-injection escaping: text cells starting with =, +, - or @ are neutralized.
• Shopify CSV rules:
    ◦ Only Ready to Publish items. One product per SKU.
    ◦ Handle = sic-000123-<slug>. Shopify import overwrites any product whose Handle matches, so this prefix protects the existing catalog.
    ◦ Variant SKU = SIC SKU, inventory tracked, qty 1 at a dedicated warehouse location.
    ◦ Status = draft by default, so a person flips it live.
    ◦ Vendor = part brand. Type = motorcycle system. Tags = engine family, years, platform, condition, sic-warehouse.
    ◦ Fitment goes in the description now, metafields later.
    ◦ The column template is checked against Shopify's current product CSV spec at build time.
• Dropship-app guard: warehouse products must be excluded from whatever app manages the dropship inventory, or it may overwrite quantities.
• Future direct sync: Shopify Admin GraphQL for product and inventory writes, plus orders/paid webhooks. channel_listings already stores the IDs this needs. Matching uses Shopify IDs, never SKU, because existing Shopify SKUs aren't unique.
13. eBay integration strategy
Nothing touches the live eBay store until it has been mapped read-only and you approve each step.
Stage
Phase
What happens
Writes to eBay?
E0 Discover
1
Identify the current listing method. Load a Seller Hub active-listings download (or read-only API pull) into staging. Match to SIC SKUs by Custom Label, then part number/title with human confirmation. Output: a mapping report
No
E1 Orders in
2
Pull paid eBay orders into orders; reserve the part and close the Shopify side
No
E2 Qty-to-zero on sale
2
For mapped existing listings, only a quantity/end update. No bulk migration or rewrite. One-listing test first. Behind an Owner switch
Minimal
E3 New listings
3
Create listings only for new SIC SKUs, from approved data
Yes, new only
• If a multichannel tool or Shopify eBay app already posts to eBay, integrate through that one writer instead of adding a second.
• Oversell safety:
    ◦ Webhooks are deduplicated by event id (unique key in webhook_events) and processed idempotently.
    ◦ A second order for a one-off part lands in sync_exceptions for a person to cancel or refund.
    ◦ A nightly reconciliation compares warehouse vs Shopify vs eBay quantities and queues any mismatch.
14. Backup and rollback plan
No migration runs until a backup has been restored successfully somewhere else.
1. Before any change: check whether VPS backups exist today (unknown). Take a full pg_dump plus a copy of any storage volume, stored off the VPS. Test-restore it into a scratch database.
2. Staging: a separate Supabase stack (Docker on the VPS or a local machine) for all migration testing. Never test on production.
3. Ongoing:
    ◦ Nightly automated pg_dump to off-site storage, kept 30 days
    ◦ Versioning on the media buckets
    ◦ A nightly Master XLSX as a human-readable copy
4. Migrations: numbered files in sql/warehouse/, each with a written rollback. All changes are additive: a new schema only, with no change to rider tables.
    ◦ Before real inventory exists, rollback = drop the warehouse schema.
    ◦ After the pilot starts, fix forward only and never drop data.
5. Frontend: git revert on main, and GitHub Pages redeploys. The warehouse page is separate from index.html, so a warehouse bug can't break the rider app.
6. Integrations: every outbound channel write has an Owner kill switch, off by default.
15. Security concerns
Concern
Mitigation
user_metadata role is self-editable
Authorize only from staff_roles, writable by owner_admin; later consider app_metadata or JWT claims
Open public signup
Every warehouse table denies by default and grants only via has_role(); revoke anon table grants
Cost, consignor and minimum price exposure
Keep them in item_financials with owner/approver-only policies
Secrets
Service-role key and Shopify/eBay tokens live only in the server-side layer, never in the public repo or the browser
Tokens in localStorage (XSS exposure)
Warehouse UI builds DOM with textContent, not innerHTML; add a Content-Security-Policy
Staff account takeover
Enable TOTP MFA for staff if the self-hosted GoTrue version supports it
Uploads
Type and size limits, staff-scoped storage policies, EXIF GPS stripped from public images
Exports
Formula-injection escaping; private files with signed download links
Webhooks
Verify Shopify HMAC and eBay notification signatures; reject replays
Public repo
Confirm this is intended (GitHub Pages from a private repo needs a paid plan)
Separately from the warehouse: the rider_routes and rider_prefs sync code is on main while its migrations are marked unapplied, so those features may be returning 404s live.
16. Missing access or files
The first three items block Phase 1. The rest can arrive during it.
[ ] Live database: a schema-only dump of production (pg_dump --schema-only), including rider_app_state, save_rider_app_state, the normalized rider tables, and which migrations are applied
[ ] VPS: Supabase stack version and docker-compose config; whether Storage, Edge Functions and Realtime are enabled; disk space; existing backups
[ ] Hostinger: what it hosts (DNS, main site, email?)
[ ] Shopify:
    ◦ Installed apps, especially dropship/inventory sync and any eBay app
    ◦ Locations, and whether a warehouse location can be added on Basic
    ◦ A custom-app token later; not needed for Phase 1 CSV
[ ] eBay: the current listing method or tool, a sample active-listings export, and whether Custom Label is used
[ ] Shop operations: how service jobs are tracked today (paper or software). This decides whether work_orders is new or a connector
[ ] Hardware:
    ◦ Phone models. iPhone vs Android matters because iOS Safari lacks the built-in barcode reader
    ◦ Bluetooth scanners, label printer model, measurement mat, shipping scale
[ ] Business rules: condition-grade scale, required measurements per category, shipping classes, pricing approval, who holds which role
[ ] Local files: your Windows handoff folder and USB backup couldn't be reached (your computer wasn't connected). GitHub main was used as the source of truth
17. Phase 1 implementation issues, in priority order
1. Capture the live schema and VPS config, and commit the missing rider_app_state DDL/RPC to sql/ as documentation.
2. Verify backups with a restore drill, and stand up staging.
3. Add a sql/warehouse/ folder and a migration-tracking convention.
4. Build staff_members, staff_roles, has_role() and deny-by-default RLS, with PGlite tests proving riders see nothing and intake can't see financials.
5. Core schema: warehouses, locations, items, item_financials, fitment tables, measurements, moves, SKU sequence.
6. Audit trigger, attribution triggers, update_item optimistic-lock RPC, status-gate function.
7. Storage buckets and policies, plus the signed-upload flow.
8. warehouse.html shell: staff check, role-aware navigation, phone layout.
9. Intake flow: SKU create or scan → guided photo checklist → fields → required measurements → bin scan → submit.
10. SKU card and bin label PDFs with QR codes.
11. My Items and Master grids: filter, sort, inline edit with conflict handling.
12. Fitment-review and listing-approval queues with the publish gate.
13. Location moves: scan item, scan new bin.
14. Exports: Master and Worker XLSX, missing-info, fitment and location reports, Shopify CSV (Draft), export history.
15. 25-part pilot and fix-up.
Phase 2 and later: Shopify GraphQL sync, order webhooks, reservations and fulfillment board, eBay E1–E3, install-at-SIC work orders linked to rider accounts, AI identification suggestions.
18. Acceptance tests for the 25-part pilot
Pilot mix: about 8 Shovelhead, 6 Evo, 6 Twin Cam, 2 M8 and 3 Japanese parts. Include at least 3 unknown-fitment parts, 2 multi-fitment parts, 1 oversize part, and 1 hardware lot with qty > 1.
#
Test
Pass when
1
Five workers intake at once on their own phones
Every record attributed correctly; none lost or overwritten
2
Two workers edit the same item
Second save refused with a field-level conflict view; nothing silently lost
3
SKU uniqueness
25 unique SKUs, even when created simultaneously
4
Photo checklist
SKU card first, front/back, numbers/castings, mounting/connectors, defects, measurement — or the item is blocked with a missing list
5
Measurements
Required measurements recorded manually; a photo estimate does not pass the gate
6
Location
Every item has a valid WH1-Rxx-Sxx-Bxx from a bin scan; one move logged with from/to/who/when
7
Unknown fitment
Cannot reach Ready to Publish; stays a research draft
8
AI suggestion
Visible but cannot set fitment status or publish
9
Intake role limits
Cannot see cost/consignor/min price, approve fitment, or export financial columns
10
Rider isolation
A plain rider account gets zero rows from every warehouse table, tested directly against the API
11
Audit
Every change shows who and when; audit rows cannot be edited or deleted by anyone
12
XLSX exports
Master and each Worker file open in Excel, match on-screen counts, image URLs work
13
Shopify CSV
Imports into a test store or as Draft only; exactly the approved items with images, qty 1, correct SKU; no existing product touched
14
Reports vs reality
Missing-info, fitment and location reports match a physical spot-check of 10 bins
15
Restore drill
Last night's backup restores to staging with all 25 items, media links and audit history
16
Rider app regression
npm test passes; rider app loads and syncs normally after the warehouse deploy
19. Estimated work in small, reviewable milestones
Phase 1 is about 17–23 focused build days plus a one-week pilot. Each milestone is one PR, or one SQL + test set, that you approve before the next begins. Review time isn't included.
#
Milestone
You review
Est. (build days)
M0
Access and discovery
Live schema dump, VPS capability list, answers to Section 16
0.5–1
M1
Safety net
Verified backup + restore drill, staging stack, migration convention
1
M2
Staff roles and RLS
Role tables, has_role, deny-by-default, isolation tests
1.5–2
M3
Core inventory schema
Items, locations, fitment, measurements, moves, SKU sequence, audit + attribution triggers, lock RPC, gate function, tests
2–3
M4
Media storage
Buckets, policies, signed upload, EXIF handling
1–2
M5
Staff shell + intake
warehouse.html, guided phone intake with photo checklist and bin scan
3–4
M6
Labels
SKU card and bin label sheets with QR
1
M7
Grids
My Items, Master and per-worker views, inline edit, conflict UI
2–3
M8
Review queues
Fitment review, listing approval, publish gate
2
M9
Exports
XLSX set, reports, Shopify CSV (Draft), export history
2–3
M10
Pilot
25 parts, acceptance tests, fix list
~1 week calendar
P2
Channels and fulfillment
Shopify sync, webhooks + dedupe, reservations, fulfillment board, reconciliation, eBay E0–E2, install work orders
Estimate after pilot
Decisions needed before Phase 1
[ ] Approve the attachment point: a staff page in the same repo and Supabase, schema warehouse
[ ] Approve that Phase 1 stops at export (Shopify CSV as Draft), with orders, reservations and eBay writes in Phase 2
[ ] Provide the M0 access items, starting with the live schema dump and whether VPS backups exist
[ ] Confirm the SKU format (SIC-000123) and the condition-grade scale