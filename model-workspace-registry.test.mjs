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
import {modelOperationEffect,supportsModelPermissionTool} from './lib/model-operation-effects.mjs';
import {describeModelOperationSchema} from './lib/model-operation-contracts.mjs';
import {NATIVE_MODEL_QUERY_TOOLS,MODEL_PREPARATION_QUERY_NAME} from './lib/native-model-queries.mjs';
import {NATIVE_PARAMETER_QUERY_TOOLS} from './lib/native-parameter-queries.mjs';
import {ACCESS_FILE_TOOLS} from './lib/access-file-tools.mjs';
import {createModelToolDispatcher,invokeModelCommand} from './lib/model-tool-dispatch.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE,verifyModelWorkspaceCatalog,verifyReadonlyWorkbenchCatalog} from './lib/codex-profile.mjs';
import {panelProfile,MODEL_SERVER_PROFILE} from './lib/panel-profile.mjs';
import {readonlyPanelCommandSchema} from './lib/workbench-client.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const session='f'.repeat(32),document={title:'Registry sample',path:'D:\\samples\\registry.rvt',activeViewId:12,activeViewType:'ThreeD',modified:false};
test('group members discovery paginates elements and returns the exact named schema',()=>{
  const name='revit_get_group_members',found=[];
  let offset=0,more=true;
  while(more){const result=describeModelOperationSchema({domain:'elements',offset,limit:3});
    assert.equal(result.ok,true);found.push(...result.value.tools.map(tool=>tool.name));
    more=result.value.hasMore;offset+=3;
  }
  assert.equal(found.filter(item=>item===name).length,1);
  const registered=MODEL_AI_READ_TOOLS.find(tool=>tool.name===name);
  const exact=describeModelOperationSchema({tool:name});assert.equal(exact.ok,true);
  assert.deepEqual(exact.value.inputSchema,registered.inputSchema);
  assert.deepEqual(exact.value.outputSchema,registered.outputSchema);
});
const status=()=>({hostSession:session,document:{...document},request_id:'11111111-1111-4111-8111-111111111111'});
test('view creation contracts are discoverable in Code Mode views and guarded as model transactions',()=>{
  const names=['revit_create_floor_plan_view','revit_create_3d_view'];
  const found=[];let offset=0,more=true;
  while(more){const result=describeModelOperationSchema({domain:'views',offset,limit:3});assert.equal(result.ok,true);found.push(...result.value.tools.map(tool=>tool.name));more=result.value.hasMore;offset+=3;}
  for(const name of names){
    assert.equal(found.filter(item=>item===name).length,1);assert.equal(supportsModelPermissionTool(name),true);
    const registered=MODEL_AI_EFFECT_TOOLS.find(tool=>tool.name===name);assert.ok(registered);
    const exact=describeModelOperationSchema({tool:name});assert.equal(exact.ok,true);assert.deepEqual(exact.value.inputSchema,registered.inputSchema);
    assert.equal(registered.inputSchema.properties.mode.default,'rollback');
  }
});
const catalog=()=>({data:[{name:'revit_workbench',runtimeStatus:'connected',authStatus:'unsupported',resources:[],resourceTemplates:[],toolsError:null,
  tools:Object.fromEntries(MODEL_AI_READ_TOOLS.map(tool=>[tool.name,structuredClone(tool)]))}]});

test('the complete inventory includes the native model and type-parameter contracts exactly once',()=>{
  assert.equal(MODEL_COMMAND_CATALOG.length,PANEL_WORKBENCH_TOOLS.length+PANEL_CONFIRMED_ONLY_TOOLS.length);
  assert.equal(new Set(MODEL_COMMAND_CATALOG.map(item=>item.id)).size,MODEL_COMMAND_CATALOG.length);
  assert.equal(modelCommandById('revit_capture_model_snapshot').readOnly,true);
  assert.equal(modelCommandById(MODEL_PREPARATION_QUERY_NAME).group,'模型查询');
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
  const instructions=profile.buildInstructions();
  assert.doesNotMatch(instructions,/\b(?:TessellatedShapeBuilder|AreTargetAndFallbackCompatible|Mesh|Salvage)\b/);
  assert.match(instructions,/生成 Revit C# 前[^。\n]*只提供脚本[^。\n]*个人命令[^。\n]*先调用 buildx_model_operation_schema\(\{tool:"revit_execute_csharp"\}\)[^。\n]*再编写代码/);
  assert.match(instructions,/起草个人命令前[^。\n]*先调用 buildx_model_operation_schema\(\{tool:"revit_save_command"\}\)/);
  assert.match(instructions,/Revit 版本和文档类型选用已核实的 API/);
  assert.match(instructions,/不兼容的写法，改用等价的受支持实现/);
  assert.match(instructions,/不影响用户目标的可选项才可省略，并说明省略项/);
  assert.match(instructions,/必需项无法等价实现时，提交脚本前说明缺口/);
  assert.deepEqual(profile.toolNames,MODEL_AI_READ_TOOLS.map(tool=>tool.name));assert.equal(profile.supportsTurnAttachments,true);
  assert.deepEqual(profile.dynamicTools.map(item=>item.name),['buildx_project_search','buildx_project_read','buildx_project_table','buildx_materials_list','buildx_materials_read',...ACCESS_FILE_TOOLS.map(item=>item.name),'buildx_model_operation_schema','buildx_model_operation']);
  assert.ok(Buffer.byteLength(JSON.stringify(profile.dynamicTools))<=32768);
  const operation=profile.dynamicTools.at(-1);
  const supported=MODEL_AI_EFFECT_TOOLS.filter(tool=>supportsModelPermissionTool(tool.name));
  assert.ok(supported.some(tool=>tool.name==='revit_create_wall'));
  assert.ok(supported.some(tool=>tool.name==='revit_inspect_elements'));
  assert.deepEqual(operation.inputSchema.properties.tool.enum,supported.map(tool=>tool.name));
  assert.equal(operation.inputSchema.additionalProperties,false);
  assert.deepEqual(operation.inputSchema.properties.parameters,{type:'object'});
  assert.equal(operation.inputSchema.oneOf,undefined);
  for(const definition of supported)assert.deepEqual(describeModelOperationSchema({tool:definition.name}).value.inputSchema,definition.inputSchema);
  const validate=new Ajv({strict:false}).compile(operation.inputSchema);
  assert.equal(validate({tool:'revit_move_elements',parameters:{expected_document:'C:\\fixture.rvt',element_ids:[1],delta_mm:{x:1,y:0,z:0},mode:'rollback'}}),true);
  assert.equal(validate({tool:'revit_move_elements',parameters:[]}),false);
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

test('conduit schema is discoverable in mep and guarded as a rollback model transaction',()=>{
 const name='revit_create_conduit',found=[];let offset=0,more=true;
 while(more){const result=describeModelOperationSchema({domain:'mep',offset,limit:3});assert.equal(result.ok,true);found.push(...result.value.tools.map(tool=>tool.name));more=result.value.hasMore;offset+=3;}
 assert.equal(found.filter(item=>item===name).length,1);assert.equal(supportsModelPermissionTool(name),true);
 const registered=MODEL_AI_EFFECT_TOOLS.find(tool=>tool.name===name);assert.ok(registered);assert.equal(registered.inputSchema.properties.mode.default,'rollback');
 assert.deepEqual(describeModelOperationSchema({tool:name}).value.inputSchema,registered.inputSchema);
 assert.equal(modelOperationEffect(name).kind,'model_transaction');
 assert.equal(modelCommandById(name).readOnly,false);
});

test('duct schema is discoverable in mep and guarded as a rollback model transaction',()=>{
 const name='revit_create_duct',found=[];let offset=0,more=true;
 while(more){const result=describeModelOperationSchema({domain:'mep',offset,limit:3});assert.equal(result.ok,true);found.push(...result.value.tools.map(tool=>tool.name));more=result.value.hasMore;offset+=3;}
 assert.equal(found.filter(item=>item===name).length,1);assert.equal(supportsModelPermissionTool(name),true);
 const registered=MODEL_AI_EFFECT_TOOLS.find(tool=>tool.name===name);assert.ok(registered);assert.equal(registered.inputSchema.properties.mode.default,'rollback');
 assert.deepEqual(describeModelOperationSchema({tool:name}).value.inputSchema,registered.inputSchema);
 assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(modelCommandById(name).readOnly,false);
});


test('sheet schema is discoverable in Code Mode views and guarded as a rollback model transaction',()=>{
 const name='revit_create_sheet',found=[];let offset=0,more=true;
 while(more){const result=describeModelOperationSchema({domain:'views',offset,limit:3});assert.equal(result.ok,true);found.push(...result.value.tools.map(tool=>tool.name));more=result.value.hasMore;offset+=3;}
 assert.equal(found.filter(item=>item===name).length,1);assert.equal(supportsModelPermissionTool(name),true);
 const registered=MODEL_AI_EFFECT_TOOLS.find(tool=>tool.name===name);assert.ok(registered);assert.equal(registered.inputSchema.properties.mode.default,'rollback');
 const exact=describeModelOperationSchema({tool:name});assert.equal(exact.ok,true);assert.deepEqual(exact.value.inputSchema,registered.inputSchema);
 assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(modelCommandById(name).readOnly,false);
});


test('viewport is discoverable in views and requires a guarded model transaction',async()=>{
 const name='revit_place_viewport_on_sheet',found=[];let offset=0,more=true;
 while(more){const result=describeModelOperationSchema({domain:'views',offset,limit:3});assert.equal(result.ok,true);found.push(...result.value.tools.map(tool=>tool.name));more=result.value.hasMore;offset+=3;}
 assert.equal(found.filter(item=>item===name).length,1);assert.equal(supportsModelPermissionTool(name),true);
 const registered=MODEL_AI_EFFECT_TOOLS.find(tool=>tool.name===name);assert.ok(registered);assert.equal(registered.inputSchema.properties.mode.default,'rollback');
 assert.deepEqual(describeModelOperationSchema({tool:name}).value.inputSchema,registered.inputSchema);
 assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(modelCommandById(name).readOnly,false);
 let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});
 const result=await dispatcher.invokeCommand(name,{sheet_id:'1',view_id:'2',x_mm:0,y_mm:0},{confirmed:false});
 assert.equal(result.ok,false);assert.equal(calls,0);
});

test('view template is discoverable in Code Mode views and requires a guarded model transaction',async()=>{
 const name='revit_apply_view_template',found=[];let offset=0,more=true;
 while(more){const result=describeModelOperationSchema({domain:'views',offset,limit:3});assert.equal(result.ok,true);found.push(...result.value.tools.map(tool=>tool.name));more=result.value.hasMore;offset+=3;}
 assert.equal(found.filter(item=>item===name).length,1);assert.equal(supportsModelPermissionTool(name),true);
 const registered=MODEL_AI_EFFECT_TOOLS.find(tool=>tool.name===name);assert.ok(registered);assert.equal(registered.inputSchema.properties.mode.default,'rollback');
 assert.deepEqual(describeModelOperationSchema({tool:name}).value.inputSchema,registered.inputSchema);
 assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(modelCommandById(name).readOnly,false);
 let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});
 const result=await dispatcher.invokeCommand(name,{view_id:'1',template_id:'2'},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);
});

test('text note is discoverable in Code Mode views and requires a guarded model transaction',async()=>{
 const name='revit_create_text_note',found=[];let offset=0,more=true;
 while(more){const result=describeModelOperationSchema({domain:'views',offset,limit:3});assert.equal(result.ok,true);found.push(...result.value.tools.map(tool=>tool.name));more=result.value.hasMore;offset+=3;}
 assert.equal(found.filter(item=>item===name).length,1);assert.equal(supportsModelPermissionTool(name),true);
 const registered=MODEL_AI_EFFECT_TOOLS.find(tool=>tool.name===name);assert.ok(registered);assert.equal(registered.inputSchema.properties.mode.default,'rollback');
 assert.deepEqual(describeModelOperationSchema({tool:name}).value.inputSchema,registered.inputSchema);
 assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(modelCommandById(name).readOnly,false);
 let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});
 const result=await dispatcher.invokeCommand(name,{view_id:'1',text_type_id:'2',point_mm:{x:0,y:0,z:0},text:'hello'},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);
});

test('section view is discovered in paged views and runs only through the guarded operation',async()=>{
  const name='revit_create_section_view',found=[];
  for(let offset=0,more=true;more;offset+=3){
    const page=describeModelOperationSchema({domain:'views',offset,limit:3});
    assert.equal(page.ok,true);found.push(...page.value.tools.map(tool=>tool.name));more=page.value.hasMore;
  }
  assert.equal(found.filter(item=>item===name).length,1);
  const registered=MODEL_AI_EFFECT_TOOLS.find(tool=>tool.name===name);
  assert.ok(registered);
  assert.deepEqual(describeModelOperationSchema({tool:name}).value.inputSchema,registered.inputSchema);
  assert.equal(registered.inputSchema.properties.angle_degrees.exclusiveMaximum,360);
  assert.equal(registered.inputSchema.properties.mode.default,'rollback');
  assert.equal(supportsModelPermissionTool(name),true);
  assert.equal(modelOperationEffect(name).kind,'model_transaction');
  assert.equal(modelCommandById(name).readOnly,false);
  let calls=0;
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});
  const result=await dispatcher.invokeCommand(name,{name:'Test',view_family_type_id:'1',origin_mm:{x:0,y:0,z:0},
    angle_degrees:90,width_mm:1000,height_mm:3000,depth_mm:4000},{confirmed:false});
  assert.equal(result.ok,false);assert.equal(calls,0);
});

test('schedule is discoverable and guarded as a model transaction',async()=>{
 const name='revit_create_schedule';const schema=describeModelOperationSchema({tool:name});assert.equal(schema.ok,true);assert.equal(schema.value.inputSchema.properties.mode.default,'rollback');
 assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelCommandById(name).readOnly,false);
 let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});
 const result=await dispatcher.invokeCommand(name,{name:'Walls',category:'OST_Walls'},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);
});


test('material is discoverable in Code Mode elements and guarded by model permission',async()=>{
 const name='revit_create_material',found=[];let offset=0,more=true;
 while(more){const page=describeModelOperationSchema({domain:'elements',offset,limit:3});assert.equal(page.ok,true);found.push(...page.value.tools.map(tool=>tool.name));more=page.value.hasMore;offset+=3;}
 assert.equal(found.filter(item=>item===name).length,1);assert.equal(supportsModelPermissionTool(name),true);
 const registered=MODEL_AI_EFFECT_TOOLS.find(tool=>tool.name===name);assert.ok(registered);assert.deepEqual(describeModelOperationSchema({tool:name}).value.inputSchema,registered.inputSchema);
 assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(modelCommandById(name).readOnly,false);
 let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});
 const result=await dispatcher.invokeCommand(name,{name:'Test material',red:12,green:34,blue:56,transparency:25},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);
});

test('change type contract is discoverable and requires guarded model permission',async()=>{
 const name='revit_change_element_type',schema=describeModelOperationSchema({tool:name});assert.equal(schema.ok,true);assert.equal(schema.value.inputSchema.properties.mode.default,'rollback');assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelCommandById(name).readOnly,false);
 let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});const result=await dispatcher.invokeCommand(name,{element_id:'1',target_type_id:'2'},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);
});

test('room appears in elements discovery with a guarded exact schema',()=>{
 const exact=describeModelOperationSchema({tool:'revit_create_room'});assert.equal(exact.ok,true);
 assert.deepEqual(exact.value.inputSchema.required,['expected_document','level_id','point_xy_mm']);
 assert.equal(exact.value.inputSchema.properties.phase_id,undefined);
 let offset=0,found=[];for(;;){const page=describeModelOperationSchema({domain:'elements',offset,limit:20});found.push(...page.value.tools.map(x=>x.name));if(!page.value.hasMore)break;offset+=20;}
 assert.equal(found.filter(x=>x==='revit_create_room').length,1);
});
test('group contract is discoverable and requires guarded model permission',async()=>{const name='revit_create_group',schema=describeModelOperationSchema({tool:name});assert.equal(schema.ok,true);assert.equal(schema.value.inputSchema.properties.mode.default,'rollback');assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelCommandById(name).readOnly,false);let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});const result=await dispatcher.invokeCommand(name,{name:'G',element_ids:['1','2']},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);});
test('column exact schema is discoverable in the elements domain',()=>{
 const name='revit_create_column',exact=describeModelOperationSchema({tool:name});assert.equal(exact.ok,true);assert.deepEqual(exact.value.inputSchema.required,['expected_document','symbol_id','base_level_id','top_level_id','point_mm']);
 let offset=0,found=[];for(;;){const p=describeModelOperationSchema({domain:'elements',offset,limit:20});found.push(...p.value.tools.map(x=>x.name));if(!p.value.hasMore)break;offset+=20;}assert.equal(found.filter(x=>x===name).length,1);
});

test('beam contract is discoverable and requires guarded model permission',async()=>{const name='revit_create_beam',schema=describeModelOperationSchema({tool:name});assert.equal(schema.ok,true);assert.equal(schema.value.inputSchema.properties.mode.default,'rollback');assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelCommandById(name).readOnly,false);let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});const result=await dispatcher.invokeCommand(name,{symbol_id:'1',level_id:'2',start_mm:{x:0,y:0,z:0},end_mm:{x:1000,y:0,z:0}},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);});

test('roof contract is discoverable and requires guarded model permission',async()=>{const name='revit_create_roof',schema=describeModelOperationSchema({tool:name});assert.equal(schema.ok,true);assert.equal(schema.value.inputSchema.properties.mode.default,'rollback');assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelCommandById(name).readOnly,false);let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});const result=await dispatcher.invokeCommand(name,{roof_type_id:'1',level_id:'2',origin_xy_mm:{x:0,y:0},width_mm:1000,depth_mm:1000},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);});

test('material assignment is discoverable and guarded in Code Mode',async()=>{
 const name='revit_set_element_material',found=[];let offset=0,more=true;
 while(more){const page=describeModelOperationSchema({domain:'elements',offset,limit:3});assert.equal(page.ok,true);found.push(...page.value.tools.map(tool=>tool.name));more=page.value.hasMore;offset+=3;}
 assert.equal(found.filter(item=>item===name).length,1);assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelOperationEffect(name).kind,'model_transaction');
 let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});
 const result=await dispatcher.invokeCommand(name,{element_id:101,parameter_id:-123,material_id:202,expected_has_value:true,expected_value_internal:-1},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);
});

test('foundation is discoverable in elements and requires guarded model permission',async()=>{
 const name='revit_create_foundation',found=[];let offset=0,more=true;while(more){const page=describeModelOperationSchema({domain:'elements',offset,limit:3});assert.equal(page.ok,true);found.push(...page.value.tools.map(x=>x.name));more=page.value.hasMore;offset+=3;}
 assert.equal(found.filter(x=>x===name).length,1);assert.equal(describeModelOperationSchema({tool:name}).value.inputSchema.properties.mode.default,'rollback');assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelCommandById(name).readOnly,false);
 let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});const result=await dispatcher.invokeCommand(name,{symbol_id:3,level_id:1,point_mm:{x:0,y:0,z:0}},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);
});
test('ungroup is a discoverable guarded destructive model action',async()=>{const name='revit_ungroup',schema=describeModelOperationSchema({tool:name});assert.equal(schema.ok,true);assert.equal(schema.value.inputSchema.properties.mode.default,'rollback');assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelCommandById(name).readOnly,false);let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});const result=await dispatcher.invokeCommand(name,{group_id:'1'},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);});
test('duplicate sheet is discoverable and guarded by model permission',async()=>{const name='revit_duplicate_sheet',schema=describeModelOperationSchema({tool:name});assert.equal(schema.ok,true);assert.equal(schema.value.inputSchema.properties.mode.default,'rollback');assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelCommandById(name).readOnly,false);let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});const result=await dispatcher.invokeCommand(name,{source_sheet_id:'1',name:'copy',number:'A2',copy_option:'empty'},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);});

test('renumber sheets exposes its exact schema through views discovery',()=>{
 const name='revit_renumber_sheets',exact=describeModelOperationSchema({tool:name});assert.equal(exact.ok,true);assert.deepEqual(exact.value.inputSchema.required,['expected_document','sheets']);let offset=0,found=[];
 for(;;){const p=describeModelOperationSchema({domain:'views',offset,limit:20});found.push(...p.value.tools.map(x=>x.name));if(!p.value.hasMore)break;offset+=20;}assert.equal(found.filter(x=>x===name).length,1);
});
test('mirror contract is discoverable and guarded by model permission',async()=>{const name='revit_mirror_element',schema=describeModelOperationSchema({tool:name});assert.equal(schema.ok,true);assert.equal(schema.value.inputSchema.properties.mode.default,'rollback');assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelCommandById(name).readOnly,false);let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});const result=await dispatcher.invokeCommand(name,{element_id:'1',plane_origin_mm:{x:0,y:0,z:0},plane_normal:{x:1,y:0,z:0}},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);});

test('selection is a discoverable guarded UI effect without rollback mode',async()=>{
 const name='revit_set_selection',schema=describeModelOperationSchema({tool:name});assert.equal(schema.ok,true);assert.equal(Object.hasOwn(schema.value.inputSchema.properties,'mode'),false);assert.equal(modelOperationEffect(name).kind,'ui_selection');assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelCommandById(name).readOnly,false);
 let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});const result=await dispatcher.invokeCommand(name,{element_ids:[1]},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);
});
test('titleblock write contract is discoverable and guarded',async()=>{const name='revit_populate_titleblock',schema=describeModelOperationSchema({tool:name});assert.equal(schema.ok,true);assert.equal(schema.value.inputSchema.properties.mode.default,'rollback');assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelCommandById(name).readOnly,false);let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});const result=await dispatcher.invokeCommand(name,{sheet_id:'1',titleblock_id:'2',changes:[]},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);});


test('UniqueId selection exposes a guarded UI contract without zoom or rollback',async()=>{
 const name='revit_select_by_unique_ids',schema=describeModelOperationSchema({tool:name});assert.equal(schema.ok,true);assert.equal(Object.hasOwn(schema.value.inputSchema.properties,'mode'),false);assert.equal(Object.hasOwn(schema.value.inputSchema.properties,'zoom'),false);assert.equal(modelOperationEffect(name).kind,'ui_selection');assert.equal(supportsModelPermissionTool(name),true);
 let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});const result=await dispatcher.invokeCommand(name,{element_uids:['uid-a']},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);
});

test('family type batch is discoverable and guarded by model permission',async()=>{const name='revit_replace_family_type',schema=describeModelOperationSchema({tool:name});assert.equal(schema.ok,true);assert.equal(schema.value.inputSchema.properties.mode.default,'rollback');assert.equal(modelOperationEffect(name).kind,'model_transaction');assert.equal(supportsModelPermissionTool(name),true);assert.equal(modelCommandById(name).readOnly,false);let calls=0;const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>status(),invokeWorkbench:async()=>{calls++;}});const result=await dispatcher.invokeCommand(name,{element_ids:['1'],old_type_id:'7',new_type_id:'8'},{confirmed:false});assert.equal(result.ok,false);assert.equal(calls,0);});
