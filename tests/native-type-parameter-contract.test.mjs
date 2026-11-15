import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {
  NATIVE_PARAMETER_QUERY_TOOLS,NATIVE_PARAMETER_QUERY_NAMES,NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL,
  NATIVE_PARAMETER_QUERY_VERSION,NATIVE_PARAMETER_QUERY_MIN_HOST_VERSION,
  isNativeParameterQuery,supportsNativeParameterQueries,
  assertNativeParameterQueryArguments,assertNativeParameterQueryResult,
} from '../lib/native-parameter-queries.mjs';

const name='revit_get_type_parameters',operation='get_type_parameters';
const sourceId='9007199254740993',typeId='9223372036854775807';
const capable=()=>({version:'0.8.2',atomicReadSnapshot:true,nativeParameterQueriesVersion:1,nativeParameterQueryOperations:[operation]});
const parameter=(patch={})=>({parameter_id:'-1001001',name:'Width',storage_type:'Double',is_read_only:false,has_value:true,
  data_type:'autodesk.spec.aec:length-2.0.0',unit_type:'autodesk.unit.unit:millimeters-1.0.1',value_internal:3.280839895,value_display:'1000 mm',...patch});
const body=(patch={})=>({schema_version:1,element_id:sourceId,element_name:'Instance',source_is_type:false,
  type_id:typeId,type_name:'Type',parameters:[parameter()],...patch});

test('the named type-parameter query owns a frozen read contract distinct from instance parameters',()=>{
  assert.deepEqual(NATIVE_PARAMETER_QUERY_NAMES,[name,'revit_get_parameter_value','revit_get_type_parameter_impact']);
  assert.deepEqual(NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL,{[name]:operation,revit_get_parameter_value:'get_parameter_value',revit_get_type_parameter_impact:'get_type_parameter_impact'});
  assert.equal(NATIVE_PARAMETER_QUERY_VERSION,1);assert.equal(NATIVE_PARAMETER_QUERY_MIN_HOST_VERSION,'0.8.2');
  assert.equal(NATIVE_PARAMETER_QUERY_TOOLS.length,3);
  const tool=NATIVE_PARAMETER_QUERY_TOOLS[0];
  assert.equal(tool.name,name);assert.equal(tool.annotations.readOnlyHint,true);
  assert.deepEqual(tool.inputSchema.required,['element_id']);
  assert.equal(tool.inputSchema.additionalProperties,false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(),['element_id','expected_document']);
  assert.equal(tool.outputSchema.properties.operation.enum[0],operation);
  assert.ok(Object.isFrozen(tool));assert.ok(Object.isFrozen(tool.outputSchema.properties.value.properties.parameters.items));
  assert.equal(isNativeParameterQuery(name),true);
  for(const other of ['revit_get_element_parameters','revit_describe_parameters','revit_set_parameters','get_type_parameters','constructor'])assert.equal(isNativeParameterQuery(other),false);
  assert.match(tool.description,/ElementType input returns itself/);
});

test('host evidence requires the independent parameter version, operation and atomic capability',()=>{
  for(const version of ['0.8.2','0.8.2.0','0.9.0','1.0.0'])assert.equal(supportsNativeParameterQueries({...capable(),version},operation),true,version);
  assert.equal(supportsNativeParameterQueries(capable()),false,'a type-only host does not prove the complete expanded family');
  assert.equal(supportsNativeParameterQueries({...capable(),version:'0.8.4',nativeParameterQueryOperations:[operation,'get_parameter_value']}),false,'two older operations do not prove the expanded impact family');
  assert.equal(supportsNativeParameterQueries({...capable(),version:'0.8.6',nativeParameterQueryOperations:[operation,'get_parameter_value','get_type_parameter_impact']}),true);
  for(const patch of [
    {version:'0.8.1'},{version:'0.8.2-preview'},{version:'0.8'},{version:''},
    {atomicReadSnapshot:false},{atomicReadSnapshot:undefined},{nativeParameterQueriesVersion:undefined},
    {nativeParameterQueriesVersion:0},{nativeParameterQueriesVersion:2},{nativeParameterQueriesVersion:'1'},
    {nativeParameterQueryOperations:undefined},{nativeParameterQueryOperations:[]},
    {nativeParameterQueryOperations:['get_element_parameters']},{nativeParameterQueryOperations:[operation,operation]},
  ])assert.equal(supportsNativeParameterQueries({...capable(),...patch},operation),false,JSON.stringify(patch));
  assert.equal(supportsNativeParameterQueries({version:'0.8.2',atomicReadSnapshot:true,nativeModelQueriesVersion:1,nativeModelQueryOperations:[operation]},operation),false);
  assert.equal(supportsNativeParameterQueries(null,operation),false);
});

test('input IDs preserve exact Int64 strings and omitted document binding without accepting writes or names',()=>{
  for(const element_id of [1,Number.MAX_SAFE_INTEGER,sourceId,typeId]){
    const input={element_id};assert.deepEqual(assertNativeParameterQueryArguments(name,input),input);
    assert.deepEqual(assertNativeParameterQueryArguments(name,{...input,expected_document:''}),{...input,expected_document:''});
  }
  for(const element_id of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,null,true,{},'', '01','+1',' 1','1.0','1e4','9223372036854775808'])assert.throws(()=>assertNativeParameterQueryArguments(name,{element_id}),undefined,String(element_id));
  assert.throws(()=>assertNativeParameterQueryArguments(name,{}));
  for(const patch of [{mode:'rollback'},{code:'unregistered'},{type_id:21},{parameter_name:'Width'},{expected_document:null}])assert.throws(()=>assertNativeParameterQueryArguments(name,{element_id:1,...patch}));
  assert.throws(()=>assertNativeParameterQueryArguments('revit_get_element_parameters',{element_id:1}));
});

test('source-to-type identity is explicit for instances and direct ElementType inputs',()=>{
  const instance=body();assert.equal(assertNativeParameterQueryResult(name,instance,{element_id:sourceId}),instance);
  const direct=body({element_id:21,type_id:'21',source_is_type:true,element_name:'Type',type_name:'Type'});
  assert.equal(assertNativeParameterQueryResult(name,direct,{element_id:'21'}),direct);
  for(const changed of [
    body({element_id:'9007199254740994'}),body({source_is_type:true}),
    body({type_id:sourceId}),body({source_is_type:1}),body({type_id:null}),
    body({type_id:'9223372036854775808'}),body({type_id:Number.MAX_SAFE_INTEGER+1}),
  ])assert.throws(()=>assertNativeParameterQueryResult(name,changed,{element_id:sourceId}));
  assert.throws(()=>assertNativeParameterQueryResult(name,{...direct,source_is_type:false},{element_id:'21'}));
});

test('every result field is required and missing type data cannot fall back to the instance shape',()=>{
  for(const key of Object.keys(body())){
    const changed=body();delete changed[key];assert.throws(()=>assertNativeParameterQueryResult(name,changed),undefined,key);
  }
  for(const patch of [{schema_version:2},{instance_parameters:[]},{type_name:42},{element_name:false},{parameters:null},{parameters:{}},{parameters:[{}]}])assert.throws(()=>assertNativeParameterQueryResult(name,body(patch)));
  assert.doesNotThrow(()=>assertNativeParameterQueryResult(name,body({element_name:null,type_name:null,parameters:[]})));
  assert.throws(()=>assertNativeParameterQueryResult('revit_describe_parameters',body()));
});

test('parameter facts retain raw values, exact references and observed units without display conversion',()=>{
  const parameters=[
    parameter(),
    parameter({parameter_id:'2',name:'Unknown numeric spec',data_type:null,unit_type:null,value_internal:1.25,value_display:'localized display'}),
    parameter({parameter_id:'3',name:'Text',storage_type:'String',data_type:null,unit_type:null,value_internal:'',value_display:''}),
    parameter({parameter_id:'4',name:'YesNo',storage_type:'Integer',data_type:'autodesk.spec:spec.bool-1.0.0',unit_type:null,value_internal:1,value_display:'是'}),
    parameter({parameter_id:'5',name:'Reference',storage_type:'ElementId',data_type:null,unit_type:null,value_internal:typeId,value_display:'type reference'}),
    parameter({parameter_id:'6',name:'Absent',storage_type:'None',has_value:false,data_type:null,unit_type:null,value_internal:null,value_display:null}),
    parameter({parameter_id:'-9223372036854775808',name:'Negative reference',storage_type:'ElementId',data_type:null,unit_type:null,value_internal:'-1',value_display:null}),
  ];
  const value=body({parameters}),before=structuredClone(value);
  assertNativeParameterQueryResult(name,value,{element_id:sourceId});assert.deepEqual(value,before);
  assert.equal(value.parameters[0].value_internal,3.280839895);assert.equal(value.parameters[0].value_display,'1000 mm');
  assert.equal(value.parameters[4].value_internal,typeId);
  for(const patch of [
    {has_value:false},{storage_type:'Double',value_internal:'3.28'},
    {storage_type:'Integer',value_internal:1.5},{storage_type:'Integer',value_internal:true},
    {storage_type:'String',value_internal:42},{storage_type:'ElementId',value_internal:Number.MAX_SAFE_INTEGER+1},
    {storage_type:'ElementId',value_internal:'9223372036854775808'},
    {storage_type:'Double',value_internal:NaN},{storage_type:'Double',value_internal:Infinity},
    {parameter_id:'-0'},{parameter_id:'9223372036854775808'},{unit_type:42},{storage_type:'Arbitrary'},
  ])assert.throws(()=>assertNativeParameterQueryResult(name,body({parameters:[parameter(patch)]})),undefined,JSON.stringify(patch));
});

test('duplicate identities and over-budget parameter results fail without silent truncation',()=>{
  assert.throws(()=>assertNativeParameterQueryResult(name,body({parameters:[parameter(),parameter({parameter_id:-1001001})]})));
  const parameters=Array.from({length:2000},(_,index)=>parameter({parameter_id:String(index+1)}));
  assert.doesNotThrow(()=>assertNativeParameterQueryResult(name,body({parameters})));
  assert.throws(()=>assertNativeParameterQueryResult(name,body({parameters:[...parameters,parameter({parameter_id:'2001'})]})));
  assert.throws(()=>assertNativeParameterQueryResult(name,body({parameters:[parameter({value_display:'x'.repeat(64001)})]})));
});

test('Ajv validates the advertised complete envelope and distinguishes it from a business DTO',()=>{
  const ajv=new Ajv({strict:true}),tool=NATIVE_PARAMETER_QUERY_TOOLS[0];
  const input=ajv.compile(tool.inputSchema),output=ajv.compile(tool.outputSchema);
  assert.equal(input({element_id:sourceId}),true,JSON.stringify(input.errors));
  assert.equal(input({element_id:sourceId,mode:'commit'}),false);
  const envelope={operation,hostSession:'b'.repeat(32),document:{title:'Unsaved',path:''},modifiedByOperation:false,
    value:body(),snapshot:{document:{title:'Unsaved',path:''}},request_id:'11111111-1111-4111-8111-111111111111',request_ids:['11111111-1111-4111-8111-111111111111']};
  assert.equal(output(envelope),true,JSON.stringify(output.errors));assert.equal(output(envelope.value),false);
  for(const key of ['operation','hostSession','document','modifiedByOperation','value','snapshot','request_id']){
    const changed={...envelope};delete changed[key];assert.equal(output(changed),false,key);
  }
  for(const patch of [{operation:'get_element_parameters'},{modifiedByOperation:true},{document:null},{value:{...body(),parameters:[{...parameter(),unit_type:42}]}}])assert.equal(output({...envelope,...patch}),false);
});
