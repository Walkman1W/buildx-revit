import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createPersonalCommandFields} from '../public/personal-command-fields.mjs';

class UiEvent {constructor(type){this.type=type;}}
class Node {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.events=new Map();this.value='';this.hidden=false;this._text='';}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const node of this.children)node.parent=null;this.children=[];this.append(...nodes);this._text='';}
  before(node){if(!this.parent)return;node.parent=this.parent;this.parent.children.splice(this.parent.children.indexOf(this),0,node);}
  addEventListener(type,callback){const list=this.events.get(type)||[];list.push(callback);this.events.set(type,list);}
  dispatchEvent(event){for(const callback of this.events.get(event.type)||[])callback(event);return true;}
  setAttribute(name,value){this[name]=String(value);}
  focus(){this.focused=true;}
  click(){this.dispatchEvent(new UiEvent('click'));}
  get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
  set textContent(value){this._text=String(value);this.children=[];}
}
function setup({onCommand}={}){
  let changes=0;
  const field=createPersonalCommandFields({document:{createElement:tag=>new Node(tag)},Event:UiEvent,id:'personal',onChange:()=>changes++,...onCommand?{onCommand}:{}});
  const find=(node,id)=>node.id===id?node:node.children.map(child=>find(child,id)).find(Boolean);
  const input=name=>find(field.element,'personal-'+name);
  const edit=(name,value)=>{const node=input(name);node.value=String(value);node.dispatchEvent(new UiEvent('input'));};
  return {field,input,edit,changes:()=>changes};
}

test('a read revision creates primitive widgets and returns exact values without a JSON editor',()=>{
  const ui=setup();ui.field.setDefinition({name:'开口检查',parameters:{note:'string',width:'number',count:'integer',enabled:'boolean'}});
  assert.equal(ui.input('note').type,'text');assert.equal(ui.input('width').type,'number');assert.equal(ui.input('width').step,'any');assert.equal(ui.input('count').step,'1');assert.equal(ui.input('enabled').tagName,'SELECT');
  assert.deepEqual(ui.input('enabled').children.map(node=>node.textContent),['请选择','否','是']);
  ui.edit('note','');ui.edit('width','12.5');ui.edit('count','3');ui.edit('enabled','false');
  assert.deepEqual(JSON.parse(ui.field.input.value),{note:'',width:12.5,count:3,enabled:false});assert.equal(ui.field.validate().ok,true);
  assert.match(ui.field.element.textContent,/已选择：开口检查/);assert.equal(ui.field.element.textContent.includes('JSON'),false);assert.ok(ui.changes()>4);
});

test('blank numbers and booleans, fractional integers and nonfinite numbers cannot become zero or false',()=>{
  const ui=setup();ui.field.setDefinition({parameters:{n:'number',i:'integer',b:'boolean'}});
  assert.match(ui.field.validate().error,/n.*有效数字/);ui.edit('n','1');ui.edit('i','2.5');assert.match(ui.field.validate().error,/i.*整数/);
  ui.edit('i','2');assert.match(ui.field.validate().error,/b.*是.*否/);ui.edit('b','true');assert.equal(ui.field.validate().ok,true);
  ui.edit('n','Infinity');assert.equal(ui.field.validate().ok,false);ui.edit('n',' ');assert.equal(ui.field.validate().ok,false);
  ui.edit('n','2');ui.edit('i','9007199254740992');assert.equal(ui.field.validate().ok,false);
});

test('a parameterless version omits parameters and a version switch clears values and old controls',()=>{
  const ui=setup();ui.field.setDefinition({parameters:{text:'string'}});ui.edit('text','草稿');assert.equal(ui.field.controls.length,2);
  const before=ui.changes();ui.field.setDefinition({name:'无参数'});assert.equal(ui.field.input.value,'');assert.equal(ui.field.validate().ok,true);assert.equal(ui.field.controls.length,1);assert.ok(ui.changes()>before);
  ui.field.input.value='{}';assert.equal(ui.field.input.value,'');
  ui.field.setDefinition(null);assert.equal(ui.field.input.value,'');assert.match(ui.field.element.textContent,/先在个人命令列表/);
});

test('legacy external assignments are preserved for validation and cannot invent an unselected definition',()=>{
  const ui=setup();ui.field.input.value='{"old":1}';assert.equal(ui.field.input.value,'{"old":1}');assert.match(ui.field.validate().error,/先查看并选择/);
  ui.field.input.value='';assert.equal(ui.field.input.value,'');assert.equal(ui.field.validate().ok,true);
  ui.field.setDefinition({parameters:{n:'number',b:'boolean'}});
  ui.field.input.value='{"n":12.5,"b":false}';assert.equal(ui.input('n').value,'12.5');assert.equal(ui.input('b').value,'false');assert.equal(ui.field.validate().ok,true);
  for(const value of ['{"n":"12.5","b":false}','{"n":12.5,"b":"false"}','{"n":12.5,"b":false,"extra":1}','null','bad']){
    ui.field.input.value=value;assert.equal(ui.field.validate().ok,false);assert.equal(ui.field.input.value,value);
  }
  ui.edit('n','5');ui.edit('b','true');assert.equal(ui.field.validate().ok,true);assert.deepEqual(JSON.parse(ui.field.input.value),{n:5,b:true});
});

test('unsupported or oversized definitions fail closed without rendering arbitrary complex input',()=>{
  const ui=setup();
  for(const parameters of [null,{value:'object'},{'wrong-name':'string'},Array(1),Object.fromEntries(Array.from({length:33},(_,i)=>['p'+i,'string']))]){
    ui.field.setDefinition({parameters});assert.match(ui.field.validate().error,/参数定义/);assert.equal(ui.field.controls.length,1);
  }
});

test('display labels and units appear in widgets and validation while execution parameter keys remain original',()=>{
  const ui=setup();ui.field.setDefinition({name:'带中文名称',parameters:{count:'integer',enabled:'boolean',note:'string'},parameter_labels:{count:'放置数量（个）',enabled:'启用偏移',note:'构件备注'}});
  assert.match(ui.field.element.textContent,/放置数量（个）/);assert.match(ui.field.element.textContent,/启用偏移/);assert.match(ui.field.element.textContent,/构件备注/);
  assert.equal(ui.field.element.textContent.includes('count'),false);assert.equal(ui.field.element.textContent.includes('enabled'),false);assert.equal(ui.field.element.textContent.includes('note'),false);
  assert.match(ui.field.validate().error,/放置数量（个）.*有效数字/);ui.edit('count','1.5');assert.match(ui.field.validate().error,/放置数量（个）.*整数/);
  ui.edit('count','2');assert.match(ui.field.validate().error,/启用偏移.*是.*否/);ui.edit('enabled','false');ui.edit('note','备注内容');
  assert.deepEqual(JSON.parse(ui.field.input.value),{count:2,enabled:false,note:'备注内容'});assert.equal(ui.field.validate().ok,true);
});

test('invalid label metadata fails closed and an unlabelled legacy field retains its original name',()=>{
  const ui=setup();
  for(const parameter_labels of [null,[],{unknown:'未知参数'},{count:''},{count:'   '},{count:12},{count:'字'.repeat(81)}]){
    ui.field.setDefinition({parameters:{count:'integer'},parameter_labels});assert.match(ui.field.validate().error,/参数显示名称/);assert.equal(ui.field.controls.length,1);
  }
  ui.field.setDefinition({parameters:{count:'integer',constructor:'string'},parameter_labels:{count:'数量'}});
  assert.match(ui.field.element.textContent,/数量/);assert.match(ui.field.element.textContent,/constructor/);assert.equal(ui.field.element.textContent.includes('function Object'),false);
});

test('transport JSON from another realm retains parameter definitions and Chinese labels',()=>{
  const ui=setup(),record=vm.runInNewContext('JSON.parse(\'{"name":"跨域命令","parameters":{"count":"integer"},"parameter_labels":{"count":"创建数量（个）"}}\')');
  ui.field.setDefinition(record);assert.match(ui.field.element.textContent,/创建数量（个）/);ui.edit('count','3');
  assert.equal(ui.field.validate().ok,true);assert.deepEqual(JSON.parse(ui.field.input.value),{count:3});
});

test('explicit enum metadata renders typed dropdowns and rejects values outside the viewed revision',()=>{
  const ui=setup();ui.field.setDefinition({parameters:{style:'string',count:'integer',ratio:'number',enabled:'boolean'},parameter_labels:{style:'布置方式'},parameter_options:{style:{kind:'enum',values:['横向','纵向']},count:{kind:'enum',values:[1,3]},ratio:{kind:'enum',values:[0.5,1.25]},enabled:{kind:'enum',values:[false]}}});
  for(const name of ['style','count','ratio','enabled'])assert.equal(ui.input(name).tagName,'SELECT');
  assert.deepEqual(ui.input('style').children.map(node=>node.textContent),['请选择','横向','纵向']);
  assert.deepEqual(ui.input('enabled').children.map(node=>node.value),['','false']);
  ui.field.input.value=JSON.stringify({style:'纵向',count:3,ratio:1.25,enabled:false});
  assert.equal(ui.field.validate().ok,true);assert.deepEqual(JSON.parse(ui.field.input.value),{style:'纵向',count:3,ratio:1.25,enabled:false});
  ui.field.input.value=JSON.stringify({style:'纵向',count:2,ratio:1.25,enabled:false});assert.match(ui.field.validate().error,/可选项/);
  ui.edit('count','3');assert.equal(ui.field.validate().ok,true);
  ui.field.input.value=JSON.stringify({style:'纵向',count:3,ratio:1.25,enabled:true});assert.equal(ui.field.validate().ok,false);
  ui.field.setDefinition({parameters:{style:'string'}});assert.equal(ui.input('style').tagName,'INPUT');assert.equal(ui.input('style').value,'');
});

test('invalid dropdown metadata fails closed and parameter names do not infer model lookups',()=>{
  const ui=setup();
  for(const parameter_options of [null,[],{unknown:{kind:'enum',values:['A']}},{n:{kind:'enum',values:[1,'2']}},{n:{kind:'enum',values:[1,1]}},{n:{kind:'model',source:'unknown'}},{n:{kind:'model',source:'level_id',extra:true}}]){
    ui.field.setDefinition({parameters:{n:'integer'},parameter_options});assert.match(ui.field.validate().error,/可选项无效/);assert.equal(ui.field.controls.length,1);
  }
  ui.field.setDefinition({parameters:{level_id:'integer'}});assert.equal(ui.input('level_id').tagName,'INPUT');assert.equal(ui.field.controls.some(node=>node.className==='command-choice-read'),false);
  ui.field.setDefinition({parameters:{level_id:'string'},parameter_options:{level_id:{kind:'model',source:'level_id'}}});assert.equal(ui.field.validate().ok,false);
});

const snapshot=(commands=[],overrides={})=>({accountEpoch:1,contextEpoch:1,commandIdentityKey:'connection-1',commandConversationId:'chat-a',busy:false,blocked:false,commands,...overrides});
const modelRead=(commandId,executionId,path='D:/model.rvt')=>({commandId,executionId,status:'completed',result:{hostSession:'host',document:{title:'模型',path},data:{items:[{element_id:'42',name:'首层'},{element_id:'84',name:'二层'}],total:2,returned:2,truncated:false}}});
test('explicit model metadata reuses the read selector and preserves typed keys with document provenance',()=>{
  const requests=[],ui=setup({onCommand:detail=>{requests.push(detail);return true;}});ui.field.update(snapshot());
  ui.field.setDefinition({parameters:{chosenLevel:'integer'},parameter_labels:{chosenLevel:'放置标高'},parameter_options:{chosenLevel:{kind:'model',source:'level_id'}}});
  const read=ui.field.controls.find(node=>node.className==='command-choice-read');read.click();assert.deepEqual(requests,[{commandId:'levels',parameters:{}}]);
  assert.match(ui.field.validate().error,/等待读取放置标高/);
  ui.field.update(snapshot([modelRead('levels','read-1')]));ui.input('chosenLevel-choice').value='84';ui.input('chosenLevel-choice').dispatchEvent(new UiEvent('change'));
  assert.equal(ui.field.validate().ok,true);assert.deepEqual(JSON.parse(ui.field.input.value),{chosenLevel:84});assert.deepEqual(ui.field.sourceDocument(),{session:'host',title:'模型',path:'D:/model.rvt'});
  ui.field.update(snapshot([],{contextEpoch:2}));assert.equal(ui.input('chosenLevel-choice').value,'');assert.equal(ui.field.sourceDocument(),null);assert.equal(ui.field.validate().ok,false);
  ui.edit('chosenLevel','0');assert.match(ui.field.validate().error,/可选项/);
});

test('model options from different documents cannot be silently combined and changing a revision drops their sources',()=>{
  const ui=setup({onCommand:()=>true});ui.field.update(snapshot());
  const record={parameters:{level:'integer',wall:'integer'},parameter_options:{level:{kind:'model',source:'level_id'},wall:{kind:'model',source:'wall_type_id'}}};ui.field.setDefinition(record);
  const reads=ui.field.controls.filter(node=>node.className==='command-choice-read');reads[0].click();ui.field.update(snapshot([modelRead('levels','levels-a','D:/A.rvt')]));
  ui.input('level-choice').value='42';ui.input('level-choice').dispatchEvent(new UiEvent('change'));
  reads[1].click();ui.field.update(snapshot([modelRead('levels','levels-a','D:/A.rvt'),modelRead('revit_list_family_types','walls-b','D:/B.rvt')]));
  ui.input('wall-choice').value='84';ui.input('wall-choice').dispatchEvent(new UiEvent('change'));
  assert.match(ui.field.validate().error,/不同模型/);assert.ok(ui.field.sourceDocument());
  const controls=[...ui.field.controls];ui.field.setDefinition({...record,parameter_options:{level:{kind:'enum',values:[5]},wall:{kind:'enum',values:[6]}}});
  assert.equal(ui.field.sourceDocument(),null);assert.equal(ui.field.controls.some(node=>controls.includes(node)&&node!==ui.field.input),false);assert.equal(ui.input('level').value,'');
});
