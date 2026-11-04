import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {COMMAND_TOOLS,invokeCommand} from './lib/command-store.mjs';

const base={command_id:'labelled-command',name:'按规则放置',description:'读取个人参数并放置构件。'};
const code='return parameters["count"];';
const parameters={count:'integer',enabled:'boolean',note:'string'};
const parameter_labels={count:'放置数量（个）',enabled:'启用偏移',note:'构件备注'};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-command-labels-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,call:(name,args={},options={})=>invokeCommand(name,args,{root,...options})};
}
const getArgs=saved=>({command_id:saved.command_id,revision:saved.revision});
const recordFile=(root,saved)=>path.join(root,'commands',saved.command_id,saved.revision+'.json');
const sha=body=>createHash('sha256').update(JSON.stringify(body)).digest('hex');

test('save contract advertises bounded display labels without changing execution keys',()=>{
  const labels=COMMAND_TOOLS.find(tool=>tool.name==='revit_save_command').inputSchema.properties.parameter_labels;
  assert.equal(labels.type,'object');assert.equal(labels.maxProperties,32);assert.deepEqual(labels.additionalProperties,{type:'string',minLength:1,maxLength:80});
  assert.equal(Object.hasOwn(COMMAND_TOOLS.find(tool=>tool.name==='revit_run_command').inputSchema.properties,'parameter_labels'),false);
});

test('save, read and list retain immutable schema 4 labels and label changes create a new revision',async t=>{
  const {root,call}=await fixture(t),args={...base,code,parameters,parameter_labels};
  const saved=await call('revit_save_command',args);assert.equal(saved.schema_version,4);assert.deepEqual(saved.parameters,parameters);assert.deepEqual(saved.parameter_labels,parameter_labels);
  const original=await fs.readFile(recordFile(root,saved));
  const read=await call('revit_get_command',getArgs(saved));assert.equal(read.code,code);assert.deepEqual(read.parameter_labels,parameter_labels);
  const again=await call('revit_save_command',args);assert.equal(again.created,false);assert.equal(again.revision,saved.revision);
  const renamed=await call('revit_save_command',{...args,parameter_labels:{...parameter_labels,count:'创建数量（个）'}});
  assert.notEqual(renamed.revision,saved.revision);assert.deepEqual(await fs.readFile(recordFile(root,saved)),original);
  const listed=await call('revit_list_commands');assert.equal(listed.total,2);assert.ok(listed.commands.every(record=>Object.hasOwn(record,'parameter_labels')&&!Object.hasOwn(record,'code')));
});

test('labels are metadata only: exact revision execution passes typed values and original C# once',async t=>{
  const {call}=await fixture(t),saved=await call('revit_save_command',{...base,code,parameters,parameter_labels});
  await call('revit_save_command',{...base,code:'return 999;',parameters,parameter_labels});
  const values={count:3,enabled:false,note:'新备注'},calls=[];
  const run=await call('revit_run_command',{...getArgs(saved),expected_document:'D:\\sample.rvt',parameters:values},{parameterizedScriptsSupported:true,execute:async(...args)=>{calls.push(args);return {request_id:'exact-revision'};}});
  assert.deepEqual(calls,[['revit_execute_csharp',{code,expected_document:'D:\\sample.rvt',mode:'rollback',parameters:values}]]);
  assert.equal(run.command.revision,saved.revision);assert.equal(run.execution.request_id,'exact-revision');
  let executed=false;
  await assert.rejects(call('revit_run_command',{...getArgs(saved),expected_document:'D:\\sample.rvt',parameters:values},{execute:async()=>{executed=true;}}),/capability/);assert.equal(executed,false);
  await assert.rejects(call('revit_run_command',{...getArgs(saved),expected_document:'D:\\sample.rvt',parameters:values,parameter_labels},{parameterizedScriptsSupported:true,execute:async()=>{executed=true;}}),/unknown/);assert.equal(executed,false);
});

test('labels require C# parameters and reject unknown keys, invalid labels, excess metadata and sequences',async t=>{
  const {call}=await fixture(t),args={...base,code,parameters};
  for(const labels of [null,[],{missing:'未知参数'},{count:''},{count:'   '},{count:1},{count:'字'.repeat(81)},Object.fromEntries(Array.from({length:33},(_,i)=>['p'+i,'名称']))]){
    await assert.rejects(call('revit_save_command',{...args,parameter_labels:labels}),/parameter_labels/);
  }
  await assert.rejects(call('revit_save_command',{...base,code,parameter_labels:{}}),/require code and parameters/);
  await assert.rejects(call('revit_save_command',{...base,parameters,parameter_labels,steps:[{id:'one',tool:'revit_list_levels',arguments:{}}]}),/steps do not support labels/);
  const partial=await call('revit_save_command',{...args,parameter_labels:{count:'数量'}});assert.equal(partial.schema_version,4);assert.deepEqual(partial.parameter_labels,{count:'数量'});
  assert.equal((await call('revit_save_command',{...base,code,parameters:{},parameter_labels:{}})).schema_version,4);
});

test('schema 4 reads fail closed for tampered labels, missing metadata and legacy schema aliases',async t=>{
  const {root,call}=await fixture(t),saved=await call('revit_save_command',{...base,code,parameters,parameter_labels}),filename=recordFile(root,saved);
  const original=JSON.parse(await fs.readFile(filename,'utf8'));
  for(const mutate of [record=>{record.parameter_labels.count='伪造名称';},record=>{delete record.parameter_labels;},record=>{record.schema_version=2;}]){
    const record=structuredClone(original);mutate(record);await fs.writeFile(filename,JSON.stringify(record));
    await assert.rejects(call('revit_get_command',getArgs(saved)),/SHA256 mismatch|missing record.parameter_labels|unknown record.parameter_labels/);
  }
});

test('unlabelled schema 1, 2 and 3 revisions retain their original canonical hashes and reading behavior',async t=>{
  const {call}=await fixture(t),legacyCode='return 42;',steps=[{id:'one',tool:'revit_list_levels',arguments:{}}];
  const cases=[
    [{...base,code:legacyCode},{schema_version:1,...base,code:legacyCode}],
    [{...base,code,parameters},{schema_version:2,...base,code,parameters}],
    [{...base,parameters:{},steps},{schema_version:3,...base,parameters:{},steps}],
  ];
  for(const [args,canonical] of cases){
    const saved=await call('revit_save_command',args);assert.equal(saved.revision,sha(canonical));assert.equal(saved.schema_version,canonical.schema_version);assert.equal(Object.hasOwn(saved,'parameter_labels'),false);
    const read=await call('revit_get_command',getArgs(saved));assert.equal(read.revision,saved.revision);assert.equal(Object.hasOwn(read,'parameter_labels'),false);
  }
});
