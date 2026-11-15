import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {invokeWorkbench,workbenchFailureEvidence} from '../lib/workbench-client.mjs';
import {timeoutAfterPublication} from '../test-support/workbench-timeout.mjs';

const session='b'.repeat(32),sourceDocument={session,title:'Sample',path:'C:\\workbench\\samples\\Argus-Codex-Plumbing-Sample.rvt'};
const approvedFamily={job_handle:'job-123',project_handle:'project-123',project_fingerprint:'project-fingerprint',save:{path:'C:\\workbench\\family-artifacts\\valve.rfa',sha256:'c'.repeat(64)}};
const input=mode=>({expected_document:sourceDocument.path,job_handle:approvedFamily.job_handle,mode});
const control={sourceDocument,expectedHostSession:session,approvedFamily,retainReceiptOwner:true,shouldContinue:()=>true};
async function fixture(t){
  const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'buildx-family-load-'));
  const rel=path.relative(parent,path.resolve(root));assert.ok(rel.startsWith('buildx-family-load-')&&!rel.includes(path.sep)&&!path.isAbsolute(rel));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const queue=path.join(root,'queue');for(const name of ['inbox','outbox','processing'])await fs.mkdir(path.join(queue,name),{recursive:true});
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version:'0.6.6',startedUtc:new Date().toISOString()}));
  return {root,queue};
}
function receipt(id,mode){
  const stamp=new Date().toISOString(),rollback=mode==='rollback',detail={mode,outcome:rollback?'rolled_back':'committed',family_count_before:20,family_count_after:rollback?20:21,project_saved:false,temporary_instances_rolled_back:true,loaded_family_id:100,type_validation:[{type_name:'BuildX_Valve_A',type_id:101,connector_count:2,connectors:[{},{}]},{type_name:'BuildX_Valve_B',type_id:102,connector_count:2,connectors:[{},{}]}],independent_id_readback:[{id:100,exists:!rollback},{id:101,exists:!rollback},{id:102,exists:!rollback},{id:103,exists:false},{id:104,exists:false}],rollback_independently_verified:rollback?true:null};
  return {id,ok:true,completedUtc:stamp,timing:{schemaVersion:1,requestId:id,hostSession:session,schedulerCorrelation:'unmatched',executeEnteredUtc:stamp,claimedUtc:stamp,responsePreparedUtc:stamp,observedUtc:null,raiseReturnedUtc:null,dispatchStartedUtc:stamp,dispatchFinishedUtc:stamp,observedToExecuteMs:null,dispatchMs:0,validationMs:0,hostWorkMs:0,raiseResult:null},result:{operation:'family_load_job',hostSession:session,value:{operation:'family_load_job',host_session:session,revit_pid:process.pid,job_handle:approvedFamily.job_handle,project_handle:approvedFamily.project_handle,project_fingerprint:approvedFamily.project_fingerprint,job_scope:'bound_project',success:true,code:'FAMILY_LOADED_AND_READ_BACK',outcome:rollback?'rolled_back_verified':'family_committed_in_memory_not_saved',cleanup_pending:false,save:{...approvedFamily.save,independently_reopened_verified:true},native_status:{project_group:rollback?'RolledBack':'Committed',project_transaction:'Committed',validation_subtransaction:'RolledBack'},effects:{project_saved:false,project_load:detail},value:detail}}};
}
async function timeout(f,mode='rollback'){
  let error;try{await timeoutAfterPublication(options=>invokeWorkbench('revit_family_load_job',input(mode),options),{root:f.root,...control});}catch(value){error=value;}
  const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');assert.equal(facts.requestIds.length,1);assert.ok(facts.receiptOwner);const [id]=facts.requestIds;assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[id+'.json']);return {id,owner:facts.receiptOwner};
}

test('family load requires the exact approved job, project and artifact before publication',async t=>{
  const f=await fixture(t);
  for(const approved of [null,{...approvedFamily,job_handle:'different'},{...approvedFamily,save:{...approvedFamily.save,sha256:'bad'}},{...approvedFamily,project_handle:''}]){
    let error;try{await invokeWorkbench('revit_family_load_job',input('rollback'),{root:f.root,...control,approvedFamily:approved});}catch(value){error=value;}
    assert.ok(error);assert.equal(workbenchFailureEvidence(error).outcome,'not_started');
  }
  await assert.rejects(invokeWorkbench('revit_family_load_job',input('rollback'),{root:f.root,...control,sourceDocument:undefined}),error=>workbenchFailureEvidence(error).outcome==='not_started');
  assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);
});

for(const mode of ['rollback','commit'])test(`${mode} late family receipt retains and verifies approved evidence`,async t=>{
  const f=await fixture(t),{id,owner}=await timeout(f,mode),file=path.join(f.queue,'outbox',id+'.json');
  assert.equal(owner.inspect().value.status,'pending');await fs.writeFile(file,JSON.stringify(receipt(id,mode)));
  const checked=owner.inspect();assert.equal(checked.value.status,'received');assert.equal(checked.value.terminal,true);assert.equal(checked.value.evidence.committed,mode==='commit');assert.equal(checked.value.evidence.artifactSha256,approvedFamily.save.sha256);assert.equal(owner.close().value.closed,true);
});

test('mismatched identities, incomplete effects and unsuccessful business result remain unknown',async t=>{
  const f=await fixture(t),{id,owner}=await timeout(f),file=path.join(f.queue,'outbox',id+'.json');
  const mutations=[v=>delete v.timing,v=>v.result.hostSession='x',v=>v.result.value.revit_pid++,v=>v.result.value.job_handle='different',v=>v.result.value.project_handle='different',v=>v.result.value.project_fingerprint='different',v=>v.result.value.save.sha256='d'.repeat(64),v=>v.result.value.save.path='C:\\other.rfa',v=>v.result.value.success=false,v=>v.result.value.cleanup_pending=true,v=>v.result.value.value.mode='commit',v=>v.result.value.native_status.project_group='Committed',v=>v.result.value.value.rollback_independently_verified=false,v=>v.result.value.value.independent_id_readback[0].exists=true,v=>v.result.value.value.family_count_after++,v=>v.result.value.value.project_saved=true];
  for(const mutate of mutations){const value=receipt(id,'rollback');mutate(value);await fs.writeFile(file,JSON.stringify(value));assert.equal(owner.inspect().value.status,'unconfirmed',mutate.toString());assert.equal(owner.inspect().value.terminal,false);}
  assert.equal(owner.close().value.closed,true);
});

test('normal family load returns the original receipt owner for safe cleanup',async t=>{
  const f=await fixture(t),pending=invokeWorkbench('revit_family_load_job',input('rollback'),{root:f.root,timeout:2000,...control});let file;
  for(let i=0;i<100&&!file;i++){await new Promise(resolve=>setTimeout(resolve,10));file=(await fs.readdir(path.join(f.queue,'inbox'))).find(item=>item.endsWith('.json'));}
  assert.ok(file);const id=file.slice(0,-5);await fs.writeFile(path.join(f.queue,'outbox',file),JSON.stringify(receipt(id,'rollback')));
  const value=await pending;assert.ok(value.receiptOwner);assert.equal(value.receiptOwner.inspect().value.status,'received');assert.equal(value.receiptOwner.close().value.closed,true);
});

test('committed load checks permanent family/types separately from temporary instances',async t=>{
  const f=await fixture(t),{id,owner}=await timeout(f,'commit'),file=path.join(f.queue,'outbox',id+'.json');
  const value=receipt(id,'commit');value.result.value.value.independent_id_readback[3].exists=true;value.result.value.value.independent_id_readback[4].exists=true;
  await fs.writeFile(file,JSON.stringify(value));assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(owner.close().value.closed,true);
});

test('revocation while a family request is staged prevents its publication',async t=>{
  const f=await fixture(t);let allowed=true,error;
  try{await invokeWorkbench('revit_family_load_job',input('rollback'),{root:f.root,...control,shouldContinue:()=>allowed,onTiming:value=>{if(value.phase==='temp_ready')allowed=false;}});}catch(value){error=value;}
  assert.equal(workbenchFailureEvidence(error).outcome,'not_started');assert.equal((await fs.readdir(path.join(f.queue,'inbox'))).some(value=>value.endsWith('.json')),false);
});
