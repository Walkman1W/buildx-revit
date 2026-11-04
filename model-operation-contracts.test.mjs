import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {MODEL_AI_EFFECT_TOOLS} from './lib/panel-tools.mjs';
import {supportsModelPermissionTool} from './lib/model-operation-effects.mjs';
import {MODEL_AGENT_TOOL,MODEL_AGENT_TOOL_WITH_FAMILY_LIFECYCLE} from './lib/model-agent-tool.mjs';
import {MODEL_OPERATION_SCHEMA_TOOL,modelOperationContracts,describeModelOperationSchema} from './lib/model-operation-contracts.mjs';
import {createModelWorkspaceSessionProfile} from './lib/codex-profile.mjs';
import {CodexClientCore} from './lib/codex-client-core.mjs';

test('on-demand contracts preserve the registered schema without granting model authority',()=>{
  const names=modelOperationContracts(true).map(contract=>contract.name);
  assert.deepEqual(MODEL_OPERATION_SCHEMA_TOOL.inputSchema.properties.tool.enum,names);
  for(const name of names){
    const original=MODEL_AI_EFFECT_TOOLS.find(tool=>tool.name===name);
    const result=describeModelOperationSchema({tool:name});
    assert.equal(result.ok,true);
    assert.equal(result.value.tool,name);
    assert.equal(result.value.description,original.description);
    assert.deepEqual(result.value.inputSchema,original.inputSchema);
    assert.notEqual(result.value.inputSchema,original.inputSchema);
    assert.equal(result.value.requiresFamilyLifecycleCapability,['revit_family_save_job','revit_family_close_job'].includes(name));
    assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.value.inputSchema));
    assert.throws(()=>{result.value.inputSchema.required.push('injected');},TypeError);
  }
  assert.deepEqual(modelOperationContracts().map(contract=>contract.name),MODEL_AI_EFFECT_TOOLS.filter(tool=>supportsModelPermissionTool(tool.name)).map(tool=>tool.name));
});

test('schema lookup rejects malformed data, aliases, unknown names and getters without model work',()=>{
  let reads=0;
  for(const input of [null,[],{},'revit_create_wall',{tool_name:'revit_create_wall'},
    {tool:'revit_create_wall',parameters:{}},{tool:1},{get tool(){reads++;return 'revit_create_wall';}},
    {[Symbol('tool')]:'revit_create_wall'},{tool:'revit_create_wall',[Symbol('extra')]:true},
    new Proxy({},{getPrototypeOf(){throw new Error('PRIVATE invalid boundary');}})]){
    assert.equal(describeModelOperationSchema(input).error.code,'MODEL_OPERATION_SCHEMA_INPUT_INVALID');
  }
  assert.equal(reads,0);
  for(const tool of ['__proto__','constructor','revit_create_window','revit_create_wall ','REVIT_CREATE_WALL'])
    assert.equal(describeModelOperationSchema({tool}).error.code,'MODEL_OPERATION_SCHEMA_UNAVAILABLE');
  assert.equal(describeModelOperationSchema(Object.assign(Object.create(null),{tool:'revit_create_wall'})).ok,true);
});

test('wall discovery supplies the exact fields missing from observed malformed model calls',()=>{
  const {value}=describeModelOperationSchema({tool:'revit_create_wall'});
  assert.deepEqual(value.inputSchema.required,['expected_document','wall_type_id','level_id','start_mm','end_mm','height_mm']);
  assert.equal(value.inputSchema.properties.mode.default,'rollback');
  assert.match(value.inputSchema.properties.start_mm.description,/millimetres/);
  const ajv=new Ajv({strict:false}),lookup=ajv.compile(MODEL_OPERATION_SCHEMA_TOOL.inputSchema),call=ajv.compile(MODEL_AGENT_TOOL.inputSchema);
  assert.equal(lookup({tool:'revit_create_wall'}),true);
  assert.equal(lookup({tool_name:'revit_create_wall'}),false);
  const parameters={expected_document:'D:\\BuildXProbe\\Test.rvt',wall_type_id:1740,level_id:355,
    start_mm:{x:0,y:0,z:0},end_mm:{x:4000,y:0,z:0},height_mm:3000,mode:'commit'};
  assert.equal(call({tool:'revit_create_wall',parameters}),true);
  for(const invalid of [{tool:'revit_create_wall'},{tool:'revit_create_wall',parameters:{}},
    {tool_name:'revit_create_wall',parameters,mode:'commit'},
    {tool:'revit_create_wall',parameters:{...parameters,start_point:parameters.start_mm}}])assert.equal(call(invalid),false);
});

test('both workspace capability variants register the same metadata tool within transport budgets',()=>{
  const profile=createModelWorkspaceSessionProfile(process.cwd());
  for(const tools of [profile.dynamicTools,profile.familyLifecycleDynamicTools]){
    assert.equal(tools.length,10);
    assert.ok(Buffer.byteLength(JSON.stringify(tools))<=32768);
    assert.equal(tools.find(tool=>tool.name==='buildx_model_operation_schema'),MODEL_OPERATION_SCHEMA_TOOL);
  }
  assert.doesNotThrow(()=>new CodexClientCore(process.cwd(),profile));
  assert.deepEqual(profile.dynamicTools.filter(tool=>tool.name!=='buildx_model_operation'),
    profile.familyLifecycleDynamicTools.filter(tool=>tool.name!=='buildx_model_operation'));
  for(const [tool,lifecycle] of [[MODEL_AGENT_TOOL,false],[MODEL_AGENT_TOOL_WITH_FAMILY_LIFECYCLE,true]])
    for(const contract of modelOperationContracts(lifecycle))assert.deepEqual(tool.inputSchema.oneOf.find(variant=>variant.properties.tool.enum[0]===contract.name).properties.parameters,describeModelOperationSchema({tool:contract.name}).value.inputSchema);
});
