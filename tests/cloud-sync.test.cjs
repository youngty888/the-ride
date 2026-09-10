const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const clone = x => JSON.parse(JSON.stringify(x));
function device(server, id = 'rider-a', local = new Map()) {
  const session = new Map([['sicc-ride-auth-session', JSON.stringify({user:{id},access_token:'test'})]]);
  const ls = {getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)};
  const ctx = vm.createContext({console, setTimeout:()=>0,clearTimeout(){},confirm:()=>true,
    window:{localStorage:ls,addEventListener(){}}, sessionStorage:{getItem:k=>session.get(k)},
    RideAuth:{session:async()=>({user:{id},access_token:'test'})},
    document:{getElementById:()=>null},App:{renderProfile(){},renderGarage(){},renderEmergencyContacts(){},updateTotalMiles(){}}});
  vm.runInContext(source('storage.js')+'\n'+source('cloud-sync.js')+'\nthis.S=Storage;this.C=RiderCloud;',ctx);
  const C=ctx.C,S=ctx.S;
  C.status=(text)=>{C.lastStatus=text};
  C.request=async(p,o)=>{
    if(server.offline) throw new Error('Offline');
    if(!o) return server.rows[id] ? [clone(server.rows[id])] : [];
    const b=JSON.parse(o.body), old=server.rows[id];
    if((old?.revision||0)!==b.expected_revision) return [];
    const row={payload:b.new_payload,revision:(old?.revision||0)+1};
    server.rows[id]=clone(row);
    if(server.onWrite) await server.onWrite();
    if(server.loseResponse){server.loseResponse=false;throw new Error('Response lost');}
    return [clone(row)];
  };
  return {C,S,local,session};
}
test('complete records restore on a clean second device',async()=>{
  const server={rows:{}}, a=device(server); await a.C.init();
  a.S.saveProfile({...a.S.getProfile(),name:'Test Rider',profilePic:'data:image/png;base64,abc',emergencyContacts:[{name:'Test'}]});
  a.S.saveBike({id:'legacy-bike',make:'Test',serviceRecords:[{notes:'Keep this note'}]});
  await a.C.reconcile();
  const b=device(server);await b.C.init();
  assert.equal(b.S.getProfile().name,'Test Rider');
  assert.equal(b.S.getProfile().profilePic,'data:image/png;base64,abc');
  assert.equal(b.S.getBikes()[0].serviceRecords[0].notes,'Keep this note');
  const other=device(server,'rider-b');await other.C.init();assert.equal(other.S.getBikes().length,0);
});
test('legacy data requires explicit review',async()=>{
  const server={rows:{}}, a=device(server);a.S.saveProfile({name:'Old sample or real rider'});
  await a.C.init();assert.equal(a.C.phase,'import');assert.equal(server.rows['rider-a'],undefined);
  await a.C.importLocal();assert.equal(server.rows['rider-a'].payload.profile.name,'Old sample or real rider');
});
test('offline edits survive reload and retry',async()=>{
  const server={rows:{}},a=device(server);await a.C.init();server.offline=true;
  a.S.saveProfile({...a.S.getProfile(),name:'Offline edit'});await a.C.reconcile();assert.equal(a.C.meta.dirty,true);
  const b=device(server,'rider-a',a.local);await b.C.init();assert.equal(b.S.getProfile().name,'Offline edit');
  server.offline=false;await b.C.reconcile();assert.equal(server.rows['rider-a'].payload.profile.name,'Offline edit');
});
test('conflicts preserve both copies and deletions restore',async()=>{
  const server={rows:{}},a=device(server);await a.C.init();a.S.saveBike({id:'one'});await a.C.reconcile();
  const b=device(server);await b.C.init();
  a.S.saveProfile({...a.S.getProfile(),name:'First device'});await a.C.reconcile();
  b.S.saveProfile({...b.S.getProfile(),name:'Second device'});await b.C.reconcile();
  assert.equal(b.C.phase,'conflict');assert.equal(server.rows['rider-a'].payload.profile.name,'First device');
  await b.C.useCloud();assert.equal(b.S.getProfile().name,'First device');
  assert.equal(b.S.get('rideflow_cloud_conflict_backup').profile.name,'Second device');
  b.S.deleteBike('one');await b.C.reconcile();await a.C.reconcile();assert.equal(a.S.getBikes().length,0);
});
test('lost success response does not duplicate write',async()=>{
  const server={rows:{}},a=device(server);await a.C.init();a.S.saveProfile({name:'Retain'});
  server.loseResponse=true;await a.C.reconcile();assert.equal(a.C.meta.dirty,true);
  await a.C.reconcile();assert.equal(a.C.meta.dirty,false);assert.equal(server.rows['rider-a'].revision,1);
});
test('edits during upload remain pending',async()=>{
  const server={rows:{}},a=device(server);await a.C.init();a.S.saveProfile({name:'First'});
  server.onWrite=()=>{server.onWrite=null;a.S.saveProfile({name:'Latest'});};
  await a.C.reconcile();assert.equal(a.C.meta.dirty,true);
  await a.C.reconcile();assert.equal(server.rows['rider-a'].payload.profile.name,'Latest');
});
test('account switch aborts pending work',async()=>{
  const server={rows:{}},a=device(server);await a.C.init();a.S.saveProfile({name:'A'});
  a.session.set('sicc-ride-auth-session',JSON.stringify({user:{id:'rider-b'}}));
  await a.C.reconcile();assert.deepEqual(server.rows,{});
});
