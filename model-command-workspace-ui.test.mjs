import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush,UiEvent} from './test-support/model-input-ui-fixture.mjs';
import {MODEL_COMMAND_CATALOG} from './lib/model-command-catalog.mjs';
import {MODEL_SERVER_PROFILE,panelProfile} from './lib/panel-profile.mjs';
import {modelSchemaParameters,modelCommandPresentation} from './public/model-workspace.mjs';

const state={workspace:{kind:'model',supportsModelContext:true},ready:false,commandsReady:true,commandReadiness:'local',
  directCommandsAvailable:true,commandCatalog:MODEL_COMMAND_CATALOG,historyAvailable:true,account:{required:false},
  connectionGeneration:1,codexAccount:{accountRevision:1,status:'unavailable'}};
async function setup(t){const ui=await createInputUi();t.after(()=>ui.close());ui.emit('state',state);ui.emit('conversation',{busy:false,session:session()});await flush();return ui;}

test('workspace tool count uses the registered Revit catalog and survives count-only reconnect updates',async t=>{
  const ui=await setup(t),catalog=panelProfile(MODEL_SERVER_PROFILE).catalog;
  const reads=catalog.filter(tool=>tool.readOnly).length, count=catalog.length;
  const label=`Revit 工具总数 ${count} 项 · 只读查询 ${reads} 项 · 其他操作 ${count-reads} 项`;
  ui.emit('state',{...state,toolCount:reads,toolCatalog:[...catalog,catalog[0],{name:'<invalid>'}]});
  const badge=ui.get('model-tools-toggle'),drawerCount=ui.get('tool-count');
  assert.equal(badge.textContent,`工具 ${count}`);
  assert.equal(badge.title,label);
  assert.equal(drawerCount.textContent,label);
  assert.equal(ui.get('tool-list').childElementCount,catalog.length);
  ui.emit('state',{...state,toolCount:0});
  assert.equal(badge.textContent,`工具 ${count}`);
  assert.equal(drawerCount.textContent,label);
  ui.emit('state',{...state,toolCount:0,toolCatalog:[]});
  assert.equal(badge.textContent,'工具');
  assert.equal(drawerCount.textContent,'正在读取目录');
});

test('create command stays directly below search and remains available with no matching or saved commands',async t=>{
  const ui=await setup(t),list=ui.get('model-command-list'),search=list.querySelectorAll('.model-command-filter')[0],create=ui.get('model-create-command'),area=list.querySelectorAll('.command-create-area')[0],items=list.querySelectorAll('.model-command-items')[0];
  ui.document.body.querySelectorAll('.model-tab')[1].click();
  assert.equal(list.hidden,false);assert.deepEqual(list.children.slice(0,3),[search,area,items]);assert.equal(items.contains(create),false);
  assert.match(area.textContent,/C# 命令/);assert.equal(create.contains(ui.get('model-create-command-kind')),false);
  search.value='不存在的命令-unique';search.dispatchEvent(new UiEvent('input'));
  assert.equal(items.children.every(row=>row.hidden),true);assert.equal(create.hidden,false);
  ui.emit('state',{...state,commandCatalog:[]});await flush();
  assert.equal(items.children.length,0);assert.equal(area.parent,list);assert.equal(create.hidden,false);
});

test('command creation selects supported source kinds and does not create unsupported DLL or Dynamo commands',async t=>{
  const ui=await setup(t),kind=ui.get('model-create-command-kind'),create=ui.get('model-create-command'),starts=[];
  ui.window.addEventListener('buildx-create-command',event=>starts.push(event.detail));
  assert.equal(kind.value,'csharp');assert.deepEqual(kind.children.map(option=>[option.value,option.disabled]),[['csharp',false],['sequence',false],['dll',true],['dynamo',true]]);
  for(const unsupported of ['dll','dynamo']){kind.value=unsupported;kind.dispatchEvent(new UiEvent('change'));create.click();}
  assert.equal(starts.length,0);assert.equal(ui.requests.length,0);
  kind.value='sequence';kind.dispatchEvent(new UiEvent('change'));assert.match(ui.get('model-create-command-help').textContent,/现有只读查询/);
  create.click();await flush();assert.deepEqual(starts,[{kind:'sequence'}]);
});

test('command creation disables the type selector with the creation action while the workspace is busy',async t=>{
  const ui=await setup(t);ui.emit('conversation',{busy:true,session:session()});await flush();
  assert.equal(ui.get('model-create-command').disabled,true);assert.equal(ui.get('model-create-command-kind').disabled,true);
});

test('workspace presents four tabs with skills separate from the library and no model viewer',async t=>{
  const ui=await setup(t),tabs=ui.document.body.querySelectorAll('.model-tab');
  assert.deepEqual(tabs.map(tab=>tab.textContent),['对话','命令','技能','资料库']);
  assert.equal(ui.document.body.querySelectorAll('.model-extra-panel').some(panel=>panel.id==='model-viewer-panel'),false);
  assert.equal(ui.get('skills-panel').parent===ui.get('model-skills-page'),true);
  tabs[2].click();assert.equal(ui.document.body.dataset.modelView,'skills');
  assert.equal(ui.get('model-skills-page').hidden,false);assert.equal(ui.get('project-knowledge-panel').hidden,true);
  let opened=0;ui.window.addEventListener('buildx-project-files-opened',()=>opened++);
  tabs[3].click();assert.equal(opened,1);assert.equal(ui.document.body.dataset.modelView,'knowledge');
  assert.equal(ui.get('model-skills-page').hidden,true);assert.equal(ui.get('project-knowledge-panel').hidden,false);
  tabs[0].click();assert.equal(ui.document.body.dataset.modelView,'chat');
  const previous=ui.view();ui.window.dispatchEvent(new UiEvent('buildx-model-view',{detail:{enabled:false}}));
  assert.equal(ui.get('skills-panel').parent===ui.get('model-skills-page'),false);
  ui.window.dispatchEvent(new UiEvent('buildx-model-view',{detail:previous}));
  assert.equal(ui.get('skills-panel').parent===ui.get('model-skills-page'),true);
});

test('a catalog command sends structured parameters while AI is offline without submitting a turn',async t=>{
  const ui=await setup(t);ui.input('保留我的对话草稿');
  await ui.intent('buildx-model-command',{commandId:'revit_list_family_types',parameters:{limit:12,offset:0}});
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/command');
  assert.equal(ui.requests[0].body.commandId,'revit_list_family_types');assert.deepEqual(ui.requests[0].body.parameters,{limit:12,offset:0});
  assert.equal(ui.get('prompt').value,'保留我的对话草稿');
  await ui.respond(ui.requests[0],{ok:true,executionId:'family-types-1'});
  ui.emit('conversation',{busy:false,session:session(),command:{commandId:'revit_list_family_types',conversationId:'chat-a',executionId:'family-types-1',status:'completed',result:{data:{value:{items:[{name:'类型A'}],total:1}}}}});
  assert.equal(ui.view().commands[0].status,'completed');assert.equal(ui.view().ready,false);assert.equal(ui.get('transcript').children.length,0);
});

test('AI reconnect observations retain the independently owned command and pending acceptance',async t=>{
  const ui=await setup(t);
  await ui.intent('buildx-model-command',{commandId:'document',parameters:{}});
  ui.emit('state',{...state,connectionGeneration:2,codexAccount:{accountRevision:7,status:'checking'}});
  await ui.respond(ui.requests[0],{ok:true,executionId:'independent-read'});
  assert.equal(ui.view().commands[0].executionId,'independent-read');assert.equal(ui.view().commands[0].status,'running');
});

test('write intent requires explicit confirmation and never smuggles it into tool parameters',async t=>{
  const ui=await setup(t),detail={commandId:'revit_create_wall',parameters:{mode:'rollback'}};
  await ui.intent('buildx-model-command',detail);assert.equal(ui.requests.length,0);
  await ui.intent('buildx-model-command',{...detail,confirmed:true});assert.equal(ui.requests.length,1);
  assert.equal(ui.requests[0].body.confirmed,true);assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback'});
  await ui.respond(ui.requests[0],{ok:true,executionId:'confirmed-write'});
});

test('schema-driven inputs parse typed values, preserve defaults and reject malformed structured values',()=>{
  const wall=MODEL_COMMAND_CATALOG.find(command=>command.id==='revit_create_wall');
  const values={wall_type_id:'1',level_id:'2',start_mm:'{"x":0,"y":0,"z":0}',end_mm:'{"x":100,"y":0,"z":0}',height_mm:'3000'};
  const parsed=modelSchemaParameters(wall,values);assert.equal(parsed.ok,true);assert.equal(parsed.parameters.mode,'rollback');assert.equal(parsed.parameters.wall_type_id,1);assert.deepEqual(parsed.parameters.start_mm,{x:0,y:0,z:0});
  assert.equal(modelSchemaParameters(wall,{...values,start_mm:'bad-json'}).ok,false);
  assert.equal(modelSchemaParameters(wall,{...values,height_mm:'-1'}).ok,false);
  const generic=modelCommandPresentation({commandId:'revit_list_family_types',status:'completed',result:{data:{value:{total:1,items:[{name:'<script>'}]}}}});
  assert.deepEqual(generic.rows,[['total','1'],['items','[{"name":"<script>"}]']]);
});

test('local receipt inspection remains available while AI is offline',async t=>{
  const ui=await setup(t);
  ui.emit('conversation',{busy:false,session:session(),command:{commandId:'document',conversationId:'chat-a',executionId:'late-native',status:'unknown',canInspectReceipt:true}});
  const inspect=ui.document.body.querySelectorAll('.model-command-inspect')[0];assert.equal(inspect.hidden,false);assert.equal(inspect.disabled,false);
  inspect.click();await flush();assert.equal(ui.requests[0].url,'/api/command/check');await ui.respond(ui.requests[0],{ok:true});
});
test('cabinet acknowledgement requires terminal projection and binds exact execution and revision',async t=>{
  const ui=await setup(t),commandId='revit_family_save_cabinet';
  const command={commandId,conversationId:'chat-a',executionId:'cabinet-save-1',status:'unknown',canInspectReceipt:true,receiptCheck:{revision:1,status:'unconfirmed'}};
  ui.emit('conversation',{busy:false,session:session(),command});await flush();
  const item=ui.document.body.querySelectorAll('.model-command-item').find(row=>row.dataset.commandId===commandId),ack=item.querySelectorAll('.model-command-acknowledge')[0];
  assert.equal(ack.hidden,true);await ui.intent('buildx-model-command-acknowledge',{commandId,conversationId:'chat-a',executionId:'cabinet-save-1',revision:1});assert.equal(ui.requests.length,0);
  ui.emit('conversation',{busy:false,session:session(),command:{...command,canInspectReceipt:false,canAcknowledgeReceipt:true,receiptCheck:{revision:2,status:'received',evidence:{jobHandle:'job-1',savePath:'D:/cabinet.rfa'}}}});await flush();
  assert.equal(ack.hidden,false);assert.match(item.textContent,/job-1/);assert.match(item.textContent,/D:\/cabinet.rfa/);ack.click();await flush();
  assert.equal(ui.requests[0].url,'/api/command/acknowledge');assert.deepEqual(ui.requests[0].body,{client:'ui-id-1',conversationId:'chat-a',commandId,executionId:'cabinet-save-1',revision:2,confirmed:true});
  await ui.respond(ui.requests[0],{ok:true,executionId:'cabinet-save-1'});
});
test('cabinet unknown result exposes only server-bound read-only job recovery',async t=>{
  const ui=await setup(t),commandId='revit_family_save_cabinet';
  const command={commandId,conversationId:'chat-a',executionId:'cabinet-save-2',status:'unknown',canInspectReceipt:true,canInspectCabinetJob:true,receiptCheck:{revision:2,status:'unconfirmed',evidence:{jobHandle:'job-2',cleanupPending:true}}};
  ui.emit('conversation',{busy:false,session:session(),command});await flush();
  const item=ui.document.body.querySelectorAll('.model-command-item').find(row=>row.dataset.commandId===commandId),button=item.querySelectorAll('.model-command-recover')[0];
  assert.equal(button.hidden,false);button.click();await flush();assert.equal(ui.requests[0].url,'/api/command/recover');assert.deepEqual(ui.requests[0].body,{client:'ui-id-1',conversationId:'chat-a',commandId,executionId:'cabinet-save-2'});
  ui.emit('conversation',{busy:false,session:session(),command:{...command,cabinetRecoveryInspection:{checking:false,status:'received',job:{job_handle:'job-2',cleanup_pending:true}}}});await ui.respond(ui.requests[0],{ok:true});assert.match(item.textContent,/job-2/);assert.match(item.textContent,/cleanup_pending/);
});

test('editing a write parameter clears the earlier parameter confirmation',async t=>{
  const ui=await setup(t);
  const groups=ui.document.body.querySelectorAll('.model-command-confirm');
  const confirmation=groups[0].children[0];confirmation.checked=true;
  // The first write in the named catalog is the script runner.
  ui.get('model-command-revit_execute_csharp-code').dispatchEvent(new UiEvent('input'));
  assert.equal(confirmation.checked,false);
});

test('cabinet confirmation is specific to edited dimensions and each subsequent action',async t=>{
  const ui=await setup(t);
  const row=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='revit_family_create_cabinet');
  assert.ok(row);assert.match(row.textContent,/宽度（mm）/);assert.match(row.textContent,/深度（mm）/);assert.match(row.textContent,/板厚（mm）/);
  const confirm=row.querySelectorAll('.model-command-confirm')[0].children[0],run=row.querySelectorAll('.model-command-run')[0];
  ui.get('model-command-revit_family_create_cabinet-template_id').value='metric-generic-model';
  confirm.checked=true;
  const width=ui.get('model-command-revit_family_create_cabinet-width_mm');width.value='1350';width.dispatchEvent(new UiEvent('input'));
  assert.equal(confirm.checked,false);run.click();await flush();assert.equal(ui.requests.length,0);
  confirm.checked=true;run.click();await flush();assert.equal(ui.requests.length,1);
  assert.equal(ui.requests[0].body.confirmed,true);assert.equal(ui.requests[0].body.commandId,'revit_family_create_cabinet');
  assert.equal(ui.requests[0].body.parameters.width_mm,1350);assert.equal(ui.requests[0].body.parameters.depth_mm,600);
  assert.equal(confirm.checked,false);
  await ui.respond(ui.requests[0],{ok:true,executionId:'cabinet-created'});
  const close=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='revit_family_close_cabinet');
  assert.ok(close);assert.match(close.textContent,/未保存内容将丢弃/);
  ui.get('model-command-revit_family_close_cabinet-job_handle').value='owned-cabinet';
  close.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,1);
  assert.match(close.querySelectorAll('.model-command-confirm')[0].textContent,/丢弃未保存内容/);
  const save=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='revit_family_save_cabinet');
  assert.ok(save);assert.match(save.querySelectorAll('.model-command-confirm')[0].textContent,/新 RFA、关闭原临时族并重新打开复核/);
  const saveConfirm=save.querySelectorAll('.model-command-confirm')[0].children[0],job=ui.get('model-command-revit_family_save_cabinet-job_handle');
  job.value='owned-cabinet';saveConfirm.checked=true;job.value='other-cabinet';job.dispatchEvent(new UiEvent('input'));assert.equal(saveConfirm.checked,false);
});

test('command drafts require exactly one body and exact revision identities',()=>{
  const save=MODEL_COMMAND_CATALOG.find(command=>command.id==='revit_save_command');
  const get=MODEL_COMMAND_CATALOG.find(command=>command.id==='revit_get_command');
  const run=MODEL_COMMAND_CATALOG.find(command=>command.id==='revit_run_command');
  const draft={command_id:'sample',name:'示例',description:'说明'};
  assert.match(modelSchemaParameters(save,draft).error,/二选一/);
  assert.match(modelSchemaParameters(save,{...draft,code:'return 1;',steps:'[{"id":"a","tool":"revit_list_levels","arguments":{}}]'}).error,/二选一/);
  assert.match(modelSchemaParameters(save,{...draft,code:'中'.repeat(22000)}).error,/64000 UTF-8/);
  assert.match(modelSchemaParameters(save,{...draft,code:'return 1;',parameters:'{}',source_request_id:'00000000-0000-0000-0000-000000000000'}).error,/暂不支持/);
  assert.deepEqual(modelSchemaParameters(save,{...draft,code:'return 1;'}),{ok:true,parameters:{...draft,code:'return 1;'}});
  for(const command of [get,run]){
    assert.match(modelSchemaParameters(command,{command_id:'sample',revision:'latest'}).error,/完整 64 位/);
    assert.equal(modelSchemaParameters(command,{command_id:'sample',revision:'a'.repeat(64)}).ok,true);
  }
  assert.equal(modelCommandPresentation({commandId:'revit_save_command',status:'running'}).status,'正在保存…');
  assert.match(modelCommandPresentation({commandId:'revit_run_command',status:'unknown'}).error,/不要重复提交/);
  for (const commandId of ['revit_family_create_cabinet','revit_family_save_cabinet','revit_family_close_cabinet']) {
    assert.match(modelCommandPresentation({commandId,status:'unknown'}).error,/不要重复提交/);
    assert.equal(modelCommandPresentation({commandId,status:'failed',error:{code:'COMMAND_NOT_STARTED',outcome:'not_started'}}).error,'本次操作未执行。');
  }
});

test('saving a pasted draft uses the existing confirmed command path and retains the chat draft',async t=>{
  const ui=await setup(t);ui.input('对话草稿');
  const row=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='revit_save_command');
  assert.match(row.textContent,/保存只生成不可变版本，不执行或验证/);
  for(const [key,value] of Object.entries({command_id:'sample',name:'示例',description:'说明',code:'return 1;'}))ui.get('model-command-revit_save_command-'+key).value=value;
  const confirm=row.querySelectorAll('.model-command-confirm')[0].children[0];confirm.checked=true;
  row.querySelectorAll('.model-command-run')[0].click();await flush();
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/command');
  assert.deepEqual(ui.requests[0].body.parameters,{command_id:'sample',name:'示例',description:'说明',code:'return 1;'});
  assert.equal(ui.requests[0].body.confirmed,true);assert.equal(ui.get('prompt').value,'对话草稿');
  await ui.respond(ui.requests[0],{ok:true,executionId:'saved-draft'});
});

test('browse saved revisions and explicitly read and choose one without running it',async t=>{
  const ui=await setup(t),revision='a'.repeat(64),record={command_id:'sample',revision,name:'示例',description:'说明',verification:{status:'unverified',evidence:[]}};
  ui.emit('conversation',{busy:false,session:session(),command:{commandId:'revit_list_commands',conversationId:'chat-a',executionId:'list-1',status:'completed',result:{data:{value:{commands:[record],total:21,offset:0,limit:20,has_more:true}}}}});
  const list=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='revit_list_commands');
  assert.match(list.textContent,/已保存版本/);assert.match(list.textContent,/还有后续页/);assert.match(list.textContent,/未记录成功执行证据/);assert.match(list.textContent,new RegExp(revision));
  list.querySelectorAll('.model-command-version-view')[0].click();await flush();
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.commandId,'revit_get_command');assert.deepEqual(ui.requests[0].body.parameters,{command_id:'sample',revision});
  await ui.respond(ui.requests[0],{ok:true,executionId:'get-1'});
  ui.emit('conversation',{busy:false,session:session(),command:{commandId:'revit_get_command',conversationId:'chat-a',executionId:'get-1',status:'completed',result:{data:{value:{...record,code:'// comment\nreturn 1;'}}}}});
  const get=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='revit_get_command');
  assert.match(get.textContent,/return 1;/);assert.match(get.textContent,/历史执行记录不代表当前适用/);
  assert.equal(get.querySelectorAll('.model-command-diagnostic-text')[0].textContent,'// comment\nreturn 1;');
  const run=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='revit_run_command');
  ui.get('model-command-revit_run_command-parameters').value='{"old":1}';
  run.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;
  get.querySelectorAll('.model-command-version-choose')[0].click();await flush();
  assert.equal(ui.requests.length,1);assert.equal(ui.get('model-command-revit_run_command-command_id').value,'sample');
  assert.equal(ui.get('model-command-revit_run_command-revision').value,revision);assert.equal(ui.get('model-command-revit_run_command-parameters').value,'');
  assert.equal(run.querySelectorAll('.model-command-confirm')[0].children[0].checked,false);
});

test('malformed stored identities cannot be selected and stale buttons cannot cross an account change',async t=>{
  const ui=await setup(t),list=()=>ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='revit_list_commands');
  const make=revision=>({commandId:'revit_list_commands',conversationId:'chat-a',executionId:'list-1',status:'completed',result:{data:{value:{commands:[{command_id:'sample',revision}],total:1,offset:0,limit:20,has_more:false}}}});
  ui.emit('conversation',{busy:false,session:session(),command:make('latest')});assert.equal(list().querySelectorAll('.model-command-version-view').length,0);assert.match(list().textContent,/身份无效/);
  ui.emit('conversation',{busy:false,session:session(),command:make('a'.repeat(64))});const stale=list().querySelectorAll('.model-command-version-view')[0];
  ui.emit('state',{...state,account:{required:true,signedIn:false}});stale.click();await flush();assert.equal(ui.requests.length,0);
});

test('explicitly importing an assistant C# block preserves its source and never saves or executes automatically',async t=>{
  const ui=await setup(t);ui.input('保留聊天草稿');
  ui.conversation('chat-a',[{id:'assistant-a',role:'assistant',status:'completed',text:'说明\n```json\n{}\n```\n```csharp\n// 候选\nreturn 7;\n```',tools:[]}]);
  const candidates=ui.get('transcript').querySelectorAll('.copy-code').filter(button=>button.textContent==='作为命令草稿');
  assert.equal(candidates.length,1);candidates[0].click();await flush();
  assert.equal(ui.requests.length,0);assert.equal(ui.get('prompt').value,'保留聊天草稿');
  assert.equal(ui.get('model-command-revit_save_command-code').value,'// 候选\nreturn 7;');
  const save=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='revit_save_command');
  assert.match(save.textContent,/对话 chat-a · 消息 assistant-a · 代码块 2/);
  for(const [key,value] of Object.entries({command_id:'chat-draft',name:'候选',description:'需要核对'}))ui.get('model-command-revit_save_command-'+key).value=value;
  save.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;save.querySelectorAll('.model-command-run')[0].click();await flush();
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.commandId,'revit_save_command');
  assert.equal(ui.requests[0].body.parameters.code,'// 候选\nreturn 7;');
  assert.match(ui.requests[0].body.parameters.description,/来源（从对话导入，内容可能已编辑）：\{"conversationId":"chat-a","messageId":"assistant-a","blockIndex":2\}/);
  await ui.respond(ui.requests[0],{ok:true,executionId:'saved-chat-draft'});
});

test('streaming, non-C# and stale conversation blocks cannot create or overwrite a command draft',async t=>{
  const ui=await setup(t);
  ui.conversation('chat-a',[{id:'stream',role:'assistant',status:'streaming',text:'```csharp\nreturn 1;\n```',tools:[]},{id:'other',role:'assistant',status:'completed',text:'```json\n{}\n```',tools:[]}]);
  assert.equal(ui.get('transcript').querySelectorAll('.copy-code').filter(button=>button.textContent==='作为命令草稿').length,0);
  ui.conversation('chat-a',[{id:'done',role:'assistant',status:'completed',text:'```cs\nreturn 2;\n```',tools:[]}]);
  const button=ui.get('transcript').querySelectorAll('.copy-code').find(item=>item.textContent==='作为命令草稿');
  ui.get('model-command-revit_save_command-code').value='existing';button.click();await flush();
  assert.equal(ui.get('model-command-revit_save_command-code').value,'existing');assert.match(ui.get('messages').textContent,/已有草稿/);
  ui.get('model-command-revit_save_command-code').value='';button.click();await flush();
  ui.conversation('chat-b',[]);const save=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='revit_save_command');
  assert.match(save.textContent,/来源所属身份或对话已变化/);
  for(const [key,value] of Object.entries({command_id:'chat-draft',name:'候选',description:'需要核对'}))ui.get('model-command-revit_save_command-'+key).value=value;
  save.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;save.querySelectorAll('.model-command-run')[0].click();await flush();
  assert.equal(ui.requests.length,0);assert.match(save.textContent,/请清除导入内容/);
  save.querySelectorAll('.model-command-draft-clear')[0].click();assert.equal(ui.get('model-command-revit_save_command-code').value,'');
  button.click();await flush();assert.equal(ui.requests.length,0);assert.equal(ui.get('model-command-revit_save_command-code').value,'');
});

test('a changed account identity invalidates an imported draft even if the conversation is unchanged',async t=>{
  const ui=await setup(t);ui.conversation('chat-a',[{id:'answer',role:'assistant',status:'completed',text:'```csharp\nreturn 3;\n```',tools:[]}]);
  ui.get('transcript').querySelectorAll('.copy-code').find(item=>item.textContent==='作为命令草稿').click();await flush();
  ui.emit('state',{...state,account:{required:false,signedIn:true,user:{id:'other-account'}}});
  const save=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='revit_save_command');
  assert.match(save.textContent,/来源所属身份或对话已变化/);
  for(const [key,value] of Object.entries({command_id:'chat-draft',name:'候选',description:'说明'}))ui.get('model-command-revit_save_command-'+key).value=value;
  save.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;save.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,0);
});
