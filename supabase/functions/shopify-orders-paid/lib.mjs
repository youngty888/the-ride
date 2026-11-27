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

// What one paid order means for Dads Don't Quit points: the order's Dollars for
// Dads donation lines and its ManUp merch lines, in dollars. Returns null when it
// has neither. cfg: { donationVariantIds: [..], manupVendors: ['manup', ..],
// manupProductIds: [..] }. A merch line is one whose product is listed in
// manupProductIds, or whose vendor contains one of manupVendors (letters and
// digits only, any case: "ManUp Movement" and "The Man Up Movement" both match
// "manup").
const squash = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const lineCents = l => {
  const disc = (Array.isArray(l.discount_allocations) ? l.discount_allocations : []).reduce((s, d) => s + cents(d?.amount), 0);
  return Math.max(0, cents(l.price) * Math.max(0, Number(l.quantity) || 0) - disc);
};
const MEMBER_NAMES = ['ride member', 'ride_member', 'ride member id'];
export function orderToDads(order, cfg) {
  if (!order || typeof order !== 'object' || !cfg) return null;
  const donIds = new Set((cfg.donationVariantIds || []).map(String));
  const prodIds = new Set((cfg.manupProductIds || []).map(String));
  const vendors = (cfg.manupVendors || []).map(squash).filter(Boolean);
  let don = 0; let merch = 0; let member = '';
  for (const l of Array.isArray(order.line_items) ? order.line_items : []) {
    if (!l || typeof l !== 'object') continue;
    if (donIds.has(String(l.variant_id ?? ''))) {
      don += lineCents(l);
      member = member || attr(l.properties, MEMBER_NAMES);
    } else if (prodIds.has(String(l.product_id ?? '')) || (vendors.length && vendors.some(v => squash(l.vendor).includes(v)))) {
      merch += lineCents(l);
    }
  }
  if (!don && !merch) return null;
  member = attr(order.note_attributes, MEMBER_NAMES) || member;
  const email = String(order.email || order.contact_email || order.customer?.email || '').trim().toLowerCase();
  return {
    order_id: String(order.id ?? ''),
    order_name: order.name ? String(order.name) : null,
    email: email || null,
    ride_member: member ? member.toLowerCase().slice(0, 40) : null,
    donation: (don / 100).toFixed(2),
    merch: (merch / 100).toFixed(2),
    currency: order.currency || null,
    test: order.test === true,
  };
}

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// cfg: { secret, variantIds: [..], shopDomain?: 'xxx.myshopify.com', record: async (rec) => result,
//        dads?: { donationVariantIds, manupVendors, manupProductIds, record: async (rec) => result } }
// One order can pay a plan and give to Dads at the same time (a round-up on a bike
// payment); each part is recorded on its own. Both records ignore repeats, so when
// either fails the whole call answers 500 and Shopify sends it again.
export async function handleShopifyWebhook(req, cfg) {
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  const dadsOn = !!(cfg?.dads?.record && cfg.dads.donationVariantIds?.length);
  if (!cfg?.secret || (!cfg?.variantIds?.length && !dadsOn)) return reply(500, { error: 'webhook is not configured on the server' });
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
  const rec = cfg.variantIds?.length ? orderToRecord(order, cfg.variantIds) : null;
  const dads = dadsOn ? orderToDads(order, cfg.dads) : null;
  if (!rec && !dads) return reply(200, { ignored: dadsOn ? 'no plan payment or Dads gift in this order' : 'no plan payment in this order' });
  if (!/^[0-9]{1,20}$/.test((rec || dads).order_id)) return reply(400, { error: 'no order id' });
  let plan; let gift;
  try {
    if (rec) plan = (await cfg.record(rec)) ?? { ok: true };
    if (dads) gift = (await cfg.dads.record(dads)) ?? { ok: true };
  } catch (e) {
    // 500 makes Shopify send it again later; the database ignores repeats.
    return reply(500, { error: 'could not record the order' });
  }
  // Same answer as before for a plan payment alone; the Dads part rides along.
  if (rec && !dads) return reply(200, plan);
  if (dads && !rec) return reply(200, { dads: gift });
  return reply(200, { ...plan, dads: gift });
}
