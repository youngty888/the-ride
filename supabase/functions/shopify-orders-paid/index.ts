// Edge function: Shopify "Order payment" webhook -> credit a RIDE payment plan.
// Runs in the shop server's supabase-edge-functions container at
//   https://api.ride.siccycles.com/functions/v1/shopify-orders-paid
// Settings it reads (server only, never in this repo):
//   SHOPIFY_WEBHOOK_SECRET     the signing secret shown under Shopify admin >
//                              Settings > Notifications > Webhooks
//   SHOPIFY_PLAN_VARIANT_IDS   comma list of the plan-payment product variant ids
//   SHOPIFY_SHOP_DOMAIN        optional, e.g. xxxx.myshopify.com
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   already set for every function
// See supabase/functions/README.md for how to install it.
import { handleShopifyWebhook } from './lib.mjs';

const env = (k: string) => (Deno.env.get(k) ?? '').trim();

async function record(rec: Record<string, unknown>) {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/shop_record_shopify_order`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
      authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
    },
    body: JSON.stringify({ p_order: rec }),
  });
  if (!res.ok) {
    console.error('shop_record_shopify_order failed', res.status, (await res.text()).slice(0, 300));
    throw new Error(`database ${res.status}`);
  }
  const out = await res.json();
  console.log('shopify order', rec.order_id, out?.status, out?.reason ?? '');
  return out;
}

Deno.serve((req: Request) => handleShopifyWebhook(req, {
  secret: env('SHOPIFY_WEBHOOK_SECRET'),
  variantIds: env('SHOPIFY_PLAN_VARIANT_IDS').split(',').map(s => s.trim()).filter(Boolean),
  shopDomain: env('SHOPIFY_SHOP_DOMAIN'),
  record,
}));
