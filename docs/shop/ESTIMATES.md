# Shop estimates — setup and status

Page: https://ride.siccycles.com/shop/ (GitHub Pages serves `main`).

## What the estimate screen does

- Staff sign in on the shop page itself with their RIDE account. Accounts not
  on `shop_staff` see "No shop access" and get no data.
- One form: customer (pick existing or new), bike (pick existing, new, or none),
  date, work description, itemized parts (qty, price, internal cost) and labor
  (hours, rate), tax, customer notes, internal notes.
- Line totals, subtotals, tax and total update live. On save the database
  recalculates everything from the line items (`shop_save_estimate`), so stored
  totals always match the lines.
- Tax: rate % plus "parts only / parts and labor / no tax". The default comes
  from Settings and starts EMPTY — enter the shop's real rate once. Each saved
  estimate keeps the rate it was saved with.
- Estimate numbers start at 1001 and are assigned by the database.
- Save -> customer copy -> Print / Save PDF. The customer copy never shows our
  cost, profit, internal notes or invoice #.
- Status: Estimate -> Start job -> Mark complete (`shop_set_job_status`; amounts
  untouched).
- Bike photos are private to staff (loaded with the staff sign-in).

## Bugs fixed from the earlier version

- Saving with a blank Year or Mileage failed ("invalid input syntax for type integer").
- "Start job" re-submitted the job with only a status and wiped parts/labor/tax/total
  to $0 and cleared the invoice number.
- Editing a job/picking a bike did not fill the bike fields; photo URLs were not
  loaded, so a save could blank them.
- Totals were typed by hand. Customer text was inserted as HTML. Load/save errors
  were silent, and double-tapping Save could create duplicates.
- Sign-in redirected to `auth.html?next=shop/`, which ignores `next` and lands in
  the rider app.

## Going live (needs owner access to the self-hosted database)

The live database is the self-hosted Supabase behind `api.ride.siccycles.com`.
It could not be reached from the Claude cloud session, so none of this has been
run or checked live yet.

1. Check what is already there (read-only):
   ```sql
   select tablename from pg_tables where schemaname = 'public' and tablename like 'shop\_%';
   select proname from pg_proc where proname like 'shop\_%';
   select id, public from storage.buckets where id = 'shop-bike-photos';
   select count(*) from public.shop_jobs;  -- only if the table exists
   ```
2. Back up first (`pg_dump`), then apply only the files not yet applied, in order:
   `2026-10-04-shop-001-core.sql`, `-002-writes.sql`, `-003-storage.sql`,
   `2026-10-30-shop-004-estimates.sql`. 001 and 003 are not re-runnable (they
   create policies); 004 is re-runnable and additive.
3. Staff: run step 1 of `2026-10-30-shop-005-staff-access.sql`, confirm the exact
   emails for Tyler, Garrett and Fang, then run step 2 with those emails.
4. Merge the PR so GitHub Pages serves the new page. Do this AFTER step 2 —
   the new page calls `shop_save_estimate`, which only exists after 004.
5. Live acceptance check: sign in, Settings -> enter the real tax rate, create
   "TEST ESTIMATE – Do Not Use" with two parts and one labor line, save, reload,
   reopen, edit, print; sign in with a non-staff RIDE account and confirm "No shop
   access". The test job can stay (there is no delete) or be removed by the owner
   in SQL along with its line items.

## Importing the SICSYSTEMS invoices

`scripts/shop-import/` loads the per-invoice tabs of the SICSYSTEMS sheet:

1. Download SICSYSTEMS as .xlsx, then
   `python3 scripts/shop-import/sicsystems_to_json.py SICSYSTEMS.xlsx sicsystems.json`
   (needs `pip install openpyxl`). The JSON holds customer details — keep it
   private; `.gitignore` blocks `*sicsystems*.json`.
2. Dry run (writes nothing; lists every invoice and anything that doesn't match
   the sheet or Jobs_Log): `node scripts/shop-import/import.cjs sicsystems.json`
3. After the SQL is live and staff are added:
   `SHOP_EMAIL=... SHOP_PASSWORD=... node scripts/shop-import/import.cjs sicsystems.json --apply --settings`
   `--settings` also copies the sheet's Settings tab (8.7% tax on parts, phone,
   email) and the service policies into shop Settings.

Imported invoices keep their numbers; new estimates continue after the highest.
Re-running updates the same records (fixed ids), it never duplicates.
Tested locally on the real sheet (Oct 30): 31 invoices loaded, every total, line
count and status matched on read-back, re-import added nothing, and new
estimates continued at #1038.

## Tests

- `tests/shop-calc.test.cjs` — estimate math.
- `tests/shop-sql.test.cjs` — the real SQL in PGlite: save/reopen/edit, double
  save, stale-edit protection, status, validation, permissions, photo privacy,
  applying 004 over existing jobs.
- `tests/shop-import.test.cjs` — the SICSYSTEMS importer, with made-up data.
- `tests/shop-e2e.test.cjs` — the real page in Chromium against a local fake
  server (`tests/support/shop-fake-backend.cjs`) running the same SQL: full
  acceptance flow, PDF, phone layout, unsafe text, failed save, non-staff API.
  Local only; it does not prove the live server.

Run: `npm i --no-save @electric-sql/pglite && npm test` (the browser test also
needs Playwright; it is skipped without it).
