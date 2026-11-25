/* Moto Tow price and crew pay math (no DOM). Shared by the public tow request
   page (../tow/) and the staff tow board (tow.html). The database works out
   the same numbers itself (shop_tow_quote, shop-014); tests keep the two the
   same. Money is in whole dollars here; prices are set in round dollars.
   Zones (Tyler's Nov 25 pricing, worst case 9 mpg):
     tucson        within 15 miles of the shop: $125, or $100 going to SIC Cycles,
                   plus $3.50 for each mile past 15
     sierra_vista  flat $295, or $250 going to SIC Cycles
     phoenix       flat $425, or $375 going to SIC Cycles
     other         quoted by staff
   Crew pay: a share of the tow price goes to the crew. One person alone
   gets the solo share; with a navigator the crew gets the pair share, split
   between driver and navigator by the driver's percent (50 = even). */
(function (root) {
  'use strict';
  const ZONES = {
    tucson: { label: 'Tucson area', base: 125, shop: 100, freeMiles: 15, perMile: 3.5 },
    sierra_vista: { label: 'Sierra Vista / Cochise', base: 295, shop: 250 },
    phoenix: { label: 'Phoenix area', base: 425, shop: 375 },
    other: { label: 'Somewhere else (we call you with a price)' },
  };
  const VEHICLES = { motorcycle: 'Motorcycle', atv: 'ATV', golf_cart: 'Golf cart', side_by_side: 'Side-by-side (UTV)' };
  const DEFAULTS = { solo_pct: 30, pair_pct: 40, driver_pct: 50 };
  const round2 = n => Math.round(Number(n) * 100) / 100;

  // Price for a zone. miles = total one-way miles from the shop (only used for
  // tucson). Returns null when staff must quote (other zone).
  function quote(zone, { toShop = false, miles = 0 } = {}) {
    const z = ZONES[zone];
    if (!z || z.base == null) return null;
    let price = toShop ? z.shop : z.base;
    if (z.perMile) price += Math.max(0, Math.ceil(Number(miles) || 0) - z.freeMiles) * z.perMile;
    return round2(price);
  }

  // Crew pay for a delivered tow. Percents are whole numbers (30 = 30%).
  function crewPay(price, { navigator = false, solo_pct, pair_pct, driver_pct } = {}) {
    const s = { ...DEFAULTS };
    if (solo_pct != null) s.solo_pct = Number(solo_pct);
    if (pair_pct != null) s.pair_pct = Number(pair_pct);
    if (driver_pct != null) s.driver_pct = Number(driver_pct);
    const p = Number(price) || 0;
    if (!navigator) return { pool: round2(p * s.solo_pct / 100), driver: round2(p * s.solo_pct / 100), navigator: 0 };
    const pool = round2(p * s.pair_pct / 100);
    const driver = round2(pool * s.driver_pct / 100);
    return { pool, driver, navigator: round2(pool - driver) };
  }

  const money = v => '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const api = { ZONES, VEHICLES, DEFAULTS, quote, crewPay, money };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TowCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
