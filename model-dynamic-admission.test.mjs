import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from './lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {sanitizePanelAudit} from './lib/panel-audit.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const wait=async predicate=>{const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw new Error('fixture timeout');await new Promise(resolve=>setTimeout(resolve,5));}};
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
class FixtureCodex extends EventEmitter{
  profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});
  state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};
  answers=[];
  async newThread(){return 'thread';}async turn(){return {turn:{id:'turn'}};}async interrupt(){}async close(){return {closed:true};}
  request(id,args,tool='buildx_model_operation'){
    const params=Object.freeze({threadId:'thread',turnId:'turn',callId:'call-'+id,tool,arguments:Object.freeze(args)});
    this.emit('dynamic-tool-request',{id,params,generation:1,revision:2,respond:value=>{this.answers.push(value);return true;},reject:()=>{},discard:()=>{}});
  }
}
async function fixture(t,{observeBarrier=null,verifyBarrier=null,invokeBarrier=null,invokeResult={ok:true,value:{done:true}}}={}){
  const codex=new FixtureCodex(),invocations=[],audits=[];let observations=0;
  let document={session:'host',path:'C:\\test.rvt',title:'Test'};
  const services=Object.freeze({observeDocument:async()=>{observations++;if(observeBarrier)await observeBarrier;if(observations>1&&verifyBarrier)await verifyBarrier;return {...document};},readCommand:async()=>{},inspectFamilyJob:async()=>{},invoke:async(...args)=>{invocations.push(args);if(invokeBarrier)await invokeBarrier;return invokeResult;}});
  const app=createPanelServer({root,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,modelPermissionServices:services,invokeWorkbench:async()=>{throw new Error('Unexpected read');},audit:(file,data)=>{const row=sanitizePanelAudit(file,data);if(row?.kind==='dynamic_model')audits.push(row);}});
  const {origin}=await app.listen();t.after(()=>app.close());
  const state=await(await fetch(origin+'/api/status')).json(),session=app.snapshot('browser').session.conversation.id;
  const post=async(route,data={})=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Chat':state.csrf},body:JSON.stringify({client:'browser',...data})});return {status:response.status,body:await response.json()};};
  const choose=level=>post('model-permission',{conversationId:session,level,expectedRevision:app.snapshot('browser').modelPermission.revision});
  const begin=()=>post('turn',{message:'Create an element in this fixture only'});
  const answer=async count=>{await wait(()=>codex.answers.length===count);return JSON.parse(codex.answers.at(-1).contentItems[0].text);};
  return {app,codex,audits,invocations,origin,post,session,choose,begin,answer,observations:()=>observations,changeDocument:()=>{document={...document,path:'C:\\other.rvt'};}};
}

test('slow permission verification is an owned Revit check, not an AI turn',async t=>{
  let release;const barrier=new Promise(resolve=>{release=resolve;});t.after(()=>release());const f=await fixture(t,{observeBarrier:barrier});
  const pending=f.choose('confirm');await wait(()=>f.observations()===1);
  const state=await(await fetch(f.origin+'/api/status')).json();
  assert.equal(state.busy,true);assert.equal(state.busyOperation,'model-permission-check');assert.match(state.message,/Revit.*核实/);
  assert.match(f.app.snapshot('browser').activity,/Revit.*核实/);assert.equal(f.invocations.length,0);
  release();assert.equal((await pending).status,200);
  assert.equal((await(await fetch(f.origin+'/api/status')).json()).busyOperation,null);
});

test('named schema discovery needs no model grant or native observation',async t=>{
  const f=await fixture(t);await f.begin();
  f.codex.request(1,{tool:'revit_create_wall'},'buildx_model_operation_schema');
  const result=await f.answer(1);assert.equal(result.ok,true);assert.equal(result.value.tool,'revit_create_wall');
  assert.ok(result.value.inputSchema.required.includes('height_mm'));assert.equal(f.observations(),0);assert.equal(f.invocations.length,0);
  f.codex.request(2,{tool:'revit_create_wall',mode:'commit'},'buildx_model_operation_schema');assert.equal((await f.answer(2)).ok,false);
  assert.equal(f.observations(),0);
});

test('outer contract errors are not reported as permission errors or used to observe a model',async t=>{
  const f=await fixture(t);await f.begin();
  const malformed=[{tool:'revit_move_elements',parameters:'private-json-text'},{tool:'revit_move_elements',parameters:[]},{tool:'revit_move_elements',parameters:{},extra:'private-value'},{tool:'revit_move_elements'}];
  for(const [index,args] of malformed.entries()){
    f.codex.request(index+1,args);const result=await f.answer(index+1);
    assert.equal(result.error.code,'MODEL_OPERATION_ARGUMENTS_INVALID');assert.equal(result.error.outcome,'not_started');
  }
  assert.equal(f.observations(),0);assert.equal(f.invocations.length,0);
  assert.deepEqual(f.audits.filter(row=>row.phase==='rejected').map(row=>row.parametersType),['string','array','object','undefined']);
  assert.ok(f.audits.every(row=>row.hasCurrentGrant===false));
  assert.equal(JSON.stringify(f.audits).includes('private-'),false);
});

test('a valid call with no grant has its own stable rejection code',async t=>{
  const f=await fixture(t);await f.begin();f.codex.request(1,{tool:'revit_move_elements',parameters:{mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}}});
  assert.equal((await f.answer(1)).error.code,'MODEL_PERMISSION_MISSING');
  assert.equal(f.invocations.length,0);assert.equal(f.audits.at(-1).stage,'binding');assert.equal(f.audits.at(-1).hasCurrentGrant,false);
});

test('a malformed call never consumes a current grant and a corrected new call can execute once',async t=>{
  const f=await fixture(t);await f.choose('automatic');await f.begin();const observed=f.observations();
  f.codex.request(1,{tool:'revit_move_elements',parameters:{element_ids:[1]},mode:'commit'});
  assert.equal((await f.answer(1)).error.code,'MODEL_OPERATION_ARGUMENTS_INVALID');
  assert.equal(f.observations(),observed);assert.equal(f.invocations.length,0);assert.equal(f.audits.at(-1).hasCurrentGrant,true);
  f.codex.request(2,{tool:'revit_move_elements',parameters:{mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}}});
  assert.equal((await f.answer(2)).status,'completed');assert.equal(f.invocations.length,1);assert.equal(f.invocations[0][1].mode,'commit');
});

test('unsupported tools, transaction modes and document mismatches retain separate producer reasons',async t=>{
  const f=await fixture(t);await f.choose('automatic');await f.begin();
  const cases=[
    [{tool:'revit_fixture_unavailable_operation',parameters:{mode:'commit'}},'MODEL_OPERATION_UNSUPPORTED'],
    [{tool:'revit_move_elements',parameters:{mode:'apply',element_ids:[1],delta_mm:{x:1,y:0,z:0}}},'MODEL_TRANSACTION_MODE_INVALID'],
    [{tool:'revit_move_elements',parameters:{expected_document:'C:\\other.rvt',mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}}},'MODEL_DOCUMENT_MISMATCH'],
    [{tool:'revit_execute_csharp',parameters:{code:42}},'MODEL_SCRIPT_PARAMETERS_INVALID'],
  ];
  for(const [index,[args,code]] of cases.entries()){f.codex.request(index+1,args);assert.equal((await f.answer(index+1)).error.code,code);assert.equal(f.audits.at(-1).hasCurrentGrant,true);}
  assert.equal(f.invocations.length,0);
  assert.equal(f.app.snapshot('browser').modelPermission.level,'automatic');
});

test('empty or aliased wall parameters fail before model revalidation or dispatch and return their exact schema',async t=>{
  const f=await fixture(t);await f.choose('confirm');await f.begin();const observed=f.observations();
  for(const [index,parameters] of [{},{wall_type_id:1,level_id:2,start_point:[0,0,0],height:3000}].entries()){
    f.codex.request(index+1,{tool:'revit_create_wall',parameters});const result=await f.answer(index+1);
    assert.equal(result.error.code,'MODEL_OPERATION_PARAMETERS_INVALID');assert.equal(result.error.details.tool,'revit_create_wall');
    assert.ok(result.error.details.inputSchema.required.includes('height_mm'));assert.match(result.error.details.field,/^arguments\./);
  }
  assert.equal(f.observations(),observed);assert.equal(f.invocations.length,0);assert.equal(f.app.snapshot('browser').dynamicApproval,null);
  assert.equal(f.audits.some(row=>['verifying','dispatching','awaiting_approval'].includes(row.phase)),false);
});

test('confirmation traces admission, waiting, verification and real dispatch without retaining argument values',async t=>{
  const f=await fixture(t);await f.choose('confirm');await f.begin();
  const code='return "private-script-value";';
  f.codex.request(1,{tool:'revit_execute_csharp',parameters:{mode:'commit',code}});
  const approval=f.app.snapshot('browser').dynamicApproval;
  assert.ok(approval);assert.equal(f.invocations.length,0);
  assert.deepEqual(f.audits.map(row=>row.phase),['received','awaiting_approval']);
  assert.equal((await f.post('dynamic-approval',{conversationId:f.session,requestId:approval.id,digest:approval.digest,decision:'accept'})).status,200);
  await f.answer(1);
  assert.deepEqual(f.audits.map(row=>row.phase),['received','awaiting_approval','verifying','dispatching','completed']);
  assert.equal(f.audits.at(-1).outcome,'completed');assert.equal(f.invocations.length,1);assert.equal(f.invocations[0][1].code,code);
  assert.equal(JSON.stringify(f.audits).includes('private-script-value'),false);
  assert.deepEqual(f.audits[0].argumentKeys,['tool','parameters']);assert.deepEqual(f.audits[0].parameterKeys,['mode','code']);
  assert.ok(f.audits.every(row=>row.threadId==='thread'&&row.callId==='call-1'&&row.elapsedMs>=0));
});

test('document changes during approval finish as not started and never emit a dispatch event',async t=>{
  const f=await fixture(t);await f.choose('confirm');await f.begin();
  f.codex.request(1,{tool:'revit_move_elements',parameters:{mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}}});
  const approval=f.app.snapshot('browser').dynamicApproval;f.changeDocument();
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),3000);t.after(()=>{clearTimeout(timeout);controller.abort();});
  const stream=await fetch(f.origin+'/api/events?client=browser',{signal:controller.signal}),reader=stream.body.getReader();await reader.read();
  await f.post('dynamic-approval',{conversationId:f.session,requestId:approval.id,digest:approval.digest,decision:'accept'});
  const result=await f.answer(1);assert.equal(result.status,'not_started');assert.equal(result.code,'MODEL_DOCUMENT_REVALIDATION_FAILED');
  assert.equal(f.invocations.length,0);assert.equal(f.audits.some(row=>row.phase==='dispatching'),false);assert.equal(f.audits.at(-1).outcome,'not_started');
  const final=f.app.snapshot('browser');assert.equal(final.modelPermission.level,null);
  assert.deepEqual(final.dynamicApprovalResult,{requestId:approval.id,digest:approval.digest,conversationId:f.session,status:'not_started',code:'MODEL_DOCUMENT_REVALIDATION_FAILED'});
  let wire='';while(!wire.includes('MODEL_DOCUMENT_REVALIDATION_FAILED')){const part=await reader.read();assert.equal(part.done,false);wire+=new TextDecoder().decode(part.value);}
  assert.match(wire,/"dynamicApprovalResult":\{"requestId":/);clearTimeout(timeout);controller.abort();
  assert.equal(f.app.snapshot('other').dynamicApprovalResult,null);
  f.codex.emit('notification','turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed'}});
  assert.equal(f.app.snapshot('browser').busy,false);assert.deepEqual(f.app.snapshot('browser').dynamicApprovalResult,final.dynamicApprovalResult);
  f.codex.state={...f.codex.state,connectionGeneration:2};assert.equal(f.app.snapshot('browser').dynamicApprovalResult,null);
});

const move={mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}};
const accept=(f,p)=>f.post('dynamic-approval',{conversationId:f.session,requestId:p.id,digest:p.digest,decision:'accept'});
test('an unaccepted model proposal expires as structured not started without a native observation',async t=>{
  t.after(()=>t.mock.timers.reset());const f=await fixture(t);await f.choose('confirm');await f.begin();const observed=f.observations();
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  f.codex.request(1,{tool:'revit_move_elements',parameters:move});const p=f.app.snapshot('browser').dynamicApproval;
  t.mock.timers.tick(p.deadline-Date.now()+1);await flush();t.mock.timers.reset();
  const result=await f.answer(1);assert.equal(result.ok,false);assert.equal(result.error.code,'MODEL_APPROVAL_EXPIRED');
  assert.equal(result.error.outcome,'not_started');assert.equal(result.error.stage,'approval');
  assert.equal(f.observations(),observed);assert.equal(f.invocations.length,0);
  assert.equal(f.app.snapshot('browser').dynamicApproval,null);assert.equal(f.app.snapshot('browser').modelReceipt,null);
  assert.equal(f.app.snapshot('browser').dynamicApprovalResult.status,'not_started');assert.equal(f.app.snapshot('browser').dynamicApprovalResult.code,'MODEL_APPROVAL_EXPIRED');
  assert.equal(f.app.snapshot('browser').modelPermission.level,'confirm');
  assert.deepEqual(f.audits.map(row=>row.phase),['received','awaiting_approval','rejected']);
  assert.equal(f.audits.at(-1).stage,'approval');assert.equal(f.audits.at(-1).code,'MODEL_APPROVAL_EXPIRED');assert.equal(f.audits.at(-1).outcome,'not_started');
  assert.equal((await accept(f,p)).status,409);assert.equal(f.invocations.length,0);
});

test('an HTTP decision arriving after the deadline uses the same expiry owner before a delayed timer runs',async t=>{
  t.after(()=>t.mock.timers.reset());const f=await fixture(t);await f.choose('confirm');await f.begin();const observed=f.observations();
  // Advance only Date: the real proposal timer has not fired yet.
  t.mock.timers.enable({apis:['Date'],now:Date.now()});f.codex.request(1,{tool:'revit_move_elements',parameters:move});
  const p=f.app.snapshot('browser').dynamicApproval;t.mock.timers.tick(p.deadline-Date.now()+1);
  const response=await accept(f,p);t.mock.timers.reset();assert.equal(response.status,409);assert.equal(response.body.code,'MODEL_APPROVAL_EXPIRED');
  const result=await f.answer(1);assert.equal(result.error.outcome,'not_started');assert.equal(result.error.stage,'approval');
  assert.equal(f.observations(),observed);assert.equal(f.invocations.length,0);assert.equal(f.app.snapshot('browser').modelReceipt,null);
  assert.equal(f.audits.some(row=>['verifying','dispatching'].includes(row.phase)),false);
});

test('an accepted proposal waiting in verification cannot be relabelled as an unaccepted approval expiry',async t=>{
  let release;const barrier=new Promise(resolve=>{release=resolve;});t.after(()=>{release();t.mock.timers.reset();});
  const f=await fixture(t,{verifyBarrier:barrier});await f.choose('confirm');await f.begin();
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});f.codex.request(1,{tool:'revit_move_elements',parameters:move});
  const p=f.app.snapshot('browser').dynamicApproval;assert.equal((await accept(f,p)).status,200);await flush();assert.equal(f.observations(),2);
  t.mock.timers.tick(p.deadline-Date.now()+1);await flush();assert.equal(f.codex.answers.length,0);
  assert.equal(f.audits.some(row=>row.code==='MODEL_APPROVAL_EXPIRED'),false);assert.equal(f.invocations.length,0);
  release();await flush();t.mock.timers.reset();const result=await f.answer(1);
  assert.equal(result.code,'MODEL_DOCUMENT_REVALIDATION_FAILED');assert.equal(result.status,'not_started');
});

test('dispatch uncertainty after an accepted decision retains its original receipt beyond the approval deadline',async t=>{
  let release,closes=0;const barrier=new Promise(resolve=>{release=resolve;});t.after(()=>{release();t.mock.timers.reset();});
  const receipt=Object.freeze({inspect:async()=>({ok:true,value:{status:'received',terminal:true,requestId:'original'}}),close:async()=>{closes++;return {ok:true,value:{closed:true}};}});
  const f=await fixture(t,{invokeBarrier:barrier,invokeResult:{ok:false,error:{outcome:'unconfirmed'},receiptOwner:receipt}});await f.choose('confirm');await f.begin();
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});f.codex.request(1,{tool:'revit_move_elements',parameters:move});
  const p=f.app.snapshot('browser').dynamicApproval;assert.equal((await accept(f,p)).status,200);await flush();assert.equal(f.invocations.length,1);
  t.mock.timers.tick(p.deadline-Date.now()+1);await flush();assert.equal(f.codex.answers.length,0);assert.equal(f.audits.some(row=>row.code==='MODEL_APPROVAL_EXPIRED'),false);
  release();await flush();t.mock.timers.reset();assert.equal((await f.answer(1)).status,'unconfirmed');
  const original=f.app.snapshot('browser').modelReceipt;assert.ok(original);assert.equal(closes,0);
  assert.equal((await f.post('new-chat')).status,409);assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:original.ticket})).status,200);
  const checked=f.app.snapshot('browser').modelReceipt;assert.equal(checked.check.requestId,'original');
  assert.equal((await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket:original.ticket,checkRevision:checked.checkRevision,confirmed:true})).status,200);
  assert.equal(closes,1);assert.equal(f.app.snapshot('browser').modelReceipt,null);
});
