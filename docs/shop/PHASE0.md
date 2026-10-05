# Shop module — Phase 0

Replaces the manual "SICSYSTEMS" Google Sheet workflow (Jobs_Log, Customers,
Order tabs, per-job invoice tabs) with real database tables inside the-ride,
for Tyler, Garrett, and Fang to use as the staff backend for invoices,
estimates, customer records, bike records (VIN + photos), and parts orders.

## Scope decisions (from Tyler, this phase)

- One staff app, three sections: Consignment, Warehouse (existing,
  unmerged `warehouse-phase1` branch), Shop (this branch).
- **Flat permissions**: Tyler, Garrett, Fang are all full admins across all
  three sections. No role tiers (unlike Warehouse's
  owner/intake/fitment_reviewer/listing_approver/fulfillment split) — Tyler
  explicitly asked to not overthink this.
- **Single entry point**: filling out an estimate must create/update the
  linked Customer and Bike records automatically. Staff never re-enter the
  same customer or bike info on a separate page. Implemented as one database
  function, `shop_submit_estimate`, called by the estimate form with
  customer + bike + job fields together.
- Data lives in real tables ("saved into files"), not spreadsheets.

## Schema (sql/shop/2026-10-04-shop-001-core.sql, -002-writes.sql)

- `shop_staff` — flat allowlist (user_id, display_name, active). Managed by
  Tyler directly; no self-service signup path.
- `shop_customers` — name, phone, email, address, last_visit, invoice_count,
  lifetime_spend (last three are rollups, maintained by
  `shop_submit_estimate`, not client-writable).
- `shop_bikes` — vin, make, model, year, mileage, photo_urls (jsonb array),
  linked to a customer. New capability vs. the sheet (no VIN/photo tracking
  existed before).
- `shop_jobs` — one row per estimate/invoice. status
  (estimate/in_progress/complete), payment_status, parts/labor/tax/total
  amounts, parts_cost, and generated part_profit/total_profit columns so
  profit can never drift from the input amounts. Matches the real Jobs_Log
  columns verified from the SICSYSTEMS sheet.
- `shop_job_line_items` — part/labor breakdown within a job.
- `shop_part_orders` — mirrors the SICSYSTEMS "Order" tab (parts-purchasing
  log, separate from Jobs_Log): supplier, cost/tax/charged, received flag,
  generated profit column.
- `shop_audit_log` — every write recorded, no API role can edit it.

Safety pattern follows the Warehouse module precedent: RLS read policies
only, all writes through SECURITY DEFINER functions that check
`shop_has_staff_access()`, attribution columns set server-side from
`auth.uid()`, additive-only, no rider table touched.

## Status

SQL drafted, NOT applied to the live database. Branch `shop-phase1`, not
merged. App code written (`shop/index.html`, `sh-app.js`, `sh-api.js`,
`sh.css`) - jobs list + single-entry-point estimate form. Not tested against
a live DB yet; no tests written yet.
