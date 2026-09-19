const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function setup(){
  const list={innerHTML:'',querySelector:()=>({addEventListener(){}})};
  const ctx=vm.createContext({console,document:{addEventListener(){},getElementById:()=>list},MapModule:{currentLocation:{lat:32,lon:-110}},Geo:{}});
  for(const name of ['poi.js','app.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',name),'utf8'),ctx);
  vm.runInContext('this.A=App;this.P=PoiModule;',ctx);
  ctx.P.display=(_,rows)=>{list.innerHTML=rows[0]?.name||'empty';};ctx.P.showMarkers=()=>{};
  return {ctx,list,A:ctx.A,P:ctx.P};
}
test('denied location stops after one attempt and offers manual retry',async()=>{
 const {ctx,list,A}=setup();let attempts=0;
 ctx.MapModule.currentLocation=null;
 ctx.MapModule.requestOneFix=cb=>{attempts++;if(attempts>1)throw new Error('Repeated location request');cb(null);};
 await A.loadStops();assert.equal(attempts,1);assert.match(list.innerHTML,/Retry location/);
});
test('slow gas results cannot replace a newer food selection',async()=>{
 const {A,P,list}=setup();let finishGas;
 P.searchNearby=cat=>cat==='fuel'?new Promise(r=>finishGas=r):Promise.resolve([{name:'Food result'}]);
 const gas=A.loadStops();A.currentStopType='fast_food';await A.loadStops();
 finishGas([{name:'Old gas result'}]);await gas;assert.equal(list.innerHTML,'Food result');
});
test('service timeout remark triggers fallback instead of false no-results',async()=>{
 const {ctx,P}=setup();let calls=0;
 ctx.Geo.fetchTimeout=async()=>({ok:true,json:async()=>++calls===1?{remark:'runtime error: timeout',elements:[]}:{elements:[{id:1}]}});
 const result=await P.overpass('test');assert.equal(calls,2);assert.equal(result[0].id,1);
});
