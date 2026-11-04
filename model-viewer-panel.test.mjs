import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('./public/model-viewer-ui.mjs',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const response=value=>({ok:true,json:async()=>value});
const flush=async()=>{for(let n=0;n<5;n++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(fetchImpl){
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.events={};this.dataset={};this.textContent='';this.disabled=false;this.value='';}
    append(...items){this.children.push(...items);} setAttribute(){} addEventListener(type,handler){this.events[type]=handler;}
    fire(type,event={}){return this.events[type]?.(event);} focus(){} dispatchEvent(){}
  }
  const root=new Element('section'),prompt=new Element('textarea'),listeners={},store=new Map([['revit-codex-client','synthetic-client']]),viewers=[];
  const doc={getElementById:id=>id==='model-viewer-panel'?root:id==='prompt'?prompt:null,createElement:tag=>new Element(tag)};
  const window={addEventListener:(name,fn)=>{listeners[name]=fn;},dispatchEvent(){}};
  const mountModelViewer=({onSelect})=>{const viewer={loaded:[],destroyed:false,onSelect,load(value){this.loaded.push(value);},clearSelection(notify){if(notify)onSelect(null);},destroy(){this.destroyed=true;}};viewers.push(viewer);return viewer;};
  const sessionStorage={getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)};
  vm.runInNewContext(source.replace(/^import .*\r?\n/,'') ,{document:doc,window,mountModelViewer,sessionStorage,fetch:fetchImpl,AbortController,setTimeout,clearTimeout,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},Event:class{},CustomEvent:class{}});
  return {root,prompt,listeners,viewers,store,button:text=>root.children.find(item=>item.textContent===text),status:()=>root.children.find(item=>item.tag==='p'&&item.events===undefined)??root.children.find(item=>item.tag==='p'&&item.textContent.includes('快照'))};
}
const goodStatus=()=>response({workspace:{kind:'model'},csrf:'synthetic-csrf'});
const snapshot={snapshotId:'snapshot-a',identity:{hostSession:'synthetic'},value:{items:[],coverage:{}}};

test('switching project before admission prevents the old capture from being posted',async()=>{
  const pending=deferred(),calls=[];const ui=fixture(async(url,options)=>{calls.push({url,options});return pending.promise;});
  const action=ui.button('生成快照').fire('click');await flush();ui.listeners['buildx-project-changed']();
  pending.resolve(goodStatus());await action;
  assert.equal(calls.length,1);assert.equal(ui.viewers[0].destroyed,true);assert.equal(ui.viewers[1].loaded.length,0);
  assert.equal(ui.store.has('buildx-viewer-request'),false);assert.equal(ui.button('生成快照').disabled,false);
});

test('switching project after submission retains unknown receipt and ignores the late result',async()=>{
  const pending=deferred(),calls=[];const ui=fixture(async(url,options)=>{calls.push({url,options});return url==='/api/status'?goodStatus():pending.promise;});
  const action=ui.button('生成快照').fire('click');await flush();assert.equal(calls.length,2);
  ui.listeners['buildx-project-changed']();assert.equal(ui.button('生成快照').disabled,true);assert.ok(ui.store.has('buildx-viewer-request'));
  pending.resolve(response({ok:true,value:snapshot}));await action;
  assert.equal(ui.viewers[1].loaded.length,0);assert.equal(ui.store.has('buildx-viewer-request'),true);
});

test('different document status clears selection and blocks attaching old snapshot elements',async()=>{
  let state='freshness_unknown';const actions=[];
  const ui=fixture(async(url,options)=>{if(url==='/api/status')return goodStatus();const action=JSON.parse(options.body).action;actions.push(action);
    if(action==='refresh')return response({ok:true,value:snapshot});
    if(action==='status')return response({ok:true,value:{snapshotId:'snapshot-a',state,capturedAt:'2026-10-29T00:00:00Z'}});
    throw new Error('unexpected synthetic request');});
  await ui.button('生成快照').fire('click');ui.viewers[0].onSelect({snapshotId:'snapshot-a',elementId:'42',identity:{hostSession:'synthetic'}});
  state='different_document';await ui.button('核查快照状态').fire('click');
  ui.viewers[0].onSelect({snapshotId:'snapshot-a',elementId:'42',identity:{hostSession:'synthetic'}});ui.button('将所选构件附到对话').fire('click');
  assert.equal(ui.prompt.value,'');assert.deepEqual(actions,['refresh','status']);
  assert.ok(ui.root.children.some(item=>item.textContent.includes('当前快照不可附到对话')));
});

test('opening current snapshot also invalidates an old selection when document changed',async()=>{
  const ui=fixture(async(url,options)=>{if(url==='/api/status')return goodStatus();const action=JSON.parse(options.body).action;
    return response({ok:true,value:action==='refresh'?snapshot:{state:'different_document',snapshotId:'snapshot-a'}});});
  await ui.button('生成快照').fire('click');ui.viewers[0].onSelect({snapshotId:'snapshot-a',elementId:'42'});
  await ui.button('打开当前快照').fire('click');ui.button('将所选构件附到对话').fire('click');
  assert.equal(ui.prompt.value,'');assert.ok(ui.root.children.some(item=>item.textContent.includes('当前快照不可附到对话')));
});

test('same snapshot identity never becomes a claim of current model freshness',async()=>{
  const ui=fixture(async(url,options)=>{if(url==='/api/status')return goodStatus();const action=JSON.parse(options.body).action;
    return response({ok:true,value:action==='refresh'?snapshot:{state:'freshness_unknown',snapshotId:'snapshot-a',capturedAt:'2026-10-29T00:00:00Z'}});});
  await ui.button('生成快照').fire('click');await ui.button('核查快照状态').fire('click');
  assert.ok(ui.root.children.some(item=>item.textContent.includes('快照新鲜度未知；文档或模型可能已变化')));
});
