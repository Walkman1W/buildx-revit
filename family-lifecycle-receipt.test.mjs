// Isolated fake host and private queue only. No Revit process or user files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {timeoutAfterPublication} from './test-support/workbench-timeout.mjs';

const session='d'.repeat(32),token='e'.repeat(32),sourceDocument={session,title:'Sample',path:'C:\\workbench\\samples\\Argus-Codex-Plumbing-Sample.rvt'};
const pendingSave={attempted:false,state:'not_started',path:null,sha256:null,independently_reopened_verified:false};
const saved={attempted:true,state:'saved_reopened_verified_closed',path:'C:\\workbench\\family-artifacts\\valve.rfa',sha256:'c'.repeat(64),independently_reopened_verified:true};
const identity=(name)=>({job_handle:'job-123',project_handle:'project-123',project_fingerprint:'project-fingerprint',template:{template_id:'metric-generic-model',sha256:'b'.repeat(64)},save:name==='revit_family_save_job'?pendingSave:saved});
const input=name=>name==='revit_family_save_job'?{expected_document:sourceDocument.path,job_handle:'job-123'}:{job_handle:'job-123'};
const control=name=>({sourceDocument,expectedHostSession:session,approvedLifecycle:{schema_version:1,operation:name.slice('revit_'.length),approval_token:token},approvedFamilyIdentity:identity(name),retainReceiptOwner:true,shouldContinue:()=>true});
async function fixture(t,capability=1){
  const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'buildx-family-lifecycle-'));const rel=path.relative(parent,path.resolve(root));assert.ok(rel.startsWith('buildx-family-lifecycle-')&&!rel.includes(path.sep)&&!path.isAbsolute(rel));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const queue=path.join(root,'queue');for(const folder of ['inbox','outbox','processing'])await fs.mkdir(path.join(queue,folder),{recursive:true});
  const host={sessionId:session,pid:process.pid,version:'0.6.7',startedUtc:new Date().toISOString()};if(capability!==null)host.familyLifecycleApprovalVersion=capability;
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify(host));return {root,queue};
}
function receipt(id,name){
  const stamp=new Date().toISOString(),operation=name.slice('revit_'.length),isSave=name==='revit_family_save_job';
  const body={operation,host_session:session,revit_pid:process.pid,job_handle:'job-123',project_handle:'project-123',project_fingerprint:'project-fingerprint',job_scope:'bound_project',stage:'Closed',core_registry_current:true,success:true,code:isSave?'FAMILY_RFA_VERIFIED':'FAMILY_CLOSED',outcome:isSave?'file_persists_independently':'closed',cleanup_pending:false,build_state:'committed',template:identity(name).template,native_status:{family_transaction:'Committed'},save:{...saved,bytes:1234},effects:{saved_file_may_persist:true,project_saved:false},value:isSave?{family_document:true}:null,approval_validation:{schema_version:1,operation,approval_token:token,verified:true}};
  return {id,ok:true,completedUtc:stamp,timing:{schemaVersion:1,requestId:id,hostSession:session,schedulerCorrelation:'unmatched',executeEnteredUtc:stamp,claimedUtc:stamp,responsePreparedUtc:stamp,observedUtc:null,raiseReturnedUtc:null,dispatchStartedUtc:stamp,dispatchFinishedUtc:stamp,observedToExecuteMs:null,dispatchMs:0,validationMs:0,hostWorkMs:0,raiseResult:null},result:{operation,hostSession:session,value:body}};
}
async function timedOut(f,name){let error;try{await timeoutAfterPublication(options=>invokeWorkbench(name,input(name),options),{root:f.root,...control(name)});}catch(value){error=value;}
  const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');assert.equal(facts.requestIds.length,1);assert.ok(facts.receiptOwner);const [id]=facts.requestIds;assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[id+'.json']);return {id,owner:facts.receiptOwner};}

test('old host and malformed or caller-supplied approvals cannot publish',async t=>{
  for(const capability of [null,0,2]){const f=await fixture(t,capability);await assert.rejects(invokeWorkbench('revit_family_save_job',input('revit_family_save_job'),{root:f.root,...control('revit_family_save_job')}),error=>workbenchFailureEvidence(error).outcome==='not_started');assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);}
  const f=await fixture(t),name='revit_family_save_job';
  for(const change of [{approvedLifecycle:{schema_version:1,operation:'family_close_job',approval_token:token}},{approvedLifecycle:{schema_version:1,operation:'family_save_job',approval_token:'bad'}},{approvedFamilyIdentity:{...identity(name),job_handle:'other'}},{sourceDocument:undefined},{shouldContinue:undefined}])await assert.rejects(invokeWorkbench(name,input(name),{root:f.root,...control(name),...change}),error=>workbenchFailureEvidence(error).outcome==='not_started');
  await assert.rejects(invokeWorkbench(name,{...input(name),approved_lifecycle:control(name).approvedLifecycle},{root:f.root,...control(name)}));
  assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);
});

test('approval tokens can be requested only through trusted host-bound control',async t=>{
  const f=await fixture(t),name='revit_family_inspect_job';
  await assert.rejects(invokeWorkbench(name,{job_handle:'job-123',request_lifecycle_approval:true},{root:f.root}));
  await assert.rejects(invokeWorkbench(name,{job_handle:'job-123'},{root:f.root,requestLifecycleApproval:true}));
  assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);
  await assert.rejects(timeoutAfterPublication(options=>invokeWorkbench(name,{job_handle:'job-123'},options),{root:f.root,sourceDocument,shouldContinue:()=>true,requestLifecycleApproval:true}),/Revit response timeout/);
  const files=(await fs.readdir(path.join(f.queue,'inbox'))).filter(value=>value.endsWith('.json'));
  assert.equal(files.length,1);const request=JSON.parse(await fs.readFile(path.join(f.queue,'inbox',files[0]),'utf8'));
  assert.equal(request.args.request_lifecycle_approval,true);assert.equal(request.targetSession,session);
});

test('ordinary inspection never requests a token and unsupported hosts cannot request one',async t=>{
  const name='revit_family_inspect_job',f=await fixture(t);
  await assert.rejects(timeoutAfterPublication(options=>invokeWorkbench(name,{job_handle:'job-123'},options),{root:f.root}),/Revit response timeout/);
  const files=(await fs.readdir(path.join(f.queue,'inbox'))).filter(value=>value.endsWith('.json'));
  assert.equal(files.length,1);const request=JSON.parse(await fs.readFile(path.join(f.queue,'inbox',files[0]),'utf8'));
  assert.equal(Object.hasOwn(request.args,'request_lifecycle_approval'),false);
  for(const capability of [null,0,2]){const old=await fixture(t,capability);await assert.rejects(invokeWorkbench(name,{job_handle:'job-123'},{root:old.root,sourceDocument,shouldContinue:()=>true,requestLifecycleApproval:true}),error=>workbenchFailureEvidence(error).outcome==='not_started');assert.deepEqual(await fs.readdir(path.join(old.queue,'inbox')),[]);}
  for(const source of [{...sourceDocument,session:'f'.repeat(32)},{...sourceDocument,path:''}]){const bad=await fixture(t);await assert.rejects(invokeWorkbench(name,{job_handle:'job-123'},{root:bad.root,sourceDocument:source,shouldContinue:()=>true,requestLifecycleApproval:true}),error=>workbenchFailureEvidence(error).outcome==='not_started');assert.deepEqual(await fs.readdir(path.join(bad.queue,'inbox')),[]);}
});

for(const name of ['revit_family_save_job','revit_family_close_job'])test(`${name} retains its own late receipt and verified approval`,async t=>{
  const f=await fixture(t),{id,owner}=await timedOut(f,name),request=JSON.parse(await fs.readFile(path.join(f.queue,'inbox',id+'.json'),'utf8'));
  assert.deepEqual(request.args.approved_lifecycle,control(name).approvedLifecycle);
  await fs.writeFile(path.join(f.queue,'outbox',id+'.json'),JSON.stringify(receipt(id,name)));
  const result=owner.inspect();assert.equal(result.value.status,'received');assert.equal(result.value.terminal,true);assert.equal(result.value.evidence.jobHandle,'job-123');assert.equal(result.value.evidence.artifactSha256,saved.sha256);assert.equal(owner.close().value.closed,true);
});

for(const name of ['revit_family_save_job','revit_family_close_job'])test(`${name} hands the verified original receipt owner to its caller`,async t=>{
  const f=await fixture(t),pending=invokeWorkbench(name,input(name),{root:f.root,timeout:3000,...control(name)});let file;
  for(let i=0;i<100&&!file;i++){await new Promise(resolve=>setTimeout(resolve,10));file=(await fs.readdir(path.join(f.queue,'inbox'))).find(item=>item.endsWith('.json'));}
  assert.ok(file);await fs.writeFile(path.join(f.queue,'outbox',file),JSON.stringify(receipt(file.slice(0,-5),name)));
  const result=await pending;assert.ok(result.receiptOwner);assert.equal(Object.hasOwn(result.value.approval_validation,'approval_token'),false);assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(result.receiptOwner.close().value.closed,true);
});

test('close accepts unknown current template while retaining host, job and save checks',async t=>{
  const f=await fixture(t),name='revit_family_close_job',{id,owner}=await timedOut(f,name),file=path.join(f.queue,'outbox',id+'.json');
  for(const template of [null,{template_id:'metric-generic-model',sha256:null,state:'Missing'}]){const value=receipt(id,name);value.result.value.template=template;await fs.writeFile(file,JSON.stringify(value));assert.equal(owner.inspect().value.status,'received');}
  assert.equal(owner.close().value.closed,true);
});

test('stale native approval proves not started without implying a file was saved',async t=>{
  const f=await fixture(t),name='revit_family_save_job',{id,owner}=await timedOut(f,name),value=receipt(id,name);
  value.result.value.success=false;value.result.value.code='FAMILY_APPROVAL_STALE';value.result.value.outcome='not_started';value.result.value.approval_validation.verified=false;
  await fs.writeFile(path.join(f.queue,'outbox',id+'.json'),JSON.stringify(value));const checked=owner.inspect();assert.equal(checked.value.status,'not_started');assert.equal(checked.value.terminal,true);assert.equal(owner.close().value.closed,true);
});

for(const name of ['revit_family_save_job','revit_family_close_job'])test(`${name} keeps partial, changed or unverified facts unknown`,async t=>{
  const f=await fixture(t),{id,owner}=await timedOut(f,name),file=path.join(f.queue,'outbox',id+'.json');
  const changes=[v=>delete v.timing,v=>v.result.hostSession='bad',v=>v.result.value.revit_pid++,v=>v.result.value.job_handle='other',v=>v.result.value.project_fingerprint='other',v=>v.result.value.approval_validation.approval_token='f'.repeat(32),v=>v.result.value.approval_validation.verified=false,v=>v.result.value.cleanup_pending=true,v=>v.result.value.success=false,v=>v.result.value.effects.project_saved=true,v=>v.result.value.save.sha256='z'.repeat(64)];
  if(name==='revit_family_save_job')changes.push(v=>v.result.value.template.sha256='a'.repeat(64),v=>v.result.value.save.independently_reopened_verified=false,v=>v.result.value.save.path='not-absolute.rfa');else changes.push(v=>v.result.value.save.path='C:\\different.rfa');
  for(const mutate of changes){const value=receipt(id,name);mutate(value);await fs.writeFile(file,JSON.stringify(value));assert.equal(owner.inspect().value.status,'unconfirmed',mutate.toString());assert.equal(owner.inspect().value.terminal,false);}
  assert.equal(owner.close().value.closed,true);
});

test('revoked family lifecycle approval cannot publish a staged request',async t=>{
  const f=await fixture(t),name='revit_family_save_job';let allowed=true,error;try{await invokeWorkbench(name,input(name),{root:f.root,...control(name),shouldContinue:()=>allowed,onTiming:value=>{if(value.phase==='temp_ready')allowed=false;}});}catch(value){error=value;}
  assert.equal(workbenchFailureEvidence(error).outcome,'not_started');assert.equal((await fs.readdir(path.join(f.queue,'inbox'))).some(value=>value.endsWith('.json')),false);
});
