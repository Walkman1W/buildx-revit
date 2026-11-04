import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateTool,invokeWorkbench,WORKBENCH_TOOLS} from './lib/workbench-client.mjs';
import {ALL_PANEL_TOOLS} from './lib/panel-tools.mjs';
const document='D:\\validation\\sample.rvt';
const drawing=()=>({schemaVersion:1,documentPath:document,documentFingerprint:'doc-uid',rootElementId:1,rootUniqueId:'uid-1',nodes:[{key:'1',uniqueId:'uid-1',label:'Pipe',category:'Pipes',elementId:1,x:0,y:0},{key:'2',uniqueId:'uid-2',label:'Valve',category:'Fittings',elementId:2,x:1500,y:0}],edges:[{source:'1',target:'2'}],warnings:[]});
const args=()=>({expected_document:document,drawing:drawing()});

test('native tools have distinct names, operation mappings, bounded schemas and rollback default',()=>{
  assert.equal(new Set(ALL_PANEL_TOOLS).size,ALL_PANEL_TOOLS.length);
  const preview=validateTool('revit_preview_schematic',{expected_document:document,start_element_id:1});
  assert.equal(preview.operation,'preview_schematic');assert.ok(!Object.hasOwn(preview.args,'mode'));
  const exported=validateTool('revit_export_schematic',args());
  assert.equal(exported.operation,'export_schematic');assert.equal(exported.args.mode,'rollback');
  assert.deepEqual(exported.args.drawing,drawing());
  assert.equal(validateTool('revit_export_schematic',{...args(),mode:'commit'}).args.mode,'commit');
});
test('native schemas reject missing fields, unsafe numbers and unsupported nested data',()=>{
  for(const field of ['schemaVersion','documentPath','documentFingerprint','rootElementId','rootUniqueId','nodes','edges','warnings']){
    const input=args();delete input.drawing[field];assert.throws(()=>validateTool('revit_export_schematic',input));
  }
  for(const change of [d=>delete d.nodes[0].x,d=>d.nodes[0].x=Infinity,d=>d.nodes[0].y=1000001,d=>d.nodes[0].elementId=Number.MAX_SAFE_INTEGER+1,d=>d.nodes[0].label='x'.repeat(301),d=>d.nodes[0].category=null,d=>d.edges[0].extra=true,d=>d.schemaVersion=2,d=>d.nodes=[],d=>d.nodes=Array(301).fill(d.nodes[0]),d=>d.edges=Array(801).fill(d.edges[0]),d=>d.warnings=Array(101).fill('warning')]){
    const input=args();change(input.drawing);assert.throws(()=>validateTool('revit_export_schematic',input));
  }
  assert.throws(()=>validateTool('revit_preview_schematic',{expected_document:'',start_element_id:1}));
  assert.throws(()=>validateTool('revit_preview_schematic',{expected_document:document,start_element_id:1,mode:'rollback'}));
  assert.throws(()=>validateTool('revit_export_schematic',{...args(),expected_document:'D:\\other.rvt'}));
  assert.throws(()=>validateTool('revit_preview_schematic',{expected_document:'sample.rvt',start_element_id:1}));
});
async function temporaryHost(version){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-native-mcp-'));
  await fs.mkdir(path.join(root,'queue','outbox'),{recursive:true});
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:'a'.repeat(32),pid:process.pid,version}));
  return root;
}
async function requestAt(root){
  for(let i=0;i<100;i++){
    const files=await fs.readdir(path.join(root,'queue','inbox')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    const filename=files.find(f=>f.endsWith('.json'));
    if(filename)return {filename,request:JSON.parse(await fs.readFile(path.join(root,'queue','inbox',filename),'utf8'))};
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('No test request published');
}
test('old or malformed host is rejected before either native operation is queued',async()=>{
  for(const version of ['0.3.0','0.2.0',undefined,'unknown']){
    const root=await temporaryHost(version);
    for(const [name,input] of [['revit_preview_schematic',{expected_document:document,start_element_id:1}],['revit_export_schematic',args()]])
      await assert.rejects(invokeWorkbench(name,input,{root,timeout:50}),/0\.4\.0.*未入队/);
    await assert.rejects(fs.stat(path.join(root,'queue','inbox')),error=>error.code==='ENOENT');
  }
});
test('native DTO UTF8 request size is bounded before creating an inbox',async()=>{
  const root=await temporaryHost('0.4.0'),input=args();
  input.drawing.nodes=Array.from({length:300},(_,i)=>({key:String(i+1),uniqueId:'u'.repeat(512),label:'测'.repeat(300),category:'c'.repeat(300),elementId:i+1,x:i,y:0}));
  await assert.rejects(invokeWorkbench('revit_export_schematic',input,{root,timeout:50}),/128 KiB/);
  await assert.rejects(fs.stat(path.join(root,'queue','inbox')),error=>error.code==='ENOENT');
});
test('new host receives an unchanged document-bound preview and returns the DTO',async()=>{
  const root=await temporaryHost('0.4.0');
  const pending=invokeWorkbench('revit_preview_schematic',{expected_document:document,start_element_id:1},{root,timeout:2000});
  const {filename,request}=await requestAt(root);
  assert.equal(request.operation,'preview_schematic');assert.equal(request.targetSession,'a'.repeat(32));
  assert.deepEqual(request.args,{expected_document:document,start_element_id:1});
  await fs.writeFile(path.join(root,'queue','outbox',filename),JSON.stringify({id:request.id,ok:true,result:{operation:'preview_schematic',value:drawing(),modifiedByOperation:false}}));
  assert.deepEqual((await pending).value,drawing());
});
test('export keeps rollback/commit evidence and edited positions without rebuilding identities',async()=>{
  for(const mode of ['rollback','commit']){
    const root=await temporaryHost('0.4.0'),input={...args(),mode};input.drawing.nodes[0].x=250;input.drawing.nodes[0].label='Edited';
    const pending=invokeWorkbench('revit_export_schematic',input,{root,timeout:2000});
    const {filename,request}=await requestAt(root);assert.equal(request.operation,'export_schematic');assert.deepEqual(request.args,input);
    const value={view_id:42,view_name:'BuildX Test',element_ids:Array.from({length:11},(_,i)=>100+i),actual_node_count:2,edge_line_count:1,text_count:2,detail_curve_count:9,symbol_style:'basic-native-symbols',layout_note:'layout_bfs_not_engineering_analysis'};
    await fs.writeFile(path.join(root,'queue','outbox',filename),JSON.stringify({id:request.id,ok:true,result:{operation:'export_schematic',mode,committed:mode==='commit',value}}));
    const result=await pending;assert.equal(result.mode,mode);assert.equal(result.committed,mode==='commit');assert.deepEqual(result.value,value);
  }
});
test('a malformed native completion is an unknown outcome and never a success',async()=>{
  const root=await temporaryHost('0.4.0');
  const pending=invokeWorkbench('revit_export_schematic',args(),{root,timeout:2000});
  const rejection=assert.rejects(pending,/outcome unknown.*Do not retry/s);
  const {filename,request}=await requestAt(root);
  await fs.writeFile(path.join(root,'queue','outbox',filename),JSON.stringify({id:request.id,ok:true,result:{operation:'export_schematic',mode:'commit',committed:true,value:{view_id:1}}}));
  await rejection;
});

test('native response identity and boolean completion flag fail closed even with a valid value',async()=>{
  for(const patch of [{id:'another-request'},{ok:'true'},{ok:undefined}]){
    const root=await temporaryHost('0.4.0');
    const pending=invokeWorkbench('revit_preview_schematic',{expected_document:document,start_element_id:1},{root,timeout:2000});
    const rejection=assert.rejects(pending,/outcome unknown.*Do not retry/s);
    const {filename,request}=await requestAt(root);
    await fs.writeFile(path.join(root,'queue','outbox',filename),JSON.stringify({id:request.id,ok:true,result:{operation:'preview_schematic',value:drawing(),modifiedByOperation:false},...patch}));
    await rejection;
  }
});
