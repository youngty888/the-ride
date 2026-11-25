// Map search should behave like a phone map: "mcdonalds" finds the nearest one,
// typed addresses come up (Photon typeahead), and big hotkeys open nearby stops.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load(extra = {}) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ctx = vm.createContext(Object.assign({console, Math, Set, JSON, Promise, encodeURIComponent,
    Storage: {getPoiPrefs: () => ({favorites: [], blocked: [], learned: {}, learn: true})},
    MapModule: {}, document: {getElementById: () => null}, window: {}, L: {},
    App: {escapeHtml: esc}, Geo: {fmtMi: n => n.toFixed(1), distMi: (a, b, c, d) => Math.hypot(c - a, d - b) * 69, bearing: () => 90}}, extra));
  vm.runInContext(src('poi.js') + '\n' + src('route.js') + '\nthis.P = PoiModule; this.R = RouteModule;', ctx);
  return ctx;
}
const node = (name, lat, lon, tags = {}) => ({type: 'node', id: Math.round(lat * 1e6 + lon * 1e3), lat, lon, tags: Object.assign({name, amenity: 'fast_food'}, tags)});

test('chain names match however they are typed', () => {
  const {P} = load();
  const re = new RegExp(P.nameRegex('mcdonalds'), 'i');
  for (const n of ["McDonald's", 'McDonalds', 'Mc Donalds', 'mcdonald’s']) assert.ok(re.test(n), n);
  assert.ok(!re.test('Wendy’s'));
  assert.equal(P.nameRegex('ab'), null);
  assert.equal(P.normName('Jack in the Box!'), 'jackinthebox');
});

test('the name query searches name and brand around the rider', () => {
  const {P} = load();
  const q = P.buildNameQuery(P.nameRegex('circle k'), 32.2, -110.9, 40234);
  assert.ok(q.includes('around:40234,32.20000,-110.90000'));
  assert.ok(q.includes('["name"~') && q.includes('["brand"~'));
});

test('name search returns the nearest match first and widens when nothing is close', async () => {
  const calls = [];
  const {P} = load();
  P.overpass = async (body) => {
    calls.push(body);
    if (body.includes('around:40234,')) return []; // nothing within 25 mi
    return [node("McDonald's", 32.9, -110.9), node("McDonald's", 32.6, -110.9), node('Car Wash by McDonalds', 32.55, -110.9, {amenity: 'car_wash'})];
  };
  const out = await P.searchByName('mcdonalds', 32.2, -110.9);
  assert.equal(calls.length, 2, 'tried 25 then 75 miles');
  assert.equal(out[0].lat, 32.6);
  assert.ok(out.every((p, i) => i === 0 || p.distanceMi >= out[i - 1].distanceMi || P.nameTier(p, 'mcdonalds') > P.nameTier(out[i - 1], 'mcdonalds')));
});

test('Photon results become US address suggestions', () => {
  const {R} = load();
  const out = R.photonToResults({features: [
    {geometry: {coordinates: [-110.97, 32.22]}, properties: {countrycode: 'US', housenumber: '123', street: 'E Main St', city: 'Tucson', state: 'Arizona', postcode: '85701'}},
    {geometry: {coordinates: [2.35, 48.85]}, properties: {countrycode: 'FR', name: 'Paris'}},
  ]});
  assert.equal(out.length, 1);
  assert.equal(out[0].short, '123 E Main St, Tucson');
  assert.equal(out[0].lat, 32.22);
  assert.equal(out[0].lon, -110.97);
});

test('duplicate results from two services are merged', () => {
  const {R} = load();
  const a = [{short: 'A', lat: 32.2, lon: -110.9}];
  const b = [{short: 'A again', lat: 32.2001, lon: -110.9001}, {short: 'B', lat: 33, lon: -111}];
  assert.equal(R.mergeResults(a, b).map(r => r.short).join(), 'A,B');
});

test('search is centred on GPS, then the route start, then the map', () => {
  const {R} = load({MapModule: {map: {getCenter: () => ({lat: 1, lng: 2})}}});
  R.gps = null; R.from = null;
  assert.equal(R.searchCenter().source, 'map');
  R.from = {lat: 3, lon: 4};
  assert.equal(R.searchCenter().source, 'start');
});

test('a far-away match is labelled as farther away, not shown as nearby', () => {
  const {R} = load();
  const {html} = R.buildSuggestions(null, [], [{short: "McDonald's, Bangor", name: "McDonald's, Bangor, Maine", lat: 44, lon: -68}], true, "McDonald's");
  assert.ok(html.includes('Farther away'));
});

test('hotkeys point at real stop groups', () => {
  const {P} = load();
  assert.equal(P.HOTKEYS.map(h => h.id).join(), 'gas,food,hotel,mechanic');
  for (const h of P.HOTKEYS) {
    const g = P.GROUPS.find(x => x.id === h.group);
    assert.ok(g, h.id);
    assert.ok(h.sub === 'all' ? g.all : g.subs.includes(h.sub), h.id);
  }
});

test('mechanic search no longer returns motorcycle parking', () => {
  const {P} = load();
  const m = P.CATS.find(c => c.id === 'mechanic');
  assert.ok(!m.filters.join().includes('motorcycle_parking'));
  assert.ok(m.filters.join().includes('craft"="mechanic'));
});

test('the map has four big hotkey buttons wired to the app', () => {
  const html = src('index.html');
  for (const id of ['gas', 'food', 'hotel', 'mechanic']) assert.ok(html.includes(`data-hotkey="${id}"`), id);
  assert.ok(src('app.js').includes('openHotkey('));
});
