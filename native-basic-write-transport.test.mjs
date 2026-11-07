import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {singleParameterWriteFixture,SOURCE_DOCUMENT,writeEnvelope} from './test-support/native-single-parameter-write-fixtures.mjs';
const operations=['create_level','create_grid','pin_element','unpin_element','create_floor_plan_view','create_3d_view'];
const hostPatch={version:'0.8.9',nativeBasicWritesVersion:1,nativeBasicWriteOperations:operations};
const args=(more)=>({expected_document:SOURCE_DOCUMENT.path,...more});
const envelope=(request,value)=>{const e=writeEnvelope(request,{value});e.result.operation=request.operation;return e;};

test('section view publishes only valid requests and preserves the actual rollback receipt',async t=>{
  const tool='revit_create_section_view',operation='create_section_view';
  const all=[...operations,operation],sectionHost={...hostPatch,nativeBasicWriteOperations:all};
  const parameters={name:'Section A',view_family_type_id:'9007199254740993',origin_mm:{x:-20,y:2100,z:3050},angle_degrees:225,width_mm:1200,height_mm:3450,depth_mm:4200};
  const {angle_degrees:angle,...facts}=parameters;
  const value={...facts,element_id:'9007199254740994',view_kind:'section',look_direction:{x:-Math.SQRT1_2,y:-Math.SQRT1_2,z:0}};
  const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});
  await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
  assert.equal(absent.requests.length,0);

  const fixture=await singleParameterWriteFixture(t,{hostPatch:sectionHost,operations:all,respondEnvelope:r=>envelope(r,value)});
  for(const change of [{name:' Bad'},{name:'Bad\u0007name'},{view_family_type_id:'9223372036854775808'},
    {origin_mm:{x:0,y:0,z:Infinity}},{angle_degrees:360},{angle_degrees:-0.01},{width_mm:99},{height_mm:1000001},{depth_mm:0},{extra:true}]){
    await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),fixture.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
  }
  assert.equal(fixture.requests.length,0);
  const result=await invokeWorkbench(tool,args(parameters),fixture.options());fixture.remember(result.receiptOwner);
  assert.equal(fixture.requests.length,1);
  assert.equal(fixture.requests[0].operation,operation);
  assert.equal(fixture.requests[0].args.mode,'rollback');
  assert.equal(fixture.requests[0].args.angle_degrees,angle);
  assert.deepEqual(result.value,value);
  assert.equal(result.receiptOwner.inspect().value.status,'received');
});

test('section geometry or type receipt drift stays unconfirmed without a replay',async t=>{
  const operation='create_section_view',all=[...operations,operation];
  const parameters={name:'Section A',view_family_type_id:'3',origin_mm:{x:10,y:20,z:30},angle_degrees:0,width_mm:1000,height_mm:3000,depth_mm:4000};
  const value={element_id:'5',view_kind:'section',name:parameters.name,view_family_type_id:'3',origin_mm:parameters.origin_mm,
    look_direction:{x:1,y:0,z:0},width_mm:1000,height_mm:3000,depth_mm:4000};
  for(const change of [{look_direction:{x:-1,y:0,z:0}},{origin_mm:{x:10.0008,y:20.0008,z:30}},{depth_mm:3999.998},{view_family_type_id:'4'}]){
    const fixture=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,
      respondEnvelope:r=>envelope(r,{...value,...change})});
    let owner;
    await assert.rejects(invokeWorkbench('revit_create_section_view',args(parameters),fixture.options()),error=>{
      const facts=workbenchFailureEvidence(error);owner=fixture.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';
    });
    assert.equal(owner.inspect().value.status,'unconfirmed');
    assert.equal(fixture.requests.length,1);
  }
});
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

test('duct capability and inputs are validated before queue; exact receipt retains rollback',async t=>{
 const operation='create_duct',tool='revit_create_duct',all=[...operations,operation],patch={...hostPatch,nativeBasicWriteOperations:all};
 const parameters={duct_type_id:'9007199254740993',system_type_id:'9007199254740994',level_id:'9007199254740995',start_mm:{x:0,y:2,z:3000},end_mm:{x:1000,y:2,z:3000}};
 for(const host of [{...patch,version:'0.8.8'},{...patch,nativeBasicWritesVersion:0},{...patch,nativeBasicWriteOperations:operations}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:all});
  await assert.rejects(invokeWorkbench(tool,args(parameters),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
 }
 const f=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,{element_id:'9007199254740996',...parameters})});
 for(const change of [{duct_type_id:'0'},{duct_type_id:'9223372036854775808'},{duct_type_id:9007199254740992},{system_type_id:'-1'},{system_type_id:'1.5'},{level_id:'0'},{start_mm:{x:0,y:0,z:NaN}},{end_mm:{x:0,y:2,z:3000}},{end_mm:{x:2.53,y:2,z:3000}},{mode:'invalid'}])
  await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);
 const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].operation,operation);assert.equal(f.requests[0].args.mode,'rollback');
 assert.deepEqual(result.value,{element_id:'9007199254740996',...parameters});assert.equal(result.receiptOwner.inspect().value.status,'received');
});

test('duct receipt identity mismatches remain unknown without replay',async t=>{
 const operation='create_duct',all=[...operations,operation],parameters={duct_type_id:'9007199254740993',system_type_id:'9007199254740994',level_id:'9007199254740995',start_mm:{x:0,y:0,z:3000},end_mm:{x:1000,y:0,z:3000}};
 for(const change of [{element_id:'0'},{duct_type_id:'4'},{system_type_id:'4'},{level_id:'4'},{start_mm:{x:1,y:0,z:3000}},{end_mm:{x:1001,y:0,z:3000}}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{element_id:'5',...parameters,...change})});let owner;
  await assert.rejects(invokeWorkbench('revit_create_duct',args(parameters),f.options()),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
  assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(f.requests.length,1);
 }
});


test('sheet capability and invalid inputs fail before queue; rollback preserves exact IDs',async t=>{
 const operation='create_sheet',tool='revit_create_sheet',all=[...operations,operation],patch={...hostPatch,nativeBasicWriteOperations:all};
 const parameters={name:'建筑平面',number:'A-101',titleblock_id:'9007199254740993'};
 for(const host of [{...patch,version:'0.8.8'},{...patch,nativeBasicWritesVersion:0},{...patch,nativeBasicWriteOperations:operations}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:all});
  await assert.rejects(invokeWorkbench(tool,args(parameters),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
 }
 const f=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,{element_id:'9007199254740994',name:r.args.name,number:r.args.number,is_placeholder:!r.args.titleblock_id,titleblock_id:r.args.titleblock_id??null})});
 for(const change of [{name:''},{name:' a'},{name:'a '},{name:'a\u0001b'},{name:'a\u0085b'},{name:'x'.repeat(256)},{number:''},{number:' A'},{number:'A '},{number:'A\u007f'},{number:'x'.repeat(256)},{titleblock_id:'0'},{titleblock_id:'9223372036854775808'},{titleblock_id:9007199254740992},{titleblock_id:null},{mode:'bad'}])
  await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);
 for(const input of [parameters,{name:'x'.repeat(255),number:'N'}]){
  const result=await invokeWorkbench(tool,args(input),f.options());f.remember(result.receiptOwner);
  const request=f.requests.at(-1);assert.equal(request.operation,operation);assert.equal(request.args.mode,'rollback');
  assert.deepEqual(result.value,{element_id:'9007199254740994',name:input.name,number:input.number,is_placeholder:!input.titleblock_id,titleblock_id:input.titleblock_id??null});
  assert.equal(result.receiptOwner.inspect().value.status,'received');
 }
});

test('sheet mismatched original receipt remains unconfirmed without replay',async t=>{
 const operation='create_sheet',all=[...operations,operation],parameters={name:'Sheet',number:'A1',titleblock_id:'9007199254740993'};
 for(const change of [{element_id:'0'},{name:'Other'},{number:'A2'},{is_placeholder:true},{titleblock_id:'9007199254740992'},{titleblock_id:null}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{element_id:'5',name:parameters.name,number:parameters.number,is_placeholder:false,titleblock_id:parameters.titleblock_id,...change})});let owner;
  await assert.rejects(invokeWorkbench('revit_create_sheet',args(parameters),f.options()),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
  assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(f.requests.length,1);
 }
});


test('viewport checks host capability and input before queue, retaining exact rollback receipt',async t=>{
 const operation='place_viewport_on_sheet',tool='revit_place_viewport_on_sheet',all=[...operations,operation],patch={...hostPatch,nativeBasicWriteOperations:all};
 const parameters={sheet_id:'9007199254740993',view_id:'9007199254740994',x_mm:-20,y_mm:30};
 for(const host of [{...patch,version:'0.8.8'},{...patch,nativeBasicWritesVersion:0},{...patch,nativeBasicWriteOperations:operations}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:all});
  await assert.rejects(invokeWorkbench(tool,args(parameters),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
 }
 const value={element_id:'9007199254740995',...parameters};
 const f=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,value)});
 for(const change of [{sheet_id:'0'},{sheet_id:'9223372036854775808'},{sheet_id:9007199254740992},{view_id:'-1'},{view_id:'1.5'},{x_mm:NaN},{x_mm:Infinity},{y_mm:-Infinity},{mode:'invalid'}])
  await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);
 const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].operation,operation);assert.equal(f.requests[0].args.mode,'rollback');
 assert.deepEqual(result.value,value);assert.equal(result.receiptOwner.inspect().value.status,'received');
});

test('viewport receipt verifies identities and Euclidean paper-space tolerance without replay',async t=>{
 const operation='place_viewport_on_sheet',all=[...operations,operation],parameters={sheet_id:'9007199254740993',view_id:'9007199254740994',x_mm:-20,y_mm:30};
 for(const change of [{element_id:'0'},{sheet_id:'9007199254740992'},{view_id:'4'},{x_mm:-19.9992,y_mm:30.0008},{x_mm:NaN},{y_mm:Infinity},{extra:true}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{element_id:'5',...parameters,...change})});let owner;
  await assert.rejects(invokeWorkbench('revit_place_viewport_on_sheet',args(parameters),f.options()),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
  assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(f.requests.length,1);
 }
 const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{element_id:'5',...parameters,x_mm:-19.9994,y_mm:30.0006})});
 const result=await invokeWorkbench('revit_place_viewport_on_sheet',args(parameters),f.options());f.remember(result.receiptOwner);assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(f.requests.length,1);
});

test('view template rejects old hosts and invalid IDs before queue, preserving rollback and no-op receipts',async t=>{
 const operation='apply_view_template',tool='revit_apply_view_template',all=[...operations,operation],patch={...hostPatch,nativeBasicWriteOperations:all};
 const parameters={view_id:'9007199254740993',template_id:'9007199254740994'};
 for(const host of [{...patch,version:'0.8.8'},{...patch,nativeBasicWritesVersion:0},{...patch,nativeBasicWriteOperations:operations}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:all});
  await assert.rejects(invokeWorkbench(tool,args(parameters),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
 }
 const f=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,{element_id:parameters.view_id,before_template_id:null,template_id:parameters.template_id,changed:true})});
 for(const change of [{view_id:'0'},{view_id:'9223372036854775808'},{view_id:9007199254740992},{view_id:'1.5'},{template_id:'-1'},{template_id:null},{template_id:parameters.view_id},{mode:'invalid'}])
  await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);
 const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].operation,operation);assert.equal(f.requests[0].args.mode,'rollback');
 assert.deepEqual(result.value,{element_id:parameters.view_id,before_template_id:null,template_id:parameters.template_id,changed:true});assert.equal(result.receiptOwner.inspect().value.status,'received');
 const noop=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,{element_id:parameters.view_id,before_template_id:parameters.template_id,template_id:parameters.template_id,changed:false})});
 const unchanged=await invokeWorkbench(tool,args(parameters),noop.options());noop.remember(unchanged.receiptOwner);assert.equal(unchanged.value.changed,false);assert.equal(unchanged.receiptOwner.inspect().value.status,'received');assert.equal(noop.requests.length,1);
});

test('view template mismatched original receipts remain unconfirmed without replay',async t=>{
 const operation='apply_view_template',all=[...operations,operation],parameters={view_id:'9007199254740993',template_id:'9007199254740994'};
 const value={element_id:parameters.view_id,before_template_id:null,template_id:parameters.template_id,changed:true};
 for(const change of [{element_id:'1'},{template_id:'1'},{before_template_id:'0'},{before_template_id:parameters.template_id},{changed:false},{extra:true}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;
  await assert.rejects(invokeWorkbench('revit_apply_view_template',args(parameters),f.options()),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
  assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(f.requests.length,1);
 }
});

test('text note validates host and inputs before queue and normalizes multiline rollback',async t=>{
 const operation='create_text_note',tool='revit_create_text_note',all=[...operations,operation],patch={...hostPatch,nativeBasicWriteOperations:all};
 const parameters={view_id:'9007199254740993',text_type_id:'9007199254740994',point_mm:{x:1,y:2,z:3},text:'第一行\r\n第二行\r第三行'};
 for(const host of [{...patch,version:'0.8.8'},{...patch,nativeBasicWritesVersion:0},{...patch,nativeBasicWriteOperations:operations}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:all});
  await assert.rejects(invokeWorkbench(tool,args(parameters),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
 }
 const value={element_id:'5',...parameters,text:'第一行\n第二行\n第三行'};
 const f=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,value)});
 for(const change of [{view_id:'0'},{view_id:'9223372036854775808'},{view_id:9007199254740992},{text_type_id:'-1'},{text_type_id:'1.5'},{point_mm:{x:NaN,y:0,z:0}},{point_mm:{x:Infinity,y:0,z:0}},{point_mm:{x:16093440,y:1,z:0}},{text:''},{text:' \n '},{text:'a'.repeat(2001)},{text:'a\t'},{text:'a\u0085'},{mode:'invalid'}])
  await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);
 const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].operation,operation);assert.equal(f.requests[0].args.mode,'rollback');assert.equal(f.requests[0].args.text,value.text);
 assert.deepEqual(result.value,value);assert.equal(result.receiptOwner.inspect().value.status,'received');
});

test('text note receipt mismatch remains unconfirmed without replay',async t=>{
 const operation='create_text_note',all=[...operations,operation],parameters={view_id:'2',text_type_id:'3',point_mm:{x:1,y:2,z:3},text:'a\nb'};
 const value={element_id:'5',...parameters};
 for(const change of [{element_id:'0'},{view_id:'4'},{text_type_id:'4'},{point_mm:{x:1.0008,y:2.0008,z:3}},{point_mm:{x:NaN,y:2,z:3}},{text:'a\r\nb'},{extra:true}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;
  await assert.rejects(invokeWorkbench('revit_create_text_note',args(parameters),f.options()),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
  assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(f.requests.length,1);
 }
 const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,point_mm:{x:1.0006,y:2.0006,z:3}})});
 const result=await invokeWorkbench('revit_create_text_note',args(parameters),f.options());f.remember(result.receiptOwner);assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(f.requests.length,1);
});

test('schedule requires capability, preserves receipt and rejects result drift without replay',async t=>{
  const tool='revit_create_schedule',operation='create_schedule',all=[...operations,operation];
  const parameters={name:'Walls schedule',category:'OST_Walls'},value={element_id:'9007199254740993',...parameters,field_count:0};
  const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});
  await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
  const fixture=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});
  for(const change of [{name:' Bad'},{name:'Bad\u0007name'},{category:'Walls'},{extra:true}])await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),fixture.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
  assert.equal(fixture.requests.length,0);
  const result=await invokeWorkbench(tool,args(parameters),fixture.options());fixture.remember(result.receiptOwner);
  assert.equal(fixture.requests.length,1);assert.equal(fixture.requests[0].args.mode,'rollback');assert.deepEqual(result.value,value);assert.equal(result.receiptOwner.inspect().value.status,'received');
  for(const change of [{field_count:1},{category:'OST_Doors'},{name:'other'}]){
    const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;
    await assert.rejects(invokeWorkbench(tool,args(parameters),f.options()),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
    assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(f.requests.length,1);
  }
});


test('material validates before queue, reads graphics exactly and retains mismatched original receipt',async t=>{
 const operation='create_material',tool='revit_create_material',all=[...operations,operation];
 const parameters={name:'Test material',red:12,green:34,blue:56,transparency:25};
 const patch={...hostPatch,nativeBasicWriteOperations:all},value={element_id:'5',...parameters,shininess:50,smoothness:50};
 for(const host of [{...patch,version:'0.8.8'},{...patch,nativeBasicWriteOperations:operations}]){
  const unsupported=await singleParameterWriteFixture(t,{hostPatch:host,operations:all});
  await assert.rejects(invokeWorkbench(tool,args(parameters),unsupported.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(unsupported.requests.length,0);
 }
 const f=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,value)});
 for(const change of [{name:''},{name:' bad '},{red:-1},{green:256},{blue:1.5},{transparency:101},{shininess:129},{shininess:-1},{smoothness:101},{smoothness:1.5},{texture:'file'}])
  await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);
 const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);
 assert.deepEqual(result.value,value);assert.equal(f.requests[0].args.mode,'rollback');assert.equal(f.requests[0].args.shininess,50);assert.equal(f.requests[0].args.smoothness,50);assert.equal(f.requests.length,1);
 const bad=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,{...value,red:13})});let owner;
 await assert.rejects(invokeWorkbench(tool,args(parameters),bad.options()),e=>{const facts=workbenchFailureEvidence(e);owner=bad.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
 assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(bad.requests.length,1);
});


test('material explicit shine and smoothness values are read back exactly',async t=>{
 const operation='create_material',all=[...operations,operation],parameters={name:'Bounds',red:0,green:255,blue:0,transparency:100,shininess:128,smoothness:0};
 const value={element_id:'5',...parameters},patch={...hostPatch,nativeBasicWriteOperations:all};
 const f=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,value)});
 const result=await invokeWorkbench('revit_create_material',args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,value);
 for(const change of [{shininess:127},{smoothness:1}]){
  const bad=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;
  await assert.rejects(invokeWorkbench('revit_create_material',args(parameters),bad.options()),e=>{const facts=workbenchFailureEvidence(e);owner=bad.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
  assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(bad.requests.length,1);
 }
});

test('change type checks host and exact IDs, preserves original receipt, never replays drift',async t=>{
  const tool='revit_change_element_type',operation='change_element_type',all=[...operations,operation];
  const parameters={element_id:'9007199254740993',target_type_id:'9007199254740994'},value={element_id:parameters.element_id,before_type_id:'42',target_type_id:parameters.target_type_id,changed:true};
  const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
  const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});
  for(const change of [{element_id:'0'},{element_id:9007199254740992},{target_type_id:'9223372036854775808'},{element_ids:['1','1']},{extra:1}])await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
  assert.equal(f.requests.length,0);const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,value);assert.equal(f.requests[0].args.mode,'rollback');assert.equal(result.receiptOwner.inspect().value.status,'received');
  for(const change of [{element_id:'3'},{target_type_id:'2'},{before_type_id:'0'},{changed:false}]){const x=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;await assert.rejects(invokeWorkbench(tool,args(parameters),x.options()),e=>{const facts=workbenchFailureEvidence(e);owner=x.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(x.requests.length,1);}
});
test('room requires named host and preserves exact receipt, phase facts and unknown outcomes',async t=>{
 const op='create_room',all=[...operations,op],input={level_id:'3',point_xy_mm:{x:100,y:-200},name:'Office',number:'101'};
 const value={element_id:'5',...input,phase_id:'8',area_internal:120,volume_internal:null};
 const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});
 await assert.rejects(invokeWorkbench('revit_create_room',args(input),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const good=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});
 await assert.rejects(invokeWorkbench('revit_create_room',args({...input,phase_id:'8'}),good.options()));
 const result=await invokeWorkbench('revit_create_room',args(input),good.options());good.remember(result.receiptOwner);
 assert.equal(result.value.phase_id,'8');assert.equal(result.value.volume_internal,null);assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(good.requests.length,1);
 const bad=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,level_id:'4'})});let owner;
 await assert.rejects(invokeWorkbench('revit_create_room',args(input),bad.options()),e=>{const facts=workbenchFailureEvidence(e);owner=bad.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
 assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(bad.requests.length,1);
});

test('group checks exact members and original receipt without replay',async t=>{
 const tool='revit_create_group',operation='create_group',all=[...operations,operation],parameters={name:'Group A',element_ids:['9007199254740993','9007199254740994']},value={element_id:'3',name:'Group A',element_ids:parameters.element_ids};
 const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const fixture=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});
 for(const change of [{name:' Bad'},{element_ids:['1']},{element_ids:[1,'1']},{element_ids:[9007199254740992,2]},{element_ids:['9223372036854775808','2']},{element_ids:['1','2'],extra:true}])await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),fixture.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(fixture.requests.length,0);const result=await invokeWorkbench(tool,args(parameters),fixture.options());fixture.remember(result.receiptOwner);assert.deepEqual(result.value,value);assert.equal(fixture.requests[0].args.mode,'rollback');assert.equal(result.receiptOwner.inspect().value.status,'received');
 for(const change of [{element_ids:['9007199254740993','5']},{element_ids:['9007199254740993','9007199254740993']},{name:'other'}]){const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;await assert.rejects(invokeWorkbench(tool,args(parameters),f.options()),e=>{const x=workbenchFailureEvidence(e);owner=f.remember(x.receiptOwner);return x.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(f.requests.length,1);}
});

test('column native capability, exact rollback receipt and mismatch remain guarded',async t=>{
 const operation='create_column',all=[...operations,operation],input={symbol_id:'3',base_level_id:'1',top_level_id:'2',point_mm:{x:304.8,y:609.6,z:0}};
 const value={element_id:'20',...input,column_kind:'vertical',base_elevation_mm:0,top_elevation_mm:3048,height_mm:3048};
 const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench('revit_create_column',args(input),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const good=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});
 await assert.rejects(invokeWorkbench('revit_create_column',args({...input,top_level_id:'1'}),good.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 const result=await invokeWorkbench('revit_create_column',args(input),good.options());good.remember(result.receiptOwner);assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(good.requests[0].args.mode,'rollback');assert.equal(good.requests.length,1);
 for(const delta of [{top_level_id:'9'},{height_mm:3000},{point_mm:{x:304.8,y:609.6,z:1}},{column_kind:'slanted'}]){
  const bad=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...delta})});let owner;
  await assert.rejects(invokeWorkbench('revit_create_column',args(input),bad.options()),e=>{const facts=workbenchFailureEvidence(e);owner=bad.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(bad.requests.length,1);
 }
});

test('beam checks capability and exact geometry receipts without replay',async t=>{
 const tool='revit_create_beam',operation='create_beam',all=[...operations,operation],parameters={symbol_id:'9007199254740993',level_id:'9007199254740994',start_mm:{x:0,y:0,z:100},end_mm:{x:1000,y:0,z:200}},value={element_id:'3',...parameters};
 const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});
 for(const change of [{symbol_id:'0'},{level_id:9007199254740992},{end_mm:{x:0,y:0,z:100}},{extra:1}])await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,value);assert.equal(f.requests[0].args.mode,'rollback');assert.equal(result.receiptOwner.inspect().value.status,'received');
 for(const change of [{level_id:'2'},{symbol_id:'2'},{end_mm:{x:1001,y:0,z:200}}]){const x=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;await assert.rejects(invokeWorkbench(tool,args(parameters),x.options()),e=>{const facts=workbenchFailureEvidence(e);owner=x.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(x.requests.length,1);}
});

test('roof validates host and input and retains original receipt without replay',async t=>{
 const tool='revit_create_roof',operation='create_roof',all=[...operations,operation],parameters={roof_type_id:'9007199254740993',level_id:'9007199254740994',origin_xy_mm:{x:0,y:100},width_mm:3000,depth_mm:2000},value={element_id:'3',...parameters,slope:0};
 const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});
 for(const change of [{roof_type_id:'0'},{level_id:9007199254740992},{width_mm:99},{depth_mm:1000001},{extra:1}])await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,value);assert.equal(f.requests[0].args.mode,'rollback');assert.equal(result.receiptOwner.inspect().value.status,'received');
 for(const change of [{roof_type_id:'4'},{origin_xy_mm:{x:0,y:101}},{width_mm:2999},{slope:1}]){const x=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;await assert.rejects(invokeWorkbench(tool,args(parameters),x.options()),e=>{const facts=workbenchFailureEvidence(e);owner=x.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(x.requests.length,1);}
});

test('material assignment requires exact prior state and retains unknown original receipt',async t=>{
 const operation='set_element_material',tool='revit_set_element_material',all=[...operations,operation],patch={...hostPatch,nativeBasicWriteOperations:all};
 const parameters={element_id:'101',parameter_id:'-123',material_id:'202',expected_has_value:true,expected_value_internal:'-1'};
 const value={element_id:'101',parameter_id:'-123',material_id:'202',before_has_value:true,before_value_internal:'-1',changed:true};
 const f=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,value)});
 for(const change of [{parameter_id:'-1'},{expected_has_value:false},{material_id:0},{element_id:9007199254740992},{face_index:0}])await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,value);assert.equal(f.requests[0].args.mode,'rollback');
 const bad=await singleParameterWriteFixture(t,{hostPatch:patch,operations:all,respondEnvelope:r=>envelope(r,{...value,material_id:'203'})});let owner;
 await assert.rejects(invokeWorkbench(tool,args(parameters),bad.options()),e=>{const facts=workbenchFailureEvidence(e);owner=bad.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(bad.requests.length,1);
});

test('foundation requires named host and exact original rollback receipt without replay',async t=>{
 const tool='revit_create_foundation',operation='create_foundation',all=[...operations,operation],parameters={symbol_id:'9007199254740993',level_id:'9007199254740994',point_mm:{x:100,y:200,z:300}},value={element_id:'3',...parameters,foundation_kind:'isolated',level_elevation_mm:300};
 const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});
 for(const change of [{symbol_id:'0'},{level_id:9007199254740992},{point_mm:{x:NaN,y:0,z:0}},{host_id:1}])await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,value);assert.equal(f.requests[0].args.mode,'rollback');assert.equal(result.receiptOwner.inspect().value.status,'received');
 for(const change of [{level_id:'2'},{symbol_id:'2'},{point_mm:{x:101,y:200,z:300}},{foundation_kind:'other'},{level_elevation_mm:301}]){const x=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;await assert.rejects(invokeWorkbench(tool,args(parameters),x.options()),e=>{const facts=workbenchFailureEvidence(e);owner=x.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(x.requests.length,1);}
});
test('ungroup checks capability, exact group ID and original member receipt without replay',async t=>{
 const tool='revit_ungroup',operation='ungroup',all=[...operations,operation],parameters={group_id:'9007199254740993'},value={element_id:parameters.group_id,name:'Group A',member_ids:['9007199254740994','12'],member_count:2};
 const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});for(const change of [{group_id:'0'},{group_id:9007199254740992},{group_id:'9223372036854775808'},{extra:1}])await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
 const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,value);assert.equal(f.requests[0].args.mode,'rollback');assert.equal(result.receiptOwner.inspect().value.status,'received');
 for(const change of [{element_id:'5'},{member_ids:['12','12']},{member_count:3},{member_ids:['0','12']}]){const x=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;await assert.rejects(invokeWorkbench(tool,args(parameters),x.options()),e=>{const facts=workbenchFailureEvidence(e);owner=x.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(x.requests.length,1);}
});
test('duplicate sheet validates empty option and original receipt without replay',async t=>{const tool='revit_duplicate_sheet',operation='duplicate_sheet',all=[...operations,operation],parameters={source_sheet_id:'9007199254740993',name:'Copy',number:'A101',copy_option:'empty'},value={element_id:'3',...parameters,titleblock_type_id:'9',viewport_count:0,placed_view_count:0,schedule_count:0};const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});for(const change of [{source_sheet_id:'0'},{source_sheet_id:9007199254740992},{copy_option:'with_views'},{name:' bad'},{number:' '},{extra:1}])await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,value);assert.equal(f.requests[0].args.mode,'rollback');
 for(const change of [{element_id:parameters.source_sheet_id},{source_sheet_id:'2'},{viewport_count:1},{schedule_count:1},{titleblock_type_id:'0'}]){const x=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;await assert.rejects(invokeWorkbench(tool,args(parameters),x.options()),e=>{const facts=workbenchFailureEvidence(e);owner=x.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(x.requests.length,1);}});
test('sheet renumber capability and exact receipt bind rows and do not replay mismatches',async t=>{
 const operation='renumber_sheets',all=[...operations,operation],sheets=[{sheet_id:'3',expected_number:'A',new_number:'B'},{sheet_id:'4',expected_number:'B',new_number:'A'}];
 const value={count:2,sheets:sheets.map((x,i)=>({...x,unique_id:'sheet-'+i}))};
 const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench('revit_renumber_sheets',args({sheets}),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const good=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});
 for(const invalid of [[sheets[0],{...sheets[1],sheet_id:'3'}],[sheets[0],{...sheets[1],new_number:'b'}],[{...sheets[0],expected_number:' A'}]])await assert.rejects(invokeWorkbench('revit_renumber_sheets',args({sheets:invalid}),good.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 const result=await invokeWorkbench('revit_renumber_sheets',args({sheets}),good.options());good.remember(result.receiptOwner);assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(good.requests[0].args.mode,'rollback');assert.equal(good.requests.length,1);
 const bad=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,sheets:[value.sheets[1],value.sheets[0]]})});let owner;
 await assert.rejects(invokeWorkbench('revit_renumber_sheets',args({sheets}),bad.options()),e=>{const facts=workbenchFailureEvidence(e);owner=bad.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(bad.requests.length,1);
});
test('mirror checks capability, reflected transforms and original receipt without replay',async t=>{const tool='revit_mirror_element',operation='mirror_element',all=[...operations,operation],parameters={element_id:'9007199254740993',plane_origin_mm:{x:0,y:0,z:0},plane_normal:{x:1,y:0,z:0}},value={element_id:'3',source_element_id:parameters.element_id,type_id:'7',level_id:'9',source_position_mm:{x:100,y:200,z:300},position_mm:{x:-100,y:200,z:300},source_basis_x:{x:1,y:0,z:0},source_basis_y:{x:0,y:1,z:0},source_basis_z:{x:0,y:0,z:1},basis_x:{x:-1,y:0,z:0},basis_y:{x:0,y:1,z:0},basis_z:{x:0,y:0,z:1}};const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});for(const change of [{element_id:'0'},{element_id:9007199254740992},{plane_normal:{x:2,y:0,z:0}},{plane_normal:{x:0,y:0,z:1}},{extra:1}])await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,value);assert.equal(f.requests[0].args.mode,'rollback');
 for(const change of [{source_element_id:'2'},{position_mm:{x:100,y:200,z:300}},{basis_x:{x:1,y:0,z:0}}]){const x=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;await assert.rejects(invokeWorkbench(tool,args(parameters),x.options()),e=>{const facts=workbenchFailureEvidence(e);owner=x.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(x.requests.length,1);}});

test('selection requires capability and confirms actual UI state without a transaction or replay',async t=>{
 const tool='revit_set_selection',parameters={element_ids:[3,1]},cap={nativeSelectionWritesVersion:1,nativeSelectionWriteOperations:['set_selection']};
 const response=r=>{const e=writeEnvelope(r,{value:{selected_ids:[1,3],count:2}});e.result={operation:'set_selection',hostSession:SOURCE_DOCUMENT.session,document:{title:SOURCE_DOCUMENT.title,path:SOURCE_DOCUMENT.path},effect:'ui_selection',value:{selected_ids:[1,3],count:2}};return e;};
 const absent=await singleParameterWriteFixture(t,{operations:['set_selection']});await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const f=await singleParameterWriteFixture(t,{hostPatch:cap,operations:['set_selection'],respondEnvelope:response});
 for(const bad of [{element_ids:[1,1]},{element_ids:[0]},{element_ids:[9007199254740992]},{element_ids:[1],mode:'rollback'}])await assert.rejects(invokeWorkbench(tool,args(bad),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,{selected_ids:[1,3],count:2});assert.equal(f.requests[0].args.mode,undefined);assert.equal(result.receiptOwner.inspect().value.status,'received');
 const x=await singleParameterWriteFixture(t,{hostPatch:cap,operations:['set_selection'],respondEnvelope:r=>{const e=response(r);e.result.value={selected_ids:[1],count:1};return e;}});let owner;
 await assert.rejects(invokeWorkbench(tool,args(parameters),x.options()),e=>{const facts=workbenchFailureEvidence(e);owner=x.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(x.requests.length,1);
});


test('selection clear and mismatched host or document remain fail closed',async t=>{
 const tool='revit_set_selection',cap={nativeSelectionWritesVersion:1,nativeSelectionWriteOperations:['set_selection']};
 const respond=(r,patch={})=>{const e=writeEnvelope(r,{value:{selected_ids:[],count:0}});e.result={operation:'set_selection',hostSession:SOURCE_DOCUMENT.session,document:{title:SOURCE_DOCUMENT.title,path:SOURCE_DOCUMENT.path},effect:'ui_selection',value:{selected_ids:[],count:0},...patch};return e;};
 const f=await singleParameterWriteFixture(t,{hostPatch:cap,operations:['set_selection'],respondEnvelope:r=>respond(r)});
 await assert.rejects(invokeWorkbench(tool,args({element_ids:[]}),f.options({retainReceiptOwner:false})),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
 const result=await invokeWorkbench(tool,args({element_ids:[]}),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,{selected_ids:[],count:0});
 for(const patch of [{hostSession:'d'.repeat(32)},{document:{title:SOURCE_DOCUMENT.title,path:'D:\\other.rvt'}},{effect:'model_transaction'}]){
  const x=await singleParameterWriteFixture(t,{hostPatch:cap,operations:['set_selection'],respondEnvelope:r=>respond(r,patch)});let owner;
  await assert.rejects(invokeWorkbench(tool,args({element_ids:[]}),x.options()),e=>{const facts=workbenchFailureEvidence(e);owner=x.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(x.requests.length,1);
 }
});
test('titleblock changes validate owners, exact before states and guarded receipts',async t=>{const tool='revit_populate_titleblock',operation='populate_titleblock',all=[...operations,operation],state={storage_type:'String',has_value:true,value_internal:'old',data_type:'text'},change={element_id:'11',parameter_id:'12',value:'new',expected_state:state},parameters={sheet_id:'10',titleblock_id:'11',changes:[change]},row={element_id:'11',parameter_id:'12',storage_type:'String',data_type:'text',changed:true,before_internal:'old',after_internal:'new'},value={element_id:'11',sheet_id:'10',results:[{schema_version:1,target_kind:'instance',before:state,result:{updated_count:1,changes:[row]}}]};
 const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});
 for(const patch of [{changes:[change,change]},{titleblock_id:'22'},{changes:[{...change,expected_state:{...state,has_value:false}}]},{changes:[]},{extra:1}])await assert.rejects(invokeWorkbench(tool,args({...parameters,...patch}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,value);assert.equal(f.requests[0].args.mode,'rollback');
 const x=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,results:[{...value.results[0],before:{...state,value_internal:'drift'}}]})});let owner;await assert.rejects(invokeWorkbench(tool,args(parameters),x.options()),e=>{const facts=workbenchFailureEvidence(e);owner=x.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(x.requests.length,1);});


test('UniqueId selection validates capabilities and exact UID-to-ID original receipt',async t=>{
 const tool='revit_select_by_unique_ids',parameters={element_uids:['uid-b','uid-a']},cap={nativeSelectionWritesVersion:1,nativeSelectionWriteOperations:['set_selection','select_by_unique_ids']};
 const value={selected:[{unique_id:'uid-a',element_id:'9007199254740993'},{unique_id:'uid-b',element_id:'7'}],count:2};
 const response=r=>{const e=writeEnvelope(r,{value});e.result={operation:'select_by_unique_ids',hostSession:SOURCE_DOCUMENT.session,document:{title:SOURCE_DOCUMENT.title,path:SOURCE_DOCUMENT.path},effect:'ui_selection',value};return e;};
 const absent=await singleParameterWriteFixture(t,{hostPatch:{nativeSelectionWritesVersion:1,nativeSelectionWriteOperations:['set_selection']},operations:['select_by_unique_ids']});await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const f=await singleParameterWriteFixture(t,{hostPatch:cap,operations:['select_by_unique_ids'],respondEnvelope:response});
 for(const bad of [{element_uids:[]},{element_uids:['a','a']},{element_uids:[' a']},{element_uids:['a\u0000']},{element_uids:['a'],mode:'rollback'},{element_uids:['a'],zoom:true}])await assert.rejects(invokeWorkbench(tool,args(bad),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 assert.equal(f.requests.length,0);const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,value);assert.equal(f.requests[0].args.mode,undefined);assert.equal(result.receiptOwner.inspect().value.status,'received');
 for(const bad of [{selected:[{unique_id:'uid-a',element_id:'7'},{unique_id:'uid-b',element_id:'7'}],count:2},{selected:[{unique_id:'uid-a',element_id:'1'},{unique_id:'uid-c',element_id:'2'}],count:2}]){const x=await singleParameterWriteFixture(t,{hostPatch:cap,operations:['select_by_unique_ids'],respondEnvelope:r=>{const e=response(r);e.result.value=bad;return e;}});let owner;await assert.rejects(invokeWorkbench(tool,args(parameters),x.options()),e=>{const facts=workbenchFailureEvidence(e);owner=x.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(x.requests.length,1);}
});


test('existing ElementId selection accepts a host advertising both UI selection operations',async t=>{
 const cap={nativeSelectionWritesVersion:1,nativeSelectionWriteOperations:['set_selection','select_by_unique_ids']};
 const f=await singleParameterWriteFixture(t,{hostPatch:cap,operations:['set_selection'],respondEnvelope:r=>{const e=writeEnvelope(r,{value:{selected_ids:[1],count:1}});e.result={operation:'set_selection',hostSession:SOURCE_DOCUMENT.session,document:{title:SOURCE_DOCUMENT.title,path:SOURCE_DOCUMENT.path},effect:'ui_selection',value:{selected_ids:[1],count:1}};return e;}});
 const result=await invokeWorkbench('revit_set_selection',args({element_ids:[1]}),f.options());f.remember(result.receiptOwner);assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(f.requests.length,1);
});

test('family type batch validates IDs and retains original receipt without replay',async t=>{const tool='revit_replace_family_type',operation='replace_family_type',all=[...operations,operation],parameters={element_ids:['9007199254740993','9007199254740994'],old_type_id:'7',new_type_id:'8'},value={...parameters,changed_count:2};const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench(tool,args(parameters),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const f=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});for(const change of [{element_ids:[1,'1']},{element_ids:[]},{element_ids:[9007199254740992]},{new_type_id:'7'},{old_type_id:'0'},{extra:1}])await assert.rejects(invokeWorkbench(tool,args({...parameters,...change}),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);const result=await invokeWorkbench(tool,args(parameters),f.options());f.remember(result.receiptOwner);assert.deepEqual(result.value,value);assert.equal(f.requests[0].args.mode,'rollback');
 for(const change of [{element_ids:['9007199254740993','2']},{changed_count:1},{new_type_id:'9'}]){const x=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,...change})});let owner;await assert.rejects(invokeWorkbench(tool,args(parameters),x.options()),e=>{const facts=workbenchFailureEvidence(e);owner=x.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(x.requests.length,1);}});

test('batch sheet creation requires capability, exact row receipts and no replay',async t=>{
 const operation='batch_create_sheets_from_csv',all=[...operations,operation],sheets=[{name:'Plan',number:'A101',titleblock_id:'7'},{name:'Index',number:'A102'}];
 const value={count:2,sheets:[{element_id:'30',unique_id:'sheet-30',name:'Plan',number:'A101',is_placeholder:false,titleblock_id:'7'},{element_id:'31',unique_id:'sheet-31',name:'Index',number:'A102',is_placeholder:true,titleblock_id:null}]};
 const absent=await singleParameterWriteFixture(t,{hostPatch,operations:all});await assert.rejects(invokeWorkbench('revit_batch_create_sheets_from_csv',args({sheets}),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const good=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,value)});
 for(const invalid of [[sheets[0],{...sheets[1],number:'a101'}],[{...sheets[0],name:' '}],[{...sheets[0],titleblock_id:'0'}]])await assert.rejects(invokeWorkbench('revit_batch_create_sheets_from_csv',args({sheets:invalid}),good.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');
 const result=await invokeWorkbench('revit_batch_create_sheets_from_csv',args({sheets}),good.options());good.remember(result.receiptOwner);assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(good.requests[0].args.mode,'rollback');assert.equal(good.requests.length,1);
 const bad=await singleParameterWriteFixture(t,{hostPatch:{...hostPatch,nativeBasicWriteOperations:all},operations:all,respondEnvelope:r=>envelope(r,{...value,sheets:[{...value.sheets[0],titleblock_id:'8'},value.sheets[1]]})});let owner;
 await assert.rejects(invokeWorkbench('revit_batch_create_sheets_from_csv',args({sheets}),bad.options()),e=>{const facts=workbenchFailureEvidence(e);owner=bad.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(owner.inspect().value.status,'unconfirmed');assert.equal(bad.requests.length,1);
});
