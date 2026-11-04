import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelPermissionOwner,isRecoverableModelScriptReceipt} from './model-permission-owner.mjs';

const scope=()=>({client:'client',conversationId:'original-chat',generation:1,revision:2,account:'account',document:{session:'host',path:'C:\\model.rvt',title:'Model'}});
const failedReceipt=()=>({status:'unconfirmed',terminal:false,requestId:'original-request',recovery:{kind:'script_failure',requiresReview:true,modelRollback:'unknown',externalEffects:'unknown'},evidence:{nativeFailure:{code:'ArgumentNullException',message:'Value cannot be null.',started:true,outcome:'failed',phase:'dispatch',completedUtc:'2026-11-04T10:00:00.000Z',requestId:'original-request',hostSession:'host'}}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture({tool='revit_execute_csharp',verifyRecovery=async()=>true,close=async()=>({ok:true,value:{closed:true}})}={}){
  let value=failedReceipt(),checks=0,closes=0,invocations=0;const verifications=[];
  const original={inspect:async()=>({ok:true,value:{...structuredClone(value),checkedAt:String(++checks)}}),close:async()=>{closes++;return close();}};
  const owner=createModelPermissionOwner({
    verifyDocument:async(document,control)=>{if(control.recovery){verifications.push({document,control});return verifyRecovery();}return true;},
    invoke:async()=>{invocations++;return {ok:false,error:{outcome:'unconfirmed'},receiptOwner:original};},
  });
  owner.setLevel({level:'automatic',scope:scope(),isCurrent:()=>true});
  const parameters=tool==='revit_move_elements'?{element_ids:[1],delta_mm:{x:1,y:0,z:0}}:tool==='revit_run_command'?{command_id:'script',revision:'a'.repeat(64),mode:'commit'}:{code:'throw new ArgumentNullException("value");',mode:'commit'};
  const reviewedCommand=tool==='revit_run_command'?{schema_version:2,command_id:'script',revision:'a'.repeat(64),name:'Script',description:'Script',code:'throw new ArgumentNullException("value");',parameters:{}}:undefined;
  const proposal=owner.propose({scope:scope(),callId:'call',tool,parameters,...reviewedCommand?{reviewedCommand}:{},isCurrent:()=>true});
  assert.equal((await owner.decide({ticket:proposal.ticket,digest:proposal.digest,decision:'accept'})).status,'unconfirmed');
  const input=async()=>({ticket:proposal.ticket,scope:scope(),expected:(await owner.inspect({ticket:proposal.ticket,scope:scope()})).value});
  return {owner,proposal,input,verifications,set:value_=>{value=value_;},stats:()=>({checks,closes,invocations})};
}

test('reviewed ended C# failures can be retired after live validation even after switching conversations',async()=>{
  for(const tool of ['revit_execute_csharp','revit_run_command']){
    const f=await fixture({tool}),input=await f.input();f.owner.revoke();
    await assert.rejects(f.owner.acknowledge(input),{code:'MODEL_RECEIPT_UNCONFIRMED'});
    assert.deepEqual(await f.owner.recover(input),{closed:true,outcome:'failed',modelRollback:'unknown',externalEffects:'unknown'});
    assert.deepEqual(f.verifications,[{document:scope().document,control:{accessPolicy:undefined,recovery:true,receiptScope:scope()}}]);
    assert.equal(f.stats().invocations,1);assert.equal(f.stats().closes,1);
    await assert.rejects(f.owner.inspect(input),{code:'MODEL_RECEIPT_UNAVAILABLE'});
    await assert.rejects(f.owner.recover(input),{code:'MODEL_RECEIPT_UNAVAILABLE'});
  }
});

test('recovery refuses unfinished, malformed, mismatched and unrelated model receipts',async()=>{
  const mutations=[
    value=>{value.status='pending';},value=>{delete value.recovery;},value=>{value.recovery.requiresReview=false;},
    value=>{value.evidence.nativeFailure.started=false;},value=>{value.evidence.nativeFailure.outcome='not_started';},
    value=>{value.evidence.nativeFailure.phase='validation';},value=>{value.evidence.nativeFailure.completedUtc='2026-02-30T10:00:00Z';},
    value=>{value.evidence.nativeFailure.requestId='another-request';},value=>{value.evidence.nativeFailure.hostSession='another-host';},
  ];
  const f=await fixture();
  for(const mutate of mutations){const value=failedReceipt();mutate(value);f.set(value);await assert.rejects(f.owner.recover(await f.input()),{code:'MODEL_RECEIPT_UNCONFIRMED'});}
  f.set(failedReceipt());const input=await f.input();
  await assert.rejects(f.owner.recover({...input,scope:{...scope(),account:'another-account'}}),{code:'MODEL_RECEIPT_UNAVAILABLE'});
  assert.equal(f.verifications.length,0);assert.equal(f.stats().closes,0);
  assert.equal(isRecoverableModelScriptReceipt('revit_move_elements',failedReceipt()),false);
  const ordinary=await fixture({tool:'revit_move_elements'});
  await assert.rejects(ordinary.owner.recover(await ordinary.input()),{code:'MODEL_RECEIPT_UNCONFIRMED'});
});

test('recovery cannot substitute expected evidence and retains the original request for retry',async()=>{
  const f=await fixture(),input=await f.input(),changed=structuredClone(input.expected);changed.evidence.nativeFailure.code='Changed';
  await assert.rejects(f.owner.recover({...input,expected:changed}),{code:'MODEL_RECEIPT_UNCONFIRMED'});
  assert.equal(f.verifications.length,0);assert.equal(f.stats().closes,0);
  assert.equal((await f.owner.recover(input)).closed,true);assert.equal(f.stats().invocations,1);
});

test('failed live document checks retain recovery ownership and can be retried',async()=>{
  let available=false;const f=await fixture({verifyRecovery:async()=>available}),input=await f.input();
  await assert.rejects(f.owner.recover(input),{code:'MODEL_RECEIPT_DOCUMENT_CHANGED'});assert.equal(f.stats().closes,0);
  available=true;assert.equal((await f.owner.recover(input)).closed,true);assert.equal(f.stats().invocations,1);
});

test('receipt changes during live validation cannot be acknowledged with stale review',async()=>{
  const started=deferred(),verify=deferred();const f=await fixture({verifyRecovery:async()=>{started.resolve();return verify.promise;}}),input=await f.input();
  const pending=f.owner.recover(input);await started.promise;
  const changed=failedReceipt();changed.evidence.nativeFailure.code='Changed';f.set(changed);verify.resolve(true);
  await assert.rejects(pending,{code:'MODEL_RECEIPT_UNCONFIRMED'});assert.equal(f.stats().closes,0);
  assert.equal((await f.owner.inspect(input)).value.evidence.nativeFailure.code,'Changed');
});

test('cleanup failure remains owned and retries never replay the script',async()=>{
  let available=false;const f=await fixture({close:async()=>available?{ok:true,value:{closed:true}}:{ok:false}}),input=await f.input();
  await assert.rejects(f.owner.recover(input),{code:'MODEL_RECEIPT_CLEANUP_UNCONFIRMED'});
  assert.equal((await f.owner.inspect(input)).value.terminal,false);
  available=true;assert.equal((await f.owner.recover(input)).closed,true);
  assert.equal(f.stats().closes,2);assert.equal(f.stats().invocations,1);
});

test('one settlement owns document validation and final cleanup until it completes',async()=>{
  for(const phase of ['validation','cleanup']){
    const started=deferred(),wait=deferred();
    const f=await fixture({verifyRecovery:async()=>{if(phase==='validation'){started.resolve();await wait.promise;}return true;},close:async()=>{if(phase==='cleanup'){started.resolve();await wait.promise;}return {ok:true,value:{closed:true}};}}),input=await f.input();
    const pending=f.owner.recover(input);await started.promise;
    await assert.rejects(f.owner.recover(input),{code:'MODEL_RECEIPT_UNAVAILABLE'});
    await assert.rejects(f.owner.acknowledge(input),{code:'MODEL_RECEIPT_UNAVAILABLE'});
    wait.resolve();assert.equal((await pending).closed,true);assert.equal(f.stats().closes,1);
  }
});
