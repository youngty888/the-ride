const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const KEY = 'sicc-ride-auth-session';
function area(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {getItem:k=>m.has(k)?m.get(k):null, setItem:(k,v)=>m.set(k,String(v)), removeItem:k=>m.delete(k), m};
}
function store(win) {
  const ctx = vm.createContext({window: win});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','session-store.js'),'utf8')+'\nthis.S=RideSessionStore;', ctx);
  return ctx.S;
}
test('the sign-in survives closing the app (new tab storage, same device storage)', () => {
  const local = area();
  store({localStorage: local, sessionStorage: area()}).setItem(KEY, 'tok');
  const reopened = store({localStorage: local, sessionStorage: area()}); // tab storage is empty again
  assert.equal(reopened.getItem(KEY), 'tok');
});
test('a session left in tab storage by the old version is moved over, not lost', () => {
  const local = area(), tab = area({[KEY]: 'old'});
  const s = store({localStorage: local, sessionStorage: tab});
  assert.equal(s.getItem(KEY), 'old');
  assert.equal(local.getItem(KEY), 'old');
  assert.equal(tab.getItem(KEY), null);
});
test('signing out clears the sign-in everywhere', () => {
  const local = area({[KEY]: 'a'}), tab = area({[KEY]: 'a'});
  const s = store({localStorage: local, sessionStorage: tab});
  s.removeItem(KEY);
  assert.equal(local.getItem(KEY), null);
  assert.equal(tab.getItem(KEY), null);
  assert.equal(s.getItem(KEY), null);
});
test('a refreshed token replaces the stored one', () => {
  const local = area({[KEY]: 'old'});
  const s = store({localStorage: local, sessionStorage: area()});
  s.setItem(KEY, 'new');
  assert.equal(s.getItem(KEY), 'new');
});
test('falls back to tab storage when device storage is blocked', () => {
  const blocked = {get localStorage() { throw new Error('blocked'); }, sessionStorage: area()};
  const s = store(blocked);
  s.setItem(KEY, 'tok');
  assert.equal(s.getItem(KEY), 'tok');
});
test('falls back to tab storage when writing to device storage fails', () => {
  const full = {getItem:()=>null, setItem(){ throw new Error('quota'); }, removeItem(){}};
  const tab = area();
  const s = store({localStorage: full, sessionStorage: tab});
  s.setItem(KEY, 'tok');
  assert.equal(tab.getItem(KEY), 'tok');
  assert.equal(s.getItem(KEY), 'tok');
});
