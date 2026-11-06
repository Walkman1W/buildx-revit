import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush,UiEvent} from './test-support/model-input-ui-fixture.mjs';
import {modelMentionMatches} from './public/model-workspace.mjs';
import {MODEL_COMMAND_CATALOG} from './lib/model-command-catalog.mjs';

const catalog=[{name:'revit_get_sheets',label:'图纸列表',readOnly:true},{name:'revit_get_schedule_data',label:'明细表数据',readOnly:true},{name:'revit_create_schedule',label:'创建明细表',readOnly:false}];
const state={workspace:{kind:'model',supportsModelContext:true},ready:true,commandsReady:true,directCommandsAvailable:true,historyAvailable:true,account:{required:false},connectionGeneration:1,codexAccount:{accountRevision:1,status:'unavailable'}};
async function setup(t,tools=catalog){const ui=await createInputUi();t.after(()=>ui.close());ui.emit('state',{...state,toolCatalog:tools});ui.emit('conversation',{busy:false,session:session()});await flush();return ui;}

test('mention ranking handles full name, label, operation token and initials',()=>{
 assert.equal(modelMentionMatches(catalog,'gsd')[0].name,'revit_get_schedule_data');
 assert.equal(modelMentionMatches(catalog,'schedule_data')[0].name,'revit_get_schedule_data');
 assert.equal(modelMentionMatches(catalog,'明细表数据')[0].name,'revit_get_schedule_data');
 assert.equal(modelMentionMatches(catalog,'REVIT_GET_SCHEDULE_DATA')[0].name,'revit_get_schedule_data');
 assert.equal(modelMentionMatches(catalog,'no-such-tool').length,0);
});

test('dynamic AEC catalog supports keyboard navigation and click insertion without sending',async t=>{
 const extra=Array.from({length:130},(_,i)=>({name:`revit_fixture_${i}`,label:`示例${i}`,readOnly:true}));
 const ui=await setup(t,[...extra,...catalog]);
 ui.input('@gsd');const picker=ui.get('model-tool-picker');assert.equal(picker.hidden,false);assert.match(picker.textContent,/revit_get_schedule_data/);
 const prompt=ui.get('prompt');prompt.dispatchEvent(new UiEvent('keydown',{key:'Enter'}));assert.equal(prompt.value,'@revit_get_schedule_data ');assert.equal(ui.requests.length,0);
 ui.input('@schedule');const options=picker.querySelectorAll('.model-tool-option');assert.equal(options.length,2);
 prompt.dispatchEvent(new UiEvent('keydown',{key:'ArrowDown'}));assert.equal(prompt.getAttribute('aria-activedescendant'),'model-tool-option-1');
 prompt.dispatchEvent(new UiEvent('keydown',{key:'Enter'}));assert.equal(prompt.value,'@revit_create_schedule ');assert.equal(ui.requests.length,0);
 ui.input('@明细表数据');picker.querySelectorAll('.model-tool-option')[0].click();assert.equal(prompt.value,'@revit_get_schedule_data ');assert.equal(ui.requests.length,0);
});

test('command bar click dispatches the new AEC revision read through the existing request path',async t=>{
 const ui=await setup(t);ui.document.body.querySelectorAll('.model-tab')[1].click();
 ui.emit('state',{...state,toolCatalog:catalog,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const list=ui.get('model-command-list');const row=list.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='revit_get_revision_sequences');
 assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 row.querySelectorAll('.model-command-run')[0].click();await flush();
 assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/command');assert.equal(ui.requests[0].body.commandId,'revit_get_revision_sequences');
 await ui.respond(ui.requests[0],{ok:true,executionId:'fixture-read'});
});
