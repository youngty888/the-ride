# Consignment + Parts intake: plan (agreed direction, not built yet)

Updated 2026-11-19 from Tyler's request. No code or SQL yet. This is the plan to approve.

## What Tyler wants
- Back end (staff only, inside the RIDE /shop/ module): add consignment items and parts fast, several at a time.
- Shop-owned bikes can be sold through the same screen. Basic form info auto-fills: name, address, phone, email. We will NOT know bike year/make/model up front, so those fields are optional and filled in at inspection.
- Customers (non-admin) never list directly. They use the website form, which books an appointment for the part or bike to be inspected.

## Decisions from Tyler (2026-11-19)
1. Inspection request form fields: description, fitment, part number (if known), year, part rank/quality (condition grade), photos. Bikes use the same form.
2. AI check: after submit, an AI step compares the form (and photos) with the part number/fitment to identify the part and flag if it does not match what the customer claims. It only flags and explains for staff, it never auto-rejects. Runs server-side so no API key ever lives in this repo.
3. Then the customer picks an inspection time on a calendar: 30-minute slots from 12:00 noon to 12:00 midnight Tucson time (24 slots a day, last one starts 11:30 pm). Days open not stated, so assumed every day until Tyler says otherwise. Slots already booked or blocked by staff are hidden.
4. Admin = Garrett and Tyler only for now (not Fang). Uses the existing staff table, one row per person.

## Still assumed
- Staff get an email on each new request; Google Calendar sync can follow.
- Parts bulk upload reuses the existing Warehouse CSV import and quick-add.

## Pieces (one small PR each)
1. SQL (NEW numbered file, Tyler must run it): `consignment_requests` (customer contact, item type bike/part, description, preferred time, status Requested/Scheduled/Inspected/Accepted/Declined/Sold, optional bike year/make/model/VIN, optional wh_item_id, photos) with RLS: staff read/write, public insert only through one rate-limited function.
2. Staff screen in /shop/: Consignment list, status changes, "Add several" rows (name, phone, email, address copied down from the previous row), and a shop-owned-bike toggle that fills the owner as SIC Cycles.
3. Public inspection request form (fields above, AI part check, then calendar slot picker) on the store (siccycles.com) that posts to the function above, with a thank-you message and no account needed.
4. Email/calendar notify to staff when a request arrives.
5. Link accepted parts into the Warehouse and bulk-import photos.

## Not decided
- Consignor payout split and who sets price (needs Tyler).
- Whether the public form lives on Shopify (page + theme section) or on ride.siccycles.com.
