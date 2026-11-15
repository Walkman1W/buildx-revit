import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session} from '../test-support/model-input-ui-fixture.mjs';
import {createModelWorkspaceSessionProfile} from '../lib/codex-profile.mjs';

for(const kind of ['csharp','sequence'])test(`creating ${kind} keeps its chosen type in the new conversation without running it`,async t=>{
  const ui=await createInputUi({layout:false});t.after(()=>ui.close());
  const started=[];ui.window.addEventListener('buildx-command-authoring-started',event=>started.push(event.detail));
  await ui.intent('buildx-create-command',{kind});assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/new-chat');
  await ui.respond(ui.requests[0],{ok:true,busy:false,session:session('authoring-'+kind),draft:{text:'',includeSelection:false},history:{available:true,activeId:'authoring-'+kind}});
  assert.match(ui.get('prompt').value,kind==='sequence'?/个人命令（只读步骤）/:/个人命令（C#）/);
  assert.match(ui.get('prompt').value,/不要自动执行/);assert.equal(started.length,1);assert.equal(started[0].kind,kind);
  if(kind==='csharp')assert.match(ui.get('prompt').value,/下拉选择.*中文名称和单位/);
  assert.equal(ui.requests.some(request=>request.url==='/api/turn'),false);
});

test('unsupported file command kinds do not create a conversation or alter a draft',async t=>{
  const ui=await createInputUi({layout:false});t.after(()=>ui.close());ui.input('原有草稿');
  for(const kind of ['dll','dynamo','unexpected','',null,{}])await ui.intent('buildx-create-command',{kind});
  assert.equal(ui.requests.length,0);assert.equal(ui.get('prompt').value,'原有草稿');
});

test('the real authoring profile describes supported kinds and typed parameter dropdown metadata',()=>{
  const instructions=createModelWorkspaceSessionProfile(process.cwd()).buildInstructions();
  for(const text of ['只读步骤命令','DLL 和 Dynamo','parameter_options','kind:"enum"','kind:"model"','source:"level_id"','不根据参数名猜用途','准确 revision'])assert.ok(instructions.includes(text),text);
});
