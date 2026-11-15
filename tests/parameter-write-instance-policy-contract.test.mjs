import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {hostSupportsParameterWriteTargetPolicy,hostSupportsNativeParameterWrite,NATIVE_PARAMETER_WRITE_NAMES} from '../lib/native-parameter-writes.mjs';
import {WORKBENCH_TOOLS,validateTool,validateToolArguments,READONLY_WORKBENCH_TOOL_NAMES} from '../lib/workbench-client.mjs';
import {assertParameterWriteResult} from '../lib/parameter-write-result.mjs';
import {modelOperationEffect} from '../lib/model-operation-effects.mjs';
import {LEGACY_PANEL_WORKBENCH_TOOLS,MODEL_AI_READ_TOOLS,MODEL_AI_EFFECT_TOOLS} from '../lib/panel-tools.mjs';
import {describeModelOperationSchema} from '../lib/model-operation-contracts.mjs';
import {BATCH_TOOL,BATCH_OPERATION,batchArguments,batchChange,batchValue,policyHost} from '../test-support/parameter-write-instance-policy-fixtures.mjs';

const tool=WORKBENCH_TOOLS.find(item=>item.name===BATCH_TOOL);

test('the legacy batch policy requires a numeric host version at least 0.8.7 and both exact declarations',()=>{
  for(const version of ['0.8.7','0.8.7.0','0.8.8','0.9.0','1.0.0'])assert.equal(hostSupportsParameterWriteTargetPolicy(policyHost({version})),true,version);
  for(const version of [undefined,null,8,['0.8.7'],'','0.8.6','0.7.99','0.8.7-preview','v0.8.7','0.8.7\n','0.8','0.8.7.0.0','9007199254740992.0.0','0.8.7.9007199254740992'])
    assert.equal(hostSupportsParameterWriteTargetPolicy(policyHost({version})),false,JSON.stringify(version));
  for(const patch of [{parameterWriteTargetPolicyVersion:undefined},{parameterWriteTargetPolicyVersion:0},{parameterWriteTargetPolicyVersion:2},
    {parameterWriteTargetPolicyVersion:'1'},{parameterWriteTargetPolicyVersion:true},{parameterWriteTargetPolicy:undefined},
    {parameterWriteTargetPolicy:'Instance_Only'},{parameterWriteTargetPolicy:'instance_and_type'},{parameterWriteTargetPolicy:true}])
    assert.equal(hostSupportsParameterWriteTargetPolicy(policyHost(patch)),false,JSON.stringify(patch));
  for(const value of [null,undefined,[],{},Object.create({version:'0.8.7',parameterWriteTargetPolicyVersion:1,parameterWriteTargetPolicy:'instance_only'})])
    assert.equal(hostSupportsParameterWriteTargetPolicy(value),false);
});

test('the guarded single write retains its independent 0.8.5 gate without the legacy target policy',()=>{
  const single={version:'0.8.5',nativeParameterWritesVersion:1,nativeParameterWriteOperations:['set_parameter_value']};
  assert.equal(hostSupportsNativeParameterWrite(single),true);assert.equal(hostSupportsParameterWriteTargetPolicy(single),false);
  assert.equal(hostSupportsNativeParameterWrite({...single,parameterWriteTargetPolicyVersion:0,parameterWriteTargetPolicy:'unsupported'}),true);
  assert.equal(hostSupportsNativeParameterWrite(policyHost()),false);
  assert.equal(hostSupportsParameterWriteTargetPolicy({...single,version:'0.8.7'}),false);
  assert.equal(hostSupportsNativeParameterWrite({...single,version:'0.8.4'}),false);
  assert.deepEqual(NATIVE_PARAMETER_WRITE_NAMES,['revit_set_parameter_value']);
});

test('the batch keeps its old input and transaction contract while describing the new instance-only boundary',()=>{
  assert.match(tool.description,/INSTANCE/);assert.match(tool.description,/0\.8\.7/);assert.match(tool.description,/instance_only/);
  assert.match(tool.description,/every batch target.*before any Set/);assert.match(tool.description,/does not confine arbitrary C#/);
  assert.deepEqual(Object.keys(tool.inputSchema.properties),['expected_document','mode','changes']);
  assert.deepEqual(tool.inputSchema.required,['expected_document','changes']);assert.equal(tool.inputSchema.additionalProperties,false);
  assert.equal(tool.inputSchema.properties.changes.minItems,1);assert.equal(tool.inputSchema.properties.changes.maxItems,50);
  assert.deepEqual(Object.keys(tool.inputSchema.properties.changes.items.properties),['element_id','parameter_id','value','value_unit']);
  assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.idempotentHint,false);
  assert.equal(tool.outputSchema,undefined);
  const args=batchArguments(),before=structuredClone(args),normalized=validateTool(BATCH_TOOL,args);
  assert.equal(normalized.operation,BATCH_OPERATION);assert.equal(normalized.args.mode,'rollback');assert.deepEqual(args,before);
  normalized.args.changes[0].value=9;assert.deepEqual(args,before);
});

test('safe numeric identities, signed built-ins, 1-50 rows and explicit internal units remain unchanged',()=>{
  for(const element_id of [1,100,Number.MAX_SAFE_INTEGER])for(const parameter_id of [-2,-Number.MAX_SAFE_INTEGER,1,Number.MAX_SAFE_INTEGER])
    assert.doesNotThrow(()=>validateToolArguments(BATCH_TOOL,batchArguments({changes:[batchChange({element_id,parameter_id})]})));
  const rejected=[...['100',0,-1,1.5,Number.MAX_SAFE_INTEGER+1].map(element_id=>batchChange({element_id})),
    ...['1',0,-1,1.5,Number.MAX_SAFE_INTEGER+1].map(parameter_id=>batchChange({parameter_id})),
    batchChange({parameter_name:'Width'}),batchChange({type_id:200}),batchChange({expected_state:{}}),batchChange({value_unit:'mm'}),
    ...[NaN,Infinity,null,true,{}].map(value=>batchChange({value}))];
  for(const change of rejected)assert.throws(()=>validateToolArguments(BATCH_TOOL,batchArguments({changes:[change]})));
  for(const extra of [{type_id:200},{parameter_name:'Width'},{ack:true},{parameterWriteTargetPolicy:'instance_only'}])
    assert.throws(()=>validateToolArguments(BATCH_TOOL,{...batchArguments(),...extra}));
  for(const changes of [[],Array.from({length:51},()=>batchChange())])assert.throws(()=>validateToolArguments(BATCH_TOOL,batchArguments({changes})));
  const fifty=Array.from({length:50},(_,i)=>batchChange({element_id:i+1}));assert.equal(validateTool(BATCH_TOOL,batchArguments({changes:fifty})).args.changes.length,50);
  for(const value of ['', '原值', 2]){const change=batchChange({value});delete change.value_unit;assert.doesNotThrow(()=>validateToolArguments(BATCH_TOOL,batchArguments({changes:[change]})));}
});

test('Ajv and the shared validator agree on unchanged identity shapes and refuse policy fields supplied by callers',()=>{
  const validate=new Ajv({strict:true,allErrors:true}).compile(tool.inputSchema);
  assert.equal(validate(batchArguments()),true);
  for(const input of [batchArguments({type_id:200}),batchArguments({ack:true}),batchArguments({changes:[batchChange({element_id:'100'})]}),
    batchArguments({changes:[batchChange({parameter_id:'-123'})]}),batchArguments({changes:[batchChange({parameter_name:'Width'})]})])assert.equal(validate(input),false);
  const described=describeModelOperationSchema({tool:BATCH_TOOL});assert.equal(described.ok,true);assert.deepEqual(described.value.inputSchema,tool.inputSchema);
});

test('the legacy seven-field row stays with its result owner instead of claiming a new authorization receipt',()=>{
  const args=validateTool(BATCH_TOOL,batchArguments()).args,value=batchValue(args);
  assert.equal(assertParameterWriteResult(value,args),value);assert.deepEqual(Object.keys(value),['updated_count','changes']);
  assert.deepEqual(Object.keys(value.changes[0]),['element_id','parameter_id','storage_type','data_type','changed','before_internal','after_internal']);
  for(const alter of [row=>{row.element_id='100';},row=>{row.parameter_id='1';},row=>{row.after_internal=3;},row=>{row.changed=false;},row=>{row.target_kind='instance';}]){
    const bad=structuredClone(value);alter(bad.changes[0]);assert.throws(()=>assertParameterWriteResult(bad,args));
  }
});

test('the operation remains a legacy model transaction and never appears in either read-only MCP profile',()=>{
  assert.equal(modelOperationEffect(BATCH_TOOL).kind,'model_transaction');
  assert.equal(LEGACY_PANEL_WORKBENCH_TOOLS.filter(item=>item.name===BATCH_TOOL).length,1);
  assert.ok(MODEL_AI_EFFECT_TOOLS.some(item=>item.name===BATCH_TOOL));assert.ok(!MODEL_AI_READ_TOOLS.some(item=>item.name===BATCH_TOOL));
  assert.ok(!READONLY_WORKBENCH_TOOL_NAMES.includes(BATCH_TOOL));
  assert.ok(WORKBENCH_TOOLS.some(item=>item.name==='revit_set_type_parameter'));
  assert.ok(MODEL_AI_EFFECT_TOOLS.some(item=>item.name==='revit_set_type_parameter'));
  assert.ok(!LEGACY_PANEL_WORKBENCH_TOOLS.some(item=>item.name==='revit_set_type_parameter'));
  assert.ok(!MODEL_AI_READ_TOOLS.some(item=>item.name==='revit_set_type_parameter'));
  assert.ok(!READONLY_WORKBENCH_TOOL_NAMES.includes('revit_set_type_parameter'));
});
