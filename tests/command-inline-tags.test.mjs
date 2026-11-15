import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush,UiEvent} from '../test-support/model-input-ui-fixture.mjs';
import {MODEL_COMMAND_CATALOG} from '../lib/model-command-catalog.mjs';

const state={workspace:{kind:'model',supportsModelContext:true},ready:false,commandsReady:true,commandReadiness:'local',directCommandsAvailable:true,commandCatalog:MODEL_COMMAND_CATALOG,historyAvailable:true,account:{required:false},connectionGeneration:1,codexAccount:{accountRevision:1,status:'unavailable'}};
const record=(id,name)=>({command_id:id,name,description:'自定义命令',revision:'a'.repeat(64),verification:{status:'unverified',evidence:[]}});
async function setup(t){const ui=await createInputUi();t.after(()=>ui.close());ui.emit('state',state);ui.emit('conversation',{busy:false,session:session()});await flush();return ui;}
const row=(ui,id)=>ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===id);
function showSaved(ui,commands){ui.emit('conversation',{busy:false,session:session(),command:{commandId:'revit_list_commands',conversationId:'chat-a',executionId:'list-1',status:'completed',result:{data:{value:{commands,total:commands.length,offset:0,limit:20,has_more:false}}}}});}
function search(ui,value){const input=ui.document.body.querySelectorAll('.model-command-filter')[0];input.value=value;input.dispatchEvent(new UiEvent('input'));}

test('commands share one page with inline system and personal labels and a create entry',async t=>{
  const ui=await setup(t);ui.document.body.querySelectorAll('.model-tab').find(tab=>tab.textContent==='命令').click();
  showSaved(ui,[record('notes','参数备注')]);
  assert.equal(ui.document.body.querySelectorAll('.command-categories').length,0);assert.equal(ui.document.body.querySelectorAll('.command-category').length,0);
  const system=row(ui,'revit_set_parameters'),list=row(ui,'revit_list_commands'),personal=list.querySelectorAll('.model-command-stored-version')[0];
  assert.equal(system.hidden,false);assert.equal(list.hidden,false);assert.equal(personal.hidden,false);
  const systemName=system.querySelectorAll('.command-name')[0],personalName=personal.querySelectorAll('.command-name')[0];
  assert.equal(systemName.children[0].textContent,'批量修改实例参数');assert.equal(systemName.children[1].textContent,'系统');
  assert.equal(personalName.children[0].textContent,'参数备注');assert.equal(personalName.children[1].textContent,'个人');
  assert.equal(personalName.children[1].tagName,'SPAN');assert.equal(ui.get('model-create-command').textContent.includes('创建命令'),true);
  assert.equal(ui.requests.length,0,'opening commands must not repeatedly query or run any command');
});

test('one search matches system names and personal saved names without switching category',async t=>{
  const ui=await setup(t);showSaved(ui,[record('notes','参数备注'),record('floors','楼板统计')]);
  search(ui,'参数');
  assert.equal(row(ui,'revit_set_parameters').hidden,false);assert.equal(row(ui,'revit_list_commands').hidden,false);
  const personal=row(ui,'revit_list_commands').querySelectorAll('.model-command-stored-version');
  assert.equal(personal[0].hidden,false);assert.equal(personal[1].hidden,true);
  search(ui,'楼板统计');assert.equal(row(ui,'revit_set_parameters').hidden,true);assert.equal(row(ui,'revit_list_commands').hidden,false);assert.equal(personal[1].hidden,false);
  search(ui,'');assert.equal(row(ui,'revit_set_parameters').hidden,false);assert.ok(personal.every(item=>!item.hidden));
});

test('viewed and selected personal versions keep their badge and creating a command still opens a fresh session',async t=>{
  const ui=await setup(t),saved={...record('notes','参数备注'),code:'return 1;'};
  ui.emit('conversation',{busy:false,session:session(),command:{commandId:'revit_get_command',conversationId:'chat-a',executionId:'get-1',status:'completed',result:{data:{value:saved}}}});
  const viewed=row(ui,'revit_get_command');assert.equal(viewed.querySelectorAll('.model-command-result')[0].querySelectorAll('.command-origin-personal')[0].textContent,'个人');
  viewed.querySelectorAll('.model-command-version-choose')[0].click();await flush();
  assert.equal(row(ui,'revit_run_command').querySelectorAll('.personal-command-selected')[0].querySelectorAll('.command-origin-personal')[0].textContent,'个人');
  let create=0;ui.window.addEventListener('buildx-create-command',()=>create++);ui.get('model-create-command').click();await flush();assert.equal(create,1);
  assert.equal(ui.requests.at(-1).url,'/api/new-chat');await ui.respond(ui.requests.at(-1),{ok:true,session:session('fresh-command')});assert.match(ui.get('prompt').value,/创建一个个人命令/);
});
