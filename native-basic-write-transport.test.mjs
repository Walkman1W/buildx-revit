import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {singleParameterWriteFixture,SOURCE_DOCUMENT,writeEnvelope} from './test-support/native-single-parameter-write-fixtures.mjs';
const operations=['create_level','create_grid','pin_element','unpin_element'];
const hostPatch={version:'0.8.9',nativeBasicWritesVersion:1,nativeBasicWriteOperations:operations};
const args=(more)=>({expected_document:SOURCE_DOCUMENT.path,...more});
const envelope=(request,value)=>{const e=writeEnvelope(request,{value});e.result.operation=request.operation;return e;};
test('basic writes require advertised capability before publication',async t=>{
  for(const patch of [{version:'0.8.8'},{nativeBasicWritesVersion:0},{nativeBasicWriteOperations:[]},{nativeBasicWriteOperations:['pin_element','pin_element']}]){
    const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,...patch},operations});
    await assert.rejects(invokeWorkbench('revit_pin_element',args({element_id:42}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
  }
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
