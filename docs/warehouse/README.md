# Fangs Warehouse (Parts Warehouse) — Phase 1

Staff-only inventory for used and take-off motorcycle parts, inside the Ride app at
`ride.siccycles.com/warehouse/`. The database is the master record (the "Bible");
spreadsheets and the Shopify CSV are exports. Phase 0 architecture: [PHASE0.md](PHASE0.md).

## What is in this branch

| Path | What it is |
|---|---|
| `sql/warehouse/2026-09-29-wh-001-core.sql` | Tables, staff roles, security rules, audit log, locked write functions, publish gate, eBay import |
| `sql/warehouse/2026-09-29-wh-002-storage.sql` | Photo buckets `wh-originals` (private) and `wh-marketplace` (public listing copies) |
| `sql/warehouse/2026-09-29-wh-001-rollback.sql` | Undo both, **only before real inventory exists** |
| `warehouse/` | The staff page (no build step, no libraries, same look as Ride) |
| `tests/warehouse-*.test.cjs` | 29 tests: permissions, conflicts, publish gate, audit, eBay import, exports, barcodes |
| `scripts/warehouse-dev-server.mjs` | Local copy of the backend in memory, for trying the page without touching the live server |

No existing Ride file is changed. Nothing is linked from the rider app.

## What staff can do

- **Intake (phone):** new part gets a permanent SKU (`SIC-000123`), guided photo checklist (SKU card first),
  fields save automatically, fitment lines (family, platform, years, conditions, exclusions),
  hand measurements, scan a bin label to shelve.
- **Import from eBay:** upload the Seller Hub "All active listings" CSV from SW ODDS and ENDS AZ. Each listing
  becomes a draft with its own SIC SKU and keeps its eBay item number (never imported twice). eBay photos are
  reused. Part numbers / engine family / category read from titles are *hints* only. Car parts and antiques start
  unselected. Nothing is sent to eBay.
- **Review:** fitment reviewer approves fitment and condition; listing approver approves the listing.
  The database refuses "Ready to publish" until fitment status + real evidence (never AI or title guesses),
  reviewer approval, required hand measurements, photos, price, weight, dimensions, shipping class and location
  are all present.
- **Exports:** master workbook (sheets for all, drafts, each queue, published, sold, discrepancies and each worker),
  worker workbook, missing-info / fitment / location reports, and the **Shopify CSV (always Draft,
  handle = SKU, never oversold)**. Every export is logged with who, when, rows and a hash.
- **Labels:** printable SKU cards and bin labels with Code 128 barcodes (any USB/Bluetooth scanner reads them).
- **Staff (owner):** add people by their Ride account email and give roles: Owner, Intake, Fitment reviewer,
  Listing approver, Fulfillment.
- Two people editing the same part: the second save is refused, untouched fields merge, clashing fields show
  both values to choose from. Every change is in the history. Idle sign-out after 30 minutes.

## Going live (needs Tyler's approval; nothing below has been run)

1. **Back up first.** `pg_dump` the live database to somewhere off the VPS (Hostinger weekly backups exist,
   but they are whole-server and a week old at worst). Also take a Hostinger snapshot.
2. **Apply the SQL** in Supabase Studio → SQL editor (or `psql` on the VPS), in order: `wh-001-core.sql`, then
   `wh-002-storage.sql`. Both are safe to re-run.
3. **Create the first owner** (once, in the SQL editor — the app cannot call this):
   `select public.wh_bootstrap_owner('your-ride-login@email', 'Tyler');`
   Then in the warehouse page → Staff, add Fang and the workers (they sign up at ride.siccycles.com first).
4. **Deploy the page:** merge this branch to `main`; GitHub Pages publishes `/warehouse/`.
5. **Pilot:** import Fang's active listings, shelve and card-photo 25 parts, review, export the Shopify CSV,
   import it in Shopify admin (Products → Import), check the drafts, set them Active.

## Known limits (Phase 2)

- **Double-selling risk (accepted by Tyler 2026-09-29):** parts stay listed on eBay and on siccycles.com. Until
  automatic sync is built, when a part sells in one place, end or zero it in the other right away.
- eBay photo links come from the report's picture column when present; otherwise paste them per part
  ("Add photos from the eBay listing"). Pulling them automatically needs an eBay developer key.
- Offline: edits need a connection; photo uploads retry on tap. A durable offline queue is Phase 2.
- Orders board, reservations, Shopify/eBay sync, install work orders and AI suggestions are Phase 2.

## Testing locally

```
npm i --no-save @electric-sql/pglite
npm test                                   # all Ride tests + warehouse tests
node scripts/warehouse-dev-server.mjs      # then open http://localhost:8787/warehouse/
```
Dev accounts (password `warehouse-test-1`): tyler@test.local (owner), jake@test.local (intake), rev@test.local (reviewer).
