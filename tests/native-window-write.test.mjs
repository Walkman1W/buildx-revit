import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeWorkbench,workbenchFailureEvidence,validateTool,WORKBENCH_TOOLS} from '../lib/workbench-client.mjs';
import {describeModelOperationSchema} from '../lib/model-operation-contracts.mjs';
import {MODEL_AI_EFFECT_TOOLS,LEGACY_PANEL_TOOL_NAMES} from '../lib/panel-tools.mjs';
import {singleParameterWriteFixture,SOURCE_DOCUMENT,writeEnvelope} from '../test-support/native-single-parameter-write-fixtures.mjs';
const operation='place_window',tool='revit_place_window',operations=[operation],hostPatch={version:'0.8.9',nativeBasicWritesVersion:1,nativeBasicWriteOperations:operations};
const args={expected_document:SOURCE_DOCUMENT.path,symbol_id:'9007199254740993',wall_id:'11',level_id:'12',point_mm:{x:1,y:2,z:3},facing_direction:{x:0,y:1,z:0}};
const value={element_id:'15',wall_id:'11',wall_type_id:'16',symbol_id:args.symbol_id,level_id:'12',point_mm:args.point_mm,offset_mm:3,facing_direction:args.facing_direction,facing_flipped:false,dimensions_mm:{width:1000,height:null}};
const envelope=(request,v)=>{const e=writeEnvelope(request,{value:v});e.result.operation=request.operation;return e;};
test('window contract, model classification and legacy gate',()=>{
 const schema=describeModelOperationSchema({tool});assert.equal(schema.ok,true);assert.match(schema.value.inputSchema.properties.facing_direction.description,/Unitless/);assert.deepEqual(Object.keys(schema.value.inputSchema.properties.facing_direction.properties),['x','y','z']);
 assert.ok(WORKBENCH_TOOLS.some(t=>t.name===tool));assert.ok(MODEL_AI_EFFECT_TOOLS.some(t=>t.name===tool));assert.ok(!LEGACY_PANEL_TOOL_NAMES.includes(tool));
 assert.equal(validateTool(tool,args).operation,operation);assert.equal(validateTool(tool,args).args.mode,'rollback');
 for(const change of [{wall_id:'0'},{symbol_id:'9223372036854775808'},{facing_direction:{x:0,y:2,z:0}},{facing_direction:{x:0,y:0,z:1}}])assert.throws(()=>validateTool(tool,{...args,...change}));
});
test('window capability gate and exact queue receipt',async t=>{
 for(const patch of [{version:'0.8.8'},{nativeBasicWritesVersion:0},{nativeBasicWriteOperations:[] }]){
  const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,...patch},operations});await assert.rejects(invokeWorkbench(tool,args,f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
 }
 const f=await singleParameterWriteFixture(t,{hostPatch,operations,respondEnvelope:r=>envelope(r,value)});
 const result=await invokeWorkbench(tool,args,f.options());f.remember(result.receiptOwner);assert.equal(f.requests.length,1);assert.equal(f.requests[0].operation,operation);assert.equal(f.requests[0].args.mode,'rollback');assert.equal(result.receiptOwner.inspect().value.status,'received');
});
test('window mismatched original receipt stays unconfirmed without replay',async t=>{
 for(const change of [{wall_id:'13'},{symbol_id:'13'},{level_id:'13'},{point_mm:{x:3,y:2,z:3}},{facing_direction:{x:0,y:-1,z:0}},{dimensions_mm:{width:-1,height:null}}]){
  const f=await singleParameterWriteFixture(t,{hostPatch,operations,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;
  await assert.rejects(invokeWorkbench(tool,args,f.options()),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(f.requests.length,1);
 }
});
test('window rejects missing trusted receipt and checks late original without replay',async t=>{
 const f=await singleParameterWriteFixture(t,{hostPatch,operations,respond:false,respondEnvelope:r=>envelope(r,value)});
 for(const opts of [{retainReceiptOwner:false},{shouldContinue:undefined},{shouldContinue:()=>false}])await assert.rejects(invokeWorkbench(tool,args,f.options(opts)),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);let owner;
 await assert.rejects(invokeWorkbench(tool,args,f.options({timeout:80})),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
 assert.equal(f.requests.length,1);assert.equal(owner.inspect().value.status,'pending');await f.publish(f.requests[0]);assert.equal(owner.inspect().value.status,'received');assert.equal(f.requests.length,1);
});
test('late mismatched window receipt remains unconfirmed',async t=>{
 const f=await singleParameterWriteFixture(t,{hostPatch,operations,respond:false,respondEnvelope:r=>envelope(r,{...value,wall_id:'99'})});let owner;
 await assert.rejects(invokeWorkbench(tool,args,f.options({timeout:80})),e=>{owner=f.remember(workbenchFailureEvidence(e).receiptOwner);return true;});
 await f.publish(f.requests[0]);assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(f.requests.length,1);
});
