import test from 'node:test';
import assert from 'node:assert/strict';
import {loadNativeParameterWriteProducer} from './test-support/native-parameter-write-producer.mjs';

const variants=[['Double',1,2],['Integer',1,2],['String','原值','新值中文']];
const parameter=(storage,value,extra={})=>({id:1,storage,value,...extra});
const change=(storage,value,extra={})=>({element_id:100,parameter_id:1,value,...(storage==='Double'?{value_unit:'internal'}:{}),...extra});
const input=(storage,before,wanted,extra={})=>({parameters:[parameter(storage,before)],args:{changes:[change(storage,wanted)]},...extra});
function failed(result,pattern){assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.result,null);if(pattern)assert.match(result.error.message,pattern);assert.equal(result.transactions.GroupCommits,0);return result;}
function restored(result){assert.equal(result.after.IsModified,result.before.IsModified);assert.deepEqual(result.after.parameters.map(({value,HasValue})=>({value,HasValue})),result.before.parameters.map(({value,HasValue})=>({value,HasValue})));}

test('actual C# parameter setters reject successful Set flags when requested values were not stored',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);t.diagnostic(JSON.stringify(produce.sourceEvidence));
  for(const [storage,before,wanted] of variants)await t.test(storage+' true-but-no-change cannot publish success',async()=>{
    const result=await produce(input(storage,before,wanted,{parameters:[parameter(storage,before,{behavior:'trueNoChange'})]}));failed(result,/parameter|value/i);restored(result);assert.equal(result.transactions.InnerCommits,0);assert.equal(result.transactions.InnerRollbacks,1);assert.equal(result.transactions.GroupRollbacks,1);
  });
});

test('actual C# parameter write verifies stored values through regeneration, commit and outer group',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);t.diagnostic(JSON.stringify(produce.sourceEvidence));
  for(const [storage,before,wanted] of variants){
    await t.test(storage+' ordinary write commits and reports observed before/after values',async()=>{
      const result=await produce(input(storage,before,wanted));assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.result.committed,true);assert.equal(result.result.value.updated_count,1);
      assert.deepEqual(result.result.value.changes[0],{element_id:100,parameter_id:1,storage_type:storage,data_type:storage==='Double'?'length':'text',changed:true,before_internal:before,after_internal:wanted});assert.equal(result.after.parameters[0].value,wanted);assert.equal(result.after.parameters[0].SetCalls,1);assert.equal(result.transactions.Regenerates,1);assert.equal(result.transactions.InnerCommits,1);assert.equal(result.transactions.GroupCommits,1);assert.equal(result.transactions.GroupRollbacks,0);
    });
    await t.test(storage+' false Set return succeeds when value was actually stored',async()=>{
      const result=await produce(input(storage,before,wanted,{parameters:[parameter(storage,before,{behavior:'falseApplied'})]}));assert.equal(result.ok,true,JSON.stringify(result.error));const row=result.result.value.changes[0];assert.equal(row.changed,true);assert.equal(row.after_internal,wanted);assert.equal(result.after.parameters[0].value,wanted);assert.equal(result.transactions.GroupCommits,1);
    });
    await t.test(storage+' already equal is a no-op without invoking Set',async()=>{
      const result=await produce(input(storage,wanted,wanted,{parameters:[parameter(storage,wanted,{behavior:'throws'})]}));assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.result.value.updated_count,1);const row=result.result.value.changes[0];assert.equal(row.changed,false);assert.equal(row.before_internal,wanted);assert.equal(row.after_internal,wanted);assert.equal(result.after.parameters[0].SetCalls,0);
    });
    await t.test(storage+' false/no-change is rejected and leaves original state',async()=>{
      const result=await produce(input(storage,before,wanted,{parameters:[parameter(storage,before,{behavior:'falseNoChange'})]}));failed(result,/parameter|value/i);restored(result);assert.equal(result.transactions.InnerCommits,0);
    });
    await t.test(storage+' regeneration drift fails inside the transaction',async()=>{
      const result=await produce(input(storage,before,wanted,{regenerateBehavior:'drift'}));failed(result,/parameter|value/i);restored(result);assert.equal(result.transactions.Regenerates,1);assert.equal(result.transactions.InnerCommits,0);assert.equal(result.transactions.InnerRollbacks,1);assert.equal(result.transactions.GroupRollbacks,1);
    });
    await t.test(storage+' post-commit drift fails and outer group rolls back the committed inner transaction',async()=>{
      const result=await produce(input(storage,before,wanted,{commitBehavior:'drift'}));failed(result,/parameter|value/i);restored(result);assert.equal(result.transactions.InnerCommits,1);assert.equal(result.transactions.InnerRollbacks,0);assert.equal(result.transactions.GroupRollbacks,1);assert.deepEqual(result.transactions.events.slice(-2),['InnerCommit','GroupRollback']);
    });
    await t.test(storage+' already-equal values are still verified after commit',async()=>{
      const result=await produce(input(storage,wanted,wanted,{commitBehavior:'drift'}));failed(result,/parameter|value/i);restored(result);assert.equal(result.after.parameters[0].SetCalls,0);assert.equal(result.transactions.InnerRollbacks,0);assert.equal(result.transactions.GroupRollbacks,1);
    });
    await t.test(storage+' post-commit read exception publishes no success DTO',async()=>{
      const result=await produce(input(storage,before,wanted,{commitBehavior:'readThrows'}));failed(result,/post-commit parameter read/);restored(result);assert.equal(result.transactions.InnerCommits,1);assert.equal(result.transactions.InnerRollbacks,0);assert.equal(result.transactions.GroupRollbacks,1);
    });
  }
  await t.test('empty String is a real stored value, distinct from missing value',async()=>{
    const result=await produce(input('String',null,'',{parameters:[parameter('String',null,{hasValue:false})]}));assert.equal(result.ok,true);assert.equal(result.result.value.changes[0].before_internal,null);assert.equal(result.result.value.changes[0].after_internal,'');assert.equal(result.result.value.changes[0].changed,true);assert.equal(result.after.parameters[0].HasValue,true);
  });
  await t.test('explicit outer rollback returns preview facts while restoring all model values',async()=>{
    const result=await produce(input('Double',1,2,{args:{mode:'rollback',changes:[change('Double',2)]},modifiedBefore:true}));assert.equal(result.ok,true);assert.equal(result.result.committed,false);assert.equal(result.result.mode,'rollback');assert.equal(result.result.value.changes[0].after_internal,2);restored(result);assert.equal(result.transactions.InnerCommits,1);assert.equal(result.transactions.GroupCommits,0);assert.equal(result.transactions.GroupRollbacks,1);
  });
  await t.test('a three-storage batch validates every row and commits once',async()=>{
    const parameters=variants.map(([storage,before],index)=>parameter(storage,before,{id:index+1})),changes=variants.map(([storage,,wanted],index)=>change(storage,wanted,{parameter_id:index+1}));const result=await produce({parameters,args:{changes}});assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.result.value.updated_count,3);assert.deepEqual(result.after.parameters.map(row=>row.value),variants.map(row=>row[2]));assert.equal(result.transactions.InnerCommits,1);assert.equal(result.transactions.Regenerates,1);assert.equal(result.transactions.GroupCommits,1);
  });
});

test('actual C# parameter write rejects invalid targets, values, identity and units without partial writes',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);
  const rejects=[
    ['read-only target',input('Double',1,2,{parameters:[parameter('Double',1,{readOnly:true})]}),/read-only/i],
    ['parameter does not exist',input('Double',1,2,{args:{changes:[change('Double',2,{parameter_id:999})]}}),/does not belong/],
    ['element does not exist',input('Double',1,2,{args:{changes:[change('Double',2,{element_id:999})]}}),/does not exist/],
    ['invalid element',input('Double',1,2,{invalidElement:true}),/does not exist/],
    ['ElementId storage is unsupported',input('ElementId',10,20),/Only Double, Integer and String/],
    ['None storage is unsupported',input('None',null,20),/Only Double, Integer and String/],
    ['Double requires explicit internal units',input('Double',1,2,{args:{changes:[{element_id:100,parameter_id:1,value:2}]}}),/value_unit=internal/],
    ['unit cannot be a display unit',input('Double',1,2,{args:{changes:[change('Double',2,{value_unit:'mm'})]}}),/must equal internal/],
    ['unit cannot be an empty explicit field',input('Integer',1,2,{args:{changes:[change('Integer',2,{value_unit:''})]}}),/must equal internal/],
    ['numeric text is not converted to Double',input('Double',1,'2'),/JSON number/],
    ['boolean is not converted to Integer',input('Integer',1,true),/JSON number/],
    ['fraction is not rounded to Integer',input('Integer',1,1.25),/integer/],
    ['integer overflow is rejected',input('Integer',1,2147483648),/integer/],
    ['String does not coerce a number',input('String','one',2),/must be a string/],
    ['String rejects null',input('String','one',null),/null/],
    ['YesNo requires zero or one',input('Integer',0,2,{parameters:[parameter('Integer',0,{dataType:'yesno'})]}),/0 or 1/],
    ['unsafe numeric ElementId is rejected',input('Double',1,2,{args:{changes:[change('Double',2,{element_id:9007199254740992})]}}),/integer/],
    ['decimal-string ElementId is not silently converted',input('Double',1,2,{args:{changes:[change('Double',2,{element_id:'100'})]}}),/JSON number/],
    ['reserved parameter id zero rejects',input('Double',1,2,{args:{changes:[change('Double',2,{parameter_id:0})]}}),/actual parameter/],
    ['reserved parameter id minus-one rejects',input('Double',1,2,{args:{changes:[change('Double',2,{parameter_id:-1})]}}),/actual parameter/],
    ['unknown field rejects',input('Double',1,2,{args:{changes:[change('Double',2,{parameter_name:'猜测'})]}}),/Unknown argument/],
    ['empty changes rejects',input('Double',1,2,{args:{changes:[]}}),/1 to 50/],
    ['oversized changes rejects',input('Double',1,2,{args:{changes:Array.from({length:51},()=>change('Double',2))}}),/1 to 50/],
    ['non-object changes rejects',input('Double',1,2,{args:{changes:[null]}}),/must be an object/],
    ['wrong expected document rejects before transaction',input('Double',1,2,{args:{expected_document:'D:\\other.rvt',changes:[change('Double',2)]}}),/document|Document/],
    ...['nan','infinity','negativeInfinity'].map(value=>['nonfinite Double '+value,input('Double',1,2,{nonFiniteValue:value}),/finite/])
  ];
  for(const [name,fixture,pattern] of rejects)await t.test(name,async()=>{const result=await produce(fixture);failed(result,pattern);restored(result);assert.equal(result.transactions.InnerCommits,0);assert.equal(result.after.parameters[0].SetCalls,0);});
  await t.test('duplicate element/parameter pair rejects and rolls back the earlier setter',async()=>{
    const result=await produce(input('Double',1,2,{args:{changes:[change('Double',2),change('Double',3)]}}));failed(result,/Duplicate/);restored(result);assert.equal(result.after.parameters[0].SetCalls,1);assert.equal(result.transactions.InnerRollbacks,1);assert.equal(result.transactions.GroupRollbacks,1);
  });
  for(const behavior of ['readOnly','absent','throws','trueNoChange'])await t.test('later batch '+behavior+' rolls back every earlier storage value',async()=>{
    const parameters=variants.map(([storage,before],index)=>parameter(storage,before,{id:index+1}));parameters.push(parameter('String','last',{id:4,...(behavior==='readOnly'?{readOnly:true}:{behavior})}));
    const changes=variants.map(([storage,,wanted],index)=>change(storage,wanted,{parameter_id:index+1}));changes.push(change('String','new last',{parameter_id:behavior==='absent'?999:4}));const result=await produce({parameters,args:{changes}});failed(result);restored(result);assert.deepEqual(result.after.parameters.slice(0,3).map(row=>row.SetCalls),[1,1,1]);assert.equal(result.transactions.InnerCommits,0);assert.equal(result.transactions.InnerRollbacks,1);assert.equal(result.transactions.GroupRollbacks,1);
  });
  await t.test('stable signed parameter id selects one of two same-named parameters',async()=>{
    const result=await produce(input('Integer',1,2,{parameters:[parameter('Integer',999,{id:200,name:'同名参数'}),parameter('Integer',1,{id:-123,name:'同名参数'})],args:{changes:[change('Integer',2,{parameter_id:-123})]}}));assert.equal(result.ok,true);assert.equal(result.result.value.changes[0].parameter_id,-123);assert.deepEqual(result.after.parameters.map(row=>row.value),[999,2]);assert.deepEqual(result.after.parameters.map(row=>row.SetCalls),[0,1]);
  });
});

test('actual C# parameter write refetches targets after regeneration and commit',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);
  for(const boundary of ['regenerateBehavior','commitBehavior'])for(const behavior of ['removeElement','invalidElement','removeParameter','replaceParameter','storageChange','missingValue'])await t.test(boundary+' '+behavior+' never trusts the earlier parameter reference',async()=>{
    for(const [storage,before,wanted] of variants){
      const result=await produce(input(storage,before,wanted,{[boundary]:behavior}));failed(result,/element|parameter|value/i);restored(result);assert.equal(result.transactions.InnerCommits,boundary==='commitBehavior'?1:0);assert.equal(result.transactions.InnerRollbacks,boundary==='commitBehavior'?0:1);assert.equal(result.transactions.GroupRollbacks,1);
    }
  });
});

test('actual C# inner and outer transaction failures never produce a success DTO',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);
  for(const [name,fixture,pattern,innerCommits,innerRollbacks] of [
    ['Parameter.Set exception',{parameters:[parameter('Double',1,{behavior:'throws'})]},/Parameter.Set failure/,0,1],
    ['Transaction.Start failure',{startBehavior:'fail'},/start Revit transaction/,0,0],
    ['Regenerate exception',{regenerateBehavior:'throws'},/Regenerate failure/,0,1],
    ['Commit returns RolledBack',{commitBehavior:'rollback'},/transaction|Revit/i,1,0],
    ['Commit returns Pending',{commitBehavior:'pending'},/transaction|Revit/i,1,0],
    ['Commit throws',{commitBehavior:'throws'},/Commit failure/,1,1]
  ])await t.test(name,async()=>{const result=await produce(input('Double',1,2,fixture));failed(result,pattern);restored(result);assert.equal(result.transactions.InnerCommits,innerCommits);assert.equal(result.transactions.InnerRollbacks,innerRollbacks);assert.equal(result.transactions.GroupRollbacks,1);});
  await t.test('outer Assimilate exception triggers group rollback',async()=>{
    const result=await produce(input('Double',1,2,{groupBehavior:'commitThrows'}));assert.equal(result.ok,false);assert.equal(result.result,null);assert.equal(result.transactions.GroupCommits,1);assert.equal(result.transactions.GroupRollbacks,1);restored(result);
  });
  await t.test('outer Assimilate Pending is an error with no determinate rollback claim',async()=>{
    const result=await produce(input('Double',1,2,{groupBehavior:'commitPending'}));assert.equal(result.ok,false);assert.equal(result.result,null);assert.match(result.error.message,/Pending/);assert.equal(result.transactions.GroupCommits,1);assert.equal(result.transactions.GroupRollbacks,0);assert.equal(result.after.parameters[0].value,2);assert.equal('transaction' in result.error,false);
  });
  for(const groupBehavior of ['rollbackThrows','rollbackPending'])await t.test('post-commit verification failure with '+groupBehavior+' stays an error without a rollback proof',async()=>{
    const result=await produce(input('Double',1,2,{commitBehavior:'drift',groupBehavior}));failed(result);assert.equal(result.transactions.InnerCommits,1);assert.equal(result.transactions.InnerRollbacks,0);assert.equal(result.transactions.GroupRollbacks,1);assert.equal(result.after.parameters[0].value,3);assert.equal('transaction' in result.error,false);
  });
});
