const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function device(server, id = 'rider-a', local = new Map()) {
  const session = new Map([['sicc-ride-auth-session', JSON.stringify({user:{id},access_token:'test'})]]);
  const ls = {getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)};
  const ctx = vm.createContext({console, setTimeout:()=>0,clearTimeout(){},confirm:()=>true,
    window:{localStorage:ls,addEventListener(){}}, sessionStorage:{getItem:k=>session.get(k)},
    RideAuth:{session:async()=>({user:{id},access_token:'test'})},
    document:{getElementById:()=>null},App:{renderProfile(){},renderGarage(){},renderEmergencyContacts(){},updateTotalMiles(){}}});
  vm.runInContext(source('storage.js')+'\n'+source('rides-sync.js')+'\nthis.S=Storage;this.R=RidesCloud;',ctx);
  const R=ctx.R,S=ctx.S;
  R.status=()=>{};
  R.request=async(p,o)=>{
    if(server.offline) throw new Error('Offline');
    if(!o) { // GET (pull)
      return Object.values(server.rows).filter(r=>r.owner_id===id);
    }
    const row = JSON.parse(o.body);
    server.rows[row.id] = row; // upsert (ignore-duplicates semantics: last write for a new id)
    return [];
  };
  return {R,S,local};
}
test('a completed ride pushes to the account once online', async () => {
  const server = {rows:{}}, a = device(server);
  a.S.saveRide({id:'r1', date:'2026-09-19', distance:12.4, duration:1800, bikeId:'bike1'});
  await a.R.init(); await a.R.reconcile();
  assert.equal(server.rows['r1'].owner_id, 'rider-a');
  assert.equal(a.S.getRides()[0].synced, true);
});
test('a ride created offline syncs once back online', async () => {
  const server = {rows:{}, offline:true}, a = device(server);
  a.S.saveRide({id:'r2', date:'2026-09-18', distance:5, duration:600, bikeId:null});
  await a.R.init();
  assert.equal(a.S.getRides()[0].synced, undefined);
  server.offline = false; await a.R.reconcile();
  assert.equal(server.rows['r2'].distance_miles, 5);
  assert.equal(a.S.getRides()[0].synced, true);
});
test('a second device pulls ride history it does not have locally', async () => {
  const server = {rows:{}}, a = device(server);
  a.S.saveRide({id:'r3', date:'2026-09-17', distance:88, duration:3600, bikeId:'bike1'});
  await a.R.init(); await a.R.reconcile();
  const b = device(server); // same account id, empty local storage
  await b.R.init();
  assert.equal(b.S.getRides().length, 1);
  assert.equal(b.S.getRides()[0].id, 'r3');
});
test('another rider cannot see rides from a different account', async () => {
  const server = {rows:{}}, a = device(server);
  a.S.saveRide({id:'r4', date:'2026-09-16', distance:20, duration:1200, bikeId:null});
  await a.R.init(); await a.R.reconcile();
  const other = device(server, 'rider-b');
  await other.R.init();
  assert.equal(other.S.getRides().length, 0);
});
