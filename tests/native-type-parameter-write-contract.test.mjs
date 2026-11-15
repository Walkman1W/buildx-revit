import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {NATIVE_TYPE_PARAMETER_WRITE_TOOLS,NATIVE_TYPE_PARAMETER_WRITE_NAMES,isNativeTypeParameterWrite,nativeTypeParameterWriteOperationForTool,
  assertNativeTypeParameterWriteArguments,assertNativeTypeParameterWriteResult,supportsNativeTypeParameterWrites,buildTypeParameterWriteReview,assertTypeParameterWriteReview,typeParameterWriteBindingKey} from '../lib/native-type-parameter-writes.mjs';
import {hostSupportsNativeParameterWrite,hostSupportsParameterWriteTargetPolicy} from '../lib/native-parameter-writes.mjs';
import {WORKBENCH_TOOLS,validateToolArguments,validateTool} from '../lib/workbench-client.mjs';
import {MODEL_AI_READ_TOOLS,MODEL_AI_EFFECT_TOOLS,LEGACY_PANEL_WORKBENCH_TOOLS} from '../lib/panel-tools.mjs';
import {modelCommandByTool} from '../lib/model-command-catalog.mjs';
import {modelOperationEffect} from '../lib/model-operation-effects.mjs';
import {TYPE_WRITE_TOOL,TYPE_WRITE_DOCUMENT,typeWriteArgs,typeWriteImpact,typeWriteHost} from '../test-support/native-type-parameter-write-approval-fixtures.mjs';

const tool=NATIVE_TYPE_PARAMETER_WRITE_TOOLS.find(item=>item.name===TYPE_WRITE_TOOL);
export function typeWriteValue(args=typeWriteArgs()){
  const before=structuredClone(args.expected_state);return {schema_version:1,target_kind:'type',before,instance_ids:[...args.expected_instance_ids],instance_count:args.expected_instance_ids.length,
    scope:'current_document_direct_type_references',indirect_effects:'not_assessed',result:{updated_count:1,changes:[{element_id:String(args.type_id),parameter_id:String(args.parameter_id),
      storage_type:before.storage_type,data_type:before.data_type,changed:before.value_internal!==args.value,before_internal:before.value_internal,after_internal:args.value}]}};
}
const reject=args=>{assert.throws(()=>assertNativeTypeParameterWriteArguments(TYPE_WRITE_TOOL,args));assert.throws(()=>validateToolArguments(TYPE_WRITE_TOOL,args));};

test('type writing owns one guarded operation with a reviewed manual intent and no raw MCP exposure',()=>{
  assert.deepEqual(NATIVE_TYPE_PARAMETER_WRITE_NAMES,[TYPE_WRITE_TOOL]);assert.equal(isNativeTypeParameterWrite(TYPE_WRITE_TOOL),true);assert.equal(nativeTypeParameterWriteOperationForTool(TYPE_WRITE_TOOL),'set_type_parameter');
  for(const name of ['set_type_parameter','revit_set_parameters','revit_set_parameter_value','constructor'])assert.equal(isNativeTypeParameterWrite(name),false);
  assert.equal(WORKBENCH_TOOLS.filter(item=>item.name===TYPE_WRITE_TOOL).length,1);assert.ok(Object.isFrozen(tool.inputSchema));assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.idempotentHint,false);
  assert.equal(modelOperationEffect(TYPE_WRITE_TOOL).kind,'model_transaction');assert.ok(MODEL_AI_EFFECT_TOOLS.some(item=>item.name===TYPE_WRITE_TOOL));
  assert.ok(!MODEL_AI_READ_TOOLS.some(item=>item.name===TYPE_WRITE_TOOL));assert.ok(!LEGACY_PANEL_WORKBENCH_TOOLS.some(item=>item.name===TYPE_WRITE_TOOL));
  assert.equal(modelCommandByTool(TYPE_WRITE_TOOL).enabled,true);assert.equal(modelCommandByTool(TYPE_WRITE_TOOL).manualExecution,true);
  assert.equal(modelCommandByTool(TYPE_WRITE_TOOL).requiresTypeParameterReview,true);
});

test('host 0.8.8 and its independent exact operation are mandatory without raising old operation minima',()=>{
  for(const version of ['0.8.8','0.8.8.0','0.9.0','1.0.0'])assert.equal(supportsNativeTypeParameterWrites(typeWriteHost({version})),true);
  for(const patch of [{version:'0.8.7'},{version:'0.8.8-preview'},{version:['0.8.8']},{version:8},{version:'9007199254740992.0.0'},
    {version:'0.8.8.9007199254740992'},{nativeTypeParameterWritesVersion:undefined},{nativeTypeParameterWritesVersion:0},{nativeTypeParameterWritesVersion:'1'},
    {nativeTypeParameterWriteOperations:undefined},{nativeTypeParameterWriteOperations:['set_parameter_value']},{nativeTypeParameterWriteOperations:['set_type_parameter','set_type_parameter']}])
    assert.equal(supportsNativeTypeParameterWrites(typeWriteHost(patch)),false,JSON.stringify(patch));
  assert.equal(hostSupportsNativeParameterWrite({version:'0.8.5',nativeParameterWritesVersion:1,nativeParameterWriteOperations:['set_parameter_value']}),true);
  assert.equal(hostSupportsParameterWriteTargetPolicy({version:'0.8.7',parameterWriteTargetPolicyVersion:1,parameterWriteTargetPolicy:'instance_only'}),true);
});

test('normalization defaults only the mode and detaches all state and instance guard data',()=>{
  const args=typeWriteArgs();delete args.mode;const original=structuredClone(args),normalized=assertNativeTypeParameterWriteArguments(TYPE_WRITE_TOOL,args);
  assert.equal(normalized.mode,'rollback');assert.equal(normalized.type_id,args.type_id);assert.equal(normalized.parameter_id,args.parameter_id);
  normalized.expected_state.value_internal=9;normalized.expected_instance_ids.length=0;assert.deepEqual(args,original);
  assert.equal(validateTool(TYPE_WRITE_TOOL,args).operation,'set_type_parameter');
  const unbound={...args};delete unbound.expected_document;assert.throws(()=>assertNativeTypeParameterWriteArguments(TYPE_WRITE_TOOL,unbound));
  assert.equal(Object.hasOwn(assertNativeTypeParameterWriteArguments(TYPE_WRITE_TOOL,unbound,{allowDocumentBinding:true}),'expected_document'),false);
});

test('positive type IDs and signed parameter IDs retain exact safe numbers or canonical Int64 strings',()=>{
  for(const type_id of [1,Number.MAX_SAFE_INTEGER,'9007199254740993','9223372036854775807'])for(const parameter_id of [-2,1,-Number.MAX_SAFE_INTEGER,'-9223372036854775808','9223372036854775807'])
    assert.doesNotThrow(()=>assertNativeTypeParameterWriteArguments(TYPE_WRITE_TOOL,typeWriteArgs({type_id,parameter_id,expected_instance_ids:[]})));
  for(const type_id of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'0','01','+1',' 1','9223372036854775808',null,true])reject(typeWriteArgs({type_id}));
  for(const parameter_id of [0,-1,'0','-1','-0','01','-01','-9223372036854775809',Number.MAX_SAFE_INTEGER+1,NaN,Infinity,true])reject(typeWriteArgs({parameter_id}));
  for(const extra of [{element_id:100},{parameter_name:'Width'},{type_name:'Guess'},{ack:true},{approved_type_write:{token:'x'}},{type_write_proposal:{}}])reject({...typeWriteArgs(),...extra});
});

test('the complete instance guard is a unique numeric-order canonical string set bounded by 500',()=>{
  for(const expected_instance_ids of [[],['2','10','9007199254740993'],Array.from({length:500},(_,i)=>String(i+1))])assert.doesNotThrow(()=>assertNativeTypeParameterWriteArguments(TYPE_WRITE_TOOL,typeWriteArgs({expected_instance_ids})));
  for(const expected_instance_ids of [[2],['10','2'],['2','2'],['0'],['-1'],['01'],['9007199254740993',9007199254740994],['9223372036854775808'],['9223372036854775806'],Array.from({length:501},(_,i)=>String(i+1))])reject(typeWriteArgs({expected_instance_ids}));
});

test('typed raw guards preserve null and empty strings while values obey storage and internal-unit limits',()=>{
  for(const expected_state of [{storage_type:'Double',has_value:false,value_internal:null,data_type:null},{storage_type:'String',has_value:true,value_internal:null,data_type:'text'}]){
    const args=typeWriteArgs({expected_state,value:expected_state.storage_type==='String'?'':3});assert.doesNotThrow(()=>assertNativeTypeParameterWriteArguments(TYPE_WRITE_TOOL,args));
  }
  for(const [storage_type,value_internal,value] of [['Integer',1,2],['String','原值','新值']]){const args=typeWriteArgs({expected_state:{storage_type,has_value:true,value_internal,data_type:null},value});delete args.value_unit;assert.doesNotThrow(()=>assertNativeTypeParameterWriteArguments(TYPE_WRITE_TOOL,args));}
  for(const expected_state of [{...typeWriteArgs().expected_state,has_value:false},{...typeWriteArgs().expected_state,value_internal:'2'},
    {...typeWriteArgs().expected_state,data_type:'x'.repeat(1025)},{...typeWriteArgs().expected_state,storage_type:'ElementId'},
    {storage_type:'Integer',has_value:true,value_internal:1.5,data_type:null},{storage_type:'String',has_value:true,value_internal:'x'.repeat(8193),data_type:null}])reject(typeWriteArgs({expected_state}));
  for(const patch of [{value_unit:'mm'},{value:NaN},{value:Infinity},{value:true},{value:null},{value:'3'},{value_unit:undefined}])reject(typeWriteArgs(patch));
  for(const value of [-2147483649,2147483648,1.5])reject(typeWriteArgs({value,expected_state:{storage_type:'Integer',has_value:true,value_internal:1,data_type:null}}));
  reject(typeWriteArgs({value:'x'.repeat(8193),expected_state:{storage_type:'String',has_value:true,value_internal:'old',data_type:null}}));
  for(const key of Object.keys(typeWriteArgs().expected_state)){const expected_state=typeWriteArgs().expected_state;delete expected_state[key];reject(typeWriteArgs({expected_state}));}
});

test('Ajv validates the public shape while the semantic owner rejects cross-field state and set contradictions',()=>{
  const validate=new Ajv({strict:true,allErrors:true}).compile(tool.inputSchema);assert.equal(validate(typeWriteArgs()),true);
  for(const args of [typeWriteArgs({ack:true}),typeWriteArgs({approved_type_write:{schema_version:1,token:'a'.repeat(32)}}),typeWriteArgs({expected_instance_ids:[2]}),
    typeWriteArgs({value:'x'.repeat(8193)}),typeWriteArgs({type_id:'01'})])assert.equal(validate(args),false);
  for(const args of [typeWriteArgs({expected_instance_ids:['10','2']}),typeWriteArgs({value:'2'})])assert.throws(()=>assertNativeTypeParameterWriteArguments(TYPE_WRITE_TOOL,args));
});

test('the result binds all eight fields to the original type, parameter, raw facts and complete direct set',()=>{
  const args=typeWriteArgs(),value=typeWriteValue(args);assert.equal(assertNativeTypeParameterWriteResult(value,args),value);
  assert.deepEqual(Object.keys(value),['schema_version','target_kind','before','instance_ids','instance_count','scope','indirect_effects','result']);
  const alterations=[v=>{v.schema_version=2;},v=>{v.target_kind='instance';},v=>{v.before.value_internal=99;},v=>{v.before.has_value=false;},v=>{v.before.data_type='different';},
    v=>{v.instance_ids=['2','10'];},v=>{v.instance_count=2;},v=>{v.instance_ids=[2,'10','9007199254740993'];},v=>{v.scope='all_effects';},v=>{v.indirect_effects='assessed';},
    v=>{v.result.updated_count=0;},v=>{v.result.changes[0].element_id='1000';},v=>{v.result.changes[0].parameter_id='-124';},v=>{v.result.changes[0].element_id=1000;},
    v=>{v.result.changes[0].after_internal=4;},v=>{v.result.changes[0].changed=false;},v=>{v.result.changes[0].data_type='changed';}];
  for(const alter of alterations){const bad=structuredClone(value);alter(bad);assert.throws(()=>assertNativeTypeParameterWriteResult(bad,args));}
  for(const key of Object.keys(value)){const bad=structuredClone(value);delete bad[key];assert.throws(()=>assertNativeTypeParameterWriteResult(bad,args));}
});

test('review facts come from the actual read owner and cannot be fabricated from guards or grant write authority',()=>{
  const args=typeWriteArgs(),impact=typeWriteImpact(),review=buildTypeParameterWriteReview(args,impact,TYPE_WRITE_DOCUMENT);
  assert.ok(Object.isFrozen(review));assert.deepEqual(review.instance_ids,args.expected_instance_ids);assert.equal(review.parameter.value_internal,2);assert.equal(review.value,3);
  assert.equal(review.scope,'current_document_direct_type_references');assert.equal(review.indirect_effects,'not_assessed');assert.equal(Object.hasOwn(review,'write_authorization'),false);
  for(const observed of [typeWriteImpact({instance_ids:['2','10'],instance_count:2}),typeWriteImpact({parameter:{...impact.parameter,value_internal:9}}),typeWriteImpact({parameter:{...impact.parameter,is_read_only:true}}),typeWriteImpact({write_authorization:'granted'})])
    assert.throws(()=>buildTypeParameterWriteReview(args,observed,TYPE_WRITE_DOCUMENT));
  for(const patch of [{write_authorization:'granted'},{schema_version:2},{mode:'automatic'},{instance_count:2},{parameter:{...review.parameter,value_display:'x'.repeat(8193)}}])assert.throws(()=>assertTypeParameterWriteReview({...review,...patch}));
  assert.throws(()=>buildTypeParameterWriteReview(args,impact,{...TYPE_WRITE_DOCUMENT,path:'D:\\controlled\\other.rvt'}));
});

test('review budgets fail closed in characters and UTF8 instead of truncating complete values',()=>{
  const sourceDocument={...TYPE_WRITE_DOCUMENT,path:'D:\\'+'r'.repeat(32750)+'.rvt'},before='a'.repeat(8192),value='b'.repeat(8192),data_type='d'.repeat(1024);
  const args=typeWriteArgs({expected_document:sourceDocument.path,value,expected_state:{storage_type:'String',has_value:true,value_internal:before,data_type}});delete args.value_unit;
  const impact=typeWriteImpact({type_name:'t'.repeat(1024),parameter:{...typeWriteImpact().parameter,name:'p'.repeat(1024),storage_type:'String',data_type,unit_type:null,value_internal:before,value_display:before}});
  assert.throws(()=>buildTypeParameterWriteReview(args,impact,sourceDocument),/review exceeds/);
  const unicodeDocument={...TYPE_WRITE_DOCUMENT,path:'D:\\'+'路'.repeat(24000)+'.rvt'},unicodeArgs=typeWriteArgs({expected_document:unicodeDocument.path});
  const unicodeImpact=typeWriteImpact({type_name:'类'.repeat(1024),parameter:{...typeWriteImpact().parameter,name:'参'.repeat(1024),value_display:'显'.repeat(8192)}});
  assert.throws(()=>buildTypeParameterWriteReview(unicodeArgs,unicodeImpact,unicodeDocument),/review exceeds/);
});

test('the stable binding includes every semantic guard and ignores object insertion order only',()=>{
  const args=typeWriteArgs(),key=typeParameterWriteBindingKey(args,TYPE_WRITE_DOCUMENT),reordered=Object.fromEntries(Object.entries(args).reverse());
  reordered.expected_state=Object.fromEntries(Object.entries(args.expected_state).reverse());assert.equal(typeParameterWriteBindingKey(reordered,TYPE_WRITE_DOCUMENT),key);
  for(const patch of [{value:4},{mode:'commit'},{parameter_id:'-124'},{type_id:'9223372036854775805'},{expected_instance_ids:['2','10']},
    {expected_state:{...args.expected_state,value_internal:3}}])assert.notEqual(typeParameterWriteBindingKey({...args,...patch},TYPE_WRITE_DOCUMENT),key);
});
