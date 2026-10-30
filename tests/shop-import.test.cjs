// SICSYSTEMS importer (scripts/shop-import/import.cjs) with made-up data in the
// sheet's shape. Real customer data is never stored in the repo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan, rpcArgs, report } = require('../scripts/shop-import/import.cjs');

const row = (r, description, labor_hours, labor_amount, parts_price, extra = {}) =>
  ({ row: r, description, labor_hours, labor_amount, parts_price, order_log: '', parts_ordered: '', line_total: (labor_amount || 0) + (parts_price || 0), ...extra });
const inv = (tab, number, status, customer, bike, lines, sheet, extra = {}) =>
  ({ tab, number, header: `INVOICE #${number}`, date: '2026-10-01', status, customer, bike, lines, sheet_totals: sheet, payment: 'Paid', payment_note: '', authorized_by: 'Garrett', ...extra });
const DATA = {
  settings: { 'Shop Name': 'SIC Cycles', Phone: '520-000-0000', Email: 'shop@example.com', 'Sales Tax Rate': 0.087 },
  policies: ['Labor Rate: $150 per hour'],
  jobs_log: { 2001: { 'Total $': 268.46, 'Parts Cost $': 75 }, 2002: { 'Total $': 999 } },
  invoices: [
    inv('Test A IV#2001', 2001, 'Complete', { name: 'Test A', phone: '520-111-1111', email: '', address: '' },
      { year: '2013', make: 'Harley', model: 'Street Glide', vin: '1HD1TEST0000001', mileage: '44758' },
      [row(13, 'Front pads', 0, 0, 0, { order_log: 'declined', line_total: 0 }), row(14, 'Rear pads', 1, 150, 92.99), row(15, 'Caliper bolt', 0, 0, 15.99)],
      { labor: 150, parts: 108.98, subtotal: 258.98, tax: 9.48126, grand: 268.46126 }),
    inv('Test A IV#2002', 2002, 'Estamate', { name: 'test a', phone: '', email: 'a@example.com', address: '' },
      { year: 'na', make: 'Harley', model: 'Street Glide', vin: '1hd1test0000001', mileage: '' },
      [row(13, 'Fender', 0.3, 45, 0), row(14, 'payment @ pickup', 0, 0, 0, { line_total: -100 })],
      { labor: 45, parts: 0, subtotal: 45, tax: 0, grand: 45 }),
    inv('Test B IV#2003', 2003, 'Complete', { name: 'Test B', phone: '', email: '', address: '' }, { year: '', make: '', model: '', vin: '', mileage: '' },
      [row(13, 'Oil', 0, 75, 85)], { labor: 75, parts: 85, subtotal: 100, tax: 0, grand: 100 }), // no tax charged + bad sheet total
    inv('Test B O&A 2003', 2003, 'Estamate', { name: 'Test B', phone: '', email: '', address: '' }, { year: '', make: '', model: '', vin: '', mileage: '' },
      [row(13, 'Oil', 0, 50, 0)], { labor: 50, parts: 0, subtotal: 50, tax: 0, grand: 50 }),
  ],
};

test('sheet rows become labor and part lines; totals match the sheet rounded to cents', () => {
  const plan = buildPlan(DATA);
  const a = plan.jobs.find(j => j.number === 2001);
  assert.deepEqual(a.items.map(i => [i.kind, i.description, i.quantity, i.unit_price]), [
    ['labor', 'Front pads (declined)', '1', '0.00'], ['labor', 'Rear pads', '1', '150.00'],
    ['part', 'Rear pads (parts)', '1', '92.99'], ['part', 'Caliper bolt', '1', '15.99']]);
  assert.equal(a.calc.total, 268.46); assert.deepEqual(a.issues, []);
  assert.equal(a.job.estimate_number, '2001'); assert.equal(a.job.status, 'complete'); assert.equal(a.job.tax_rate, '8.7');
  // our parts cost from Jobs_Log spread over the part lines by price
  assert.deepEqual(a.items.filter(i => i.kind === 'part').map(i => i.unit_cost), ['64.00', '11.00']);
  assert.match(a.job.notes, /Payment: Paid/); assert.match(a.job.notes, /Authorized by Garrett/);
});

test('same customer and same bike across invoices are merged; hours x rate kept when exact', () => {
  const plan = buildPlan(DATA);
  const a1 = plan.jobs.find(j => j.number === 2001), a2 = plan.jobs.find(j => j.number === 2002);
  assert.equal(a1.customerKey, a2.customerKey); assert.equal(a1.bike.id, a2.bike.id);
  const c = plan.customers.get(a1.customerKey);
  assert.equal(c.phone, '520-111-1111'); assert.equal(c.email, 'a@example.com');
  assert.deepEqual(a2.items.map(i => [i.quantity, i.unit_price]), [['0.3', '150.00']]);
  assert.equal(a2.job.status, 'estimate');
  assert.ok(plan.warnings.some(w => /payment @ pickup.*left off/.test(w)));
  assert.match(a2.job.notes, /Sheet row not imported: "payment @ pickup"/);
  assert.ok(plan.warnings.some(w => /year "na"/.test(w)));
});

test('no tax charged on the sheet imports as No tax; broken sheet totals and duplicates are reported', () => {
  const plan = buildPlan(DATA);
  const b = plan.jobs.find(j => j.number === 2003);
  assert.equal(b.job.tax_applies_to, 'none'); assert.equal(b.calc.total, 160);
  assert.ok(b.issues.some(i => /formula error/.test(i)));
  assert.equal(plan.jobs.filter(j => j.number === 2003).length, 1);
  assert.ok(plan.skipped.some(s => /O&A/.test(s)));
  assert.ok(plan.jobs.find(j => j.number === 2002).issues.some(i => /Jobs_Log total \$999\.00/.test(i)));
  assert.match(report(plan), /CHECK #2003/);
});

test('ids are stable so re-importing updates instead of duplicating; settings come from the sheet', () => {
  const p1 = buildPlan(DATA), p2 = buildPlan(JSON.parse(JSON.stringify(DATA)));
  assert.deepEqual(p1.jobs.map(j => j.id), p2.jobs.map(j => j.id));
  for (const j of p1.jobs) { const a = rpcArgs(p1, j); assert.match(a.p_job_id, /^[A-Za-z0-9_-]{6,64}$/); assert.match(a.p_customer_id, /^[A-Za-z0-9_-]{6,64}$/); }
  assert.equal(p1.settings.default_tax_rate, '8.7'); assert.equal(p1.settings.phone, '520-000-0000');
  assert.match(p1.settings.estimate_terms, /Labor Rate: \$150/);
});
