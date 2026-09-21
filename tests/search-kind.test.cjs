const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function load() {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ctx = vm.createContext({console, Math, Set, JSON, Storage: {}, MapModule: {}, document: {getElementById: () => null}, window: {}, L: {},
    App: {escapeHtml: esc}, Geo: {fmtMi: n => n.toFixed(1)}});
  vm.runInContext(src('poi.js') + '\n' + src('route.js') + '\nthis.P = PoiModule; this.R = RouteModule;', ctx);
  return ctx;
}
const kindOf = (q) => { const {P} = load(); const k = P.matchKind(q); return k && k.label; };

test('kind-of-place words are recognised', () => {
  const words = {gas: 'Gas', 'Gas Station': 'Gas', fuel: 'Gas', coffee: 'Coffee', hotel: 'Lodging', motels: 'Lodging',
    food: 'Food', 'places to eat': 'Food', restrooms: 'Restrooms', camping: 'Camping', 'motorcycle shop': 'Repair',
    grocery: 'Stores', viewpoint: 'Scenic stops', museum: 'Things to see', hospital: 'Hospitals', '  GAS  ': 'Gas'};
  for (const [q, label] of Object.entries(words)) assert.equal(kindOf(q), label, q);
});
test('addresses and names are NOT treated as a kind of place', () => {
  for (const q of ['Gas City, Indiana', 'Phoenix Sky Harbor', 'Starbucks', '123 Main St', 'coffee shop road', 'Hotel California'])
    assert.equal(kindOf(q), null, q);
});
test('the kind vocabulary only points at real categories', () => {
  const {P} = load();
  for (const k of P.KINDS) for (const id of k.cats) assert.ok(P.CATS.some(c => c.id === id), `${k.label}/${id}`);
});
test('nearby stops are listed first, then address matches, and clicks map to the right one', () => {
  const {R, P} = load();
  const kind = P.matchKind('gas');
  const places = [{name: 'Shell', address: '1 Main St', lat: 1, lon: 2, distanceMi: 0.8}, {name: 'Circle K', lat: 3, lon: 4, distanceMi: 1.4}];
  const results = [{short: 'Gas City, IN', name: 'Gas City, Grant, Indiana', lat: 9, lon: 9}];
  const {html, picks} = R.buildSuggestions(kind, places, results, true);
  assert.equal(picks.length, 3);
  assert.equal(picks[0].short, 'Shell');
  assert.equal(picks[2].short, 'Gas City, IN');
  assert.ok(html.indexOf('Shell') < html.indexOf('Gas City, IN'));
  assert.ok(html.includes('near you') && html.includes('0.8 mi away') && html.includes('data-i="2"'));
});
test('with no location a kind search says so instead of showing nothing', () => {
  const {R, P} = load();
  const {html, picks} = R.buildSuggestions(P.matchKind('coffee'), [], [], false);
  assert.equal(picks.length, 0);
  assert.ok(html.includes('Turn on location'));
});
test('a kind search with nothing nearby says so', () => {
  const {R, P} = load();
  assert.ok(R.buildSuggestions(P.matchKind('hotel'), [], [], true).html.includes('No lodging found within 15 miles'));
});
test('a normal address search is unchanged', () => {
  const {R} = load();
  const {html, picks} = R.buildSuggestions(null, [], [{short: 'Tucson, AZ', name: 'Tucson, Pima, Arizona', lat: 1, lon: 1}], true);
  assert.equal(picks.length, 1);
  assert.ok(!html.includes('near you'));
});
test('place names are escaped', () => {
  const {R, P} = load();
  const {html} = R.buildSuggestions(P.matchKind('gas'), [{name: '<img src=x onerror=alert(1)>', lat: 1, lon: 1, distanceMi: 1}], [], true);
  assert.ok(!html.includes('<img'));
});
