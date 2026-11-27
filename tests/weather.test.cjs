const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Loads weather.js with a fake page and a National Weather Service we can switch off.
async function run({alertsDown = false, forecastDown = false} = {}) {
  const section = {innerHTML: ''};
  const buttons = [];
  const now = new Date();
  const ctx = vm.createContext({
    document: {
      getElementById: () => section,
      querySelectorAll: () => (section.innerHTML.match(/<button[^>]*wx-retry/g) || []).map(() => {
        const b = {bound: false, addEventListener() { this.bound = true; }};
        buttons.push(b); return b;
      }),
    },
    App: {escapeHtml: s => String(s)},
    Storage: {KEYS: {}, get: (k, d) => d, set() {}},
    HazardModule: {routeCrossesWash: () => false},
    Geo: {
      sampleEvery: () => [{lat: 32, lon: -110, mile: 0}],
      pointAtMile: () => ({idx: 0}),
      bearing: () => null,
      fmtClock: () => '9:00 AM',
      async fetchJson(url) {
        if (url.includes('/alerts/')) { if (alertsDown) throw new Error('offline'); return {features: []}; }
        if (forecastDown) throw new Error('offline');
        if (url.includes('/points/')) return {properties: {forecastHourly: 'https://x/hourly'}};
        return {properties: {periods: [{startTime: now.toISOString(), temperature: 70, windSpeed: '5 mph', shortForecast: 'Sunny'}]}};
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'weather.js'), 'utf8') + '\nthis.W = WeatherModule;', ctx);
  await ctx.W.loadForRoute({cum: [0], coords: [[32, -110]], durationSec: 0}, now);
  return {html: section.innerHTML, buttons, leg: ctx.W.legs[0]};
}

test('all checks work: says none active and nothing flagged', async () => {
  const {html, leg} = await run();
  assert.match(html, /None active right now/);
  assert.match(html, /all check out/);
  assert.doesNotMatch(html, /err-box/);
  assert.equal(leg.rideScore.score, 'Great');
});

test('advisory check fails: never says none active, and the point is not scored Great', async () => {
  const {html, leg} = await run({alertsDown: true});
  assert.doesNotMatch(html, /None active right now/);
  assert.match(html, /Couldn't check NWS advisories for 1 of 1/);
  assert.equal(leg.rideScore.score, 'Unknown');
});

test('forecast fails: never says all clear or 0% rain, and every Retry button works', async () => {
  const {html, buttons} = await run({forecastDown: true});
  assert.doesNotMatch(html, /all check out|0% rain/);
  assert.match(html, /No forecast for 1 of 1/);
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every(b => b.bound));
});
