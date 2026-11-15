import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeWorkbench,workbenchFailureEvidence} from '../lib/workbench-client.mjs';
import {invokeModelCommand} from '../lib/model-tool-dispatch.mjs';
import {createModelPermissionOwner} from '../lib/model-permission-owner.mjs';
import {issueTypeWriteUserDecision,approvePreparedTypeWrite} from '../lib/type-parameter-write-approval.mjs';
import {loadNativeTypeParameterWriteProducer} from '../test-support/native-type-parameter-write-producer.mjs';
import {TYPE_TRANSPORT_DOCUMENT,typeTransportArguments,typeWriteQueueFixture,artificialTypeWriteApproval} from '../test-support/native-type-parameter-write-transport-fixtures.mjs';

const TOOL='revit_set_type_parameter',WRITE='set_type_parameter';
const writes=f=>f.requests.filter(request=>request.operation===WRITE);
const wait=async predicate=>{const end=Date.now()+6000;while(!predicate()){if(Date.now()>end)throw new Error('Type queue observation timeout');await new Promise(resolve=>setTimeout(resolve,5));}};
const approve=(args,prepared)=>approvePreparedTypeWrite(prepared,{args,sourceDocument:TYPE_TRANSPORT_DOCUMENT,deadline:Date.now()+50000});
function permission(f,args,prepared){
  const scope={client:'controlled',conversationId:'controlled-type-queue',generation:1,revision:1,account:'controlled',document:TYPE_TRANSPORT_DOCUMENT};
  const owner=createModelPermissionOwner({verifyDocument:async()=>true,invoke:async(name,chosen,control)=>{
    const value=await invokeWorkbench(name,chosen,f.options(control));f.remember(value.receiptOwner);return {ok:true,value,receiptOwner:value.receiptOwner};
  }});owner.setLevel({scope,level:'automatic',isCurrent:()=>true});
  const proposal=owner.propose({scope,callId:'controlled-type-call',tool:TOOL,parameters:args,reviewedTypeWrite:prepared,isCurrent:()=>true});
  return {owner,proposal,proof:()=>issueTypeWriteUserDecision({ticket:proposal.ticket,digest:proposal.digest,sourceDocument:TYPE_TRANSPORT_DOCUMENT,deadline:proposal.deadline})};
}

test('raw calls and forged approval objects cannot publish even with caller-supplied bound controls',async t=>{
  const f=await typeWriteQueueFixture(t),args=typeTransportArguments();
  for(const patch of [{},{approvedTypeWrite:{}},{approvedTypeWrite:Object.freeze({})},{approvedTypeWrite:{schema_version:1,token:'a'.repeat(32)}},
    {approvedTypeWrite:true},{approvedTypeWrite:JSON.parse(JSON.stringify(artificialTypeWriteApproval(args)))},
    {approvedTypeWrite:artificialTypeWriteApproval(args),retainReceiptOwner:false},{approvedTypeWrite:artificialTypeWriteApproval(args),shouldContinue:undefined},
    {approvedTypeWrite:artificialTypeWriteApproval(args),sourceDocument:undefined}]){
    await assert.rejects(invokeWorkbench(TOOL,args,f.options(patch)),error=>workbenchFailureEvidence(error).outcome==='not_started');await f.noRequests();
  }
});

test('old, incomplete and falsely typed host declarations reject both preparation and write before publication',async t=>{
  const f=await typeWriteQueueFixture(t),args=typeTransportArguments();
  for(const patch of [{version:'0.8.7'},{version:'0.8.8-preview'},{version:['0.8.8']},{version:'0.8.8.9007199254740992'},
    {nativeTypeParameterWritesVersion:undefined},{nativeTypeParameterWritesVersion:2},{nativeTypeParameterWritesVersion:'1'},
    {nativeTypeParameterWriteOperations:[]},{nativeTypeParameterWriteOperations:['set_parameter_value']},{nativeTypeParameterWriteOperations:[WRITE,WRITE]}]){
    await f.rewriteHost(patch);
    await assert.rejects(f.prepare(args),error=>workbenchFailureEvidence(error).outcome==='not_started');
    await assert.rejects(invokeWorkbench(TOOL,args,f.options({approvedTypeWrite:artificialTypeWriteApproval(args)})),error=>workbenchFailureEvidence(error).outcome==='not_started');
    await f.noRequests();
  }
});

test('default, workspace and read-only MCP plus direct manual dispatch cannot expose or authorize the type write',async t=>{
  const f=await typeWriteQueueFixture(t),args=typeTransportArguments();
  for(const flags of [[],['--workspace'],['--read-only']]){
    const {client}=await f.connect(flags),tools=(await client.listTools()).tools;assert.ok(!tools.some(item=>item.name===TOOL));
    assert.equal((await client.callTool({name:TOOL,arguments:args})).isError,true);await f.noRequests();
  }
  const result=await invokeModelCommand(TOOL,args,f.options({confirmed:true,approvedTypeWrite:artificialTypeWriteApproval(args)}));
  assert.equal(result.ok,false);await f.noRequests();
});

test('actual native preparations and three-storage writes cross the Node queue only after one user proof',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeTypeParameterWriteProducer(t);t.diagnostic(JSON.stringify(produce.sourceEvidence));
  for(const [storage,before,value] of [['Double',1,2],['Integer',1,2],['String','原值','新值']])for(const mode of ['rollback','commit']){
    const native=await produce.openSession({hostSession:TYPE_TRANSPORT_DOCUMENT.session,storage,before,value,mode});
    const f=await typeWriteQueueFixture(t,{nativeSession:native}),args=typeTransportArguments({mode,value,expected_state:{storage_type:storage,has_value:true,value_internal:before,data_type:storage==='Double'?'length':'text'}});
    if(storage!=='Double')delete args.value_unit;
    const read=await f.prepare(args);assert.ok(read.typeWritePreparation);assert.equal(Object.keys(read).includes('typeWritePreparation'),false);
    const preparation=f.observed[0].native.result.type_write_preparation;assert.equal(JSON.stringify(read).includes(preparation.token),false);assert.equal(JSON.stringify(read).includes('type_write_preparation'),false);
    assert.equal(f.observed[0].native.facts.SetCalls,0);assert.equal(writes(f).length,0);
    const p=permission(f,args,read.typeWritePreparation);assert.equal(p.proposal.requiresApproval,true);
    await assert.rejects(p.owner.decide({ticket:p.proposal.ticket,digest:p.proposal.digest,decision:'accept'}));assert.equal(writes(f).length,0);
    const decision=await p.owner.decide({ticket:p.proposal.ticket,digest:p.proposal.digest,decision:'accept',userDecisionProof:p.proof()});
    assert.equal(decision.status,'completed');const result=decision.result.value,actual=f.observed.at(-1).native;
    assert.equal(actual.ok,true,JSON.stringify(actual.error));assert.equal(actual.facts.SetCalls,1);assert.equal(result.value.target_kind,'type');assert.equal(result.value.before.value_internal,before);
    assert.equal(result.value.result.changes[0].after_internal,value);assert.equal(result.committed,mode==='commit');assert.equal(actual.after.parameters[0].value,mode==='commit'?value:before);
    assert.deepEqual(result.value.instance_ids,['100','101']);assert.equal(result.value.instance_count,2);assert.equal(JSON.stringify(result).includes(preparation.token),false);
    assert.equal(writes(f).length,1);assert.equal(f.requests.length,2);assert.deepEqual(writes(f)[0].args.approved_type_write,{schema_version:1,token:preparation.token});
    await assert.rejects(p.owner.decide({ticket:p.proposal.ticket,digest:p.proposal.digest,decision:'accept',userDecisionProof:p.proof()}));assert.equal(writes(f).length,1);
    const replay=await native.call({action:'write',args:writes(f)[0].args});assert.equal(replay.ok,false);assert.equal(replay.facts.SetCalls,1);
    assert.equal((await p.owner.close()).closed,true);await native.close();
  }
});

test('an approved capability cannot change arguments or enqueue a second request after consumption',async t=>{
  const f=await typeWriteQueueFixture(t),args=typeTransportArguments(),approved=artificialTypeWriteApproval(args);
  await assert.rejects(invokeWorkbench(TOOL,{...args,value:3},f.options({approvedTypeWrite:approved})),error=>workbenchFailureEvidence(error).outcome==='not_started');
  await assert.rejects(invokeWorkbench(TOOL,args,f.options({approvedTypeWrite:approved})),error=>workbenchFailureEvidence(error).outcome==='not_started');await f.noRequests();
});

test('mismatched success DTOs and transaction identity remain unknown against their original receipt',async t=>{
  const corruptions=[e=>{e.result.value.target_kind='instance';},e=>{e.result.value.before.value_internal=9;},e=>{e.result.value.instance_ids=['100'];},
    e=>{e.result.value.instance_count=1;},e=>{e.result.value.scope='all';},e=>{e.result.value.indirect_effects='assessed';},e=>{e.result.value.result.changes[0].after_internal=9;},
    e=>{e.result.value.result.changes[0].element_id='1001';},e=>{e.result.value.result.changes[0].changed=false;},e=>{e.result.committed=true;},e=>{e.result.operation='set_parameter_value';}];
  for(const alter of corruptions){
    const f=await typeWriteQueueFixture(t,{corrupt:(envelope,request)=>{if(request.operation===WRITE)alter(envelope);}}),args=typeTransportArguments();let owner;
    await assert.rejects(invokeWorkbench(TOOL,args,f.options({approvedTypeWrite:artificialTypeWriteApproval(args)})),error=>{
      const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=f.remember(facts.receiptOwner);return true;
    });
    const result=owner.inspect();assert.equal(result.ok,true);assert.equal(result.value.terminal,false);assert.equal(result.value.status,'unconfirmed');assert.equal(writes(f).length,1);
  }
});

test('actual native membership or raw-state drift after preparation refuses Set and keeps the write unknown',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeTypeParameterWriteProducer(t);
  for(const kind of ['add','remove','swap','value','owner']){
    const native=await produce.openSession({hostSession:TYPE_TRANSPORT_DOCUMENT.session}),f=await typeWriteQueueFixture(t,{nativeSession:native}),args=typeTransportArguments({mode:'commit'});
    const read=await f.prepare(args),approved=approve(args,read.typeWritePreparation);await native.call({action:'mutate',kind});let owner;
    await assert.rejects(invokeWorkbench(TOOL,args,f.options({approvedTypeWrite:approved})),error=>{const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=f.remember(facts.receiptOwner);return true;});
    const actual=f.observed.at(-1).native;assert.equal(actual.ok,false);assert.equal(actual.facts.SetCalls,0);assert.equal(actual.facts.GroupCommits,0);
    assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(writes(f).length,1);await native.close();
  }
});

test('a native permit expired by the real monotonic book cannot reach Set',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeTypeParameterWriteProducer(t),native=await produce.openSession({hostSession:TYPE_TRANSPORT_DOCUMENT.session}),f=await typeWriteQueueFixture(t,{nativeSession:native}),args=typeTransportArguments();
  const read=await f.prepare(args),approved=approve(args,read.typeWritePreparation);await native.call({action:'clock',ticks:120000});let owner;
  await assert.rejects(invokeWorkbench(TOOL,args,f.options({approvedTypeWrite:approved})),error=>{const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=f.remember(facts.receiptOwner);return true;});
  assert.equal(f.observed.at(-1).native.facts.SetCalls,0);assert.equal(owner.inspect().value.terminal,false);assert.equal(writes(f).length,1);await native.close();
});

test('a late actual write response resolves only the original unknown receipt and cannot reuse its capability',{skip:process.platform!=='win32'},async t=>{
  let release;const barrier=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const produce=await loadNativeTypeParameterWriteProducer(t),native=await produce.openSession({hostSession:TYPE_TRANSPORT_DOCUMENT.session}),f=await typeWriteQueueFixture(t,{nativeSession:native,writeBarrier:barrier}),args=typeTransportArguments();
  const read=await f.prepare(args),approved=approve(args,read.typeWritePreparation);let facts;
  const pending=invokeWorkbench(TOOL,args,f.options({approvedTypeWrite:approved,timeout:300})).catch(error=>{facts=workbenchFailureEvidence(error);});
  await wait(()=>f.observed.some(item=>item.operation===WRITE));await pending;assert.equal(facts.outcome,'unconfirmed');const owner=f.remember(facts.receiptOwner);assert.equal(owner.inspect().value.status,'pending');
  await assert.rejects(invokeWorkbench(TOOL,args,f.options({approvedTypeWrite:approved})),error=>workbenchFailureEvidence(error).outcome==='not_started');assert.equal(writes(f).length,1);
  release();await wait(()=>owner.inspect().value?.status==='received');const checked=owner.inspect();assert.equal(checked.value.terminal,true);assert.deepEqual(facts.requestIds,[writes(f)[0].id]);
  assert.equal(f.observed.at(-1).native.facts.SetCalls,1);assert.equal(writes(f).length,1);assert.equal(f.requests.length,2);await native.close();
});
