import test from 'node:test';
import assert from 'node:assert/strict';
import {mountModelViewer} from './public/model-viewer.mjs';

test('mesh preview paints and picks its mapped element, with bounds fallback',()=>{
  const paths=[];let current=[];
  const ctx={setTransform(){},clearRect(){},beginPath(){current=[];},moveTo(x,y){current.push([x,y]);},lineTo(x,y){current.push([x,y]);},closePath(){},fill(){paths.push(current.slice());},stroke(){}};
  class Element {
    constructor(tag,doc){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.listeners={};this.value='';}
    append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=[...nodes];} setAttribute(){}
    addEventListener(name,fn){this.listeners[name]=fn;} getBoundingClientRect(){return {width:400,height:300,left:0,top:0};}
    getContext(){return ctx;} setPointerCapture(){} fire(name,event){this.listeners[name]?.(event);}
  }
  const doc={defaultView:{devicePixelRatio:1},createElement(tag){return new Element(tag,doc);},createTextNode(text){return {textContent:text};}};
  const root=new Element('div',doc),selected=[];const viewer=mountModelViewer({container:root,onSelect:x=>selected.push(x)});
  const snapshot={snapshotId:'snapshot',identity:{hostSession:'session'},value:{geometry:'triangle_mesh_with_bounds',items:[
    {element_id:'42',unique_id:'id42',name:'wall',category:'walls',min:{x:0,y:0,z:0},max:{x:100,y:0,z:100},mesh:[0,0,0,100,0,0,0,0,100],meshStatus:'complete'},
    {element_id:'43',unique_id:'id43',name:'fallback',category:null,min:{x:200,y:0,z:0},max:{x:300,y:100,z:100},mesh:[],meshStatus:'missing'}],
    coverage:{exported:2,triangles:1,meshPartial:0,meshMissing:1,meshFailed:0,missingBoundingBox:0,failed:0,truncated:false}}};
  viewer.load(snapshot);assert.match(root.children[1].textContent,/表面网格 1/);assert.equal(paths.length,1);
  const triangle=paths[0],x=triangle.reduce((s,p)=>s+p[0],0)/3,y=triangle.reduce((s,p)=>s+p[1],0)/3,canvas=root.children[2];
  canvas.fire('pointerdown',{clientX:x,clientY:y,pointerId:1});canvas.fire('pointerup',{clientX:x,clientY:y});
  assert.equal(selected[0].elementId,'42');assert.equal(selected[0].snapshotId,'snapshot');
  assert.equal(viewer.select('43',true),true);assert.equal(selected[1].elementId,'43');
  root.children[0].children[1].fire('click',{});
  assert.equal(selected.at(-1),null);assert.equal(root.children[0].children[3].value,'');
  assert.equal(root.children[3].textContent,'选择构件以查看属性。');
  viewer.destroy();assert.equal(root.children.length,0);
});
