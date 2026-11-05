import test from 'node:test';
import assert from 'node:assert/strict';
import {loadNativeParameterWriteProducer} from './test-support/native-parameter-write-producer.mjs';

const variants=[['Double',1,2],['Integer',1,2],['String','原值','新值']];
function batch(count=3){
  const elements=[],changes=[];
  for(let index=0;index<count;index++){
    const [storage,before,wanted]=variants[index%variants.length],id=100+index;
    elements.push({id,parameters:[{id:1,storage,value:before}]});changes.push({element_id:id,parameter_id:1,value:wanted,...(storage==='Double'?{value_unit:'internal'}:{})});
  }
  return {elements,args:{mode:'commit',changes}};
}
function modelFacts(facts){return {modified:facts.IsModified,sources:facts.source_ids,parameters:facts.parameters.map(({SetCalls,ReadCalls,...value})=>value)};}
function restored(result){assert.deepEqual(modelFacts(result.after),modelFacts(result.before));}
function refused(result,pattern){assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.result,null);assert.equal(result.transactions.GroupCommits,0);if(pattern)assert.match(result.error.message,pattern);return result;}
function noSets(result){assert.equal(result.transactions.SetAttempts,0);assert.deepEqual(result.transactions.SetTargets,[]);assert.ok(result.after.parameters.every(parameter=>parameter.SetCalls===0));}
const hook=(input,trigger,target,action)=>{input.elements[trigger].parameters[0].onSet={element_id:input.elements[target].id,parameter_id:1,action};return input;};

test('actual parameter write policy preflights all targets before the first Set',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);t.diagnostic(JSON.stringify(produce.sourceEvidence));
  for(const position of [0,1,2])await t.test('ElementType in mixed-storage position '+position+' causes zero Set calls',async()=>{
    const input=batch();input.elements[position].isType=true;const result=await produce(input);refused(result,/instance|ElementType/);noSets(result);restored(result);assert.equal(result.transactions.InnerCommits,0);
  });
  for(const owner of ['type','otherElement','otherDocument','null','invalid'])for(const position of [0,1,2])await t.test('foreign owner '+owner+' in position '+position+' causes zero Set calls',async()=>{
    const input=batch();input.elements[position].parameters[0].owner=owner;const result=await produce(input);refused(result,/owned/);noSets(result);restored(result);
  });
  for(const problem of ['foreignDocument','nullDocument','invalid'])for(const position of [0,1,2])await t.test('source '+problem+' in position '+position+' causes zero Set calls',async()=>{
    const input=batch();if(problem==='invalid')input.elements[position].invalid=true;else input.elements[position].document=problem==='foreignDocument'?'other':'null';const result=await produce(input);refused(result,/instance|current-document|does not exist/);noSets(result);restored(result);
  });
  await t.test('missing targets and duplicate pairs at the end cause zero Set calls',async()=>{
    for(const problem of ['element','parameter','pair']){const input=batch();if(problem==='element')input.args.changes[2].element_id=999;else if(problem==='parameter')input.args.changes[2].parameter_id=999;else input.args.changes.push({...input.args.changes[0]});const result=await produce(input);refused(result,/exist|belong|Duplicate/);noSets(result);restored(result);}
  });
  await t.test('no-op rows do not bypass a later forbidden target or initial readonly state',async()=>{
    const input=batch();for(let index=0;index<input.args.changes.length;index++)input.args.changes[index].value=input.elements[index].parameters[0].value;input.elements[2].isType=true;const result=await produce(input);refused(result,/instance|ElementType/);noSets(result);restored(result);
    const readonly=batch(1);readonly.args.changes[0].value=1;readonly.elements[0].parameters[0].readOnly=true;const readOnlyResult=await produce(readonly);refused(readOnlyResult,/read-only/);noSets(readOnlyResult);restored(readOnlyResult);
  });
  await t.test('all 50 legal mixed-storage targets commit with the existing numeric batch DTO',async()=>{
    const result=await produce(batch(50));assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.result.value.updated_count,50);assert.equal(result.transactions.SetAttempts,50);assert.equal(result.transactions.InnerCommits,1);assert.equal(result.transactions.GroupCommits,1);assert.ok(result.result.value.changes.every(row=>typeof row.element_id==='number'&&typeof row.parameter_id==='number'));
  });
  await t.test('50 no-ops remain successful without Set and 51 changes remain rejected',async()=>{
    const input=batch(50);input.args.changes.forEach((change,index)=>{change.value=input.elements[index].parameters[0].value;});const result=await produce(input);assert.equal(result.ok,true);assert.equal(result.result.value.updated_count,50);assert.ok(result.result.value.changes.every(row=>row.changed===false));noSets(result);
    const exceeded=await produce(batch(51));refused(exceeded,/1 to 50/);noSets(exceeded);restored(exceeded);
  });
});

test('actual parameter write policy refetches each target and verifies live objects after Set',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);
  for(const action of ['ownerType','ownerOtherDocument','ownerNull','replaceWrongOwner','replaceTypeSource','sourceOtherDocument','readOnly'])await t.test('first Set changes a later target via '+action+' and only the first setter runs',async()=>{
    const result=await produce(hook(batch(),0,1,action));refused(result);assert.equal(result.transactions.SetAttempts,1);assert.deepEqual(result.transactions.SetTargets,['100:1']);assert.equal(result.after.parameters.find(row=>row.element_id==='101').SetCalls,0);assert.equal(result.transactions.InnerCommits,0);assert.equal(result.transactions.InnerRollbacks,1);assert.equal(result.transactions.GroupRollbacks,1);restored(result);
  });
  await t.test('an owner-drifted later no-op is rejected before the no-op optimization',async()=>{
    const input=hook(batch(),0,1,'ownerType');input.args.changes[1].value=1;const result=await produce(input);refused(result,/owned/);assert.equal(result.transactions.SetAttempts,1);assert.deepEqual(result.transactions.SetTargets,['100:1']);restored(result);
  });
  await t.test('a valid replacement of a later parameter is used instead of the preflight wrapper',async()=>{
    const result=await produce(hook(batch(),0,1,'replace'));assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.transactions.SetAttempts,3);assert.deepEqual(result.transactions.SetTargets,['100:1','101:1','102:1']);assert.equal(result.after.parameters[1].value,2);assert.equal(result.after.parameters[1].SetCalls,1);
  });
  await t.test('legacy before values remain live observations when an earlier Set reaches a later value',async()=>{
    const result=await produce(hook(batch(),0,1,'valueDrift'));assert.equal(result.ok,true);assert.equal(result.transactions.SetAttempts,2);assert.deepEqual(result.result.value.changes[1],{element_id:101,parameter_id:1,storage_type:'Integer',data_type:'text',changed:false,before_internal:2,after_internal:2});
  });
  for(const action of ['replaceWrongOwner','replaceWrongValue','replaceTypeSource','sourceOtherDocument'])await t.test('immediate '+action+' never verifies the stale Parameter after Set',async()=>{
    const result=await produce(hook(batch(),0,0,action));refused(result);assert.equal(result.transactions.SetAttempts,1);assert.equal(result.transactions.Regenerates,0);assert.equal(result.transactions.InnerCommits,0);restored(result);
  });
  for(const action of ['ownerType','valueDrift','replaceWrongOwner','replaceWrongValue'])await t.test('a later setter changing an already-written target via '+action+' is caught by shared expectations',async()=>{
    const result=await produce(hook(batch(2),1,0,action));refused(result);assert.equal(result.transactions.SetAttempts,2);assert.equal(result.transactions.Regenerates,1);assert.equal(result.transactions.InnerCommits,0);restored(result);
  });
  for(const boundary of ['regenerateBehavior','commitBehavior'])await t.test(boundary+' owner drift is refused for legacy batches',async()=>{
    const result=await produce({...batch(),[boundary]:'ownerDrift'});refused(result,/owned/);assert.equal(result.transactions.SetAttempts,3);assert.equal(result.transactions.InnerCommits,boundary==='commitBehavior'?1:0);assert.equal(result.transactions.InnerRollbacks,boundary==='commitBehavior'?0:1);assert.equal(result.transactions.GroupRollbacks,1);restored(result);
  });
});

test('actual target policy preserves writability timing and uncertain transaction outcomes',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);
  for(const operation of ['set_parameters','set_parameter_value'])for(const boundary of ['immediate','regenerate','commit'])await t.test(operation+' '+boundary+' readonly transition does not invalidate a retained value',async()=>{
    const input=batch(1);input.operation=operation;if(operation==='set_parameter_value')input.args.changes[0].expected_state={storage_type:'Double',has_value:true,value_internal:1,data_type:'length'};
    if(boundary==='immediate')input.elements[0].parameters[0].behavior='readOnlyAfterSet';else input[boundary==='regenerate'?'regenerateBehavior':'commitBehavior']='readOnly';const result=await produce(input);assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.transactions.SetAttempts,1);assert.equal(result.after.parameters[0].IsReadOnly,true);assert.equal(result.after.parameters[0].value,2);assert.equal(result.transactions.InnerCommits,1);assert.equal(result.transactions.GroupCommits,1);
  });
  for(const groupBehavior of ['rollbackThrows','rollbackPending'])await t.test('post-commit ownership failure with '+groupBehavior+' never gains a rollback proof',async()=>{
    const result=await produce({...batch(),commitBehavior:'ownerDrift',groupBehavior});refused(result,/owned|RollBack failure/);assert.equal(result.transactions.InnerCommits,1);assert.equal(result.transactions.InnerRollbacks,0);assert.equal(result.transactions.GroupRollbacks,1);assert.equal('transaction' in result.error,false);assert.equal(result.after.IsModified,true);
  });
  await t.test('runtime setter exceptions still rollback earlier legal writes without claiming zero total Set',async()=>{
    const input=batch();input.elements[1].parameters[0].behavior='throws';const result=await produce(input);refused(result,/Set failure/);assert.equal(result.transactions.SetAttempts,2);assert.deepEqual(result.transactions.SetTargets,['100:1','101:1']);restored(result);
  });
  await t.test('a rollback preview uses the same instance preflight and restores the complete batch',async()=>{
    const input=batch();input.args.mode='rollback';const result=await produce(input);assert.equal(result.ok,true);assert.equal(result.result.committed,false);assert.equal(result.transactions.SetAttempts,3);assert.equal(result.transactions.GroupCommits,0);assert.equal(result.transactions.GroupRollbacks,1);restored(result);
  });
});
