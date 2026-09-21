const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load() {
  const ctx = vm.createContext({
    console, Math, Set, JSON,
    Storage: {getPoiPrefs: () => ({favorites: [], blocked: [], maxDetourMi: 5})},
    Geo: {distMi: () => 1, bearing: () => 0, sampleEvery: () => [{lat: 1, lon: 1}], nearestOnPath: () => ({distMi: 1, mile: 5})},
    MapModule: {}, App: {}, document: {getElementById: () => null}, window: {}, L: {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'poi.js'), 'utf8') + '\nthis.P = PoiModule;', ctx);
  return ctx.P;
}
const el = (id, tags) => ({type: 'node', id, lat: 1, lon: 1, tags});

test('Add Stop offers exactly five groups and every sub-choice is a real category', () => {
  const P = load();
  assert.equal(JSON.stringify(P.GROUPS.map(g => g.label)), JSON.stringify(['Gas', 'Food', 'Lodging', 'Store', 'Things to See']));
  for (const g of P.GROUPS) for (const id of g.subs) assert.ok(P.CATS.some(c => c.id === id), `${g.id}/${id}`);
});
test('Hospital is not an Add Stop choice, but the category still exists for Emergency', () => {
  const P = load();
  assert.ok(!P.GROUPS.some(g => g.subs.includes('hospital')));
  assert.ok(P.CATS.some(c => c.id === 'hospital'));
});
test('Gas group has no All (gas and restrooms should not be mixed); other groups do', () => {
  const P = load();
  assert.equal(P.group('gas').all, false);
  for (const id of ['food', 'lodging', 'store', 'see']) assert.equal(P.group(id).all, true);
});
test('an unknown group falls back to Gas', () => {
  assert.equal(load().group('nope').id, 'gas');
});
test('searching a whole group sends ONE query with every sub-category', async () => {
  const P = load(); let bodies = [];
  P.overpass = async body => { bodies.push(body); return []; };
  await P.searchNearby(P.group('food').subs, 1, 1, 10);
  assert.equal(bodies.length, 1);
  for (const f of ['fast_food', 'restaurant', 'cafe']) assert.ok(bodies[0].includes(`"amenity"="${f}"`), f);
});
test('results from a group search are labelled with their own category', async () => {
  const P = load();
  P.overpass = async () => [el(1, {amenity: 'cafe', name: 'Beans'}), el(2, {amenity: 'fast_food', name: 'Burgers'}), el(3, {amenity: 'restaurant', name: 'Diner'})];
  const out = await P.searchNearby(P.group('food').subs, 1, 1, 10);
  const byName = Object.fromEntries(out.map(p => [p.name, p.cat]));
  assert.equal(JSON.stringify(byName), JSON.stringify({Beans: 'cafe', Burgers: 'fast_food', Diner: 'restaurant'}));
});
test('a single category still works with a plain string id', async () => {
  const P = load();
  P.overpass = async () => [el(1, {amenity: 'fuel', name: 'Shell'})];
  const out = await P.searchNearby('fuel', 1, 1, 10);
  assert.equal(out[0].cat, 'fuel');
});
test('Things to See finds viewpoints and attractions along a route too', async () => {
  const P = load(); let body = '';
  P.overpass = async b => { body = b; return [el(1, {tourism: 'viewpoint', name: 'Overlook'}), el(2, {tourism: 'museum', name: 'Museum'})]; };
  const out = await P.searchAlongRoute(P.group('see').subs, [[1, 1]], [0]);
  assert.ok(body.includes('viewpoint') && body.includes('museum'));
  assert.equal(out.map(p => p.cat).sort().join(), 'attraction,viewpoint');
});
test('Store group finds both shops and mechanics', async () => {
  const P = load();
  P.overpass = async () => [el(1, {shop: 'convenience', name: 'Mart'}), el(2, {shop: 'motorcycle_repair', name: 'Wrench'})];
  const out = await P.searchNearby(P.group('store').subs, 1, 1, 10);
  assert.equal(out.map(p => p.cat).sort().join(), 'mechanic,store');
});
