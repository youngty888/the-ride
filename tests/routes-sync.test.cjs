const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let clock = 1000;
function device(server, id = 'rider-a', local = new Map()) {
  const session = new Map([['sicc-ride-auth-session', JSON.stringify({user:{id},access_token:'test'})]]);
  const ls = {getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)};
  const ctx = vm.createContext({console, setTimeout:()=>0,clearTimeout(){},confirm:()=>true,
    Date:{now:()=>++clock}, JSON, encodeURIComponent, decodeURIComponent, URLSearchParams,
    window:{localStorage:ls,addEventListener(){}}, RideSessionStore:{getItem:k=>session.get(k)},
    RideAuth:{session:async()=>({user:{id},access_token:'test'})},
    document:{getElementById:()=>null},App:{renderProfile(){},renderGarage(){},renderEmergencyContacts(){},updateTotalMiles(){}}});
  vm.runInContext(source('storage.js')+'\n'+source('routes-sync.js')+'\nthis.S=Storage;this.R=RoutesCloud;',ctx);
  const R=ctx.R,S=ctx.S;
  R.status=m=>{ if(m && process.env.DBG) console.log('STATUS',m); };
  R.request=async(p,o)=>{
    if(server.offline) throw new Error('Offline');
    const q = new URLSearchParams(p.split('?')[1]);
    const owner = (q.get('owner_id') || '').slice(3); // upserts carry the owner in the body instead
    if(!o){ // GET
      const rows = Object.values(server.rows).filter(r=>r.owner_id===owner);
      if(q.get('id')) {
        const ids = q.get('id').slice(4,-1).split(',').map(s=>s.replace(/"/g,''));
        return rows.filter(r=>ids.includes(r.id)).map(r=>({id:r.id,data:r.data}));
      }
      return rows.map(r=>({id:r.id,updated_ms:r.updated_ms}));
    }
    if(o.method==='DELETE'){ delete server.rows[owner+':'+q.get('id').slice(3)]; return []; }
    const row = JSON.parse(o.body); server.posts = (server.posts||0)+1;
    server.rows[row.owner_id+':'+row.id] = row; // upsert (merge-duplicates)
    return [];
  };
  return {R,S,local};
}
const route = (id, extra = {}) => ({id, name:'Tucson to Vegas', from:{name:'Tucson'}, to:{name:'Las Vegas'},
  waypoints:[], geometry:'abc', distanceMi:453, durationSec:30000, createdAt:1, notes:'', ...extra});
const ids = a => a.S.getRoutes().map(r=>r.id).sort().join(',');

test('a saved route is pushed to the account', async () => {
  const server = {rows:{}}, a = device(server);
  await a.R.init(); a.S.saveRoute(route('t1')); await a.R.reconcile();
  assert.equal(server.rows['rider-a:t1'].data.name, 'Tucson to Vegas');
  assert.equal(server.rows['rider-a:t1'].updated_ms, a.S.getRoute('t1').updatedAt);
});
test('a second device downloads saved routes', async () => {
  const server = {rows:{}}, a = device(server);
  await a.R.init(); a.S.saveRoute(route('t2')); await a.R.reconcile();
  const b = device(server); await b.R.init();
  assert.equal(ids(b), 't2');
  assert.equal(b.S.getRoute('t2').geometry, 'abc');
});
test('editing notes on one device reaches the other and the older copy never wins', async () => {
  const server = {rows:{}}, a = device(server), b = device(server);
  await a.R.init(); await b.R.init();
  a.S.saveRoute(route('t3')); await a.R.reconcile(); await b.R.reconcile();
  const r = b.S.getRoute('t3'); r.notes = 'stop at Kingman'; b.S.saveRoute(r); await b.R.reconcile();
  await a.R.reconcile();
  assert.equal(a.S.getRoute('t3').notes, 'stop at Kingman');
  assert.equal(server.rows['rider-a:t3'].data.notes, 'stop at Kingman');
});
test('a stale device does not overwrite a newer cloud copy', async () => {
  const server = {rows:{}}, a = device(server), b = device(server);
  await a.R.init(); await b.R.init();
  a.S.saveRoute(route('t4')); await a.R.reconcile();
  server.offline = true; await b.R.reconcile(); server.offline = false; // b never saw t4
  const r = a.S.getRoute('t4'); r.notes = 'newer'; a.S.saveRoute(r); await a.R.reconcile();
  await b.R.reconcile();
  assert.equal(server.rows['rider-a:t4'].data.notes, 'newer');
  assert.equal(b.S.getRoute('t4').notes, 'newer');
});
test('a route made offline syncs once back online', async () => {
  const server = {rows:{}, offline:true}, a = device(server);
  await a.R.init(); a.S.saveRoute(route('t5'));
  await a.R.reconcile(); assert.equal(Object.keys(server.rows).length, 0);
  server.offline = false; await a.R.reconcile();
  assert.ok(server.rows['rider-a:t5']);
});
test('deleting a route removes it from the account and it stays deleted', async () => {
  const server = {rows:{}}, a = device(server), b = device(server);
  await a.R.init(); await b.R.init();
  a.S.saveRoute(route('t6')); await a.R.reconcile(); await b.R.reconcile();
  a.S.deleteRoute('t6'); await a.R.reconcile(); await b.R.reconcile();
  assert.equal(server.rows['rider-a:t6'], undefined);
  assert.equal(a.S.getRoutes().length, 0);
  assert.equal(b.S.getRoutes().length, 0); // the other device drops it instead of re-uploading it
});
test('a delete made offline is sent later and the route is not pulled back meanwhile', async () => {
  const server = {rows:{}}, a = device(server);
  await a.R.init(); a.S.saveRoute(route('t7')); await a.R.reconcile();
  server.offline = true; a.S.deleteRoute('t7'); await a.R.reconcile();
  server.offline = false; await a.R.reconcile();
  assert.equal(server.rows['rider-a:t7'], undefined);
  assert.equal(a.S.getRoutes().length, 0);
});
test('an unchanged route is not re-uploaded on every sync', async () => {
  const server = {rows:{}}, a = device(server);
  await a.R.init(); a.S.saveRoute(route('t8')); await a.R.reconcile();
  const before = server.posts; await a.R.reconcile(); await a.R.reconcile();
  assert.equal(server.posts, before);
});
test('another rider cannot see or receive my routes', async () => {
  const server = {rows:{}}, a = device(server), o = device(server, 'rider-b');
  await a.R.init(); a.S.saveRoute(route('t9')); await a.R.reconcile();
  await o.R.init();
  assert.equal(o.S.getRoutes().length, 0);
});
test('routes saved before updatedAt existed still sync', async () => {
  const server = {rows:{}}, local = new Map(), a = device(server, 'rider-a', local);
  a.S.set(a.S.KEYS.ROUTES, [route('old', {createdAt: 555})]);
  await a.R.init();
  assert.equal(server.rows['rider-a:old'].updated_ms, 555);
});
