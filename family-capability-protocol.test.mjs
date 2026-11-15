import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexClientCore} from './lib/codex-client-core.mjs';

const A='a'.repeat(32),B='b'.repeat(32);
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
function tool(names){return freeze({type:'function',name:'buildx_model_operation',description:'fixture',inputSchema:{type:'object',properties:{tool:{type:'string',enum:names},parameters:{type:'object'}},required:['tool','parameters'],additionalProperties:false}});}
function profile(){
  const toolNames=Object.freeze(['fixture_read']),group=Object.freeze({name:'fixture_group',toolNames,statusTimeout:1000,failFast:true});
  return Object.freeze({id:'model-workspace',service:'fixture-codex',mode:'document-workbench',toolNames,groups:Object.freeze([group]),clientInfo:Object.freeze({name:'fixture',version:'1'}),buildLaunchArgs:()=>[],buildInstructions:()=>'',connectingTools:'checking',catalogFailed:'failed',catalogNotReady:'not ready',verifiedDiagnostic:'verified',denialMessage:'denied',dynamicTools:Object.freeze([tool(['revit_move_elements'])]),familyLifecycleDynamicTools:Object.freeze([tool(['revit_move_elements','revit_family_save_job','revit_family_close_job'])])});
}
function fixture(observe){
  const messages=[];let count=0;
  const spawn=()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;
    // A real stdio child keeps the loop alive while the production capability
    // deadline is unref'ed. Model that lifetime, bounded even if cleanup fails.
    const childLifetime=setTimeout(()=>{},10000);
    child.stdin.write=(line,callback)=>{const request=JSON.parse(line);messages.push(request);queueMicrotask(()=>{
      callback?.();if(!request.method||request.id===undefined)return;
      const result=request.method==='account/read'?{requiresOpenaiAuth:true,account:{type:'chatgpt',email:null,planType:'free'}}:request.method==='thread/start'?{thread:{id:'thread-'+ ++count}}:request.method==='mcpServerStatus/list'?{data:[{name:'fixture_group',runtimeStatus:'connected',tools:{fixture_read:{}}}]}:{};
      child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,result})+'\n'));
    });return true;};
    child.stdin.end=()=>queueMicrotask(()=>{clearTimeout(childLifetime);child.emit('exit',0,null);child.emit('close',0,null);});child.kill=()=>true;return child;
  };
  const dependencies={spawn,resolveRuntimes:()=>({codex:'fake',python:'fake'}),readConfiguredNames:()=>[],closeTimeoutMs:20,killTimeoutMs:20};
  if(observe)dependencies.familyCapabilityOwner=Object.freeze({observe});
  const client=new CodexClientCore(process.cwd(),profile(),dependencies),calls=[];
  client.on('dynamic-tool-request',value=>calls.push(value));
  const invoke=(thread,id,tool)=>client.dispatch({id,method:'item/tool/call',params:{threadId:thread,turnId:'turn',callId:'call-'+id,tool:'buildx_model_operation',arguments:{tool,parameters:{}}}});
  const threads=()=>messages.filter(value=>value.method==='thread/start');
  return {client,messages,calls,invoke,threads};
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,10));
const names=thread=>thread.params.dynamicTools[0].inputSchema.properties.tool.enum;

test('old, absent or unverified host advertises base schema and rejects injected family operations',async t=>{
  for(const observe of [undefined,async()=>null,async()=>{throw new Error('offline');},async()=>({hostSession:A,version:0})]){
    const f=fixture(observe);t.after(()=>f.client.close());await f.client.start();const id=await f.client.newThread();
    assert.deepEqual(names(f.threads().at(-1)),['revit_move_elements']);f.invoke(id,1,'revit_family_save_job');await wait();assert.equal(f.calls.length,0);assert.equal(f.messages.at(-1).error.code,-32600);
  }
});

test('a verified host grants only its thread the two lifecycle operations and is rechecked for each request',async t=>{
  let host=A;const f=fixture(async()=>({hostSession:host,version:1}));t.after(()=>f.client.close());await f.client.start();const id=await f.client.newThread();
  assert.deepEqual(names(f.threads().at(-1)),['revit_move_elements','revit_family_save_job','revit_family_close_job']);
  f.invoke(id,1,'revit_family_save_job');await wait();assert.equal(f.calls.length,1);assert.equal(f.calls[0].respond({contentItems:[],success:true}),true);
  host=B;f.invoke(id,2,'revit_family_close_job');await wait();assert.equal(f.calls.length,1);assert.equal(f.messages.at(-1).error.code,-32600);
});

test('a precreated thread is discarded when the observed host or capability changes',async t=>{
  let host=A;const f=fixture(async()=>host?{hostSession:host,version:1}:null);t.after(()=>f.client.close());await f.client.start();host=null;
  const id=await f.client.newThread();assert.equal(id,'thread-2');assert.deepEqual(names(f.threads().at(-1)),['revit_move_elements']);
  f.invoke('thread-1',1,'revit_family_close_job');await wait();assert.equal(f.calls.length,0);assert.equal(f.messages.at(-1).error.code,-32600);
  host=B;const next=await f.client.newThread();assert.equal(next,'thread-3');assert.ok(names(f.threads().at(-1)).includes('revit_family_close_job'));
});

test('a delayed capability read does not block startup indefinitely or launch duplicate observations',async t=>{
  let reads=0,resolve;const f=fixture(()=>{reads++;return reads===1?new Promise(done=>{resolve=done;}):Promise.resolve({hostSession:A,version:1});});t.after(()=>f.client.close());
  const started=Date.now();await f.client.start();assert.ok(Date.now()-started<3500);assert.deepEqual(names(f.threads().at(-1)),['revit_move_elements']);
  const id=await f.client.newThread();assert.equal(id,'thread-1');assert.equal(reads,1);resolve({hostSession:A,version:1});await wait();
  const next=await f.client.newThread();assert.equal(next,'thread-2');assert.equal(reads,2);assert.ok(names(f.threads().at(-1)).includes('revit_family_save_job'));
});

test('late capability observations cannot deliver a request after account invalidation or turn resolution',async t=>{
  let pending=false,resolve;const f=fixture(()=>pending?new Promise(done=>{resolve=done;}):Promise.resolve({hostSession:A,version:1}));t.after(()=>f.client.close());
  await f.client.start();const id=await f.client.newThread();pending=true;
  f.invoke(id,7,'revit_family_save_job');await wait();f.client.dispatch({method:'serverRequest/resolved',params:{threadId:id,requestId:7}});resolve({hostSession:A,version:1});await wait();assert.equal(f.calls.length,0);
  f.invoke(id,8,'revit_family_close_job');await wait();f.client.dispatch({method:'account/updated',params:{}});resolve({hostSession:A,version:1});await wait();assert.equal(f.calls.length,0);
});

test('malformed capability values degrade without invoking getters or preventing startup',async t=>{
  let invoked=0;const value={version:1};Object.defineProperty(value,'hostSession',{enumerable:true,get(){invoked++;return A;}});
  const f=fixture(async()=>value);t.after(()=>f.client.close());await f.client.start();assert.equal(invoked,0);assert.deepEqual(names(f.threads().at(-1)),['revit_move_elements']);
});
