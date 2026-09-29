const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'bike-connection.js'), 'utf8');

test('a verified motorcycle-screen connection starts automatic mileage for the selected bike', () => {
  const calls = [];
  const bike = {id: 'bike-1', nickname: 'Road Glide'};
  const settings = {connectedBikeId: 'bike-1'};
  const badge = {hidden: true, textContent: ''};
  const listeners = {};
  const ctx = vm.createContext({console,
    navigator: {},
    window: {addEventListener: (name, fn) => { listeners[name] = fn; }},
    document: {getElementById: id => id === 'bikeConnectionBadge' ? badge : null},
    Storage: {getRideSettings: () => settings, saveRideSettings: () => {}, getBike: id => id === bike.id ? bike : null, getBikes: () => [bike]},
    App: {onBikeConnectionChanged: (connected, info) => calls.push({connected, info}), toast() {}, escapeHtml: s => s},
  });
  vm.runInContext(source + '\nthis.B = BikeConnection;', ctx);
  ctx.B.init();
  ctx.B.setNativeConnection(true, {name: 'SIC motorcycle screen', bikeId: 'bike-1'});
  assert.equal(ctx.B.connected, true);
  assert.equal(ctx.B.source, 'screen');
  assert.equal(badge.hidden, false);
  assert.match(badge.textContent, /SIC motorcycle screen/);
  assert.equal(calls[0].connected, true);
  assert.equal(calls[0].info.bikeId, 'bike-1');
});
