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
