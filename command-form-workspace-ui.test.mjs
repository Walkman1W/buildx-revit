import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush,UiEvent} from './test-support/model-input-ui-fixture.mjs';
import {MODEL_COMMAND_CATALOG} from './lib/model-command-catalog.mjs';

const state={workspace:{kind:'model',supportsModelContext:true},ready:false,commandsReady:true,commandReadiness:'local',directCommandsAvailable:true,commandCatalog:MODEL_COMMAND_CATALOG,historyAvailable:true,account:{required:false},connectionGeneration:1,codexAccount:{accountRevision:1,status:'unavailable'}};
const source={session:'form-host',title:'模型A',path:'D:/samples/A.rvt'};
const selection=(executionId='read-1')=>({commandId:'selection',conversationId:'chat-a',executionId,status:'completed',result:{hostSession:source.session,document:{title:source.title,path:source.path},data:{items:[{element_id:'42',name:'墙'}],total:1,returned:1,truncated:false}}});
async function setup(t){const ui=await createInputUi();t.after(()=>ui.close());ui.emit('state',state);ui.emit('conversation',{busy:false,session:session()});await flush();return ui;}
const row=(ui,id)=>ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===id);
async function readSelection(ui){row(ui,'revit_move_elements').querySelectorAll('.command-choice-read')[0].click();await flush();const request=ui.requests.at(-1);await ui.respond(request,{ok:true,executionId:'read-1'});ui.emit('conversation',{busy:false,session:session(),command:selection()});await flush();return request;}

test('real alias string IDs become exact typed move inputs with their source through the composer',async t=>{
  const ui=await setup(t);await readSelection(ui);
  for(const [axis,value] of Object.entries({x:'125.5',y:'0',z:'-20'})){const control=ui.get('model-command-revit_move_elements-delta_mm-'+axis);control.value=value;control.dispatchEvent(new UiEvent('input'));}
  const item=row(ui,'revit_move_elements');item.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;item.querySelectorAll('.model-command-run')[0].click();await flush();
  const write=ui.requests.at(-1);assert.equal(write.body.commandId,'revit_move_elements');assert.deepEqual(write.body.parameters.element_ids,[42]);assert.deepEqual(write.body.parameters.delta_mm,{x:125.5,y:0,z:-20});assert.deepEqual(write.body.sourceDocument,source);
  assert.equal(ui.requests.some(request=>request.url==='/api/turn'),false);await ui.respond(write,{ok:true,executionId:'move-1'});
});

test('a rejected repeat read releases its local pending state instead of accepting the restored old result',async t=>{
  const ui=await setup(t);await readSelection(ui);const item=row(ui,'revit_move_elements');
  item.querySelectorAll('.command-choice-read')[0].click();await flush();await ui.respond(ui.requests.at(-1),{error:'连接状态已变化'},false);
  assert.match(item.textContent,/本次读取未被接受/);assert.equal(ui.get('model-command-revit_move_elements-element_ids-choice').value,'');
  item.querySelectorAll('.model-command-run')[0].click();await flush();assert.doesNotMatch(item.querySelectorAll('.model-command-error')[0].textContent,/等待读取/);
});

test('catalog rebuilding clears a sourced choice rather than silently converting it to a manual ID',async t=>{
  const ui=await setup(t);await readSelection(ui);assert.equal(ui.get('model-command-revit_move_elements-element_ids-choice').value,'[42]');
  const changed=MODEL_COMMAND_CATALOG.map(command=>command.id==='revit_move_elements'?{...command,label:'移动构件'}:command);
  ui.emit('state',{...state,commandCatalog:changed});await flush();assert.equal(ui.get('model-command-revit_move_elements-element_ids-choice').value,'');
});

test('personal command parameters come from the complete viewed revision and keep typed values',async t=>{
  const ui=await setup(t),revision='a'.repeat(64),record={command_id:'sample',revision,name:'批量备注',description:'修改备注',code:'return parameters;',parameters:{count:'integer',enabled:'boolean',note:'string'}};
  ui.emit('conversation',{busy:false,session:session(),command:{commandId:'revit_get_command',conversationId:'chat-a',executionId:'get-1',status:'completed',result:{data:{value:record}}}});
  row(ui,'revit_get_command').querySelectorAll('.model-command-version-choose')[0].click();await flush();
  for(const [key,value] of Object.entries({count:'4',enabled:'false',note:'文字'})){const control=ui.get('model-command-revit_run_command-parameters-'+key);control.value=value;control.dispatchEvent(new UiEvent('input'));}
  const run=row(ui,'revit_run_command');run.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;run.querySelectorAll('.model-command-run')[0].click();await flush();
  const request=ui.requests.at(-1);assert.equal(request.body.commandId,'revit_run_command');assert.equal(request.body.parameters.revision,revision);assert.deepEqual(request.body.parameters.parameters,{count:4,enabled:false,note:'文字'});await ui.respond(request,{ok:true,executionId:'personal-run'});
});
