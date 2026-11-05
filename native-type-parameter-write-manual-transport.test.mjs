import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadNativeTypeParameterWriteProducer} from './test-support/native-type-parameter-write-producer.mjs';
import {TYPE_TRANSPORT_DOCUMENT,typeTransportArguments} from './test-support/native-type-parameter-write-transport-fixtures.mjs';
import {manualTypeWriteTransportFixture,waitManualTypeWrite} from './test-support/native-type-parameter-write-manual-transport-fixtures.mjs';

const writes=f=>f.requests.filter(request=>request.operation==='set_type_parameter');
const nativeWrite=f=>f.observed.findLast(item=>item.operation==='set_type_parameter')?.native;
const terminalCommand=f=>['completed','unknown','failed','interrupted'].includes(f.snapshot().command?.status);
async function submitAndReview(f,args){
 assert.equal((await f.choose('automatic')).status,200);
 const started=await f.command(args);assert.equal(started.status,202,JSON.stringify(started.body));
 await waitManualTypeWrite(()=>Boolean(f.preview()));const preview=f.preview(),snapshot=f.snapshot();
 assert.equal(snapshot.command.executionId,started.body.executionId);assert.equal(snapshot.command.status,'running');assert.equal(snapshot.command.progress.phase,'awaiting_approval');
 assert.equal(preview.action,'revit_set_type_parameter');assert.equal(writes(f).length,0);assert.equal(f.invocations.length,0);assert.equal(f.observed[0].native.facts.SetCalls,0);assert.equal(f.codex.turnCalls,0);
 const token=f.observed[0].native.result.type_write_preparation.token;
 assert.equal(JSON.stringify(snapshot).includes(token),false);assert.equal(JSON.stringify(snapshot).includes('type_write_preparation'),false);
 return {started,preview,token};
}

test('manual HTTP decisions reach the same owner, real Node queue and persistent production C# book',{skip:process.platform!=='win32'},async t=>{
 const produce=await loadNativeTypeParameterWriteProducer(t);t.diagnostic(JSON.stringify(produce.sourceEvidence));
 const production=['lib/panel-server-core.mjs','lib/model-permission-owner.mjs','lib/model-permission-services.mjs','lib/workbench-client.mjs','lib/type-parameter-write-approval.mjs'];
 const sourceHashes=Object.fromEntries(await Promise.all(production.map(async name=>[name,createHash('sha256').update(await fs.readFile(new URL(name,import.meta.url))).digest('hex')])));
 t.diagnostic(JSON.stringify({manualTransportSourceSha256:sourceHashes,scope:'Actual loopback POST command/dynamic-approval, same production permission owner/services, Node queue/retained original receipt, persistent actual C# book/Host/impact/shared setter; controlled Codex/status/API peers, no AI turn or real Revit/model'}));
 for(const mode of ['rollback','commit'])await t.test('manual '+mode+' stays zero-Set until HTTP accept, then verifies all four phases exactly once',async t=>{
  const native=await produce.openSession({hostSession:TYPE_TRANSPORT_DOCUMENT.session}),f=await manualTypeWriteTransportFixture(t,{nativeSession:native});
  try{
   const args=typeTransportArguments({mode});if(mode==='rollback')delete args.mode;
   const {started,preview,token}=await submitAndReview(f,args),review=JSON.parse(preview.typeParameterReview);
   assert.equal(review.mode,mode);assert.deepEqual(review.instance_ids,['100','101']);
   assert.equal((await f.decide(preview)).status,200);await waitManualTypeWrite(()=>terminalCommand(f));
   const snapshot=f.snapshot(),command=snapshot.command,actual=nativeWrite(f),result=command.result?.data;
   assert.equal(command.executionId,started.body.executionId);assert.equal(command.status,'completed',JSON.stringify(command));
   assert.equal(actual.ok,true,JSON.stringify(actual.error));assert.equal(actual.facts.SetCalls,1);assert.equal(actual.facts.captures,5);assert.equal(actual.facts.InnerCommits,1);assert.equal(actual.facts.GroupCommits,mode==='commit'?1:0);assert.equal(actual.facts.GroupRollbacks,mode==='rollback'?1:0);
   assert.equal(actual.after.parameters[0].value,mode==='commit'?2:1);assert.equal(result.committed,mode==='commit');
   assert.deepEqual(result.value.before,{storage_type:'Double',has_value:true,value_internal:1,data_type:'length'});
   assert.equal(result.value.target_kind,'type');assert.deepEqual(result.value.instance_ids,['100','101']);assert.equal(result.value.result.changes[0].after_internal,2);
   assert.equal(f.invocations.length,1);assert.equal(f.invocations[0].retainReceiptOwner,true);assert.equal(writes(f).length,1);assert.equal(f.requests.length,2);assert.equal(f.codex.turnCalls,0);assert.equal(actual.facts.realRevitExecuted,false);
   assert.equal(JSON.stringify(snapshot).includes(token),false);assert.equal((await f.decide(preview)).status,409);assert.equal(writes(f).length,1);assert.equal((await native.call({action:'facts'})).facts.SetCalls,1);
  }finally{await f.close();await native.close();}
 });
 for(const drift of ['add','value'])await t.test('actual '+drift+' drift between manual preview and HTTP acceptance stays unknown with zero Set',async t=>{
  const native=await produce.openSession({hostSession:TYPE_TRANSPORT_DOCUMENT.session}),f=await manualTypeWriteTransportFixture(t,{nativeSession:native,unconfirmedDriftEvidence:drift});
  try{
   const {preview}=await submitAndReview(f,typeTransportArguments({mode:'commit'}));assert.equal((await native.call({action:'mutate',kind:drift})).ok,true);
   assert.equal((await f.decide(preview)).status,200);await waitManualTypeWrite(()=>terminalCommand(f)&&Boolean(f.snapshot().modelReceipt));
   const snapshot=f.snapshot(),actual=nativeWrite(f);assert.equal(snapshot.command.status,'unknown');assert.equal(snapshot.command.canInspectReceipt,false);assert.equal(actual.ok,false);assert.equal(actual.facts.SetCalls,0);assert.equal(actual.facts.GroupCommits,0);assert.equal(writes(f).length,1);
   const receipt=snapshot.modelReceipt;assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:receipt.ticket})).status,200);
   const checked=f.snapshot().modelReceipt;assert.equal(checked.check.terminal,false);assert.equal(checked.check.requestId,writes(f)[0].id);assert.equal(checked.check.status,'unconfirmed');
   assert.equal((await f.decide(preview)).status,409);assert.equal(writes(f).length,1);assert.equal(f.codex.turnCalls,0);
  }finally{await f.close();await native.close();}
 });
 await t.test('late manual response is reconciled only through its original permission receipt without a second write',async t=>{
  let release;const barrier=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const native=await produce.openSession({hostSession:TYPE_TRANSPORT_DOCUMENT.session}),f=await manualTypeWriteTransportFixture(t,{nativeSession:native,writeBarrier:barrier,writeTimeout:500});
  try{
   const {preview}=await submitAndReview(f,typeTransportArguments());assert.equal((await f.decide(preview)).status,200);
   await waitManualTypeWrite(()=>terminalCommand(f)&&Boolean(f.snapshot().modelReceipt)&&Boolean(nativeWrite(f)));
   const snapshot=f.snapshot(),receipt=snapshot.modelReceipt,id=writes(f)[0].id;assert.equal(snapshot.command.status,'unknown');assert.equal(snapshot.command.canInspectReceipt,false);assert.equal(nativeWrite(f).facts.SetCalls,1);assert.equal(nativeWrite(f).facts.captures,5);
   assert.equal((await f.decide(preview)).status,409);assert.equal(writes(f).length,1);release();
   await waitManualTypeWrite(async()=>Boolean((await fs.readdir(path.join(f.queue,'outbox'))).includes(id+'.json')));
   assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:receipt.ticket})).status,200);
   const checked=f.snapshot().modelReceipt;assert.equal(checked.check.terminal,true);assert.equal(checked.check.status,'received');assert.equal(checked.check.requestId,id);
   assert.equal((await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket:receipt.ticket,checkRevision:checked.checkRevision,confirmed:true})).status,200);
   assert.equal(f.snapshot().modelReceipt,null);assert.equal(writes(f).length,1);assert.equal(f.requests.length,2);assert.equal((await native.call({action:'facts'})).facts.SetCalls,1);assert.equal(f.codex.turnCalls,0);
  }finally{release();await f.close();await native.close();}
 });
});
