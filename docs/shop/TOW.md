# Moto Tow

Public page: `/tow/` (book, sign the waiver, see the price, pay link).
Crew board: `/shop/tow.html` (its own sign-in; also linked from the shop page).
Math: `shop/tow-calc.js` (the page preview) and the same math in the database,
which is the one that counts.

## Prices (change in `tow-calc.js` and `shop_tow_quote` together)

| Area | Price | Going to SIC Cycles |
|---|---|---|
| Tucson, within 15 mi of the shop | $125, then $3.50 a mile | $100 |
| Sierra Vista | $295 flat | $250 |
| Phoenix metro | $425 flat | $375 |
| Anywhere else | crew sets the price | |

Same price 24/7. Motorcycles, ATVs, golf carts, side-by-sides only.

## Rules the database enforces

- No tow starts until it is paid, the waiver is signed and a driver is on it.
- Once paid, only the admin (the payroll manager) can change the price.
- Crew pay is locked when the tow is marked delivered.
- A paid tow that is cancelled is flagged as a refund due.
- Tow crew see only the tow board, not the rest of the shop.

## Crew pay (Settings tab, admin only)

- One person on the tow: driver gets 30% of the price.
- Two people: 40% of the price, split driver/navigator 50/50 by default.
  Set it to 60/40 or anything else.
- Pay tab totals each person's tows for the check, by Arizona date.

## Setup, in order (on the server)

1. Run `sql/shop/2026-11-21-shop-008-tech-signoff.sql` if it has not run yet.
2. Run `sql/shop/2026-11-25-shop-014-tow.sql`.
   Undo: `sql/shop/2026-11-25-shop-014-tow-rollback.sql`.
3. Make sure Tyler is the payroll manager:
   `update public.shop_staff set payroll_manager = true where user_id = '<tyler id>';`
4. Add each tow person (they need a RIDE login first):
   ```sql
   insert into public.shop_tow_crew (user_id, display_name)
   select id, 'Garrett' from auth.users where email = 'garrett@...';
   ```
   Add Tyler too if he will take tows himself.
5. Payment: send each customer an invoice (PayPal, Square or Shopify) for the
   tow's price, then press Mark paid with the invoice number. Pay links on the
   Settings tab are optional; leave them blank to use invoices.
6. Set up texting: see `supabase/functions/README.md`, tow-alert.
7. When the tow number is bought, put it in `PHONE` at the top of `tow/tow.js`.
8. Have a lawyer read the waiver (version `2026-11-25` in shop-014) before
   real customers sign it. A new version is a new row in `shop_tow_waivers`.
