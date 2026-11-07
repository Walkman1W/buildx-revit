import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from './lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {CodexClient} from './lib/codex-client.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
test('the actual Codex client accepts the terminal-enabled trusted profile',()=>{
  const codex=new CodexClient(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE,modelTerminal:true});
  assert.ok(codex.profile.dynamicTools.some(tool=>tool.name==='buildx_terminal_run'));
  assert.ok(codex.profile.familyLifecycleDynamicTools.some(tool=>tool.name==='buildx_terminal_run'));
});
const requestId='01234567-89ab-4cde-8fab-0123456789ab';
const wait=async predicate=>{
  const limit=Date.now()+3500;
  while(!predicate()){
    if(Date.now()>limit)throw new Error('fixture timed out');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
};

class CodexFixture extends EventEmitter{
  constructor(){
    super();
    this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE,modelTerminal:true});
    this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};
    this.answers=new Map();
  }
  async newThread(){return 'thread';}
  async turn(){return {turn:{id:'turn'}};}
  async close(){return {closed:true};}
  request(id,tool,args){
    const params=Object.freeze({threadId:'thread',turnId:'turn',callId:'call-'+id,tool,arguments:Object.freeze(args)});
    this.emit('dynamic-tool-request',{id,generation:1,revision:2,params,
      respond:value=>{this.answers.set(id,value);return true;},
      reject:()=>this.answers.set(id,'rejected'),discard:()=>{}});
  }
  terminal(id){
    this.request(id,'buildx_terminal_run',{interpreter:'python',script:'print("中文 CSV")',timeout_ms:2000});
  }
}

async function fixture(t,{mode='full-access',available=true,invoke}={}){
  const codex=new CodexFixture(),modelCalls=[],terminalCalls=[],stopCalls=[];
  const document={session:'fixture-host',path:'C:\\项目\\fixture.rvt',title:'测试模型'};
  const control=Object.freeze({id:'test-policy',revision:1,mode,accountScope:'model:research-local'});
  const policy=Object.freeze({...control,roots:mode==='project-write'?[{path:'C:\\项目'}]:[]});
  const accessServices=Object.freeze({
    tools:[],view:()=>policy,control:()=>control,
    activate:async()=>({ok:true,value:policy}),
    current:(_scope,observed)=>observed?.id===policy.id&&observed?.revision===policy.revision&&observed?.mode===mode,
    authorize:async(_scope,file,{write})=>({ok:mode!=='read-only'&&file===document.path&&write===true}),
    select:async()=>{throw new Error('unexpected policy change');},
    invoke:async()=>{throw new Error('unexpected generic file call');},
    deactivate:async()=>({closed:true}),close:async()=>({closed:true}),
  });
  let entry;
  const owns=(scope,id=requestId)=>entry&&id===entry.record.requestId&&scope.account===entry.scope.account&&scope.conversationId===entry.scope.conversationId;
  const update=fields=>{Object.assign(entry.record,fields);entry.onUpdate({...entry.record});};
  const complete=fields=>{update(fields);entry.resolve({...entry.record});};
  const modelTerminal=Object.freeze({
    async start(options){
      const {scope,args,callId,isCurrent,onUpdate}=options;
      assert.equal(isCurrent(),true);
      terminalCalls.push({scope,args,callId});
      let resolve;
      const done=new Promise(finish=>{resolve=finish;});
      const record={requestId,cwd:'C:\\隔离 工作目录',...args,status:'running',stdout:'中文 CSV',stderr:'',stdoutTruncated:false,stderrTruncated:false,exitCode:null,exitConfirmed:false};
      entry={scope,onUpdate,record,resolve};onUpdate({...record});
      return {requestId,done};
    },
    latest:scope=>owns(scope)?{...entry.record}:null,
    restoreLatest:async scope=>owns(scope)?{...entry.record}:null,
    inspect:async(scope,id)=>owns(scope,id)?{...entry.record}:null,
    stop(scope,id){
      if(!owns(scope,id))return null;
      stopCalls.push(id);
      if(entry.record.status==='running')update({status:'stop_requested',stopReason:'cancelled'});
      return {...entry.record};
    },
    async close(){
      if(entry&&!entry.record.exitConfirmed)complete({status:'exited',exitConfirmed:true,exitCode:1,outcome:'cancelled'});
      return {closed:true};
    },
  });
  const modelPermissionServices=Object.freeze({
    observeDocument:async()=>({...document}),
    readCommand:async()=>{throw new Error('unexpected command read');},
    inspectFamilyJob:async()=>{throw new Error('unexpected family read');},
    invoke:async(...args)=>{modelCalls.push(args);return invoke?invoke(...args):{ok:true,value:{done:true}};},
  });
  const app=createPanelServer({root,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,accessServices,modelPermissionServices,modelTerminal,
    modelReceiptPollDelays:[30000],terminalAvailability:{available,...available?{}:{reason:'解释器不可用'}},
    invokeWorkbench:async()=>{throw new Error('unexpected Revit read');}});
  const {origin}=await app.listen(),{csrf}=await(await fetch(origin+'/api/status')).json();
  t.after(()=>app.close());
  const snapshot=(client='browser')=>app.snapshot(client);
  const post=async(route,data={},client='browser',headers={})=>{
    const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':csrf,Origin:origin,...headers},body:JSON.stringify({client,...data})});
    return {status:response.status,body:await response.json()};
  };
  const conversationId=snapshot().session.conversation.id;
  const choose=level=>post('model-permission',{conversationId,level,expectedRevision:snapshot().modelPermission.revision??0});
  const toggle=(enabled=true,headers)=>post('terminal/enable',{conversationId,enabled},'browser',headers);
  const turn=()=>post('turn',{message:'请在终端测试 CSV。'});
  return {app,codex,origin,post,choose,toggle,turn,snapshot,conversationId,terminalCalls,modelCalls,stopCalls,complete};
}

const answer=(f,id)=>JSON.parse(f.codex.answers.get(id).contentItems[0].text);

test('terminal rejects read-only, project-write, confirmation-only and unavailable scopes at HTTP and dispatch',async t=>{
  for(const scenario of [
    {mode:'read-only',level:'automatic',chooseStatus:409},
    {mode:'project-write',level:'automatic',chooseStatus:200},
    {mode:'full-access',level:'confirm',chooseStatus:200},
    {mode:'full-access',level:'automatic',chooseStatus:200,available:false},
  ]){
    const f=await fixture(t,scenario);
    assert.equal((await f.choose(scenario.level)).status,scenario.chooseStatus,scenario.mode+' '+scenario.level);
    assert.equal(f.snapshot().terminal.eligible,false);
    assert.equal((await f.toggle()).status,409);
    assert.equal((await f.turn()).status,202);
    f.codex.terminal(1);await wait(()=>f.codex.answers.has(1));
    assert.equal(f.codex.answers.get(1).success,false);
    assert.equal(answer(f,1).code,'TERMINAL_DISABLED');
    assert.equal(f.snapshot().dynamicApproval,null);
    assert.equal(f.terminalCalls.length,0);
  }
});

test('trusted terminal uses one explicit switch and scopes stop and status to the original request',async t=>{
  const f=await fixture(t),id=f.conversationId;
  assert.equal((await f.choose('automatic')).status,200);
  assert.equal(f.snapshot().terminal.eligible,true);
  assert.equal(f.snapshot().terminal.enabled,false);
  assert.equal((await f.toggle(true,{Origin:'https://example.test'})).status,403);
  assert.equal((await f.toggle(true,{'X-Local-Chat':'incorrect'})).status,403);
  assert.equal((await f.post('terminal/run',{conversationId:id,interpreter:'python',script:'print(1)'})).status,404);
  assert.equal((await f.toggle()).body.terminal.enabled,true);
  assert.equal((await f.turn()).status,202);
  f.codex.terminal(1);await wait(()=>f.terminalCalls.length===1);
  assert.deepEqual(f.terminalCalls[0].args,{interpreter:'python',script:'print("中文 CSV")',timeout_ms:2000});
  assert.equal(f.snapshot().dynamicApproval,null);
  assert.equal(f.modelCalls.length,0);
  const controller=new AbortController();
  try{
    const response=await fetch(f.origin+'/api/events?client=browser',{signal:controller.signal});
    const reader=response.body.getReader();
    const first=new TextDecoder().decode((await reader.read()).value);
    assert.match(first,/event: snapshot/);assert.match(first,new RegExp(requestId));assert.match(first,/中文 CSV/);
  }finally{controller.abort();}
  const other=f.snapshot('other').session.conversation.id,original={conversationId:id,requestId};
  assert.equal((await f.post('terminal/cancel',original,'other')).status,409);
  assert.equal((await f.post('terminal/status',{...original,conversationId:other},'other')).status,404);
  assert.equal((await f.post('terminal/cancel',{...original,requestId:'12345678-1234-4234-8234-123456789123'})).status,404);
  assert.equal(f.stopCalls.length,0);
  const stopped=await f.post('terminal/cancel',original);
  assert.equal(stopped.status,200);
  assert.equal(stopped.body.terminal.job.status,'stop_requested');
  assert.equal(stopped.body.terminal.job.exitConfirmed,false);
  assert.equal(f.codex.answers.has(1),false);
  f.complete({status:'exited',outcome:'cancelled',exitCode:1,exitConfirmed:true});
  await wait(()=>f.codex.answers.has(1));
  const checked=await f.post('terminal/status',original);
  assert.equal(checked.body.terminal.job.status,'exited');
  assert.equal(checked.body.terminal.job.exitCode,1);
  assert.equal(answer(f,1).requestId,requestId);
  assert.equal(answer(f,1).exitConfirmed,true);
  assert.equal(Object.hasOwn(answer(f,1),'script'),false);
  assert.equal(f.terminalCalls.length,1);
});

test('automatic model permission alone does not grant terminal authority',async t=>{
  const f=await fixture(t);
  assert.equal((await f.choose('automatic')).status,200);
  assert.equal((await f.turn()).status,202);
  f.codex.terminal(1);await wait(()=>f.codex.answers.has(1));
  assert.equal(answer(f,1).code,'TERMINAL_DISABLED');
  assert.equal(f.terminalCalls.length,0);
});

test('an enabled terminal keeps specialist approval and original model receipt recovery in the Revit owner',async t=>{
  let checks=0;
  const receiptOwner={
    inspect:async()=>({ok:true,value:{status:'received',terminal:true,requestId:'original-revit',checkedAt:String(++checks)}}),
    close:async()=>({ok:true,value:{closed:true}}),
  };
  const f=await fixture(t,{invoke:async()=>({ok:false,error:{outcome:'unconfirmed'},receiptOwner})});
  assert.equal((await f.choose('automatic')).status,200);
  assert.equal((await f.toggle()).status,200);
  assert.equal((await f.turn()).status,202);
  f.codex.request(1,'buildx_model_operation',{tool:'revit_smart_annotate',parameters:{mode:'rollback',element_ids:[1],view_id:2,tag_type_id:3}});
  const preview=f.snapshot().dynamicApproval;
  assert.equal(preview.kind,'model');
  assert.equal(preview.action,'revit_smart_annotate');
  assert.match(preview.source,/事务外副作用/);
  assert.equal(f.modelCalls.length,0);
  assert.equal((await f.post('dynamic-approval',{conversationId:f.conversationId,requestId:preview.id,digest:preview.digest,decision:'decline'})).status,200);
  f.codex.request(2,'buildx_model_operation',{tool:'revit_move_elements',parameters:{mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}}});
  await wait(()=>Boolean(f.snapshot().modelReceipt));
  const modelReceipt=f.snapshot().modelReceipt;
  assert.equal(f.modelCalls.length,1);
  assert.equal(f.snapshot().terminal.eligible,false);
  f.codex.terminal(3);await wait(()=>f.codex.answers.has(3));
  assert.equal(answer(f,3).code,'TERMINAL_DISABLED');
  assert.equal(f.terminalCalls.length,0);
  const original={conversationId:f.conversationId,ticket:modelReceipt.ticket};
  assert.equal((await f.post('model-receipt/check',original)).status,200);
  const checked=f.snapshot().modelReceipt;
  assert.equal(checked.check.requestId,'original-revit');
  assert.equal((await f.post('model-receipt/acknowledge',{...original,checkRevision:checked.checkRevision,confirmed:true})).status,200);
  assert.equal(f.snapshot().modelReceipt,null);
  assert.equal(f.modelCalls.length,1);
});
