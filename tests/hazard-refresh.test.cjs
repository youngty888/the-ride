const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'alerts.js'), 'utf8');

async function refresh({route, scan}) {
  const toasts = [];
  const ctx = vm.createContext({console, App: {toast: m => toasts.push(m)},
    RouteModule: {activeRoute: () => route}, HazardModule: {scanRoute: scan}});
  vm.runInContext(source + '\nthis.A = AlertsModule;', ctx);
  Object.assign(ctx.A, {pruneExpired: () => [], rebuildIndex() {}, renderMapReports() {}});
  await ctx.A.manualRefresh(false);
  return toasts;
}

test('refresh with no route only says reports were refreshed', async () => {
  assert.deepEqual(await refresh({route: null}), ['Reports refreshed.']);
});

test('a failed hazard load is reported as unavailable', async () => {
  const toasts = await refresh({route: {}, scan: async () => { throw new Error('offline'); }});
  assert.deepEqual(toasts, ['Riding without the crash cache — data file unavailable.']);
});

test('the refresh button does not claim success on its own', () => {
  assert.doesNotMatch(source, /refreshed from the network/);
});
