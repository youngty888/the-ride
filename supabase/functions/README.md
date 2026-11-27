# Shop server edge functions

These run in the shop server's `supabase-edge-functions` container (self-hosted
Supabase on the VPS). Nothing here holds a secret: every key comes from the
server's own settings. Nothing in this folder is live until it is copied to the
server and the container is restarted.

## shopify-orders-paid

Shopify tells this function when an order is paid. If the order is for the
plan-payment product and carries a plan's loan number (added by the buyer's
pay page), the payment is added to that plan automatically. Anything else is
kept as "held" on the staff Payment plans page to check.

Install (once, after `sql/shop/2026-11-23-shop-013-shopify-payments.sql` has run):

1. Copy the folder `supabase/functions/shopify-orders-paid` to
   `/root/supabase/docker/volumes/functions/shopify-orders-paid` on the server.
2. In Shopify admin, go to Settings > Notifications > Webhooks, create a webhook:
   event "Order payment", format JSON, URL
   `https://api.ride.siccycles.com/functions/v1/shopify-orders-paid`.
   The page shows the secret Shopify signs webhooks with.
3. On the server, add to `/root/supabase/docker/.env`:
   ```
   SHOPIFY_WEBHOOK_SECRET=<the secret from step 2>
   SHOPIFY_PLAN_VARIANT_IDS=<the plan-payment product's variant id>
   ```
   and add these two lines under `functions:` > `environment:` in
   `docker-compose.yml`:
   ```
   SHOPIFY_WEBHOOK_SECRET: ${SHOPIFY_WEBHOOK_SECRET}
   SHOPIFY_PLAN_VARIANT_IDS: ${SHOPIFY_PLAN_VARIANT_IDS}
   ```
4. Restart the functions container: `docker compose up -d functions`.
5. In Shopify, use "Send test notification" on the webhook. Shopify's sample
   order is not a plan payment, so nothing is recorded, but the functions
   container log shows `shopify webhook orders/paid 200`. A 401 there means the
   secret in step 3 does not match.

Undo: delete the webhook in Shopify, remove the folder, restart the container.

### Dads Don't Quit points (same function)

The same webhook can also give RIDE riders Dads Don't Quit points: 1 point per
$1 given through the "Dollars for Dads Donation" product on siccycles.com, and
1 point per $1 spent on ManUp merch sold there. It stays off until you turn it on.

1. Run `sql/shop/2026-11-27-shop-016-dads-points.sql` in the server's SQL editor.
2. Add to `/root/supabase/docker/.env`:
   ```
   DADS_POINTS=on
   ```
   and under `functions:` > `environment:` in `docker-compose.yml`:
   ```
   DADS_POINTS: ${DADS_POINTS}
   ```
   Optional, same way: `D4D_VARIANT_IDS` (defaults to today's $1, $5, $10, $20,
   $25, $50 and $100 donation variants), `MANUP_VENDORS` (default `manup`: any product
   whose vendor contains "ManUp" counts as merch), `MANUP_PRODUCT_IDS`.
3. Restart the functions container: `docker compose up -d functions`.

An order is matched to a rider by the RIDE member id the app adds to the cart,
or else by the order email (a confirmed RIDE login). Orders that match nobody
are kept in `ride_dads_orders_held` for staff. Gifts made on manup-movement.org
(PayPal) and gear bought there don't reach Shopify; add those by hand with
`select public.ride_dads_add('rider@email', 'donation', 20, null, 'PayPal 11/27');`
Undo: set `DADS_POINTS=off` and restart; the rollback file removes the tables.

## tow-alert

Texts (and optionally emails) everyone on duty on the Moto Tow board when a
new tow comes in, and turns texts sent to the tow number into tows on the
board. Needs `sql/shop/2026-11-25-shop-014-tow.sql` first. Uses Quo (the phone
service) to send and receive texts, and Resend for email if you want it.

Install (once):

1. Copy the folder `supabase/functions/tow-alert` to
   `/root/supabase/docker/volumes/functions/tow-alert` on the server.
2. Make up a long random key, for example with `openssl rand -hex 24`.
3. On the server, add to `/root/supabase/docker/.env`:
   ```
   TOW_HOOK_KEY=<the random key>
   QUO_API_KEY=<Quo > Settings > API>
   QUO_FROM=<the tow number, like +15205550123>
   RESEND_API_KEY=<optional>
   TOW_EMAIL_FROM=<optional, like Moto Tow <dispatch@your-domain>>
   ```
   and the same names under `functions:` > `environment:` in
   `docker-compose.yml`, each as `NAME: ${NAME}`.
4. Restart the functions container: `docker compose up -d functions`.
5. In Supabase Studio, Database > Webhooks, create a webhook on table
   `shop_tow_requests`, event Insert, type HTTP request, method POST, URL
   `https://api.ride.siccycles.com/functions/v1/tow-alert?key=<the random key>`.
6. In Quo, Settings > Webhooks, add a webhook for "message.received" on the
   tow number with the same URL.
7. Test: turn yourself on duty on the tow board with your cell number, then
   book a test tow on `/tow/`. You get a text. The functions log shows
   `tow alert 1 on duty, 1 sent`. A 401 means the key in the URL does not match.

Undo: delete both webhooks, remove the folder, restart the container.
