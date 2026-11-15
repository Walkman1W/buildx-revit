import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexClientCore} from '../lib/codex-client-core.mjs';
import {createApiProviderLaunch,ISOLATED_API_FIXTURE_KEY} from '../lib/api-provider-launch.mjs';

// A fake RPC peer only. No user credentials, network, Revit, or real Codex.
const fakeKey=ISOLATED_API_FIXTURE_KEY;
function fixture(options={}){
  const toolNames=Object.freeze(['fixture_read']);
  const group=Object.freeze({name:'fixture',toolNames,statusTimeout:1000,failFast:true});
  const profile=Object.freeze({id:'model-workspace',service:'fixture-codex',mode:'document-workbench',toolNames,
    groups:Object.freeze([group]),clientInfo:Object.freeze({name:'fixture',version:'1'}),buildLaunchArgs:()=>['app-server'],
    buildInstructions:()=>'fixture',connectingTools:'checking',catalogFailed:'failed',catalogNotReady:'not ready',
    verifiedDiagnostic:'verified',denialMessage:'denied',verifyWholeCatalog:result=>({ok:result?.data?.[0]?.name==='fixture'})});
  const provider=createApiProviderLaunch({baseUrl:'http://127.0.0.1:23119/v1',model:'example-model',apiKey:fakeKey,allowLoopbackHttp:true});
  const providerId=provider.describe().identity.providerId;
  const children=[],diagnostics=[];let launch,client;
  const spawn=(executable,args,env)=>{
    launch={executable,args,env};const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.messages=[];child.stdin.writable=true;
    child.stdin.write=(line,cb)=>{
      const message=JSON.parse(line);child.messages.push(message);
      queueMicrotask(()=>{cb?.();if(message.id===undefined||!message.method)return;
        if(message.method==='thread/start'&&options.deferThread){child.deferredThreadId=message.id;return;}
        let result={};
        if(message.method==='thread/start')result={thread:{id:'fixture-thread'},model:options.model??'example-model',modelProvider:options.provider??providerId};
        if(message.method==='mcpServerStatus/list')result={data:[{name:'fixture',runtimeStatus:'connected',tools:{fixture_read:{}}}]};
        if(message.method==='turn/start')result={turn:{id:'fixture-turn'}};
        child.stdout.emit('data',Buffer.from(JSON.stringify({id:message.id,result})+'\n'));
      });return true;
    };
    child.stdin.end=()=>queueMicrotask(()=>{child.emit('exit',0,null);child.emit('close',0,null);});child.kill=()=>true;children.push(child);return child;
  };
  client=new CodexClientCore(process.cwd(),profile,{spawn,apiProvider:provider,resolveRuntimes:()=>({codex:process.execPath,python:'fake'}),
    readConfiguredNames:()=>[],closeTimeoutMs:10,killTimeoutMs:10});
  client.on('diagnostic',value=>diagnostics.push(value));
  return {client,children,diagnostics,providerId,get launch(){return launch;}};
}

test('API provider selection verifies local thread identity but never claims model availability',async t=>{
  const f=fixture();t.after(()=>f.client.close());await Promise.all([f.client.start(),f.client.start()]);
  assert.equal(f.children.length,1);assert.equal(f.client.state.ready,true);
  assert.equal(f.client.state.codexAccount.type,'api_key');assert.equal(f.client.state.codexAccount.model,'example-model');
  assert.equal(f.client.state.codexAccount.modelAvailability,'unverified');
  assert.equal(f.children[0].messages.some(x=>x.method==='account/read'),false);
  assert.equal(f.children[0].messages.some(x=>x.method==='mcpServerStatus/list'),true);
  assert.equal(JSON.stringify(f.launch.args).includes(fakeKey),false);
  const envSetting=f.launch.args.find(value=>value.startsWith(`model_providers.${f.providerId}.env_key=`));
  const envName=JSON.parse(envSetting.split('=')[1]);
  assert.match(envName,/^BUILDX_API_[a-f0-9]{32}$/);
  assert.equal(f.launch.env.env[envName],fakeKey);
  assert.equal(JSON.stringify([f.client.state,f.diagnostics,f.children[0].messages]).includes(fakeKey),false);
  const before=f.client.state.codexAccount.observationSequence;
  const observed=await f.client.refreshAccount();assert.equal(observed.type,'api_key');assert.equal(observed.modelAvailability,'unverified');
  assert.ok(observed.observationSequence>before);assert.equal(f.children[0].messages.some(x=>x.method==='account/read'),false);
});

for(const options of [{provider:'other-provider'},{model:'other-model'}])test('unverified runtime provider or model fails closed with its own reason',async t=>{
  const f=fixture(options);t.after(()=>f.client.close());await assert.rejects(f.client.start(),{code:'CODEX_PROVIDER_UNVERIFIED'});
  assert.equal(f.client.state.ready,false);assert.equal(f.client.toolsReady,false);
  assert.match(f.client.state.message,/所选 API 服务与模型/);
  assert.equal(f.children[0].messages.some(x=>x.method==='mcpServerStatus/list'),false);
});

test('account notifications invalidate local connection and cannot reuse the one-shot key',async()=>{
  const f=fixture();await f.client.start();f.client.dispatch({method:'account/updated',params:{}});
  assert.equal(f.client.state.ready,false);await assert.rejects(f.client.refreshAccount());
  await f.client.close();await assert.rejects(f.client.start());assert.equal(f.children.length,1);
});

test('close before start discards the one-shot provider; mutable or accessor owners are rejected',async()=>{
  const f=fixture();await f.client.close();await assert.rejects(f.client.start());assert.equal(f.children.length,0);
  const profile=f.client.profile;
  const unsafe={describe(){},start(){},dispose(){}};
  assert.throws(()=>new CodexClientCore(process.cwd(),profile,{apiProvider:unsafe}),/冻结/);
  let reads=0;const deps={};Object.defineProperty(deps,'apiProvider',{get(){reads++;return unsafe;}});
  assert.throws(()=>new CodexClientCore(process.cwd(),profile,deps));assert.equal(reads,0);
});

test('closing during a pending API thread handshake discards late results and never reuses the key',async()=>{
  const f=fixture({deferThread:true});
  const starting=f.client.start();
  const outcome=starting.then(()=>null,error=>error);
  for(let i=0;i<100&&!f.children[0]?.deferredThreadId;i++)await new Promise(resolve=>setImmediate(resolve));
  const child=f.children[0];assert.ok(child.deferredThreadId);
  assert.equal((await f.client.close()).closed,true);
  const failure=await outcome;assert.ok(failure);assert.equal(f.client.state.ready,false);
  child.stdout.emit('data',Buffer.from(JSON.stringify({id:child.deferredThreadId,result:{thread:{id:'late'},model:'example-model',modelProvider:f.providerId}})+'\n'));
  assert.equal(f.client.state.ready,false);
  assert.equal(child.messages.some(x=>x.method==='mcpServerStatus/list'),false);
  await assert.rejects(f.client.start());assert.equal(f.children.length,1);
});
