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
    window:{localStorage:ls,addEventListener(){}}, RideSessionStore:{getItem:k=>session.get(k)},
    RideAuth:{session:async()=>({user:{id},access_token:'test'})},
    document:{getElementById:()=>null},App:{rideRenders:0,renderRideHistory(){this.rideRenders++},renderProfile(){},renderGarage(){},renderEmergencyContacts(){},updateTotalMiles(){}}});
  vm.runInContext(source('storage.js')+'\n'+source('rides-sync.js')+'\nthis.S=Storage;this.R=RidesCloud;',ctx);
  const R=ctx.R,S=ctx.S;
  R.status=()=>{};
  R.request=async(p,o)=>{
    if(server.offline) throw new Error('Offline');
    if(!o) return Object.values(server.rows).filter(r=>r.owner_id===id); // GET (pull)
    if(o.method==='DELETE'){
      const q=new URLSearchParams(p.split('?')[1]);
      delete server.rows[q.get('owner_id').slice(3)+':'+q.get('id').slice(3)];
      return [];
    }
    const row = JSON.parse(o.body), key = row.owner_id+':'+row.id;
    if(!server.rows[key]) server.rows[key] = row; // primary key (owner_id, id); ignore-duplicates
    return [];
  };  return {R,S,local,A:ctx.App};
}
test('a completed ride pushes to the account once online', async () => {
  const server = {rows:{}}, a = device(server);
  a.S.saveRide({id:'r1', date:'2026-09-19', distance:12.4, duration:1800, bikeId:'bike1'});
  await a.R.init(); await a.R.reconcile();
  assert.equal(server.rows['rider-a:r1'].owner_id, 'rider-a');
  assert.equal(a.S.getRides()[0].synced, true);
});
test('a ride created offline syncs once back online', async () => {
  const server = {rows:{}, offline:true}, a = device(server);
  a.S.saveRide({id:'r2', date:'2026-09-18', distance:5, duration:600, bikeId:null});
  await a.R.init();
  assert.equal(a.S.getRides()[0].synced, undefined);
  server.offline = false; await a.R.reconcile();
  assert.equal(server.rows['rider-a:r2'].distance_miles, 5);
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
test('deleting a synced ride removes it from the account and it stays deleted', async () => {
  const server = {rows:{}}, a = device(server);
  a.S.saveRide({id:'r5', date:'2026-09-15', distance:30, duration:900, bikeId:null});
  await a.R.init(); await a.R.reconcile();
  assert.ok(server.rows['rider-a:r5']);
  a.S.deleteRide('r5'); await a.R.reconcile();
  assert.equal(server.rows['rider-a:r5'], undefined);
  assert.equal(a.S.getRides().length, 0);
  assert.equal(a.S.get(a.S.KEYS.RIDES_DELETED, []).length, 0);
});
test('a delete made offline is sent later and the ride is not pulled back meanwhile', async () => {
  const server = {rows:{}}, a = device(server);
  a.S.saveRide({id:'r6', date:'2026-09-14', distance:10, duration:600, bikeId:null});
  await a.R.init(); await a.R.reconcile();
  server.offline = true; a.S.deleteRide('r6');
  await a.R.reconcile();
  assert.equal(a.S.getRides().length, 0);
  server.offline = false; await a.R.reconcile();
  assert.equal(server.rows['rider-a:r6'], undefined);
  assert.equal(a.S.getRides().length, 0);
});
test('deleting a ride that never synced does not queue a cloud delete', async () => {
  const server = {rows:{}, offline:true}, a = device(server);
  a.S.saveRide({id:'r7', date:'2026-09-13', distance:4, duration:300, bikeId:null});
  a.S.deleteRide('r7');
  assert.equal(a.S.get(a.S.KEYS.RIDES_DELETED, []).length, 0);
});
test('two riders with the same ride id both keep their ride', async () => {
  const server = {rows:{}}, a = device(server), b = device(server, 'rider-b');
  a.S.saveRide({id:'same', date:'2026-09-12', distance:11, duration:600, bikeId:null});
  b.S.saveRide({id:'same', date:'2026-09-12', distance:22, duration:900, bikeId:null});
  await a.R.init(); await b.R.init();
  assert.equal(server.rows['rider-a:same'].distance_miles, 11);
  assert.equal(server.rows['rider-b:same'].distance_miles, 22);
});test('duration is stored in seconds (app keeps minutes) and comes back as minutes', async () => {
  const server = {rows:{}}, a = device(server);
  a.S.saveRide({id:'r8', date:'2026-09-11', distance:9.5, duration:25, bikeId:null});
  await a.R.init();
  assert.equal(server.rows['rider-a:r8'].duration_seconds, 1500);
  const b = device(server); await b.R.init();
  assert.equal(b.S.getRides()[0].duration, 25);
});
test('a ride the table would reject does not block other rides from syncing', async () => {
  const server = {rows:{}}, a = device(server);
  a.S.saveRide({id:'old', date:'2026-08-15', distance:88.7, duration:'2h 10m', bikeId:null});
  a.S.saveRide({id:'bad', date:'', distance:5, duration:10, bikeId:null});
  a.S.saveRide({id:'r9', date:'2026-09-10', distance:3, duration:5, bikeId:null});
  await a.R.init();
  assert.ok(server.rows['rider-a:r9']);
  assert.equal(server.rows['rider-a:bad'], undefined);
  assert.equal(server.rows['rider-a:old'].duration_seconds, null);
});
test('rides pulled from the account refresh the on-screen ride list', async () => {
  const server = {rows:{}}, a = device(server);
  a.S.saveRide({id:'r10', date:'2026-09-09', distance:7, duration:20, bikeId:null});
  await a.R.init();
  const b = device(server); await b.R.init();
  assert.equal(b.S.getRides().length, 1);
  assert.ok(b.A.rideRenders >= 1);
});
