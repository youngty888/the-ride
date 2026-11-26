// Emergency screen contacts (app.js): call and text links carry only a phone
// number, and the text carries the rider's location only when there is one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const code = src.slice(src.indexOf('  // Only digits and a leading +'), src.indexOf('  renderEmergencyContacts() {'));
const ctx = { MapModule: { currentLocation: null }, encodeURIComponent };
vm.createContext(ctx);
const App = vm.runInContext(`({${code}})`, ctx);

test('only digits and a leading + reach the link', () => {
  assert.equal(App.dialNumber('(520) 555-0101'), '5205550101');
  assert.equal(App.dialNumber(' +1 520.555.0101'), '+15205550101');
  assert.equal(App.dialNumber('520" onclick="x'), '520');
  assert.equal(App.dialNumber('call mom'), '');
});

test('the text has the location, or says there is none', () => {
  const body = () => decodeURIComponent(App.locationTextHref('5205550101').split('body=')[1]);
  assert.match(body(), /could not get my location/);
  assert.doesNotMatch(body(), /maps/);
  ctx.MapModule.currentLocation = { lat: 32.1, lon: -110.9 };
  assert.match(body(), /maps\?q=32\.1,-110\.9$/);
  assert.ok(App.locationTextHref('5205550101').startsWith('sms:5205550101?&body='));
});
