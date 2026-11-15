import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {NATIVE_PARAMETER_QUERY_TOOLS,NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL,NATIVE_PARAMETER_QUERY_VERSION,
  supportsNativeParameterQueries,assertNativeParameterQueryArguments,assertNativeParameterQueryResult} from '../lib/native-parameter-queries.mjs';
import {validateTool,validateToolArguments} from '../lib/workbench-client.mjs';
import {MODEL_AI_READ_TOOLS,MODEL_AI_EFFECT_TOOLS} from '../lib/panel-tools.mjs';
import {supportsModelPermissionTool} from '../lib/model-operation-effects.mjs';
import {describeModelOperationSchema} from '../lib/model-operation-contracts.mjs';
import {createModelPermissionOwner} from '../lib/model-permission-owner.mjs';
import {IMPACT_TOOL,IMPACT_OPERATION,IMPACT_TYPE_ID,IMPACT_PARAMETER_ID,impactArguments,impactParameter,impactValue} from '../test-support/native-type-parameter-impact-fixtures.mjs';

const tool=NATIVE_PARAMETER_QUERY_TOOLS.find(item=>item.name===IMPACT_TOOL);
const capable=(version='0.8.6',operations=[IMPACT_OPERATION])=>({version,atomicReadSnapshot:true,nativeParameterQueriesVersion:1,nativeParameterQueryOperations:operations});
const reject=args=>{assert.throws(()=>assertNativeParameterQueryArguments(IMPACT_TOOL,args));assert.throws(()=>validateToolArguments(IMPACT_TOOL,args));};
const mutated=change=>{const value=impactValue();change(value);assert.throws(()=>assertNativeParameterQueryResult(IMPACT_TOOL,value,impactArguments()));};

test('the frozen impact tool owns an explicit type-and-parameter read with no mutation inputs',()=>{
  assert.ok(tool);assert.equal(NATIVE_PARAMETER_QUERY_VERSION,1);assert.equal(NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL[IMPACT_TOOL],IMPACT_OPERATION);
  assert.equal(tool.annotations.readOnlyHint,true);assert.deepEqual(tool.inputSchema.required,['type_id','parameter_id']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(),['expected_document','parameter_id','type_id']);assert.equal(tool.inputSchema.additionalProperties,false);
  assert.equal(tool.outputSchema.properties.operation.enum[0],IMPACT_OPERATION);assert.ok(Object.isFrozen(tool.outputSchema.properties.value.properties.coverage));
  assert.equal(validateTool(IMPACT_TOOL,impactArguments()).operation,IMPACT_OPERATION);
  assert.match(tool.description,/grants no write authority/);assert.match(tool.description,/does not close legacy/);
  for(const patch of [{element_id:1},{parameter_name:'Width'},{name:'Type'},{value:2},{ack:true},{mode:'commit'},{expected_state:{}}])reject({...impactArguments(),...patch});
});

test('impact capability requires host 0.8.6 without raising the minimum for either older operation',()=>{
  assert.equal(supportsNativeParameterQueries(capable('0.8.2',['get_type_parameters']),'get_type_parameters'),true);
  assert.equal(supportsNativeParameterQueries(capable('0.8.4',['get_parameter_value']),'get_parameter_value'),true);
  for(const version of ['0.8.6','0.8.6.0','0.9.0','1.0.0'])assert.equal(supportsNativeParameterQueries(capable(version),IMPACT_OPERATION),true);
  for(const patch of [{version:'0.8.5'},{version:'0.8.6-preview'},{atomicReadSnapshot:false},{nativeParameterQueriesVersion:0},
    {nativeParameterQueriesVersion:2},{nativeParameterQueryOperations:['get_type_parameters','get_parameter_value']},
    {nativeParameterQueryOperations:[IMPACT_OPERATION,IMPACT_OPERATION]}])assert.equal(supportsNativeParameterQueries({...capable(),...patch},IMPACT_OPERATION),false);
  assert.equal(supportsNativeParameterQueries(capable('0.8.6',['get_type_parameters','get_parameter_value',IMPACT_OPERATION])),true);
});

test('input exact IDs preserve safe numbers and Int64 strings with optional atomic document binding',()=>{
  for(const type_id of [1,Number.MAX_SAFE_INTEGER,'9007199254740993','9223372036854775807'])for(const parameter_id of [-2,1,'9223372036854775807','-9223372036854775808']){
    const args={type_id,parameter_id};assert.deepEqual(assertNativeParameterQueryArguments(IMPACT_TOOL,args),args);assert.deepEqual(validateToolArguments(IMPACT_TOOL,args),args);
  }
  assert.deepEqual(assertNativeParameterQueryArguments(IMPACT_TOOL,{...impactArguments(),expected_document:''}),{expected_document:'',...impactArguments()});
  for(const type_id of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'01','9223372036854775808',null,true])reject(impactArguments({type_id}));
  for(const parameter_id of [0,-1,'0','-1','-0','01','-01','+1',' 1','9223372036854775808','-9223372036854775809',Number.MAX_SAFE_INTEGER+1,1.5,NaN,Infinity,null,true])reject(impactArguments({parameter_id}));
  reject({type_id:IMPACT_TYPE_ID});reject({parameter_id:IMPACT_PARAMETER_ID});reject(impactArguments({expected_document:null}));
});

test('result source and parameter identities match the requested type and selected parameter exactly',()=>{
  const value=impactValue();assert.equal(assertNativeParameterQueryResult(IMPACT_TOOL,value,impactArguments()),value);
  assert.doesNotThrow(()=>assertNativeParameterQueryResult(IMPACT_TOOL,impactValue({type_id:'42'}),{type_id:42,parameter_id:-123}));
  mutated(value=>{value.type_id='9223372036854775805';});mutated(value=>{value.parameter.parameter_id='-124';});
  for(const parameter_id of ['0','-1','-0','9223372036854775808'])mutated(value=>{value.parameter.parameter_id=parameter_id;});
  for(const key of Object.keys(impactValue()))mutated(value=>{delete value[key];});
  mutated(value=>{value.element_id='instance-fallback';});mutated(value=>{value.type_name=42;});
});

test('direct instance references are unique, numerically sorted exact IDs with bounded complete coverage',()=>{
  assert.doesNotThrow(()=>assertNativeParameterQueryResult(IMPACT_TOOL,impactValue({instance_ids:['2','10','9007199254740992','9007199254740993'],instance_count:4}),impactArguments()));
  assert.doesNotThrow(()=>assertNativeParameterQueryResult(IMPACT_TOOL,impactValue({instance_ids:[],instance_count:0,coverage:{...impactValue().coverage,scanned_elements:0}}),impactArguments()));
  const maximum=Array.from({length:500},(_,index)=>String(index+1));
  assert.doesNotThrow(()=>assertNativeParameterQueryResult(IMPACT_TOOL,impactValue({instance_ids:maximum,instance_count:500,coverage:{...impactValue().coverage,scanned_elements:20000}}),impactArguments()));
  for(const instance_ids of [['10','2'],['2','2'],[2],[2,'2'],['0'],['01'],[-1],[9007199254740992],['9223372036854775808'],[IMPACT_TYPE_ID],Array.from({length:501},(_,index)=>String(index+1))]){
    assert.throws(()=>assertNativeParameterQueryResult(IMPACT_TOOL,impactValue({instance_ids,instance_count:instance_ids.length,coverage:{...impactValue().coverage,scanned_elements:20000}}),impactArguments()));
  }
  for(const instance_count of [2,4,'3',NaN,-1])mutated(value=>{value.instance_count=instance_count;});
  for(const scanned_elements of [-1,2,20001,1.5,'4',NaN,Infinity])mutated(value=>{value.coverage.scanned_elements=scanned_elements;});
});

test('a partial scan, indirect-effects claim or write grant can never become a verified preview',()=>{
  for(const patch of [{complete:false},{scope:'all_documents'},{indirect_effects:'assessed'},{extra:true}])mutated(value=>{Object.assign(value.coverage,patch);});
  for(const key of Object.keys(impactValue().coverage))mutated(value=>{delete value.coverage[key];});
  for(const write_authorization of ['granted','confirmed','pending',true,null])mutated(value=>{value.write_authorization=write_authorization;});
  mutated(value=>{value.approval_token='invented';});
});

test('the preview reuses unchanged parameter raw/internal/display and read-only facts',()=>{
  for(const patch of [{},{storage_type:'Integer',value_internal:1,unit_type:null,is_read_only:true},
    {storage_type:'String',value_internal:'',value_display:'',unit_type:null,data_type:null},
    {storage_type:'ElementId',value_internal:'9223372036854775807',unit_type:null},
    {storage_type:'None',has_value:false,value_internal:null,value_display:null,unit_type:null,data_type:null}]){
    const value=impactValue({type_name:null,parameter:impactParameter(patch)}),before=structuredClone(value);
    assertNativeParameterQueryResult(IMPACT_TOOL,value,impactArguments());assert.deepEqual(value,before);
  }
  for(const patch of [{has_value:false},{storage_type:'Double',value_internal:'609.6 mm'},{storage_type:'Integer',value_internal:1.5},
    {storage_type:'ElementId',value_internal:9007199254740992},{unit_type:42}])mutated(value=>{Object.assign(value.parameter,patch);});
});

test('Ajv validates the bounded business result inside the complete atomic transport schema',()=>{
  const ajv=new Ajv({strict:true}),input=ajv.compile(tool.inputSchema),output=ajv.compile(tool.outputSchema);
  assert.equal(input(impactArguments()),true,JSON.stringify(input.errors));assert.equal(input({...impactArguments(),ack:true}),false);
  const envelope={operation:IMPACT_OPERATION,hostSession:'d'.repeat(32),document:{title:'Type preview',path:''},modifiedByOperation:false,value:impactValue(),snapshot:{},request_id:'11111111-1111-4111-8111-111111111111'};
  assert.equal(output(envelope),true,JSON.stringify(output.errors));assert.equal(output(envelope.value),false);
  for(const key of ['operation','hostSession','document','modifiedByOperation','value','snapshot','request_id']){const changed={...envelope};delete changed[key];assert.equal(output(changed),false,key);}
  assert.equal(output({...envelope,value:{...impactValue(),write_authorization:'granted'}}),false);
  assert.equal(output({...envelope,value:{...impactValue(),instance_ids:[2],instance_count:1}}),false);
  assert.equal(output({...envelope,value:{...impactValue(),coverage:{...impactValue().coverage,complete:false}}}),false);
});

test('preview metadata enters read MCP only and cannot authorize the independently registered type write',()=>{
  assert.equal(MODEL_AI_READ_TOOLS.some(item=>item.name===IMPACT_TOOL),true);assert.equal(MODEL_AI_EFFECT_TOOLS.some(item=>item.name===IMPACT_TOOL),false);
  assert.equal(supportsModelPermissionTool(IMPACT_TOOL),false);assert.equal(describeModelOperationSchema({tool:IMPACT_TOOL}).ok,false);
  assert.equal(NATIVE_PARAMETER_QUERY_TOOLS.some(item=>item.name==='revit_set_type_parameter'),false);
  assert.equal(supportsModelPermissionTool('revit_set_type_parameter'),true);
  const scope={client:'controlled',conversationId:'controlled',generation:1,revision:1,account:'controlled',document:{session:'controlled',path:'D:\\controlled.rvt',title:'Controlled'}};
  let calls=0;const owner=createModelPermissionOwner({invoke:async()=>{calls++;throw new Error('preview must not invoke a write');},verifyDocument:async()=>true});
  owner.setLevel({level:'automatic',scope,isCurrent:()=>true});
  assert.throws(()=>owner.propose({scope,callId:IMPACT_TOOL,tool:IMPACT_TOOL,parameters:impactArguments(),isCurrent:()=>true}),{code:'MODEL_OPERATION_UNSUPPORTED'});
  const p=impactParameter(),parameters={expected_document:scope.document.path,type_id:IMPACT_TYPE_ID,parameter_id:IMPACT_PARAMETER_ID,value:p.value_internal,value_unit:'internal',
    expected_state:{storage_type:p.storage_type,has_value:p.has_value,value_internal:p.value_internal,data_type:p.data_type},expected_instance_ids:impactValue().instance_ids};
  assert.throws(()=>owner.propose({scope,callId:'unprepared-type-write',tool:'revit_set_type_parameter',parameters,isCurrent:()=>true}),{code:'MODEL_TYPE_PARAMETER_REVIEW_UNAVAILABLE'});
  assert.equal(calls,0);
});
