const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load(route) {
  const ctx = vm.createContext({RouteModule: {activeRoute: () => route}, App: {escapeHtml: s => s}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'hazards.js'), 'utf8') + '\nthis.H = HazardModule;', ctx);
  return ctx.H;
}
const midtown = [32.2226, -110.9747];
const windyPoint = [32.368, -110.716];

test('a route up Mt Lemmon gets the tap-to-call road hotline, even if crash data fails', () => {
  const H = load({coords: [midtown, windyPoint]});
  for (const failed of [false, true]) assert.match(H.routeSectionHtml(failed), /href="tel:\+15203513351"/);
});

test('routes elsewhere, and no route, do not show the hotline', () => {
  const sabino = [32.31, -110.822], tanqueVerde = [32.27, -110.76], oroValley = [32.42, -110.93];
  for (const route of [{coords: [midtown, sabino, tanqueVerde, oroValley]}, null]) {
    assert.doesNotMatch(load(route).routeSectionHtml(false), /3351/);
  }
});
