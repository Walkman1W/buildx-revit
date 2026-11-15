import test from 'node:test';
import assert from 'node:assert/strict';
import {loadNativeParameterWriteProducer} from '../test-support/native-parameter-write-producer.mjs';

const source='9007199254740993',parameterId='-123',variants=[['Double',1,2],['Integer',1,2],['String','原值','新值中文']];
function fixture(storage,before,wanted,{parameter={},state={},change={},args={},...controls}={}){
  const sourceId=controls.sourceId??source,p={id:parameterId,storage,value:before,...parameter};
  const expected={storage_type:storage,has_value:before!==null,value_internal:before,data_type:storage==='Double'?'length':'text',...state};
  return {operation:'set_parameter_value',sourceId,parameters:[p],args:{mode:'commit',changes:[{element_id:sourceId,parameter_id:p.id,value:wanted,...(storage==='Double'?{value_unit:'internal'}:{}),expected_state:expected,...change}],...args},...controls};
}
const modelFacts=value=>({modified:value.IsModified,ids:value.source_ids,parameters:value.parameters.map(({id_exact,storage_type,data_type,owner_id,owner_is_type,HasValue,value})=>({id_exact,storage_type,data_type,owner_id,owner_is_type,HasValue,value}))});
function restored(result){assert.deepEqual(modelFacts(result.after),modelFacts(result.before));}
function rejected(result,pattern,sets){assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.result,null);assert.equal(result.transactions.GroupCommits,0);if(pattern)assert.match(result.error.message,pattern);if(sets!==undefined)assert.equal(result.after.parameters.reduce((sum,row)=>sum+row.SetCalls,0),sets);return result;}

test('actual guarded single-parameter write reuses setter values, expectations and transaction groups',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);t.diagnostic(JSON.stringify(produce.sourceEvidence));
  for(const [storage,before,wanted] of variants){
    await t.test(storage+' commits only the explicit instance and returns observed before state with exact IDs',async()=>{
      const result=await produce(fixture(storage,before,wanted));assert.equal(result.ok,true,JSON.stringify(result.error));const dataType=storage==='Double'?'length':'text';
      assert.deepEqual(result.result.value,{schema_version:1,target_kind:'instance',before:{storage_type:storage,has_value:true,value_internal:before,data_type:dataType},result:{updated_count:1,changes:[{element_id:source,parameter_id:parameterId,storage_type:storage,data_type:dataType,changed:true,before_internal:before,after_internal:wanted}]}});
      assert.equal(result.result.committed,true);assert.equal(result.after.parameters[0].value,wanted);assert.equal(result.transactions.InnerCommits,1);assert.equal(result.transactions.Regenerates,1);assert.equal(result.transactions.GroupCommits,1);
    });
    await t.test(storage+' false Set return with retained value succeeds and reports changed',async()=>{
      const result=await produce(fixture(storage,before,wanted,{parameter:{behavior:'falseApplied'}}));assert.equal(result.ok,true);assert.equal(result.result.value.result.changes[0].changed,true);assert.equal(result.after.parameters[0].value,wanted);
    });
    await t.test(storage+' equal value is a verified no-op without calling Set',async()=>{
      const result=await produce(fixture(storage,before,before,{parameter:{behavior:'throws'}}));assert.equal(result.ok,true);assert.equal(result.result.value.result.changes[0].changed,false);assert.equal(result.after.parameters[0].SetCalls,0);
    });
    await t.test(storage+' true Set flag without storage change cannot publish success',async()=>{
      const result=await produce(fixture(storage,before,wanted,{parameter:{behavior:'trueNoChange'}}));rejected(result,/retain|parameter value/i,1);restored(result);assert.equal(result.transactions.InnerCommits,0);
    });
    for(const [name,state] of [['raw value',{value_internal:storage==='String'?'别的值':99}],['HasValue',{has_value:false}],['storage',{storage_type:storage==='Double'?'Integer':'Double'}],['data_type',{data_type:'CHANGED'}]])await t.test(storage+' stale '+name+' guard refuses before any Set',async()=>{
      const result=await produce(fixture(storage,before,wanted,{state}));rejected(result,/state changed/,0);restored(result);assert.equal(result.transactions.InnerCommits,0);
    });
    for(const behavior of ['dataTypeDrift','ownerDrift'])await t.test(storage+' immediate '+behavior+' rejects before Commit',async()=>{
      const result=await produce(fixture(storage,before,wanted,{parameter:{behavior}}));rejected(result,/data_type|owned/,1);restored(result);assert.equal(result.transactions.InnerCommits,0);
    });
    for(const boundary of ['regenerateBehavior','commitBehavior'])for(const behavior of ['drift','dataTypeDrift','dataTypeNull','ownerDrift'])await t.test(storage+' '+boundary+' '+behavior+' is refetched and rejected before outer commit',async()=>{
      const result=await produce(fixture(storage,before,wanted,{[boundary]:behavior}));rejected(result,/retain|data_type|owned/,1);restored(result);assert.equal(result.transactions.InnerCommits,boundary==='commitBehavior'?1:0);assert.equal(result.transactions.InnerRollbacks,boundary==='commitBehavior'?0:1);assert.equal(result.transactions.GroupRollbacks,1);
    });
  }
  await t.test('omitted mode uses the original outer rollback preview and retains before/after facts',async()=>{
    const input=fixture('Double',1,2,{modifiedBefore:true});delete input.args.mode;const result=await produce(input);assert.equal(result.ok,true);assert.equal(result.result.mode,'rollback');assert.equal(result.result.committed,false);assert.equal(result.result.value.before.value_internal,1);assert.equal(result.result.value.result.changes[0].after_internal,2);assert.equal(result.transactions.GroupCommits,0);assert.equal(result.transactions.GroupRollbacks,1);restored(result);
  });
  await t.test('full signed Int64 parameter and positive Int64 source IDs never become JSON numbers',async()=>{
    for(const id of ['-9223372036854775808','9223372036854775807']){
      const result=await produce(fixture('String','原','新',{sourceId:'9223372036854775807',parameter:{id}}));assert.equal(result.ok,true);const row=result.result.value.result.changes[0];assert.equal(row.element_id,'9223372036854775807');assert.equal(row.parameter_id,id);assert.equal(result.after.parameters[0].id_exact,id);
    }
  });
  await t.test('boxed Double source and signed parameter safe bounds use the unchanged shared exact parser',async()=>{
    for(const id of ['9007199254740991','-9007199254740991']){
      const result=await produce(fixture('Double',1,2,{sourceId:'9007199254740991',parameter:{id},elementIdAsDouble:true,parameterIdAsDouble:true}));assert.equal(result.ok,true);const row=result.result.value.result.changes[0];assert.equal(row.element_id,'9007199254740991');assert.equal(row.parameter_id,id);
    }
  });
  await t.test('missing and raw-null before values preserve HasValue independently and are not filled with zero',async()=>{
    for(const [storage,wanted] of [['Double',0],['Integer',0],['String','']]){
      const result=await produce(fixture(storage,null,wanted,{parameter:{hasValue:false}}));assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.result.value.before.has_value,false);assert.equal(result.result.value.before.value_internal,null);assert.equal(result.result.value.result.changes[0].before_internal,null);assert.equal(result.result.value.result.changes[0].changed,true);
    }
    const assignedNull=await produce(fixture('String',null,'',{parameter:{hasValue:true},state:{has_value:true}}));assert.equal(assignedNull.ok,true);assert.equal(assignedNull.result.value.before.has_value,true);assert.equal(assignedNull.result.value.before.value_internal,null);
    const stale=await produce(fixture('Integer',null,1,{parameter:{hasValue:false},state:{has_value:true,value_internal:0}}));rejected(stale,/state changed/,0);restored(stale);
  });
  await t.test('nullable data_type is compared and returned as the observed null',async()=>{
    const result=await produce(fixture('String','原','新',{parameter:{dataType:null},state:{data_type:null}}));assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.result.value.before.data_type,null);assert.equal(result.result.value.result.changes[0].data_type,null);
  });
  await t.test('guard accepts a real preexisting YesNo integer without applying the new-value constraint',async()=>{
    const result=await produce(fixture('Integer',2,1,{parameter:{dataType:'yesno'},state:{data_type:'yesno'}}));assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.result.value.before.value_internal,2);assert.equal(result.result.value.result.changes[0].after_internal,1);
    const invalid=await produce(fixture('Integer',1,2,{parameter:{dataType:'yesno'},state:{data_type:'yesno'}}));rejected(invalid,/0 or 1/,0);restored(invalid);
  });
});

test('actual guarded single-parameter write refuses types, wrong owners and malformed guards before mutation',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);
  await t.test('an ElementType source is explicitly refused',async()=>{const result=await produce(fixture('Double',1,2,{sourceIsType:true}));rejected(result,/instance|ElementType/,0);restored(result);});
  for(const owner of ['type','otherElement','otherDocument','null','invalid'])await t.test('parameter owner '+owner+' is refused',async()=>{const result=await produce(fixture('Double',1,2,{parameter:{owner}}));rejected(result,/owned/,0);restored(result);});
  const invalidStates=[null,1,{}, {storage_type:'Double',has_value:true,value_internal:1}, {storage_type:'Double',has_value:true,data_type:'length'},
    {storage_type:'Double',has_value:1,value_internal:1,data_type:'length'}, {storage_type:'Double',has_value:true,value_internal:1,data_type:1},
    {storage_type:'ElementId',has_value:true,value_internal:1,data_type:'length'}, {storage_type:'Double',has_value:true,value_internal:'1',data_type:'length'},
    {storage_type:'Double',has_value:true,value_internal:1,data_type:'length',name:'untrusted'}];
  for(const [index,expected_state] of invalidStates.entries())await t.test('malformed expected_state '+index+' is refused',async()=>{const result=await produce(fixture('Double',1,2,{change:{expected_state}}));rejected(result,/state|Missing|Unknown/,0);restored(result);});
  await t.test('missing expected_state is not an unconditional write',async()=>{const input=fixture('Double',1,2);delete input.args.changes[0].expected_state;const result=await produce(input);rejected(result,/expected_state/,0);restored(result);});
  await t.test('single changes count is enforced and names are not a write selector',async()=>{
    for(const changes of [[],[fixture('Double',1,2).args.changes[0],fixture('Double',1,2).args.changes[0]]]){const result=await produce(fixture('Double',1,2,{args:{changes}}));rejected(result,/1 to 1/,0);restored(result);}
    const result=await produce(fixture('Double',1,2,{change:{parameter_name:'同名参数'}}));rejected(result,/Unknown argument/,0);restored(result);
  });
  await t.test('invalid signed IDs and precision loss are rejected by the shared owner',async()=>{
    for(const id of [0,-1,'0','-1','01','-0','+1','9223372036854775808','-9223372036854775809',9007199254740992,-9007199254740992,1.5]){const result=await produce(fixture('Double',1,2,{change:{parameter_id:id}}));rejected(result,/id|ElementId|integer/i,0);restored(result);}
    for(const id of ['0','-1','01','9223372036854775808',9007199254740992]){const result=await produce(fixture('Double',1,2,{change:{element_id:id}}));rejected(result,/ElementId|integer/i,0);restored(result);}
  });
  await t.test('shared unit, readonly, integer, string and finite-value rules remain mandatory',async()=>{
    for(const input of [fixture('Double',1,2,{change:{value_unit:'mm'}}),fixture('Double',1,2,{change:{value_unit:undefined}}),fixture('Double',1,2,{parameter:{readOnly:true}}),fixture('Integer',1,1.5),fixture('String','原',2),fixture('String','原',null),fixture('Double',1,2,{nonFiniteValue:'nan'})]){const result=await produce(input);rejected(result,/unit|read-only|integer|string|null|finite/i,0);restored(result);}
  });
  await t.test('legacy operation refuses ElementType targets before any Set',async()=>{
    const result=await produce({operation:'set_parameters',sourceIsType:true,parameters:[{id:1,storage:'Double',value:1}],args:{changes:[{element_id:100,parameter_id:1,value:2,value_unit:'internal'}]}});rejected(result,/instance|ElementType/,0);restored(result);
  });
  await t.test('legacy instance operation retains numeric DTOs and its existing metadata behavior',async()=>{
    const result=await produce({operation:'set_parameters',parameters:[{id:1,storage:'Double',value:1,behavior:'dataTypeDrift'}],args:{changes:[{element_id:100,parameter_id:1,value:2,value_unit:'internal'}]}});assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.result.value.changes[0].element_id,100);assert.equal(result.result.value.changes[0].parameter_id,1);assert.equal(result.result.value.changes[0].data_type,'changed-immediately');
  });
});

test('actual guarded single-parameter transaction failures never claim an unproved outcome',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);
  for(const commitBehavior of ['rollback','pending','throws','readThrows'])await t.test('inner '+commitBehavior+' cannot return success',async()=>{const result=await produce(fixture('Double',1,2,{commitBehavior}));rejected(result);restored(result);assert.equal(result.transactions.InnerCommits,1);assert.equal(result.transactions.GroupRollbacks,1);});
  for(const groupBehavior of ['rollbackThrows','rollbackPending'])await t.test('post-commit metadata mismatch with outer '+groupBehavior+' stays unknown',async()=>{const result=await produce(fixture('Double',1,2,{commitBehavior:'dataTypeDrift',groupBehavior}));rejected(result);assert.equal(result.transactions.InnerCommits,1);assert.equal(result.transactions.InnerRollbacks,0);assert.equal(result.transactions.GroupRollbacks,1);assert.equal('transaction' in result.error,false);assert.equal(result.after.parameters[0].value,2);assert.equal(result.after.parameters[0].data_type,'changed-during-boundary');});
});

test('actual selection element descriptor serializes large IDs as exact strings and safe IDs as existing numbers',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);
  for(const [sourceId,expected] of [['100',100],['9007199254740991',9007199254740991],['9007199254740992','9007199254740992'],['9007199254740993','9007199254740993'],['9223372036854775807','9223372036854775807']]){
    const result=await produce({sourceId,describeOnly:true});assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.result.element_id,expected);assert.equal(JSON.parse(result.result_json).element_id,expected);assert.ok(result.result_json.includes('"element_id":'+JSON.stringify(expected)));assert.equal(result.transactions.InnerStarts,0);assert.equal(result.transactions.GroupStarts,0);restored(result);
  }
  const unsafe=await produce({describeOnly:true,sourceId:'9007199254740993',typeId:'9223372036854775807',levelId:'9007199254740995',categoryId:'-9007199254740993'});assert.equal(unsafe.ok,true);assert.equal(unsafe.result.element_id,'9007199254740993');assert.equal(unsafe.result.type_id,'9223372036854775807');assert.equal(unsafe.result.level_id,'9007199254740995');assert.equal(unsafe.result.category_id,'-9007199254740993');assert.deepEqual(JSON.parse(unsafe.result_json),unsafe.result);assert.equal(unsafe.transactions.InnerStarts,0);restored(unsafe);
  const safe=await produce({describeOnly:true,sourceId:100,typeId:200,levelId:-1,categoryId:-2000011});assert.equal(safe.ok,true);assert.equal(safe.result.element_id,100);assert.equal(safe.result.type_id,200);assert.equal(safe.result.level_id,-1);assert.equal(safe.result.category_id,-2000011);assert.deepEqual(JSON.parse(safe.result_json),safe.result);
});
