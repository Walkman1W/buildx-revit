import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Ajv from 'ajv';
import {fileURLToPath} from 'node:url';
import {MODEL_COMMAND_CATALOG,MODEL_WORKSPACE_TOOL_NAMES,modelCommandById} from './lib/model-command-catalog.mjs';
import {PANEL_WORKBENCH_TOOLS,PANEL_CONFIRMED_ONLY_TOOLS,READ_TOOLS,MODEL_WORKSPACE_TOOLS,MODEL_AI_READ_TOOLS,MODEL_AI_EFFECT_TOOLS} from './lib/panel-tools.mjs';
import {supportsModelPermissionTool} from './lib/model-operation-effects.mjs';
import {NATIVE_MODEL_QUERY_TOOLS} from './lib/native-model-queries.mjs';
import {NATIVE_PARAMETER_QUERY_TOOLS} from './lib/native-parameter-queries.mjs';
import {ACCESS_FILE_TOOLS} from './lib/access-file-tools.mjs';
import {createModelToolDispatcher,invokeModelCommand} from './lib/model-tool-dispatch.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE,verifyModelWorkspaceCatalog,verifyReadonlyWorkbenchCatalog} from './lib/codex-profile.mjs';
import {panelProfile,MODEL_SERVER_PROFILE} from './lib/panel-profile.mjs';
import {readonlyPanelCommandSchema} from './lib/workbench-client.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const session='f'.repeat(32),document={title:'Registry sample',path:'D:\\samples\\registry.rvt',activeViewId:12,activeViewType:'ThreeD',modified:false};
const status=()=>({hostSession:session,document:{...document},request_id:'11111111-1111-4111-8111-111111111111'});
const catalog=()=>({data:[{name:'revit_workbench',runtimeStatus:'connected',authStatus:'unsupported',resources:[],resourceTemplates:[],toolsError:null,
  tools:Object.fromEntries(MODEL_AI_READ_TOOLS.map(tool=>[tool.name,structuredClone(tool)]))}]});

test('the complete inventory includes the native model and type-parameter contracts exactly once',()=>{
  assert.equal(MODEL_COMMAND_CATALOG.length,PANEL_WORKBENCH_TOOLS.length+PANEL_CONFIRMED_ONLY_TOOLS.length);
  assert.equal(new Set(MODEL_COMMAND_CATALOG.map(item=>item.id)).size,MODEL_COMMAND_CATALOG.length);
  assert.equal(modelCommandById('revit_capture_model_snapshot').readOnly,true);
  assert.equal(modelCommandById('revit_place_door').readOnly,false);
  assert.equal(modelCommandById('revit_family_create_cabinet').readOnly,false);
  assert.equal(modelCommandById('revit_family_save_cabinet').readOnly,false);
  assert.equal(modelCommandById('revit_family_close_cabinet').readOnly,false);
  assert.deepEqual(MODEL_COMMAND_CATALOG.filter(item=>item.enabled&&!PANEL_CONFIRMED_ONLY_TOOLS.some(tool=>tool.name===item.tool)).map(item=>item.tool),MODEL_WORKSPACE_TOOL_NAMES);
  for(const item of MODEL_COMMAND_CATALOG){
    assert.ok(Object.isFrozen(item));assert.equal(typeof item.label,'string');
    if(READ_TOOLS.includes(item.tool)){
      const source=[...NATIVE_MODEL_QUERY_TOOLS,...NATIVE_PARAMETER_QUERY_TOOLS].find(tool=>tool.name===item.tool);assert.equal(item.enabled,true);
      const projected=structuredClone(source.inputSchema);delete projected.properties.expected_document;projected.required=projected.required.filter(key=>key!=='expected_document');
      assert.deepEqual(item.inputSchema,projected);assert.equal(item.unavailableReason,null);continue;
    }
    const source=[...PANEL_WORKBENCH_TOOLS,...PANEL_CONFIRMED_ONLY_TOOLS].find(tool=>tool.name===item.tool);
    assert.equal(item.readOnly,source.annotations.readOnlyHint);
    assert.equal(Object.hasOwn(item.inputSchema.properties,'expected_document'),false);
    assert.ok(!item.inputSchema.required?.includes('expected_document'));
    if(source.inputSchema.properties.mode)assert.equal(item.inputSchema.properties.mode.default,'rollback');
  }
  assert.equal(modelCommandById('document').tool,'revit_workbench_status');
  assert.equal(modelCommandById('search').tool,'revit_search_elements');
});

test('the legacy external query group keeps six tools while the owned workbench advertises type parameters',()=>{
  const profile=createCodexSessionProfile(root,{profile:'model'});
  assert.deepEqual(profile.groups.find(group=>group.name==='revit_local').toolNames,NATIVE_MODEL_QUERY_TOOLS.map(tool=>tool.name));
  assert.ok(profile.groups.find(group=>group.name==='revit_workbench').toolNames.includes('revit_get_type_parameters'));
});

test('the product profile owns one exact local MCP catalog without requiring the optional AEC server',()=>{
  assert.equal(MODEL_SERVER_PROFILE,MODEL_WORKSPACE_SESSION_PROFILE);
  const profile=createCodexSessionProfile(root,{profile:MODEL_SERVER_PROFILE}),composition=panelProfile(MODEL_SERVER_PROFILE);
  assert.deepEqual(profile.toolNames,MODEL_AI_READ_TOOLS.map(tool=>tool.name));assert.equal(profile.supportsTurnAttachments,true);
  assert.deepEqual(profile.dynamicTools.map(item=>item.name),['buildx_project_search','buildx_project_read','buildx_project_table','buildx_materials_list','buildx_materials_read',...ACCESS_FILE_TOOLS.map(item=>item.name),'buildx_model_operation_schema','buildx_model_operation']);
  assert.ok(Buffer.byteLength(JSON.stringify(profile.dynamicTools))<=32768);
  const operation=profile.dynamicTools.at(-1);
  const supported=MODEL_AI_EFFECT_TOOLS.filter(tool=>supportsModelPermissionTool(tool.name));
  assert.ok(supported.some(tool=>tool.name==='revit_create_wall'));
  assert.ok(supported.some(tool=>tool.name==='revit_inspect_elements'));
  assert.deepEqual(operation.inputSchema.properties.tool.enum,supported.map(tool=>tool.name));
  assert.equal(operation.inputSchema.additionalProperties,false);
  for(const definition of supported){const variant=operation.inputSchema.oneOf.find(item=>item.properties.tool.enum[0]===definition.name);assert.deepEqual(variant.properties.parameters,definition.inputSchema);}
  assert.deepEqual(operation.inputSchema.oneOf.map(item=>item.properties.tool.enum[0]),supported.map(item=>item.name));
  const validate=new Ajv({strict:false}).compile(operation.inputSchema);
  assert.equal(validate({tool:'revit_move_elements',parameters:{expected_document:'C:\\fixture.rvt',element_ids:[1],delta_mm:{x:1,y:0,z:0},mode:'rollback'}}),true);
  assert.equal(validate({tool:'revit_move_elements',parameters:{code:'unexpected'}}),false);
  assert.equal(validate({tool:'revit_get_selection',parameters:{}}),false);
  for(const name of ['revit_family_save_job','revit_family_close_job'])assert.equal(validate({tool:name,parameters:{}}),false,name);
  assert.equal(validate({tool:'revit_move_elements',parameters:{expected_document:'C:\\fixture.rvt',element_ids:[1],delta_mm:{x:1,y:0,z:0}},approved:true}),false);
  assert.equal(composition.commands,MODEL_COMMAND_CATALOG);assert.equal(composition.commandReadiness,'local');
  assert.equal(profile.groups.length,1);assert.deepEqual(profile.groups[0].entryArguments,['--workspace']);
  assert.doesNotThrow(()=>profile.buildLaunchArgs([]));
  const args=profile.buildLaunchArgs(['revit_local']);
  assert.ok(args.includes('mcp_servers.revit_local.enabled=false'));
  assert.ok(args.includes('features.shell_tool=false'));assert.ok(args.includes('features.code_mode=true'));
  assert.equal(panelProfile('source-development').commands,undefined);
  assert.equal(panelProfile('model-readonly').commands,undefined);
});

test('the four manual aliases consume their existing parameter owner rather than a divergent MCP projection',async()=>{
  for(const id of ['document','selection','levels','search'])assert.deepEqual(modelCommandById(id).inputSchema,readonlyPanelCommandSchema(id));
  const parameters={keyword:'Pump',category:'equipment',limit:20,offset:0},seen=[];
  const dispatcher=createModelToolDispatcher({invokeReadonlyCommand:async(id,args)=>{seen.push({id,args});return {ok:true,value:{command:id,data:{items:[]}}};}});
  assert.equal((await dispatcher.invokeCommand('search',parameters)).ok,true);
  assert.deepEqual(seen,[{id:'search',args:parameters}]);
  assert.deepEqual(modelCommandById('search').inputSchema.properties.category.enum,['all','walls','pipes','equipment']);
  assert.equal(Object.hasOwn(modelCommandById('search').inputSchema.properties,'name_contains'),false);
});

test('the full profile verifies every named schema and effect without weakening the old four-tool proof',()=>{
  assert.equal(verifyModelWorkspaceCatalog(catalog()).ok,true);
  assert.equal(verifyReadonlyWorkbenchCatalog(catalog()).ok,false);
  for(const mutate of [value=>delete value.data[0].tools.revit_get_selection,
    value=>value.data[0].tools.revit_get_selection.annotations.readOnlyHint=false,
    value=>value.data[0].tools.revit_get_selection.inputSchema.properties.unexpected={type:'string'},
    value=>value.data[0].tools.revit_create_wall=structuredClone(MODEL_WORKSPACE_TOOLS.find(tool=>tool.name==='revit_create_wall')),
    value=>value.data[0].tools.unexpected={name:'unexpected'},
    value=>value.data.push({name:'foreign',runtimeStatus:'connected',authStatus:'unsupported',resources:[],resourceTemplates:[],tools:{}}),
    value=>value.nextCursor='another-page']){
    const value=catalog();mutate(value);assert.equal(verifyModelWorkspaceCatalog(value).ok,false,mutate.toString());
  }
});

test('the workspace MCP entry exposes only the exact read contracts',()=>{
  const request={jsonrpc:'2.0',id:1,method:'tools/list'};
  const child=spawnSync(process.execPath,[path.join(root,'workbench-mcp.mjs'),'--workspace'],{cwd:root,input:JSON.stringify(request)+'\n',encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);
  const reply=JSON.parse(child.stdout.trim());
  assert.deepEqual(reply.result.tools,MODEL_AI_READ_TOOLS);
});

test('every write tool is rejected at the independent workspace MCP entry',()=>{
  const input=MODEL_AI_EFFECT_TOOLS.map((tool,index)=>({jsonrpc:'2.0',id:index+1,method:'tools/call',params:{name:tool.name,arguments:{}}}));
  const child=spawnSync(process.execPath,[path.join(root,'workbench-mcp.mjs'),'--workspace'],{cwd:root,input:input.map(value=>JSON.stringify(value)).join('\n')+'\n',encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(child.status,0,child.stderr);
  const replies=child.stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(replies.length,input.length);
  assert.ok(replies.every(reply=>reply.result?.isError===true&&reply.result.content[0].text==='此会话不提供该工具。'));
});

test('cabinet mutations are absent from every MCP catalog and direct calls are rejected',()=>{
  const names=['revit_family_create_cabinet','revit_family_save_cabinet','revit_family_close_cabinet'];
  for(const args of [[],['--workspace'],['--read-only']]){
    const input=[{jsonrpc:'2.0',id:1,method:'tools/list'},...names.map((name,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params:{name,arguments:{template_id:'metric-generic-model',job_handle:'forged'}}}))];
    const child=spawnSync(process.execPath,[path.join(root,'workbench-mcp.mjs'),...args],{cwd:root,input:input.map(item=>JSON.stringify(item)).join('\n')+'\n',encoding:'utf8',timeout:10000});
    assert.equal(child.status,0,child.stderr);
    const replies=new Map(child.stdout.trim().split('\n').map(line=>JSON.parse(line)).map(item=>[item.id,item]));
    for(const name of names)assert.equal(replies.get(1).result.tools.some(tool=>tool.name===name),false);
    for(const id of [2,3,4])assert.equal(replies.get(id).result.isError,true);
  }
});

test('cabinet mutations require an explicit panel confirmation for the exact request',async()=>{
  const calls=[];
  const dispatcher=createModelToolDispatcher({invokeWorkbench:async(name,args,options)=>{
    calls.push({name,args,confirmed:options.confirmed});
    return {operation:name.replace('revit_',''),hostSession:session,value:{success:true}};
  }});
  const create={template_id:'metric-generic-model',width_mm:1200,depth_mm:600,height_mm:2200,thickness_mm:18,shelf_count:3};
  assert.equal((await dispatcher.invokeCommand('revit_family_create_cabinet',create)).error.code,'COMMAND_CONFIRMATION_REQUIRED');
  await assert.rejects(dispatcher.invokeTool('revit_family_create_cabinet',create),/明确确认/);
  assert.equal((await dispatcher.invokeCommand('revit_family_save_cabinet',{job_handle:'owned-job'})).error.code,'COMMAND_CONFIRMATION_REQUIRED');
  assert.equal((await dispatcher.invokeCommand('revit_family_close_cabinet',{job_handle:'owned-job'})).error.code,'COMMAND_CONFIRMATION_REQUIRED');
  assert.deepEqual(calls,[]);
  assert.equal((await dispatcher.invokeCommand('revit_family_create_cabinet',create,{confirmed:true})).ok,true);
  assert.equal((await dispatcher.invokeCommand('revit_family_save_cabinet',{job_handle:'owned-job'},{confirmed:true})).ok,true);
  assert.equal((await dispatcher.invokeCommand('revit_family_close_cabinet',{job_handle:'owned-job'},{confirmed:true})).ok,true);
  assert.deepEqual(calls,[{name:'revit_family_create_cabinet',args:create,confirmed:true},{name:'revit_family_save_cabinet',args:{job_handle:'owned-job'},confirmed:true},{name:'revit_family_close_cabinet',args:{job_handle:'owned-job'},confirmed:true}]);
});

test('manual and MCP additional queries share the same native result owner',async()=>{
  const calls=[];
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:async(name,args)=>{calls.push({name,args});return {operation:'list_family_types',hostSession:session,document:{...document},request_id:'22222222-2222-4222-8222-222222222222',value:{items:[],total:0}};}});
  const parameters={name_contains:'Sample',limit:10};
  const manual=await dispatcher.invokeCommand('revit_list_family_types',parameters);
  const mcp=await dispatcher.invokeTool('revit_list_family_types',parameters);
  assert.equal(manual.ok,true);assert.deepEqual(manual.value.data,mcp);
  assert.deepEqual(calls,[{name:'revit_list_family_types',args:parameters},{name:'revit_list_family_types',args:parameters}]);
});

test('manual writes require confirmation, bind the current target and preserve the host guard',async()=>{
  const calls=[];
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async(name,args,options)=>{calls.push({name,args,session:options.expectedHostSession});return {operation:'move_elements',hostSession:session,document:{...document},request_id:'33333333-3333-4333-8333-333333333333'};}});
  const args={element_ids:[1],delta_mm:{x:1,y:0,z:0}};
  assert.equal((await dispatcher.invokeCommand('revit_move_elements',args)).error.code,'COMMAND_CONFIRMATION_REQUIRED');
  assert.equal(calls.length,0);
  assert.equal((await dispatcher.invokeCommand('revit_move_elements',args,{confirmed:true})).ok,true);
  assert.equal(calls[0].args.expected_document,document.path);assert.equal(calls[0].session,session);
  await assert.rejects(dispatcher.invokeTool('revit_move_elements',{...args,expected_document:'D:\\other.rvt'}),/不一致/);
  assert.equal(calls.length,1);
});

test('cancellation after preflight never dispatches a model write',async()=>{
  let current=true,writes=0;
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>{current=false;return status();},invokeWorkbench:async()=>{writes++;}});
  const result=await dispatcher.invokeCommand('revit_move_elements',{element_ids:[1],delta_mm:{x:1,y:0,z:0}},{confirmed:true,shouldContinue:()=>current});
  assert.equal(result.error.outcome,'not_started');assert.equal(writes,0);
});

test('family transport success with an unknown business outcome remains unknown for both entries',async()=>{
  const requestId='44444444-4444-4444-8444-444444444444';
  const native={operation:'family_save_job',hostSession:session,request_id:requestId,
    value:{success:false,code:'FAMILY_OPERATION_OUTCOME_UNKNOWN',outcome:'unknown',job_handle:'owned-job-1',cleanup_pending:true,
      effects:{saved_file_may_persist:true,project_saved:false},save:{attempted:true,state:'save_outcome_unknown'}}};
  let calls=0;
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;return native;}});
  const manual=await dispatcher.invokeCommand('revit_family_save_job',{job_handle:'owned-job-1'},{confirmed:true});
  assert.equal(manual.ok,false);assert.equal(manual.error.code,'COMMAND_READ_UNCONFIRMED');assert.equal(manual.error.outcome,'unconfirmed');
  assert.deepEqual(manual.evidence.requestIds,[requestId]);assert.deepEqual(manual.evidence.producerResult,native);
  assert.equal(manual.error.nativeFailure.requestId,requestId);assert.equal(manual.error.nativeFailure.producerOutcome,'unknown');
  await assert.rejects(dispatcher.invokeTool('revit_family_save_job',{job_handle:'owned-job-1'}),error=>{
    assert.equal(error.modelOutcome,'unconfirmed');assert.deepEqual(error.producerResult,native);return true;
  });
  assert.equal(calls,2);assert.equal(native.value.cleanup_pending,true);
});

test('explicit family business failure preserves its producer outcome and cleanup uncertainty',async()=>{
  for(const cleanupPending of [false,true]){
    const native={operation:'family_load_job',hostSession:session,request_id:'55555555-5555-4555-8555-555555555555',
      value:{success:false,code:'FAMILY_LOAD_NOT_COMPLETED',outcome:'failed_rolled_back',cleanup_pending:cleanupPending,job_handle:'owned-job-2',effects:{saved_file_may_persist:true}}};
    const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>native});
    const result=await dispatcher.invokeCommand('revit_family_load_job',{job_handle:'owned-job-2'},{confirmed:true});
    assert.equal(result.ok,false);assert.equal(result.error.outcome,cleanupPending?'unconfirmed':'failed');
    assert.equal(result.error.nativeFailure.producerOutcome,'failed_rolled_back');
    assert.equal(result.evidence.producerResult.value.effects.saved_file_may_persist,true);
  }
});

test('a real queue timeout retains the producing read receipt owner through the shared dispatcher',async t=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-dispatch-receipt-'));
  for(const child of ['inbox','processing','outbox'])await fs.mkdir(path.join(temporary,'queue',child),{recursive:true});
  await fs.writeFile(path.join(temporary,'queue','host.json'),JSON.stringify({sessionId:session,pid:process.pid,version:'0.6.4',atomicReadSnapshot:true}));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));assert.ok(path.basename(temporary).startsWith('buildx-dispatch-receipt-'));await fs.rm(temporary,{recursive:true,force:true});});
  const result=await invokeModelCommand('revit_list_family_types',{}, {root:temporary,timeout:1});
  assert.equal(result.ok,false);assert.equal(result.error.outcome,'unconfirmed');
  assert.equal(result.evidence.requestIds.length,1);assert.ok(result.receiptOwner);
  assert.equal((await result.receiptOwner.close()).ok,true);
});
