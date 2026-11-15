import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush,UiEvent} from '../test-support/model-input-ui-fixture.mjs';
import {createModelWorkspaceSessionProfile,createReadonlyWorkbenchSessionProfile} from '../lib/codex-profile.mjs';

async function setup(t,options){const ui=await createInputUi({layout:false,...options});t.after(()=>ui.close());return ui;}
const newSession=id=>({ok:true,busy:false,session:session(id),draft:{text:'',includeSelection:false},history:{available:true,activeId:id}});
function observeStarts(ui){const starts=[];ui.window.addEventListener('buildx-command-authoring-started',event=>starts.push(event.detail));return starts;}

test('create-command uses a fresh conversation, saves the previous draft and never submits a model turn',async t=>{
  const ui=await setup(t),starts=observeStarts(ui);
  ui.input('原对话未发送的需求');ui.get('include-selection').checked=true;ui.get('include-document').checked=true;
  await ui.intent('buildx-create-command');
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/new-chat');
  assert.deepEqual(ui.requests[0].body.draft,{text:'原对话未发送的需求',includeSelection:true});
  assert.equal(starts.length,0);assert.equal(ui.get('prompt').value,'原对话未发送的需求');
  await ui.respond(ui.requests[0],newSession('command-a'));
  assert.match(ui.get('prompt').value,/我想创建一个个人命令/);assert.match(ui.get('prompt').value,/不要自动执行/);
  assert.equal(ui.get('include-selection').checked,false);assert.equal(ui.get('include-document').checked,false);
  assert.equal(starts.length,1);assert.equal(starts[0].conversationId,'command-a');
  assert.equal(ui.requests.some(request=>request.url==='/api/turn'),false);
  await ui.intent('buildx-history-select',{conversationId:'chat-a'});
  const restore=ui.requests.at(-1);assert.equal(restore.url,'/api/chat/select');
  await ui.respond(restore,{...newSession('chat-a'),draft:{text:'服务器较早草稿',includeSelection:false}});
  assert.equal(ui.get('prompt').value,'原对话未发送的需求');assert.equal(ui.get('include-selection').checked,true);
});

test('command creation waits for an owned draft save and retains the atomic new-chat draft payload',async t=>{
  const ui=await setup(t),starts=observeStarts(ui);
  ui.input('待保存草稿');ui.get('prompt').dispatchEvent(new UiEvent('blur'));await flush();
  assert.equal(ui.requests[0].url,'/api/chat/draft');
  await ui.intent('buildx-create-command');assert.equal(ui.requests.length,1);assert.equal(ui.get('prompt').readOnly,true);
  ui.emit('conversation',{busy:false,session:session(),draft:{text:'较早的保存',includeSelection:false}});
  await ui.respond(ui.requests[0]);
  assert.equal(ui.requests[1].url,'/api/new-chat');assert.equal(ui.requests[1].body.draft.text,'待保存草稿');
  await ui.respond(ui.requests[1],newSession('command-b'));
  assert.equal(starts.length,1);assert.match(ui.get('prompt').value,/个人命令/);
  assert.equal(ui.requests.some(request=>request.url==='/api/turn'),false);
});

test('a new-session SSE starts authoring once and a late HTTP acknowledgement preserves later edits',async t=>{
  const ui=await setup(t),starts=observeStarts(ui);
  ui.input('保留原草稿');await ui.intent('buildx-create-command');const request=ui.requests[0];
  ui.emit('conversation',newSession('command-sse'));await flush();
  assert.equal(starts.length,1);assert.equal(starts[0].conversationId,'command-sse');
  ui.input('我想创建一个个人命令：统计当前楼层门窗数量');
  await ui.respond(request,newSession('command-sse'));
  assert.equal(starts.length,1);assert.equal(ui.get('prompt').value,'我想创建一个个人命令：统计当前楼层门窗数量');
  assert.equal(ui.requests.some(item=>item.url==='/api/turn'),false);
});

test('creation failures preserve the draft, selection and prior session without starting authoring',async t=>{
  const ui=await setup(t),starts=observeStarts(ui);
  ui.input('失败也保留');ui.get('include-selection').checked=true;
  await ui.intent('buildx-create-command');await ui.reject(ui.requests[0],'新对话保存失败');
  assert.equal(ui.get('prompt').value,'失败也保留');assert.equal(ui.get('include-selection').checked,true);
  assert.equal(ui.view().commandConversationId,'chat-a');assert.equal(starts.length,0);
  assert.equal(ui.get('error-notice').textContent,'新对话保存失败');
  assert.equal(ui.get('new-chat').disabled,false);assert.equal(ui.requests.some(item=>item.url==='/api/turn'),false);
});

test('a response without a fresh empty session cannot overwrite the previous composer',async t=>{
  const ui=await setup(t),starts=observeStarts(ui);ui.input('不能覆盖原草稿');
  for(const result of [{ok:true},newSession('chat-a'),{...newSession('not-empty'),session:session('not-empty',[{id:'existing',role:'user',text:'既有对话',tools:[]}])}]){
    await ui.intent('buildx-create-command');await ui.respond(ui.requests.at(-1),result);
    assert.equal(ui.get('prompt').value,'不能覆盖原草稿');assert.equal(ui.view().commandConversationId,'chat-a');
  }
  assert.equal(starts.length,0);assert.match(ui.get('error-notice').textContent,/新对话尚未确认/);
});

test('duplicate and busy authoring intents cannot create parallel sessions',async t=>{
  const ui=await setup(t);await ui.intent('buildx-create-command');await ui.intent('buildx-create-command');
  ui.get('new-chat').click();await flush();assert.equal(ui.requests.length,1);
  await ui.respond(ui.requests[0],newSession('one-authoring-session'));
  ui.emit('conversation',{busy:true,session:session('one-authoring-session')});await ui.intent('buildx-create-command');
  assert.equal(ui.requests.length,1);
});

test('restricted workspaces ignore command creation and old-account acknowledgements cannot initialize it',async t=>{
  const restricted=await setup(t,{kind:'source-development'});await restricted.intent('buildx-create-command');assert.equal(restricted.requests.length,0);
  const ui=await setup(t),starts=observeStarts(ui);await ui.intent('buildx-create-command');const stale=ui.requests[0];
  await ui.close();await ui.respond(stale,newSession('old-account-new-session'));
  assert.equal(starts.length,0);assert.doesNotMatch(ui.get('prompt').value,/个人命令/);
});

test('model sessions without history still create commands and keep the old draft locally',async t=>{
  const ui=await setup(t),starts=observeStarts(ui);
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,historyAvailable:false});
  ui.input('未开启历史时的原草稿');ui.get('include-selection').checked=true;
  await ui.intent('buildx-create-command');assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/new-chat');
  assert.equal(Object.hasOwn(ui.requests[0].body,'draft'),false);
  await ui.respond(ui.requests[0],{ok:true,busy:false,session:session('authoring-without-history')});
  assert.equal(starts.length,1);assert.equal(starts[0].conversationId,'authoring-without-history');
  assert.match(ui.get('prompt').value,/个人命令/);assert.equal(ui.get('include-selection').checked,false);
  assert.match(ui.get('error-notice').textContent,/原草稿保留在当前页面/);
  assert.equal(ui.requests.some(item=>item.url==='/api/turn'),false);
  // If the service subsequently enables history, the existing draft owner can
  // recover the retained text rather than replacing it with a server fallback.
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,historyAvailable:true});
  ui.emit('conversation',{...newSession('chat-a'),draft:{text:'服务器旧文本',includeSelection:false}});await flush();
  assert.equal(ui.get('prompt').value,'未开启历史时的原草稿');assert.equal(ui.get('include-selection').checked,true);
});

test('without history, edits made while creation waits are not replaced by the starter text',async t=>{
  const ui=await setup(t),starts=observeStarts(ui);
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,historyAvailable:false});
  ui.input('原草稿');await ui.intent('buildx-create-command');ui.input('等待期间补充的需求');
  await ui.respond(ui.requests[0],{ok:true,busy:false,session:session('authoring-newer-input')});
  assert.equal(starts.length,1);assert.equal(ui.get('prompt').value,'等待期间补充的需求');
  assert.equal(ui.requests.some(item=>item.url==='/api/turn'),false);
});

test('the actual model profile teaches personal command creation through the existing save contract',()=>{
  const profile=createModelWorkspaceSessionProfile(process.cwd()),instructions=profile.buildInstructions();
  for(const text of ['起草个人命令','自然对话','必要输入','适用模型','操作范围','C# 方法体或只读 steps 和 parameters 类型声明','buildx_model_operation_schema({tool:"revit_save_command"})','用户确认保存后','准确 revision','未执行不得声称已验证','不授权运行它','明确授权','rollback'])assert.ok(instructions.includes(text),text);
  assert.equal(profile.toolNames.includes('revit_save_command'),false);
  assert.equal(profile.dynamicTools.filter(tool=>tool.name==='buildx_model_operation').length,1);
  const readonly=createReadonlyWorkbenchSessionProfile(process.cwd());
  assert.equal(readonly.toolNames.includes('revit_save_command'),false);
  assert.match(readonly.buildInstructions(),/禁止.*命令保存与运行/);
});
