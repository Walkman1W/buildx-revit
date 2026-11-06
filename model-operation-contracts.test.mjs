import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import {MODEL_AI_EFFECT_TOOLS,MODEL_AI_READ_TOOLS} from './lib/panel-tools.mjs';
import {supportsModelPermissionTool} from './lib/model-operation-effects.mjs';
import {MODEL_AGENT_TOOL,MODEL_AGENT_TOOL_WITH_FAMILY_LIFECYCLE} from './lib/model-agent-tool.mjs';
import {MODEL_OPERATION_SCHEMA_TOOL,modelOperationContracts,describeModelOperationSchema} from './lib/model-operation-contracts.mjs';
import {createModelWorkspaceSessionProfile} from './lib/codex-profile.mjs';
import {CodexClientCore} from './lib/codex-client-core.mjs';
import {createModelPermissionOwner} from './lib/model-permission-owner.mjs';

const documentPath='D:\\controlled\\catalog-budget.rvt';
const strictAjv=()=>new Ajv2020({strict:true,allErrors:true});
function schemaSample(rule,key=''){
  if(Object.hasOwn(rule,'const'))return structuredClone(rule.const);
  if(rule.enum)return structuredClone(rule.enum[0]);
  const alternatives=rule.anyOf??rule.oneOf;
  if(alternatives){
    const ajv=strictAjv(),validate=ajv.compile(rule);
    for(const candidate of alternatives){const value=schemaSample(candidate,key);if(validate(value))return value;}
    throw new Error('No controlled schema sample for '+key);
  }
  if(rule.type==='object')return Object.fromEntries((rule.required??[]).map(name=>[name,schemaSample(rule.properties[name],name)]));
  if(rule.type==='array')return Array.from({length:rule.minItems??0},()=>schemaSample(rule.items,key+'[]'));
  if(rule.type==='boolean')return true;
  if(rule.type==='null')return null;
  if(rule.type==='number'||rule.type==='integer'){
    let value=Math.max(rule.minimum??0,0);if(rule.exclusiveMinimum!==undefined)value=Math.max(value,rule.exclusiveMinimum+1);
    if(rule.maximum!==undefined)value=Math.min(value,rule.maximum);if(rule.exclusiveMaximum!==undefined)value=Math.min(value,rule.exclusiveMaximum-1);return value;
  }
  if(rule.type==='string'){
    const candidates=['expected_document','documentPath'].includes(key)?[documentPath]:['fixture','catalog-budget','a'.repeat(64),'a'.repeat(32),'1','100'];
    const validate=strictAjv().compile(rule);
    for(const candidate of [...candidates,'a'.repeat(Math.max(1,rule.minLength??0))])if(validate(candidate))return candidate;
    throw new Error('No bounded string sample for '+key);
  }
  return {};
}
function nestedInvalidSamples(schema,value){
  const samples=[];
  const change=(path,alter)=>{const result=structuredClone(value);let target=result;for(const key of path)target=target[key];alter(target);samples.push(result);};
  const walk=(rule,current,path=[])=>{
    if(rule.type==='object'){
      for(const key of rule.required??[])change(path,target=>{delete target[key];});
      if(rule.additionalProperties===false)change(path,target=>{target.catalog_unrecognized_field=true;});
      for(const [key,child] of Object.entries(rule.properties??{}))if(Object.hasOwn(current,key))walk(child,current[key],[...path,key]);
    }else if(rule.type==='array')current.forEach((entry,index)=>walk(rule.items,entry,[...path,index]));
    else for(const branch of rule.anyOf??rule.oneOf??[])if(strictAjv().compile(branch)(current))walk(branch,current,path);
  };
  walk(schema,value);return samples;
}

test('on-demand contracts preserve the registered schema without granting model authority',()=>{
  const names=modelOperationContracts(true).map(contract=>contract.name);
  assert.deepEqual(MODEL_OPERATION_SCHEMA_TOOL.inputSchema.properties.tool.enum,[...MODEL_AI_READ_TOOLS.map(tool=>tool.name),...names]);
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
  const script=describeModelOperationSchema({tool:'revit_execute_csharp'});
  assert.equal(script.ok,true);
  const guidance=script.value.inputSchema.properties.code.description;
  assert.match(guidance,/Revit 2024/);
  assert.match(guidance,/TessellatedShapeBuilder\.Build\(\)/);
  assert.match(guidance,/\bSolid\s*\/\s*Abort\b.*\bAnyGeometry\s*\/\s*Mesh\b.*\bMesh\s*\/\s*Salvage\b/s);
  assert.match(guidance,/\bAreTargetAndFallbackCompatible\b/);
});

test('domain discovery is bounded and exact read contracts retain their schemas',()=>{
  const seen=[],byDomain=new Map();
  for(const domain of ['document','elements','parameters','families','mep','views','commands']){
    let offset=0,more=true;
    const names=[];
    while(more){const result=describeModelOperationSchema({domain,offset,limit:3});assert.equal(result.ok,true);assert.ok(result.value.tools.length<=3);names.push(...result.value.tools.map(tool=>tool.name));more=result.value.hasMore;offset+=3;}
    byDomain.set(domain,names);
    seen.push(...names);
  }
  assert.deepEqual(new Set(seen),new Set([...MODEL_AI_READ_TOOLS.map(t=>t.name),...modelOperationContracts(true).map(t=>t.name)]));
  for(const tool of MODEL_AI_READ_TOOLS){const result=describeModelOperationSchema({tool:tool.name}).value;assert.deepEqual(result.inputSchema,tool.inputSchema);assert.deepEqual(result.outputSchema,tool.outputSchema);}
  const views=describeModelOperationSchema({domain:'views',limit:20}).value.tools.map(tool=>tool.name);
  for(const name of MODEL_AI_READ_TOOLS.filter(tool=>/schedule|revision/.test(tool.name)).map(tool=>tool.name))assert.ok(views.includes(name),name);
  for(const name of ['revit_check_clashes','revit_calculate_material_quantities','revit_create_level','revit_create_grid','revit_pin_element','revit_unpin_element']){
    assert.ok(byDomain.get('elements').includes(name),name);
  }
  for(const input of [{domain:'bad'},{domain:'mep',limit:21},{domain:'mep',offset:-1},{domain:'mep',tool:'revit_execute_csharp'}])assert.equal(describeModelOperationSchema(input).ok,false);
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
  for(const invalid of [{tool:'revit_create_wall'}, {tool_name:'revit_create_wall',parameters,mode:'commit'}])assert.equal(call(invalid),false);
  assert.equal(call({tool:'revit_create_wall',parameters:{}}),true); // Trusted owner validates inner fields.
});

test('both actual workspace registrations retain at least 4 KiB within the 32 KiB transport budget',t=>{
  const profile=createModelWorkspaceSessionProfile(process.cwd());
  for(const [variant,tools] of [['default',profile.dynamicTools],['family',profile.familyLifecycleDynamicTools]]){
    assert.equal(tools.length,10);
    const bytes=Buffer.byteLength(JSON.stringify(tools));assert.ok(bytes<=32768-4096,variant+' registration must reserve 4096 bytes, got '+bytes);
    t.diagnostic(JSON.stringify({variant,registeredTools:tools.length,bytes,budget:32768,headroom:32768-bytes}));
    assert.equal(tools.find(tool=>tool.name==='buildx_model_operation_schema'),MODEL_OPERATION_SCHEMA_TOOL);
  }
  assert.doesNotThrow(()=>new CodexClientCore(process.cwd(),profile));
  assert.deepEqual(profile.dynamicTools.filter(tool=>tool.name!=='buildx_model_operation'),
    profile.familyLifecycleDynamicTools.filter(tool=>tool.name!=='buildx_model_operation'));
  for(const contract of modelOperationContracts(true))assert.deepEqual(describeModelOperationSchema({tool:contract.name}).value.inputSchema,contract.inputSchema);
});

test('on-demand contracts retain validation of valid samples and malformed nested data',t=>{
  let operations=0,invalidSamples=0;
  for(const [tool,lifecycle] of [[MODEL_AGENT_TOOL,false],[MODEL_AGENT_TOOL_WITH_FAMILY_LIFECYCLE,true]]){
    const registered=strictAjv().compile(tool.inputSchema),contracts=modelOperationContracts(lifecycle);
    assert.deepEqual(tool.inputSchema.properties.tool.enum,contracts.map(contract=>contract.name));
    assert.equal(tool.inputSchema.oneOf,undefined);
    for(const contract of contracts){
      const original=strictAjv().compile(contract.inputSchema),sample=schemaSample(contract.inputSchema);operations++;
      assert.equal(original(sample),true,contract.name+': original controlled schema sample');
      assert.equal(registered({tool:contract.name,parameters:sample}),true,contract.name+': registered sample');
      for(const parameters of nestedInvalidSamples(contract.inputSchema,sample)){
        invalidSamples++;assert.equal(original(parameters),false,contract.name+': original nested invalid sample');
        assert.equal(registered({tool:contract.name,parameters}),true,contract.name+': compact registration accepts object for trusted validation');
      }
      for(const input of [{tool:contract.name},{tool:contract.name,parameters:sample,mode:'commit'},{tool_name:contract.name,parameters:sample}])assert.equal(registered(input),false);
    }
  }
  assert.ok(invalidSamples>250);t.diagnostic(JSON.stringify({operationVariants:operations,nestedInvalidSamples:invalidSamples}));
});

test('on-demand nested contracts retain alternatives and constraints',()=>{
  const validate=({tool,parameters})=>strictAjv().compile(describeModelOperationSchema({tool}).value.inputSchema)(parameters),base={expected_document:documentPath};
  const saved={command_id:'catalog-budget',name:'预算验证',description:'User content named description',code:'return 1;',parameters:{description:'string'}};
  assert.equal(validate({tool:'revit_save_command',parameters:saved}),true);
  for(const parameters of [{...saved,description:42},{...saved,parameters:{description:'object'}},{...saved,code:''}])assert.equal(validate({tool:'revit_save_command',parameters}),false);
  const typeWrite={...base,type_id:'9007199254740993',parameter_id:'-123',value:2,value_unit:'internal',expected_state:{storage_type:'Double',has_value:true,value_internal:1,data_type:'length'},expected_instance_ids:['100','101']};
  assert.equal(validate({tool:'revit_set_type_parameter',parameters:typeWrite}),true);
  for(const parameters of [{...typeWrite,value_unit:'mm'},{...typeWrite,ack:true},{...typeWrite,approved_type_write:{token:'forged'}},
    {...typeWrite,expected_state:{...typeWrite.expected_state,extra:true}},{...typeWrite,expected_state:{...typeWrite.expected_state,storage_type:'ElementId'}},
    {...typeWrite,expected_instance_ids:[100]},{...typeWrite,type_id:9007199254740992}])assert.equal(validate({tool:'revit_set_type_parameter',parameters}),false);
  const batch={...base,changes:[{element_id:100,parameter_id:-123,value:2,value_unit:'internal'}]};assert.equal(validate({tool:'revit_set_parameters',parameters:batch}),true);
  for(const changes of [[],Array(51).fill(batch.changes[0]),[{...batch.changes[0],parameter_name:'Guess'}],[{...batch.changes[0],parameter_id:0}]])assert.equal(validate({tool:'revit_set_parameters',parameters:{...base,changes}}),false);
  const script={...base,code:'return 1;',parameters:{description:'user text',number:2,flag:true}};assert.equal(validate({tool:'revit_execute_csharp',parameters:script}),true);
  assert.equal(validate({tool:'revit_execute_csharp',parameters:{...script,parameters:{nested:{value:1}}}}),false);
  assert.equal(validate({tool:'revit_execute_csharp',parameters:{...script,mode:'automatic'}}),false);
});

test('compact discovery still grants no execution authority and keeps family and type write permission owners',async()=>{
  const full=strictAjv().compile(MODEL_AGENT_TOOL_WITH_FAMILY_LIFECYCLE.inputSchema),ordinary=strictAjv().compile(MODEL_AGENT_TOOL.inputSchema);
  const lifecycle={tool:'revit_family_close_job',parameters:{job_handle:'controlled-job'}};
  assert.equal(full(lifecycle),true);assert.equal(ordinary(lifecycle),false);
  for(const name of ['revit_create_window','revit_execute_python','constructor','revit_set_type_parameter '])assert.equal(full({tool:name,parameters:{}}),false);
  let calls=0;const owner=createModelPermissionOwner({invoke:async()=>{calls++;return {ok:true};},verifyDocument:async()=>true});
  const scope={client:'controlled',conversationId:'catalog',generation:1,revision:1,account:'controlled',document:{session:'e'.repeat(32),path:documentPath,title:'Catalog fixture'}};
  const request={scope,callId:'catalog-type-write',tool:'revit_set_type_parameter',parameters:{expected_document:documentPath,type_id:'1000',parameter_id:'-123',value:2,value_unit:'internal',
    expected_state:{storage_type:'Double',has_value:true,value_internal:1,data_type:'length'},expected_instance_ids:['100','101']},isCurrent:()=>true};
  assert.equal(describeModelOperationSchema({tool:request.tool}).ok,true);assert.throws(()=>owner.propose(request),{code:'MODEL_PERMISSION_UNAVAILABLE'});
  owner.setLevel({scope,level:'automatic',isCurrent:()=>true});assert.throws(()=>owner.propose(request),{code:'MODEL_TYPE_PARAMETER_REVIEW_UNAVAILABLE'});
  for(const [index,tool,parameters,code] of [
    [0,'revit_create_wall',{},'MODEL_OPERATION_PARAMETERS_INVALID'],
    [1,'revit_create_wall',{expected_document:documentPath,wall_type_id:1,level_id:1,start_mm:{x:0,y:0,z:0},end_mm:{x:1,y:0,z:0},height_mm:1000,extra:true},'MODEL_OPERATION_PARAMETERS_INVALID'],
    [2,'revit_execute_csharp',{expected_document:documentPath,code:''},'MODEL_SCRIPT_PARAMETERS_INVALID'],
    [3,'revit_create_window',{},'MODEL_OPERATION_UNSUPPORTED'],
  ])assert.throws(()=>owner.propose({...request,callId:'invalid-'+index,tool,parameters}),{code});
  assert.throws(()=>owner.propose({...request,callId:'catalog-family-close',tool:lifecycle.tool,parameters:lifecycle.parameters}),{code:'MODEL_OPERATION_UNSUPPORTED'});
  assert.equal(calls,0);assert.equal((await owner.close()).closed,true);
});
