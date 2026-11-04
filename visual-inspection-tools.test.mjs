import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateTool,invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {assertVisualResult} from './lib/visual-inspection-tools.mjs';
import {modelOperationEffect,supportsModelPermissionTool} from './lib/model-operation-effects.mjs';
import {createCreatedElementLedger} from './lib/created-elements.mjs';
import {createModelToolDispatcher} from './lib/model-tool-dispatch.mjs';
import {createModelPermissionOwner} from './lib/model-permission-owner.mjs';
import {createVisualRecoveryOwner} from './lib/visual-inspection-recovery.mjs';

const source={session:'a'.repeat(32),title:'sample',path:'D:\\sample.rvt'};
const scope={account:'fixture-user',conversationId:'fixture-conversation'};
const retained={sourceDocument:source,expectedHostSession:source.session,retainReceiptOwner:true,shouldContinue:()=>true};
async function fixture(t,host={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-visual-tools-'));
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('buildx-visual-tools-'));await fs.rm(root,{recursive:true,force:true});});
  for(const folder of ['inbox','processing','outbox'])await fs.mkdir(path.join(root,'queue',folder),{recursive:true});
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:source.session,pid:process.pid,version:'0.7.0',startedUtc:'2026-11-03T00:00:00Z',visualInspectionVersion:1,...host}));
  return {root,inbox:path.join(root,'queue','inbox')};
}
async function request(f){for(let i=0;i<200;i++){const name=(await fs.readdir(f.inbox)).find(name=>name.endsWith('.json'));if(name)return JSON.parse(await fs.readFile(path.join(f.inbox,name),'utf8'));await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('fixture request deadline');}
function value(f,id,args,operation='inspect_elements'){
  const orientations=args.orientations??['isometric'];
  return {operation,hostSession:source.session,document:{title:source.title,path:source.path},value:{schema_version:1,operation,host_session:source.session,document:{title:source.title,path:source.path},success:true,cleanup_pending:false,outcome:'captured_and_restored',code:'VISUAL_OK',target_ids:args.element_ids??[],context_ids:args.context_element_ids??[],images:operation==='restore_visual_session'?[]:(operation==='capture_view'?['current']:orientations).map(orientation=>({artifact_id:randomUUID(),path:path.join(f.root,'visual-captures',source.session,id,orientation+'.png'),sha256:'b'.repeat(64),bytes:123,width:1280,height:720,view_id:99,view_name:'inspection',orientation,captured_at:'2026-11-03T00:00:00Z'})),restoration:{status:operation==='capture_view'?'unchanged':'restored',session_handle:null,source_view_unchanged:true}}};
}
function envelope(id,result){const stamp=new Date().toISOString();return {id,ok:true,completedUtc:stamp,timing:{schemaVersion:1,requestId:id,hostSession:source.session,schedulerCorrelation:'unmatched',executeEnteredUtc:stamp,claimedUtc:stamp,responsePreparedUtc:stamp,observedUtc:null,raiseReturnedUtc:null,dispatchStartedUtc:stamp,dispatchFinishedUtc:stamp,observedToExecuteMs:null,dispatchMs:0,validationMs:0,hostWorkMs:0,raiseResult:null},result};}

test('visual tools have separate effects, bounded explicit contracts and no transaction mode',()=>{
  const args=validateTool('revit_inspect_elements',{expected_document:source.path,element_ids:[12]});
  assert.equal(args.operation,'inspect_elements');assert.deepEqual(args.args.orientations,['isometric']);assert.equal(args.args.pixel_size,1280);assert.equal(Object.hasOwn(args.args,'mode'),false);
  assert.equal(modelOperationEffect('revit_inspect_elements').kind,'view_capture');assert.equal(supportsModelPermissionTool('revit_capture_view'),true);
  for(const parameters of [{mode:'commit'},{output_path:'D:\\elsewhere.png'},{pixel_size:2049},{orientations:['isometric','isometric']}])assert.throws(()=>validateTool('revit_inspect_elements',{expected_document:source.path,element_ids:[12],...parameters}));
  assert.throws(()=>validateTool('revit_inspect_elements',{expected_document:source.path}));
});

test('native transport requires explicit host capability and rejects unresolved creation IDs before publish',async t=>{
  const f=await fixture(t,{visualInspectionVersion:0});
  await assert.rejects(invokeWorkbench('revit_capture_view',{expected_document:source.path},{root:f.root,timeout:20,...retained}),/未声明/);
  assert.deepEqual(await fs.readdir(f.inbox),[]);
  await assert.rejects(invokeWorkbench('revit_inspect_elements',{expected_document:source.path,source_request_id:randomUUID()},{root:f.root,timeout:20,...retained}),/requires actual/);
});

test('transport verifies complete host/document/image identity and preserves the original owner',async t=>{
  const f=await fixture(t),args={expected_document:source.path,element_ids:[12],context_element_ids:[13],orientations:['isometric','front']};
  const pending=invokeWorkbench('revit_inspect_elements',args,{root:f.root,timeout:2000,...retained});
  const req=await request(f);assert.equal(Object.hasOwn(req.args,'mode'),false);assert.equal(req.operation,'inspect_elements');
  await fs.writeFile(path.join(f.root,'queue','outbox',req.id+'.json'),JSON.stringify(envelope(req.id,value(f,req.id,req.args))));
  const result=await pending;assert.equal(result.value.images.length,2);assert.ok(result.receiptOwner);assert.equal((await result.receiptOwner.inspect()).value.terminal,true);assert.equal((await result.receiptOwner.close()).value.closed,true);
  const invalid=value(f,req.id,req.args);invalid.value.images[0].path=path.join(f.root,'elsewhere.png');assert.throws(()=>assertVisualResult('revit_inspect_elements',invalid,req.args,{hostSession:source.session,requestId:req.id,root:f.root,sourceDocument:source}),/outside/);
  invalid.value.images[0].path=path.join(f.root,'visual-captures',source.session,req.id,'isometric.png');invalid.value.document.title='other';assert.throws(()=>assertVisualResult('revit_inspect_elements',invalid,req.args,{hostSession:source.session,requestId:req.id,root:f.root}),/identity/);
});

test('post-publication cancellation writes one bound marker and waits for original restoration receipt',async t=>{
  const f=await fixture(t);let current=true;
  const pending=invokeWorkbench('revit_inspect_elements',{expected_document:source.path,element_ids:[12]},{root:f.root,timeout:2000,...retained,shouldContinue:()=>current,onTiming:e=>{if(e.phase==='published')current=false;}});
  const req=await request(f),marker=path.join(f.root,'queue','cancel',req.id+'.json');
  for(let i=0;i<100;i++){try{await fs.access(marker);break;}catch{await new Promise(resolve=>setTimeout(resolve,5));}}
  assert.deepEqual(JSON.parse(await fs.readFile(marker,'utf8')),{schema_version:1,request_id:req.id,target_session:source.session});
  const cancelled=value(f,req.id,req.args);cancelled.value.success=false;cancelled.value.outcome='cancelled';cancelled.value.code='VISUAL_CANCELLED';cancelled.value.images=[];
  await fs.writeFile(path.join(f.root,'queue','outbox',req.id+'.json'),JSON.stringify(envelope(req.id,cancelled)));
  const result=await pending;assert.equal(result.value.restoration.status,'restored');assert.equal((await result.receiptOwner.inspect()).value.status,'failed');await result.receiptOwner.close();
});

test('timed-out visual request keeps late receipt ownership and publishes cancellation',async t=>{
  const f=await fixture(t);let failure;
  try{await invokeWorkbench('revit_capture_view',{expected_document:source.path},{root:f.root,timeout:25,...retained});}catch(e){failure=e;}
  const facts=workbenchFailureEvidence(failure);assert.equal(facts.outcome,'unconfirmed');assert.ok(facts.receiptOwner);const req=await request(f);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'queue','cancel',req.id+'.json'),'utf8')).target_session,source.session);
  await fs.writeFile(path.join(f.root,'queue','outbox',req.id+'.json'),JSON.stringify(envelope(req.id,value(f,req.id,req.args,'capture_view'))));
  assert.equal((await facts.receiptOwner.inspect()).value.status,'received');await facts.receiptOwner.close();
});

test('original native receipt inspection restores only its owned pending session and preserves the failure',async t=>{
  const f=await fixture(t),pending=invokeWorkbench('revit_inspect_elements',{expected_document:source.path,element_ids:[12]},{root:f.root,timeout:2000,...retained});
  const req=await request(f),failed=value(f,req.id,req.args);
  failed.value.success=false;failed.value.cleanup_pending=true;failed.value.outcome='cleanup_pending';failed.value.code='VISUAL_RESTORE_PENDING';failed.value.restoration={status:'pending',session_handle:'owned-handle',source_view_unchanged:true};
  await fs.writeFile(path.join(f.root,'queue','outbox',req.id+'.json'),JSON.stringify(envelope(req.id,failed)));
  const result=await pending,checking=result.receiptOwner.inspect();let recoveryRequest;
  for(let i=0;i<200&&!recoveryRequest;i++){
    for(const name of (await fs.readdir(f.inbox)).filter(name=>name.endsWith('.json')&&name!==req.id+'.json')){
      const candidate=JSON.parse(await fs.readFile(path.join(f.inbox,name),'utf8'));if(candidate.operation==='restore_visual_session')recoveryRequest=candidate;
    }
    if(!recoveryRequest)await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.ok(recoveryRequest);assert.equal(recoveryRequest.args.session_handle,'owned-handle');assert.equal(recoveryRequest.targetSession,source.session);assert.equal(recoveryRequest.args.expected_document,source.path);
  await fs.writeFile(path.join(f.root,'queue','outbox',recoveryRequest.id+'.json'),JSON.stringify(envelope(recoveryRequest.id,value(f,recoveryRequest.id,recoveryRequest.args,'restore_visual_session'))));
  const checked=await checking;assert.equal(checked.value.terminal,true);assert.equal(checked.value.status,'failed');assert.equal(checked.value.evidence.recoveryRequestId,recoveryRequest.id);
  assert.equal((await result.receiptOwner.inspect()).value.terminal,true);assert.equal((await fs.readdir(f.inbox)).filter(name=>name.endsWith('.json')).length,2);
  assert.equal((await result.receiptOwner.close()).value.closed,true);
});

test('creation ledger owns producer field interpretation and rejects rollback/foreign scopes',()=>{
  const ledger=createCreatedElementLedger(),id=randomUUID(),result={request_id:id,mode:'commit',committed:true,document:source.title,value:{created_ids:[23]}};
  assert.equal(ledger.record('revit_execute_csharp',result,source,scope),null);
  assert.equal(ledger.record('revit_place_family_instance',result,source,scope).valid_for_inspection,true);
  assert.deepEqual(ledger.resolve(id,source,scope).element_ids,[23]);
  assert.throws(()=>ledger.resolve(id,source,{...scope,account:'other'}));assert.throws(()=>ledger.resolve(id,{...source,session:'b'.repeat(32)},scope));
  const rollback={...result,request_id:randomUUID(),mode:'rollback',committed:false};ledger.record('revit_place_family_instance',rollback,source,scope);assert.throws(()=>ledger.resolve(rollback.request_id,source,scope),/回滚/);
});

test('dispatcher resolves trusted created source into actual IDs before native inspection',async()=>{
  const calls=[],id=randomUUID();
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>({hostSession:source.session,document:{title:source.title,path:source.path}}),invokeWorkbench:async(name,args)=>{calls.push({name,args});return name==='revit_create_wall'?{request_id:id,mode:'commit',committed:true,document:source.title,value:{element_id:23}}:{operation:'inspect_elements',hostSession:source.session,document:{title:source.title,path:source.path},request_id:randomUUID(),value:{success:true}};}});
  const created=await dispatcher.invokeTool('revit_create_wall',{mode:'commit'},{creationScope:scope});assert.deepEqual(created.created_elements.element_ids,[23]);
  await dispatcher.invokeTool('revit_inspect_elements',{source_request_id:id},{creationScope:scope});assert.deepEqual(calls[1].args.element_ids,[23]);assert.equal(Object.hasOwn(calls[1].args,'source_request_id'),false);
  await assert.rejects(dispatcher.invokeTool('revit_inspect_elements',{source_request_id:id},{creationScope:{...scope,conversationId:'other'}}),/当前账号、对话/);
});

test('permission owner permits named visual workflow without adding mode or per-call approval',async()=>{
  const binding={client:'fixture',conversationId:scope.conversationId,generation:1,revision:0,account:scope.account,document:source};let actual;
  const owner=createModelPermissionOwner({verifyDocument:async()=>true,invoke:async(tool,args,control)=>{actual={tool,args,control};return {ok:true,value:{}};}});
  owner.setLevel({level:'confirm',scope:binding,isCurrent:()=>true});
  const proposal=owner.propose({scope:binding,callId:'visual-call',tool:'revit_inspect_elements',parameters:{element_ids:[23]},isCurrent:()=>true});
  assert.equal(proposal.effect,'view_capture');assert.equal(proposal.requiresApproval,false);assert.equal(Object.hasOwn(proposal.parameters,'mode'),false);
  assert.equal((await owner.decide({ticket:proposal.ticket,digest:proposal.digest,decision:'accept'})).status,'completed');assert.deepEqual(actual.control.creationScope,scope);await owner.close();
});

test('pending cleanup recovery is bound, concurrent checks share work and unknown restore is never replayed',async()=>{
  let restoreCalls=0,inspectCalls=0,closeCalls=0,late=false;
  const original={inspect:()=>({ok:true,value:{status:'unconfirmed',terminal:false,evidence:{restorationStatus:'pending',sessionHandle:'owned-handle'}}}),close:()=>({ok:true,value:{closed:true}})};
  const recovery={inspect:()=>{inspectCalls++;return {ok:true,value:{status:late?'received':'pending',terminal:late,requestId:'recovery-id',evidence:{restorationStatus:late?'restored':'pending'}}};},close:()=>{closeCalls++;return {ok:true,value:{closed:true}};}};
  const owner=createVisualRecoveryOwner({receiptOwner:original,restore:async handle=>{assert.equal(handle,'owned-handle');restoreCalls++;throw new Error('unknown');},failureEvidence:()=>({outcome:'unconfirmed',receiptOwner:recovery,requestIds:['recovery-id']})});
  await Promise.all([owner.inspect(),owner.inspect()]);assert.equal(restoreCalls,1);
  assert.equal((await owner.inspect()).value.terminal,false);assert.equal(restoreCalls,1);assert.equal(inspectCalls,1);
  late=true;const fixed=await owner.inspect();assert.equal(fixed.value.terminal,true);assert.equal(fixed.value.evidence.recoveryRequestId,'recovery-id');assert.equal(restoreCalls,1);
  await owner.close();assert.equal(closeCalls,1);
});
