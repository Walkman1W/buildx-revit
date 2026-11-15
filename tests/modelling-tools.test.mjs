import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {compileScriptRunnerOffline} from '../test-support/script-compiler-offline.mjs';
import {MODELLING_TOOLS,MODELLING_TEMPLATE_VERSION,isModellingTool,compileModellingTool} from '../lib/modelling-tools.mjs';
import {validateTool} from '../lib/workbench-client.mjs';

const common={expected_document:'D:\\sample.rvt'};
const cases={
  revit_rotate_elements:{...common,element_ids:[123,456],axis_origin_mm:{x:-100.5,y:20,z:0},angle_degrees:90},
  revit_place_family_instance:{...common,symbol_id:123,level_id:456,point_mm:{x:1000,y:2000,z:3250}},
  revit_place_door:{...common,symbol_id:123,wall_id:789,level_id:456,point_mm:{x:1000,y:2000,z:3000}},
  revit_create_floor:{...common,floor_type_id:123,level_id:456,origin_mm:{x:1000,y:2000,z:3150},width_mm:2000,depth_mm:3000,offset_mm:150}
};

test('named modelling contracts use rollback by default and require exact document identity',()=>{
  assert.equal(MODELLING_TEMPLATE_VERSION,1);
  assert.deepEqual(MODELLING_TOOLS.map(t=>t.name),Object.keys(cases));
  for(const tool of MODELLING_TOOLS){
    assert.equal(isModellingTool(tool.name),true);
    assert.equal(tool.inputSchema.additionalProperties,false);
    assert.equal(tool.inputSchema.properties.mode.default,'rollback');
    assert.ok(tool.inputSchema.required.includes('expected_document'));
    const validated=validateTool(tool.name,cases[tool.name]);
    assert.equal(validated.operation,'execute_csharp');
    assert.equal(validated.args.mode,'rollback');
    assert.equal(validated.args.expected_document,common.expected_document);
    assert.equal(validated.args.code,compileModellingTool(tool.name,cases[tool.name]));
    assert.equal(validated.logical_tool,tool.name);
    assert.equal(validated.template_version,MODELLING_TEMPLATE_VERSION);
  }
  assert.equal(isModellingTool('revit_unknown'),false);
});

test('hosted door contracts require exact symbol/host/level identities and unitless finite horizontal facing',()=>{
  const base=cases.revit_place_door;
  for(const key of ['symbol_id','wall_id','level_id']){
    const missing={...base};delete missing[key];assert.throws(()=>validateTool('revit_place_door',missing));
    for(const value of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'123'])assert.throws(()=>validateTool('revit_place_door',{...base,[key]:value}));
  }
  for(const point of [{x:0,y:0},{x:0,y:0,z:Infinity},{x:0,y:0,z:0,w:1}])assert.throws(()=>validateTool('revit_place_door',{...base,point_mm:point}));
  for(const value of [null,{},[],{x:0,y:0,z:0},{x:0,y:0,z:1},{x:1,y:0,z:0.01},{x:0,y:NaN,z:0},{x:0,y:Infinity,z:0},{x:1,y:0,z:0,unit:'mm'}])assert.throws(()=>validateTool('revit_place_door',{...base,facing_direction:value}));
  const unit={x:0,y:-1,z:0},scaled={x:0,y:-1e308,z:0},small={x:0,y:-1e-308,z:0};
  const canonical=validateTool('revit_place_door',{...base,facing_direction:unit});
  assert.equal(canonical.args.mode,'rollback');
  for(const facing of [scaled,small])assert.equal(validateTool('revit_place_door',{...base,facing_direction:facing}).args.code,canonical.args.code);
});

test('modelling contract rejects unsafe IDs, duplicate targets, malformed coordinates and code arguments',()=>{
  const rotate=cases.revit_rotate_elements;
  for(const ids of [[],[1,1],Array.from({length:51},(_,i)=>i+1),[0],[-1],[1.5],[Number.MAX_SAFE_INTEGER+1]]){
    assert.throws(()=>validateTool('revit_rotate_elements',{...rotate,element_ids:ids}));
  }
  for(const value of [NaN,Infinity,-Infinity,'0; throw new Exception();']){
    assert.throws(()=>validateTool('revit_rotate_elements',{...rotate,angle_degrees:value}));
    assert.throws(()=>compileModellingTool('revit_rotate_elements',{...rotate,angle_degrees:value}));
    assert.throws(()=>validateTool('revit_place_family_instance',{...cases.revit_place_family_instance,point_mm:{x:value,y:0,z:0}}));
  }
  for(const tool of MODELLING_TOOLS){
    assert.throws(()=>validateTool(tool.name,{...cases[tool.name],expected_document:''}));
    assert.throws(()=>validateTool(tool.name,{...cases[tool.name],code:'return null;'}));
    assert.throws(()=>validateTool(tool.name,{...cases[tool.name],mode:'save'}));
  }
  assert.throws(()=>validateTool('revit_rotate_elements',{...rotate,axis_origin_mm:{x:0,y:0}}));
  assert.throws(()=>validateTool('revit_rotate_elements',{...rotate,axis_origin_mm:{x:0,y:0,z:0,w:1}}));
  for(const dimension of [0,-1,NaN,Infinity])assert.throws(()=>validateTool('revit_create_floor',{...cases.revit_create_floor,width_mm:dimension}));
  assert.throws(()=>validateTool('revit_create_floor',{...cases.revit_create_floor,width_mm:1e308,depth_mm:1e308}));
});

test('commit is explicit and template numeric formatting accepts exponents without accepting source text',()=>{
  for(const [name,args] of Object.entries(cases)){
    const validated=validateTool(name,{...args,mode:'commit'});
    assert.equal(validated.args.mode,'commit');
    assert.ok(Buffer.byteLength(validated.args.code,'utf8')<64000);
  }
  const code=compileModellingTool('revit_rotate_elements',{...cases.revit_rotate_elements,element_ids:[Number.MAX_SAFE_INTEGER],axis_origin_mm:{x:1e-10,y:-0,z:-1e20},angle_degrees:1e100});
  assert.ok(code.includes('9007199254740991L'));
  assert.ok(code.includes('1e-10d'));
  assert.ok(!code.includes('-0d'));
  assert.throws(()=>compileModellingTool('unknown',{}));
  assert.throws(()=>compileModellingTool('revit_rotate_elements',{...cases.revit_rotate_elements,element_ids:['123L); throw new Exception();']}));
});

test('all modelling templates compile through production ScriptRunner preparation against explicitly selected Revit 2024 references (no Revit execution)',{
  skip:process.env.BUILDX_COMPILE_MODELLING!=='1'?'Optional compiler acceptance was not selected.':!(process.env.BUILDX_SCRIPT_COMPILER&&process.env.BUILDX_REVIT_API_DIR)?'Select BUILDX_SCRIPT_COMPILER and BUILDX_REVIT_API_DIR; no private fallback is used.':false
},async t=>{
  const outputDirectory=process.env.BUILDX_MODELLING_COMPILER_OUTPUT||path.join(await fs.mkdtemp(path.join(os.tmpdir(),'buildx-modelling-offline-')),'evidence');
  const summary=await compileScriptRunnerOffline({compilerExecutable:process.env.BUILDX_SCRIPT_COMPILER,revitDirectory:process.env.BUILDX_REVIT_API_DIR,outputDirectory});
  t.diagnostic('Offline modelling evidence: '+path.join(outputDirectory,'summary.json'));
  assert.equal(summary.passed,true,JSON.stringify(summary.entries.map(entry=>({name:entry.name,variant:entry.variant,exitCode:entry.exitCode}))));
  assert.equal(summary.generatedAssembliesLoaded,false);assert.equal(summary.executedInRevit,false);assert.equal(summary.modelModified,false);
});
