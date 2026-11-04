import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createInternalApiClient} from './lib/internal-api-client.mjs';
import {ISOLATED_API_FIXTURE_KEY} from './lib/api-provider-launch.mjs';
import {MODEL_AI_READ_TOOLS} from './lib/panel-tools.mjs';

const syntheticKey=ISOLATED_API_FIXTURE_KEY;
const input=()=>({root:process.cwd(),provider:{baseUrl:'http://127.0.0.1:23119/v1',model:'fixture-model',apiKey:syntheticKey,allowLoopbackHttp:true}});
const tools=Object.fromEntries(MODEL_AI_READ_TOOLS.map(item=>[item.name,structuredClone(item)]));
function setup(options={}){
  const children=[],captures=[];
  const spawn=(exe,args,opts)=>{
    const setting=args.find(value=>value.startsWith('model_provider='));
    const providerId=JSON.parse(setting.slice('model_provider='.length));
    captures.push({exe,args,env:opts.env});
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;
    child.stdin.write=(line,callback)=>{const message=JSON.parse(line);queueMicrotask(()=>{
      callback?.();if(message.id===undefined||!message.method)return;
      let result={};
      if(message.method==='thread/start')result={thread:{id:'fixture-thread'},model:options.badModel?'wrong':'fixture-model',modelProvider:providerId};
      if(message.method==='mcpServerStatus/list')result={data:[{name:'revit_workbench',runtimeStatus:'connected',authStatus:'unsupported',resources:[],resourceTemplates:[],tools}]};
      child.stdout.emit('data',Buffer.from(JSON.stringify({id:message.id,result})+'\n'));
    });return true;};
    child.stdin.end=()=>{if(!options.holdClose)queueMicrotask(()=>{child.emit('exit',0,null);child.emit('close',0,null);});};
    child.kill=()=>true;children.push(child);return child;
  };
  const dependencies={spawn,resolveRuntimes:()=>({codex:process.execPath,python:'fake'}),readConfiguredNames:()=>[],closeTimeoutMs:10,killTimeoutMs:10};
  const owner=createInternalApiClient(input(),dependencies);
  // The production profile registers dynamic project tools and requires an
  // explicit request owner. This fixture denies requests; it grants no tool.
  if(!options.withoutDynamicOwner)owner.client.on('dynamic-tool-request',request=>request.reject());
  return {owner,children,captures};
}

test('internal API client without the dynamic tool owner fails closed',async()=>{
  const f=setup({withoutDynamicOwner:true});
  await assert.rejects(f.owner.start(),{code:'INTERNAL_API_START_FAILED'});
  assert.equal(f.owner.client.state.ready,false);assert.equal(f.children.length,1);
  assert.equal((await f.owner.close()).closed,true);
});

test('internal composition fixes Revit workspace and checks catalog before reporting local readiness',async()=>{
  const f=setup(),diagnostics=[];f.owner.client.on('diagnostic',event=>diagnostics.push(event));
  assert.ok(Object.isFrozen(f.owner));assert.equal(f.owner.client.profile.id,'model-workspace');
  assert.equal(f.owner.client.profile.toolNames.length,MODEL_AI_READ_TOOLS.length);
  assert.equal(typeof f.owner.client.profile.verifyWholeCatalog,'function');assert.equal(f.children.length,0);
  assert.deepEqual(await f.owner.start(),{ready:true,modelAvailability:'unverified'});assert.equal(f.children.length,1);
  assert.equal(f.owner.client.state.codexAccount.type,'api_key');
  assert.equal(f.owner.client.state.codexAccount.modelAvailability,'unverified');
  assert.equal(JSON.stringify([f.captures[0].args,f.owner.client.state,diagnostics]).includes(syntheticKey),false);
  assert.equal((await f.owner.close()).closed,true);assert.equal((await f.owner.close()).closed,true);
  await assert.rejects(f.owner.start());
});

test('caller cannot override profile or install a substitute API owner',()=>{
  const original=input();let getterCalls=0;
  assert.throws(()=>createInternalApiClient({...original,profile:'model-readonly'}));
  assert.throws(()=>createInternalApiClient(original,{apiProvider:{}}));
  const deps={};Object.defineProperty(deps,'spawn',{enumerable:true,get(){getterCalls++;return ()=>{};}});
  assert.throws(()=>createInternalApiClient(original,deps));assert.equal(getterCalls,0);
});

test('internal factory cannot be used to launch a remote provider or carry a non-fixture credential',()=>{
  const remote=input();remote.provider.baseUrl='https://provider.example/v1';
  assert.throws(()=>createInternalApiClient(remote),{code:'API_REMOTE_DISABLED'});
  const unknown=input();unknown.provider.apiKey='some-other-credential';
  assert.throws(()=>createInternalApiClient(unknown),{code:'API_FIXTURE_KEY_REQUIRED'});
});

test('close before start discards the transient launch and refuses any later start',async()=>{
  const f=setup();assert.equal((await f.owner.close()).closed,true);await assert.rejects(f.owner.start());assert.equal(f.children.length,0);
});

test('failed provider handshake cleans its child and does not retry or disclose secrets',async()=>{
  const f=setup({badModel:true});let error;
  try{await f.owner.start();}catch(value){error=value;}
  assert.ok(error);assert.equal(error.code,'CODEX_PROVIDER_UNVERIFIED');assert.equal(JSON.stringify(error).includes(syntheticKey),false);
  assert.equal(f.owner.client.state.ready,false);assert.equal(f.children.length,1);
  await assert.rejects(f.owner.start());assert.equal(f.children.length,1);
});

test('failed cleanup retains the child and permits explicit close retry after it exits',async()=>{
  const f=setup({badModel:true,holdClose:true});let error;
  try{await f.owner.start();}catch(value){error=value;}
  assert.equal(error?.code,'CODEX_CLEANUP_UNCONFIRMED');assert.equal(f.children.length,1);
  await assert.rejects(f.owner.close(),{code:'CODEX_CLEANUP_UNCONFIRMED'});
  f.children[0].emit('exit',0,null);f.children[0].emit('close',0,null);
  assert.equal((await f.owner.close()).closed,true);assert.equal(f.children.length,1);
});
