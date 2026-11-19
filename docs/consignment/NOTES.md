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

## Fees and rules (Tyler, 2026-11-19)
- Customer form lives on ride.siccycles.com.
- No inspection fee.
- Consignment fee is a percentage taken from the sale: bikes 15%, parts 25%. Store as settings (not hard-coded) so Tyler/Garrett can change them.
- Suggested sale price: staff-reviewed estimate from make/model/year plus similar vehicles in the area. A suggestion only, never auto-priced. Live local comps may need a paid data source (listing sites forbid scraping), still to decide.
- Nothing is posted to the site until staff approve it (status must be Approved). Applies to bikes and parts.
- Consignment parts also show up in the Warehouse parts list, together with the shop's own warehouse parts.

## Still assumed
- Staff get an email on each new request; Google Calendar sync can follow.
- Parts bulk upload reuses the existing Warehouse CSV import and quick-add.
- Days open: every day.

## Pieces (one small PR each)
1. SQL (NEW numbered file, Tyler must run it): `consignment_requests` (customer contact, item type bike/part, description, preferred time, status Requested/Scheduled/Inspected/Accepted/Declined/Sold, optional bike year/make/model/VIN, optional wh_item_id, photos) with RLS: staff read/write, public insert only through one rate-limited function.
2. Staff screen in /shop/: Consignment list, status changes, "Add several" rows (name, phone, email, address copied down from the previous row), and a shop-owned-bike toggle that fills the owner as SIC Cycles.
3. Public inspection request form (fields above, AI part check, then calendar slot picker) on the store (siccycles.com) that posts to the function above, with a thank-you message and no account needed.
4. Email/calendar notify to staff when a request arrives.
5. Link accepted parts into the Warehouse and bulk-import photos.

## Not decided
- Source of local price comparisons (paid data vs. staff entering comps by hand).
- Consignor payout timing (when the owner gets paid after a sale).
