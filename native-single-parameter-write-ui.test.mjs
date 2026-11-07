import test from 'node:test';
import assert from 'node:assert/strict';
import {createParameterChangeField,parameterInputKind,parameterExpectedState} from './public/parameter-change-field.mjs';
import {NATIVE_PARAMETER_WRITE_TOOLS,assertNativeParameterWriteArguments} from './lib/native-parameter-writes.mjs';
import {MODEL_COMMAND_CATALOG} from './lib/model-command-catalog.mjs';
import {createInputUi,session,flush,UiEvent} from './test-support/model-input-ui-fixture.mjs';

const name='revit_set_parameter_value',sourceId='9007199254740993',parameterId='-9223372036854775808';
const rule=NATIVE_PARAMETER_WRITE_TOOLS[0].inputSchema.properties.changes;
const source={hostSession:'guarded-ui-host',document:{title:'实例参数样例',path:'D:\\guarded-ui.rvt'}};
const parameter=(patch={})=>({parameter_id:parameterId,name:'备注',storage_type:'String',is_read_only:false,
  has_value:true,value_internal:' 原始文本 ',value_display:'本地显示',data_type:null,unit_type:null,...patch});
class Node {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.events=new Map();this.value='';this.disabled=false;this.hidden=false;this._text='';}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];this._text='';}
  addEventListener(type,fn){const list=this.events.get(type)||[];list.push(fn);this.events.set(type,list);}
  dispatchEvent(event){for(const fn of this.events.get(event.type)||[])fn(event);return true;}
  setAttribute(key,value){this[key]=String(value);}
  focus(){this.focused=true;}
  click(){this.dispatchEvent(new UiEvent('click'));}
  get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
  set textContent(value){this.children=[];this._text=String(value);}
}
function fixture({legacy=false,changeRule=rule,maxChanges=1}={}){
  let state={accountEpoch:1,contextEpoch:1,commandIdentityKey:'owner-a',commandConversationId:'chat-a',commands:[]},sequence=0;
  const calls=[],editor=createParameterChangeField({document:{createElement:tag=>new Node(tag)},Event:UiEvent,id:'guarded',onCommand:detail=>calls.push(detail),
    ...legacy?{}:{rule:changeRule,maxChanges,exactIds:true}});
  editor.update(state);
  const find=(node,id)=>node.id===id?node:node.children.map(child=>find(child,id)).find(Boolean),get=suffix=>find(editor.element,'guarded-'+suffix);
  const update=patch=>{state={...state,...patch};editor.update(state);};
  const complete=(commandId,result)=>update({commands:[...state.commands.filter(item=>item.commandId!==commandId),{commandId,status:'completed',executionId:'read-'+(++sequence),result}]});
  const selection=(items=[{element_id:sourceId,name:'墙实例',is_type:false}],identity=source)=>{get('read-selection').click();complete('selection',{...identity,data:{items,total:items.length}});};
  const describe=(parameters,identity=source)=>{get('read-parameters').click();const request=calls.at(-1);complete(request.commandId,{...identity,data:{value:{element_id:request.parameters.element_id,parameters}}});};
  const change=(suffix,value,event='change')=>{const node=get(suffix);node.value=String(value);node.dispatchEvent(new UiEvent(event));};
  const choose=(id,value,suffix='value')=>{change('parameter',id);change(suffix,value,'input');get('add').click();};
  return {editor,calls,get,update,complete,selection,describe,change,choose};
}

test('expected state retains the four original raw facts without display or unit interpretation',()=>{
  for(const observed of [parameter(),parameter({has_value:false,value_internal:null}),parameter({value_internal:''}),
    parameter({storage_type:'Integer',value_internal:0,data_type:''}),parameter({storage_type:'Double',value_internal:2,data_type:'autodesk.spec.aec:length-2.0.0'})]){
    const before=structuredClone(observed),state=parameterExpectedState(observed);
    assert.deepEqual(state,{storage_type:observed.storage_type,has_value:observed.has_value,value_internal:observed.value_internal,data_type:observed.data_type});
    assert.deepEqual(observed,before);assert.notEqual(state,observed);
  }
  for(const patch of [{has_value:1},{has_value:false,value_internal:'not null'},{storage_type:'ElementId'},
    {data_type:42},{storage_type:'Integer',value_internal:1.5},{storage_type:'Double',value_internal:Infinity}])assert.equal(parameterExpectedState(parameter(patch)),null);
  const missing=parameter();delete missing.data_type;assert.equal(parameterExpectedState(missing),null);
});

test('exact mode preserves selected Int64 IDs and builds a Node-valid guarded change from fresh facts',()=>{
  const ui=fixture(),observed=parameter();ui.selection();ui.describe([observed]);
  assert.deepEqual(ui.calls[1],{commandId:'revit_get_element_parameters',parameters:{element_id:sourceId},sourceDocument:{session:source.hostSession,...source.document}});
  observed.value_internal='外部对象后来被改写';
  ui.choose(parameterId,' 新文本 ');
  const changes=JSON.parse(ui.editor.input.value);
  assert.deepEqual(changes,[{element_id:sourceId,parameter_id:parameterId,value:' 新文本 ',expected_state:{storage_type:'String',has_value:true,value_internal:' 原始文本 ',data_type:null}}]);
  assert.equal(ui.editor.validate().ok,true);assert.deepEqual(ui.editor.sourceDocument(),{session:source.hostSession,...source.document});
  assert.doesNotThrow(()=>assertNativeParameterWriteArguments(name,{expected_document:source.document.path,changes}));
  assert.equal(ui.editor.element.textContent.includes('JSON'),false);
  assert.equal(parameterInputKind(parameter()),null,'legacy mode keeps its numeric parameter-ID boundary');
  assert.equal(parameterInputKind(parameter(),{exactIds:true,idRule:rule.items.properties.parameter_id}),'text');
});

test('single mode never accumulates a second change and imported JSON cannot supply an expected state',()=>{
  const ui=fixture();ui.selection();ui.describe([parameter(),parameter({parameter_id:'2',name:'另一参数'})]);
  ui.choose(parameterId,'一次修改');assert.equal(ui.get('add').disabled,true);
  ui.choose(2,'第二次修改');assert.equal(JSON.parse(ui.editor.input.value).length,1);
  ui.get('remove-0').click();assert.equal(ui.get('add').disabled,false);ui.get('add').click();
  assert.equal(JSON.parse(ui.editor.input.value)[0].parameter_id,2);
  ui.editor.input.value=JSON.stringify([{element_id:sourceId,parameter_id:parameterId,value:'伪造',expected_state:{}}]);
  assert.deepEqual(JSON.parse(ui.editor.input.value),[]);assert.equal(ui.editor.sourceDocument(),null);assert.equal(ui.editor.validate().ok,false);
});

test('only recognized instances and newly requested parameter results can populate guarded state',()=>{
  const ui=fixture();ui.selection([{element_id:sourceId,name:'类型',is_type:true},{element_id:'42',name:'符号',class_name:'FamilySymbol'}]);
  assert.equal(ui.get('read-parameters').disabled,true);assert.match(ui.editor.element.textContent,/仅修改实例/);
  ui.selection();ui.complete('revit_get_element_parameters',{...source,data:{value:{element_id:sourceId,parameters:[parameter()]}}});
  assert.equal(ui.get('parameter').children.length,1);
  ui.describe([parameter()]);ui.choose(parameterId,'修改');
  ui.update({accountEpoch:2});assert.equal(ui.editor.sourceDocument(),null);assert.deepEqual(JSON.parse(ui.editor.input.value),[]);
  ui.selection();ui.get('read-parameters').click();ui.complete('revit_get_element_parameters',{...source,data:{value:{element_id:'9007199254740994',parameters:[parameter()]}}});
  assert.match(ui.editor.validate().error,/上次读取/);assert.equal(ui.get('parameter').children.length,1);
});

test('Length input preserves the observed internal guard and reuses the existing millimetre conversion',()=>{
  const ui=fixture(),observed=parameter({storage_type:'Double',value_internal:2,data_type:'autodesk.spec.aec:length-2.0.0',value_display:'609.6 mm'});
  ui.selection();ui.describe([observed,parameter({parameter_id:'3',storage_type:'Double',data_type:'autodesk.spec.aec:area-2.0.0'}),parameter({parameter_id:'4',is_read_only:true})]);
  assert.equal(ui.get('parameter').children.length,2);ui.choose(parameterId,'914.4','number');
  const change=JSON.parse(ui.editor.input.value)[0];assert.equal(change.value,914.4/304.8);assert.equal(change.value_unit,'internal');
  assert.deepEqual(change.expected_state,{storage_type:'Double',has_value:true,value_internal:2,data_type:observed.data_type});
  assert.doesNotThrow(()=>assertNativeParameterWriteArguments(name,{expected_document:source.document.path,changes:[change]}));
});

test('empty text, unset state and YesNo use raw facts while malformed descriptors stay unavailable',()=>{
  for(const [observed,value,suffix] of [[parameter({has_value:false,value_internal:null}),'','value'],
    [parameter({storage_type:'Integer',value_internal:0,data_type:'autodesk.spec:spec.bool-1.0.0'}),'1','yesno']]){
    const ui=fixture();ui.selection();ui.describe([observed]);ui.choose(parameterId,value,suffix);
    const change=JSON.parse(ui.editor.input.value)[0];assert.deepEqual(change.expected_state,parameterExpectedState(observed));
    assert.doesNotThrow(()=>assertNativeParameterWriteArguments(name,{expected_document:source.document.path,changes:[change]}));
  }
  const ui=fixture();ui.selection();ui.describe([parameter({has_value:false,value_internal:'invalid'}),parameter({parameter_id:'2',data_type:false})]);
  assert.equal(ui.get('parameter').children.length,1);assert.equal(ui.get('add').disabled,true);
});

test('the default legacy editor keeps its old read interface, multiple rows and unguarded shape',()=>{
  const ui=fixture({legacy:true});ui.selection([{element_id:'42',name:'墙'},{element_id:sourceId,name:'超出旧范围'}]);
  assert.equal(ui.get('element').children.length,2);ui.describe([parameter({parameter_id:-123}),parameter({parameter_id:2})]);
  assert.equal(ui.calls.at(-1).commandId,'revit_describe_parameters');
  ui.choose(-123,'旧一');ui.choose(2,'旧二');
  assert.deepEqual(JSON.parse(ui.editor.input.value),[{element_id:42,parameter_id:-123,value:'旧一'},{element_id:42,parameter_id:2,value:'旧二'}]);
});

test('the actual workspace mounts the guarded widget and preserves source and confirmation in its command intent',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:false,commandsReady:true,commandReadiness:'local',
    directCommandsAvailable:true,commandCatalog:MODEL_COMMAND_CATALOG,historyAvailable:true,account:{required:false},connectionGeneration:1,codexAccount:{accountRevision:1,status:'unavailable'}});
  ui.emit('conversation',{busy:false,session:session()});await flush();
  const row=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===name);assert.ok(row);
  const prefix='model-command-'+name+'-changes-',get=suffix=>ui.get(prefix+suffix);
  assert.equal(row.querySelectorAll('.parameter-change-field').length,1);
  get('read-selection').click();await flush();await ui.respond(ui.requests.at(-1),{ok:true,executionId:'selection-1'});
  ui.emit('conversation',{busy:false,session:session(),command:{commandId:'selection',conversationId:'chat-a',executionId:'selection-1',status:'completed',
    result:{...source,data:{items:[{element_id:sourceId,name:'墙',is_type:false}],total:1}}}});await flush();
  get('read-parameters').click();await flush();assert.equal(ui.requests.at(-1).body.commandId,'revit_get_element_parameters');
  assert.equal(ui.requests.at(-1).body.parameters.element_id,sourceId);
  await ui.respond(ui.requests.at(-1),{ok:true,executionId:'parameters-1'});
  ui.emit('conversation',{busy:false,session:session(),command:{commandId:'revit_get_element_parameters',conversationId:'chat-a',executionId:'parameters-1',status:'completed',
    result:{...source,data:{value:{element_id:sourceId,parameters:[parameter()]}}}}});await flush();
  get('parameter').value=parameterId;get('parameter').dispatchEvent(new UiEvent('change'));get('value').value='明确新值';get('value').dispatchEvent(new UiEvent('input'));get('add').click();
  const count=ui.requests.length;row.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,count);
  row.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;row.querySelectorAll('.model-command-run')[0].click();await flush();
  const request=ui.requests.at(-1);assert.equal(request.body.commandId,name);assert.equal(request.body.confirmed,true);
  assert.deepEqual(request.body.sourceDocument,{session:source.hostSession,...source.document});assert.equal(request.body.parameters.mode,'rollback');
  assert.equal(request.body.parameters.changes[0].element_id,sourceId);assert.equal(request.body.parameters.changes[0].parameter_id,parameterId);
  assert.deepEqual(request.body.parameters.changes[0].expected_state,parameterExpectedState(parameter()));
  assert.doesNotThrow(()=>assertNativeParameterWriteArguments(name,{...request.body.parameters,expected_document:source.document.path}));
  await ui.respond(request,{ok:true,executionId:'guarded-write-1'});
});

test('titleblock manual field accumulates bounded guarded inputs without JSON',()=>{
 const tool=MODEL_COMMAND_CATALOG.find(item=>item.tool==='revit_populate_titleblock');assert.ok(tool);const ui=fixture({changeRule:tool.inputSchema.properties.changes,maxChanges:5});ui.selection();ui.describe([parameter(),parameter({parameter_id:'2',name:'另一参数'})]);ui.choose(parameterId,'新值');ui.choose('2','第二值');const changes=JSON.parse(ui.editor.input.value);assert.equal(changes.length,2);assert.equal(changes[0].expected_state.value_internal,' 原始文本 ');assert.equal(ui.editor.element.textContent.includes('JSON'),false);assert.equal(ui.editor.validate().ok,true);
});
