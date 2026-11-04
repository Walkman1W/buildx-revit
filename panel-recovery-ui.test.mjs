// Production UI under a synthetic DOM and HTTP/SSE transport. No Revit,
// Codex process or external service is contacted by this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as chatView from './public/chat-view.mjs';

const source=await fs.readFile(new URL('./public/app.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.events=new Map();this.style={};this.dataset={};this.value='';this.textContent='';this.checked=false;this.hidden=false;this.disabled=false;this.className='';this.scrollHeight=60;this.scrollTop=0;this.clientHeight=300;this.isConnected=true;}
  addEventListener(type,fn){const list=this.events.get(type)||[];list.push(fn);this.events.set(type,list);}
  dispatchEvent(event){event.target=this;for(const fn of this.events.get(event.type)||[])fn(event);return true;}
  append(...items){for(let item of items){if(typeof item==='string'){const node=new Element('#text');node.textContent=item;item=node;}item.remove();item.parent=this;this.children.push(item);}}
  replaceChildren(...items){for(const item of this.children)item.parent=null;this.children=[];this.append(...items);}
  insertBefore(item,before){item.remove();item.parent=this;const i=this.children.indexOf(before);if(i<0)this.children.push(item);else this.children.splice(i,0,item);}
  remove(){if(this.parent){this.parent.children=this.parent.children.filter(item=>item!==this);this.parent=null;}}
  setAttribute(key,value){this[key]=value;}
  get childElementCount(){return this.children.length;}
  focus(){}
}
class UiEvent{constructor(type,options={}){this.type=type;Object.assign(this,options);}preventDefault(){}}

async function fixture(){
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const win=new Element('window'),calls=[];let id=0,queued=null;
  const state=extra=>({workspace:{kind:'model',supportsModelContext:true},csrf:'fixture',ready:true,busy:false,error:false,message:'后台就绪',toolCount:37,account:{required:false},...extra});
  class Stream{
    static all=[];
    constructor(){this.events=new Map();Stream.all.push(this);}
    addEventListener(type,fn){const list=this.events.get(type)||[];list.push(fn);this.events.set(type,list);}
    emit(type,data){for(const fn of this.events.get(type)||[])fn({data:JSON.stringify(data)});}
    close(){this.closed=true;}
  }
  const sandbox={__chatView:chatView,window:win,document:{getElementById:get,querySelectorAll:()=>[],createElement:tag=>new Element(tag),createTextNode:text=>{const e=new Element('#text');e.textContent=text;return e;},createDocumentFragment:()=>new Element('#fragment')},sessionStorage:{getItem:()=>null,setItem(){}},crypto:{randomUUID:()=>`fixture-${++id}`},Event:UiEvent,CustomEvent:UiEvent,EventSource:Stream,AbortController,navigator:{clipboard:{writeText:async()=>{}}},setTimeout,clearTimeout,queueMicrotask,
    fetch:async(url,options={})=>{calls.push({url,method:options.method||'GET'});if(url==='/api/status'){if(queued){const pending=queued;queued=null;return pending.promise;}return {ok:true,json:async()=>state()};}if(url==='/api/reconnect')return {ok:true,json:async()=>({ok:true})};throw new Error('unexpected request '+url);}};
  const context=vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import \{([^}]+)\} from '\.\/chat-view\.mjs';/,'const {$1} = __chatView;'),context,{filename:'production/public/app.js'});
  await flush();const current=()=>Stream.all.at(-1);
  const snapshot=(stream=current(),value=state())=>stream.emit('snapshot',{workspace:value.workspace,state:value,busy:value.busy,session:{messages:[],contextEpoch:0,context:{document:null,selection:null,capturedAt:null}}});
  current().onopen();snapshot();await flush();
  return {get,win,current,state,snapshot,calls,queueStatus(){queued=deferred();return queued;},async click(id){get(id).dispatchEvent(new UiEvent('click'));await flush();}};
}

test('HTTP readiness during an SSE outage cannot claim the panel recovered; a fresh opened stream snapshot can',async()=>{
  const f=await fixture(),stream=f.current();
  stream.onerror();await flush();
  assert.match(f.get('error-notice').textContent,/本地连接已中断/);
  assert.equal(f.get('send').disabled,true);
  assert.match(f.get('status-text').textContent,/正在恢复面板连接/);
  // Opening the same EventSource is not enough until current state arrives.
  const delayed=f.queueStatus();stream.onopen();await flush();
  assert.match(f.get('error-notice').textContent,/本地连接已中断/);
  f.snapshot(stream);await flush();
  assert.match(f.get('error-notice').textContent,/连接已恢复/);
  assert.match(f.get('error-notice').textContent,/结果仍需核对/);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
  delayed.resolve({ok:true,json:async()=>f.state({ready:false,message:'stale'})});await flush();
  assert.match(f.get('error-notice').textContent,/连接已恢复/);
  assert.equal(f.get('status-text').textContent,'后台就绪');
});

test('a newer non-connection failure is never replaced by a later recovery notice',async()=>{
  const f=await fixture(),stream=f.current();stream.onerror();await flush();
  stream.emit('failure',{message:'先核对上一项操作'});
  assert.equal(f.get('error-notice').textContent,'先核对上一项操作');
  stream.onopen();f.snapshot(stream);await flush();
  assert.equal(f.get('error-notice').textContent,'先核对上一项操作');
  assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
});

test('a fresh conversation event also carries authoritative recovery state',async()=>{
  const f=await fixture(),stream=f.current();stream.onerror();await flush();
  const delayed=f.queueStatus();stream.onopen();
  const state=f.state();stream.emit('conversation',{workspace:state.workspace,state,busy:false,session:{messages:[],contextEpoch:0,context:{document:null,selection:null,capturedAt:null}}});await flush();
  assert.match(f.get('error-notice').textContent,/连接已恢复/);
  assert.match(f.get('error-notice').textContent,/结果仍需核对/);
  delayed.resolve({ok:true,json:async()=>f.state({ready:false})});await flush();
  assert.equal(f.get('status-text').textContent,'后台就绪');
  assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
});

test('an incompatible snapshot or unready state cannot declare recovery',async()=>{
  const f=await fixture(),stream=f.current();stream.onerror();await flush();
  const delayed=f.queueStatus();stream.onopen();
  f.snapshot(stream,f.state({workspace:{kind:'source-development',supportsModelContext:false}}));await flush();
  assert.doesNotMatch(f.get('error-notice').textContent,/连接已恢复/);
  f.snapshot(stream,f.state({ready:false,error:true}));await flush();
  assert.doesNotMatch(f.get('error-notice').textContent,/连接已恢复/);
  assert.equal(f.get('send').disabled,true);
  delayed.resolve({ok:true,json:async()=>f.state({ready:false})});await flush();
});

test('late open and snapshot from a replaced stream cannot declare recovery',async()=>{
  const f=await fixture(),old=f.current();old.onerror();await flush();
  await f.click('reconnect');const current=f.current();assert.notEqual(current,old);
  old.onopen();f.snapshot(old);await flush();
  assert.doesNotMatch(f.get('error-notice').textContent,/连接已恢复/);
  const delayed=f.queueStatus();current.onopen();f.snapshot(current);await flush();
  // Manual reconnect clears the old transport notice, but never causes a
  // replay of a turn; only the requested reconnect POST was sent.
  assert.deepEqual(f.calls.filter(call=>call.method==='POST').map(call=>call.url),['/api/reconnect']);
  delayed.resolve({ok:true,json:async()=>f.state()});await flush();
});
