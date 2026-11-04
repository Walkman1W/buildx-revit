import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommandField,COMMAND_PARAMETER_LABELS} from './public/command-fields.mjs';

class UiEvent {constructor(type){this.type=type;}}
class Node {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.events=new Map();this.attributes=new Map();this.value='';this.textContent='';}
  append(...nodes){this.children.push(...nodes);}
  addEventListener(type,fn){const list=this.events.get(type)??[];list.push(fn);this.events.set(type,list);}
  dispatchEvent(event){for(const fn of this.events.get(event.type)??[])fn(event);}
  setAttribute(name,value){this.attributes.set(name,value);}
  focus(){this.focused=true;}
}
const document={createElement:tag=>new Node(tag)};
const field=options=>createCommandField({document,Event:UiEvent,id:'test-field',key:'value',...options});
const point={type:'object',properties:{x:{type:'number'},y:{type:'number'},z:{type:'number'}},required:['x','y','z'],additionalProperties:false};
const ids={type:'array',items:{type:'integer',minimum:1},minItems:1,maxItems:50,uniqueItems:true};

test('scalar controls retain defaults and allow fractional measurements',()=>{
  const length=field({key:'width_mm',rule:{type:'number',exclusiveMinimum:0,default:600}});
  assert.equal(length.input.type,'number');assert.equal(length.input.step,'any');assert.equal(length.input.value,'600');
  assert.equal(length.element.children[0].textContent,'宽度（mm）');
  const count=field({rule:{type:'integer',minimum:1,maximum:5},value:2});
  assert.equal(count.input.step,'1');assert.equal(count.input.min,'1');assert.equal(count.input.max,'5');assert.equal(count.input.value,'2');
  assert.equal(field({rule:{type:'number',default:10},value:''}).input.value,'');
});

test('choices use Chinese labels and keep absence distinct from false',()=>{
  const mode=field({key:'mode',rule:{type:'string',enum:['rollback','commit'],default:'rollback'}});
  assert.equal(mode.input.tagName,'SELECT');assert.equal(mode.input.value,'rollback');
  assert.deepEqual(mode.input.children.map(node=>node.textContent),['预览（不保留修改）','应用修改（不保存模型）']);
  const optional=field({rule:{type:'boolean'}}),required=field({rule:{type:'boolean'},required:true});
  assert.deepEqual(optional.input.children.map(node=>[node.value,node.textContent]),[['','未指定'],['false','否'],['true','是']]);
  assert.equal(required.input.children[0].textContent,'请选择');assert.equal(optional.input.value,'');
  const restricted=field({rule:{type:'boolean',enum:[false]},required:true});
  assert.deepEqual(restricted.input.children.map(node=>[node.value,node.textContent]),[['','请选择'],['false','否']]);
});

test('coordinates round trip through the common value interface without blank becoming zero',()=>{
  const item=field({key:'delta_mm',rule:point}),axes=item.controls.slice(1);
  assert.equal(item.input.value,'');
  axes[0].value='1.5';assert.throws(()=>JSON.parse(item.input.value));
  axes[1].value='-2';axes[2].value='0';
  assert.deepEqual(JSON.parse(item.input.value),{x:1.5,y:-2,z:0});
  item.input.value='{"x":25,"y":-5.5,"z":0}';assert.deepEqual(axes.map(node=>node.value),['25','-5.5','0']);
  item.input.value='';assert.deepEqual(axes.map(node=>node.value),['','','']);
  assert.ok(axes.every(node=>node.type==='number'&&node.step==='any'));
  item.input.focus();assert.equal(axes[0].focused,true);
});

test('coordinate changes invalidate the parent value confirmation and malformed imports remain invalid',()=>{
  let changes=0;const item=field({rule:point,onChange:()=>changes++});
  item.input.value='{"x":1,"y":2,"z":3,"extra":4}';assert.throws(()=>JSON.parse(item.input.value));
  const axes=item.controls.slice(1);for(const [index,node] of axes.entries())node.value=String(index);
  axes[0].dispatchEvent(new UiEvent('input'));assert.equal(changes,1);
  assert.deepEqual(JSON.parse(item.input.value),{x:0,y:1,z:2});
  axes[1].dispatchEvent(new UiEvent('change'));assert.equal(changes,2);
  item.input.value='not-json';assert.throws(()=>JSON.parse(item.input.value));
  item.input.value='{"x":"1","y":2,"z":3}';assert.throws(()=>JSON.parse(item.input.value));
});

test('element lists accept ordinary separators and preserve invalid or unsafe input as an error',()=>{
  const item=field({key:'element_ids',rule:ids,value:'[12,34]'}),control=item.controls[1];
  assert.equal(control.value,'12, 34');assert.deepEqual(JSON.parse(item.input.value),[12,34]);
  control.value='12，34 56;78';assert.deepEqual(JSON.parse(item.input.value),[12,34,56,78]);
  for(const invalid of ['12, bad, 34','12, 12','9007199254740993','0','-2','1.5']){
    control.value=invalid;assert.throws(()=>JSON.parse(item.input.value),invalid);
  }
  item.input.value='[]';assert.throws(()=>JSON.parse(item.input.value));
  item.input.value='';assert.equal(item.input.value,'');
  item.input.value=[45,67];assert.deepEqual(JSON.parse(item.input.value),[45,67]);
  for(const invalid of [[null],['12'],['']]){item.input.value=invalid;assert.throws(()=>JSON.parse(item.input.value));}
  assert.equal(field({rule:{type:'array',items:{type:'integer'}},value:[]}).input.value,'[]');
});

test('unmodeled structured content retains its exact advanced input rather than guessing controls',()=>{
  const raw='[{"custom":"a b"}]',item=field({rule:{type:'array',items:{type:'object'}},value:raw});
  assert.equal(item.input.tagName,'TEXTAREA');assert.equal(item.input.value,raw);
  assert.equal(item.element.children[1].textContent,'高级输入（JSON）');
  assert.equal(COMMAND_PARAMETER_LABELS.axis_origin_mm,'旋转中心（mm）');
});
