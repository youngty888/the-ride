const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load(stored) {
  const local = new Map();
  if (stored) local.set('rideflow_poi_prefs:rider-a', JSON.stringify(stored));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ctx = vm.createContext({console, Math, Set, JSON, Date, Object,
    window: {localStorage: {getItem: k => local.has(k) ? local.get(k) : null, setItem: (k, v) => local.set(k, v), removeItem: k => local.delete(k)}},
    RideSessionStore: {getItem: () => JSON.stringify({user: {id: 'rider-a'}, access_token: 't'})},
    Geo: {}, MapModule: {}, L: {}, document: {getElementById: () => null}, App: {escapeHtml: esc}});
  vm.runInContext(['storage.js', 'poi.js', 'prefs.js'].map(src).join('\n') + '\nthis.S = Storage; this.P = PoiModule; this.M = PrefsModule;', ctx);
  return ctx;
}
const poi = (name, extra = {}) => ({name, cat: 'fuel', brand: name, distanceMi: 1, ...extra});
const pick = (P, p, n) => { for (let i = 0; i < n; i++) P.recordPick(p); };

test('prefs saved by an older version get the new fields', () => {
  const {S} = load({favorites: ['x'], blocked: [], preferredCats: [], maxDetourMi: 7});
  const p = S.getPoiPrefs();
  assert.equal(p.maxDetourMi, 7);
  assert.equal(p.favorites[0], 'x');
  assert.equal(p.learn, true);
  assert.equal(p.startGroup, 'gas');
  assert.equal(Object.keys(p.learned).length, 0);
});
test('a stop becomes "usual" after three picks, not before', () => {
  const {P} = load(); const shell = poi('Shell');
  pick(P, shell, 2); assert.equal(P.isUsual(shell), false);
  pick(P, shell, 1); assert.equal(P.isUsual(shell), true);
});
test('generic unnamed places are not learned', () => {
  const {P, S} = load();
  assert.equal(P.recordPick({name: 'Gas', cat: 'fuel', brand: ''}), false); // name fell back to the category label
  assert.equal(Object.keys(S.getPoiPrefs().learned).length, 0);
});
test('turning learning off stops recording and removes the "usual" boost', () => {
  const {P, S} = load(); const shell = poi('Shell'); pick(P, shell, 3);
  const p = S.getPoiPrefs(); p.learn = false; S.savePoiPrefs(p);
  assert.equal(P.isUsual(shell), false);
  assert.equal(P.recordPick(shell), false);
  assert.equal(S.getPoiPrefs().learned.shell.n, 3);
});
test('the learned list is capped and keeps the most-picked stops', () => {
  const {P, S} = load(); const keep = poi('Favorite Cafe'); pick(P, keep, 5);
  for (let i = 0; i < P.LEARNED_MAX + 10; i++) P.recordPick(poi('Place ' + i));
  const learned = S.getPoiPrefs().learned;
  assert.ok(Object.keys(learned).length <= P.LEARNED_MAX);
  assert.ok(learned['favorite cafe']);
});
test('ranking: favorites, then usual, then the rest by distance; blocked are hidden', () => {
  const {P, S} = load();
  const p = S.getPoiPrefs(); p.favorites = ['circle k']; p.blocked = ['bad gas']; S.savePoiPrefs(p);
  pick(P, poi('Shell'), 3);
  const list = [poi('Chevron', {distanceMi: 0.5}), poi('Shell', {distanceMi: 4}), poi('Circle K', {distanceMi: 9}), poi('Bad Gas', {distanceMi: 0.1}), poi('Valero', {distanceMi: 1})];
  assert.equal(P.rank(list).map(x => x.name).join(), 'Circle K,Shell,Chevron,Valero');
});
test('a stop that is both favorite and usual counts as a favorite', () => {
  const {P, S} = load(); const shell = poi('Shell'); pick(P, shell, 3);
  const p = S.getPoiPrefs(); p.favorites = ['shell']; S.savePoiPrefs(p);
  assert.equal(P.tier(shell), 0);
});
test('adding a brand normalises it, dedupes it, and moves it between lists', () => {
  const {M} = load(); const p = {favorites: [], blocked: ['circle k']};
  assert.equal(M.addTo(p, 'favorites', '  Circle   K '), true);
  assert.equal(p.favorites.join(), 'circle k');
  assert.equal(p.blocked.length, 0);
  M.addTo(p, 'favorites', 'circle k');
  assert.equal(p.favorites.length, 1);
  assert.equal(M.addTo(p, 'favorites', 'x'), false);
});
test('a list cannot grow without bound', () => {
  const {M} = load(); const p = {favorites: [], blocked: []};
  for (let i = 0; i < 60; i++) M.addTo(p, 'favorites', 'brand ' + i);
  assert.equal(p.favorites.length, M.MAX_LIST);
});
test('the app suggests a favorite only for a usual stop that is not one yet', () => {
  const {P, S, M} = load(); pick(P, poi('Circle K'), 4);
  assert.equal(M.suggestion(S.getPoiPrefs()).name, 'Circle K');
  const p = S.getPoiPrefs(); p.favorites = ['circle k']; S.savePoiPrefs(p);
  assert.equal(M.suggestion(S.getPoiPrefs()), null);
  p.favorites = []; p.learn = false; S.savePoiPrefs(p);
  assert.equal(M.suggestion(S.getPoiPrefs()), null);
});
test('the screen shows the suggestion, the learned list and forget buttons', () => {
  const {P, S, M} = load(); pick(P, poi('Circle K'), 3);
  const html = M.html(S.getPoiPrefs());
  assert.ok(html.includes('You usually stop at Circle K'));
  assert.ok(html.includes('data-forget="circle k"'));
  assert.ok(html.includes('Forget everything it learned'));
  assert.ok(html.includes('saved on this device'));
});
test('the screen explains an empty learned list', () => {
  const {S, M} = load();
  assert.ok(M.html(S.getPoiPrefs()).includes('Nothing learned yet'));
});
test('brand names from map data cannot break out of the page', () => {
  const {P, S, M} = load();
  pick(P, poi('"><img src=x onerror=alert(1)>'), 3);
  const html = M.html(S.getPoiPrefs());
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&quot;'));
});

// The real App.escapeHtml: browsers' innerHTML leaves quotes alone, which is unsafe inside attributes.
test('App.escapeHtml is safe inside HTML attributes', () => {
  const div = {set textContent(v) { this.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }};
  const ctx = vm.createContext({console, document: {addEventListener() {}, createElement: () => Object.create(div), getElementById: () => null}, MapModule: {}, Geo: {}, Storage: {}});
  vm.runInContext(src('poi.js') + '\n' + src('app.js') + '\nthis.A = App;', ctx);
  const out = ctx.A.escapeHtml('a"b\'c<d>&');
  assert.equal(out, 'a&quot;b&#39;c&lt;d&gt;&amp;');
  assert.equal(ctx.A.escapeHtml(''), '');
});
