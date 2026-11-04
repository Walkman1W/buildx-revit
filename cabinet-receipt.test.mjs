import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {invokeModelCommand} from './lib/model-tool-dispatch.mjs';
import {createModelWorkspaceFixture} from './test-support/model-workspace-preview.mjs';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-cabinet-receipt-')),queue=path.join(root,'queue');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const name of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,name),{recursive:true});
  const host={sessionId:'e'.repeat(32),pid:process.pid,version:'0.6.6',startedUtc:new Date().toISOString(),familyCabinetContractVersion:1};
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify(host));return {root,queue,host};
}
const args={template_id:'metric-generic-model'};
const receipt=(f,id,extra={})=>({id,ok:true,completedUtc:new Date().toISOString(),result:{operation:'family_create_cabinet',hostSession:f.host.sessionId,value:{operation:'family_create_cabinet',host_session:f.host.sessionId,revit_pid:f.host.pid,success:true,code:'FAMILY_CREATED',outcome:'created_in_owned_family_document',job_handle:'owned-cabinet',cleanup_pending:false,...extra}}});
async function pendingOwner(f){
  try{await invokeWorkbench('revit_family_create_cabinet',args,{root:f.root,timeout:25,retainReceiptOwner:true});assert.fail('must not complete');}
  catch(error){const evidence=workbenchFailureEvidence(error);assert.equal(evidence.outcome,'unconfirmed');assert.equal(evidence.requestIds.length,1);assert.ok(evidence.receiptOwner);return {id:evidence.requestIds[0],owner:evidence.receiptOwner};}
}
test('timeout retains exact request, late success and unknown business outcomes without replay',async t=>{
  const f=await fixture(t),{id,owner}=await pendingOwner(f),file=path.join(f.queue,'outbox',id+'.json');
  assert.equal(owner.inspect().value.status,'pending');
  await fs.writeFile(file,JSON.stringify(receipt(f,id,{success:false,outcome:'unknown'})));
  let observed=owner.inspect().value;assert.equal(observed.status,'unconfirmed');assert.equal(observed.terminal,false);assert.equal(observed.canCheckAgain,true);assert.equal(observed.evidence.jobHandle,'owned-cabinet');
  await fs.writeFile(file,JSON.stringify(receipt(f,id)));
  observed=owner.inspect().value;assert.equal(observed.status,'received');assert.equal(observed.terminal,true);assert.equal(observed.evidence.jobHandle,'owned-cabinet');assert.equal(observed.canCheckAgain,false);
  assert.deepEqual((await fs.readdir(path.join(f.queue,'inbox'))).filter(x=>x.endsWith('.json')),[id+'.json']);assert.equal(owner.close().ok,true);
});
test('malformed, changed request or changed host cannot be adopted as a cabinet result',async t=>{
  const f=await fixture(t),{id,owner}=await pendingOwner(f),file=path.join(f.queue,'outbox',id+'.json');
  await fs.writeFile(file,'{bad');assert.equal(owner.inspect().ok,false);
  await fs.writeFile(file,JSON.stringify(receipt(f,id)));const hostPath=path.join(f.queue,'host.json');await fs.writeFile(hostPath,JSON.stringify({...f.host,sessionId:'f'.repeat(32)}));assert.equal(owner.inspect().value.status,'host_changed');assert.equal(owner.inspect().value.canCheckAgain,true);
  await fs.writeFile(hostPath,JSON.stringify(f.host));await fs.appendFile(path.join(f.queue,'inbox',id+'.json'),' ');assert.equal(owner.inspect().ok,false);assert.equal(owner.close().ok,true);
});
test('uncertain rename preserves the original owner even when publication occurred',async t=>{
  const f=await fixture(t),rename=fs.rename;let invoked=0;
  t.mock.method(fs,'rename',async(...args)=>{invoked++;await rename(...args);throw new Error('simulated unknown publication');});
  let facts;try{await invokeWorkbench('revit_family_create_cabinet',args,{root:f.root,timeout:25,retainReceiptOwner:true});assert.fail('must reject');}catch(error){facts=workbenchFailureEvidence(error);}
  assert.equal(invoked,1);assert.equal(facts.requestIds.length,1);assert.ok(facts.receiptOwner);assert.equal(facts.receiptOwner.inspect().value.status,'pending');assert.equal(facts.receiptOwner.close().ok,true);
});
test('failure envelope proves not started only with host and execution facts; started failure stays unknown',async t=>{
  const f=await fixture(t),{id,owner}=await pendingOwner(f),file=path.join(f.queue,'outbox',id+'.json');
  const failure={id,ok:false,hostSession:f.host.sessionId,completedUtc:new Date().toISOString(),error:{code:'ERROR',message:'fixture'},execution:{started:true,phase:'dispatch',reason:null}};
  await fs.writeFile(file,JSON.stringify(failure));assert.equal(owner.inspect().value.status,'unconfirmed');
  failure.execution={started:false,phase:'validation',reason:null};await fs.writeFile(file,JSON.stringify(failure));assert.equal(owner.inspect().value.status,'not_started');assert.equal(owner.inspect().value.terminal,true);
  failure.hostSession='0'.repeat(32);await fs.writeFile(file,JSON.stringify(failure));assert.equal(owner.inspect().ok,false);assert.equal(owner.close().ok,true);
});
test('failed descriptor cleanup remains with the exact cabinet owner',async t=>{
  const f=await fixture(t),{owner}=await pendingOwner(f),close=fsSync.closeSync;let fail=true;
  t.mock.method(fsSync,'closeSync',fd=>{if(fail){fail=false;throw new Error('simulated close failure');}return close(fd);});
  assert.equal(owner.inspect().error.code,'RECEIPT_CLEANUP_PENDING');assert.equal(owner.close().ok,true);
});
test('panel dispatcher retains receipt owner and request id across a cabinet timeout',async t=>{
  const f=await fixture(t),result=await invokeModelCommand('revit_family_create_cabinet',args,{root:f.root,timeout:25,confirmed:true});
  assert.equal(result.ok,false);assert.equal(result.error.outcome,'unconfirmed');assert.equal(result.evidence.requestIds.length,1);assert.ok(result.receiptOwner);
  const id=result.evidence.requestIds[0];await fs.writeFile(path.join(f.queue,'outbox',id+'.json'),JSON.stringify(receipt(f,id)));
  const checked=result.receiptOwner.inspect();assert.equal(checked.value.status,'received');assert.equal(checked.value.evidence.jobHandle,'owned-cabinet');assert.equal(result.receiptOwner.close().ok,true);
});
test('business failure inside an ok transport envelope keeps the owner for user inspection',async t=>{
  const f=await fixture(t),pending=invokeModelCommand('revit_family_create_cabinet',args,{root:f.root,timeout:2000,confirmed:true});
  let files=[];for(let i=0;i<100&&!files.length;i++){await new Promise(resolve=>setTimeout(resolve,10));files=(await fs.readdir(path.join(f.queue,'inbox'))).filter(name=>name.endsWith('.json'));}
  assert.equal(files.length,1);const id=files[0].slice(0,-5);await fs.writeFile(path.join(f.queue,'outbox',files[0]),JSON.stringify(receipt(f,id,{success:false,outcome:'unknown'})));
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.error.outcome,'unconfirmed');assert.equal(result.evidence.requestIds[0],id);assert.ok(result.receiptOwner);assert.equal(result.receiptOwner.inspect().value.evidence.jobHandle,'owned-cabinet');assert.equal(result.receiptOwner.close().ok,true);
});
test('successful cabinet create, save and close release their verified owner and allow subsequent commands',async t=>{
  const f=await fixture(t),seen=new Set();
  for(const [name,operation,input,outcome] of [
    ['revit_family_create_cabinet','family_create_cabinet',args,'created_in_owned_family_document'],
    ['revit_family_save_cabinet','family_save_cabinet',{job_handle:'owned-cabinet'},'file_persists_independently'],
    ['revit_family_close_cabinet','family_close_cabinet',{job_handle:'owned-cabinet'},'closed']]){
    const pending=invokeModelCommand(name,input,{root:f.root,timeout:2000,confirmed:true});let file;
    for(let i=0;i<100&&!file;i++){await new Promise(resolve=>setTimeout(resolve,10));file=(await fs.readdir(path.join(f.queue,'inbox'))).find(x=>x.endsWith('.json')&&!seen.has(x));}
    assert.ok(file);seen.add(file);const id=file.slice(0,-5),body=receipt(f,id,{outcome,save:{path:'D:/artifacts/cabinet.rfa',independently_reopened_verified:true}});
    body.result.operation=operation;body.result.value.operation=operation;await fs.writeFile(path.join(f.queue,'outbox',file),JSON.stringify(body));
    const result=await pending;assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.receiptOwner);assert.equal(result.receiptOwner.close().ok,true);
  }
});
test('a success arriving after cancellation retains the original owner and job receipt',async t=>{
  const f=await fixture(t);let current=true;
  const pending=invokeModelCommand('revit_family_create_cabinet',args,{root:f.root,timeout:2000,confirmed:true,shouldContinue:()=>current});let file;
  for(let i=0;i<100&&!file;i++){await new Promise(resolve=>setTimeout(resolve,10));file=(await fs.readdir(path.join(f.queue,'inbox'))).find(x=>x.endsWith('.json'));}
  assert.ok(file);current=false;const id=file.slice(0,-5);await fs.writeFile(path.join(f.queue,'outbox',file),JSON.stringify(receipt(f,id)));
  const result=await pending;assert.equal(result.ok,true);assert.ok(result.receiptOwner);const checked=result.receiptOwner.inspect();assert.equal(checked.value.status,'received');assert.equal(checked.value.evidence.jobHandle,'owned-cabinet');assert.equal(result.receiptOwner.close().ok,true);
});
test('only the original published job and host can seed a read-only recovery',async t=>{
  const f=await fixture(t);let facts;
  try{await invokeWorkbench('revit_family_save_cabinet',{job_handle:'original-job'},{root:f.root,timeout:25,retainReceiptOwner:true});assert.fail();}catch(error){facts=workbenchFailureEvidence(error);}
  assert.deepEqual(facts.receiptOwner.inspect().value.recovery,{jobHandle:'original-job',hostIdentity:{sessionId:f.host.sessionId,pid:f.host.pid,version:f.host.version,startedUtc:f.host.startedUtc}});
  const before=(await fs.readdir(path.join(f.queue,'inbox'))).length;
  await assert.rejects(invokeWorkbench('revit_family_inspect_job',{job_handle:'original-job'},{root:f.root,expectedHostIdentity:{...f.host,pid:f.host.pid+1}}),error=>workbenchFailureEvidence(error).outcome==='not_started');
  assert.equal((await fs.readdir(path.join(f.queue,'inbox'))).length,before);assert.equal(facts.receiptOwner.close().ok,true);
});
test('real transport success passes ownership to panel completion, allowing next command and close',async t=>{
  const f=await fixture(t),seen=new Set(),panel=await createModelWorkspaceFixture({profile:'model-workspace',required:false,cabinetFixtureTesting:true,invokeReadonlyCommand:(id,parameters,options)=>id==='document'?{ok:true,value:{command:id,requestIds:[],data:{}}}:invokeModelCommand(id,parameters,{...options,root:f.root,timeout:2000})});t.after(()=>panel.close());
  const snapshot=()=>panel.app.snapshot('model-test-client'),conversationId=snapshot().session.conversation.id;
  for(const [name,operation,input,outcome] of [
    ['revit_family_create_cabinet','family_create_cabinet',args,'created_in_owned_family_document'],
    ['revit_family_save_cabinet','family_save_cabinet',{job_handle:'owned-cabinet'},'file_persists_independently'],
    ['revit_family_close_cabinet','family_close_cabinet',{job_handle:'owned-cabinet'},'closed']]){
    const start=await panel.post('command',{conversationId,commandId:name,parameters:input,confirmed:true});assert.equal(start.status,202);let file;
    for(let i=0;i<100&&!file;i++){await new Promise(resolve=>setTimeout(resolve,10));file=(await fs.readdir(path.join(f.queue,'inbox'))).find(x=>x.endsWith('.json')&&!seen.has(x));}
    assert.ok(file);seen.add(file);const id=file.slice(0,-5),body=receipt(f,id,{outcome,save:{path:'D:/artifacts/cabinet.rfa',independently_reopened_verified:true}});body.result.operation=operation;body.result.value.operation=operation;await fs.writeFile(path.join(f.queue,'outbox',file),JSON.stringify(body));
    for(let i=0;i<300&&snapshot().busy;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(snapshot().command.status,'completed');
  }
  const next=await panel.post('command',{conversationId,commandId:'document',parameters:{}});assert.equal(next.status,202);for(let i=0;i<300&&snapshot().busy;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(snapshot().command.status,'completed');await panel.close();
});
test('real producer late success after stop is retained for original panel user to inspect',async t=>{
  const f=await fixture(t),panel=await createModelWorkspaceFixture({profile:'model-workspace',required:false,cabinetFixtureTesting:true,invokeReadonlyCommand:(id,parameters,options)=>invokeModelCommand(id,parameters,{...options,root:f.root,timeout:2000})});t.after(()=>panel.close());
  const snapshot=()=>panel.app.snapshot('model-test-client'),conversationId=snapshot().session.conversation.id,commandId='revit_family_create_cabinet';
  const start=await panel.post('command',{conversationId,commandId,parameters:args,confirmed:true});assert.equal(start.status,202);let file;
  for(let i=0;i<100&&!file;i++){await new Promise(resolve=>setTimeout(resolve,10));file=(await fs.readdir(path.join(f.queue,'inbox'))).find(x=>x.endsWith('.json'));}
  assert.ok(file);assert.equal((await panel.post('interrupt',{conversationId,executionId:start.body.executionId})).status,202);
  const id=file.slice(0,-5);await fs.writeFile(path.join(f.queue,'outbox',file),JSON.stringify(receipt(f,id)));
  for(let i=0;i<300&&snapshot().busy;i++)await new Promise(resolve=>setTimeout(resolve,10));const pending=snapshot().command;assert.equal(pending.status,'unknown');assert.equal(pending.canInspectReceipt,true);
  assert.equal((await panel.post('command/check',{conversationId,commandId,executionId:pending.executionId})).status,202);for(let i=0;i<300&&snapshot().busy;i++)await new Promise(resolve=>setTimeout(resolve,10));const checked=snapshot().command;assert.equal(checked.receiptCheck.evidence.jobHandle,'owned-cabinet');assert.equal(checked.canAcknowledgeReceipt,true);
  assert.equal((await panel.post('command/acknowledge',{conversationId,commandId,executionId:pending.executionId,revision:checked.receiptCheck.revision,confirmed:true})).status,200);await panel.close();
});
test('account invalidation after real dispatcher success and before panel delivery retains owner',async()=>{
  const code=`
    import assert from 'node:assert/strict'; import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
    import {invokeModelCommand} from './lib/model-tool-dispatch.mjs';import {createModelWorkspaceFixture} from './test-support/model-workspace-preview.mjs';
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'cabinet-handoff-')),queue=path.join(root,'queue');for(const name of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,name),{recursive:true});
    const host={sessionId:'e'.repeat(32),pid:process.pid,version:'0.6.6',startedUtc:new Date().toISOString(),familyCabinetContractVersion:1};await fs.writeFile(path.join(queue,'host.json'),JSON.stringify(host));
    let resume,notify,captured;const gate=new Promise(r=>resume=r),arrived=new Promise(r=>notify=r);
    const panel=await createModelWorkspaceFixture({profile:'model-workspace',required:false,cabinetFixtureTesting:true,invokeReadonlyCommand:async(id,parameters,options)=>{const result=await invokeModelCommand(id,parameters,{...options,root,timeout:2000});captured=result;notify();await gate;return result;}});
    const snapshot=()=>panel.app.snapshot('model-test-client'),conversationId=snapshot().session.conversation.id,commandId='revit_family_create_cabinet';
    assert.equal((await panel.post('command',{conversationId,commandId,parameters:{template_id:'metric-generic-model'},confirmed:true})).status,202);
    let file;for(let i=0;i<100&&!file;i++){await new Promise(r=>setTimeout(r,10));file=(await fs.readdir(path.join(queue,'inbox'))).find(x=>x.endsWith('.json'));}assert.ok(file);
    const id=file.slice(0,-5),value={operation:'family_create_cabinet',host_session:host.sessionId,revit_pid:host.pid,success:true,code:'OK',outcome:'created_in_owned_family_document',job_handle:'owned-cabinet',cleanup_pending:false};
    await fs.writeFile(path.join(queue,'outbox',file),JSON.stringify({id,ok:true,completedUtc:new Date().toISOString(),result:{operation:'family_create_cabinet',hostSession:host.sessionId,value}}));
    await arrived;assert.equal(captured.ok,true);assert.ok(captured.receiptOwner);
    panel.codex.emit('account-invalidated',{connectionGeneration:panel.codex.state.connectionGeneration});resume();
    for(let i=0;i<200&&snapshot().busy;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(captured.receiptOwner.inspect().value.evidence.jobHandle,'owned-cabinet');assert.equal(snapshot().command,null);
    const next=await panel.post('command',{conversationId:snapshot().session.conversation.id,commandId:'document',parameters:{}});assert.notEqual(next.status,202);
    process.exit(0);
  `;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{cwd:fileURLToPath(new URL('.',import.meta.url)),timeout:15000,windowsHide:true});
});
