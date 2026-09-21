const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const MI_PER_DEG_LAT = 69.05;
function ride(startClock = 1e12) {
  let clock = startClock;
  class FakeDate extends Date { static now() { return clock; } }
  const ctx = vm.createContext({console, Math, Date: FakeDate, Set, Object,
    L: {polyline: () => ({addTo() { return this; }, setLatLngs() {}})},
    document: {getElementById: () => null, addEventListener() {}},
    RouteModule: {to: null}, App: {promptEndRide() {}, hideArrivalPrompt() {}},
    Storage: {genId: () => 'x', saveRide() {}}});
  vm.runInContext(src('geo.js') + '\n' + src('map.js') + '\nthis.M = MapModule;', ctx);
  const M = ctx.M; M.map = {removeLayer() {}}; M.startRideTracking();
  M.fix = (lat, lon, seconds, accuracy = 12) => { clock += seconds * 1000; M.currentLocation = {lat, lon, accuracy}; M.updateRideTracking(lat, lon); };
  M.miles = () => M.rideDistance * 0.621371;
  return M;
}
const LON = -110;
const wobble = i => ({dLat: Math.sin(i * 1.7) * 0.00007, dLon: Math.cos(i * 2.3) * 0.00007}); // about +/-8 m

test('parked with a wobbling GPS adds essentially no distance', () => {
  const M = ride();
  for (let i = 0; i < 300; i++) { const w = wobble(i); M.fix(32 + w.dLat, LON + w.dLon, 2); } // 10 minutes parked
  assert.ok(M.miles() < 0.01, `phantom miles: ${M.miles()}`);
});
test('real riding is counted accurately (1 mile at about 50 mph)', () => {
  const M = ride(); const steps = 100;
  for (let i = 0; i <= steps; i++) M.fix(32 + (1 / MI_PER_DEG_LAT) * i / steps, LON, 3.6 * 1); // fixes every ~3.6 s
  assert.ok(Math.abs(M.miles() - 1) < 0.03, `counted ${M.miles()}`);
});
test('riding is still counted with a typical 12 m GPS wobble on top', () => {
  const M = ride(); const steps = 200;
  for (let i = 0; i <= steps; i++) { const w = wobble(i); M.fix(32 + (2 / MI_PER_DEG_LAT) * i / steps + w.dLat, LON + w.dLon, 3); }
  assert.ok(Math.abs(M.miles() - 2) < 0.15, `counted ${M.miles()}`);
});
test('slow movement (walking pace) still adds up', () => {
  const M = ride(); const steps = 120; // about 0.15 mi over four minutes
  for (let i = 0; i <= steps; i++) M.fix(32 + (0.15 / MI_PER_DEG_LAT) * i / steps, LON, 2, 8);
  assert.ok(M.miles() > 0.12 && M.miles() < 0.16, `counted ${M.miles()}`);
});
test('parking at the destination after a ride does not inflate the miles', () => {
  const M = ride();
  for (let i = 0; i <= 100; i++) M.fix(32 + (1 / MI_PER_DEG_LAT) * i / 100, LON, 3.6);
  const arrived = M.miles();
  for (let i = 0; i < 120; i++) { const w = wobble(i); M.fix(32 + 1 / MI_PER_DEG_LAT + w.dLat, LON + w.dLon, 2); } // 4 minutes parked
  assert.ok(M.miles() - arrived < 0.01, `grew by ${M.miles() - arrived}`);
});
test('a fix with very poor accuracy is ignored', () => {
  const M = ride();
  M.fix(32, LON, 3); M.fix(32.02, LON, 3, 400);
  assert.equal(M.miles(), 0);
  assert.equal(M.ridePathCoords.length, 1);
});
test('a single GPS teleport is not counted', () => {
  const M = ride();
  for (let i = 0; i <= 20; i++) M.fix(32 + 0.0005 * i, LON, 3);
  const before = M.miles();
  M.fix(32.5, LON, 3); // 30+ miles away in 3 seconds
  M.fix(32 + 0.0005 * 21, LON, 3); // back on the road
  assert.ok(M.miles() - before < 0.1, `jump leaked: ${M.miles() - before}`);
});
test('a genuine relocation is re-anchored without adding the jump', () => {
  const M = ride();
  for (let i = 0; i <= 10; i++) M.fix(32 + 0.0005 * i, LON, 3);
  const before = M.miles();
  for (let i = 0; i < 6; i++) M.fix(32.5 + 0.0005 * i, LON, 3); // phone resumed far away and stays there
  const grown = M.miles() - before;
  assert.ok(grown < 0.5, `relocation counted as riding: ${grown} mi`);
  for (let i = 6; i < 16; i++) M.fix(32.5 + 0.0005 * i, LON, 3); // carries on riding from the new spot
  assert.ok(M.miles() - before > grown, 'riding after re-anchoring is counted again');
});
test('the drawn path leaves out the jitter points', () => {
  const M = ride();
  for (let i = 0; i < 100; i++) { const w = wobble(i); M.fix(32 + w.dLat, LON + w.dLon, 2); }
  assert.ok(M.ridePathCoords.length <= 3, `path has ${M.ridePathCoords.length} points`);
});
test('a ride with no real movement records zero miles', () => {
  const M = ride();
  for (let i = 0; i < 50; i++) { const w = wobble(i); M.fix(32 + w.dLat, LON + w.dLon, 2); }
  assert.equal(M.stopRideTracking().miles < 0.01, true);
});
