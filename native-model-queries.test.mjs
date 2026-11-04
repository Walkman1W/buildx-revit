import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {
  NATIVE_MODEL_QUERY_TOOLS,NATIVE_MODEL_QUERY_NAMES,NATIVE_MODEL_QUERY_OPERATION_BY_TOOL,
  NATIVE_MODEL_QUERY_CATEGORY_ALIASES,assertNativeModelQueryArguments,
  assertNativeModelQueryResult,supportsNativeModelQueries
} from './lib/native-model-queries.mjs';

const capable=()=>({version:'0.8.1',atomicReadSnapshot:true,nativeModelQueriesVersion:1,nativeModelQueryOperations:Object.values(NATIVE_MODEL_QUERY_OPERATION_BY_TOOL)});
const page=(items,extra={})=>({schema_version:1,items,offset:0,limit:200,total:items.length,has_more:false,coverage:{scanned:items.length,complete:true,stop_reason:null},...extra});
const parameter=(extra={})=>({parameter_id:'-1001001',name:'Length',storage_type:'Double',is_read_only:false,has_value:true,data_type:'autodesk.spec.aec:length-2.0.0',unit_type:'autodesk.unit.unit:millimeters-1.0.1',value_internal:3.280839895,value_display:'1000 mm',...extra});
const geometry=()=>({schema_version:1,element_id:'9223372036854775807',representation:'summary_no_mesh',coordinate_system:'revit_internal',location:{kind:'curve',start_mm:{x:0,y:0,z:0},end_mm:{x:1000,y:0,z:0}},bounding_box:{min_mm:{x:0,y:-5,z:-5},max_mm:{x:1000,y:5,z:5}},level:{id:'31',name:'L1'},length:{value:1000,unit:'mm'},area:null,volume:null,unavailable:{location:null,bounding_box:null,level:null,length:null,area:'not_applicable',volume:'no_value'}});

test('six native names own frozen input, output and operation contracts without a provider',()=>{
  assert.equal(NATIVE_MODEL_QUERY_TOOLS.length,6);
  assert.deepEqual(NATIVE_MODEL_QUERY_TOOLS.map(tool=>tool.name),NATIVE_MODEL_QUERY_NAMES);
  for(const tool of NATIVE_MODEL_QUERY_TOOLS){
    assert.ok(NATIVE_MODEL_QUERY_OPERATION_BY_TOOL[tool.name]);
    assert.equal(tool.inputSchema.additionalProperties,false);
    assert.equal(tool.annotations.readOnlyHint,true);
    assert.ok(Object.isFrozen(tool.inputSchema.properties));
    assert.ok(tool.outputSchema.properties.value.properties.schema_version);
    assert.equal(tool.outputSchema.properties.operation.enum[0],NATIVE_MODEL_QUERY_OPERATION_BY_TOOL[tool.name]);
    assert.ok(tool.outputSchema.required.includes('request_id'));
  }
});
test('capability evidence requires current version, exact contract and the requested native operation before publication',()=>{
  assert.equal(supportsNativeModelQueries(capable()),true);
  assert.equal(supportsNativeModelQueries(capable(),'list_views'),true);
  for(const patch of [{version:'0.8.0'},{version:'0.8.1-preview'},{atomicReadSnapshot:false},{nativeModelQueriesVersion:0},{nativeModelQueriesVersion:2},{nativeModelQueryOperations:undefined},{nativeModelQueryOperations:['health']}]){
    assert.equal(supportsNativeModelQueries({...capable(),...patch}),false,JSON.stringify(patch));
  }
  assert.equal(supportsNativeModelQueries({...capable(),nativeModelQueryOperations:['health']},'list_views'),false);
});
test('argument owner preserves decimal Int64 IDs and rejects unsafe rounded IDs or unowned fields',()=>{
  const name='revit_get_element_parameters';
  for(const id of [1,Number.MAX_SAFE_INTEGER,'9007199254740993','9223372036854775807'])assert.equal(assertNativeModelQueryArguments(name,{element_id:id}).element_id,id);
  for(const id of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'01','1.0','9223372036854775808','1e4'])assert.throws(()=>assertNativeModelQueryArguments(name,{element_id:id}),/contract/);
  assert.throws(()=>assertNativeModelQueryArguments(name,{element_id:1,code:'unregistered'}),/unknown/);
  assert.deepEqual(assertNativeModelQueryArguments('revit_health',{expected_document:''}),{expected_document:''});
});
test('type, category, exact level and fields remain independent inputs with bounded pagination',()=>{
  const input=assertNativeModelQueryArguments('revit_get_elements_by_type',{type_id:'9007199254740993',category:'Walls',level:'L1',level_id:31,fields:['name','length'],offset:800,limit:500});
  assert.equal(input.type_id,'9007199254740993');assert.equal(input.level,'L1');assert.deepEqual(input.fields,['name','length']);
  assert.equal(NATIVE_MODEL_QUERY_CATEGORY_ALIASES.Walls,'OST_Walls');
  assert.equal(assertNativeModelQueryArguments('revit_get_elements_by_type',{category:'OST_PipeCurves'}).category,'OST_PipeCurves');
  assert.equal(assertNativeModelQueryArguments('revit_get_elements_by_type',{category:'MechanicalEquipment'}).category,'MechanicalEquipment');
  assert.throws(()=>assertNativeModelQueryArguments('revit_get_elements_by_type',{category:'walls'}),/category/);
  for(const patch of [{category:'wall'},{level:''},{level_id:'00'},{fields:['name','name']},{fields:['arbitrary']},{limit:501},{offset:-1}])assert.throws(()=>assertNativeModelQueryArguments('revit_get_elements_by_type',patch),/contract/);
  assert.deepEqual(assertNativeModelQueryArguments('revit_get_elements_by_type',{}).fields,['name','category','type_id','level']);
});
test('pagination cannot publish missing rows, false coverage or duplicate/out-of-order identities',()=>{
  const item=id=>({id,name:'Plan',view_type:'FloorPlan',is_template:false});
  assertNativeModelQueryResult('revit_list_views',page([item('41'),item('9007199254740993')]));
  for(const value of [page([item('41')],{total:4}),page([item('41')],{coverage:{scanned:0,complete:true,stop_reason:null}}),page([item('41')],{coverage:{scanned:1,complete:false,stop_reason:'scan_budget'}}),page([item('41'),item('41')]),page([item('42'),item('41')])])assert.throws(()=>assertNativeModelQueryResult('revit_list_views',value),/contract/);
  assertNativeModelQueryResult('revit_list_views',page([],{offset:800,total:3,coverage:{scanned:3,complete:true,stop_reason:null}}),{offset:800});
});
test('returned fields, units, category, type and level identities match the chosen request',()=>{
  const args={category:'Walls',type_id:12,level_id:31,level:'L1',fields:['category','type_id','level','length']};
  const item={id:'41',category:{id:'-2000011',name:'墙',built_in_category:'OST_Walls'},type_id:'12',level:{id:'31',name:'L1'},length:{value:1000,unit:'mm'}};
  assertNativeModelQueryResult('revit_get_elements_by_type',page([item]),args);
  for(const patch of [{type_id:'13'},{type_id:null},{category:{...item.category,built_in_category:'OST_Doors'}},{category:null},{level:{id:'32',name:'L1'}},{level:null},{name:'not requested'},{length:{value:1,unit:'ft'}}])assert.throws(()=>assertNativeModelQueryResult('revit_get_elements_by_type',page([{...item,...patch}]),args),/contract/);
});
test('parameter facts retain raw/display distinction, signed identities and exact ElementId references',()=>{
  const body={schema_version:1,element_id:'9007199254740993',element_name:'Wall',parameters:[parameter(),parameter({parameter_id:'2',name:'Reference',storage_type:'ElementId',value_internal:'9223372036854775807',value_display:'reference',unit_type:null})]};
  assertNativeModelQueryResult('revit_get_element_parameters',body,{element_id:'9007199254740993'});
  for(const value of [{...body,element_id:'9007199254740994'},{...body,parameters:[parameter({has_value:false})]},{...body,parameters:[parameter({storage_type:'ElementId',value_internal:9007199254740992})]},{...body,parameters:[parameter(),parameter()]}])assert.throws(()=>assertNativeModelQueryResult('revit_get_element_parameters',value,{element_id:'9007199254740993'}),/contract/);
});
test('geometry is a bounded model-coordinate summary with explicit missing facts, units and identity',()=>{
  assertNativeModelQueryResult('revit_get_element_geometry',geometry(),{element_id:'9223372036854775807'});
  for(const patch of [{coordinate_system:'shared'},{representation:'mesh'},{area:{value:1,unit:'ft2'}},{unavailable:{...geometry().unavailable,area:null}},{bounding_box:{min_mm:{x:1001,y:0,z:0},max_mm:{x:1000,y:1,z:1}}}])assert.throws(()=>assertNativeModelQueryResult('revit_get_element_geometry',{...geometry(),...patch}),/contract/);
  assert.throws(()=>assertNativeModelQueryResult('revit_get_element_geometry',geometry(),{element_id:'41'}),/identity/);
});
test('health and document output cannot invent an open model or change a selected path',()=>{
  assertNativeModelQueryResult('revit_health',{schema_version:1,status:'no_document',document_open:false});
  assert.throws(()=>assertNativeModelQueryResult('revit_health',{schema_version:1,status:'ready',document_open:false}),/inconsistent/);
  const info={schema_version:1,title:'Unsaved',path:'',is_family_document:false,is_read_only:false,is_modified:false,active_view:null};
  assertNativeModelQueryResult('revit_get_document_info',info,{expected_document:''});
  assert.throws(()=>assertNativeModelQueryResult('revit_get_document_info',info,{expected_document:'D:\\other.rvt'}),/changed/);
});
test('advertised output schemas validate the full structured transport envelope and require its evidence',()=>{
  const ajv=new Ajv({strict:true});
  for(const tool of NATIVE_MODEL_QUERY_TOOLS){ajv.compile(tool.inputSchema);ajv.compile(tool.outputSchema);}
  const tool=NATIVE_MODEL_QUERY_TOOLS.find(tool=>tool.name==='revit_health'),validate=ajv.compile(tool.outputSchema);
  const envelope={operation:'health',hostSession:'d'.repeat(32),document:null,modifiedByOperation:false,value:{schema_version:1,status:'no_document',document_open:false},snapshot:{document:null},request_id:'f'.repeat(36),request_ids:['f'.repeat(36)]};
  assert.equal(validate(envelope),true,JSON.stringify(validate.errors));
  assert.equal(validate(envelope.value),false);
  for(const key of ['request_id','snapshot','hostSession','document','modifiedByOperation']){const changed={...envelope};delete changed[key];assert.equal(validate(changed),false,key);}
  assert.equal(validate({...envelope,operation:'status'}),false);
  assert.equal(validate({...envelope,modifiedByOperation:true}),false);
});
