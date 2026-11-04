import test from 'node:test';
import assert from 'node:assert/strict';
import {createParameterChangeField,parameterInputKind} from './public/parameter-change-field.mjs';

class UiEvent {constructor(type,options={}){this.type=type;Object.assign(this,options);}}
class Node {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.events=new Map();this.value='';this.disabled=false;this.hidden=false;this._text='';}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];this._text='';}
  addEventListener(type,callback){const callbacks=this.events.get(type)||[];callbacks.push(callback);this.events.set(type,callbacks);}
  dispatchEvent(event){for(const callback of this.events.get(event.type)||[])callback(event);return true;}
  setAttribute(key,value){this[key]=String(value);}
  focus(){this.focused=true;}
  click(){this.dispatchEvent(new UiEvent('click'));}
  get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
  set textContent(value){this.children=[];this._text=String(value);}
}
const source={hostSession:'host-a',document:{title:'样例',path:'D:\\sample.rvt'}};
const parameter=(id,name,storage_type,extra={})=>({parameter_id:id,name,storage_type,is_read_only:false,has_value:true,value_internal:storage_type==='String'?'原文本':0,value_display:'原显示值',data_type:'',unit_type:null,...extra});
function setup(){
  let state={accountEpoch:1,contextEpoch:2,commandIdentityKey:'identity-a',commandConversationId:'chat-a',commands:[]},revision=0,changes=0;
  const calls=[],editor=createParameterChangeField({document:{createElement:tag=>new Node(tag)},Event:UiEvent,id:'changes',onCommand:detail=>calls.push(detail),onChange:()=>changes++});
  editor.update(state);
  const find=(node,id)=>node.id===id?node:node.children.map(child=>find(child,id)).find(Boolean);
  const get=suffix=>find(editor.element,'changes-'+suffix);
  const change=(suffix,value,event='change')=>{const node=get(suffix);node.value=String(value);node.dispatchEvent(new UiEvent(event));};
  const complete=(commandId,result,extras={})=>{state={...state,commands:[...state.commands.filter(command=>command.commandId!==commandId),{commandId,status:'completed',executionId:'execution-'+(++revision),result,...extras}]};editor.update(state);};
  // Production read aliases intentionally preserve native Int64 IDs as strings.
  const selection=(elements=[{element_id:'42',name:'墙 A',category:'墙'}],identity=source)=>{get('read-selection').click();complete('selection',{...identity,data:{items:elements,total:elements.length,returned:elements.length,truncated:false}});};
  const describe=(parameters,identity=source)=>{get('read-parameters').click();complete('revit_describe_parameters',{...identity,data:{value:{element_id:Number(get('element').value),parameters}}});};
  const choose=(id,value,suffix='value')=>{change('parameter',id);change(suffix,value,'input');get('add').click();};
  return {editor,calls,get,change,complete,selection,describe,choose,state:()=>state,changes:()=>changes,update:patch=>{state={...state,...patch};editor.update(state);}};
}

test('read selection, choose parameter and enter millimetres produce a typed native change without JSON editing',()=>{
  const ui=setup();assert.equal(ui.get('read-parameters').disabled,true);
  ui.selection();assert.deepEqual(ui.calls[0],{commandId:'selection',parameters:{}});
  ui.describe([parameter(-1001105,'高度','Double',{data_type:'autodesk.spec.aec:length-2.0.0',value_internal:3000/304.8,value_display:'three metres'})]);
  assert.deepEqual(ui.calls[1],{commandId:'revit_describe_parameters',parameters:{element_id:42},sourceDocument:{session:'host-a',title:'样例',path:'D:\\sample.rvt'}});
  ui.choose(-1001105,3600,'number');
  assert.equal(ui.editor.validate().ok,true);assert.deepEqual(JSON.parse(ui.editor.input.value),[{element_id:42,parameter_id:-1001105,value:3600/304.8,value_unit:'internal'}]);
  assert.deepEqual(ui.editor.sourceDocument(),{session:'host-a',title:'样例',path:'D:\\sample.rvt'});
  assert.match(ui.editor.element.textContent,/3600 mm/);assert.equal(ui.editor.element.textContent.includes('JSON'),false);assert.ok(ui.changes()>0);
});

test('selection decimal strings normalize once while unsafe identifiers are explicitly excluded',()=>{
  const ui=setup();ui.selection([
    {element_id:'42',name:'可用元素'},
    {element_id:'9007199254740993',name:'超出安全整数'},
    {element_id:'9223372036854775807',name:'Int64 最大值'},
    {element_id:'042',name:'非标准编号'},
  ]);
  assert.equal(ui.get('element').children.length,2);assert.equal(ui.get('element').value,'42');assert.match(ui.editor.element.textContent,/3 个元素编号.*已排除/);
  ui.describe([parameter(-11,'备注','String')]);assert.equal(ui.calls[1].parameters.element_id,42);assert.equal(typeof ui.calls[1].parameters.element_id,'number');
  ui.choose(-11,'修改');assert.equal(JSON.parse(ui.editor.input.value)[0].element_id,42);
  ui.selection([{element_id:'9007199254740993',name:'仅超范围编号'}]);assert.equal(ui.get('element').children.length,1);assert.equal(ui.get('read-parameters').disabled,true);assert.match(ui.editor.element.textContent,/超出当前表单支持范围/);
});

test('writable text accepts empty strings and YesNo remains a native two-choice control',()=>{
  const ui=setup();ui.selection();ui.describe([
    parameter(-11,'备注','String'),parameter(-12,'房间边界','Integer',{data_type:'autodesk.spec:spec.bool-1.0.0',value_internal:1}),
    parameter(-13,'数量','Integer'),parameter(-14,'只读','String',{is_read_only:true}),parameter(-15,'面积','Double',{data_type:'autodesk.spec.aec:area-2.0.0'}),parameter(-16,'标高','ElementId'),
  ]);
  assert.equal(ui.get('parameter').children.length,4);assert.match(ui.editor.element.textContent,/略去 3 个/);
  ui.choose(-11,'');ui.choose(-12,'0','yesno');
  assert.deepEqual(JSON.parse(ui.editor.input.value),[{element_id:42,parameter_id:-11,value:''},{element_id:42,parameter_id:-12,value:0}]);
  assert.equal(ui.get('yesno').hidden,false);assert.equal(ui.get('number').hidden,true);
  ui.change('parameter',-13);ui.change('number','2147483648','input');ui.get('add').click();assert.match(ui.editor.element.textContent,/之间的整数/);assert.equal(JSON.parse(ui.editor.input.value).length,2);
  ui.change('number','-2147483648','input');ui.get('add').click();assert.equal(JSON.parse(ui.editor.input.value)[2].value,-2147483648);
});

test('unsupported parameter types and unknown unit semantics cannot be guessed from display names',()=>{
  assert.equal(parameterInputKind(parameter(-2,'长度','Double',{data_type:'autodesk.spec.aec:area-2.0.0'})),null);
  assert.equal(parameterInputKind(parameter(-2,'是否启用','Integer',{data_type:''})),'integer');
  assert.equal(parameterInputKind(parameter(-1,'无效参数','String')),null);
  assert.equal(parameterInputKind(parameter(0,'无效参数','String')),null);
  assert.equal(parameterInputKind(parameter(-2,'只读参数','String',{is_read_only:true})),null);
});

test('unadded edits and duplicate element/parameter pairs cannot silently execute',()=>{
  const ui=setup();ui.selection();ui.describe([parameter(-11,'备注','String')]);
  ui.choose(-11,'第一次');ui.change('value','第二次','input');
  assert.match(ui.editor.validate().error,/尚未加入/);ui.get('add').click();assert.match(ui.editor.element.textContent,/已在列表/);
  assert.equal(JSON.parse(ui.editor.input.value)[0].value,'第一次');
  ui.get('remove-0').click();ui.get('add').click();assert.equal(ui.editor.validate().ok,true);assert.equal(JSON.parse(ui.editor.input.value)[0].value,'第二次');
});

test('only newly requested query executions populate controls; cached command results remain unusable',()=>{
  const ui=setup();const cached={...source,data:{items:[{element_id:7,name:'旧元素'}],total:1}};
  ui.complete('selection',cached);assert.equal(ui.get('element').children.length,1);
  ui.get('read-selection').click();ui.editor.update(ui.state());assert.equal(ui.get('element').children.length,1);
  ui.complete('selection',{...source,data:{items:[{element_id:42,name:'新元素'}],total:1}});
  assert.equal(ui.get('element').value,'42');
  ui.complete('revit_describe_parameters',{...source,data:{value:{element_id:42,parameters:[parameter(-11,'旧参数','String')]}}});
  assert.equal(ui.get('parameter').children.length,1);
  ui.get('read-parameters').click();ui.editor.update(ui.state());assert.equal(ui.get('parameter').children.length,1);
});

test('model or host changes clear queued edits instead of merging IDs from separate sources',()=>{
  for(const other of [{...source,hostSession:'host-b'},{...source,document:{...source.document,path:'D:\\other.rvt'}}]){
    const ui=setup();ui.selection();ui.describe([parameter(-11,'备注','String')]);ui.choose(-11,'修改');
    ui.selection([{element_id:42,name:'同 ID 其他元素'}],other);
    assert.deepEqual(JSON.parse(ui.editor.input.value),[]);assert.equal(ui.editor.sourceDocument(),null);assert.match(ui.editor.element.textContent,/当前模型已变化/);
  }
});

test('account, context and conversation changes clear inputs, pending queries and edit source',()=>{
  for(const patch of [{accountEpoch:3},{contextEpoch:3},{commandIdentityKey:'identity-b'},{commandConversationId:'chat-b'}]){
    const ui=setup();ui.selection();ui.describe([parameter(-11,'备注','String')]);ui.choose(-11,'修改');ui.update(patch);
    assert.equal(ui.editor.validate().ok,false);assert.equal(ui.editor.sourceDocument(),null);assert.deepEqual(JSON.parse(ui.editor.input.value),[]);assert.match(ui.editor.element.textContent,/身份或对话已变化/);
  }
});

test('rejected or vanished reads do not leave the editor pending or permit old queued values',()=>{
  const ui=setup();ui.selection();ui.describe([parameter(-11,'备注','String')]);ui.choose(-11,'修改');
  ui.get('read-selection').click();ui.update({commands:[{commandId:'selection',status:'pending'}]});
  ui.update({commands:[{commandId:'selection',status:'failed',error:{message:'rejected'}}]});
  assert.match(ui.editor.validate().error,/上次读取/);assert.equal(ui.get('read-selection').disabled,false);assert.equal(ui.get('read-parameters').disabled,true);
  ui.editor.input.value='';assert.deepEqual(JSON.parse(ui.editor.input.value),[]);assert.equal(ui.editor.sourceDocument(),null);
  ui.editor.input.value='[{"element_id":42,"parameter_id":-11,"value":"无来源"}]';assert.equal(ui.editor.validate().ok,false);assert.match(ui.editor.element.textContent,/重新读取元素和参数/);
});

test('HTTP rejection restoring the previous result ends the requested read without reusing old data',()=>{
  const ui=setup();ui.selection();ui.describe([parameter(-11,'备注','String')]);ui.choose(-11,'原修改');
  const oldSelection=ui.state().commands.find(command=>command.commandId==='selection');
  ui.get('read-selection').click();ui.update({commands:[{commandId:'selection',status:'pending'}],busy:false,blocked:false});
  ui.update({commands:[oldSelection],busy:false,blocked:false});
  assert.match(ui.editor.element.textContent,/本次读取未被接受/);assert.match(ui.editor.validate().error,/上次读取/);
  assert.equal(ui.get('read-selection').disabled,false);assert.equal(ui.get('read-parameters').disabled,true);assert.equal(ui.get('element').children.length,1);
  ui.selection();ui.describe([parameter(-12,'另一参数','String')]);const oldDescription=ui.state().commands.find(command=>command.commandId==='revit_describe_parameters');
  ui.get('read-parameters').click();ui.update({commands:[{commandId:'revit_describe_parameters',status:'pending'}],busy:false,blocked:false});
  ui.update({commands:[oldDescription],busy:false,blocked:false});
  assert.match(ui.editor.element.textContent,/本次读取未被接受/);assert.equal(ui.get('parameter').children.length,1);assert.equal(ui.get('read-parameters').disabled,false);assert.equal(ui.editor.validate().ok,false);
});

test('list re-rendering releases superseded controls and applies the contract limit',()=>{
  const ui=setup();ui.selection();ui.describe(Array.from({length:51},(_,index)=>parameter(index+1,'参数 '+index,'String')));
  const initial=ui.editor.controls.length;
  for(let index=1;index<=50;index++)ui.choose(index,'值 '+index);
  assert.equal(JSON.parse(ui.editor.input.value).length,50);assert.equal(ui.get('add').disabled,true);assert.equal(ui.editor.controls.length,initial+50);
  ui.get('remove-0').click();assert.equal(ui.editor.controls.length,initial+49);assert.equal(ui.get('add').disabled,false);
  ui.choose(51,'值 51');assert.equal(JSON.parse(ui.editor.input.value).length,50);assert.equal(ui.editor.controls.length,initial+50);
});
