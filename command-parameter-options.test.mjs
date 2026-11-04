import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {fileURLToPath} from 'node:url';
import {COMMAND_TOOLS,invokeCommand} from './lib/command-store.mjs';
import {validateCommandParameterOptions,validateCommandParameterValues} from './public/command-parameter-options.mjs';

const draft={command_id:'dropdown-command',name:'下拉参数命令',description:'使用明确选项和当前模型中的类型',code:'return parameters;'};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-command-options-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('buildx-command-options-'));await fs.rm(root,{recursive:true,force:true});});
  return {root,call:(tool,args,options={})=>invokeCommand(tool,args,{root,...options})};
}
const run=(saved,parameters)=>({command_id:saved.command_id,revision:saved.revision,expected_document:'D:\\samples\\model.rvt',mode:'rollback',parameters});

test('exact persisted dropdown revision retains options through list/get and validates typed values before its sole execution',async t=>{
  const {root,call}=await fixture(t),parameters={mode:'string',quantity:'integer',enabled:'boolean',wall:'integer'},parameter_options={mode:{kind:'enum',values:['标准','加强']},quantity:{kind:'enum',values:[1,3]},enabled:{kind:'enum',values:[false,true]},wall:{kind:'model',source:'wall_type_id'}};
  const args={...draft,parameters,parameter_labels:{mode:'方案',quantity:'数量',enabled:'启用',wall:'墙类型'},parameter_options};
  const saved=await call('revit_save_command',args);assert.equal(saved.schema_version,5);assert.deepEqual(saved.parameter_options,parameter_options);
  const filename=path.join(root,'commands',saved.command_id,saved.revision+'.json'),original=await fs.readFile(filename);
  const repeat=await call('revit_save_command',args);assert.equal(repeat.created,false);assert.equal(repeat.revision,saved.revision);assert.deepEqual(await fs.readFile(filename),original);
  const record=await call('revit_get_command',{command_id:saved.command_id,revision:saved.revision});assert.deepEqual(record.parameter_options,parameter_options);assert.equal(record.code,args.code);
  const listed=await call('revit_list_commands',{});assert.deepEqual(listed.commands[0].parameter_options,parameter_options);assert.equal(Object.hasOwn(listed.commands[0],'code'),false);
  const calls=[],execute=async(...args)=>{calls.push(args);return {value:'done'};};
  await call('revit_run_command',run(saved,{mode:'加强',quantity:3,enabled:false,wall:42}),{parameterizedScriptsSupported:true,execute});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'revit_execute_csharp');assert.deepEqual(calls[0][1].parameters,{mode:'加强',quantity:3,enabled:false,wall:42});
  for(const values of [{mode:'其他',quantity:3,enabled:false,wall:42},{mode:'标准',quantity:2,enabled:false,wall:42},{mode:'标准',quantity:'3',enabled:false,wall:42},{mode:'标准',quantity:3,enabled:false,wall:0}]){
    await assert.rejects(call('revit_run_command',run(saved,values),{parameterizedScriptsSupported:true,execute}),/parameter/);
  }
  assert.equal(calls.length,1,'invalid choices must be rejected before any Revit call');
  const changed=await call('revit_save_command',{...args,parameter_options:{...parameter_options,quantity:{kind:'enum',values:[1,2,3]}}});
  assert.notEqual(changed.revision,saved.revision);assert.deepEqual(await fs.readFile(filename),original);
  const withoutLabels=await call('revit_save_command',{...draft,parameters,parameter_options});assert.equal(withoutLabels.schema_version,5);
  assert.equal((await call('revit_get_command',{command_id:withoutLabels.command_id,revision:withoutLabels.revision})).schema_version,5);
});

test('legacy C# and sequence versions retain their exact content digests',async t=>{
  const {call}=await fixture(t);
  for(const body of [
    {schema_version:1,...draft},
    {schema_version:2,...draft,parameters:{width:'number'}},
    {schema_version:4,...draft,parameters:{width:'number'},parameter_labels:{width:'宽度（毫米）'}},
    {schema_version:3,command_id:draft.command_id,name:draft.name,description:draft.description,parameters:{},steps:[{id:'levels',tool:'revit_list_levels',arguments:{}}]},
  ]){
    const {schema_version,...args}=body,saved=await call('revit_save_command',args);
    assert.equal(saved.schema_version,schema_version);assert.equal(saved.revision,createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    assert.equal((await call('revit_get_command',{command_id:saved.command_id,revision:saved.revision})).schema_version,schema_version);
  }
});

test('invalid option definitions cannot be saved or published, including model-source type drift and enum expansion',async t=>{
  const {root,call}=await fixture(t),valid={...draft,parameters:{choice:'string',level:'integer'}};
  for(const parameter_options of [null,[],{missing:{kind:'enum',values:['a']}},{choice:{kind:'enum',values:[]}},{choice:{kind:'enum',values:['a','a']}},{choice:{kind:'enum',values:[1]}},{choice:{kind:'enum',values:[' ']}},{choice:{kind:'enum',values:['x'.repeat(161)]}},{choice:{kind:'enum',values:Array.from({length:101},(_,index)=>String(index))}},{choice:{kind:'enum',values:['a'],extra:true}},{choice:{kind:'model',source:'level_id'}},{level:{kind:'model',source:'arbitrary_script'}},{level:{kind:'model',source:'level_id',category:'Walls'}},{choice:{kind:'unknown',values:['a']}}]){
    await assert.rejects(call('revit_save_command',{...valid,parameter_options}),/Command parameter options/);
  }
  await assert.rejects(call('revit_save_command',{...draft,parameter_options:{}}),/require code and parameters/);
  await assert.rejects(call('revit_save_command',{command_id:draft.command_id,name:draft.name,description:draft.description,parameters:{},steps:[{id:'levels',tool:'revit_list_levels',arguments:{}}],parameter_options:{}}),/steps do not support/);
  await assert.rejects(call('revit_save_command',{...valid,parameter_options:{level:{kind:'model',source:'level_id'}},source_request_id:'11111111-1111-4111-8111-111111111111'}),/source evidence for parameterized/);
  assert.deepEqual(await fs.readdir(root),[],'malformed choices must not create storage or locks');
});

test('source save schema accepts supported options and rejects malformed structure',()=>{
  const schema=COMMAND_TOOLS.find(tool=>tool.name==='revit_save_command').inputSchema,validate=new Ajv2020({strict:false}).compile(schema);
  assert.equal(validate({...draft,parameters:{mode:'string',level:'integer'},parameter_options:{mode:{kind:'enum',values:['A','B']},level:{kind:'model',source:'level_id'}}}),true,JSON.stringify(validate.errors));
  for(const parameter_options of [{mode:{kind:'enum',values:[]}},{mode:{kind:'enum',values:['A','A']}},{level:{kind:'model',source:'anything'}},{level:{kind:'model',source:'level_id',extra:true}}])assert.equal(validate({...draft,parameters:{mode:'string',level:'integer'},parameter_options}),false);
});

test('real MCP SDK tools/list retains the options schema and accepts it under the MCP JSON Schema 2020-12 dialect',async()=>{
  const client=new Client({name:'buildx-command-options-test',version:'1.0.0'},{versionNegotiation:{mode:'legacy'}});
  const root=fileURLToPath(new URL('.',import.meta.url)),transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'workbench-mcp.mjs')],cwd:root,env:{},stderr:'ignore',maxBufferSize:1024*1024});
  try{
    await client.connect(transport,{timeout:10000});const {tools}=await client.listTools(undefined,{timeout:10000}),schema=tools.find(tool=>tool.name==='revit_save_command').inputSchema;
    assert.deepEqual(schema.properties.parameter_options,COMMAND_TOOLS.find(tool=>tool.name==='revit_save_command').inputSchema.properties.parameter_options);
    const validate=new Ajv2020({strict:false}).compile(schema);
    assert.equal(validate({...draft,parameters:{level:'integer'},parameter_options:{level:{kind:'model',source:'level_id'}}}),true,JSON.stringify(validate.errors));
    assert.equal(validate({...draft,parameters:{level:'integer'},parameter_options:{level:{kind:'model',source:'unsupported'}}}),false);
  }finally{await client.close();}
});

test('aggregate JSON expansion is bounded before publication rather than only per enum field',async t=>{
  const {root,call}=await fixture(t),parameters={},parameter_options={};
  for(let field=0;field<5;field++){parameters['p'+field]='string';parameter_options['p'+field]={kind:'enum',values:Array.from({length:100},(_,index)=>String(index).padStart(3,'0')+'\u0001'.repeat(157))};}
  await assert.rejects(call('revit_save_command',{...draft,parameters,parameter_options}),/64 KiB command metadata budget/);
  assert.deepEqual(await fs.readdir(root),[]);
});

test('shared metadata validation accepts transported JSON across realms and preserves typed false and numeric enums',()=>{
  const transported=vm.runInNewContext('JSON.parse(\'{"options":{"constructor":{"kind":"enum","values":[false,true]},"number":{"kind":"enum","values":[1,2.5]},"floor":{"kind":"model","source":"floor_type_id"}},"types":{"constructor":"boolean","number":"number","floor":"integer"}}\')');
  const options=validateCommandParameterOptions(transported.options,transported.types);
  assert.deepEqual(options,{constructor:{kind:'enum',values:[false,true]},number:{kind:'enum',values:[1,2.5]},floor:{kind:'model',source:'floor_type_id'}});
  const values={constructor:false,number:2.5,floor:42};assert.equal(validateCommandParameterValues(options,transported.types,values),values);
  assert.throws(()=>validateCommandParameterValues(options,transported.types,{...values,constructor:'false'}),/typed parameter constructor/);
});
