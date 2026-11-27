// Edge function: Shopify "Order payment" webhook -> credit a RIDE payment plan.
// Runs in the shop server's supabase-edge-functions container at
//   https://api.ride.siccycles.com/functions/v1/shopify-orders-paid
// Settings it reads (server only, never in this repo):
//   SHOPIFY_WEBHOOK_SECRET     the signing secret shown under Shopify admin >
//                              Settings > Notifications > Webhooks
//   SHOPIFY_PLAN_VARIANT_IDS   comma list of the plan-payment product variant ids
//   SHOPIFY_SHOP_DOMAIN        optional, e.g. xxxx.myshopify.com
//   DADS_POINTS                "on" to give Dads Don't Quit points (needs shop-016)
//   D4D_VARIANT_IDS            optional, the Dollars for Dads Donation variant ids;
//                              defaults to the ones on siccycles.com today
//   MANUP_VENDORS              optional, comma list; a line whose vendor contains one
//                              counts as ManUp merch (default "manup")
//   MANUP_PRODUCT_IDS          optional, comma list of ManUp merch product ids
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   already set for every function
// See supabase/functions/README.md for how to install it.
import { handleShopifyWebhook } from './lib.mjs';

const env = (k: string) => (Deno.env.get(k) ?? '').trim();

// "Dollars for Dads Donation" on siccycles.com: $1, $5, $10, $25, $50. Not secret.
const D4D_DEFAULT = '67925558132836,67925558263908,67925558296676,67925558329444,67925558362212';
const list = (k: string, fallback = '') => (env(k) || fallback).split(',').map(s => s.trim()).filter(Boolean);

async function rpc(fn: string, rec: Record<string, unknown>) {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
      authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
    },
    body: JSON.stringify({ p_order: rec }),
  });
  if (!res.ok) {
    console.error(fn, 'failed', res.status, (await res.text()).slice(0, 300));
    throw new Error(`database ${res.status}`);
  }
  const out = await res.json();
  console.log(fn, rec.order_id, out?.status, out?.reason ?? '');
  return out;
}
const record = (rec: Record<string, unknown>) => rpc('shop_record_shopify_order', rec);
const recordDads = (rec: Record<string, unknown>) => rpc('ride_record_dads_order', rec);

Deno.serve(async (req: Request) => {
  const res = await handleShopifyWebhook(req, {
    secret: env('SHOPIFY_WEBHOOK_SECRET'),
    variantIds: list('SHOPIFY_PLAN_VARIANT_IDS'),
    shopDomain: env('SHOPIFY_SHOP_DOMAIN'),
    record,
    dads: env('DADS_POINTS').toLowerCase() === 'on' ? {
      donationVariantIds: list('D4D_VARIANT_IDS', D4D_DEFAULT),
      manupVendors: list('MANUP_VENDORS', 'manup'),
      manupProductIds: list('MANUP_PRODUCT_IDS'),
      record: recordDads,
    } : undefined,
  });
  // One line per call in the container log, so a setup mistake (wrong secret: 401)
  // is easy to spot. Never logs the order itself.
  console.log('shopify webhook', req.headers.get('x-shopify-topic') ?? '-', res.status);
  return res;
});
