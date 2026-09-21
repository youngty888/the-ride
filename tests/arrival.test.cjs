const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ~0.69 miles per 0.01 degree of latitude
const START = {lat: 32.0, lon: -110.0};
const DEST = {lat: 32.05, lon: -110.0, name: 'Phoenix Sky Harbor'};
const line = (from, to, steps) => Array.from({length: steps + 1}, (_, i) => ({lat: from + (to - from) * i / steps, lon: START.lon}));

function loadMap(dest) {
  const prompts = [], hidden = [];
  let clock = 1e12; // fake clock: each GPS fix arrives 5 s after the previous one
  class FakeDate extends Date { static now() { return clock; } }
  const ctx = vm.createContext({console, Math, Date: FakeDate, Set, Object,
    L: {polyline: () => ({addTo() { return this; }, setLatLngs() {}})},
    document: {getElementById: () => null, addEventListener() {}},
    RouteModule: {to: dest},
    App: {promptEndRide: (message, spot) => prompts.push({message, spot}), hideArrivalPrompt: () => hidden.push(1)},
    Storage: {genId: () => 'x', saveRide() {}}});
  vm.runInContext(src('geo.js') + '\n' + src('map.js') + '\nthis.M = MapModule;', ctx);
  const M = ctx.M; M.map = {removeLayer() {}};
  M.fix = (p, accuracy = 10) => { clock += 5000; M.currentLocation = {lat: p.lat, lon: p.lon, accuracy}; M.updateRideTracking(p.lat, p.lon); };
  M.ride = (points, accuracy) => points.forEach(p => M.fix(p, accuracy));
  return {M, prompts, hidden, ctx};
}

test('arriving at the destination asks once whether to end the ride', () => {
  const {M, prompts} = loadMap(DEST); M.startRideTracking();
  M.ride(line(32.0, 32.05, 50));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].message, 'You have arrived at Phoenix Sky Harbor.');
  M.arrivalOpen = false; // rider tapped Keep riding
  M.fix(DEST); M.fix(DEST); // still parked there
  assert.equal(prompts.length, 1, 'destination prompt must not repeat');
});
test('no arrival prompt on a loop that starts at the destination', () => {
  const {M, prompts} = loadMap({...START, name: 'Home'}); M.startRideTracking();
  M.fix(START); M.fix({lat: 32.0005, lon: -110.0});
  assert.equal(prompts.length, 0);
});
test('getting back to the start after a real ride asks to end it', () => {
  const {M, prompts} = loadMap(null); M.startRideTracking();
  M.ride(line(32.0, 32.05, 50)); M.ride(line(32.05, 32.0, 50));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].message, 'You are back where you started.');
});
test('a short trip out and back (under 2 miles away) does not trigger the return prompt', () => {
  const {M, prompts} = loadMap(null); M.startRideTracking();
  M.ride(line(32.0, 32.02, 20)); M.ride(line(32.02, 32.0, 20));
  assert.equal(prompts.length, 0);
});
test('a round trip asks at the destination and again when back at the start', () => {
  const {M, prompts} = loadMap(DEST); M.startRideTracking();
  M.ride(line(32.0, 32.05, 50));
  assert.equal(prompts.length, 1);
  M.arrivalOpen = false; // Keep riding
  M.ride(line(32.05, 32.0, 50));
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].message, 'You are back where you started.');
});
test('no second prompt while the first is still open', () => {
  const {M, prompts} = loadMap(DEST); M.startRideTracking();
  M.ride(line(32.0, 32.05, 50)); M.ride(line(32.05, 32.0, 50)); // never answered
  assert.equal(prompts.length, 1);
});
test('a poor GPS fix cannot trigger the prompt', () => {
  const {M, prompts} = loadMap(DEST); M.startRideTracking();
  M.ride(line(32.0, 32.04, 40), 10); // stops 0.7 mi short of the destination
  M.fix(DEST, 400);
  assert.equal(prompts.length, 0);
  M.fix(DEST, 20);
  assert.equal(prompts.length, 1);
});
test('a new ride starts with a clean slate', () => {
  const {M, prompts} = loadMap(DEST); M.startRideTracking();
  M.ride(line(32.0, 32.05, 50)); M.arrivalOpen = false; M.stopRideTracking();
  M.startRideTracking(); M.ride(line(32.0, 32.05, 50));
  assert.equal(prompts.length, 2);
});
test('stopping the ride by hand closes any open prompt', () => {
  const {M, hidden} = loadMap(DEST); M.startRideTracking(); M.fix(START);
  M.stopRideTracking();
  assert.ok(hidden.length >= 1);
});

// ---- App side: the prompt, its buttons, and the 2-minute auto-end ----
function loadApp({tracking = true, here = DEST} = {}) {
  const els = {
    arrivalPrompt: {hidden: true}, arrivalText: {textContent: ''},
    btnRide: {clicks: 0, click() { this.clicks++; }},
  };
  const timers = [];
  const ctx = vm.createContext({console, Math, Date, Set, Object,
    document: {getElementById: id => els[id] || null, addEventListener() {}},
    setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    MapModule: {isTracking: tracking, currentLocation: here, ARRIVE_RADIUS_MI: 0.12, arrivalOpen: true},
    Storage: {}, PoiModule: {}});
  vm.runInContext(src('geo.js') + '\n' + src('app.js') + '\nthis.A = App;', ctx);
  const toasts = []; ctx.A.toast = m => toasts.push(m);
  return {A: ctx.A, els, timers, toasts, M: ctx.MapModule};
}
const spot = {lat: DEST.lat, lon: DEST.lon};

test('the prompt shows the message and offers a 2-minute timer', () => {
  const {A, els, timers} = loadApp();
  A.promptEndRide('You have arrived at X.', spot);
  assert.equal(els.arrivalPrompt.hidden, false);
  assert.equal(els.arrivalText.textContent, 'You have arrived at X.');
  assert.equal(timers[0].ms, 120000);
});
test('no answer and still at the spot: the ride ends by itself', () => {
  const {A, els, timers, toasts} = loadApp();
  A.promptEndRide('x', spot); timers[0].fn();
  assert.equal(els.btnRide.clicks, 1);
  assert.equal(els.arrivalPrompt.hidden, true);
  assert.equal(toasts.length, 1);
});
test('no answer but the rider has ridden on: the ride keeps going', () => {
  const {A, els, timers, M} = loadApp({here: {lat: 32.2, lon: -110.0}});
  A.promptEndRide('x', spot); timers[0].fn();
  assert.equal(els.btnRide.clicks, 0);
  assert.equal(els.arrivalPrompt.hidden, true);
  assert.equal(M.arrivalOpen, false);
});
test('End ride runs the normal Stop Ride flow once', () => {
  const {A, els} = loadApp();
  A.promptEndRide('x', spot); A.endRideFromPrompt();
  assert.equal(els.btnRide.clicks, 1);
  assert.equal(els.arrivalPrompt.hidden, true);
});
test('End ride does nothing if the ride is already stopped', () => {
  const {A, els} = loadApp({tracking: false});
  A.promptEndRide('x', spot); A.endRideFromPrompt();
  assert.equal(els.btnRide.clicks, 0);
});
test('Keep riding closes the prompt and lets the next one fire', () => {
  const {A, els, M} = loadApp();
  A.promptEndRide('x', spot); A.hideArrivalPrompt();
  assert.equal(els.arrivalPrompt.hidden, true);
  assert.equal(M.arrivalOpen, false);
});
