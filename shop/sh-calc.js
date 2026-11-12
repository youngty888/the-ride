/* Estimate math for the shop screen. Exact decimal math (no floating-point
   drift) using the SAME rules as shop_save_estimate in the database:
     line total = round(quantity x unit price, 2)
     tax        = round(taxable subtotal x rate% , 2)   (taxable = parts, parts+labor, or nothing)
     total      = parts + labor + tax
   Rounding is half away from zero, like Postgres numeric round(). The database
   recalculates everything on save, so this is for the live screen preview. */
(function (root) {
  'use strict';

  // Parse "12.5" -> 1250n at scale 2. Returns null for blank, NaN for invalid
  // or too many decimals.
  function parseScaled(value, scale) {
    const s = String(value ?? '').trim().replace(/,/g, '').replace(/^\$/, '');
    if (s === '') return null;
    const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (m[2] === '' && (m[3] || '') === '')) return NaN;
    const frac = m[3] || '';
    if (frac.length > scale) return NaN;
    const digits = (m[2] || '0') + frac.padEnd(scale, '0');
    const n = BigInt(digits);
    return m[1] ? -n : n;
  }

  // Round a / b to an integer, half away from zero (b > 0).
  function divRound(a, b) {
    const neg = a < 0n; const abs = neg ? -a : a;
    const q = (abs * 2n + b) / (2n * b);
    return neg ? -q : q;
  }

  const toNumber = cents => Number(cents) / 100;
  function money(cents) {
    const neg = cents < 0n; const abs = neg ? -cents : cents;
    const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${neg ? '-' : ''}$${whole}.${(abs % 100n).toString().padStart(2, '0')}`;
  }

  // items: [{kind:'part'|'labor', description, quantity, unit_price, unit_cost}]
  // tax: {rate: '8.7' | null, appliesTo: 'none'|'parts'|'parts_labor'}
  function calculate(items, tax = {}) {
    const errors = [];
    let parts = 0n, labor = 0n, partsCost = 0n;
    const lines = (items || []).map((it, i) => {
      const n = i + 1;
      const qty = parseScaled(it.quantity, 2) ?? 100n;
      const price = parseScaled(it.unit_price, 2) ?? 0n;
      const cost = it.kind === 'part' ? (parseScaled(it.unit_cost, 2) ?? 0n) : 0n;
      let bad = false;
      if (Number.isNaN(qty) || Number.isNaN(price) || Number.isNaN(cost)) { errors.push(`Line ${n}: numbers can have at most 2 decimal places`); bad = true; }
      else if (qty <= 0n) { errors.push(`Line ${n}: quantity must be above 0`); bad = true; }
      else if (price < 0n || cost < 0n) { errors.push(`Line ${n}: amounts cannot be negative`); bad = true; }
      if (!String(it.description || '').trim()) errors.push(`Line ${n}: description is required`);
      if (it.kind !== 'part' && it.kind !== 'labor') { errors.push(`Line ${n}: type must be part or labor`); bad = true; }
      const total = bad ? 0n : divRound(qty * price, 100n);
      const lineCost = bad ? 0n : divRound(qty * cost, 100n);
      if (it.kind === 'part') { parts += total; partsCost += lineCost; } else if (it.kind === 'labor') labor += total;
      return { totalCents: total, total: toNumber(total), costCents: lineCost };
    });

    const rate = parseScaled(tax.rate, 3);
    if (Number.isNaN(rate) || (rate !== null && (rate < 0n || rate >= 100000n))) errors.push('Tax rate must be a percent between 0 and 100 (up to 3 decimals)');
    const appliesTo = ['none', 'parts', 'parts_labor'].includes(tax.appliesTo) ? tax.appliesTo : 'parts';
    const taxable = appliesTo === 'parts' ? parts : appliesTo === 'parts_labor' ? parts + labor : 0n;
    const taxCents = (rate === null || Number.isNaN(rate)) ? 0n : divRound(taxable * rate, 100000n);
    const totalCents = parts + labor + taxCents;
    return {
      lines, errors, taxRateSet: rate !== null && !Number.isNaN(rate), appliesTo,
      partsCents: parts, laborCents: labor, taxableCents: taxable, taxCents, totalCents, partsCostCents: partsCost,
      parts: toNumber(parts), labor: toNumber(labor), tax: toNumber(taxCents), total: toNumber(totalCents),
      partsCost: toNumber(partsCost), partProfit: toNumber(parts - partsCost),
    };
  }

  const ShCalc = { calculate, money, parseScaled, centsOf: v => parseScaled(v, 2) ?? 0n };
  root.ShCalc = ShCalc;
  if (typeof module !== 'undefined' && module.exports) module.exports = ShCalc;
})(typeof window !== 'undefined' ? window : globalThis);
