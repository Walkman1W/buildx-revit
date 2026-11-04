import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {
  NATIVE_PARAMETER_QUERY_TOOLS,NATIVE_PARAMETER_QUERY_NAMES,NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL,
  NATIVE_PARAMETER_QUERY_VERSION,NATIVE_PARAMETER_QUERY_MIN_HOST_VERSION_BY_OPERATION,
  isNativeParameterQuery,supportsNativeParameterQueries,assertNativeParameterQueryArguments,assertNativeParameterQueryResult,
} from './lib/native-parameter-queries.mjs';
import {validateToolArguments,validateTool} from './lib/workbench-client.mjs';
import {modelCommandByTool} from './lib/model-command-catalog.mjs';
import {modelSchemaParameters} from './public/model-workspace.mjs';

const name='revit_get_parameter_value',operation='get_parameter_value',sourceId='9007199254740993';
const tool=NATIVE_PARAMETER_QUERY_TOOLS.find(item=>item.name===name);
const capable=(version='0.8.4',operations=[operation])=>({version,atomicReadSnapshot:true,nativeParameterQueriesVersion:1,nativeParameterQueryOperations:operations});
const parameter=(patch={})=>({parameter_id:'-123',name:' Width ',storage_type:'Double',is_read_only:false,has_value:true,
  data_type:'autodesk.spec.aec:length-2.0.0',unit_type:'autodesk.unit.unit:millimeters-1.0.1',value_internal:2,value_display:'609.6 mm',...patch});
const body=(patch={})=>({schema_version:1,element_id:sourceId,element_name:'Selected element',parameter:parameter(),...patch});
const assertInput=args=>{
  const owned=assertNativeParameterQueryArguments(name,args),generic=validateToolArguments(name,args);
  assert.deepEqual(generic,owned);return owned;
};
const rejectInput=args=>{assert.throws(()=>assertNativeParameterQueryArguments(name,args));assert.throws(()=>validateToolArguments(name,args));};

test('the frozen single-parameter contract has one explicit selector and a single shared fact DTO',()=>{
  assert.ok(tool);assert.ok(NATIVE_PARAMETER_QUERY_NAMES.includes(name));assert.equal(isNativeParameterQuery(name),true);
  assert.equal(NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL[name],operation);assert.equal(NATIVE_PARAMETER_QUERY_VERSION,1);
  assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.inputSchema.additionalProperties,false);
  assert.deepEqual(tool.inputSchema.required,['element_id']);assert.deepEqual(tool.inputSchema.oneOf.map(branch=>branch.required),[['parameter_id'],['parameter_name']]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(),['element_id','expected_document','parameter_id','parameter_name']);
  assert.deepEqual(tool.outputSchema.properties.value.required,['schema_version','element_id','element_name','parameter']);
  assert.equal(tool.outputSchema.properties.operation.enum[0],operation);assert.ok(Object.isFrozen(tool.outputSchema.properties.value.properties.parameter));
  assert.match(tool.description,/does not silently fall back/);
  const normalized=validateTool(name,{element_id:sourceId,parameter_id:-123});assert.equal(normalized.operation,operation);assert.equal(Object.hasOwn(normalized.args,'mode'),false);
});

test('capability gates are operation-specific and keep the old type query available on host 0.8.2',()=>{
  assert.deepEqual(NATIVE_PARAMETER_QUERY_MIN_HOST_VERSION_BY_OPERATION,{get_type_parameters:'0.8.2',get_parameter_value:'0.8.4'});
  const old=capable('0.8.2',['get_type_parameters']);
  assert.equal(supportsNativeParameterQueries(old,'get_type_parameters'),true);assert.equal(supportsNativeParameterQueries(old,operation),false);
  assert.equal(supportsNativeParameterQueries(capable('0.8.3'),operation),false);
  for(const version of ['0.8.4','0.8.4.0','0.9.0','1.0.0'])assert.equal(supportsNativeParameterQueries(capable(version),operation),true,version);
  for(const patch of [{version:'0.8.4-preview'},{atomicReadSnapshot:false},{nativeParameterQueriesVersion:0},{nativeParameterQueriesVersion:2},
    {nativeParameterQueryOperations:['get_type_parameters']},{nativeParameterQueryOperations:[operation,operation]}])assert.equal(supportsNativeParameterQueries({...capable(),...patch},operation),false);
  assert.equal(supportsNativeParameterQueries(capable('0.8.4',['get_type_parameters',operation])),true);
  assert.equal(supportsNativeParameterQueries(capable('0.8.2',['get_type_parameters',operation])),false);
  assert.equal(supportsNativeParameterQueries(capable(),'set_parameters'),false);
});

test('both validators require exactly one selector and reject coercion, write fields and unknown properties',()=>{
  assert.deepEqual(assertInput({element_id:sourceId,parameter_id:-123}),{element_id:sourceId,parameter_id:-123});
  assert.deepEqual(assertInput({element_id:sourceId,parameter_name:' Width ',expected_document:''}),{element_id:sourceId,expected_document:'',parameter_name:' Width '});
  for(const args of [{element_id:sourceId},{element_id:sourceId,parameter_id:-123,parameter_name:' Width '},
    {element_id:sourceId,parameter_id:undefined,parameter_name:' Width '},{parameter_id:-123},
    {element_id:sourceId,parameter_name:' Width ',mode:'rollback'},{element_id:sourceId,parameter_id:-123,type_id:21},
    {element_id:sourceId,parameter_id:-123,code:'unregistered'},{element_id:sourceId,parameter_name:' Width ',expected_document:null}])rejectInput(args);
});

test('source and signed parameter IDs retain exact Int64 values and reject reserved, rounded or noncanonical IDs',()=>{
  for(const element_id of [1,Number.MAX_SAFE_INTEGER,sourceId,'9223372036854775807'])assert.equal(assertInput({element_id,parameter_id:-123}).element_id,element_id);
  for(const parameter_id of [-2,-123,1,Number.MAX_SAFE_INTEGER,-Number.MAX_SAFE_INTEGER,'9007199254740993','9223372036854775807','-9223372036854775808'])assert.equal(assertInput({element_id:sourceId,parameter_id}).parameter_id,parameter_id);
  for(const parameter_id of [0,-1,'0','-1','-0',1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,-Number.MAX_SAFE_INTEGER-1,
    null,true,{},[], '01','-01','+1',' 1','1 ','1.0','1e4','9223372036854775808','-9223372036854775809'])rejectInput({element_id:sourceId,parameter_id});
  for(const element_id of [0,-1,'01','9223372036854775808',Number.MAX_SAFE_INTEGER+1])rejectInput({element_id,parameter_id:-123});
});

test('name selectors retain spaces, case and Unicode without trimming or normalization',()=>{
  for(const parameter_name of [' Width ','width',' ','é','e\u0301','字'.repeat(1024)])assert.equal(assertInput({element_id:sourceId,parameter_name}).parameter_name,parameter_name);
  for(const parameter_name of ['',null,1,true,{},[],'字'.repeat(1025)])rejectInput({element_id:sourceId,parameter_name});
  for(const parameter_name of ['Width',' width ',' WIDTH ','Wídth'])assert.throws(()=>assertNativeParameterQueryResult(name,body(),{element_id:sourceId,parameter_name}));
  assert.doesNotThrow(()=>assertNativeParameterQueryResult(name,body(),{element_id:sourceId,parameter_name:' Width '}));
  assert.throws(()=>assertNativeParameterQueryResult(name,body({parameter:parameter({name:'é'})}),{element_id:sourceId,parameter_name:'e\u0301'}));
});

test('returned source and parameter identities bind to the exact chosen selector',()=>{
  const value=body();assert.equal(assertNativeParameterQueryResult(name,value,{element_id:sourceId,parameter_id:-123}),value);
  assertNativeParameterQueryResult(name,body({element_id:'42'}),{element_id:42,parameter_id:'-123'});
  const huge=body({parameter:parameter({parameter_id:'9007199254740993'})});
  assertNativeParameterQueryResult(name,huge,{element_id:sourceId,parameter_id:'9007199254740993'});
  assert.throws(()=>assertNativeParameterQueryResult(name,huge,{element_id:sourceId,parameter_id:'9007199254740992'}));
  assert.throws(()=>assertNativeParameterQueryResult(name,body({element_id:'9007199254740994'}),{element_id:sourceId,parameter_id:-123}));
  for(const parameter_id of [0,-1,'0','-1','-0','9223372036854775808',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>assertNativeParameterQueryResult(name,body({parameter:parameter({parameter_id})}),{element_id:sourceId,parameter_name:' Width '}));
});

test('one shared parameter preserves read-only, absent, empty, internal/display and exact reference facts',()=>{
  for(const patch of [
    {},{storage_type:'Double',data_type:null,unit_type:null,value_internal:1.25,value_display:'unknown numeric display'},
    {storage_type:'String',value_internal:'',value_display:'',data_type:null,unit_type:null},
    {storage_type:'Integer',is_read_only:true,value_internal:1,value_display:'是',data_type:'autodesk.spec:spec.bool-1.0.0',unit_type:null},
    {storage_type:'ElementId',value_internal:'9223372036854775807',value_display:'reference',data_type:null,unit_type:null},
    {storage_type:'None',has_value:false,value_internal:null,value_display:null,data_type:null,unit_type:null},
  ]){
    const value=body({element_name:null,parameter:parameter(patch)}),before=structuredClone(value);
    assertNativeParameterQueryResult(name,value,{element_id:sourceId,parameter_id:-123});assert.deepEqual(value,before);
  }
  for(const patch of [{has_value:false},{storage_type:'Integer',value_internal:1.5},{storage_type:'Integer',value_internal:true},
    {storage_type:'Double',value_internal:'609.6 mm'},{storage_type:'Double',value_internal:Infinity},
    {storage_type:'ElementId',value_internal:Number.MAX_SAFE_INTEGER+1},{unit_type:42},{storage_type:'String',value_internal:1},
    {value_display:'x'.repeat(64001)}])assert.throws(()=>assertNativeParameterQueryResult(name,body({parameter:parameter(patch)})));
});

test('single results cannot omit fields, publish a list or disguise type fallback with a different DTO',()=>{
  for(const key of Object.keys(body())){const value=body();delete value[key];assert.throws(()=>assertNativeParameterQueryResult(name,value),undefined,key);}
  for(const patch of [{schema_version:2},{element_name:42},{parameter:null},{parameter:[parameter()]},{parameters:[parameter()]},{type_id:21},{source_is_type:true}])assert.throws(()=>assertNativeParameterQueryResult(name,body(patch)));
  for(const key of Object.keys(parameter())){const selected=parameter();delete selected[key];assert.throws(()=>assertNativeParameterQueryResult(name,body({parameter:selected})),undefined,key);}
});

test('Ajv input oneOf enforces the selector XOR and output validates the complete transport envelope',()=>{
  const ajv=new Ajv({strict:true}),input=ajv.compile(tool.inputSchema),output=ajv.compile(tool.outputSchema);
  for(const args of [{element_id:sourceId,parameter_id:-123},{element_id:sourceId,parameter_name:' Width '}])assert.equal(input(args),true,JSON.stringify(input.errors));
  for(const args of [{element_id:sourceId},{element_id:sourceId,parameter_id:-123,parameter_name:' Width '},{element_id:sourceId,parameter_id:0},
    {element_id:sourceId,parameter_id:'-1'},{element_id:sourceId,parameter_name:''}])assert.equal(input(args),false,JSON.stringify(args));
  const envelope={operation,hostSession:'b'.repeat(32),document:{title:'Unsaved',path:''},modifiedByOperation:false,value:body(),
    snapshot:{document:{title:'Unsaved',path:''}},request_id:'11111111-1111-4111-8111-111111111111'};
  assert.equal(output(envelope),true,JSON.stringify(output.errors));assert.equal(output(envelope.value),false);
  for(const key of ['operation','hostSession','document','modifiedByOperation','value','snapshot','request_id']){const value={...envelope};delete value[key];assert.equal(output(value),false,key);}
  for(const patch of [{operation:'get_type_parameters'},{modifiedByOperation:true},{document:null},{value:body({parameter:null})}])assert.equal(output({...envelope,...patch}),false);
});

test('the command projection accepts ordinary exact-ID text, preserves names and rejects contradictory selectors',()=>{
  const command=modelCommandByTool(name);assert.ok(command);assert.deepEqual(command.inputSchema.oneOf,tool.inputSchema.oneOf);
  const named=modelSchemaParameters(command,{element_id:sourceId,parameter_name:' Width '});
  assert.deepEqual(named,{ok:true,parameters:{element_id:sourceId,parameter_name:' Width '}});assertInput(named.parameters);
  const exact=modelSchemaParameters(command,{element_id:sourceId,parameter_id:'-9223372036854775808'});
  assert.deepEqual(exact,{ok:true,parameters:{element_id:sourceId,parameter_id:'-9223372036854775808'}});assertInput(exact.parameters);
  const safe=modelSchemaParameters(command,{element_id:'42',parameter_id:'-123'});
  assert.deepEqual(safe,{ok:true,parameters:{element_id:42,parameter_id:-123}});assertInput(safe.parameters);
  const both=modelSchemaParameters(command,{element_id:sourceId,parameter_id:'-123',parameter_name:' Width '});assert.equal(both.ok,false);
  const neither=modelSchemaParameters(command,{element_id:sourceId});assert.equal(neither.ok,false);
  for(const value of [JSON.stringify(sourceId),9007199254740992])assert.equal(modelSchemaParameters(command,{element_id:value,parameter_id:'-123'}).ok,false);
  assert.equal(modelSchemaParameters(command,{element_id:sourceId,parameter_id:JSON.stringify('-9223372036854775808')}).ok,false);
});
