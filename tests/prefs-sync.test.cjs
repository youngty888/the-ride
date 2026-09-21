const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// One shared "cloud" row per rider, and any number of devices (each with its own local storage).
function cloud() { return {rows: {}, offline: false, pushes: 0}; }
function device(server, id = 'rider-a', localMap = new Map()) {
  const rendered = [];
  const ctx = vm.createContext({console, Math, Set, JSON, Date, Object, encodeURIComponent, URLSearchParams,
    setTimeout: () => 0, clearTimeout() {},
    window: {localStorage: {getItem: k => localMap.has(k) ? localMap.get(k) : null, setItem: (k, v) => localMap.set(k, v), removeItem: k => localMap.delete(k)}, addEventListener() {}},
    RideSessionStore: {getItem: () => JSON.stringify({user: {id}, access_token: 't'})},
    RideAuth: {session: async () => ({user: {id}, access_token: 't'})},
    document: {getElementById: () => null},
    Geo: {}, MapModule: {}, L: {}, App: {escapeHtml: s => String(s), applyStartGroupIfIdle() { rendered.push('start'); }},
    PrefsModule: {renderIfOpen() { rendered.push('prefs'); }}});
  vm.runInContext(['storage.js', 'poi.js', 'prefs-sync.js'].map(src).join('\n') + '\nthis.S = Storage; this.P = PrefsCloud; this.PM = PoiModule;', ctx);
  const P = ctx.P, S = ctx.S; P.account = id;
  P.request = async (p, o) => {
    if (server.offline) throw new Error('Offline');
    if (!o) return Object.values(server.rows).filter(r => r.owner_id === id).map(r => ({data: r.data, updated_ms: r.updated_ms}));
    const row = JSON.parse(o.body); server.pushes++; server.rows[row.owner_id] = row; return [];
  };
  P.messages = []; const say = P.say.bind(P); P.say = m => { P.messages.push(m); say(m); };
  return {P, S, PM: ctx.PM, rendered, localMap};
}
const saved = (S, edit) => { const p = S.getPoiPrefs(); edit(p); S.savePoiPrefs(p); return p; };

test('preferences saved on one device reach another', async () => {
  const cloudA = cloud(), a = device(cloudA), b = device(cloudA);
  saved(a.S, p => { p.favorites = ['circle k']; p.blocked = ['bad gas']; p.startGroup = 'food'; p.maxDetourMi = 9; });
  await a.P.reconcile();
  await b.P.reconcile();
  const got = b.S.getPoiPrefs();
  assert.equal(got.favorites[0], 'circle k'); assert.equal(got.blocked[0], 'bad gas');
  assert.equal(got.startGroup, 'food'); assert.equal(got.maxDetourMi, 9);
  assert.ok(b.rendered.includes('prefs') && b.rendered.includes('start'), 'open screens are refreshed');
});
test('the newest edit wins and reaches the other device', async () => {
  const c = cloud(), a = device(c), b = device(c);
  saved(a.S, p => { p.favorites = ['shell']; }); await a.P.reconcile(); await b.P.reconcile();
  const p = b.S.getPoiPrefs(); p.favorites = ['shell', 'chevron']; p.updatedAt = Date.now() + 5000; b.S.set(b.S.KEYS.POI_PREFS, p); // b edits later
  await b.P.reconcile(); await a.P.reconcile();
  assert.equal(a.S.getPoiPrefs().favorites.join(), 'shell,chevron');
  assert.equal(c.rows['rider-a'].data.favorites.join(), 'shell,chevron');
});
test('a stale device does not push over a newer account copy', async () => {
  const c = cloud(), a = device(c), b = device(c);
  saved(a.S, p => { p.favorites = ['old']; }); await a.P.reconcile(); await b.P.reconcile();
  const newer = a.S.getPoiPrefs(); newer.favorites = ['new']; newer.updatedAt = Date.now() + 10000; a.S.set(a.S.KEYS.POI_PREFS, newer); await a.P.reconcile();
  const before = c.pushes;
  await b.P.reconcile(); // b is older: it must adopt, not push
  assert.equal(c.pushes, before);
  assert.equal(b.S.getPoiPrefs().favorites[0], 'new');
});
test('an unchanged copy is not re-uploaded on every sync', async () => {
  const c = cloud(), a = device(c);
  saved(a.S, p => { p.favorites = ['x1']; }); await a.P.reconcile();
  const before = c.pushes; await a.P.reconcile(); await a.P.reconcile();
  assert.equal(c.pushes, before);
});
test('an edit made offline syncs once back online', async () => {
  const c = cloud(), a = device(c); c.offline = true;
  saved(a.S, p => { p.favorites = ['circle k']; }); await a.P.reconcile();
  assert.equal(Object.keys(c.rows).length, 0);
  assert.ok(/Offline/.test(a.P.messages.at(-1)) && /safe on this device/.test(a.P.messages.at(-1)));
  c.offline = false; await a.P.reconcile();
  assert.equal(c.rows['rider-a'].data.favorites[0], 'circle k');
  assert.equal(a.P.messages.at(-1), 'Synced to your account.');
});
test('preferences made before syncing existed are merged, not overwritten, on first sync', async () => {
  const c = cloud(), a = device(c), b = device(c);
  // device A already synced its own favorites
  saved(a.S, p => { p.favorites = ['circle k']; p.learned = {shell: {n: 5, cat: 'fuel', name: 'Shell', last: 1}}; }); await a.P.reconcile();
  // device B has old prefs with no updatedAt (made before this feature)
  const old = {favorites: ['chevron'], blocked: ['bad gas'], preferredCats: [], maxDetourMi: 7, learned: {shell: {n: 2, cat: 'fuel', name: 'Shell', last: 1}, wendys: {n: 3, cat: 'fast_food', name: "Wendy's", last: 1}}};
  b.localMap.set('rideflow_poi_prefs:rider-a', JSON.stringify(old));
  await b.P.reconcile();
  const m = b.S.getPoiPrefs();
  assert.equal(m.favorites.slice().sort().join(), 'chevron,circle k');
  assert.equal(m.blocked.join(), 'bad gas');
  assert.equal(m.learned.shell.n, 5, 'keeps the higher count');
  assert.equal(m.learned.wendys.n, 3);
  assert.equal(m.maxDetourMi, 7, "this device's settings are kept");
  assert.equal(c.rows['rider-a'].data.favorites.length, 2, 'merged copy is saved to the account too');
  await a.P.reconcile();
  assert.equal(a.S.getPoiPrefs().favorites.length, 2);
});
test('a brand favorited here stays a favorite even if the other copy blocked it', () => {
  const {P} = device(cloud());
  const merged = P.merge({favorites: ['shell'], blocked: [], learned: {}}, {favorites: [], blocked: ['shell', 'bad gas'], learned: {}});
  assert.equal(merged.favorites.join(), 'shell');
  assert.equal(merged.blocked.join(), 'bad gas');
});
test('merged lists and learned counts stay within their limits', () => {
  const {P} = device(cloud()); const many = n => Array.from({length: n}, (_, i) => 'brand ' + i);
  const learned = n => Object.fromEntries(Array.from({length: n}, (_, i) => ['k' + i, {n: i, last: i}]));
  const m = P.merge({favorites: many(30), blocked: [], learned: learned(50)}, {favorites: many(60), blocked: [], learned: learned(70)});
  assert.ok(m.favorites.length <= P.LIST_MAX);
  assert.ok(Object.keys(m.learned).length <= P.LEARNED_MAX);
});
test('a rider with no preferences anywhere causes no writes', async () => {
  const c = cloud(), a = device(c);
  await a.P.reconcile();
  assert.equal(c.pushes, 0);
  assert.equal(a.P.messages.at(-1), 'Synced to your account.');
});
test('a new device with no preferences adopts the account copy', async () => {
  const c = cloud(), a = device(c), b = device(c);
  saved(a.S, p => { p.favorites = ['circle k']; }); await a.P.reconcile();
  await b.P.reconcile();
  assert.equal(b.S.getPoiPrefs().favorites[0], 'circle k');
  assert.ok(b.S.getPoiPrefs().updatedAt > 0);
});
test("one rider's preferences are never read by another", async () => {
  const c = cloud(), a = device(c, 'rider-a'), other = device(c, 'rider-b');
  saved(a.S, p => { p.favorites = ['circle k']; }); await a.P.reconcile();
  await other.P.reconcile();
  assert.equal(other.S.getPoiPrefs().favorites.length, 0);
});
test('a failed sync never touches the local preferences', async () => {
  const c = cloud(), a = device(c); saved(a.S, p => { p.favorites = ['keep me']; });
  c.offline = true; await a.P.reconcile();
  assert.equal(a.S.getPoiPrefs().favorites[0], 'keep me');
});
