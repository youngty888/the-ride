# Consignment + Parts intake: plan (agreed direction, not built yet)

Updated 2026-11-19 from Tyler's request. No code or SQL yet. This is the plan to approve.

## What Tyler wants
- Back end (staff only, inside the RIDE /shop/ module): add consignment items and parts fast, several at a time.
- Shop-owned bikes can be sold through the same screen. Basic form info auto-fills: name, address, phone, email. We will NOT know bike year/make/model up front, so those fields are optional and filled in at inspection.
- Customers (non-admin) never list directly. They use the website form, which books an appointment for the part or bike to be inspected.

## Assumptions (Tyler did not answer these, change if wrong)
1. Inspection request = a booking form (item, preferred day/time, contact info). It creates a "Requested" record that staff see in the Consignment list and get an email about. Calendar sync is a later step.
2. Admin = same flat staff access already used by Shop and Warehouse (Tyler, Garrett, Fang). No separate owner-only tier yet.
3. Parts bulk upload reuses the existing Warehouse CSV import and quick-add instead of a second parts system. Consignment parts link to a Warehouse item once inspected.

## Pieces (one small PR each)
1. SQL (NEW numbered file, Tyler must run it): `consignment_requests` (customer contact, item type bike/part, description, preferred time, status Requested/Scheduled/Inspected/Accepted/Declined/Sold, optional bike year/make/model/VIN, optional wh_item_id, photos) with RLS: staff read/write, public insert only through one rate-limited function.
2. Staff screen in /shop/: Consignment list, status changes, "Add several" rows (name, phone, email, address copied down from the previous row), and a shop-owned-bike toggle that fills the owner as SIC Cycles.
3. Public inspection request form on the store (siccycles.com) that posts to the function above, with a thank-you message and no account needed.
4. Email/calendar notify to staff when a request arrives.
5. Link accepted parts into the Warehouse and bulk-import photos.

## Not decided
- Consignor payout split and who sets price (needs Tyler).
- Whether the public form lives on Shopify (page + theme section) or on ride.siccycles.com.
