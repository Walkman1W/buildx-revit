import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexClient} from './lib/codex-client.mjs';
import {CodexClientCore} from './lib/codex-client-core.mjs';
import {createReadonlyWorkbenchSessionProfile,MODEL_READONLY_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {READONLY_WORKBENCH_TOOL_NAMES,WORKBENCH_TOOLS} from './lib/workbench-client.mjs';
import {createPanelServer} from './lib/panel-server.mjs';
import path from 'node:path';

const root=process.cwd(),tick=()=>new Promise(resolve=>setImmediate(resolve));
const whole=()=>({data:[{name:'revit_workbench',runtimeStatus:'connected',authStatus:'unsupported',
  tools:Object.fromEntries(READONLY_WORKBENCH_TOOL_NAMES.map(name=>[name,structuredClone(WORKBENCH_TOOLS.find(tool=>tool.name===name))])),
  resources:[],resourceTemplates:[],toolsError:null},
  {name:'revit_local',runtimeStatus:'disabled',authStatus:'unknown',tools:{},resources:[],resourceTemplates:[],toolsError:null}],nextCursor:null});

function fixture(t){
  const settings={holdFull:false,mutate:null},children=[],diagnostics=[];let client,threads=0;
  const spawn=()=>{
    const child=new EventEmitter();child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    child.stdin.writable=true;child.messages=[];child.fullPending=[];
    child.reply=(message,result)=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:message.id,result})+'\n'));
    child.notice=method=>child.stdout.emit('data',Buffer.from(JSON.stringify({method,params:{}})+'\n'));
    child.stdin.write=(line,callback)=>{
      const message=JSON.parse(line);child.messages.push(message);queueMicrotask(()=>{
        callback?.();if(message.id===undefined)return;
        let result={};
        if(message.method==='account/read')result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:null,planType:'free'}};
        if(message.method==='thread/start'){
          if(settings.failThread){child.stdout.emit('data',Buffer.from(JSON.stringify({id:message.id,error:{code:-32000,message:'controlled thread creation failure'}})+'\n'));return;}
          result={thread:{id:settings.invalidThread?null:'readonly-thread-'+(++threads)}};
        }
        if(message.method==='mcpServerStatus/list'){
          result=whole();
          if(message.params.detail!=='full'&&settings.namedState)result.data[0].runtimeStatus=settings.namedState;
          if(message.params.detail==='full'){
            settings.mutate?.(result);
            if(settings.holdFull){child.fullPending.push({message,result});return;}
          }
        }
        if(message.method==='turn/start')result={turn:{id:'fixture-turn'}};
        child.reply(message,result);
      });return true;
    };
    child.confirmClose=()=>{if(child.closed)return;child.closed=true;child.emit('exit',0,null);child.emit('close',0,null);};
    child.stdin.end=()=>queueMicrotask(child.confirmClose);child.kill=()=>{throw new Error('No fake resource needs kill');};
    children.push(child);return child;
  };
  client=new CodexClient(root,{profile:MODEL_READONLY_SESSION_PROFILE},{spawn,
    resolveRuntimes:()=>({codex:'fixture-codex',python:'fixture-python'}),readConfiguredNames:()=>['revit_local','other'],closeTimeoutMs:10,killTimeoutMs:10});
  client.on('diagnostic',value=>diagnostics.push(value));
  t.after(async()=>{for(const child of children)child.confirmClose();await client.close();});
  return {client,settings,children,diagnostics,get child(){return children.at(-1);}};
}
async function pendingFull(f){for(let i=0;i<50;i++){if(f.child?.fullPending.length)return f.child.fullPending.shift();await tick();}throw new Error('Expected the controlled full-catalog request');}
const fullRequests=f=>f.children.flatMap(child=>child.messages).filter(message=>message.method==='mcpServerStatus/list'&&message.params.detail==='full');

test('readonly native turn sends exact text plus localImage under the original RPC and account owner',async t=>{
  const f=fixture(t);await f.client.start();const thread=await f.client.newThread(),image={type:'localImage',path:path.resolve('owned-test.attachment')};
  await f.client.turn(thread,'本轮已冻结的正文',[image]);
  const sent=f.child.messages.filter(message=>message.method==='turn/start');assert.equal(sent.length,1);assert.deepEqual(sent[0].params,{threadId:thread,input:[{type:'text',text:'本轮已冻结的正文'},image]});
  await assert.rejects(f.client.turn(thread,'too much\n'+'\u0001'.repeat(44000)),{code:'CODEX_TURN_INPUT_INVALID',notSent:true});
  assert.equal(f.child.messages.filter(message=>message.method==='turn/start').length,1);assert.equal(f.client.state.ready,true);
});

test('production named readonly client withholds readiness until its complete unfiltered catalog is proven',async t=>{
  const f=fixture(t);f.settings.holdFull=true;const started=f.client.start(),pending=await pendingFull(f);
  assert.equal(f.client.profile.id,'model-readonly');assert.equal(f.client.state.ready,false);assert.equal(f.client.state.toolCount,0);
  assert.equal(f.diagnostics.some(value=>value.code==='readonly_workbench_tools_verified'),false);
  await assert.rejects(f.client.turn('blocked','must not run'),{code:'CODEX_ACCOUNT_NOT_READY'});
  assert.deepEqual(pending.message.params,{threadId:'readonly-thread-1',detail:'full',limit:100});
  f.child.reply(pending.message,pending.result);await started;
  assert.equal(f.client.state.ready,true);assert.equal(f.client.state.toolCount,4);
  assert.equal(f.diagnostics.filter(value=>value.code==='readonly_workbench_tools_verified').length,1);
  assert.equal(f.child.messages.some(value=>value.method==='turn/start'),false);
});

for(const [label,mutate] of [
  ['paged',value=>value.nextCursor='more'],
  ['extra active server',value=>value.data[1].runtimeStatus='connected'],
  ['resource surface',value=>value.data[0].resources.push({uri:'fixture:///resource'})],
  ['schema drift',value=>value.data[0].tools.revit_get_selection.inputSchema.additionalProperties=true],
  ['write hint',value=>value.data[0].tools.revit_list_levels.annotations.readOnlyHint=false],
])test('production readiness rejects '+label+' after the named catalog was ready',async t=>{
  const f=fixture(t);f.settings.mutate=mutate;
  await assert.rejects(f.client.start(),{code:'CODEX_TOOL_CATALOG_UNVERIFIED'});
  assert.equal(fullRequests(f).length,1);assert.equal(f.client.state.ready,false);assert.equal(f.client.toolsReady,false);assert.equal(f.client.preparedThread,null);
  assert.equal(f.diagnostics.some(value=>value.code==='readonly_workbench_tools_verified'),false);
  await assert.rejects(f.client.turn('blocked','must not run'),{code:'CODEX_CONNECTION_CHANGED'});
  assert.equal(f.child.messages.some(value=>value.method==='turn/start'),false);
});

test('every new thread repeats the full proof and an invalid proof revokes same-owner prior readiness',async t=>{
  const f=fixture(t);await f.client.start();assert.equal(await f.client.newThread(),'readonly-thread-1');
  assert.equal(await f.client.newThread(),'readonly-thread-2');assert.equal(fullRequests(f).length,2);
  assert.equal(f.client.state.ready,true);f.settings.mutate=value=>value.nextCursor='partial';
  await assert.rejects(f.client.newThread(),{code:'CODEX_TOOL_CATALOG_UNVERIFIED'});
  assert.equal(fullRequests(f).length,3);assert.equal(f.client.initialized,false);assert.equal(f.client.authReady,false);
  assert.equal(f.client.toolsReady,false);assert.equal(f.client.preparedThread,null);assert.equal(f.client.state.ready,false);
});

for(const state of ['failed','connecting'])test('named catalog '+state+' revokes prior readonly readiness before a full proof',async t=>{
  const f=fixture(t);await f.client.start();await f.client.newThread();f.settings.namedState=state;
  f.client._pause=async c=>f.client._assert(c); // Controlled readiness clock, no native retries.
  await assert.rejects(f.client.newThread(),{code:'CODEX_TOOL_CATALOG_UNVERIFIED'});
  assert.equal(fullRequests(f).length,1);assert.equal(f.client.state.ready,false);assert.equal(f.client.preparedThread,null);
  assert.equal(f.client.initialized,false);assert.equal(f.client.authReady,false);assert.equal(f.client.toolsReady,false);
  await assert.rejects(f.client.turn('old-thread','blocked'),{code:'CODEX_ACCOUNT_NOT_READY'});
  assert.equal(f.child.messages.filter(value=>value.method==='thread/start').length,2);
});

for(const field of ['failThread','invalidThread'])test('new-thread '+field+' shares the readonly admission revocation owner',async t=>{
  const f=fixture(t);await f.client.start();await f.client.newThread();f.settings[field]=true;
  await assert.rejects(f.client.newThread(),{code:'CODEX_TOOL_CATALOG_UNVERIFIED'});
  assert.equal(f.client.state.ready,false);assert.equal(f.client.toolsReady,false);assert.equal(f.client.preparedThread,null);
  assert.equal(fullRequests(f).length,1);assert.equal(f.child.messages.filter(value=>value.method==='thread/start').length,2);
});

test('readonly connection proof is written through the existing panel audit owner',async t=>{
  const f=fixture(t),audits=[];
  const app=createPanelServer({root,profile:MODEL_READONLY_SESSION_PROFILE,codex:f.client,port:0,
    invokeWorkbench:async()=>{throw new Error('No Revit read is selected in this controlled test');},audit:(file,value)=>audits.push({file,value})});
  t.after(()=>app.close());const address=await app.listen();await app.connect();
  const status=await fetch(address.origin+'/api/status').then(value=>value.json());
  assert.equal(status.ready,true);assert.equal(status.toolCount,4);assert.equal(status.toolCatalog.length,4);
  const proof=audits.find(value=>value.file==='connection-status.json'&&value.value.code==='readonly_workbench_tools_verified');
  assert.equal(proof?.value.count,4);
  assert.ok(audits.some(value=>value.file==='connection-status.json'&&value.value.code==='readonly_workbench_tool_catalog'));
});

test('a full proof crossed by account invalidation keeps the original account fault and cannot publish readiness',async t=>{
  const f=fixture(t);await f.client.start();await f.client.newThread();f.settings.holdFull=true;
  const prepared=f.client.newThread(),rejected=assert.rejects(prepared,{code:'CODEX_ACCOUNT_REVISION_CHANGED'}),pending=await pendingFull(f);
  f.child.notice('account/updated');const revision=f.client.state.codexAccount.accountRevision;
  f.child.reply(pending.message,pending.result);await rejected;
  assert.equal(f.client.state.codexAccount.accountRevision,revision);assert.equal(f.client.state.codexAccount.status,'invalidated');
  assert.equal(f.client.initialized,true);assert.equal(f.client.state.ready,false);assert.equal(f.client.preparedThread,null);
  assert.equal(f.diagnostics.filter(value=>value.code==='readonly_workbench_tools_verified').length,1);
});

test('late full proof data after close cannot revoke or ready a replacement connection',async t=>{
  const f=fixture(t);await f.client.start();await f.client.newThread();f.settings.holdFull=true;
  const preparing=f.client.newThread(),rejected=assert.rejects(preparing,{code:'CODEX_CONNECTION_CHANGED'}),pending=await pendingFull(f),old=f.child;
  await f.client.close();await rejected;f.settings.holdFull=false;await f.client.start();
  const generation=f.client.state.connectionGeneration,current=f.child;pending.result.nextCursor='bad';old.reply(pending.message,pending.result);await tick();
  assert.equal(f.client.child,current);assert.equal(f.client.state.connectionGeneration,generation);assert.equal(f.client.state.ready,true);
  assert.equal(f.client.state.toolCount,4);assert.equal(f.diagnostics.filter(value=>value.code==='readonly_workbench_tools_verified').length,2);
});

test('the optional catalog verifier is a trusted callable, not browser data or an accessor',()=>{
  const profile=createReadonlyWorkbenchSessionProfile(root);
  for(const value of [false,{},'verify'])assert.throws(()=>new CodexClientCore(root,Object.freeze({...profile,verifyWholeCatalog:value})),/冻结/);
  let reads=0;const accessor=Object.freeze({...profile,get verifyWholeCatalog(){reads++;return ()=>({ok:true});}});
  assert.throws(()=>new CodexClientCore(root,accessor),/冻结/);assert.equal(reads,0);
});
