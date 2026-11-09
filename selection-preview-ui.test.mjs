// Executes the production app.js in an isolated DOM/transport VM. No sockets,
// Codex process, Revit calls or production service are used by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as chatView from './public/chat-view.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const source=await fs.readFile(process.env.BUILDX_CHAT_APP_SOURCE||path.join(root,'public/app.js'),'utf8');
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.events=new Map();this.style={};this.dataset={};this.value='';this.textContent='';this.checked=false;this.hidden=false;this.disabled=false;this.className='';this.scrollHeight=60;this.scrollTop=0;this.clientHeight=300;this.isConnected=true;}
  addEventListener(name,fn){const events=this.events.get(name)||[];events.push(fn);this.events.set(name,events);}
  dispatchEvent(event){event.target=this;for(const fn of this.events.get(event.type)||[])fn(event);return true;}
  append(...nodes){for(const item of nodes){const element=typeof item==='string'?new Element():item;if(typeof item==='string')element.textContent=item;element.remove();element.parent=this;this.children.push(element);}}
  replaceChildren(...nodes){for(const child of this.children)child.parent=null;this.children=[];this.append(...nodes);}
  insertBefore(element,at){element.remove();element.parent=this;const index=this.children.indexOf(at);if(index<0)this.children.push(element);else this.children.splice(index,0,element);}
  remove(){if(this.parent){this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}}
  setAttribute(name,value){this[name]=value;}
  get childElementCount(){return this.children.length;}
  focus(){this.focused=true;}
}
class UiEvent{
  constructor(type,extra={}){this.type=type;Object.assign(this,extra);}
  preventDefault(){this.defaultPrevented=true;}
}
function session(epoch=0,messages=[]){return {messages,context:{document:null,selection:null,capturedAt:null},contextEpoch:epoch,historyTruncated:false};}

async function setup(options={}){
  const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const configuredWorkspace=options.workspace,configuredHistory=options.historyAvailable,configuredDirect=options.directCommandsAvailable;
  const suggestions=[new Element('button')];suggestions[0].dataset.prompt='检查当前模型';
  const requests=[],historyRequests=[];let identity=0,account=options.account,confirmation=Object.hasOwn(options,'confirmation')?options.confirmation:{localConnectionConfirmed:true};const window=new Element('window');
  class FakeEventSource{
    static instances=[];
    constructor(url){this.url=url;this.events=new Map();FakeEventSource.instances.push(this);}
    addEventListener(name,fn){const items=this.events.get(name)||[];items.push(fn);this.events.set(name,items);}
    emit(name,data){for(const fn of this.events.get(name)||[])fn({data:JSON.stringify(data)});}
    close(){this.closed=true;}
  }
  const sandbox={__chatView:chatView,window,document:{getElementById:get,querySelectorAll:()=>suggestions,createElement:tag=>new Element(tag),createTextNode:text=>{const node=new Element('#text');node.textContent=text;return node;},createDocumentFragment:()=>new Element('#fragment')},sessionStorage:{getItem:()=>null,setItem(){}},crypto:{randomUUID:()=>++identity===1?'id-1':`00000000-0000-4000-8000-${String(identity).padStart(12,'0')}`},Event:UiEvent,CustomEvent:UiEvent,EventSource:FakeEventSource,navigator:{clipboard:{writeText:async()=>{}}},setTimeout:(fn,ms,...args)=>options.timeoutHook&&ms===15000?options.timeoutHook(fn):setTimeout(fn,ms,...args),clearTimeout,queueMicrotask,AbortController,fetch:async(url,options)=>{
    if(url==='/api/status')return {ok:true,json:async()=>({csrf:'offline-csrf',ready:!account?.required||account.signedIn,error:false,message:'离线 UI 传输',toolCount:31,toolCatalog:[],account,codexConfirmation:confirmation,workspace:configuredWorkspace,historyAvailable:configuredHistory,directCommandsAvailable:configuredDirect})};
    if(url.startsWith('/api/chats?')){const response=deferred();historyRequests.push({url,...response});return response.promise;}
    const response=deferred();requests.push({url,body:JSON.parse(options.body),...response});return response.promise;
  }};
  const context=vm.createContext(sandbox);
  // Only resolve the existing ESM import through the actual production module;
  // the rest of app.js is evaluated unchanged, including real event handlers.
  vm.runInContext(source.replace(/^import \{([^}]+)\} from '\.\/chat-view\.mjs';/,'const {$1} = __chatView;'),context,{filename:'production/public/app.js'});
  await flush();
  const stream=()=>FakeEventSource.instances.at(-1);
  const emit=(name,data)=>stream().emit(name,data);
  const conversation=(busy=false,epoch=0,extra={})=>emit('conversation',{busy,session:session(epoch),...extra});
  const input=value=>{get('prompt').value=value;get('prompt').dispatchEvent(new UiEvent('input'));};
  const submit=async()=>{get('composer').dispatchEvent(new UiEvent('submit'));await flush();};
  const click=async id=>{get(id).dispatchEvent(new UiEvent('click'));await flush();};
  const respond=async(request,data={ok:true},ok=true)=>{request.resolve({ok,json:async()=>data});await flush();};
  const reject=async(request,message)=>{request.reject(new Error(message));await flush();};
  emit('snapshot',{busy:false,session:options.initialSession||session(),draft:options.draft,history:options.history});
  return {get,requests,historyRequests,emit,conversation,input,submit,click,respond,reject,stream,suggestions,context,window,setAccount:value=>{account=value;},setConfirmation:value=>{confirmation=value;},accountEvent:async name=>{window.dispatchEvent(new UiEvent(name));await flush();},selectHistory:async id=>{window.dispatchEvent(new UiEvent('buildx-history-select',{detail:{conversationId:id}}));await flush();}};
}

test('managed inference uses its own readiness state without a local Codex confirmation',async()=>{
  const account={required:true,configured:true,signedIn:true,user:{id:'fixture-user'}};
  const workspace={kind:'model',supportsModelContext:true};
  const confirmation={required:false,phase:'not_applicable',localConnectionConfirmed:false};
  const ui=await setup({account,workspace,confirmation});
  const state={ready:true,error:false,account,workspace,codexConfirmation:confirmation,inferenceMode:'buildx-managed'};
  ui.emit('state',{...state,managedInferenceReady:false});
  assert.equal(vm.runInContext('ready',ui.context),false);
  ui.emit('state',{...state,managedInferenceReady:true});
  assert.equal(vm.runInContext('ready',ui.context),true);
  ui.emit('state',{...state,managedInferenceReady:false});
  assert.equal(vm.runInContext('ready',ui.context),false);
});

test('selection preview reads only selection and send requests fresh context',async()=>{
 const ui=await setup(); const checkbox=ui.get('include-selection'); checkbox.checked=true; checkbox.dispatchEvent(new UiEvent('change')); await flush();
 const req=ui.requests.find(r=>r.url==='/api/context'); assert.ok(req); assert.equal(req.body.includeDocument,false); assert.equal(req.body.includeSelection,true);
 assert.match(ui.get('context-summary').textContent,/正在读取/);
 await ui.respond(req,{context:{selection:{count:3,elementIds:['42','43'],truncated:true},capturedAt:'2026-11-07T00:00:00Z'}});
 assert.match(ui.get('selection-inline-summary').textContent,/3 项：42、43（部分）/); assert.match(ui.get('selection-inline-content').textContent,/展示 2 \/ 3 项/); assert.match(ui.get('selection-inline-content').textContent,/2026-11-07T00:00:00Z/);
 assert.match(ui.get('context-content').textContent,/42、43/); assert.match(ui.get('context-content').textContent,/截断/); assert.match(ui.get('context-content').textContent,/发送时将重新读取/);
 ui.input('统计选择'); await ui.submit(); const turn=ui.requests.find(r=>r.url==='/api/turn'); assert.equal(turn.body.context.includeSelection,true);
});
test('selection preview ignores stale responses after uncheck and context switch',async()=>{
 const ui=await setup(); const checkbox=ui.get('include-selection'); checkbox.checked=true; checkbox.dispatchEvent(new UiEvent('change')); await flush(); const first=ui.requests.at(-1);
 checkbox.checked=false; checkbox.dispatchEvent(new UiEvent('change')); checkbox.checked=true; checkbox.dispatchEvent(new UiEvent('change')); await flush();
 assert.equal(ui.requests.filter(r=>r.url==='/api/context').length,1); assert.match(ui.get('context-summary').textContent,/待核实/);
 ui.conversation(false,1); checkbox.checked=true; checkbox.dispatchEvent(new UiEvent('change')); await flush(); assert.equal(ui.requests.filter(r=>r.url==='/api/context').length,1);
 await ui.respond(first,{context:{selection:{count:1,elementIds:['STALE']},capturedAt:'old'}}); assert.doesNotMatch(ui.get('context-content').textContent,/STALE/);
});
test('selection preview shows errors and clears them on uncheck',async()=>{
 const ui=await setup(); const checkbox=ui.get('include-selection'); checkbox.checked=true; checkbox.dispatchEvent(new UiEvent('change')); await flush(); await ui.respond(ui.requests.at(-1),{error:'读取失败'},false);
 assert.match(ui.get('context-summary').textContent,/读取失败/); assert.match(ui.get('context-content').textContent,/读取失败/); checkbox.checked=false; checkbox.dispatchEvent(new UiEvent('change')); assert.doesNotMatch(ui.get('context-content').textContent,/读取失败/);
});

test('restored selection preference clearly states it has not been read',async()=>{
 const ui=await setup(); vm.runInContext("restoreConversationDraft('restored', {text:'draft', includeSelection:true}); renderContext(); updateButtons()",ui.context);
 assert.notEqual(ui.get('context-details').open,true); assert.equal(ui.requests.filter(r=>r.url==='/api/context').length,0);
 assert.match(ui.get('context-summary').textContent,/选择信息未取得/); assert.match(ui.get('context-content').textContent,/尚未读取/); assert.match(ui.get('context-content').textContent,/点击刷新/);
 await ui.click('refresh-context'); const req=ui.requests.find(r=>r.url==='/api/context'); assert.ok(req); assert.equal(req.body.includeSelection,true); assert.equal(req.body.includeDocument,false);
 await ui.respond(req,{context:{selection:{count:1,elementIds:['42']},capturedAt:'now'}}); assert.match(ui.get('context-content').textContent,/42/);
});

test('selection inline preview preserves unknown totals and closes when unchecked',async()=>{
 const ui=await setup();const checkbox=ui.get('include-selection');checkbox.checked=true;checkbox.dispatchEvent(new UiEvent('change'));await flush();
 assert.match(ui.get('selection-inline-summary').textContent,/读取中/);
 await ui.respond(ui.requests.at(-1),{context:{selection:{elementIds:['42'],truncated:true}}});
 assert.match(ui.get('selection-inline-summary').textContent,/数量未知：42（部分）/);assert.match(ui.get('context-content').textContent,/总数未知/);
 ui.get('selection-inline').open=true;checkbox.checked=false;checkbox.dispatchEvent(new UiEvent('change'));assert.equal(ui.get('selection-inline').hidden,true);assert.equal(ui.get('selection-inline').open,false);
});

test('timed-out preview releases the owned send guard and does not replay',async()=>{
 let timeout;const ui=await setup({timeoutHook:fn=>{timeout=fn;return 0;}});ui.input('hello');const checkbox=ui.get('include-selection');checkbox.checked=true;checkbox.dispatchEvent(new UiEvent('change'));await flush();
 const request=ui.requests.find(r=>r.url==='/api/context');assert.ok(request);assert.equal(ui.get('send').disabled,true);timeout();await flush();
 assert.equal(ui.get('send').disabled,true);assert.match(ui.get('context-content').textContent,/超时/);assert.equal(ui.requests.filter(r=>r.url==='/api/context').length,1);
 assert.equal(ui.get('refresh-context').disabled,true); await ui.click('refresh-context'); assert.equal(ui.requests.filter(r=>r.url==='/api/context').length,1);
 await ui.respond(request,{context:{selection:{count:1,elementIds:['STALE']}}});assert.doesNotMatch(ui.get('context-content').textContent,/STALE/);
});

test('late session context after timeout stays unconfirmed but displays later snapshot and errors',async()=>{
 let timeout;const ui=await setup({timeoutHook:fn=>{timeout=fn;return 0;}});ui.get('include-document').checked=true;const box=ui.get('include-selection');box.checked=true;box.dispatchEvent(new UiEvent('change'));await flush();timeout();
 ui.emit('conversation',{busy:false,session:{...session(),context:{document:{title:'新模型'},selection:{count:2,elementIds:['123'],truncated:true},capturedAt:'later'}}});
 assert.match(ui.get('context-summary').textContent,/新模型/);assert.match(ui.get('context-summary').textContent,/待核实/);assert.match(ui.get('context-content').textContent,/无法确认是否来自原请求/);assert.match(ui.get('context-content').textContent,/123/);assert.match(ui.get('context-content').textContent,/截断/);
 assert.match(ui.get('selection-inline-content').textContent,/无法确认是否来自原请求/);assert.match(ui.get('selection-inline-content').textContent,/123/);assert.match(ui.get('selection-inline-content').textContent,/截断/);assert.match(ui.get('selection-inline-content').textContent,/later/);assert.match(ui.get('selection-inline-content').textContent,/原回执尚未核实/);
 ui.emit('conversation',{busy:false,session:{...session(),context:{document:null,selection:null,capturedAt:null,error:'原回执未确认'}}});assert.match(ui.get('context-content').textContent,/原回执未确认/);
 assert.match(ui.get('selection-inline-content').textContent,/原回执未确认/);
});

test('only the original receipt clears the selection guard',async()=>{
 let timeout; const ui=await setup({timeoutHook:fn=>{timeout=fn;return 0;}}); const box=ui.get('include-selection'); box.checked=true; box.dispatchEvent(new UiEvent('change')); await flush(); timeout();
 const id='12345678-1234-4234-8234-123456789abc', other='87654321-1234-4234-8234-123456789abc';
 vm.runInContext(`observeSelectionReceipt('Revit 上下文读取未取得可核对的回执。 请求 ${id}。')`,ui.context);
 vm.runInContext(`observeSelectionReceipt('原回执确认请求已过期，上下文读取未执行。 请求 ${other}。')`,ui.context);
 await ui.click('refresh-context'); assert.equal(ui.requests.filter(r=>r.url==='/api/context').length,1);
 vm.runInContext(`observeSelectionReceipt('原回执确认请求已过期，上下文读取未执行。 请求 ${id}。'); updateButtons()`,ui.context);
 await ui.click('refresh-context'); assert.equal(ui.requests.filter(r=>r.url==='/api/context').length,2);
});
