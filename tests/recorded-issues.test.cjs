const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('signed-out-only controls respect the hidden attribute', () => {
  assert.match(read('auth.css'), /\[hidden\]\{display:none!important\}/);
});

test('the legacy cloud review prompt can be dismissed for the visit', () => {
  const source = read('cloud-sync.js');
  assert.match(source, /rideflow_cloud_prompt_dismissed/);
  assert.match(source, /dismiss\.textContent = 'Not now'/);
});

test('hazard reports require confirmation before saving', () => {
  const source = read('alerts.js');
  const confirmation = source.indexOf('if (!confirm(`Report');
  const save = source.indexOf('Storage.saveHazardReport(report)');
  assert.ok(confirmation > -1 && save > confirmation);
});

test('ride history omits empty metadata separators', () => {
  const source = read('app.js');
  assert.match(source, /\[ride\.date, ride\.bikeName, duration\][\s\S]*?\.filter\(Boolean\)[\s\S]*?\.join\(' · '\)/);
});

test('event list hides expired events and displays a year', () => {
  const source = read('app.js');
  assert.match(source, /new Date\(year, month - 1, day\)/);
  assert.match(source, /end >= today/);
  assert.match(source, /event-date-year/);
});

test('known seeded community posts are visibly marked as samples', () => {
  const source = read('app.js');
  assert.match(source, /demoTitles/);
  assert.match(source, /sample-badge/);
});

test('leaderboards are sorted by mileage before ranks are rendered', () => {
  assert.match(read('app.js'), /getLeaderboard\(scope\)\.slice\(\)\.sort\(\(a, b\) => b\.miles - a\.miles\)/);
});

test('profile pack counts come from actual pack records', () => {
  const source = read('app.js');
  assert.match(source, /const packsRidden = packs\.length/);
  assert.match(source, /const packsLed = packs\.filter/);
});

test('overlay close buttons have a visible surface', () => {
  const source = read('styles.css');
  assert.match(source, /\.overlay-close \{[\s\S]*?border: 1px solid var\(--color-border\);[\s\S]*?background: var\(--color-surface-2\);/);
});
