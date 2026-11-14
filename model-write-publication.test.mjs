import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {loadNativeReadProducer,nativeProducerAvailable} from './test-support/native-read-producer.mjs';

async function fixture(t){
  const parent=path.resolve(os.tmpdir());
  const root=await fs.mkdtemp(path.join(parent,'buildx-write-guard-'));
  const relative=path.relative(parent,path.resolve(root));
  assert.ok(relative.startsWith('buildx-write-guard-')&&!relative.includes(path.sep)&&!path.isAbsolute(relative));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'queue','outbox'),{recursive:true});
  await fs.mkdir(path.join(root,'queue','processing'),{recursive:true});
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:'a'.repeat(32),pid:process.pid,version:'0.6.0'}));
  return {root,inbox:path.join(root,'queue','inbox')};
}

for(const [tool,args] of [
  ['revit_move_elements',{expected_document:'C:\\sample.rvt',element_ids:[3],delta_mm:{x:1,y:0,z:0},mode:'commit'}],
  ['revit_execute_csharp',{expected_document:'C:\\sample.rvt',code:'return 1;',mode:'commit'}],
])test(`${tool} revocation during preparation stops before publication`,async t=>{
  const f=await fixture(t);let allowed=true,prepared=false;
  let caught;
  try{await invokeWorkbench(tool,args,{root:f.root,timeout:30,shouldContinue:()=>allowed,onTiming:event=>{if(event.phase==='temp_ready'){prepared=true;allowed=false;}}});}
  catch(error){caught=error;}
  assert.ok(prepared);assert.ok(caught);assert.equal(workbenchFailureEvidence(caught).outcome,'not_started');
  assert.equal(caught.interruptedBeforeEnqueue,true);assert.ok(caught.unpublishedRequest);
  const files=await fs.readdir(f.inbox);assert.equal(files.filter(name=>name.endsWith('.json')).length,0);
  assert.equal(files.filter(name=>name.endsWith('.tmp')).length,1);
  assert.equal(path.dirname(caught.unpublishedRequest.tempPath),f.inbox);
});

const sourceDocument={session:'a'.repeat(32),path:'C:\\sample.rvt',title:'sample'};
const moveArgs={expected_document:sourceDocument.path,element_ids:[3],delta_mm:{x:1,y:0,z:0},mode:'commit'};
const receipt=(id,patch={})=>{
  const stamp=new Date().toISOString();
  return {id,ok:true,completedUtc:stamp,timing:{schemaVersion:1,requestId:id,hostSession:sourceDocument.session,schedulerCorrelation:'unmatched',executeEnteredUtc:stamp,claimedUtc:stamp,responsePreparedUtc:stamp,observedUtc:null,raiseReturnedUtc:null,dispatchStartedUtc:stamp,dispatchFinishedUtc:stamp,observedToExecuteMs:null,dispatchMs:0,validationMs:0,hostWorkMs:0,raiseResult:null},result:{operation:'move_elements',mode:'commit',committed:true,document:'sample',value:{moved:1}},...patch};
};
const retained={sourceDocument,expectedHostSession:sourceDocument.session,retainReceiptOwner:true,shouldContinue:()=>true};

test('write timeout retains its exact original request owner and validates late receipt facts',async t=>{
  const f=await fixture(t);let error;
  try{await invokeWorkbench('revit_move_elements',moveArgs,{root:f.root,timeout:500,...retained});}catch(e){error=e;}
  const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');assert.equal(facts.requestIds.length,1);assert.ok(facts.receiptOwner);
  const id=facts.requestIds[0],responseFile=path.join(f.root,'queue','outbox',id+'.json'),owner=facts.receiptOwner;
  assert.equal(owner.inspect().value.status,'pending');assert.equal(owner.inspect().value.terminal,false);
  const missing=receipt(id);delete missing.timing;await fs.writeFile(responseFile,JSON.stringify(missing));
  assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(owner.inspect().value.terminal,false);
  const wrong=receipt(id);wrong.result.committed=false;await fs.writeFile(responseFile,JSON.stringify(wrong));assert.equal(owner.inspect().value.status,'unconfirmed');
  const foreign=receipt(id);foreign.timing.hostSession='b'.repeat(32);await fs.writeFile(responseFile,JSON.stringify(foreign));assert.equal(owner.inspect().value.status,'unconfirmed');
  const changedDocument=receipt(id);changedDocument.result.document='other';await fs.writeFile(responseFile,JSON.stringify(changedDocument));assert.equal(owner.inspect().value.status,'unconfirmed');
  await fs.writeFile(responseFile,JSON.stringify(receipt(id)));
  const checked=owner.inspect();assert.equal(checked.value.status,'received');assert.equal(checked.value.terminal,true);assert.equal(checked.value.evidence.documentPathStatus,'requested_not_returned');assert.equal(owner.close().value.closed,true);
});

test('normal verified write hands its original owner to its caller',async t=>{
  const f=await fixture(t);const pending=invokeWorkbench('revit_move_elements',moveArgs,{root:f.root,timeout:2000,...retained});
  let filename;for(let i=0;i<100&&!filename;i++){await new Promise(resolve=>setTimeout(resolve,10));filename=(await fs.readdir(f.inbox).catch(()=>[])).find(name=>name.endsWith('.json'));}
  assert.ok(filename);const id=filename.slice(0,-5);await fs.writeFile(path.join(f.root,'queue','outbox',filename),JSON.stringify(receipt(id)));
  const output=await pending;assert.equal(output.committed,true);assert.ok(output.receiptOwner);assert.equal(output.receiptOwner.inspect().value.status,'received');assert.equal(output.receiptOwner.close().value.closed,true);
});

test('a failed script exposes original native error facts without confirming effects or rollback',async t=>{
  const f=await fixture(t),pending=invokeWorkbench('revit_execute_csharp',{expected_document:sourceDocument.path,code:'return 1;',mode:'commit'},{root:f.root,timeout:2000,...retained});
  let filename;for(let i=0;i<100&&!filename;i++){await new Promise(resolve=>setTimeout(resolve,10));filename=(await fs.readdir(f.inbox).catch(()=>[])).find(name=>name.endsWith('.json'));}
  assert.ok(filename);const id=filename.slice(0,-5),responseFile=path.join(f.root,'queue','outbox',filename),completedUtc=new Date().toISOString();
  // Same failure envelope as the live ArgumentNullException. Extra producer
  // fields are intentionally not part of the receipt's display contract.
  const failure={id,ok:false,hostSession:sourceDocument.session,error:{code:'ArgumentNullException',message:'Value cannot be null.',headers:{authorization:'transport-canary'},token:'token-canary',script:'script-canary'},execution:{started:true,phase:'dispatch',reason:null},completedUtc};
  await fs.writeFile(responseFile,JSON.stringify(failure));
  const error=await pending.then(()=>assert.fail('Expected a retained failed operation'),error=>error),facts=workbenchFailureEvidence(error),owner=facts.receiptOwner;
  assert.equal(facts.outcome,'unconfirmed');assert.ok(owner);
  const checked=owner.inspect();assert.equal(checked.ok,true);assert.equal(checked.value.status,'unconfirmed');assert.equal(checked.value.terminal,false);assert.equal(checked.value.canCheckAgain,true);
  assert.deepEqual(checked.value.evidence,{nativeFailure:{code:'ArgumentNullException',message:'Value cannot be null.',outcome:'failed',phase:'dispatch',started:true,reason:null,completedUtc,requestId:id,hostSession:sourceDocument.session}});
  assert.equal(Object.hasOwn(checked.value,'nativeFailure'),false);
  assert.doesNotMatch(JSON.stringify(checked.value),/transport-canary|token-canary|script-canary/);
  assert.equal(Object.hasOwn(checked.value.evidence,'rolledBack'),false);
  assert.deepEqual(checked.value.recovery,{kind:'script_failure',requiresReview:true,modelRollback:'unknown',externalEffects:'unknown'});
  assert.deepEqual(await fs.readdir(f.inbox),[filename]);
  for(const mutate of [
    value=>{value.id='b'.repeat(36);},
    value=>{value.hostSession='b'.repeat(32);},
    value=>{value.execution.phase='validation';},
    value=>{value.error.message={text:'invalid'};},
  ]){
    const invalid=structuredClone(failure);mutate(invalid);await fs.writeFile(responseFile,JSON.stringify(invalid));
    const rejected=owner.inspect();assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'RECEIPT_UNCONFIRMED');assert.equal(Object.hasOwn(rejected,'value'),false);
  }
  await fs.writeFile(responseFile,JSON.stringify(failure));assert.equal(owner.inspect().value.terminal,false);assert.equal(owner.close().value.closed,true);
});

test('named model failures preserve explicit execution facts and keep legacy uncertainty',async t=>{
  const f=await fixture(t),pending=invokeWorkbench('revit_move_elements',moveArgs,{root:f.root,timeout:2000,...retained});
  let filename;for(let i=0;i<100&&!filename;i++){await new Promise(resolve=>setTimeout(resolve,10));filename=(await fs.readdir(f.inbox).catch(()=>[])).find(name=>name.endsWith('.json'));}
  assert.ok(filename);const id=filename.slice(0,-5),responseFile=path.join(f.root,'queue','outbox',filename),completedUtc=new Date().toISOString();
  const failure={id,ok:false,hostSession:sourceDocument.session,error:{code:'InvalidOperationException',message:'The operation failed.'},execution:{started:true,phase:'dispatch',reason:null},completedUtc};
  await fs.writeFile(responseFile,JSON.stringify(failure));
  const error=await pending.then(()=>assert.fail('Expected a retained failed operation'),error=>error),owner=workbenchFailureEvidence(error).receiptOwner;
  const dispatched=owner.inspect().value;assert.equal(dispatched.status,'unconfirmed');assert.equal(dispatched.terminal,false);assert.equal(dispatched.evidence.nativeFailure.started,true);
  assert.equal(dispatched.recovery,undefined,'Named writes never inherit C# review recovery');
  const legacy=structuredClone(failure);delete legacy.execution;await fs.writeFile(responseFile,JSON.stringify(legacy));
  const unknown=owner.inspect().value;assert.equal(unknown.status,'unconfirmed');assert.equal(unknown.terminal,false);assert.equal(unknown.evidence.nativeFailure.phase,'unknown');assert.equal(Object.hasOwn(unknown.evidence.nativeFailure,'started'),false);
  failure.error={code:'WORKBENCH_REQUEST_EXPIRED',message:'Request expired before execution; no operation was run.'};failure.execution={started:false,phase:'validation',reason:'expired'};await fs.writeFile(responseFile,JSON.stringify(failure));
  const expired=owner.inspect().value;assert.equal(expired.status,'expired');assert.equal(expired.terminal,true);assert.equal(expired.evidence.nativeFailure.started,false);assert.equal(expired.evidence.nativeFailure.reason,'expired');
  failure.error={code:'ACCESS_POLICY_DENIED',message:'The model is outside the active policy.'};failure.execution={started:false,phase:'validation',reason:null};await fs.writeFile(responseFile,JSON.stringify(failure));
  const rejected=owner.inspect().value;assert.equal(rejected.status,'not_started');assert.equal(rejected.terminal,true);assert.equal(rejected.evidence.nativeFailure.started,false);
  assert.equal(owner.close().value.closed,true);
});

test('native script failure publishes its observed group rollback and the transport validates every binding',{skip:!nativeProducerAvailable},async t=>{
  const producer=await loadNativeReadProducer(t),f=await fixture(t);
  const args={expected_document:sourceDocument.path,code:'throw new InvalidOperationException();',mode:'commit'};
  const pending=invokeWorkbench('revit_execute_csharp',args,{root:f.root,timeout:2000,...retained});
  let filename;for(let i=0;i<100&&!filename;i++){await new Promise(resolve=>setTimeout(resolve,10));filename=(await fs.readdir(f.inbox).catch(()=>[])).find(name=>name.endsWith('.json'));}
  assert.ok(filename);const id=filename.slice(0,-5),responseFile=path.join(f.root,'queue','outbox',filename);
  const native=await producer.inspect({operation:'execute_csharp',document:{title:sourceDocument.title,path:sourceDocument.path},args,fail:true});
  assert.equal(native.ok,false);assert.equal(native.error.type,'ScriptExecutionFailure');
  assert.deepEqual([native.facts.writeCalls,native.facts.commits,native.facts.rollbacks,native.facts.mutations],[1,0,1,0]);
  assert.deepEqual(native.error.transaction,{schemaVersion:1,operation:'execute_csharp',mode:'commit',document:{path:sourceDocument.path,title:sourceDocument.title},scope:'transaction_group',status:'rolled_back',externalEffects:'unknown'});
  const failure={id,ok:false,hostSession:sourceDocument.session,error:{code:'InvalidOperationException',message:native.error.message},execution:{started:true,phase:'dispatch',reason:null},completedUtc:new Date().toISOString(),transaction:native.error.transaction};
  await fs.writeFile(responseFile,JSON.stringify(failure));
  const thrown=await pending.then(()=>assert.fail('Expected failed script'),error=>error),owner=workbenchFailureEvidence(thrown).receiptOwner;
  assert.ok(owner);const checked=owner.inspect();assert.equal(checked.ok,true);assert.equal(checked.value.status,'failed_rolled_back');assert.equal(checked.value.terminal,true);
  assert.deepEqual(checked.value.recovery,{kind:'script_failure',requiresReview:false,modelRollback:'rolled_back',externalEffects:'unknown'});
  assert.deepEqual(checked.value.evidence.transaction,native.error.transaction);
  for(const mutate of [
    value=>{value.transaction.operation='move_elements';},value=>{value.transaction.mode='rollback';},
    value=>{value.transaction.document.path='C:\\other.rvt';},value=>{value.transaction.document.title='other';},
    value=>{value.transaction.schemaVersion=2;},value=>{value.transaction.status='committed';},
    value=>{value.transaction.scope='script_transaction';},value=>{value.transaction.externalEffects='none';},
    value=>{value.transaction.extra=true;},value=>{delete value.transaction;},
  ]){
    const wrong=structuredClone(failure);mutate(wrong);await fs.writeFile(responseFile,JSON.stringify(wrong));
    const observed=owner.inspect();assert.equal(observed.ok,true);assert.equal(observed.value.terminal,false);assert.equal(observed.value.recovery.requiresReview,true);
  }
  const uncertain=await producer.inspect({operation:'execute_csharp',document:{title:sourceDocument.title,path:sourceDocument.path},args,fail:true,rollbackUnknown:true});
  assert.equal(uncertain.ok,false);assert.equal(uncertain.error.transaction.status,'unknown');assert.equal(uncertain.facts.mutations,1);
  await fs.writeFile(responseFile,JSON.stringify({...failure,transaction:uncertain.error.transaction}));
  assert.equal(owner.inspect().value.terminal,false);assert.equal(owner.inspect().value.recovery.modelRollback,'unknown');
  const legacy=structuredClone(failure);delete legacy.execution;await fs.writeFile(responseFile,JSON.stringify(legacy));
  const missingExecution=owner.inspect().value;assert.equal(missingExecution.terminal,false);assert.equal(missingExecution.recovery,undefined,'A rollback marker cannot replace explicit execution facts');
  await fs.writeFile(path.join(f.root,'queue','host.json'),JSON.stringify({sessionId:'b'.repeat(32),pid:process.pid,version:'0.6.0'}));
  const changed=owner.inspect().value;assert.equal(changed.status,'host_changed');assert.equal(changed.terminal,false);assert.equal(changed.recovery,undefined);
  assert.equal(owner.close().value.closed,true);
});

test('long old and native script diagnostics retain ended facts and bounded recovery evidence',{skip:!nativeProducerAvailable},async t=>{
  const producer=await loadNativeReadProducer(t),f=await fixture(t),diagnostic='C# compilation failed: '+('user-script.cs(3): error CS0103: Unknown identifier.\n'.repeat(300));
  const args={expected_document:sourceDocument.path,code:'invalid source',mode:'commit'};
  const thrown=await invokeWorkbench('revit_execute_csharp',args,{root:f.root,timeout:500,...retained}).then(()=>assert.fail('Expected pending script'),error=>error);
  const facts=workbenchFailureEvidence(thrown),id=facts.requestIds[0],owner=facts.receiptOwner,responseFile=path.join(f.root,'queue','outbox',id+'.json');
  const failure={id,ok:false,hostSession:sourceDocument.session,error:{code:'InvalidOperationException',message:diagnostic},execution:{started:true,phase:'dispatch',reason:null},completedUtc:new Date().toISOString()};
  await fs.writeFile(responseFile,JSON.stringify(failure));
  const legacy=owner.inspect();assert.equal(legacy.ok,true);assert.equal(legacy.value.terminal,false);assert.equal(legacy.value.recovery.requiresReview,true);
  const legacyFailure=legacy.value.evidence.nativeFailure;
  assert.equal(legacyFailure.code,'InvalidOperationException');assert.equal(legacyFailure.started,true);assert.equal(legacyFailure.phase,'dispatch');
  assert.equal(legacyFailure.message,diagnostic.slice(0,4096));assert.equal(legacyFailure.messageTruncated,true);assert.equal(legacyFailure.messageCharacters,diagnostic.length);
  assert.equal(JSON.parse(await fs.readFile(responseFile,'utf8')).error.message,diagnostic,'The original legacy receipt remains complete');
  const native=await producer.inspect({operation:'execute_csharp',document:{title:sourceDocument.title,path:sourceDocument.path},args,fail:true,failureMessage:diagnostic,rollbackUnknown:true});
  assert.equal(native.ok,false);assert.equal(native.error.transaction.status,'unknown');
  assert.deepEqual(native.error.receipt,{code:'InvalidOperationException',message:diagnostic.slice(0,4096),messageTruncated:true,messageCharacters:diagnostic.length});
  await fs.writeFile(responseFile,JSON.stringify({...failure,error:native.error.receipt,transaction:native.error.transaction}));
  const current=owner.inspect();assert.equal(current.ok,true);assert.equal(current.value.terminal,false);assert.equal(current.value.recovery.requiresReview,true);
  assert.equal(current.value.evidence.nativeFailure.started,true);assert.equal(current.value.evidence.nativeFailure.messageTruncated,true);assert.equal(current.value.evidence.nativeFailure.messageCharacters,diagnostic.length);
  for(const mutate of [
    value=>{value.id='f'.repeat(36);},value=>{value.hostSession='b'.repeat(32);},
    value=>{value.completedUtc='invalid';},value=>{value.execution.phase='validation';},
    value=>{value.error.messageTruncated='true';},value=>{value.error.messageCharacters=1;},
  ]){
    const invalid=structuredClone(failure);mutate(invalid);await fs.writeFile(responseFile,JSON.stringify(invalid));
    assert.equal(owner.inspect().ok,false,'Long diagnostics cannot rescue invalid identity, completion or execution facts');
  }
  assert.equal(owner.close().value.closed,true);
});

test('a write with ambiguous rename retains its original owner and is never reported not started',async t=>{
  const f=await fixture(t),rename=fs.rename;t.mock.method(fs,'rename',async(...args)=>{await rename(...args);throw new Error('unknown publication');});
  let error;try{await invokeWorkbench('revit_move_elements',moveArgs,{root:f.root,timeout:500,...retained});}catch(e){error=e;}
  const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');assert.equal(facts.requestIds.length,1);assert.ok(facts.receiptOwner);assert.equal(facts.receiptOwner.inspect().value.status,'pending');assert.equal(facts.receiptOwner.close().value.closed,true);
});

test('revocation after publication cannot be claimed to have cancelled the write',async t=>{
  const f=await fixture(t);let allowed=true,published=0,caught;
  try{await invokeWorkbench('revit_move_elements',{expected_document:'C:\\sample.rvt',element_ids:[3],delta_mm:{x:1,y:0,z:0},mode:'commit'},
    {root:f.root,timeout:500,shouldContinue:()=>allowed,onTiming:event=>{if(event.phase==='published'){published++;allowed=false;}}});}
  catch(error){caught=error;}
  assert.equal(published,1);assert.ok(caught);assert.equal(caught.interruptedBeforeEnqueue,undefined);
  const evidence=workbenchFailureEvidence(caught);assert.equal(evidence.outcome,'unconfirmed');assert.equal(evidence.requestIds.length,1);
  assert.deepEqual(await fs.readdir(f.inbox),[evidence.requestIds[0]+'.json']);
});
