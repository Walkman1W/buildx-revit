import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {MODELLING_TOOLS,MODELLING_TEMPLATE_VERSION,isModellingTool,compileModellingTool} from './lib/modelling-tools.mjs';
import {validateTool} from './lib/workbench-client.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
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

test('all modelling templates compile against actual Revit 2024 assemblies (no Revit execution)',{skip:process.env.BUILDX_COMPILE_MODELLING!=='1'},async()=>{
  const compiler=path.resolve(root,'..','_reference','argus-source-reconstruction-20261019','toolchain','roslyn-5.0.0','tasks','net472','csc.exe');
  const apiRoot='D:\\Program Files\\Autodesk\\Revit 2024';
  const framework=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');
  const outputRoot=path.join(root,'workbench','validation','20261104-hosted-door','compile');
  await fs.mkdir(outputRoot,{recursive:true});
  const evidence=[];
  const compileCases=[...Object.entries(cases).map(([name,args])=>({name,args,variant:'default'})),{name:'revit_place_door',args:{...cases.revit_place_door,facing_direction:{x:0,y:-1,z:0}},variant:'facing'}];
  for(const {name,args,variant} of compileCases){
    const folder=path.join(outputRoot,name+'-'+variant);
    await fs.mkdir(folder,{recursive:true});
    const source=path.join(folder,'Script.cs');
    const dll=path.join(folder,'Template.dll');
    const rsp=path.join(folder,'compile.rsp');
    const wrapper='using System; using System.Linq; using System.Collections.Generic; using Autodesk.Revit.DB; using Autodesk.Revit.UI;\npublic static class LocalCodexScript { public static object Run(UIApplication uiapp) { var uidoc=uiapp.ActiveUIDocument; var doc=uidoc.Document; var app=uiapp.Application;\n'+validateTool(name,args).args.code+'\n} }';
    await fs.writeFile(source,wrapper,'utf8');
    const refs=[path.join(framework,'System.dll'),path.join(framework,'System.Core.dll'),path.join(apiRoot,'RevitAPI.dll'),path.join(apiRoot,'RevitAPIUI.dll')];
    const lines=['/nologo','/target:library','/platform:x64','/langversion:14','/optimize+',`/out:"${dll}"`,...refs.map(p=>`/reference:"${p}"`),`"${source}"`];
    await fs.writeFile(rsp,lines.join('\r\n'),'utf8');
    const result=spawnSync(compiler,['/noconfig',`@${rsp}`],{cwd:folder,encoding:'utf8',timeout:30000,windowsHide:true,env:{...process.env,COMPlus_gcServer:'0',COMPlus_GCHeapCount:'2'}});
    const log=(result.stdout||'')+(result.stderr||'')+(result.error?.message||'');
    await fs.writeFile(path.join(folder,'compile.log'),log,'utf8');
    evidence.push({name,variant,templateVersion:MODELLING_TEMPLATE_VERSION,exitCode:result.status,error:result.error?.message||null,source,rsp,dll,compiler,apiRoot,executedInRevit:false});
  }
  await fs.writeFile(path.join(outputRoot,'summary.json'),JSON.stringify({createdUtc:new Date().toISOString(),validation:'offline C# compilation only',executedInRevit:false,templates:evidence},null,2),'utf8');
  for(const entry of evidence)assert.equal(entry.exitCode,0,entry.name+' failed; inspect '+path.join(path.dirname(entry.source),'compile.log'));
});
