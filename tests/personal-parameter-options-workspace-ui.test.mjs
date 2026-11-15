import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush,UiEvent} from '../test-support/model-input-ui-fixture.mjs';
import {MODEL_COMMAND_CATALOG} from '../lib/model-command-catalog.mjs';

const state={workspace:{kind:'model',supportsModelContext:true},ready:false,commandsReady:true,commandReadiness:'local',directCommandsAvailable:true,commandCatalog:MODEL_COMMAND_CATALOG,historyAvailable:true,account:{required:false},connectionGeneration:1,codexAccount:{accountRevision:1,status:'unavailable'}};
const source={session:'form-host',title:'模型A',path:'D:/samples/A.rvt'};
const row=(ui,id)=>ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===id);
const choose=(ui,name,value)=>{const control=ui.get('model-command-revit_run_command-parameters-'+name);control.value=value;control.dispatchEvent(new UiEvent('change'));};
const revision='b'.repeat(64);
const record={schema_version:5,command_id:'place-demo',revision,name:'按标高布置',description:'固定选项和标高选择',code:'return parameters;',parameters:{arrangement:'string',targetLevel:'integer'},parameter_labels:{arrangement:'布置方向',targetLevel:'放置标高'},parameter_options:{arrangement:{kind:'enum',values:['横向','纵向']},targetLevel:{kind:'model',source:'level_id'}}};
async function setup(t,command=record){
  const ui=await createInputUi();t.after(()=>ui.close());ui.emit('state',state);ui.emit('conversation',{busy:false,session:session()});await flush();
  ui.emit('conversation',{busy:false,session:session(),command:{commandId:'revit_get_command',conversationId:'chat-a',executionId:'get-1',status:'completed',result:{data:{value:command}}}});
  row(ui,'revit_get_command').querySelectorAll('.model-command-version-choose')[0].click();await flush();return ui;
}
function emitRead(ui,commandId,executionId,document=source){
  ui.emit('conversation',{busy:false,session:session(),command:{commandId,conversationId:'chat-a',executionId,status:'completed',result:{hostSession:document.session,document:{title:document.title,path:document.path},data:{items:[{element_id:'42',name:'首层'},{element_id:'84',name:'二层'}],total:2,returned:2,truncated:false}}}});
}

test('a viewed personal revision uses enum and model dropdowns to send typed values and exact source with the real composer',async t=>{
  const ui=await setup(t),run=row(ui,'revit_run_command');
  assert.equal(ui.get('model-command-revit_run_command-parameters-arrangement').tagName,'SELECT');assert.match(run.textContent,/布置方向/);assert.match(run.textContent,/放置标高/);
  choose(ui,'arrangement','纵向');run.querySelectorAll('.command-choice-read')[0].click();await flush();
  const read=ui.requests.at(-1);assert.equal(read.url,'/api/command');assert.equal(read.body.commandId,'levels');await ui.respond(read,{ok:true,executionId:'levels-1'});
  emitRead(ui,'levels','levels-1');await flush();choose(ui,'targetLevel-choice','84');
  run.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;run.querySelectorAll('.model-command-run')[0].click();await flush();
  const request=ui.requests.at(-1);assert.equal(request.body.commandId,'revit_run_command');assert.equal(request.body.parameters.command_id,record.command_id);assert.equal(request.body.parameters.revision,revision);
  assert.deepEqual(request.body.parameters.parameters,{arrangement:'纵向',targetLevel:84});assert.deepEqual(request.body.sourceDocument,source);assert.equal(request.body.parameters.mode,'rollback');
  assert.equal(ui.requests.some(item=>item.url==='/api/turn'),false);await ui.respond(request,{ok:true,executionId:'personal-run'});
});

test('out-of-range values never submit a personal run',async t=>{
  const ui=await setup(t),run=row(ui,'revit_run_command');choose(ui,'arrangement','未声明的选择');
  const level=ui.get('model-command-revit_run_command-parameters-targetLevel');level.value='42';level.dispatchEvent(new UiEvent('input'));
  run.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;run.querySelectorAll('.model-command-run')[0].click();await flush();
  assert.equal(ui.requests.length,0);assert.match(run.querySelectorAll('.model-command-error')[0].textContent,/可选项/);
});

test('personal model selectors from different documents fail before the real run request',async t=>{
  const selected={...record,parameters:{level:'integer',wall:'integer'},parameter_labels:{level:'放置标高',wall:'墙类型'},parameter_options:{level:{kind:'model',source:'level_id'},wall:{kind:'model',source:'wall_type_id'}}};
  const ui=await setup(t,selected),run=row(ui,'revit_run_command'),reads=run.querySelectorAll('.command-choice-read');
  reads[0].click();await flush();await ui.respond(ui.requests.at(-1),{ok:true,executionId:'levels-1'});emitRead(ui,'levels','levels-1');await flush();choose(ui,'level-choice','42');
  reads[1].click();await flush();await ui.respond(ui.requests.at(-1),{ok:true,executionId:'walls-1'});emitRead(ui,'revit_list_family_types','walls-1',{...source,path:'D:/samples/B.rvt',title:'模型B'});await flush();choose(ui,'wall-choice','84');
  run.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;run.querySelectorAll('.model-command-run')[0].click();await flush();
  assert.equal(ui.requests.length,2);assert.equal(ui.requests.some(item=>item.body.commandId==='revit_run_command'),false);assert.match(run.querySelectorAll('.model-command-error')[0].textContent,/不同模型/);
});
