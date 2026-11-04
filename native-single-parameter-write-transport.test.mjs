import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {invokeWorkbench,invokeReadonlyPanelCommand,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {createModelPermissionOwner} from './lib/model-permission-owner.mjs';
import {createModelPermissionServices} from './lib/model-permission-services.mjs';
import {loadNativeParameterWriteProducer} from './test-support/native-parameter-write-producer.mjs';
import {WRITE_TOOL,WRITE_OPERATION,SOURCE_DOCUMENT,writeState,writeChange,writeArguments,writeValue,singleParameterWriteFixture} from './test-support/native-single-parameter-write-fixtures.mjs';

const scope=()=>({client:'controlled-client',conversationId:'controlled-conversation',generation:1,revision:1,account:'controlled-account',document:{...SOURCE_DOCUMENT}});
function permission(f,{level='confirm',current=()=>true}={}){
  const services=createModelPermissionServices({invoke:async(name,args,control)=>{
    try{const value=await invokeWorkbench(name,args,f.options(control));f.remember(value.receiptOwner);return value;}
    catch(error){f.remember(workbenchFailureEvidence(error).receiptOwner);throw error;}
  }});
  const owner=createModelPermissionOwner({invoke:services.invoke,verifyDocument:async value=>['session','path','title'].every(key=>value[key]===SOURCE_DOCUMENT[key])});
  owner.setLevel({level,scope:scope(),isCurrent:current});
  const propose=(parameters=writeArguments(),callId='controlled-call')=>owner.propose({scope:scope(),callId,tool:WRITE_TOOL,parameters,isCurrent:current});
  return {owner,propose};
}
const noPublished=async f=>{assert.equal(f.requests.length,0);assert.equal((await fs.readdir(f.queue+'/inbox')).filter(file=>file.endsWith('.json')).length,0);};

test('unbound raw calls cannot publish the named write without all three trusted controls',async t=>{
  const f=await singleParameterWriteFixture(t);
  for(const patch of [{retainReceiptOwner:undefined},{retainReceiptOwner:false},{retainReceiptOwner:1},
    {sourceDocument:undefined},{sourceDocument:null},{sourceDocument:{}},{sourceDocument:{...SOURCE_DOCUMENT,session:'d'.repeat(32)}},
    {sourceDocument:{...SOURCE_DOCUMENT,path:'D:\\other.rvt'}},{sourceDocument:{...SOURCE_DOCUMENT,title:''}},
    {shouldContinue:undefined},{shouldContinue:true}]){
    await assert.rejects(invokeWorkbench(WRITE_TOOL,writeArguments(),f.options(patch)),error=>workbenchFailureEvidence(error).outcome==='not_started');
    await noPublished(f);
  }
});

test('old or incompletely advertised hosts are refused before publishing a guarded write',async t=>{
  for(const hostPatch of [{version:'0.8.4'},{version:'0.8.5-preview'},{nativeParameterWritesVersion:undefined},
    {nativeParameterWritesVersion:2},{nativeParameterWriteOperations:[]},{nativeParameterWriteOperations:['set_parameters']},
    {nativeParameterWriteOperations:[WRITE_OPERATION,WRITE_OPERATION]}]){
    const f=await singleParameterWriteFixture(t,{hostPatch});
    await assert.rejects(invokeWorkbench(WRITE_TOOL,writeArguments(),f.options()),error=>workbenchFailureEvidence(error).outcome==='not_started');await noPublished(f);
  }
});

test('malformed guards, duplicate rows and unit guessing fail before any mutation request',async t=>{
  const f=await singleParameterWriteFixture(t);
  for(const args of [writeArguments({changes:[]}),writeArguments({changes:[writeChange(),writeChange()]}),
    writeArguments({changes:[writeChange({value_unit:'mm'})]}),
    writeArguments({changes:[writeChange({expected_state:writeState({has_value:false})})]}),
    writeArguments({changes:[writeChange({parameter_id:'-1'})]}),
    writeArguments({changes:[writeChange({element_id:9007199254740992})]}),
    writeArguments({changes:[writeChange({parameter_name:'Width'})]})]){
    await assert.rejects(invokeWorkbench(WRITE_TOOL,args,f.options()),error=>workbenchFailureEvidence(error).outcome==='not_started');await noPublished(f);
  }
});

test('valid commit, default rollback and no-op results retain the exact guarded request and original receipt',async t=>{
  for(const [storage_type,before,value,data_type,mode] of [['Double',1,2,'length',undefined],['Integer',1,2,null,'commit'],['String','same','same','text','commit']]){
    const f=await singleParameterWriteFixture(t),args=writeArguments({changes:[writeChange({value,expected_state:writeState({storage_type,value_internal:before,data_type})})],...(mode?{mode}:{})});
    const received=await invokeWorkbench(WRITE_TOOL,args,f.options());f.remember(received.receiptOwner);
    assert.equal(received.operation,WRITE_OPERATION);assert.equal(received.mode,mode??'rollback');assert.equal(received.committed,mode==='commit');
    assert.deepEqual(received.value,writeValue({...args,mode:mode??'rollback'}));assert.equal(f.requests.length,1);
    assert.deepEqual(f.requests[0].args,{...args,mode:mode??'rollback'});assert.equal(f.requests[0].args.changes[0].element_id,'9007199254740993');
    const checked=received.receiptOwner.inspect();assert.equal(checked.ok,true);assert.equal(checked.value.status,'received');assert.equal(checked.value.terminal,true);
    assert.equal(received.receiptOwner.close().ok,true);
  }
});

test('wrong before facts, readbacks, identities or transaction envelopes stay unknown without replay',async t=>{
  const corruptions=[
    envelope=>{envelope.result.value.before.value_internal=9;},envelope=>{envelope.result.value.before.data_type='different';},
    envelope=>{envelope.result.value.target_kind='type';},envelope=>{envelope.result.value.result.updated_count=2;},
    envelope=>{envelope.result.value.result.changes[0].element_id='9007199254740994';},
    envelope=>{envelope.result.value.result.changes[0].parameter_id='-124';},envelope=>{envelope.result.value.result.changes[0].parameter_id=-123;},
    envelope=>{envelope.result.value.result.changes[0].after_internal=3;},envelope=>{envelope.result.value.result.changes[0].changed=false;},
    envelope=>{envelope.result.value.result.changes[0].data_type='different';},envelope=>{envelope.result.operation='set_parameters';},
    envelope=>{envelope.result.committed=true;},envelope=>{envelope.timing.hostSession='d'.repeat(32);},
  ];
  for(const corrupt of corruptions){
    const f=await singleParameterWriteFixture(t,{corrupt});let owner;
    await assert.rejects(invokeWorkbench(WRITE_TOOL,writeArguments(),f.options()),error=>{
      const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=f.remember(facts.receiptOwner);assert.ok(owner);return true;
    });
    const checked=owner.inspect();assert.equal(checked.ok,true);assert.equal(checked.value.status,'unconfirmed');assert.equal(checked.value.terminal,false);assert.equal(f.requests.length,1);
  }
});

test('the approval owner freezes the guard, mode and desired value and ignores later caller changes',async t=>{
  const f=await singleParameterWriteFixture(t),{owner,propose}=permission(f),args=writeArguments({mode:'commit'}),proposal=propose(args);
  assert.equal(proposal.requiresApproval,true);assert.ok(Object.isFrozen(proposal.parameters.changes[0].expected_state));
  args.changes[0].value=99;args.changes[0].expected_state.value_internal=88;args.mode='rollback';
  await assert.rejects(owner.decide({ticket:proposal.ticket,digest:'0'.repeat(64),decision:'accept'}),{code:'MODEL_APPROVAL_UNAVAILABLE'});await noPublished(f);
  const decision=await owner.decide({ticket:proposal.ticket,digest:proposal.digest,decision:'accept',parameters:args});assert.equal(decision.status,'completed');
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].args.mode,'commit');assert.equal(f.requests[0].args.changes[0].value,2);assert.equal(f.requests[0].args.changes[0].expected_state.value_internal,1);
  await assert.rejects(owner.decide({ticket:proposal.ticket,digest:proposal.digest,decision:'accept'}),{code:'MODEL_APPROVAL_UNAVAILABLE'});assert.equal(f.requests.length,1);
});

test('rollback authority cannot become commit and permission revocation cannot publish an approved proposal',async t=>{
  const preview=await singleParameterWriteFixture(t),p=permission(preview,{level:'rollback'}),proposal=p.propose(writeArguments({mode:'commit'}));
  assert.equal(proposal.parameters.mode,'rollback');assert.equal(proposal.requiresApproval,false);
  assert.equal((await p.owner.decide({ticket:proposal.ticket,digest:proposal.digest,decision:'accept'})).status,'completed');assert.equal(preview.requests[0].args.mode,'rollback');
  const revoked=await singleParameterWriteFixture(t),r=permission(revoked),pending=r.propose();r.owner.revoke();
  await assert.rejects(r.owner.decide({ticket:pending.ticket,digest:pending.digest,decision:'accept'}),{code:'MODEL_APPROVAL_UNAVAILABLE'});await noPublished(revoked);
});

test('unknown execution remains owned and an approval decision cannot replay it',async t=>{
  const f=await singleParameterWriteFixture(t,{corrupt:envelope=>{envelope.result.value.result.changes[0].after_internal=3;}}),{owner,propose}=permission(f),proposal=propose();
  const decision=await owner.decide({ticket:proposal.ticket,digest:proposal.digest,decision:'accept'});assert.equal(decision.status,'unconfirmed');assert.equal(f.requests.length,1);
  const original=await owner.inspect({ticket:proposal.ticket,scope:scope()});assert.equal(original.ok,true);assert.equal(original.value.status,'unconfirmed');assert.equal(original.value.terminal,false);
  await assert.rejects(owner.decide({ticket:proposal.ticket,digest:proposal.digest,decision:'accept'}),{code:'MODEL_APPROVAL_UNAVAILABLE'});assert.equal(f.requests.length,1);
});

test('a grant cancelled after publication keeps the original late success instead of reporting completion',async t=>{
  let live=true;const f=await singleParameterWriteFixture(t,{onRequest:()=>{live=false;}}),{owner,propose}=permission(f,{current:()=>live}),proposal=propose();
  const result=await owner.decide({ticket:proposal.ticket,digest:proposal.digest,decision:'accept'});assert.equal(result.status,'unconfirmed');assert.equal(f.requests.length,1);
  const original=await owner.inspect({ticket:proposal.ticket,scope:scope()});assert.equal(original.ok,true);assert.equal(original.value.status,'received');
  await assert.rejects(owner.decide({ticket:proposal.ticket,digest:proposal.digest,decision:'accept'}),{code:'MODEL_APPROVAL_UNAVAILABLE'});assert.equal(f.requests.length,1);
});

test('a timed-out guarded write is checked by its original receipt and never automatically resubmitted',async t=>{
  const f=await singleParameterWriteFixture(t,{respond:false});let owner;
  await assert.rejects(invokeWorkbench(WRITE_TOOL,writeArguments(),f.options({timeout:80})),error=>{
    const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=f.remember(facts.receiptOwner);assert.ok(owner);return true;
  });
  assert.equal(f.requests.length,1);assert.equal(owner.inspect().value.status,'pending');await f.publish(f.requests[0]);
  assert.equal(owner.inspect().value.status,'received');assert.equal(f.requests.length,1);assert.equal(owner.close().ok,true);
});

test('a native dispatch failure does not manufacture rollback evidence or a retry',async t=>{
  const f=await singleParameterWriteFixture(t,{failure:{error:{code:'InvalidOperationException',message:'Parameter state changed before Set.'},execution:{started:true,phase:'dispatch',reason:null}}});let owner;
  await assert.rejects(invokeWorkbench(WRITE_TOOL,writeArguments(),f.options()),error=>{const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=f.remember(facts.receiptOwner);return true;});
  const original=owner.inspect();assert.equal(original.ok,true);assert.equal(original.value.status,'unconfirmed');assert.equal(original.value.terminal,false);
  assert.equal(Object.hasOwn(original.value.evidence??{},'rolledBack'),false);assert.equal(f.requests.length,1);
});

test('default and workspace MCP entries cannot advertise or invoke the new bound write',async t=>{
  const f=await singleParameterWriteFixture(t);
  for(const flags of [[],['--workspace']]){
    const {client,stderr}=await f.connect(flags),listed=await client.listTools();assert.equal(listed.tools.some(tool=>tool.name===WRITE_TOOL),false);
    const result=await client.callTool({name:WRITE_TOOL,arguments:writeArguments()},{timeout:7000});assert.equal(result.isError,true);assert.deepEqual(stderr,[]);await noPublished(f);
  }
});

test('actual C# guarded setter DTOs cross the real Node queue for the three supported storage kinds',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t),observed=[];
  const f=await singleParameterWriteFixture(t,{produce:async args=>{
    const change=args.changes[0],state=change.expected_state;
    const actual=await produce({operation:WRITE_OPERATION,sourceId:String(change.element_id),parameters:[{id:String(change.parameter_id),storage:state.storage_type,value:state.value_internal,dataType:state.data_type,hasValue:state.has_value,behavior:'falseApplied'}],args});
    assert.equal(actual.ok,true,JSON.stringify(actual.error));assert.equal(actual.result.mode,args.mode);observed.push(actual);return actual.result.value;
  }});
  for(const [storage_type,before,value,data_type] of [['Double',1,2,'length'],['Integer',1,2,'text'],['String','原值','新值','text']]){
    const args=writeArguments({mode:'commit',changes:[writeChange({value,expected_state:writeState({storage_type,value_internal:before,data_type})})]});
    const result=await invokeWorkbench(WRITE_TOOL,args,f.options());f.remember(result.receiptOwner);assert.equal(result.value.result.changes[0].after_internal,value);
    assert.equal(result.value.result.changes[0].changed,true);assert.equal(result.receiptOwner.inspect().value.status,'received');
  }
  assert.equal(f.requests.length,3);assert.ok(observed.every(row=>row.transactions.GroupCommits===1));
});

test('actual C# selection descriptors retain unsafe IDs through the production readonly panel command',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);
  const ids={sourceId:'9007199254740993',typeId:'9223372036854775807',levelId:'9007199254740995',categoryId:'-9007199254740993'};
  const described=await produce({describeOnly:true,...ids});assert.equal(described.ok,true,JSON.stringify(described.error));
  const item=JSON.parse(described.result_json);assert.equal(item.element_id,ids.sourceId);assert.equal(item.type_id,ids.typeId);assert.equal(item.level_id,ids.levelId);assert.equal(item.category_id,ids.categoryId);
  assert.equal(described.transactions.InnerStarts,0);assert.equal(described.transactions.GroupStarts,0);
  const doc={title:SOURCE_DOCUMENT.title,path:SOURCE_DOCUMENT.path,activeViewId:12,activeViewType:'ThreeD',modified:false};
  const f=await singleParameterWriteFixture(t,{hostPatch:{atomicReadSnapshot:true},operations:['get_selection'],respondEnvelope:async request=>({
    id:request.id,ok:true,completedUtc:new Date().toISOString(),result:{operation:'get_selection',hostSession:SOURCE_DOCUMENT.session,atomicReadSnapshot:true,
      snapshot:{hostSession:SOURCE_DOCUMENT.session,hostVersion:'0.8.5',document:doc,capabilities:{atomicReadSnapshot:true}},
      value:{operation:'get_selection',hostSession:SOURCE_DOCUMENT.session,document:{title:doc.title,path:doc.path},modifiedByOperation:false,value:{total:1,returned:1,truncated:false,items:[item]}}},
  })});
  const selected=await invokeReadonlyPanelCommand('selection',{}, {root:f.root,timeout:3000});assert.equal(selected.ok,true,JSON.stringify(selected));
  assert.equal(selected.value.data.items[0].element_id,ids.sourceId);assert.equal(f.requests.length,1);assert.equal(f.requests[0].operation,'get_selection');
});
