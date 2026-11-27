/* Dads Don't Quit: Dollars for Dads giving and member points (no DOM).
   Dollars for Dads is ManUp Movement's fundraiser. In RIDE a rider gives through
   the SIC Cycles store (siccycles.com), using the "Dollars for Dads Donation"
   product, so every gift shows up as a siccycles.com order. When Shopify reports
   the order paid, the shop server adds the points to the rider's profile
   (supabase/functions/shopify-orders-paid + sql/shop/...-shop-016-dads-points.sql).

   Points: 1 point for every $1 donated and 1 point for every $1 spent on ManUp
   merch. Thank-you gifts go by the total donated (TIERS below): $30 T-shirt,
   $50 long sleeve shirt, $100 hoodie (Tyler, Nov 27; ManUp items from the
   ManUp store on Hostinger and Printful), the same gifts as the siccycles.com Dads Don't Quit
   page. Every rider starts as a Supporter Brother (the free tier). The tier names
   are placeholders for Tyler to change; the database has its own copy
   (ride_dads_tiers) that must match. */
(function (root) {
  'use strict';
  const SHOP = 'https://www.siccycles.com';
  // Shopify hosts that sell the donation product (same store, two names).
  const SHOP_HOSTS = ['www.siccycles.com', 'siccycles.com', 'siccycles.myshopify.com'];
  // "Dollars for Dads Donation" variants on siccycles.com, largest first.
  const VARIANTS = [
    [100, '69139665485924'], [50, '67925558362212'], [25, '67925558329444'], [20, '69139665453156'],
    [10, '67925558296676'], [5, '67925558263908'], [1, '67925558132836'],
  ];
  const MANUP_DONATE = 'https://manup-movement.org/donate';
  const POINTS_PER_DOLLAR = 1;
  const MAX_GIFT = 1000;
  const TIERS = [
    { min: 30, name: 'Brother', gift: 'ManUp T-shirt' },
    { min: 50, name: 'Riding Brother', gift: 'ManUp long sleeve shirt' },
    { min: 100, name: 'Iron Brother', gift: 'ManUp hoodie' },
  ];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const cents = v => Math.round(Number(String(v ?? 0).replace(/[$,\s]/g, '') || 0) * 100);
  const wholeDollars = v => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= MAX_GIFT ? n : 0; };

  // Cart lines for a gift of whole dollars, fewest lines first ($35 = $25 + $10).
  function lines(dollars) {
    let left = wholeDollars(dollars);
    if (!left) return [];
    const out = [];
    for (const [value, id] of VARIANTS) {
      const qty = Math.floor(left / value);
      if (qty) { out.push([id, qty]); left -= qty * value; }
    }
    return out;
  }

  // How many whole dollars round an amount up to (at least) the next step.
  // step is in dollars (1, 5 or 10). The gift is whole dollars, because the
  // donation product sells in whole dollars: $37.40 -> $1 for the next $1
  // (new total $38.40), $3 for the next $5 ($40.40). An amount already on the
  // step gives 0 (nothing to round).
  function roundUp(amount, step) {
    const c = cents(amount); const s = Math.round(Number(step) || 1) * 100;
    if (!(c > 0) || !(s > 0)) return 0;
    const up = Math.ceil(c / s) * s - c;
    return Math.ceil(up / 100);
  }

  // The round-up choices for one amount: [{step, add, total}] with nothing to add left out.
  function roundUpChoices(amount) {
    const c = cents(amount);
    if (!(c > 0)) return [];
    const seen = new Set(); const out = [];
    for (const step of [1, 5, 10]) {
      const add = roundUp(amount, step);
      if (add > 0 && !seen.has(add)) { seen.add(add); out.push({ step, add, total: (c + add * 100) / 100 }); }
    }
    return out;
  }

  const attrs = (o) => Object.entries(o).filter(([, v]) => v)
    .map(([k, v]) => `attributes[${encodeURIComponent(k)}]=${encodeURIComponent(v)}`).join('&');

  // A siccycles.com cart link for a gift. member: the RIDE account id, so the
  // points land on this rider even if they check out with another email.
  function donateLink(dollars, opts = {}) {
    const l = lines(dollars);
    if (!l.length) return '';
    const member = UUID.test(String(opts.member || '')) ? String(opts.member).toLowerCase() : '';
    const q = attrs({ 'Dollars for Dads': opts.how || 'RIDE app', 'RIDE member': member });
    return `${SHOP}/cart/${l.map(([id, n]) => `${id}:${n}`).join(',')}?${q}`;
  }

  // Adds a gift to an existing siccycles.com cart link (a bike payment, a store
  // cart). Only links to the SIC Cycles store, since the donation product lives
  // there. Returns the link unchanged when there is nothing to add or it can't.
  function addToCart(link, dollars, opts = {}) {
    const l = lines(dollars);
    const m = /^https:\/\/([A-Za-z0-9.-]+)\/cart\/(\d+:\d+(?:,\d+:\d+)*)(\?[^\s"'<>#]*)?$/.exec(String(link || ''));
    if (!l.length || !m || !SHOP_HOSTS.includes(m[1].toLowerCase())) return link;
    const member = UUID.test(String(opts.member || '')) ? String(opts.member).toLowerCase() : '';
    const extra = attrs({ 'Dollars for Dads': opts.how || 'Round-up', 'RIDE member': member });
    const q = m[3] ? `${m[3]}&${extra}` : `?${extra}`;
    return `https://${m[1]}/cart/${m[2]},${l.map(([id, n]) => `${id}:${n}`).join(',')}${q}`;
  }
  const canAddTo = link => addToCart(link, 1) !== link;

  // Where a donated total stands: the tier reached, the next one and how far.
  function tierFor(donated) {
    const total = Math.max(0, cents(donated)) / 100;
    let current = null; let next = null;
    for (const t of TIERS) { if (total >= t.min) current = t; else if (!next) next = t; }
    return { total, current, next, toNext: next ? Math.ceil((next.min - total) * 100) / 100 : 0 };
  }
  const pointsFor = dollars => Math.floor(Math.max(0, cents(dollars)) / 100) * POINTS_PER_DOLLAR;

  const D4D = { SHOP, SHOP_HOSTS, VARIANTS, MANUP_DONATE, POINTS_PER_DOLLAR, MAX_GIFT, TIERS,
    lines, roundUp, roundUpChoices, donateLink, addToCart, canAddTo, tierFor, pointsFor, wholeDollars };
  if (typeof module !== 'undefined' && module.exports) module.exports = D4D;
  root.D4D = D4D;
})(typeof window !== 'undefined' ? window : globalThis);
