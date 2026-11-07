import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {WORKBENCH_TOOLS,validateTool,invokeWorkbench} from './lib/workbench-client.mjs';
import {ALL_PANEL_TOOLS,CodexClient} from './lib/codex-client.mjs';
import {MODELLING_TOOLS,MODELLING_TEMPLATE_VERSION,compileModellingTool} from './lib/modelling-tools.mjs';
import {invokeCommand} from './lib/command-store.mjs';
import {FAMILY_PANEL_CONFIRMATION_ONLY} from './lib/family-tools.mjs';
import {NATIVE_PARAMETER_WRITE_NAMES} from './lib/native-parameter-writes.mjs';
import {isNativeTypeParameterWrite} from './lib/native-type-parameter-writes.mjs';
import {isAecPilotQuery,isAecDrawingQuery,MODEL_PREPARATION_QUERY_NAME,PIPE_NETWORK_QUERY_NAME} from './lib/native-model-queries.mjs';
import {LEGACY_PANEL_TOOL_NAMES} from './lib/panel-tools.mjs';

test('mutating contracts validate ids, mode and UTF8 bounds',()=>{
  assert.equal(new Set(WORKBENCH_TOOLS.map(tool=>tool.name)).size,WORKBENCH_TOOLS.length);
  assert.equal(validateTool('revit_execute_csharp',{expected_document:'sample.rvt',code:'return 1;'}).args.mode,'rollback');
  assert.throws(()=>validateTool('revit_smart_annotate',{expected_document:'a',element_ids:[-1],view_id:2,tag_type_id:3}));
  assert.throws(()=>validateTool('revit_execute_csharp',{expected_document:'a',code:'x',mode:'automatic'}));
  assert.throws(()=>validateTool('revit_execute_csharp',{expected_document:'a',code:'测'.repeat(22000)}));
  assert.throws(()=>validateTool('revit_workbench_status',{code:'not allowed'}));
});
test('legacy MCP lists its complete tool catalog and connection status derives its count',()=>{
  const request=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'});
  const probe=spawnSync(process.execPath,[fileURLToPath(new URL('./workbench-mcp.mjs',import.meta.url))],{input:request+'\n',encoding:'utf8',windowsHide:true,timeout:5000});
  assert.equal(probe.status,0,probe.stderr);
  const tools=JSON.parse(probe.stdout.trim()).result.tools;
  assert.equal(new Set(tools.map(tool=>tool.name)).size,tools.length);
  assert.equal(new Set(ALL_PANEL_TOOLS).size,ALL_PANEL_TOOLS.length);
  const scopedNativeWrites=['revit_create_material','revit_create_level','revit_create_grid','revit_pin_element','revit_unpin_element','revit_create_floor_plan_view','revit_create_3d_view','revit_create_section_view','revit_create_schedule','revit_create_conduit','revit_create_duct','revit_create_sheet','revit_place_viewport_on_sheet','revit_apply_view_template','revit_create_text_note','revit_place_window'];
  for(const tool of WORKBENCH_TOOLS){
    const advertised=tools.find(value=>value.name===tool.name);
    const excluded=FAMILY_PANEL_CONFIRMATION_ONLY.includes(tool.name)||NATIVE_PARAMETER_WRITE_NAMES.includes(tool.name)||
      isNativeTypeParameterWrite(tool.name)||isAecPilotQuery(tool.name)||isAecDrawingQuery(tool.name)||scopedNativeWrites.includes(tool.name)||
      tool.name===MODEL_PREPARATION_QUERY_NAME||tool.name===PIPE_NETWORK_QUERY_NAME;
    if(excluded)assert.equal(advertised,undefined);
    else assert.deepEqual(advertised,tool);
  }
  for(const tool of MODELLING_TOOLS)assert.deepEqual(tools.find(t=>t.name===tool.name),tool);
  for(const name of ['revit_get_selection','revit_search_elements','revit_list_levels','revit_list_family_types','revit_describe_parameters','revit_set_parameters','revit_move_elements','revit_copy_elements','revit_create_wall','revit_create_pipe'])assert.ok(tools.some(tool=>tool.name===name));
  const client=new CodexClient('unused');client.initialized=client.authReady=client.toolsReady=true;
  assert.equal(client.state.toolCount,LEGACY_PANEL_TOOL_NAMES.length);
  assert.ok(client.state.message.includes(String(LEGACY_PANEL_TOOL_NAMES.length)));
});
test('real MCP entry preserves its error text and reports an unverified operation outcome conservatively',()=>{
  const request=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'not_a_registered_tool',arguments:{}}});
  const probe=spawnSync(process.execPath,[fileURLToPath(new URL('./workbench-mcp.mjs',import.meta.url))],{input:request+'\n',encoding:'utf8',windowsHide:true,timeout:5000});
  assert.equal(probe.status,0,probe.stderr);const result=JSON.parse(probe.stdout.trim()).result;
  assert.equal(result.isError,true);assert.equal(typeof result.content[0].text,'string');assert.ok(result.content[0].text.length);
  assert.deepEqual(result.structuredContent,{buildxToolOutcome:{schemaVersion:1,outcome:'unconfirmed'}});
});

test('script-backed modelling keeps document, rollback and exact source through queue and reusable command evidence',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-modelling-queue-'));
  await fs.mkdir(path.join(root,'queue','outbox'),{recursive:true});
  await fs.mkdir(path.join(root,'queue','processing'),{recursive:true});
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:'d'.repeat(32),pid:process.pid,version:'0.3.0'}));
  const args={expected_document:'sample.rvt',element_ids:[12],axis_origin_mm:{x:0,y:0,z:0},angle_degrees:30};
  const normalized=validateTool('revit_rotate_elements',args);
  assert.equal(normalized.args.mode,'rollback');
  assert.equal(normalized.operation,'execute_csharp');
  assert.equal(normalized.args.code,compileModellingTool('revit_rotate_elements',{...args,mode:'rollback'}));
  const waiting=invokeWorkbench('revit_rotate_elements',args,{root,timeout:5000});
  let files=[];
  for(let i=0;i<50&&!files.length;i++){
    await new Promise(r=>setTimeout(r,20));
    files=await fs.readdir(path.join(root,'queue','inbox')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    files=files.filter(f=>f.endsWith('.json'));
  }
  assert.equal(files.length,1);
  const filename=files[0];
  const request=JSON.parse(await fs.readFile(path.join(root,'queue','inbox',filename),'utf8'));
  assert.equal(request.operation,'execute_csharp');
  assert.equal(request.logical_tool,'revit_rotate_elements');
  assert.equal(request.template_version,MODELLING_TEMPLATE_VERSION);
  assert.equal(request.targetSession,'d'.repeat(32));
  assert.deepEqual(request.args,normalized.args);
  // A simulated host result verifies protocol/storage only, never Revit geometry.
  await fs.rename(path.join(root,'queue','inbox',filename),path.join(root,'queue','processing',filename));
  await fs.writeFile(path.join(root,'queue','outbox',filename),JSON.stringify({id:request.id,ok:true,completedUtc:new Date().toISOString(),result:{operation:'execute_csharp',mode:'rollback',committed:false,value:{simulated:true}}}));
  const result=await waiting;
  assert.equal(result.operation,'execute_csharp');
  assert.equal(result.logical_tool,'revit_rotate_elements');
  assert.equal(result.committed,false);
  assert.equal(result.mode,'rollback');
  const saved=await invokeCommand('revit_save_command',{command_id:'rotation-test',name:'Rotation test',description:'Simulated queue evidence test only',code:normalized.args.code,source_request_id:request.id},{root});
  assert.ok(saved);
});

test('script-backed modelling rejects invalid input before enqueuing',async()=>{
  const args={expected_document:'sample.rvt',element_ids:[12],axis_origin_mm:{x:0,y:0,z:0},angle_degrees:30};
  for(const patch of [{element_ids:[12,12]},{element_ids:[Number.MAX_SAFE_INTEGER+1]},{angle_degrees:Infinity},{axis_origin_mm:{x:0,y:0,z:'0);doc.Delete(null);'}},{mode:'preview'},{expected_document:''},{code:'return 1;'}]){
    assert.throws(()=>validateTool('revit_rotate_elements',{...args,...patch}));
  }
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-modelling-old-host-'));
  await fs.mkdir(path.join(root,'queue'),{recursive:true});
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:'e'.repeat(32),pid:process.pid,version:'0.2.0'}));
  await assert.rejects(invokeWorkbench('revit_rotate_elements',args,{root,timeout:100}),/未入队/);
  await assert.rejects(fs.stat(path.join(root,'queue','inbox')),e=>e.code==='ENOENT');
});
test('read queries bind unsaved documents and normalize pagination without a write mode',()=>{
  for(const name of ['revit_get_selection','revit_search_elements','revit_list_levels','revit_list_family_types','revit_describe_parameters']){
    const input={expected_document:'',...(name==='revit_describe_parameters'?{element_id:12}:{})};
    const normalized=validateTool(name,input);
    assert.equal(normalized.args.expected_document,'');
    assert.ok(!Object.hasOwn(normalized.args,'mode'));
    assert.throws(()=>validateTool(name,{...input,mode:'rollback'}),/Unknown argument/);
    assert.throws(()=>validateTool(name,{}),/Missing argument/);
  }
  assert.deepEqual(validateTool('revit_search_elements',{expected_document:'',category:''}).args,{expected_document:'',category:'',limit:50,offset:0});
  for(const limit of [0,201,1.5,NaN,Infinity])assert.throws(()=>validateTool('revit_list_family_types',{expected_document:'a',limit}));
  assert.throws(()=>validateTool('revit_search_elements',{expected_document:'a',offset:-1}));
  assert.throws(()=>validateTool('revit_search_elements',{expected_document:'a',offset:2147483648}));
  assert.throws(()=>validateTool('revit_describe_parameters',{expected_document:'a',element_id:-10}));
});
test('parameter writes accept real negative built-in IDs and reject invalid nested values',()=>{
  const base={expected_document:'sample.rvt',changes:[{element_id:123,parameter_id:-1001203,value:3.5,value_unit:'internal'}]};
  const normalized=validateTool('revit_set_parameters',base);
  assert.equal(normalized.operation,'set_parameters');
  assert.equal(normalized.args.mode,'rollback');
  assert.equal(normalized.args.changes[0].parameter_id,-1001203);
  for(const value of ['Description',42])assert.doesNotThrow(()=>validateTool('revit_set_parameters',{...base,changes:[{element_id:123,parameter_id:87,value}]}));
  for(const parameter_id of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateTool('revit_set_parameters',{...base,changes:[{...base.changes[0],parameter_id}]}),/parameter_id/);
  for(const value of [NaN,Infinity,-Infinity,null,true,{}])assert.throws(()=>validateTool('revit_set_parameters',{...base,changes:[{...base.changes[0],value}]}),/value/);
  assert.throws(()=>validateTool('revit_set_parameters',{...base,changes:[{...base.changes[0],value_unit:'mm'}]}),/value_unit/);
  assert.throws(()=>validateTool('revit_set_parameters',{...base,changes:[{...base.changes[0],unexpected:1}]}),/Unknown argument/);
  assert.throws(()=>validateTool('revit_set_parameters',{...base,changes:[]}),/changes/);
  assert.throws(()=>validateTool('revit_set_parameters',{...base,changes:Array(51).fill(base.changes[0])}),/changes/);
});
test('modelling validates finite coordinates, nested fields and positive dimensions',()=>{
  const point={x:0,y:1000,z:3000};
  for(const name of ['revit_move_elements','revit_copy_elements']){
    const base={expected_document:'sample.rvt',element_ids:[1,2],delta_mm:point};
    assert.equal(validateTool(name,base).args.mode,'rollback');
    assert.equal(validateTool(name,{...base,mode:'commit'}).args.mode,'commit');
    for(const x of [NaN,Infinity,'1000'])assert.throws(()=>validateTool(name,{...base,delta_mm:{...point,x}}),/delta_mm.x/);
    assert.throws(()=>validateTool(name,{...base,delta_mm:{x:1,y:2}}),/delta_mm.z/);
    assert.throws(()=>validateTool(name,{...base,delta_mm:{...point,unit:'mm'}}),/Unknown argument/);
    assert.throws(()=>validateTool(name,{...base,element_ids:[0]}));
    assert.throws(()=>validateTool(name,{...base,element_ids:new Array(1)}));
    assert.throws(()=>validateTool(name,{...base,expected_document:''}));
  }
  const wall={expected_document:'sample.rvt',wall_type_id:1,level_id:2,start_mm:{x:0,y:0,z:3000},end_mm:point,height_mm:2800};
  const normalized=validateTool('revit_create_wall',wall).args;
  assert.equal(normalized.offset_mm,0);assert.equal(normalized.structural,false);
  assert.throws(()=>validateTool('revit_create_wall',{...wall,height_mm:0}));
  assert.throws(()=>validateTool('revit_create_wall',{...wall,structural:'false'}));
  const pipe={expected_document:'sample.rvt',pipe_type_id:1,system_type_id:2,level_id:3,start_mm:{x:0,y:0,z:3000},end_mm:point,diameter_mm:100};
  assert.equal(validateTool('revit_create_pipe',pipe).operation,'create_pipe');
  assert.throws(()=>validateTool('revit_create_pipe',{...pipe,diameter_mm:-1}));
  assert.throws(()=>validateTool('revit_create_pipe',{...pipe,end_mm:{...point,z:Infinity}}));
});
test('new tools reject an outdated host before a request is queued',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-workbench-version-test-'));
  await fs.mkdir(path.join(root,'queue'),{recursive:true});
  for(const version of ['0.2.0',undefined,'unknown']){
    await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:'b'.repeat(32),pid:process.pid,version}));
    await assert.rejects(invokeWorkbench('revit_get_selection',{expected_document:''},{root,timeout:200}),/0\.3\.0.*未入队/);
    await assert.rejects(fs.stat(path.join(root,'queue','inbox')),error=>error.code==='ENOENT');
  }
});
test('updated host receives a document-bound read query with defaults and no write mode',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-workbench-read-test-'));
  await fs.mkdir(path.join(root,'queue','outbox'),{recursive:true});
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:'c'.repeat(32),pid:process.pid,version:'0.3.0'}));
  const waiting=invokeWorkbench('revit_search_elements',{expected_document:'',category:'OST_Walls'},{root,timeout:2000});
  let files=[];
  for(let i=0;i<30&&!files.length;i++){await new Promise(r=>setTimeout(r,20));files=(await fs.readdir(path.join(root,'queue','inbox'))).filter(f=>f.endsWith('.json'));}
  assert.equal(files.length,1);
  const request=JSON.parse(await fs.readFile(path.join(root,'queue','inbox',files[0]),'utf8'));
  assert.equal(request.operation,'search_elements');
  assert.deepEqual(request.args,{expected_document:'',category:'OST_Walls',limit:50,offset:0});
  await fs.writeFile(path.join(root,'queue','outbox',files[0]),JSON.stringify({id:request.id,ok:true,result:{operation:request.operation,hostSession:'c'.repeat(32),document:{path:''},value:{items:[],total:0}}}));
  const result=await waiting;
  assert.deepEqual(result.value,{items:[],total:0});
});
test('queue preserves request and target identity; errors are not successes',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-workbench-test-'));
  await fs.mkdir(path.join(root,'queue','outbox'),{recursive:true});
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:'a'.repeat(32),pid:process.pid}));
  const waiting=invokeWorkbench('revit_workbench_status',{}, {root,timeout:2000});
  let files=[];
  for(let i=0;i<30&&!files.length;i++){await new Promise(r=>setTimeout(r,20));files=(await fs.readdir(path.join(root,'queue','inbox'))).filter(f=>f.endsWith('.json'));}
  assert.equal(files.length,1);
  const request=JSON.parse(await fs.readFile(path.join(root,'queue','inbox',files[0]),'utf8'));
  assert.equal(request.targetSession,'a'.repeat(32));assert.equal(request.operation,'status');
  assert.ok(Date.parse(request.expiresUtc)>Date.parse(request.createdUtc));
  await fs.writeFile(path.join(root,'queue','outbox',files[0]),JSON.stringify({id:request.id,ok:true,result:{hostSession:'a'.repeat(32),document:null}}));
  const result=await waiting;assert.equal(result.request_id,request.id);assert.equal(result.document,null);
  await assert.rejects(invokeWorkbench('revit_workbench_status',{}, {root,timeout:40}),/outcome unknown.*Do not retry/s);
});
