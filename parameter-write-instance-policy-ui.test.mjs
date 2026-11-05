import test from 'node:test';
import assert from 'node:assert/strict';
import {createParameterChangeField} from './public/parameter-change-field.mjs';
import {NATIVE_PARAMETER_WRITE_TOOLS} from './lib/native-parameter-writes.mjs';
import {MODEL_COMMAND_CATALOG} from './lib/model-command-catalog.mjs';
import {createInputUi,session,flush,UiEvent} from './test-support/model-input-ui-fixture.mjs';

const source={hostSession:'policy-ui-host',document:{title:'实例范围样例',path:'D:\\instance-policy.rvt'}};
const parameter=(patch={})=>({parameter_id:-123,name:'备注',storage_type:'String',is_read_only:false,has_value:true,
  value_internal:'原值',value_display:'原值',data_type:'',unit_type:null,...patch});
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
function fixture(options={}){
  const calls=[];let state={accountEpoch:1,contextEpoch:1,commandIdentityKey:'owner-a',commandConversationId:'chat-a',commands:[]},sequence=0;
  const editor=createParameterChangeField({document:{createElement:tag=>new Node(tag)},Event:UiEvent,id:'policy',onCommand:detail=>calls.push(detail),...options});
  editor.update(state);
  const find=(node,id)=>node.id===id?node:node.children.map(child=>find(child,id)).find(Boolean),get=suffix=>find(editor.element,'policy-'+suffix);
  const update=patch=>{state={...state,...patch};editor.update(state);};
  const complete=(commandId,result,extra={})=>update({commands:[...state.commands.filter(item=>item.commandId!==commandId),{commandId,status:'completed',executionId:'read-'+(++sequence),result,...extra}]});
  const selection=(items=[{element_id:'42',name:'墙',is_type:false}],identity=source)=>{get('read-selection').click();complete('selection',{...identity,data:{items,total:items.length}});};
  const describe=(parameters=[parameter()],identity=source)=>{get('read-parameters').click();const request=calls.at(-1);complete(request.commandId,{...identity,data:{value:{element_id:request.parameters.element_id,parameters}}});};
  const choose=(id=-123,value='新值')=>{get('parameter').value=String(id);get('parameter').dispatchEvent(new UiEvent('change'));get('value').value=value;get('value').dispatchEvent(new UiEvent('input'));get('add').click();};
  return {editor,calls,get,update,complete,selection,describe,choose};
}

test('the legacy editor excludes every recognized type before any parameter read or queued change',()=>{
  const ui=fixture();ui.selection([{element_id:'1',name:'墙类型',is_type:true},{element_id:'2',name:'类型标记',is_element_type:true},
    {element_id:'3',name:'类型对象',class_name:'ElementType'},{element_id:'4',name:'族符号',class_name:'FamilySymbol'}]);
  assert.equal(ui.get('element').children.length,1);assert.equal(ui.get('element').value,'');
  assert.equal(ui.get('read-parameters').disabled,true);assert.equal(ui.get('add').disabled,true);
  const count=ui.calls.length;ui.get('read-parameters').click();ui.get('add').click();assert.equal(ui.calls.length,count);
  assert.deepEqual(JSON.parse(ui.editor.input.value),[]);assert.equal(ui.editor.validate().ok,false);
  assert.match(ui.editor.element.textContent,/4 个元素类型已排除.*仅修改实例参数/);
});

test('mixed selection keeps the explicitly reported instance and the legacy request and row shapes',()=>{
  const ui=fixture();ui.selection([{element_id:'41',name:'类型',is_type:true},{element_id:'42',name:'墙实例',is_type:false}]);
  assert.equal(ui.get('element').children.length,2);assert.equal(ui.get('element').value,'42');
  ui.describe();assert.deepEqual(ui.calls.at(-1),{commandId:'revit_describe_parameters',parameters:{element_id:42},sourceDocument:{session:source.hostSession,...source.document}});
  ui.choose();assert.deepEqual(JSON.parse(ui.editor.input.value),[{element_id:42,parameter_id:-123,value:'新值'}]);
  assert.equal(ui.editor.validate().ok,true);assert.deepEqual(ui.editor.sourceDocument(),{session:source.hostSession,...source.document});
});

test('display names and unrecognized class names never determine whether an element is a type',()=>{
  const ui=fixture();ui.selection([{element_id:'42',name:'FamilySymbol 类型样式名称',class_name:'CustomType',is_type:false}]);
  assert.equal(ui.get('element').value,'42');assert.equal(ui.get('read-parameters').disabled,false);
  ui.describe();ui.choose(-123,'实例仍可修改');assert.equal(ui.editor.validate().ok,true);
  assert.equal(JSON.parse(ui.editor.input.value)[0].value,'实例仍可修改');
});

test('an interrupted replacement read cannot restore cached parameter facts or authorize old queued values',()=>{
  const ui=fixture();ui.selection();ui.describe();ui.choose();
  ui.get('read-parameters').click();ui.complete('revit_describe_parameters',undefined,{status:'interrupted'});
  assert.equal(ui.editor.validate().ok,false);assert.match(ui.editor.validate().error,/上次读取/);assert.equal(ui.get('add').disabled,true);
  ui.complete('revit_describe_parameters',{...source,data:{value:{element_id:42,parameters:[parameter()]}}});
  assert.equal(ui.get('parameter').children.length,1);assert.equal(ui.editor.validate().ok,false);
  ui.update({commandConversationId:'chat-b'});assert.equal(ui.editor.sourceDocument(),null);assert.deepEqual(JSON.parse(ui.editor.input.value),[]);
  assert.match(ui.editor.element.textContent,/身份或对话已变化/);
});

test('a new host or document source clears legacy rows rather than combining equal IDs across models',()=>{
  for(const changed of [{...source,hostSession:'replacement-host'},{...source,document:{...source.document,path:'D:\\other-instance-policy.rvt'}}]){
    const ui=fixture();ui.selection();ui.describe();ui.choose();ui.selection([{element_id:'42',name:'另一个实例',is_type:false}],changed);
    assert.equal(ui.editor.sourceDocument(),null);assert.deepEqual(JSON.parse(ui.editor.input.value),[]);assert.equal(ui.editor.validate().ok,false);
  }
});

test('legacy IDs retain the safe-integer boundary while exact mode keeps its existing single guarded change',()=>{
  const legacy=fixture();legacy.selection([{element_id:String(Number.MAX_SAFE_INTEGER),name:'最大安全实例',is_type:false},
    {element_id:'9007199254740993',name:'超出旧范围',is_type:false},{element_id:Number.MAX_SAFE_INTEGER+1,name:'不安全数字',is_type:false},
    {element_id:'7',name:'类型',is_type:true}]);
  assert.equal(legacy.get('element').children.length,2);assert.equal(legacy.get('element').value,String(Number.MAX_SAFE_INTEGER));
  assert.match(legacy.editor.element.textContent,/2 个元素编号.*已排除/);
  legacy.describe();legacy.choose();assert.equal(JSON.parse(legacy.editor.input.value)[0].element_id,Number.MAX_SAFE_INTEGER);
  const exact=fixture({maxChanges:1,exactIds:true,rule:NATIVE_PARAMETER_WRITE_TOOLS[0].inputSchema.properties.changes});
  exact.selection([{element_id:'9007199254740993',name:'精确实例',is_type:false},{element_id:'8',name:'类型',is_type:true}]);
  exact.describe([parameter({parameter_id:'-9223372036854775808'})]);exact.choose('-9223372036854775808','精确修改');
  const [change]=JSON.parse(exact.editor.input.value);assert.equal(change.element_id,'9007199254740993');assert.equal(change.parameter_id,'-9223372036854775808');
  assert.deepEqual(change.expected_state,{storage_type:'String',has_value:true,value_internal:'原值',data_type:''});assert.equal(exact.get('add').disabled,true);
});

test('the actual workspace legacy widget cannot submit a type-only selection',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());const command=MODEL_COMMAND_CATALOG.find(item=>item.tool==='revit_set_parameters');assert.ok(command);
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:false,commandsReady:true,commandReadiness:'local',directCommandsAvailable:true,
    commandCatalog:MODEL_COMMAND_CATALOG,historyAvailable:true,account:{required:false},connectionGeneration:1,codexAccount:{accountRevision:1}});
  ui.emit('conversation',{busy:false,session:session()});await flush();
  const prefix='model-command-revit_set_parameters-changes-',get=suffix=>ui.get(prefix+suffix);
  get('read-selection').click();await flush();assert.equal(ui.requests.length,1);await ui.respond(ui.requests[0],{ok:true,executionId:'selection-1'});
  ui.emit('conversation',{busy:false,session:session(),command:{commandId:'selection',conversationId:'chat-a',executionId:'selection-1',status:'completed',
    result:{...source,data:{items:[{element_id:'42',name:'类型',is_type:true}],total:1}}}});await flush();
  assert.equal(get('read-parameters').disabled,true);assert.equal(get('add').disabled,true);assert.deepEqual(JSON.parse(ui.get(prefix.slice(0,-1)).value),[]);
  const item=ui.document.body.querySelectorAll('.model-command-item').find(row=>row.dataset.commandId==='revit_set_parameters');item.querySelectorAll('.model-command-confirm')[0].children[0].checked=true;
  item.querySelectorAll('.model-command-run')[0].click();await flush();assert.equal(ui.requests.length,1);
  assert.match(item.textContent,/仅修改实例参数/);assert.equal(ui.requests.some(request=>request.body.commandId==='revit_set_parameters'),false);
});
