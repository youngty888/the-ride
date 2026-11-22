// Garage loans (my-loans.js): which Garage bike a loan belongs to, and what the rider sees.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
global.PpCalc = require('../shop/pp-calc.js');
const MyLoans = new Function('getAccountId', 'CloudRest', `${fs.readFileSync(path.join(__dirname, '..', 'my-loans.js'), 'utf8')}; return MyLoans;`)(() => 'u1', {});

const plan = (over = {}) => ({
  id: 'plan-1', item: '2023 Harley-Davidson Low Rider S', status: 'active', sale_date: '2026-11-15', sale_price: 11000,
  down_payment: 0, schedule: 'monthly', payment_amount: 500, due_day: 18, first_due_date: '2026-12-18', interest_note: 'None, flat price',
  title_held: true, pay_link_url: null, bike: { make: 'Harley-Davidson', model: 'Low Rider S', year: 2023, mileage: 28000 },
  payments: [{ received_date: '2026-12-18', amount: 600, method: 'Cash' }], ...over,
});

test('a loan attaches to the Garage bike with the same year, make and model', () => {
  MyLoans.plans = [plan()];
  assert.equal(MyLoans.match({ make: 'harley-davidson ', model: 'LOW RIDER S', year: 2023 }), MyLoans.plans[0]);
  assert.equal(MyLoans.match({ make: 'Harley-Davidson', model: 'Road Glide', year: 2024 }), null);
  assert.equal(MyLoans.match({ make: 'Harley-Davidson', model: 'Low Rider S', year: 2019 }), null);
});

test('a loan with no matching Garage bike gets its own card', () => {
  MyLoans.plans = [plan()];
  assert.equal(MyLoans.unmatched([{ make: 'Honda', model: 'CB', year: 2000 }]).length, 1);
  assert.equal(MyLoans.unmatched([{ make: 'Harley-Davidson', model: 'Low Rider S', year: 2023 }]).length, 0);
  assert.match(MyLoans.cardHtml(MyLoans.plans[0]), /2023 Harley-Davidson Low Rider S/);
});

test('the loan shows balance, next payment, payments and title note; text from the database is escaped', () => {
  const html = MyLoans.blockHtml(plan({ interest_note: '<img src=x onerror=alert(1)>', pay_link_url: 'javascript:alert(1)' }));
  assert.match(html, /\$10,400\.00/);          // $11,000 - $600
  assert.match(html, /Payments received/);
  assert.match(html, /holds the title/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /javascript:/);    // only https pay links become a button
  assert.equal(MyLoans.blockHtml(null), '');
});
