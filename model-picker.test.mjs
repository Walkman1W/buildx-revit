import test from 'node:test';
import assert from 'node:assert/strict';
import {mountModelPicker} from './public/model-picker.mjs';

class Node {
  constructor(tag){this.tag=tag;this.children=[];this.listeners=new Map();this.hidden=false;this.disabled=false;this.value='';this.textContent='';}
  append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
  prepend(node){node.parentNode=this;this.children.unshift(node);}
  insertBefore(node,anchor){node.parentNode=this;const index=this.children.indexOf(anchor);this.children.splice(index<0?this.children.length:index,0,node);}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(name,value){this[name]=value;}
  addEventListener(name,fn){const listeners=this.listeners.get(name)??[];listeners.push(fn);this.listeners.set(name,listeners);}
  dispatchEvent(event){for(const fn of this.listeners.get(event.type)??[])fn(event);}
  contains(target){return this===target||this.children.some(child=>child.contains(target));}
  focus(){this.focused=true;}
}
class UiEvent {constructor(type,options={}){this.type=type;this.detail=options.detail;this.key=options.key;this.target=options.target;}}
function fixture(){
  const parent=new Node('div'),window=new Node('window'),send=new Node('button');send.id='send';parent.append(send);
  const document={querySelector:selector=>selector==='.composer-bottom'?parent:selector==='#send'?send:null,createElement:tag=>new Node(tag)};
  mountModelPicker({document,window,CustomEvent:UiEvent});const root=parent.children[0],toggle=root.children[0],menu=root.children[1];
  return {parent,root,toggle,menu,model:menu.children[1],effortWrap:menu.children[2],effort:menu.children[2].children[1],hint:menu.children[3],note:menu.children[5],window};
}

test('the compact selector opens and closes with the current model and supported effort',()=>{
  const {parent,root,toggle,menu,model,effortWrap,effort,hint,window}=fixture(),selected=[];
  window.addEventListener('buildx-model-effort-select',event=>selected.push(event.detail.effort));
  window.dispatchEvent(new UiEvent('buildx-model-picker-view',{detail:{enabled:true,ready:true,models:[{model:'a',displayName:'A'}],selected:'a',efforts:[{reasoningEffort:'low',description:'fast'},{reasoningEffort:'high',description:'deep'}],selectedEffort:'high'}}));
  assert.equal(parent.children[1].id,'send');assert.equal(root.hidden,false);assert.equal(menu.hidden,true);assert.equal(toggle.children[1].textContent,'A');assert.equal(toggle.children[2].textContent,'高');
  toggle.dispatchEvent(new UiEvent('click'));assert.equal(menu.hidden,false);assert.equal(toggle['aria-expanded'],'true');
  assert.equal(effortWrap.hidden,false);assert.equal(effort.hidden,false);assert.equal(effort.type,'range');assert.equal(effort.min,'1');assert.equal(effort.max,'2');assert.equal(effort.value,'2');
  assert.equal(model.title,'模型：A');assert.equal(model['aria-label'],'模型：A');assert.equal(effort.title,'deep');assert.equal(effort['aria-label'],'选择思考强度');assert.equal(effort['aria-valuetext'],'高');
  effort.value='1';effort.dispatchEvent(new UiEvent('input'));assert.equal(effort['aria-valuetext'],'低');effort.dispatchEvent(new UiEvent('change'));assert.deepEqual(selected,['low']);
  effort.value='4';effort.dispatchEvent(new UiEvent('change'));assert.deepEqual(selected,['low']);
  window.dispatchEvent(new UiEvent('keydown',{key:'Escape'}));assert.equal(menu.hidden,true);assert.equal(toggle['aria-expanded'],'false');assert.equal(toggle.focused,true);
  toggle.dispatchEvent(new UiEvent('click'));window.dispatchEvent(new UiEvent('click',{target:parent}));assert.equal(menu.hidden,true);
  window.dispatchEvent(new UiEvent('buildx-model-picker-view',{detail:{enabled:true,ready:true,blocked:true,models:[{model:'a',displayName:'A'}],selected:'a',efforts:[{reasoningEffort:'low',description:'fast'}],selectedEffort:'low'}}));assert.equal(model.disabled,true);assert.equal(effort.disabled,true);
  window.dispatchEvent(new UiEvent('buildx-model-picker-view',{detail:{enabled:true,ready:true,models:[{model:'old',displayName:'Old'}],selected:'old'}}));assert.equal(effort.hidden,true);assert.equal(effortWrap.hidden,true);assert.equal(hint.hidden,true);
  window.dispatchEvent(new UiEvent('buildx-model-picker-view',{detail:{enabled:true,ready:true,models:[{model:'unknown',displayName:'Unknown'}],selected:'unknown',effortUnknown:true}}));assert.equal(effort.hidden,true);assert.match(hint.textContent,/当前会话设置/);
});

test('an absent selection remains explicit and a single advertised stop can be chosen',()=>{
  const {effort,toggle,window}=fixture(),selected=[];window.addEventListener('buildx-model-effort-select',event=>selected.push(event.detail.effort));
  window.dispatchEvent(new UiEvent('buildx-model-picker-view',{detail:{enabled:true,ready:true,models:[{model:'a',displayName:'A'}],selected:'a',efforts:[{reasoningEffort:'high'}],selectedEffort:''}}));
  assert.equal(effort.min,'0');assert.equal(effort.max,'1');assert.equal(effort.value,'0');assert.equal(effort['aria-valuetext'],'未选择');assert.equal(toggle.children[2].hidden,true);
  effort.value='1';effort.dispatchEvent(new UiEvent('change'));assert.deepEqual(selected,['high']);
});

test('effort descriptions are bounded and model selection keeps the original event contract',()=>{
  const {model,effort,note,window}=fixture(),selected=[];window.addEventListener('buildx-model-picker-select',event=>selected.push(event.detail.model));
  window.dispatchEvent(new UiEvent('buildx-model-picker-view',{detail:{enabled:true,ready:true,models:[{model:'a',displayName:'A'}],selected:'a',efforts:[{reasoningEffort:'high',description:'x'.repeat(2000)}],selectedEffort:'high'}}));
  assert.equal(effort.title.length,300);model.value='a';model.dispatchEvent(new UiEvent('change'));assert.deepEqual(selected,['a']);
  window.dispatchEvent(new UiEvent('buildx-model-picker-view',{detail:{enabled:true,ready:true,models:[{model:'a',displayName:'A'}],selected:'a',effortInvalid:true}}));assert.match(note.textContent,/数据无效/);
});
