import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {singleParameterWriteFixture,SOURCE_DOCUMENT,writeEnvelope} from './test-support/native-single-parameter-write-fixtures.mjs';
const operations=['create_level','create_grid','pin_element','unpin_element','create_floor_plan_view','create_3d_view'];
const hostPatch={version:'0.8.9',nativeBasicWritesVersion:1,nativeBasicWriteOperations:operations};
const args=(more)=>({expected_document:SOURCE_DOCUMENT.path,...more});
const envelope=(request,value)=>{const e=writeEnvelope(request,{value});e.result.operation=request.operation;return e;};
test('basic writes require advertised capability before publication',async t=>{
  for(const patch of [{version:'0.8.8'},{nativeBasicWritesVersion:0},{nativeBasicWriteOperations:[]},{nativeBasicWriteOperations:['pin_element','pin_element']}]){
    const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,...patch},operations});
    await assert.rejects(invokeWorkbench('revit_pin_element',args({element_id:42}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
  }
});
test('view writes require their own capability and preserve rollback receipt identity',async t=>{
  for(const [tool,operation,parameters,value] of [
    ['revit_create_floor_plan_view','create_floor_plan_view',{name:'Plan A',view_family_type_id:'9007199254740993',level_id:'25'},{element_id:'50',name:'Plan A',view_family_type_id:'9007199254740993',level_id:'25',view_kind:'floor_plan'}],
    ['revit_create_3d_view','create_3d_view',{name:'3D A',view_family_type_id:'9007199254740993'},{element_id:'51',name:'3D A',view_family_type_id:'9007199254740993',view_kind:'isometric_3d'}],
  ]){
    const absent=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:operations.filter(item=>item!==operation)},operations});
    await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
    const f=await singleParameterWriteFixture(t,{hostPatch,operations,respondEnvelope:r=>envelope(r,value)});
    const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);
    assert.equal(f.requests.length,1);assert.equal(f.requests[0].operation,operation);assert.equal(f.requests[0].args.mode,'rollback');
    assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(result.value.view_kind,value.view_kind);
  }
});
test('view mismatched results remain unconfirmed and are never resent',async t=>{
  for(const [tool,parameters,value] of [
    ['revit_create_floor_plan_view',{name:'Plan',view_family_type_id:'11',level_id:'12'},{element_id:'50',name:'Plan',view_family_type_id:'11',level_id:'13',view_kind:'floor_plan'}],
    ['revit_create_3d_view',{name:'3D',view_family_type_id:'11'},{element_id:'51',name:'3D',view_family_type_id:'11',view_kind:'floor_plan'}],
  ]){
    const f=await singleParameterWriteFixture(t,{hostPatch,operations,respondEnvelope:r=>envelope(r,value)});let owner;
    await assert.rejects(invokeWorkbench(tool,args(parameters),f.options()),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
    assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(f.requests.length,1);
  }
});
test('view writes reject untrusted names and identifiers before publication',async t=>{
  const f=await singleParameterWriteFixture(t,{hostPatch,operations});
  for(const [tool,parameters] of [
    ['revit_create_3d_view',{name:' ',view_family_type_id:'1'}],['revit_create_3d_view',{name:' '+ 'x'.repeat(255),view_family_type_id:'1'}],
    ['revit_create_3d_view',{name:'x'.repeat(256),view_family_type_id:'1'}],['revit_create_3d_view',{name:'ok',view_family_type_id:9007199254740992}],
    ['revit_create_3d_view',{name:'ok',view_family_type_id:'9223372036854775808'}],['revit_create_floor_plan_view',{name:'ok',view_family_type_id:'1'}],
    ['revit_create_floor_plan_view',{name:'ok',view_family_type_id:'1',level_id:'0'}],
  ]) await assert.rejects(invokeWorkbench(tool,args(parameters),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
  assert.equal(f.requests.length,0);
});
test('pin changed and unchanged results retain original receipt',async t=>{
  for(const before of [false,true]){
    const f=await singleParameterWriteFixture(t,{hostPatch,operations,respondEnvelope:r=>envelope(r,{element_id:42,before_pinned:before,pinned:true,changed:!before})});
    const value=await invokeWorkbench('revit_pin_element',args({element_id:42}),f.options());f.remember(value.receiptOwner);
    assert.equal(value.value.changed,!before);assert.equal(value.receiptOwner.inspect().value.status,'received');assert.equal(f.requests.length,1);
  }
});
test('incorrect pin result is unknown and never replayed',async t=>{
  const f=await singleParameterWriteFixture(t,{hostPatch,operations,respondEnvelope:r=>envelope(r,{element_id:43,before_pinned:false,pinned:true,changed:true})});let owner;
  await assert.rejects(invokeWorkbench('revit_pin_element',args({element_id:42}),f.options()),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
  assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(f.requests.length,1);
});
test('level and grid values must match the submitted request',async t=>{
  const point={x:0,y:0,z:0},end={x:1000,y:0,z:0};
  for(const [tool,parameters,value] of [['revit_create_level',{name:'L1',elevation_mm:3000},{element_id:50,name:'L1',elevation_mm:3000}],['revit_create_grid',{name:'A',start_mm:point,end_mm:end},{element_id:51,name:'A',start_mm:point,end_mm:end}]]){
    const f=await singleParameterWriteFixture(t,{hostPatch,operations,respondEnvelope:r=>envelope(r,value)});
    const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.equal(result.receiptOwner.inspect().value.status,'received');
  }
});

test('conduit requires capability, validates before queue, and preserves exact rollback receipt',async t=>{
 const operation='create_conduit', tool='revit_create_conduit', all=[...operations,operation], patch={...hostPatch,nativeBasicWriteOperations:all};
 const parameters={conduit_type_id:'9007199254740993',level_id:'9007199254740994',start_mm:{x:0,y:2,z:3000},end_mm:{x:1000,y:2,z:3000},diameter_mm:25};
 for(const host of [{...patch,nativeBasicWritesVersion:0},{...patch,nativeBasicWriteOperations:operations}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:all});
  await assert.rejects(invokeWorkbench(tool,args(parameters),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
 }
 const invalid=[{conduit_type_id:'0'},{conduit_type_id:'9223372036854775808'},{conduit_type_id:9007199254740992},{level_id:'-1'},{level_id:'1.5'},{diameter_mm:0},{diameter_mm:Infinity},{start_mm:{x:0,y:0,z:NaN}},{end_mm:parameters.start_mm},{mode:'invalid'}];
 const f=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,{element_id:'9007199254740995',...parameters})});
 for(const change of invalid)await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);
 const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].operation,operation);assert.equal(f.requests[0].args.mode,'rollback');
 assert.deepEqual(result.value,{element_id:'9007199254740995',...parameters});assert.equal(result.receiptOwner.inspect().value.status,'received');
});

test('conduit mismatched result stays unconfirmed with one original request and no replay',async t=>{
 const operation='create_conduit', all=[...operations,operation], parameters={conduit_type_id:'9007199254740993',level_id:'9007199254740994',start_mm:{x:0,y:0,z:3000},end_mm:{x:1000,y:0,z:3000},diameter_mm:25};
 for(const change of [{element_id:'0'},{conduit_type_id:'9007199254740992'},{level_id:'4'},{start_mm:{x:1,y:0,z:3000}},{end_mm:{x:1001,y:0,z:3000}},{diameter_mm:26}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{element_id:'5',...parameters,...change})});let owner;
  await assert.rejects(invokeWorkbench('revit_create_conduit',args(parameters),f.options()),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
  assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(f.requests.length,1);
 }
});
