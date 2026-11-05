import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {loadNativeParameterWriteProducer} from './test-support/native-parameter-write-producer.mjs';
import {BATCH_TOOL,BATCH_OPERATION,SOURCE_DOCUMENT,batchArguments,batchChange,batchValue,batchEnvelope,
  parameterWritePolicyFixture,assertNoBatchPublication,replacePolicyHost} from './test-support/parameter-write-instance-policy-fixtures.mjs';

const rejectedHosts=[{version:'0.8.3'},{version:'0.8.6'},{version:'0.8.7-preview'},{version:'0.8.7\n'},
  {version:['0.8.7']},{version:'9007199254740992.0.0'},{version:'0.8.7.9007199254740992'},
  {parameterWriteTargetPolicyVersion:undefined},{parameterWriteTargetPolicyVersion:0},{parameterWriteTargetPolicyVersion:2},
  {parameterWriteTargetPolicyVersion:'1'},{parameterWriteTargetPolicyVersion:true},
  {parameterWriteTargetPolicy:undefined},{parameterWriteTargetPolicy:'instance_and_type'},{parameterWriteTargetPolicy:'Instance_Only'}];

test('old, incomplete or spoofed policy hosts refuse both raw and retained batches before UUID preparation',async t=>{
  const f=await parameterWritePolicyFixture(t),events=[];
  for(const patch of rejectedHosts){
    await replacePolicyHost(f,patch);
    for(const options of [{root:f.root,timeout:100,onTiming:event=>events.push(event)},f.options({onTiming:event=>events.push(event)})]){
      await assert.rejects(invokeWorkbench(BATCH_TOOL,batchArguments(),options),error=>{
        const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'not_started');assert.deepEqual(facts.requestIds,[]);
        assert.equal(facts.receiptOwner,undefined);assert.equal(facts.unpublishedRequest,undefined);return true;
      });
      await assertNoBatchPublication(f);
      assert.ok(events.every(event=>event.phase==='transport_finished'&&event.outcome==='not_started'&&event.requestId===undefined));
    }
  }
});

test('raw legacy MCP uses the same admission gate while both read profiles continue to exclude the batch',async t=>{
  const f=await parameterWritePolicyFixture(t),{client}=await f.connect(),catalog=(await client.listTools()).tools;
  const entry=catalog.find(item=>item.name===BATCH_TOOL);assert.ok(entry);assert.equal(entry.annotations.readOnlyHint,false);
  assert.match(entry.description,/instance_only/);assert.equal(entry.outputSchema,undefined);
  for(const patch of rejectedHosts){
    await replacePolicyHost(f,patch);
    const result=await client.callTool({name:BATCH_TOOL,arguments:batchArguments()});assert.equal(result.isError,true);
    assert.deepEqual(result.structuredContent,{buildxToolOutcome:{schemaVersion:1,outcome:'not_started'}});await assertNoBatchPublication(f);
  }
  for(const flags of [['--read-only'],['--workspace']]){
    const read=await f.connect(flags),tools=(await read.client.listTools()).tools;
    assert.ok(!tools.some(item=>item.name===BATCH_TOOL));
    assert.equal((await read.client.callTool({name:BATCH_TOOL,arguments:batchArguments()})).isError,true);await assertNoBatchPublication(f);
  }
  await replacePolicyHost(f,{});
  const success=await client.callTool({name:BATCH_TOOL,arguments:batchArguments()});assert.equal(success.isError,false);
  assert.equal(success.structuredContent,undefined);const value=JSON.parse(success.content[0].text);
  assert.equal(value.operation,BATCH_OPERATION);assert.equal(value.mode,'rollback');assert.equal(value.committed,false);
  assert.deepEqual(value.value,batchValue(batchArguments()));assert.equal(f.requests.length,1);
});

test('valid legacy raw rollback and retained commit preserve the old wire DTO and original receipt',async t=>{
  const f=await parameterWritePolicyFixture(t);
  const raw=await invokeWorkbench(BATCH_TOOL,batchArguments(),{root:f.root,timeout:3000});
  assert.equal(raw.mode,'rollback');assert.equal(raw.committed,false);assert.equal(raw.receiptOwner,undefined);
  assert.deepEqual(raw.value,batchValue(batchArguments()));assert.equal(f.requests.length,1);
  const args=batchArguments({mode:'commit'}),retained=await invokeWorkbench(BATCH_TOOL,args,f.options());f.remember(retained.receiptOwner);
  assert.equal(retained.committed,true);assert.deepEqual(f.requests[1].args,args);
  const checked=retained.receiptOwner.inspect();assert.equal(checked.ok,true);assert.equal(checked.value.status,'received');assert.equal(checked.value.terminal,true);
  assert.equal(f.requests.length,2);assert.ok(f.requests.every(request=>request.operation===BATCH_OPERATION&&!Object.hasOwn(request.args,'parameterWriteTargetPolicy')));
});

test('string or unsafe legacy IDs, name/type aliases and caller policy claims cannot publish a batch',async t=>{
  const f=await parameterWritePolicyFixture(t);
  for(const args of [batchArguments({type_id:200}),batchArguments({parameterWriteTargetPolicy:'instance_only'}),batchArguments({ack:true}),
    batchArguments({changes:[batchChange({element_id:'100'})]}),batchArguments({changes:[batchChange({element_id:9007199254740992})]}),
    batchArguments({changes:[batchChange({parameter_id:'-123'})]}),batchArguments({changes:[batchChange({parameter_name:'Width'})]}),
    batchArguments({changes:[]}),batchArguments({changes:Array.from({length:51},()=>batchChange())})]){
    await assert.rejects(invokeWorkbench(BATCH_TOOL,args,f.options()));await assertNoBatchPublication(f);
  }
});

test('wrong identities, typed readbacks or transaction facts stay unknown and retain only the original request',async t=>{
  const corruptions=[envelope=>{envelope.result.value.changes[0].element_id=101;},envelope=>{envelope.result.value.changes[0].parameter_id=2;},
    envelope=>{envelope.result.value.changes[0].element_id='100';},envelope=>{envelope.result.value.changes[0].after_internal=3;},
    envelope=>{envelope.result.value.changes[0].changed=false;},envelope=>{envelope.result.value.updated_count=2;},
    envelope=>{envelope.result.committed=true;},envelope=>{envelope.result.operation='execute_csharp';},envelope=>{envelope.timing.hostSession='e'.repeat(32);}];
  for(const corrupt of corruptions){
    const f=await parameterWritePolicyFixture(t,{corrupt});let owner;
    await assert.rejects(invokeWorkbench(BATCH_TOOL,batchArguments(),f.options()),error=>{
      const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=f.remember(facts.receiptOwner);
      assert.deepEqual(facts.requestIds,[f.requests[0].id]);return true;
    });
    const result=owner.inspect();assert.equal(result.ok,true);assert.equal(result.value.status,'unconfirmed');assert.equal(result.value.terminal,false);
    assert.equal(f.requests.length,1);
  }
  const raw=await parameterWritePolicyFixture(t,{corrupt:envelope=>{envelope.result.value.changes[0].after_internal=3;}});
  await assert.rejects(invokeWorkbench(BATCH_TOOL,batchArguments(),{root:raw.root,timeout:3000}),error=>workbenchFailureEvidence(error).outcome==='unconfirmed');
  assert.equal(raw.requests.length,1);
});

test('a timed out batch reconciles its late original receipt without publishing any replacement operation',async t=>{
  const f=await parameterWritePolicyFixture(t,{respond:false});let facts;
  await assert.rejects(invokeWorkbench(BATCH_TOOL,batchArguments(),f.options({timeout:35})),error=>{facts=workbenchFailureEvidence(error);return facts.outcome==='unconfirmed';});
  assert.equal(f.requests.length,1);const owner=f.remember(facts.receiptOwner);assert.ok(owner);
  const pending=owner.inspect();assert.equal(pending.ok,true);assert.equal(pending.value.status,'pending');assert.equal(pending.value.terminal,false);
  await f.publish(f.requests[0]);const checked=owner.inspect();assert.equal(checked.ok,true);assert.equal(checked.value.status,'received');assert.equal(checked.value.terminal,true);
  assert.deepEqual(facts.requestIds,[f.requests[0].id]);assert.equal(f.requests.length,1);
  assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);
  assert.deepEqual(await fs.readdir(path.join(f.queue,'processing')),[f.requests[0].id+'.json']);
});

test('actual C# three-storage instance batches keep default rollback, explicit commit and verified original receipts',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t),evidence=produce.sourceEvidence;
  t.diagnostic(JSON.stringify({actionsSha256:evidence.actionsSha256,hostSha256:evidence.hostSha256,peersSha256:evidence.peersSha256,generatedSha256:evidence.generatedSha256,scope:evidence.scope}));
  for(const [storage,before,wanted] of [['Double',1,2],['Integer',1,2],['String','原值','新值中文']])for(const mode of [undefined,'commit']){
    const args=batchArguments({changes:[{element_id:100,parameter_id:1,value:wanted,...storage==='Double'?{value_unit:'internal'}:{}}],...mode?{mode}:{}});
    let observed;
    const f=await parameterWritePolicyFixture(t,{respondEnvelope:async request=>{
      observed=await produce({parameters:[{id:1,storage,value:before,behavior:'falseApplied'}],args:request.args});
      assert.equal(observed.ok,true,JSON.stringify(observed.error));const envelope=batchEnvelope(request,{value:observed.result.value});envelope.result=observed.result;return envelope;
    }});
    const result=await invokeWorkbench(BATCH_TOOL,args,f.options());f.remember(result.receiptOwner);
    assert.equal(result.mode,mode??'rollback');assert.equal(result.committed,mode==='commit');assert.equal(result.value.updated_count,1);
    assert.deepEqual(result.value.changes[0],{element_id:100,parameter_id:1,storage_type:storage,data_type:storage==='Double'?'length':'text',changed:true,before_internal:before,after_internal:wanted});
    assert.equal(observed.after.parameters[0].value,mode==='commit'?wanted:before);assert.equal(observed.after.parameters[0].SetCalls,1);
    assert.equal(observed.transactions.GroupCommits,mode==='commit'?1:0);assert.equal(observed.transactions.GroupRollbacks,mode==='commit'?0:1);
    assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(f.requests.length,1);
  }
});

test('actual C# rejects an ElementType at the start, middle or end of a full batch with zero Set calls',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);
  for(const position of [0,24,49]){
    const elements=Array.from({length:50},(_,index)=>({id:100+index,isType:index===position,parameters:[{id:1,storage:'Double',value:1}]}));
    const changes=elements.map(element=>batchChange({element_id:element.id}));let observed;
    const f=await parameterWritePolicyFixture(t,{respondEnvelope:async request=>{
      observed=await produce({elements,args:request.args});assert.equal(observed.ok,false);assert.equal(observed.result,null);
      assert.match(observed.error.message,/instance|ElementType/i);
      return batchEnvelope(request,{value:null,failure:{error:{code:observed.error.type,message:observed.error.message},execution:{started:true,phase:'dispatch',reason:null}}});
    }});
    let owner;
    await assert.rejects(invokeWorkbench(BATCH_TOOL,batchArguments({mode:'commit',changes}),f.options()),error=>{
      const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=f.remember(facts.receiptOwner);return true;
    });
    assert.equal(observed.transactions.SetAttempts,0);assert.equal(observed.after.parameters.reduce((total,row)=>total+row.SetCalls,0),0);
    assert.deepEqual(observed.after.parameters.map(row=>row.value),observed.before.parameters.map(row=>row.value));
    assert.equal(observed.after.IsModified,observed.before.IsModified);assert.equal(observed.transactions.GroupCommits,0);assert.equal(observed.transactions.InnerCommits,0);
    const checked=owner.inspect();assert.equal(checked.ok,true);assert.equal(checked.value.status,'unconfirmed');assert.equal(checked.value.terminal,false);
    assert.equal(Object.hasOwn(checked.value.evidence,'transaction'),false);assert.equal(Object.hasOwn(checked.value.evidence,'rolledBack'),false);
    assert.equal(f.requests.length,1);
  }
});

test('actual C# rechecks a later target changed by the first Set and Node preserves the original unknown receipt',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);
  for(const action of ['ownerType','ownerOtherDocument','replaceTypeSource']){
    const elements=[{id:100,isType:false,parameters:[{id:1,storage:'Double',value:1,onSet:{element_id:101,parameter_id:1,action}}]},
      {id:101,isType:false,parameters:[{id:1,storage:'Double',value:1}]}];let observed;
    const f=await parameterWritePolicyFixture(t,{respondEnvelope:async request=>{
      observed=await produce({elements,args:request.args});assert.equal(observed.ok,false);assert.equal(observed.result,null);
      return batchEnvelope(request,{value:null,failure:{error:{code:observed.error.type,message:observed.error.message},execution:{started:true,phase:'dispatch',reason:null}}});
    }});
    let owner;
    await assert.rejects(invokeWorkbench(BATCH_TOOL,batchArguments({mode:'commit',changes:[batchChange(),batchChange({element_id:101})]}),f.options()),error=>{
      const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=f.remember(facts.receiptOwner);return true;
    });
    assert.equal(observed.transactions.SetAttempts,1);assert.equal(observed.transactions.GroupCommits,0);
    assert.deepEqual(observed.after.parameters.map(row=>row.value),observed.before.parameters.map(row=>row.value));
    const checked=owner.inspect();assert.equal(checked.ok,true);assert.equal(checked.value.status,'unconfirmed');assert.equal(checked.value.terminal,false);
    assert.equal(f.requests.length,1);
  }
});
