import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';

const sessionId='a'.repeat(32);
const document={session:sessionId,path:'C:\\sample.rvt',title:'sample'};
const writeArgs={expected_document:document.path,element_ids:[3],delta_mm:{x:1,y:0,z:0},mode:'commit'};

async function fixture(t,queueSettlementVersion=1){
  const temp=path.resolve(os.tmpdir());
  const root=await fs.mkdtemp(path.join(temp,'buildx-queue-settlement-'));
  assert.equal(path.dirname(root),temp);
  assert.ok(path.basename(root).startsWith('buildx-queue-settlement-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const queue=path.join(root,'queue');
  for(const name of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,name),{recursive:true});
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId,pid:process.pid,version:'0.8.9',queueSettlementVersion}));
  return {root,queue,inbox:path.join(queue,'inbox')};
}

async function waitFor(read){
  const end=Date.now()+3000;
  while(Date.now()<end){
    const result=await read();
    if(result)return result;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Expected fixture state before deadline');
}

function queueReceipt(id,reason){
  const stamp=new Date().toISOString();
  return {id,ok:false,hostSession:sessionId,completedUtc:stamp,
    execution:{started:false,phase:'queue',reason},
    error:{code:'WORKBENCH_REQUEST_'+reason.toUpperCase(),message:`Request ${reason} before execution`},
    timing:{schemaVersion:2,requestId:id,hostSession:sessionId,settledUtc:stamp,observedUtc:stamp,
      raiseReturnedUtc:stamp,schedulerCorrelation:'matched',raiseResult:'Accepted',observedToSettlementMs:1000}};
}

test('a slow staging write cannot publish a Revit request whose deadline has elapsed',async t=>{
  const {root,inbox}=await fixture(t);
  const write=fs.writeFile;
  const realNow=Date.now;
  let stagingFinished=false;
  t.mock.method(Date,'now',()=>realNow()+(stagingFinished?5000:0));
  t.mock.method(fs,'writeFile',async(file,...args)=>{
    await write(file,...args);
    if(path.dirname(file)===inbox)stagingFinished=true;
  });

  const error=await invokeWorkbench('revit_workbench_status',{}, {root,timeout:1000}).then(()=>assert.fail('Expected timeout'),error=>error);
  assert.equal(workbenchFailureEvidence(error).outcome,'not_started');
  assert.equal(error.published,false);
  assert.ok(error.unpublishedRequest);
  assert.deepEqual(await fs.readdir(inbox),[path.basename(error.unpublishedRequest.tempPath)]);
});

test('a stopped write publishes one session-bound intent and waits for proof on its original ID',async t=>{
  const {root,queue,inbox}=await fixture(t);
  const timing=[];
  let current=true;
  const result=invokeWorkbench('revit_move_elements',writeArgs,{root,timeout:2500,sourceDocument:document,retainReceiptOwner:true,
    shouldContinue:()=>current,onTiming:event=>{timing.push(event);if(event.phase==='published')current=false;}}).then(()=>assert.fail('Expected cancellation'),error=>error);
  const name=await waitFor(async()=> (await fs.readdir(inbox)).find(entry=>entry.endsWith('.json')));
  const id=path.basename(name,'.json');
  const cancelDir=path.join(queue,'cancel');
  const marker=await waitFor(()=>fs.readFile(path.join(cancelDir,name),'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;}));
  assert.deepEqual(JSON.parse(marker),{schema_version:1,request_id:id,target_session:sessionId});
  const confirmation=queueReceipt(id,'cancelled');
  await fs.rename(path.join(inbox,name),path.join(queue,'processing',name));
  await fs.writeFile(path.join(queue,'outbox',name),JSON.stringify(confirmation));

  const failure=workbenchFailureEvidence(await result);
  assert.equal(failure.outcome,'not_started');
  assert.deepEqual(failure.requestIds,[id]);
  assert.equal(failure.nativeFailure.started,false);
  assert.equal(failure.nativeFailure.reason,'cancelled');
  assert.equal(failure.receiptOwner.inspect().value.terminal,true);
  assert.equal(failure.receiptOwner.close().ok,true);
  assert.equal(timing.filter(event=>event.phase==='cancellation_requested').length,1);
  const observed=timing.find(event=>event.phase==='receipt_received');
  assert.equal(observed.hostObservedToQueueSettlementMs,1000);
  assert.equal(observed.hostDispatchMs,undefined);
  assert.deepEqual(await fs.readdir(inbox),[]);
});

test('a queue expiry is accepted only with producer timing and an unchanged original receipt identity',async t=>{
  for(const kind of ['valid','foreign','missing_timing','legacy_host'])await t.test(kind,async t=>{
    const {root,queue,inbox}=await fixture(t,kind==='legacy_host'?0:1);
    const result=invokeWorkbench('revit_workbench_status',{}, {root,timeout:2000}).then(()=>assert.fail('Expected rejection'),error=>error);
    const filename=await waitFor(async()=> (await fs.readdir(inbox)).find(entry=>entry.endsWith('.json')));
    const id=path.basename(filename,'.json');
    const receipt=queueReceipt(id,'expired');
    if(kind==='foreign')receipt.timing.hostSession='b'.repeat(32);
    if(kind==='missing_timing')delete receipt.timing;
    await fs.rename(path.join(inbox,filename),path.join(queue,'processing',filename));
    await fs.writeFile(path.join(queue,'outbox',filename),JSON.stringify(receipt));
    const failure=workbenchFailureEvidence(await result);
    assert.equal(failure.outcome,kind==='valid'?'expired':'unconfirmed');
    assert.deepEqual(failure.requestIds,[id]);
  });
});

test('a cancellation marker alone never establishes that a published write stopped',async t=>{
  const {root,queue}=await fixture(t);
  let current=true;
  const error=await invokeWorkbench('revit_move_elements',writeArgs,{root,timeout:750,sourceDocument:document,retainReceiptOwner:true,
    shouldContinue:()=>current,onTiming:event=>{if(event.phase==='published')current=false;}}).then(()=>assert.fail('Expected timeout'),error=>error);
  const failure=workbenchFailureEvidence(error);
  assert.equal(failure.outcome,'unconfirmed');
  const [id]=failure.requestIds;
  assert.deepEqual(await fs.readdir(path.join(queue,'cancel')),[id+'.json']);
  assert.equal(failure.receiptOwner.inspect().value.terminal,false);
  assert.equal(failure.receiptOwner.close().ok,true);
});
