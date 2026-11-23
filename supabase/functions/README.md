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
5. In Shopify, use "Send test notification". The test order has no loan number,
   so it shows as held on the Payment plans page. Mark it handled.

Undo: delete the webhook in Shopify, remove the folder, restart the container.
