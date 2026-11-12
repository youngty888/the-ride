// Estimate math used on the shop screen (shop/sh-calc.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shop/sh-calc.js');

const part = (description, quantity, unit_price, unit_cost = '') => ({ kind: 'part', description, quantity, unit_price, unit_cost });
const labor = (description, quantity, unit_price) => ({ kind: 'labor', description, quantity, unit_price });

test('two parts and a labor line: line totals, subtotals, tax on parts only, total', () => {
  const r = C.calculate([part('Oil filter', '1', '18.95', '9.10'), part('Oil 1 qt', '4', '12.50', '7.25'), labor('Oil change', '1.5', '95')],
    { rate: '8.7', appliesTo: 'parts' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.lines.map(l => l.total), [18.95, 50, 142.5]);
  assert.equal(r.parts, 68.95); assert.equal(r.labor, 142.5);
  assert.equal(r.tax, 6); // 68.95 * 8.7% = 5.99865 -> 6.00
  assert.equal(r.total, 217.45);
  assert.equal(r.partsCost, 38.1); assert.equal(r.partProfit, 30.85);
  assert.equal(C.money(r.totalCents), '$217.45');
});

test('tax can apply to parts and labor, or not at all', () => {
  const items = [part('Tire', '2', '199.99'), labor('Mount and balance', '1', '80')];
  assert.equal(C.calculate(items, { rate: '8.7', appliesTo: 'parts_labor' }).tax, 41.76); // 479.98 * .087 = 41.758
  assert.equal(C.calculate(items, { rate: '8.7', appliesTo: 'none' }).tax, 0);
});

test('no tax rate entered means $0 tax and is reported as not set (rate is never guessed)', () => {
  const r = C.calculate([part('Plug', '2', '9.99')], { rate: '', appliesTo: 'parts' });
  assert.equal(r.taxRateSet, false); assert.equal(r.tax, 0); assert.equal(r.total, 19.98);
});

test('exact decimal math: no floating point drift', () => {
  // 0.1 + 0.2 style problems and the classic 1.005 rounding case
  const r = C.calculate([part('A', '3', '0.10'), part('B', '1', '0.20'), labor('C', '0.33', '33.33')], { rate: '10', appliesTo: 'parts' });
  assert.equal(r.parts, 0.5); assert.equal(r.labor, 11); // 0.33*33.33 = 10.9989 -> 11.00
  assert.equal(r.tax, 0.05); assert.equal(r.total, 11.55);
  assert.equal(C.calculate([part('x', '1', '1.01')], { rate: '50', appliesTo: 'parts' }).tax, 0.51); // .505 rounds half up
});

test('half-cent rounding matches Postgres round() (half away from zero)', () => {
  assert.equal(C.calculate([labor('x', '0.5', '0.01')]).labor, 0.01); // 0.005 -> 0.01
  assert.equal(C.calculate([labor('x', '0.25', '0.10')]).labor, 0.03); // 0.025 -> 0.03
});

test('bad input is reported, not silently miscalculated', () => {
  const r = C.calculate([part('', '1', '5'), part('x', '0', '5'), part('y', '1.234', '5'), labor('z', '1', '-5'), part('w', 'abc', '1')], { rate: '120' });
  assert.ok(r.errors.some(e => /Line 1: description/.test(e)));
  assert.ok(r.errors.some(e => /Line 2: quantity must be above 0/.test(e)));
  assert.ok(r.errors.some(e => /Line 3: .*2 decimal/.test(e)));
  assert.ok(r.errors.some(e => /Line 4: amounts cannot be negative/.test(e)));
  assert.ok(r.errors.some(e => /Line 5: .*decimal/.test(e)));
  assert.ok(r.errors.some(e => /Tax rate/.test(e)));
});

test('money formatting with thousands separators and $ / commas in input', () => {
  assert.equal(C.money(C.centsOf('1234567.8')), '$1,234,567.80');
  assert.equal(C.calculate([part('x', '1', '$1,200.00')]).parts, 1200);
  assert.equal(C.money(0n), '$0.00');
});
