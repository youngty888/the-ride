const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function loadGuidance() {
  const title = {textContent: ''};
  const sub = {textContent: ''};
  const spoken = [];
  const ctx = vm.createContext({
    console, Math, Date, Set,
    document: {getElementById: id => id === 'routeBarTitle' ? title : id === 'routeBarSub' ? sub : null},
    L: {}, Storage: {}, App: {},
    AlertsModule: {settings: () => ({voiceAlerts: true}), speak: text => spoken.push(text)},
  });
  vm.runInContext(source('geo.js') + '\n' + source('map.js') + '\n' + source('route.js') + '\nthis.M=MapModule;', ctx);
  return {M: ctx.M, title, sub, spoken};
}

const LAT_PER_MI = 1 / 69.05;
const routeCoords = Array.from({length: 41}, (_, i) => [32 + (i * 0.05 * LAT_PER_MI), -110]);
const routeCum = Array.from({length: 41}, (_, i) => i * 0.05);

test('an active ride shows the next maneuver and remaining mileage', () => {
  const {M, title, sub} = loadGuidance();
  const route = {
    coords: routeCoords,
    cum: routeCum,
    distanceMi: 2,
    steps: [
      {type: 'depart', name: 'Main St', distanceMi: 1},
      {type: 'turn', modifier: 'right', name: 'Broadway', distanceMi: 1},
    ],
  };
  M.startGuidance(route);
  M.updateGuidance(32 + 0.55 * LAT_PER_MI, -110);
  assert.match(title.textContent, /0\.4 mi · Turn right onto Broadway/);
  assert.match(sub.textContent, /1\.4 mi left/);
  assert.match(sub.textContent, /Keep RIDE visible on iPhone/);
});

test('spoken turn warning fires once at each distance threshold', () => {
  const {M, spoken} = loadGuidance();
  M.startGuidance({
    coords: routeCoords, cum: routeCum, distanceMi: 2,
    steps: [{type: 'depart', distanceMi: 1}, {type: 'turn', modifier: 'right', name: 'Broadway', distanceMi: 1}],
  });
  M.updateGuidance(32 + 0.55 * LAT_PER_MI, -110);
  M.updateGuidance(32 + 0.55 * LAT_PER_MI, -110);
  M.updateGuidance(32 + 0.95 * LAT_PER_MI, -110);
  M.updateGuidance(32 + 0.95 * LAT_PER_MI, -110);
  assert.equal(spoken.length, 2);
  assert.match(spoken[0], /half a mile/i);
  assert.match(spoken[1], /Turn right/i);
});
