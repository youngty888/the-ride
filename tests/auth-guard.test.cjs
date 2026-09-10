const {test}=require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../auth-guard.js'),'utf8');
test('expired session refreshes once and verifies identity before initialization',async()=>{
 const token=exp=>'e30.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.x';
 let current=JSON.stringify({access_token:token(1),refresh_token:'fake',user:{id:'a'}}),refreshes=0;
 const ctx=vm.createContext({Date,JSON,atob,AbortSignal,sessionStorage:{getItem:()=>current,setItem:(k,v)=>current=v},
 window:{SICC_RIDE_SUPABASE:{url:'https://example.test',anonKey:'fake'}},location:{replace(){throw Error('unexpected redirect')}},
 fetch:async url=>{if(url.includes('refresh_token')){refreshes++;return {ok:true,json:async()=>({access_token:token(Math.floor(Date.now()/1000)+3600),refresh_token:'next',user:{id:'a'}})}}return {ok:true,json:async()=>({id:'a'})}}
 });
 vm.runInContext(code+'\nthis.A=RideAuth;',ctx);const result=await ctx.A.ready;
 assert.equal(result.user.id,'a');assert.equal(refreshes,1);assert.equal(JSON.parse(current).refresh_token,'next');
});
test('failed identity verification never unlocks rider app',async()=>{
 const token='e30.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.x';
 let destination='';
 const ctx=vm.createContext({Date,JSON,atob,AbortSignal,sessionStorage:{getItem:()=>JSON.stringify({access_token:token,user:{id:'a'}})},
 window:{SICC_RIDE_SUPABASE:{url:'https://example.test',anonKey:'fake'}},location:{replace:v=>destination=v},
 fetch:async()=>({ok:false})});
 vm.runInContext(code+'\nthis.A=RideAuth;',ctx);assert.equal(await ctx.A.ready,null);assert.equal(destination,'auth.html');
});
