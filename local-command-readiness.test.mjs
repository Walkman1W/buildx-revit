import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createPanelServerCore} from './lib/panel-server-core.mjs';
import {panelProfile} from './lib/panel-profile.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const commands=Object.freeze([
  Object.freeze({id:'document',tool:'revit_workbench_status',label:'模型概况',readOnly:true,enabled:true}),
  Object.freeze({id:'write-sample',tool:'revit_move_elements',label:'移动',readOnly:false,enabled:true}),
  Object.freeze({id:'external',tool:'revit_health',label:'外部桥接',readOnly:true,enabled:false,unavailableReason:'桥接未配置'}),
]);
async function fixture(t,invoke){
  const codex=new EventEmitter();codex.state={mode:'document-workbench',ready:false,error:true,toolCount:0,message:'AI disconnected'};
  codex.close=async()=>({closed:true});codex.start=async()=>{};
  const selection=Object.freeze({...panelProfile('model'),commands,commandReadiness:'local'});
  const calls=[];
  const app=createPanelServerCore({root,codex,selection,port:0,invokeWorkbench:async()=>{},invokeReadonlyCommand:async(id,parameters,control)=>{
    calls.push({id,parameters,control});if(invoke)await invoke(control);
    return {ok:true,value:{command:id,tool:commands.find(command=>command.id===id).tool,operation:'status',requestIds:[],data:{checked:true}}};
  }});
  const {origin}=await app.listen();t.after(()=>app.close());
  const state=await fetch(origin+'/api/status').then(response=>response.json());
  const client='independent-command-test',conversationId=app.snapshot(client).session.conversation.id;
  const post=(id,extra={})=>fetch(origin+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':state.csrf},body:JSON.stringify({client,conversationId,commandId:id,parameters:{},...extra})});
  return {app,codex,origin,state,post,calls,client};
}
const idle=async f=>{for(let count=0;count<100;count++){if(!f.app.snapshot(f.client).busy)return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Fixture did not settle');};

test('local commands and catalog remain available while the chat model is disconnected',async t=>{
  const f=await fixture(t);
  assert.equal(f.state.ready,false);assert.equal(f.state.commandsReady,true);
  assert.equal(f.state.commandCatalogAvailable,true);assert.equal(Object.hasOwn(f.state,'commandCatalog'),false);
  assert.ok(Buffer.byteLength(JSON.stringify(f.state),'utf8')<8192,'native service probes remain below their 8 KiB buffer');
  const catalog=await fetch(f.origin+'/api/command-catalog').then(response=>response.json());
  assert.deepEqual(catalog.commands,commands);
  assert.equal((await f.post('document')).status,202);await idle(f);
  assert.equal(f.calls.length,1);assert.equal(f.app.snapshot(f.client).command.status,'completed');
});

test('catalog registration never bypasses unavailable prerequisites or explicit write confirmation',async t=>{
  const f=await fixture(t);
  assert.equal((await f.post('external')).status,409);
  assert.equal((await f.post('write-sample')).status,403);
  assert.equal((await f.post('write-sample',{confirmed:'true'})).status,400);
  assert.equal(f.calls.length,0);
  assert.equal((await f.post('write-sample',{confirmed:true})).status,202);await idle(f);
  assert.equal(f.calls[0].control.confirmed,true);assert.deepEqual(f.calls[0].parameters,{});
});

test('an AI failure does not retire an already accepted independent command',async t=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,async control=>{await held;assert.equal(control.shouldContinue(),true);});
  assert.equal((await f.post('document')).status,202);
  f.codex.emit('state',f.codex.state);release();await idle(f);
  assert.equal(f.app.snapshot(f.client).command.status,'completed');assert.equal(f.calls.length,1);
});
