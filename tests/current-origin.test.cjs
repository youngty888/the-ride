const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'route.js'), 'utf8');

test('the planner automatically uses the latest GPS fix as its origin', () => {
  const input = {value: ''};
  const results = {innerHTML: ''};
  const ctx = vm.createContext({console, Math, Date, Set, JSON,
    document: {getElementById: id => id === 'planFrom' ? input : id === 'planFromResults' ? results : null},
    MapModule: {currentLocation: {lat: 32.22, lon: -110.97}, requestOneFix() {}},
    Storage: {}, Geo: {}, PoiModule: {}, App: {}, window: {}, L: {}});
  vm.runInContext(source + '\nthis.R = RouteModule;', ctx);
  ctx.R.useGpsAsOrigin(true);
  assert.equal(input.value, 'Current location');
  assert.equal(ctx.R.originFollowsLocation, true);
  assert.equal(ctx.R.from.lat, 32.22);
  assert.equal(ctx.R.from.lon, -110.97);
});
