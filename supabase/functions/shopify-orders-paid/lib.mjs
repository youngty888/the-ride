// Shopify "Order payment" (orders/paid) webhook -> payment plan credit.
// Plain web-standard JavaScript (Request, Response, WebCrypto) so it runs in the
// Supabase edge runtime (Deno) and in the Node tests the same way.
// No secrets here: the signing secret and keys come from the server's settings.

const enc = new TextEncoder();

function b64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Shopify signs the raw request body with HMAC-SHA256 and sends it base64 in
// X-Shopify-Hmac-Sha256. Checked on the exact bytes received, before parsing.
export async function verifyShopifyHmac(rawBody, header, secret) {
  if (!secret || !header) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, rawBody);
  return sameText(b64(sig), String(header).trim());
}

const cents = v => Math.round(Number(v || 0) * 100);
const attr = (list, names) => {
  for (const a of Array.isArray(list) ? list : []) {
    const n = String(a?.name ?? a?.key ?? '').trim().toLowerCase();
    if (names.includes(n)) { const v = String(a?.value ?? '').trim(); if (v) return v; }
  }
  return '';
};
const LOAN_NAMES = ['loan', 'loan number', 'loan #'];

// What one paid order means for payment plans. Only the order's lines for the
// plan-payment product (variantIds) count; returns null when it has none, so
// normal store orders are ignored.
export function orderToRecord(order, variantIds) {
  if (!order || typeof order !== 'object') return null;
  const ids = new Set((variantIds || []).map(String));
  const lines = (Array.isArray(order.line_items) ? order.line_items : []).filter(l => ids.has(String(l?.variant_id ?? '')));
  if (!lines.length) return null;
  let total = 0;
  for (const l of lines) {
    const disc = (Array.isArray(l.discount_allocations) ? l.discount_allocations : []).reduce((s, d) => s + cents(d?.amount), 0);
    total += cents(l.price) * Math.max(0, Number(l.quantity) || 0) - disc;
  }
  const ref = attr(order.note_attributes, LOAN_NAMES) || lines.map(l => attr(l.properties, LOAN_NAMES)).find(Boolean) || '';
  return {
    order_id: String(order.id ?? ''),
    order_name: order.name ? String(order.name) : null,
    pay_ref: ref ? ref.toUpperCase().slice(0, 40) : null,
    amount: (Math.max(0, total) / 100).toFixed(2),
    currency: order.currency || null,
    ordered_at: order.processed_at || order.created_at || null,
    test: order.test === true,
  };
}

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// cfg: { secret, variantIds: [..], shopDomain?: 'xxx.myshopify.com', record: async (rec) => result }
export async function handleShopifyWebhook(req, cfg) {
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  if (!cfg?.secret || !cfg?.variantIds?.length) return reply(500, { error: 'webhook is not configured on the server' });
  const raw = new Uint8Array(await req.arrayBuffer());
  if (!(await verifyShopifyHmac(raw, req.headers.get('x-shopify-hmac-sha256'), cfg.secret))) {
    return reply(401, { error: 'bad signature' });
  }
  if (cfg.shopDomain && String(req.headers.get('x-shopify-shop-domain') || '').toLowerCase() !== cfg.shopDomain.toLowerCase()) {
    return reply(401, { error: 'wrong shop' });
  }
  const topic = String(req.headers.get('x-shopify-topic') || '');
  if (topic !== 'orders/paid') return reply(200, { ignored: `topic ${topic || 'missing'}` });
  let order;
  try { order = JSON.parse(new TextDecoder().decode(raw)); } catch { return reply(400, { error: 'not JSON' }); }
  const rec = orderToRecord(order, cfg.variantIds);
  if (!rec) return reply(200, { ignored: 'no plan payment in this order' });
  if (!/^[0-9]{1,20}$/.test(rec.order_id)) return reply(400, { error: 'no order id' });
  try {
    const result = await cfg.record(rec);
    return reply(200, result ?? { ok: true });
  } catch (e) {
    // 500 makes Shopify send it again later; the database ignores repeats.
    return reply(500, { error: 'could not record the order' });
  }
}
