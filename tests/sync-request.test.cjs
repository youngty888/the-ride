// Runs the REAL request() of each sync module against a fake fetch, because the other
// sync tests replace request() and so cannot catch response-handling bugs
// (PostgREST answers writes with return=minimal as 201/204 with an EMPTY body).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function load(file, name, respond) {
  const session = new Map([['sicc-ride-auth-session', JSON.stringify({user:{id:'rider-a'},access_token:'t'})]]);
  const local = new Map();
  const ctx = vm.createContext({console, setTimeout:()=>0, clearTimeout(){}, JSON, encodeURIComponent,
    AbortSignal:{timeout:()=>undefined},
    fetch: async (url, opts) => respond(url, opts),
    window:{localStorage:{getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)},
      addEventListener(){}, SICC_RIDE_SUPABASE:{url:'https://x.test', anonKey:'k'}},
    RideSessionStore:{getItem:k=>session.get(k)},
    RideAuth:{session:async()=>({user:{id:'rider-a'},access_token:'t'})},
    document:{getElementById:()=>null}, App:{}});
  vm.runInContext(source('storage.js')+'\n'+source('cloud-rest.js')+'\n'+source(file)+`\nthis.M=${name};`, ctx);
  ctx.M.account = 'rider-a';
  return ctx.M;
}
const res = (status, body) => ({ok: status < 400, status, text: async () => body});
for (const [file, name] of [['rides-sync.js','RidesCloud'], ['routes-sync.js','RoutesCloud']]) {
  test(`${name}: a 201 write with an empty body is a success`, async () => {
    const m = load(file, name, () => res(201, ''));
    assert.equal((await m.request('t', {method:'POST'})).length, 0);
  });
  test(`${name}: a 204 write is a success`, async () => {
    const m = load(file, name, () => res(204, ''));
    assert.equal((await m.request('t', {method:'DELETE'})).length, 0);
  });
  test(`${name}: a read still returns the rows`, async () => {
    const m = load(file, name, () => res(200, '[{"id":"a"}]'));
    assert.equal((await m.request('t'))[0].id, 'a');
  });
  test(`${name}: an error status is reported`, async () => {
    const m = load(file, name, () => res(401, ''));
    await assert.rejects(() => m.request('t'), /Sign in again/);
  });
}
