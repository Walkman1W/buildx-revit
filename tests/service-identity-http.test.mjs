import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from '../lib/panel-server.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
class FixtureCodex extends EventEmitter{
  state={service:'revit-local-codex',ready:false,error:false,message:'fixture status '+ 'x'.repeat(16384)};
  async close(){return {closed:true};}
  async newThread(){return 'identity-test-thread';}
  async turn(){return {turn:{id:'identity-test-turn'}};}
  async interrupt(){}
}
async function setup(t,options={}){
  const codex=new FixtureCodex();
  const app=createPanelServer({root,codex,port:0,invokeWorkbench:async()=>{throw new Error('unexpected model read');},...options});
  const {origin}=await app.listen();
  t.after(()=>app.close());
  const get=(headers={})=>fetch(origin+'/api/service-identity',{headers});
  return {app,codex,origin,get};
}

test('native identity stays compact when full status exceeds the launcher buffer and Codex is not ready',async t=>{
  const f=await setup(t),status=await fetch(f.origin+'/api/status'),full=await status.text();
  assert.ok(Buffer.byteLength(full)>8192);
  assert.equal(JSON.parse(full).ready,false);
  const response=await f.get(),text=await response.text();
  assert.equal(response.status,200);
  assert.deepEqual(JSON.parse(text),{service:'revit-local-codex',installationId:null});
  assert.ok(Buffer.byteLength(text)<128);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.match(response.headers.get('content-type'),/^application\/json/);
  assert.equal(response.headers.get('set-cookie'),null);
});

test('installed identity is available without login and never reads account or Codex state',async t=>{
  const calls=[];
  const accountAuth=Object.fromEntries(['signIn','signUp','verifySession','refresh','signOut','release'].map(name=>[name,()=>{calls.push(name);throw new Error('unexpected account read');}]));
  accountAuth.close=async()=>({ok:true,value:{closed:true}});
  const installationId='aa159a01-0b21-4da8-95ab-8f2488a24ffe';
  const f=await setup(t,{installationId,accountAuth,requireAccount:true});
  const state=f.codex.state;
  Object.defineProperty(f.codex,'state',{configurable:true,get(){throw new Error('identity must not inspect Codex readiness');}});
  try{
    const response=await f.get({Cookie:'buildx_model_session=unrelated-fixture-cookie'});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{service:'revit-local-codex',installationId});
    assert.deepEqual(calls,[]);
  }finally{Object.defineProperty(f.codex,'state',{configurable:true,writable:true,value:state});}
});

test('busy conversation does not change the service identity or expose operational state',async t=>{
  const f=await setup(t);f.codex.state={...f.codex.state,ready:true,message:'ready'};
  const status=await(await fetch(f.origin+'/api/status')).json();
  const accepted=await fetch(f.origin+'/api/turn',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json','X-Local-Chat':status.csrf},body:JSON.stringify({client:'identity-test',message:'hold this fixture turn'})});
  assert.equal(accepted.status,202);
  assert.equal((await(await fetch(f.origin+'/api/status')).json()).busy,true);
  const response=await f.get();
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{service:'revit-local-codex',installationId:null});
  f.codex.emit('notification','turn/completed',{threadId:'identity-test-thread',turnId:'identity-test-turn',turn:{id:'identity-test-turn',status:'completed'}});
});

test('identity accepts native and local origins, but rejects foreign origins and host rebinding',async t=>{
  const f=await setup(t);
  for(const Origin of [f.origin,f.origin.replace('127.0.0.1','localhost')])assert.equal((await f.get({Origin})).status,200);
  const foreign=await f.get({Origin:'https://example.invalid'});
  assert.equal(foreign.status,403);
  assert.deepEqual(await foreign.json(),{error:'请求来源不匹配'});
  const rebound=await new Promise((resolve,reject)=>{
    const req=http.get(f.origin+'/api/service-identity',{headers:{Host:'example.invalid'}},res=>{
      let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body}));
    });req.on('error',reject);
  });
  assert.equal(rebound.status,403);
  assert.deepEqual(JSON.parse(rebound.body),{error:'本地地址不匹配'});
});
