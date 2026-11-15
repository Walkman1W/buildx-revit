import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {
  NATIVE_PARAMETER_WRITE_NAMES,nativeParameterWriteTools,nativeParameterWriteOperationForTool,
  assertNativeParameterWriteArguments,assertNativeParameterWriteResult,hostSupportsNativeParameterWrite,
} from '../lib/native-parameter-writes.mjs';
import {assertParameterWriteResult} from '../lib/parameter-write-result.mjs';
import {validateToolArguments,validateTool} from '../lib/workbench-client.mjs';
import {modelOperationEffect} from '../lib/model-operation-effects.mjs';
import {MODEL_AI_READ_TOOLS,MODEL_AI_EFFECT_TOOLS} from '../lib/panel-tools.mjs';
import {describeModelOperationSchema} from '../lib/model-operation-contracts.mjs';
import {MODEL_AGENT_TOOL} from '../lib/model-agent-tool.mjs';
import {createCodexSessionProfile} from '../lib/codex-profile.mjs';
import {WRITE_TOOL,WRITE_OPERATION,SOURCE_DOCUMENT,writeState,writeChange,writeArguments,writeValue} from '../test-support/native-single-parameter-write-fixtures.mjs';

const tool=()=>nativeParameterWriteTools().find(item=>item.name===WRITE_TOOL);
const reject=args=>{assert.throws(()=>assertNativeParameterWriteArguments(WRITE_TOOL,args));assert.throws(()=>validateToolArguments(WRITE_TOOL,args));};
const requestWith=(change={})=>writeArguments({changes:[writeChange(change)]});
const mutation=(alter,args=writeArguments())=>{const value=writeValue(args);alter(value);assert.throws(()=>assertNativeParameterWriteResult(value,args));};

test('the named instance write owns one guarded change and stays separate from read contracts',()=>{
  assert.deepEqual(NATIVE_PARAMETER_WRITE_NAMES,[WRITE_TOOL]);assert.equal(nativeParameterWriteOperationForTool(WRITE_TOOL),WRITE_OPERATION);
  assert.equal(nativeParameterWriteOperationForTool('revit_set_parameters'),undefined);
  assert.equal(tool().annotations.readOnlyHint,false);assert.equal(tool().annotations.idempotentHint,false);
  assert.ok(Object.isFrozen(tool().inputSchema.properties.changes.items.properties.expected_state));
  assert.deepEqual(tool().inputSchema.required,['expected_document','changes']);
  assert.equal(tool().inputSchema.properties.changes.minItems,1);assert.equal(tool().inputSchema.properties.changes.maxItems,1);
  assert.equal(tool().inputSchema.additionalProperties,false);
  assert.match(tool().description,/never an ElementType/);
  const normalized=validateTool(WRITE_TOOL,writeArguments());assert.equal(normalized.operation,WRITE_OPERATION);assert.equal(normalized.args.mode,'rollback');
});

test('write capability requires host 0.8.5, family v1 and the exact named write operation',()=>{
  const host={version:'0.8.5',nativeParameterWritesVersion:1,nativeParameterWriteOperations:[WRITE_OPERATION]};
  for(const version of ['0.8.5','0.8.5.0','0.9.0','1.0.0'])assert.equal(hostSupportsNativeParameterWrite({...host,version}),true,version);
  for(const patch of [{version:'0.8.4'},{version:'0.8.5-preview'},{nativeParameterWritesVersion:undefined},{nativeParameterWritesVersion:0},
    {nativeParameterWritesVersion:2},{nativeParameterWriteOperations:[]},{nativeParameterWriteOperations:['set_parameters']},
    {nativeParameterWriteOperations:[WRITE_OPERATION,WRITE_OPERATION]}])assert.equal(hostSupportsNativeParameterWrite({...host,...patch}),false,JSON.stringify(patch));
  assert.equal(hostSupportsNativeParameterWrite(host,'set_parameters'),false);
  assert.equal(hostSupportsNativeParameterWrite(null),false);
  assert.equal(hostSupportsNativeParameterWrite({version:'0.8.5',nativeParameterQueriesVersion:1,nativeParameterQueryOperations:[WRITE_OPERATION]}),false);
});

test('argument normalization defaults to rollback, preserves exact input IDs and detaches the guard',()=>{
  const input=requestWith({element_id:42,parameter_id:-123}),before=structuredClone(input);
  const normalized=assertNativeParameterWriteArguments(WRITE_TOOL,input);
  assert.equal(normalized.mode,'rollback');assert.equal(normalized.changes[0].element_id,42);assert.equal(normalized.changes[0].parameter_id,-123);
  assert.notEqual(normalized.changes,input.changes);assert.notEqual(normalized.changes[0].expected_state,input.changes[0].expected_state);
  normalized.changes[0].expected_state.value_internal=99;assert.deepEqual(input,before);
  const unbound={changes:[writeChange()]};
  assert.throws(()=>assertNativeParameterWriteArguments(WRITE_TOOL,unbound));
  const admissible=assertNativeParameterWriteArguments(WRITE_TOOL,unbound,{allowDocumentBinding:true});assert.equal(Object.hasOwn(admissible,'expected_document'),false);assert.equal(admissible.mode,'rollback');
  for(const expected_document of ['',null,'D:\\fixture\nwrong.rvt','x'.repeat(32769)])reject({...writeArguments(),expected_document});
  reject({...writeArguments(),mode:'automatic'});reject({...writeArguments(),mode:null});
  for(const changes of [[],[writeChange(),writeChange()],null,{}])reject({...writeArguments(),changes});
  reject({...writeArguments(),type_id:21});reject(requestWith({parameter_name:'Width'}));
  const absent=requestWith();delete absent.changes[0].expected_state;reject(absent);
});

test('source and signed parameter IDs preserve Int64 strings without reserved IDs, coercion or rounding',()=>{
  for(const element_id of [1,Number.MAX_SAFE_INTEGER,'9007199254740993','9223372036854775807'])for(const parameter_id of [-2,1,-Number.MAX_SAFE_INTEGER,'9223372036854775807','-9223372036854775808']){
    const input=requestWith({element_id,parameter_id}),chosen=assertNativeParameterWriteArguments(WRITE_TOOL,input);
    assert.equal(chosen.changes[0].element_id,element_id);assert.equal(chosen.changes[0].parameter_id,parameter_id);
  }
  for(const element_id of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'01','9223372036854775808',true,null])reject(requestWith({element_id}));
  for(const parameter_id of [0,-1,'0','-1','-0','01','-01','+1',' 1','1e2','9223372036854775808','-9223372036854775809',Number.MAX_SAFE_INTEGER+1,-Number.MAX_SAFE_INTEGER-1,1.5,NaN,Infinity,null,true])reject(requestWith({parameter_id}));
});

test('the expected guard requires all four typed facts and explicit null for an absent value',()=>{
  for(const key of Object.keys(writeState())){const expected_state=writeState();delete expected_state[key];reject(requestWith({expected_state}));}
  for(const expected_state of [writeState({extra:true}),writeState({storage_type:'ElementId'}),writeState({storage_type:'None'}),writeState({has_value:1}),
    writeState({has_value:false}),writeState({value_internal:'1'}),writeState({value_internal:Infinity}),writeState({data_type:42}),writeState({data_type:'x'.repeat(1025)})])reject(requestWith({expected_state}));
  for(const has_value of [false,true])assert.doesNotThrow(()=>assertNativeParameterWriteArguments(WRITE_TOOL,requestWith({expected_state:writeState({has_value,value_internal:null,data_type:null})})));
  for(const [storage_type,value,value_internal] of [['Integer',2,1],['String','new','old']]){
    const input=requestWith({value,expected_state:writeState({storage_type,value_internal,data_type:null})});delete input.changes[0].value_unit;
    assert.doesNotThrow(()=>assertNativeParameterWriteArguments(WRITE_TOOL,input));
  }
  reject(requestWith({expected_state:writeState({storage_type:'Integer',value_internal:1.5})}));
  reject(requestWith({value:'new',expected_state:writeState({storage_type:'String',value_internal:'x'.repeat(64001)})}));
});

test('requested values retain storage types, Int32 bounds, raw String data and explicit Double internal units',()=>{
  const missing=requestWith();delete missing.changes[0].value_unit;reject(missing);
  for(const value_unit of ['mm','feet','',null,1])reject(requestWith({value_unit}));
  for(const value of [NaN,Infinity,-Infinity,'2',true,null,{},[]])reject(requestWith({value}));
  for(const value of [-2147483648,0,2147483647])assert.doesNotThrow(()=>assertNativeParameterWriteArguments(WRITE_TOOL,requestWith({value,expected_state:writeState({storage_type:'Integer',value_internal:1})})));
  for(const value of [-2147483649,2147483648,1.5,true,'2'])reject(requestWith({value,expected_state:writeState({storage_type:'Integer',value_internal:1})}));
  for(const value of ['', ' 空格及中文 ', '2', 'x'.repeat(64000)])assert.doesNotThrow(()=>assertNativeParameterWriteArguments(WRITE_TOOL,requestWith({value,expected_state:writeState({storage_type:'String',value_internal:'old'})})));
  for(const value of [2,true,null,'x'.repeat(64001)])reject(requestWith({value,expected_state:writeState({storage_type:'String',value_internal:'old'})}));
});

test('verified instance results keep canonical output IDs, exact before facts and unchanged rows',()=>{
  for(const [storage_type,value_internal,value,data_type] of [['Double',1,2,'length'],['Integer',1,2,null],['String','原值','新值','text'],['String','same','same',null],['String',null,'','text']]){
    const args=requestWith({element_id:42,parameter_id:-123,value,expected_state:writeState({storage_type,value_internal,has_value:value_internal!==null,data_type})});
    const valueResult=writeValue(args),before=structuredClone(valueResult);
    assert.equal(assertNativeParameterWriteResult(valueResult,args),valueResult);assert.deepEqual(valueResult,before);
    assert.equal(valueResult.result.changes[0].element_id,'42');assert.equal(valueResult.result.changes[0].parameter_id,'-123');
    assert.equal(valueResult.result.updated_count,1);assert.equal(valueResult.result.changes[0].changed,value_internal!==value);
    assert.equal(assertNativeParameterWriteResult(valueResult,{...args,mode:'rollback'}),valueResult);
  }
});

test('wrong target, source, row identities, count or noncanonical output IDs never verify',()=>{
  for(const change of [value=>{value.schema_version=2;},value=>{value.target_kind='type';},value=>{value.result.updated_count=0;},
    value=>{value.result.changes=[];},value=>{value.result.changes.push(structuredClone(value.result.changes[0]));},
    value=>{value.result.changes[0].element_id='9007199254740994';},value=>{value.result.changes[0].parameter_id='-124';},
    value=>{value.result.changes[0].element_id=42;},value=>{value.result.changes[0].parameter_id=-123;},
    value=>{value.result.changes[0].element_id='09007199254740993';},value=>{value.extra=true;},value=>{value.result.changes[0].extra=true;}])mutation(change);
  mutation(value=>{value.result.changes[0].element_id=42;},requestWith({element_id:42}));
  for(const key of ['schema_version','target_kind','before','result'])mutation(value=>{delete value[key];});
});

test('before-state drift, wrong metadata, readback or changed flags remain unverified',()=>{
  for(const change of [value=>{value.before.value_internal=9;},value=>{value.before.has_value=false;value.before.value_internal=null;},
    value=>{value.before.data_type='different';},value=>{value.before.storage_type='Integer';},
    value=>{value.result.changes[0].data_type='different';},value=>{value.result.changes[0].before_internal=9;},
    value=>{value.result.changes[0].after_internal=3;},value=>{value.result.changes[0].storage_type='Integer';},
    value=>{value.result.changes[0].changed=false;}])mutation(change);
  mutation(value=>{value.result.changes[0].changed=true;},requestWith({value:1}));
});

test('the legacy default result verifier still requires safe numeric IDs and non-null metadata',()=>{
  const request={changes:[{element_id:42,parameter_id:-123,value:2,value_unit:'internal'}]},legacy={updated_count:1,changes:[{element_id:42,parameter_id:-123,storage_type:'Double',data_type:'length',changed:true,before_internal:1,after_internal:2}]};
  assert.equal(assertParameterWriteResult(legacy,request),legacy);
  for(const patch of [{element_id:'42'},{parameter_id:'-123'},{data_type:null}])assert.throws(()=>assertParameterWriteResult({...legacy,changes:[{...legacy.changes[0],...patch}]},request));
});

test('Ajv and dynamic metadata preserve the guarded one-change contract without making it a read MCP tool',()=>{
  const validate=new Ajv({strict:true}).compile(tool().inputSchema);
  assert.equal(validate(writeArguments()),true,JSON.stringify(validate.errors));
  for(const changes of [[],[writeChange(),writeChange()]])assert.equal(validate({...writeArguments(),changes}),false);
  const missing=requestWith();delete missing.changes[0].expected_state;assert.equal(validate(missing),false);
  assert.equal(modelOperationEffect(WRITE_TOOL).kind,'model_transaction');assert.equal(MODEL_AI_READ_TOOLS.some(item=>item.name===WRITE_TOOL),false);
  assert.equal(MODEL_AI_EFFECT_TOOLS.some(item=>item.name===WRITE_TOOL),true);
  const described=describeModelOperationSchema({tool:WRITE_TOOL});assert.equal(described.ok,true);assert.deepEqual(described.value.inputSchema,tool().inputSchema);
  assert.ok(MODEL_AGENT_TOOL.inputSchema.oneOf.some(branch=>branch.properties.tool.enum.includes(WRITE_TOOL)));
  const legacy=createCodexSessionProfile('D:\\controlled-program',{profile:'model'});
  assert.equal(legacy.toolNames.includes(WRITE_TOOL),false);assert.equal(legacy.groups.some(group=>group.toolNames.includes(WRITE_TOOL)),false);
});
