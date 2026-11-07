import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush,UiEvent} from './test-support/model-input-ui-fixture.mjs';
import {modelMentionMatches} from './public/model-workspace.mjs';
import {MODEL_COMMAND_CATALOG} from './lib/model-command-catalog.mjs';
import {PANEL_TOOL_CATALOG} from './lib/panel-catalog.mjs';

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

test('empty and broad searches expose the full registered catalog and keyboard reaches its end',async t=>{
 const tools=Array.from({length:130},(_,i)=>({name:`revit_fixture_${i}`,label:`示例${i}`,readOnly:true}));
 const ui=await setup(t,tools); const picker=ui.get('model-tool-picker'), prompt=ui.get('prompt');
 ui.input('@'); assert.equal(picker.querySelectorAll('.model-tool-option').length,130);
 prompt.dispatchEvent(new UiEvent('keydown',{key:'ArrowUp'}));
 assert.equal(prompt.getAttribute('aria-activedescendant'),'model-tool-option-129');
 prompt.dispatchEvent(new UiEvent('keydown',{key:'Enter'}));
 assert.equal(prompt.value,'@revit_fixture_129 '); assert.equal(ui.requests.length,0);
 ui.input('@fixture'); assert.equal(picker.querySelectorAll('.model-tool-option').length,130);
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

test('group members can be found by English name, initials and label and manually read once',async t=>{
 const tool=PANEL_TOOL_CATALOG.find(item=>item.name==='revit_get_group_members');
 assert.equal(tool?.label,'模型组成员');assert.equal(tool.readOnly,true);
 for(const query of ['revit_get_group_members','ggm','模型组成员'])
   assert.equal(modelMentionMatches([tool],query)[0]?.name,tool.name);
 const ui=await setup(t,[tool]);
 ui.input('@ggm');ui.get('model-tool-picker').querySelectorAll('.model-tool-option')[0].click();
 assert.equal(ui.get('prompt').value,'@revit_get_group_members ');assert.equal(ui.requests.length,0);
 ui.document.body.querySelectorAll('.model-tab')[1].click();
 ui.emit('state',{...state,toolCatalog:[tool],commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===tool.name);
 const search=ui.get('model-command-list').querySelectorAll('.model-command-filter')[0];
 for(const query of ['ggm','group_members','模型组成员']) {search.value=query;search.dispatchEvent(new UiEvent('input'));assert.equal(row.hidden,false,query);}
 search.value='';search.dispatchEvent(new UiEvent('input'));
 assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 ui.get('model-command-revit_get_group_members-group_id').value='9007199254740993';
 row.querySelectorAll('.model-command-run')[0].click();await flush();
 assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/command');
 assert.equal(ui.requests[0].body.commandId,tool.name);assert.equal(ui.requests[0].body.parameters.group_id,'9007199254740993');
 await ui.respond(ui.requests[0],{ok:true,executionId:'group-read'});
});

test('view creation appears in mentions and requires manual confirmation',async t=>{
 for(const [name,label,initials,extra] of [
  ['revit_create_floor_plan_view','创建楼层平面图','cfpv',{level_id:'9007199254740994'}],
  ['revit_create_3d_view','创建等轴测三维视图','c3v',{}],
 ]){
  const tool=PANEL_TOOL_CATALOG.find(item=>item.name===name);assert.equal(tool?.label,label);assert.equal(tool.readOnly,false);
  for(const query of [name,name.replace('revit_',''),initials,label])assert.equal(modelMentionMatches(PANEL_TOOL_CATALOG,query)[0]?.name,name,query);
  const ui=await setup(t,PANEL_TOOL_CATALOG);ui.input('@'+initials);ui.get('model-tool-picker').querySelectorAll('.model-tool-option')[0].click();
  assert.equal(ui.get('prompt').value,'@'+name+' ');assert.equal(ui.requests.length,0);
  ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:[tool],commandCatalog:MODEL_COMMAND_CATALOG});await flush();
  const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);
  row.querySelectorAll('.model-command-apply')[0].click();
  ui.get('model-command-'+name+'-name').value='Example';ui.get('model-command-'+name+'-view_family_type_id').value='9007199254740993';
  if(extra.level_id)ui.get('model-command-'+name+'-level_id').value=extra.level_id;
  row.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,0);
  row.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;row.querySelectorAll('.model-command-run')[0].click();await flush();
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.commandId,name);assert.equal(ui.requests[0].body.confirmed,true);
  assert.equal(ui.requests[0].body.parameters.name,'Example');assert.equal(ui.requests[0].body.parameters.view_family_type_id,'9007199254740993');
  if(extra.level_id)assert.equal(ui.requests[0].body.parameters.level_id,extra.level_id);
  await ui.respond(ui.requests[0],{ok:true,executionId:'view-write'});
 }
});

test('conduit is searchable across the full catalog and its manual form requires confirmation',async t=>{
 const name='revit_create_conduit',tool=PANEL_TOOL_CATALOG.find(item=>item.name===name);
 assert.equal(tool?.label,'创建电气导管');assert.equal(tool.readOnly,false);
 for(const query of [name,'create_conduit','cc','创建电气导管'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(item=>item.name===name),query);
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.input('@create_conduit');const picker=ui.get('model-tool-picker');
 const option=picker.querySelectorAll('.model-tool-option').find(item=>item.textContent.includes(name));assert.ok(option);option.click();
 assert.equal(ui.get('prompt').value,'@'+name+' ');assert.equal(ui.requests.length,0);
 ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);
 row.querySelectorAll('.model-command-apply')[0].click();
 for(const [key,value] of Object.entries({conduit_type_id:'9007199254740993',level_id:'9007199254740994',diameter_mm:'25'}))ui.get('model-command-'+name+'-'+key).value=value;
 for(const [key,point] of Object.entries({start_mm:{x:0,y:2,z:3000},end_mm:{x:1000,y:2,z:3000}}))for(const [axis,value] of Object.entries(point))ui.get('model-command-'+name+'-'+key+'-'+axis).value=String(value);
 row.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,0);
 row.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;row.querySelectorAll('.model-command-run')[0].click();await flush();
 assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.commandId,name);assert.equal(ui.requests[0].body.confirmed,true);
 assert.equal(ui.requests[0].body.parameters.conduit_type_id,'9007199254740993');assert.equal(ui.requests[0].body.parameters.level_id,'9007199254740994');
 assert.deepEqual(ui.requests[0].body.parameters.start_mm,{x:0,y:2,z:3000});assert.deepEqual(ui.requests[0].body.parameters.end_mm,{x:1000,y:2,z:3000});assert.equal(ui.requests[0].body.parameters.diameter_mm,25);
 await ui.respond(ui.requests[0],{ok:true,executionId:'conduit-write'});
});

test('duct is searchable across the full catalog and its manual form requires confirmation',async t=>{
 const name='revit_create_duct',tool=PANEL_TOOL_CATALOG.find(item=>item.name===name);
 assert.equal(tool?.label,'创建直风管');assert.equal(tool.readOnly,false);
 for(const query of [name,'create_duct','cd','创建直风管'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(item=>item.name===name),query);
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.input('@cd');const picker=ui.get('model-tool-picker');
 const option=picker.querySelectorAll('.model-tool-option').find(item=>item.textContent.includes(name));assert.ok(option);option.click();
 assert.equal(ui.get('prompt').value,'@'+name+' ');assert.equal(ui.requests.length,0);
 ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 for(const [key,value] of Object.entries({duct_type_id:'9007199254740993',system_type_id:'9007199254740994',level_id:'9007199254740995'}))ui.get('model-command-'+name+'-'+key).value=value;
 for(const [key,point] of Object.entries({start_mm:{x:0,y:2,z:3000},end_mm:{x:1000,y:2,z:3000}}))for(const [axis,value] of Object.entries(point))ui.get('model-command-'+name+'-'+key+'-'+axis).value=String(value);
 row.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,0);
 row.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;row.querySelectorAll('.model-command-run')[0].click();await flush();
 assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.commandId,name);assert.equal(ui.requests[0].body.confirmed,true);
 assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',duct_type_id:'9007199254740993',system_type_id:'9007199254740994',level_id:'9007199254740995',start_mm:{x:0,y:2,z:3000},end_mm:{x:1000,y:2,z:3000}});
 await ui.respond(ui.requests[0],{ok:true,executionId:'duct-write'});
});


test('sheet is searchable across the full catalog and manual submission requires confirmation',async t=>{
 const name='revit_create_sheet',tool=PANEL_TOOL_CATALOG.find(item=>item.name===name);
 assert.equal(tool?.label,'创建图纸');assert.equal(tool.readOnly,false);
 for(const query of [name,'create_sheet','cs','创建图纸'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(item=>item.name===name),query);
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.input('@cs');const picker=ui.get('model-tool-picker');
 const option=picker.querySelectorAll('.model-tool-option').find(item=>item.textContent.includes(name));assert.ok(option);option.click();
 assert.equal(ui.get('prompt').value,'@'+name+' ');assert.equal(ui.requests.length,0);
 ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 for(const [key,value] of Object.entries({name:'建筑平面',number:'A-101',titleblock_id:'9007199254740993'}))ui.get('model-command-'+name+'-'+key).value=value;
 row.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,0);
 row.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;row.querySelectorAll('.model-command-run')[0].click();await flush();
 assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.commandId,name);assert.equal(ui.requests[0].body.confirmed,true);
 assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',name:'建筑平面',number:'A-101',titleblock_id:'9007199254740993'});
 await ui.respond(ui.requests[0],{ok:true,executionId:'sheet-write'});
});


test('viewport is searchable in the full catalog and manual submission requires one confirmation',async t=>{
 const name='revit_place_viewport_on_sheet',tool=PANEL_TOOL_CATALOG.find(item=>item.name===name);
 assert.equal(tool?.label,'放置视口');assert.equal(tool.readOnly,false);
 for(const query of [name,'place_viewport_on_sheet','pvos','放置视口'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(item=>item.name===name),query);
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.input('@pvos');const picker=ui.get('model-tool-picker');
 const option=picker.querySelectorAll('.model-tool-option').find(item=>item.textContent.includes(name));assert.ok(option);option.click();
 assert.equal(ui.get('prompt').value,'@'+name+' ');assert.equal(ui.requests.length,0);
 ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 for(const [key,value] of Object.entries({sheet_id:'9007199254740993',view_id:'9007199254740994',x_mm:'-20',y_mm:'30'}))ui.get('model-command-'+name+'-'+key).value=value;
 row.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,0);
 row.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;row.querySelectorAll('.model-command-run')[0].click();await flush();
 assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.commandId,name);assert.equal(ui.requests[0].body.confirmed,true);
 assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',sheet_id:'9007199254740993',view_id:'9007199254740994',x_mm:-20,y_mm:30});
 await ui.respond(ui.requests[0],{ok:true,executionId:'viewport-write'});
});

test('view template is searchable and manual submission requires one confirmation',async t=>{
 const name='revit_apply_view_template',tool=PANEL_TOOL_CATALOG.find(item=>item.name===name);
 assert.equal(tool?.label,'应用视图样板');assert.equal(tool.readOnly,false);
 for(const query of [name,'apply_view_template','avt','应用视图样板'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(item=>item.name===name),query);
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.input('@avt');const picker=ui.get('model-tool-picker');
 const option=picker.querySelectorAll('.model-tool-option').find(item=>item.textContent.includes(name));assert.ok(option);option.click();
 assert.equal(ui.get('prompt').value,'@'+name+' ');assert.equal(ui.requests.length,0);
 ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 for(const [key,value] of Object.entries({view_id:'9007199254740993',template_id:'9007199254740994'}))ui.get('model-command-'+name+'-'+key).value=value;
 row.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,0);
 row.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;row.querySelectorAll('.model-command-run')[0].click();await flush();
 assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.commandId,name);assert.equal(ui.requests[0].body.confirmed,true);
 assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',view_id:'9007199254740993',template_id:'9007199254740994'});
 await ui.respond(ui.requests[0],{ok:true,executionId:'view-template-write'});
});

test('window mention and manual form require confirmation and preserve rollback',async t=>{
 const name='revit_place_window',tool=PANEL_TOOL_CATALOG.find(item=>item.name===name);
 assert.equal(tool?.label,'在墙上放置窗');assert.equal(tool.readOnly,false);
 for(const query of [name,'place_window','pw','在墙上放置窗'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(item=>item.name===name),query);
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.input('@pw');const picker=ui.get('model-tool-picker');
 const option=picker.querySelectorAll('.model-tool-option').find(item=>item.textContent.includes(name));assert.ok(option);option.click();
 assert.equal(ui.get('prompt').value,'@'+name+' ');assert.equal(ui.requests.length,0);
 ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 for(const [key,value] of Object.entries({symbol_id:'101',wall_id:'202',level_id:'303'}))ui.get('model-command-'+name+'-'+key).value=value;
 for(const [axis,value] of Object.entries({x:1000,y:0,z:1000}))ui.get('model-command-'+name+'-point_mm-'+axis).value=String(value);
 row.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,0);
 row.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;row.querySelectorAll('.model-command-run')[0].click();await flush();
 assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.commandId,name);assert.equal(ui.requests[0].body.confirmed,true);
 assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',symbol_id:101,wall_id:202,level_id:303,point_mm:{x:1000,y:0,z:1000}});
 await ui.respond(ui.requests[0],{ok:true,executionId:'window-fixture'});
});

test('text note is searchable and manual multiline submission requires confirmation',async t=>{
 const name='revit_create_text_note',tool=PANEL_TOOL_CATALOG.find(item=>item.name===name);
 assert.equal(tool?.label,'创建文字注释');assert.equal(tool.readOnly,false);
 for(const query of [name,'create_text_note','ctn','创建文字注释'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(item=>item.name===name),query);
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.input('@ctn');const picker=ui.get('model-tool-picker');
 const option=picker.querySelectorAll('.model-tool-option').find(item=>item.textContent.includes(name));assert.ok(option);option.click();
 assert.equal(ui.get('prompt').value,'@'+name+' ');assert.equal(ui.requests.length,0);
 ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 assert.equal(ui.get('model-command-'+name+'-text').tagName,'TEXTAREA');
 for(const [key,value] of Object.entries({view_id:'9007199254740993',text_type_id:'9007199254740994',text:'第一行\n第二行'}))ui.get('model-command-'+name+'-'+key).value=value;
 for(const [axis,value] of Object.entries({x:1,y:2,z:3}))ui.get('model-command-'+name+'-point_mm-'+axis).value=String(value);
 row.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,0);
 row.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;row.querySelectorAll('.model-command-run')[0].click();await flush();
 assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.commandId,name);assert.equal(ui.requests[0].body.confirmed,true);
 assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',view_id:'9007199254740993',text_type_id:'9007199254740994',point_mm:{x:1,y:2,z:3},text:'第一行\n第二行'});
 await ui.respond(ui.requests[0],{ok:true,executionId:'text-note-write'});
});

test('section view search and manual form accept exact type and bounded geometry after confirmation',async t=>{
  const name='revit_create_section_view';
  for(const query of [name,'create_section_view','csv','创建剖面视图']){
    assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(tool=>tool.name===name&&tool.readOnly===false),query);
  }
  const ui=await setup(t,PANEL_TOOL_CATALOG);
  ui.input('@csv');
  const option=ui.get('model-tool-picker').querySelectorAll('.model-tool-option').find(item=>item.textContent.includes(name));
  assert.ok(option);option.click();assert.equal(ui.get('prompt').value,'@'+name+' ');
  ui.document.body.querySelectorAll('.model-tab')[1].click();
  ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
  const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);
  assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
  const field=key=>ui.get('model-command-'+name+'-'+key);
  for(const [key,value] of Object.entries({name:'剖面 A',view_family_type_id:'9007199254740993',
    width_mm:2000,height_mm:3200,depth_mm:4000,'origin_mm-x':100,'origin_mm-y':-200,'origin_mm-z':300})){
    field(key).value=String(value);
  }
  const run=row.querySelectorAll('.model-command-run')[0],confirm=row.querySelectorAll('.model-command-confirm')[0].children[0];
  field('angle_degrees').value='360';confirm.checked=true;run.click();await flush();assert.equal(ui.requests.length,0);
  field('angle_degrees').value='225';field('angle_degrees').dispatchEvent(new UiEvent('input'));
  run.click();await flush();assert.equal(ui.requests.length,0);
  confirm.checked=true;run.click();await flush();
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.commandId,name);assert.equal(ui.requests[0].body.confirmed,true);
  assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',name:'剖面 A',view_family_type_id:'9007199254740993',
    origin_mm:{x:100,y:-200,z:300},angle_degrees:225,width_mm:2000,height_mm:3200,depth_mm:4000});
  await ui.respond(ui.requests[0],{ok:true,executionId:'section-write'});
});

test('schedule is searchable and manual form requires confirmation',async t=>{
 const name='revit_create_schedule';for(const query of [name,'create_schedule','创建明细表'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(tool=>tool.name===name&&tool.readOnly===false));
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 ui.get('model-command-'+name+'-name').value='墙明细';ui.get('model-command-'+name+'-category').value='OST_Walls';
 const run=row.querySelectorAll('.model-command-run')[0],confirm=row.querySelectorAll('.model-command-confirm')[0].children[0];run.click();await flush();assert.equal(ui.requests.length,0);
 confirm.checked=true;run.click();await flush();assert.equal(ui.requests.length,1);assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',name:'墙明细',category:'OST_Walls'});await ui.respond(ui.requests[0],{ok:true,executionId:'schedule-write'});
});


test('material is searchable and manual submission needs confirmation',async t=>{
 const name='revit_create_material',tool=PANEL_TOOL_CATALOG.find(item=>item.name===name);
 assert.equal(tool?.label,'创建材质');assert.equal(tool.readOnly,false);
 for(const query of [name,'create_material','cm','创建材质'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(item=>item.name===name),query);
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.input('@create_material');const option=ui.get('model-tool-picker').querySelectorAll('.model-tool-option').find(item=>item.textContent.includes(name));assert.ok(option);option.click();assert.equal(ui.get('prompt').value,'@'+name+' ');
 ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 for(const [key,value] of Object.entries({name:'Test material',red:'12',green:'34',blue:'56',transparency:'25'}))ui.get('model-command-'+name+'-'+key).value=value;
 row.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,0);
 row.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;row.querySelectorAll('.model-command-run')[0].click();await flush();
 assert.equal(ui.requests.length,1);assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',name:'Test material',red:12,green:34,blue:56,transparency:25,shininess:50,smoothness:50});
 await ui.respond(ui.requests[0],{ok:true,executionId:'material-write'});
});

test('change type is searchable and manual form requires confirmation',async t=>{
 const name='revit_change_element_type';for(const query of [name,'change_element_type','更改构件类型'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(tool=>tool.name===name&&tool.readOnly===false));
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();ui.get('model-command-'+name+'-element_id').value='9007199254740993';ui.get('model-command-'+name+'-target_type_id').value='9007199254740994';
 const run=row.querySelectorAll('.model-command-run')[0],confirm=row.querySelectorAll('.model-command-confirm')[0].children[0];run.click();await flush();assert.equal(ui.requests.length,0);confirm.checked=true;run.click();await flush();assert.equal(ui.requests.length,1);assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',element_id:'9007199254740993',target_type_id:'9007199254740994'});await ui.respond(ui.requests[0],{ok:true,executionId:'change-type-write'});
});

test('room mention and manual XY controls require confirmation and preserve parameters',async t=>{
 const name='revit_create_room';
 for(const q of [name,'创建房间'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,q).some(tool=>tool.name===name&&tool.readOnly===false));
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.input('@create_room');
 const option=ui.get('model-tool-picker').querySelectorAll('.model-tool-option').find(item=>item.textContent.includes(name));assert.ok(option);option.click();
 ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 const field=key=>ui.get('model-command-'+name+'-'+key);
 for(const [key,value] of Object.entries({level_id:'3',name:'Office',number:'101','point_xy_mm-x':'100','point_xy_mm-y':'-200'}))field(key).value=value;
 const run=row.querySelectorAll('.model-command-run')[0],confirm=row.querySelectorAll('.model-command-confirm')[0].children[0];
 run.click();await flush();assert.equal(ui.requests.length,0);confirm.checked=true;run.click();await flush();
 assert.equal(ui.requests.length,1);assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',level_id:3,point_xy_mm:{x:100,y:-200},name:'Office',number:'101'});
 await ui.respond(ui.requests[0],{ok:true,executionId:'room-write'});
});

test('group is searchable and manual exact member input requires confirmation',async t=>{
 const name='revit_create_group';for(const query of [name,'create_group','创建模型组'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(tool=>tool.name===name&&tool.readOnly===false));const ui=await setup(t,PANEL_TOOL_CATALOG);ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();ui.get('model-command-'+name+'-name').value='模型组 A';ui.get('model-command-'+name+'-element_ids-list').value='9007199254740993, 9007199254740994';
 const run=row.querySelectorAll('.model-command-run')[0],confirm=row.querySelectorAll('.model-command-confirm')[0].children[0];run.click();await flush();assert.equal(ui.requests.length,0);confirm.checked=true;run.click();await flush();assert.equal(ui.requests.length,1);assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',name:'模型组 A',element_ids:['9007199254740993','9007199254740994']});await ui.respond(ui.requests[0],{ok:true,executionId:'group-write'});
});

test('column mention and manual form require confirmation',async t=>{
 const name='revit_create_column';for(const q of [name,'创建结构柱'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,q).some(x=>x.name===name&&x.readOnly===false));
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.input('@create_column');const option=ui.get('model-tool-picker').querySelectorAll('.model-tool-option').find(x=>x.textContent.includes(name));assert.ok(option);option.click();
 ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(x=>x.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 for(const [k,v] of Object.entries({symbol_id:'3',base_level_id:'1',top_level_id:'2','point_mm-x':'304.8','point_mm-y':'609.6','point_mm-z':'0'}))ui.get('model-command-'+name+'-'+k).value=v;
 const run=row.querySelectorAll('.model-command-run')[0],confirm=row.querySelectorAll('.model-command-confirm')[0].children[0];run.click();await flush();assert.equal(ui.requests.length,0);confirm.checked=true;run.click();await flush();assert.equal(ui.requests.length,1);
 assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',symbol_id:3,base_level_id:1,top_level_id:2,point_mm:{x:304.8,y:609.6,z:0}});await ui.respond(ui.requests[0],{ok:true,executionId:'column-fixture'});
});

test('beam is searchable and manual form requires confirmation',async t=>{
 const name='revit_create_beam';for(const query of [name,'create_beam','创建结构梁'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(tool=>tool.name===name&&tool.readOnly===false));const ui=await setup(t,PANEL_TOOL_CATALOG);ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();const field=key=>ui.get('model-command-'+name+'-'+key);for(const [key,value] of Object.entries({symbol_id:'9007199254740993',level_id:'9007199254740994','start_mm-x':0,'start_mm-y':0,'start_mm-z':100,'end_mm-x':1000,'end_mm-y':0,'end_mm-z':200}))field(key).value=String(value);
 const run=row.querySelectorAll('.model-command-run')[0],confirm=row.querySelectorAll('.model-command-confirm')[0].children[0];run.click();await flush();assert.equal(ui.requests.length,0);confirm.checked=true;run.click();await flush();assert.equal(ui.requests.length,1);assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',symbol_id:'9007199254740993',level_id:'9007199254740994',start_mm:{x:0,y:0,z:100},end_mm:{x:1000,y:0,z:200}});await ui.respond(ui.requests[0],{ok:true,executionId:'beam-write'});
});

test('roof is searchable and manual XY form requires confirmation',async t=>{
 const name='revit_create_roof';for(const query of [name,'create_roof','创建矩形平屋顶'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(tool=>tool.name===name&&tool.readOnly===false));const ui=await setup(t,PANEL_TOOL_CATALOG);ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();const field=key=>ui.get('model-command-'+name+'-'+key);for(const [key,value] of Object.entries({roof_type_id:'9007199254740993',level_id:'9007199254740994','origin_xy_mm-x':0,'origin_xy_mm-y':100,width_mm:3000,depth_mm:2000}))field(key).value=String(value);
 const run=row.querySelectorAll('.model-command-run')[0],confirm=row.querySelectorAll('.model-command-confirm')[0].children[0];run.click();await flush();assert.equal(ui.requests.length,0);confirm.checked=true;run.click();await flush();assert.equal(ui.requests.length,1);assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',roof_type_id:'9007199254740993',level_id:'9007199254740994',origin_xy_mm:{x:0,y:100},width_mm:3000,depth_mm:2000});await ui.respond(ui.requests[0],{ok:true,executionId:'roof-write'});
});

test('material assignment has searchable guarded manual form',async t=>{
 const name='revit_set_element_material',tool=PANEL_TOOL_CATALOG.find(item=>item.name===name);assert.equal(tool?.label,'设置构件材质');assert.equal(tool.readOnly,false);
 for(const query of [name,'set_element_material','sem','设置构件材质'])assert.ok(modelMentionMatches(PANEL_TOOL_CATALOG,query).some(item=>item.name===name),query);
 const ui=await setup(t,PANEL_TOOL_CATALOG);ui.document.body.querySelectorAll('.model-tab')[1].click();ui.emit('state',{...state,toolCatalog:PANEL_TOOL_CATALOG,commandCatalog:MODEL_COMMAND_CATALOG});await flush();
 const row=ui.get('model-command-list').querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);row.querySelectorAll('.model-command-apply')[0].click();
 for(const [key,value] of Object.entries({element_id:'101',parameter_id:'-123',material_id:'202',expected_has_value:'true',expected_value_internal:'-1'}))ui.get('model-command-'+name+'-'+key).value=value;
 row.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,0);
 row.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;row.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,1);
 assert.deepEqual(ui.requests[0].body.parameters,{mode:'rollback',element_id:101,parameter_id:-123,material_id:202,expected_has_value:true,expected_value_internal:-1});
 await ui.respond(ui.requests[0],{ok:true,executionId:'assignment-write'});
});
