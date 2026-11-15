import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FAMILY_TOOLS,FAMILY_OPERATION_BY_TOOL,assertFamilyResult} from '../lib/family-tools.mjs';
import {validateTool,invokeWorkbench,workbenchFailureEvidence} from '../lib/workbench-client.mjs';
import {panelProfile} from '../lib/panel-profile.mjs';
import {MODEL_COMMAND_CATALOG} from '../lib/model-command-catalog.mjs';
import {FAMILY_PANEL_CONFIRMATION_ONLY} from '../lib/family-tools.mjs';

const sample='D:\\code\\REA\\local-codex-panel\\workbench\\samples\\Argus-Codex-Plumbing-Sample.rvt';
const create={expected_document:sample,template_id:'metric-generic-model'};
const cabinet={template_id:'metric-generic-model'};
test('nine named family contracts remain separate from source and script permissions',()=>{
  assert.equal(FAMILY_TOOLS.length,9);assert.equal(new Set(FAMILY_TOOLS.map(t=>t.name)).size,9);
  for(const tool of FAMILY_TOOLS){
    assert.ok(MODEL_COMMAND_CATALOG.some(t=>t.tool===tool.name));
    assert.equal(panelProfile('model').catalog.some(t=>t.name===tool.name),!FAMILY_PANEL_CONFIRMATION_ONLY.includes(tool.name));
    assert.ok(!panelProfile('source-development').catalog.some(t=>t.name===tool.name));
    assert.equal(tool.inputSchema.additionalProperties,false);
  }
  assert.equal(validateTool('revit_family_create_valve',create).operation,'family_create_valve');
  assert.deepEqual(validateTool('revit_family_create_valve',create).args,{...create,length_mm:300,diameter_mm:100});
  assert.deepEqual(validateTool('revit_family_create_cabinet',cabinet),{operation:'family_create_cabinet',args:{...cabinet,width_mm:1200,depth_mm:600,height_mm:2200,thickness_mm:18,shelf_count:3}});
  assert.deepEqual(validateTool('revit_family_save_cabinet',{job_handle:'owned-job'}),{operation:'family_save_cabinet',args:{job_handle:'owned-job'}});
  assert.deepEqual(validateTool('revit_family_close_cabinet',{job_handle:'owned-job'}),{operation:'family_close_cabinet',args:{job_handle:'owned-job'}});
  assert.equal(FAMILY_TOOLS.find(t=>t.name==='revit_family_create_cabinet').annotations.readOnlyHint,false);
  assert.equal(validateTool('revit_family_load_job',{expected_document:sample,job_handle:'owned-job'}).args.mode,'rollback');
});
test('family input rejects wrong sample, path/transaction injection and invalid geometry before queue',()=>{
  for(const expected_document of ['', 'sample.rvt','D:\\project1.rvt','\\\\server\\share\\Argus-Codex-Plumbing-Sample.rvt','//server/share/Argus-Codex-Plumbing-Sample.rvt'])
    assert.throws(()=>validateTool('revit_family_create_valve',{...create,expected_document}));
  for(const patch of [{template_id:'metric-mechanical-equipment'},{length_mm:0},{diameter_mm:Infinity},{diameter_mm:501},{length_mm:2001},{code:'return null;'},{mode:'rollback'}])
    assert.throws(()=>validateTool('revit_family_create_valve',{...create,...patch}));
  for(const patch of [{width_mm:299},{width_mm:5001},{depth_mm:149},{height_mm:5001},{thickness_mm:5},{shelf_count:-1},{shelf_count:9},{shelf_count:1.5},{width_mm:Infinity},{code:'return null;'},{mode:'commit'}])
    assert.throws(()=>validateTool('revit_family_create_cabinet',{...cabinet,...patch}));
  assert.throws(()=>validateTool('revit_family_create_cabinet',{...cabinet,expected_document:sample}));
  assert.throws(()=>validateTool('revit_family_save_cabinet',{job_handle:'owned-job',output_path:'D:\\replace.rfa'}));
  assert.throws(()=>validateTool('revit_family_save_job',{expected_document:sample,job_handle:'owned',output_path:'D:\\replace.rfa'}));
  for(const job_handle of ['',' ','old\njob'])assert.throws(()=>validateTool('revit_family_close_job',{job_handle}));
});
test('cabinet requires an explicit host-owned capability before any request is queued',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-cabinet-capability-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'queue'));
  const host={sessionId:'c'.repeat(32),pid:process.pid,version:'0.6.6'};
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify(host));
  await assert.rejects(invokeWorkbench('revit_family_create_cabinet',cabinet,{root,timeout:200}),error=>/未声明柜族能力.*未入队/.test(error.message)&&workbenchFailureEvidence(error).outcome==='not_started');
  await assert.rejects(invokeWorkbench('revit_family_save_cabinet',{job_handle:'owned-job'},{root,timeout:200}),error=>/未声明柜族能力.*未入队/.test(error.message)&&workbenchFailureEvidence(error).outcome==='not_started');
  await assert.rejects(invokeWorkbench('revit_family_close_cabinet',{job_handle:'owned-job'},{root,timeout:200}),error=>/未声明柜族能力.*未入队/.test(error.message)&&workbenchFailureEvidence(error).outcome==='not_started');
  await assert.rejects(fs.stat(path.join(root,'queue','inbox')),e=>e.code==='ENOENT');
  for(const capability of [true,'1',0,2,null]){
    await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({...host,familyCabinetContractVersion:capability}));
    await assert.rejects(invokeWorkbench('revit_family_create_cabinet',cabinet,{root,timeout:200}),/未声明柜族能力.*未入队/);
    await assert.rejects(fs.stat(path.join(root,'queue','inbox')),e=>e.code==='ENOENT');
  }
});
test('cabinet queues the named operation and preserves an unknown owned job receipt',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-cabinet-queue-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const folder of ['inbox','processing','outbox'])await fs.mkdir(path.join(root,'queue',folder),{recursive:true});
  const host={sessionId:'d'.repeat(32),pid:process.pid,version:'0.6.6',familyCabinetContractVersion:1};
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify(host));
  const pending=invokeWorkbench('revit_family_create_cabinet',cabinet,{root,timeout:2000,retainReceiptOwner:true});
  let files=[];
  for(let n=0;n<30&&!files.length;n++){await new Promise(r=>setTimeout(r,15));try{files=(await fs.readdir(path.join(root,'queue','inbox'))).filter(n=>n.endsWith('.json'));}catch{}}
  assert.equal(files.length,1);
  const request=JSON.parse(await fs.readFile(path.join(root,'queue','inbox',files[0]),'utf8'));
  assert.equal(request.operation,'family_create_cabinet');assert.equal(request.targetSession,host.sessionId);
  assert.deepEqual(request.args,{...cabinet,width_mm:1200,depth_mm:600,height_mm:2200,thickness_mm:18,shelf_count:3});
  await fs.writeFile(path.join(root,'queue','outbox',files[0]),JSON.stringify({id:request.id,ok:true,completedUtc:new Date().toISOString(),result:{operation:'family_create_cabinet',hostSession:host.sessionId,value:{operation:'family_create_cabinet',host_session:host.sessionId,revit_pid:host.pid,code:'FAMILY_OUTCOME_UNKNOWN',cleanup_pending:false,success:false,outcome:'unknown',job_handle:'retained-cabinet'}}}));
  const result=await pending;assert.equal(result.value.success,false);assert.equal(result.value.outcome,'unknown');assert.equal(result.value.job_handle,'retained-cabinet');
});
test('family operations on 0.5 host fail before inbox creation',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-family-old-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'queue'));await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:'a'.repeat(32),pid:process.pid,version:'0.5.0'}));
  await assert.rejects(invokeWorkbench('revit_family_create_valve',create,{root,timeout:200}),/0\.6\.0.*未入队/);
  await assert.rejects(fs.stat(path.join(root,'queue','inbox')),e=>e.code==='ENOENT');
});
test('family queue keeps operation and exact session; business failure is preserved',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-family-queue-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'queue','outbox'),{recursive:true});
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:'b'.repeat(32),pid:process.pid,version:'0.6.0'}));
  const pending=invokeWorkbench('revit_family_create_valve',create,{root,timeout:2000});
  let files=[];
  for(let n=0;n<30&&!files.length;n++){await new Promise(r=>setTimeout(r,15));try{files=(await fs.readdir(path.join(root,'queue','inbox'))).filter(n=>n.endsWith('.json'));}catch{}}
  assert.equal(files.length,1);
  const request=JSON.parse(await fs.readFile(path.join(root,'queue','inbox',files[0]),'utf8'));
  assert.equal(request.operation,'family_create_valve');assert.equal(request.targetSession,'b'.repeat(32));assert.ok(!('code'in request.args));
  await fs.writeFile(path.join(root,'queue','outbox',files[0]),JSON.stringify({id:request.id,ok:true,result:{operation:'family_create_valve',hostSession:request.targetSession,value:{success:false,outcome:'unknown',job_handle:'retained-job'}}}));
  const result=await pending;assert.equal(result.value.success,false);assert.equal(result.value.job_handle,'retained-job');
});
test('family result rejects a foreign session or operation instead of reporting success',()=>{
  const name='revit_family_save_job';
  assert.throws(()=>assertFamilyResult(name,{operation:'family_load_job',hostSession:'mine',value:{}},'mine'),/unknown/);
  assert.throws(()=>assertFamilyResult(name,{operation:FAMILY_OPERATION_BY_TOOL[name],hostSession:'old',value:{}},'mine'),/unknown/);
});
