// Production app + both account widgets share one VM/DOM/HTTP/SSE consumer.
// Peers are fixtures: no browser, real account, Codex, cloud, socket or Revit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as chatView from '../public/chat-view.mjs';

const app=await fs.readFile(process.env.BUILDX_INTERRUPTION_APP_SOURCE||new URL('../public/app.js',import.meta.url),'utf8');
const account=await fs.readFile(new URL('../public/account.js',import.meta.url),'utf8');
const codex=await fs.readFile(new URL('../public/codex-account.js',import.meta.url),'utf8');
const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
const flush=async()=>{for(let n=0;n<10;n++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const unknown={code:'turn_result_unknown',message:'上一轮对话的结果未知；请核对后再明确发起新消息。'};
const now=Date.parse('2026-10-25T02:00:00.000Z');
const state=extra=>({workspace:{kind:'customer-chat',supportsModelContext:false},csrf:'fixture-csrf',busy:false,ready:true,error:false,message:'fixture ready',toolCount:0,toolCatalog:[],
  account:{configured:true,required:true,signedIn:true,user:{id:'fixture-user',email:'buildx@example.test'},expiresAt:now+3600000},
  codexConnectionReady:true,codexAccount:{status:'verified',connectionGeneration:1,accountRevision:1,observationSequence:2,observedAt:new Date(now).toISOString()},
  codexConfirmation:{required:true,phase:'confirmed',localConnectionConfirmed:true},interruptionNotice:null,...extra});
const unconfirmed=extra=>state({ready:false,codexConfirmation:{required:true,phase:'confirmation_required',localConnectionConfirmed:false},...extra});
const session=(messages=[],epoch=0)=>({messages,contextEpoch:epoch,context:{document:null,selection:null,capturedAt:null},historyTruncated:false});

class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.events=new Map();this.dataset={};this.style={};this.value='';this.textContent='';this.hidden=false;this.disabled=false;this.checked=false;this.className='';this.scrollHeight=60;this.clientHeight=300;this.scrollTop=0;this.isConnected=true;}
  addEventListener(name,fn){const items=this.events.get(name)||[];items.push(fn);this.events.set(name,items);}
  dispatchEvent(event){event.target=this;for(const fn of this.events.get(event.type)||[])fn(event);return true;}
  append(...items){for(let item of items){if(typeof item==='string'){const value=item;item=new Element('#text');item.textContent=value;}item.remove();item.parent=this;this.children.push(item);}}
  replaceChildren(...items){for(const item of this.children)item.parent=null;this.children=[];this.append(...items);}
  insertBefore(item,before){item.remove();item.parent=this;const index=this.children.indexOf(before);if(index<0)this.children.push(item);else this.children.splice(index,0,item);}
  remove(){if(this.parent){this.parent.children=this.parent.children.filter(item=>item!==this);this.parent=null;}}
  setAttribute(name,value){this[name]=value;}
  get childElementCount(){return this.children.length;}
  focus(){this.focused=true;}
}
class UiEvent{constructor(type,extra={}){this.type=type;Object.assign(this,extra);}preventDefault(){this.defaultPrevented=true;}}
async function fixture(t){
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element()]));
  const get=id=>{assert.ok(elements.has(id),'unknown hook '+id);return elements.get(id);};
  const suggestions=Array.from({length:3},()=>new Element('button')),window=new Element('window'),requests=[],timers=[],storage=new Map(),statusQueue=[];
  let current=state(),identity=0;
  class FakeEventSource{
    static instances=[];
    constructor(url){this.url=url;this.events=new Map();FakeEventSource.instances.push(this);}
    addEventListener(name,fn){const list=this.events.get(name)||[];list.push(fn);this.events.set(name,list);}
    emit(name,value){for(const fn of this.events.get(name)||[])fn({data:JSON.stringify(value)});}
    close(){this.closed=true;}
  }
  const sandbox={__chatView:chatView,window,document:{getElementById:get,querySelectorAll:()=>suggestions,createElement:tag=>new Element(tag),createTextNode:text=>{const e=new Element('#text');e.textContent=text;return e;},createDocumentFragment:()=>new Element('#fragment')},
    crypto:{randomUUID:()=> 'fixture-client-'+(++identity)},sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    Event:UiEvent,CustomEvent:UiEvent,EventSource:FakeEventSource,AbortController,TextEncoder,
    Date:class extends Date{static now(){return now;}},navigator:{clipboard:{writeText:async()=>{}}},
    setTimeout:(fn,ms)=>{const timer={fn,ms,cleared:false};timers.push(timer);return timer;},clearTimeout:timer=>{if(timer)timer.cleared=true;},
    fetch:async(url,options={})=>{
      const request={url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null,options};requests.push(request);let value;
      if(url==='/api/status')value=statusQueue.length?await statusQueue.shift()(request):current;
      else if(url==='/api/account/status')value=current.account;
      else if(url==='/api/reconnect'){
        current=unconfirmed({codexAccount:{...current.codexAccount,status:'verified',connectionGeneration:current.codexAccount.connectionGeneration+1,accountRevision:current.codexAccount.accountRevision+1},interruptionNotice:current.interruptionNotice});value={ok:true};
      }else if(url==='/api/codex-account/inspect')value={ok:true,challengeId:'fixturechallenge00000001',expiresAt:now+60000,display:{type:'chatgpt',email:'codex@example.test',planType:'free',observedAt:new Date(now).toISOString()},confirmation:{required:true,phase:'prepared',localConnectionConfirmed:false}};
      else if(url==='/api/codex-account/confirm'){current={...current,ready:true,codexConfirmation:{required:true,phase:'confirmed',localConnectionConfirmed:true}};value={ok:true,confirmation:current.codexConfirmation};}
      else if(url==='/api/new-chat'){current={...current,interruptionNotice:null};value={ok:true,workspace:current.workspace,session:session([],1)};}
      else if(url==='/api/turn'){current={...current,busy:true,interruptionNotice:null};value={ok:true};}
      else throw new Error('unexpected route '+url);
      return {ok:true,status:options.method==='POST'?202:200,json:async()=>value};
    }};
  const context=vm.createContext(sandbox);
  vm.runInContext(app.replace(/^import \{([^}]+)\} from '\.\/chat-view\.mjs';/,'const {$1} = __chatView;'),context,{filename:'production/public/app.js'});
  vm.runInContext(account,context,{filename:'production/public/account.js'});
  vm.runInContext(codex,context,{filename:'production/public/codex-account.js'});
  await flush();
  t.after(()=>window.dispatchEvent(new UiEvent('pagehide')));
  const stream=()=>FakeEventSource.instances.at(-1);
  const emit=(name,value)=>stream().emit(name,value);
  const snapshot=(value=current,messages=[],epoch=0)=>emit('snapshot',{workspace:value.workspace,state:value,busy:value.busy,session:session(messages,epoch)});
  snapshot();
  return {get,requests,timers,stream,emit,snapshot,window,context,
    posts:()=>requests.filter(request=>request.method==='POST'),statusReads:()=>requests.filter(request=>request.url==='/api/status'),
    setState:value=>{current=value;},getState:()=>current,queueStatus:fn=>statusQueue.push(fn),
    input(text){get('prompt').value=text;get('prompt').dispatchEvent(new UiEvent('input'));},
    active(){current={...current,busy:true};snapshot(current,[{id:'old-user',role:'user',text:'private-old-request',tools:[]},{id:'old-assistant',role:'assistant',text:'partial reply',status:'streaming',tools:[]}]);},
    async click(id){get(id).dispatchEvent(new UiEvent('click'));await flush();},
    async submit(){get('composer').dispatchEvent(new UiEvent('submit'));await flush();}};
}

test('customer EOF is checked with GET; unknown notice survives empty snapshot, explicit reconnect and renewed confirmation',async t=>{
  const f=await fixture(t);f.active();f.input('new deliberate draft');const reads=f.statusReads().length;
  f.setState(unconfirmed({error:true,message:'fixture EOF',busy:false,codexConnectionReady:false,codexAccount:{...f.getState().codexAccount,status:'unknown',accountRevision:2},interruptionNotice:unknown}));
  f.stream().onerror();await flush();
  assert.equal(f.statusReads().length,reads+1);assert.equal(f.get('reconnect').disabled,false);assert.match(f.get('error-notice').textContent,/上一轮对话的结果未知/);
  assert.equal(f.get('prompt').value,'new deliberate draft');assert.equal(f.posts().length,0);
  const partial={...f.getState()};delete partial.interruptionNotice;f.snapshot(partial);assert.equal(f.get('transcript').childElementCount,0);assert.match(f.get('error-notice').textContent,/上一轮对话的结果未知/);
  await f.click('reconnect');assert.deepEqual(f.posts().map(request=>request.url),['/api/reconnect']);assert.match(f.get('error-notice').textContent,/上一轮对话的结果未知/);
  f.stream().onopen();await flush();f.snapshot();assert.equal(f.get('send').disabled,true);assert.equal(f.get('codex-account-inspect').disabled,false);
  await f.click('codex-account-inspect');await f.click('codex-account-confirm');f.stream().onopen();await flush();f.snapshot();
  assert.equal(f.get('codex-account-summary').textContent,'本机连接已确认');assert.equal(f.get('send').disabled,false);assert.match(f.get('error-notice').textContent,/上一轮对话的结果未知/);
  assert.equal(f.posts().filter(request=>request.url==='/api/turn').length,0);assert.equal(f.get('prompt').value,'new deliberate draft');
  await f.submit();const turns=f.posts().filter(request=>request.url==='/api/turn');assert.equal(turns.length,1);assert.equal(turns[0].body.message,'new deliberate draft');assert.deepEqual(turns[0].body.context,{includeDocument:false,includeSelection:false});
  f.snapshot();assert.doesNotMatch(f.get('error-notice').textContent,/上一轮对话的结果未知/);
});

test('fresh busy recovery proof never forces reconnect or automatically replays the old turn',async t=>{
  const f=await fixture(t);f.active();f.input('keep draft');f.setState(unconfirmed({busy:true,interruptionNotice:unknown}));
  f.stream().onerror();await flush();await f.click('reconnect');
  assert.equal(f.posts().length,0);assert.match(f.get('error-notice').textContent,/仍在处理|仍有任务|尚未结束/);assert.equal(f.get('prompt').value,'keep draft');
  f.setState(unconfirmed({busy:false,interruptionNotice:unknown}));f.stream().onopen();await flush();
  assert.equal(f.get('reconnect').disabled,false);assert.equal(f.posts().length,0);
});

test('recovery GET is bounded; timeout is unverified and a late response cannot claim cancellation or readiness',async t=>{
  const f=await fixture(t);f.active();f.input('keep after timeout');const pending=deferred();f.queueStatus(()=>pending.promise);
  f.stream().onerror();await flush();const deadline=f.timers.findLast(timer=>!timer.cleared&&timer.ms===12000);assert.ok(deadline);deadline.fn();await flush();
  assert.match(f.get('error-notice').textContent,/尚未核对|未能核对|未完成/);assert.equal(f.get('send').disabled,true);assert.equal(f.posts().length,0);assert.equal(f.get('prompt').value,'keep after timeout');
  pending.resolve(state());await flush();assert.equal(f.get('send').disabled,true);assert.equal(f.posts().length,0);assert.doesNotMatch(f.get('error-notice').textContent,/已取消|取消成功/);
});

test('late recovery status from an old stream or account cannot overwrite a newer unconfirmed state',async t=>{
  for(const eventName of ['buildx-account-refreshed','buildx-account-changed']){
    const f=await fixture(t);f.active();f.input('draft across identity check');const pending=deferred();f.queueStatus(()=>pending.promise);const old=f.stream();old.onerror();await flush();
    const next=unconfirmed({account:{...f.getState().account,user:{id:eventName==='buildx-account-changed'?'other-user':'fixture-user',email:'next@example.test'}},interruptionNotice:null});
    f.setState(next);f.window.dispatchEvent(new UiEvent(eventName));await flush();assert.notEqual(f.stream(),old);
    pending.resolve(state({interruptionNotice:unknown}));await flush();
    assert.equal(f.get('send').disabled,true);assert.equal(f.get('prompt').value,'draft across identity check');assert.equal(f.get('codex-account-confirm').disabled,true);assert.equal(f.posts().length,0);
    if(eventName==='buildx-account-changed')assert.doesNotMatch(f.get('error-notice').textContent,/上一轮对话的结果未知/);
  }
});

test('only a matching public interruption code is displayed; explicit new-chat clears it without restoring private history',async t=>{
  const f=await fixture(t);f.emit('state',state({interruptionNotice:unknown}));assert.match(f.get('error-notice').textContent,/上一轮对话的结果未知/);
  const partial=state();delete partial.interruptionNotice;f.emit('state',partial);assert.match(f.get('error-notice').textContent,/上一轮对话的结果未知/);
  f.input('preserved new-chat draft');await f.click('new-chat');f.snapshot();assert.doesNotMatch(f.get('error-notice').textContent,/上一轮对话的结果未知/);assert.equal(f.get('prompt').value,'preserved new-chat draft');
  f.emit('state',state({interruptionNotice:{code:'foreign_code',message:'private-forged-message'}}));assert.doesNotMatch(f.get('error-notice').textContent,/private-forged-message/);assert.equal(f.get('transcript').childElementCount,0);
});

test('SSE state supersedes an older recovery GET on the same stream before its HTTP body arrives',async t=>{
  const f=await fixture(t);f.active();f.input('draft remains');const pending=deferred();f.queueStatus(()=>pending.promise);f.stream().onerror();await flush();
  const fresh=unconfirmed({busy:false,message:'fresh proof required',interruptionNotice:unknown,codexAccount:{...f.getState().codexAccount,accountRevision:2}});
  f.setState(fresh);f.emit('state',fresh);assert.equal(f.get('status-text').textContent,'fresh proof required');
  pending.resolve(state({message:'stale GET claims ready',busy:true,interruptionNotice:null}));await flush();
  assert.equal(f.get('status-text').textContent,'fresh proof required');assert.equal(f.get('send').disabled,true);assert.equal(f.get('reconnect').disabled,false);
  assert.match(f.get('error-notice').textContent,/上一轮对话的结果未知/);assert.equal(f.get('prompt').value,'draft remains');assert.equal(f.posts().length,0);
});

test('authoritative explicit null clears the notice even during checking; later producer DTO can restore it',async t=>{
  const f=await fixture(t);f.emit('state',state({interruptionNotice:unknown}));assert.match(f.get('error-notice').textContent,/上一轮对话的结果未知/);
  f.emit('state',unconfirmed({codexAccount:{...f.getState().codexAccount,status:'checking'},interruptionNotice:null}));
  assert.doesNotMatch(f.get('error-notice').textContent,/上一轮对话的结果未知/);assert.equal(f.posts().length,0);
  f.emit('state',unconfirmed({interruptionNotice:unknown}));assert.match(f.get('error-notice').textContent,/上一轮对话的结果未知/);assert.equal(f.posts().length,0);
  f.window.dispatchEvent(new UiEvent('buildx-account-changed'));await flush();assert.doesNotMatch(f.get('error-notice').textContent,/上一轮对话的结果未知/);
});

test('account change withdraws local readiness immediately while the next identity status is pending',async t=>{
  const f=await fixture(t);f.input('do not send under old identity');assert.equal(f.get('send').disabled,false);
  const pending=deferred();f.queueStatus(()=>pending.promise);f.window.dispatchEvent(new UiEvent('buildx-account-changed'));await flush();
  assert.equal(f.get('send').disabled,true);await f.submit();assert.equal(f.posts().length,0);
  const next=unconfirmed({account:{...f.getState().account,user:{id:'other-user',email:'other@example.test'}}});
  f.setState(next);pending.resolve(next);await flush();assert.equal(f.get('send').disabled,true);assert.equal(f.get('prompt').value,'do not send under old identity');
});

test('every current-stream observation invalidates an older GET; old-stream events do not invalidate a new stream read',async t=>{
  for(const name of ['done','failure','state']){
    const f=await fixture(t);f.active();f.input('fresh draft');const pending=deferred();f.queueStatus(()=>pending.promise);f.stream().onerror();await flush();
    f.emit(name,name==='state'?state({workspace:{kind:'model',supportsModelContext:true}}):{message:'terminal observation'});
    pending.resolve(state({message:'stale GET must not restore ready',busy:false}));await flush();
    assert.notEqual(f.get('status-text').textContent,'stale GET must not restore ready');assert.equal(f.get('send').disabled,true);assert.equal(f.posts().length,0);
  }
  const f=await fixture(t),old=f.stream();f.window.dispatchEvent(new UiEvent('buildx-account-refreshed'));await flush();assert.notEqual(f.stream(),old);
  const pending=deferred();f.queueStatus(()=>pending.promise);f.stream().onopen();await flush();old.emit('done',{});
  const next=unconfirmed({message:'new stream current proof',busy:false,interruptionNotice:unknown});f.setState(next);pending.resolve(next);await flush();
  assert.equal(f.get('status-text').textContent,'new stream current proof');assert.match(f.get('error-notice').textContent,/上一轮对话的结果未知/);assert.equal(f.posts().length,0);
});

test('a fresh nonbusy snapshot releases and aborts a stale GET immediately without waiting for its deadline',async t=>{
  const f=await fixture(t);f.active();f.input('fresh snapshot draft');const pending=deferred();f.queueStatus(()=>pending.promise);f.stream().onerror();await flush();
  const oldRead=f.statusReads().at(-1);assert.equal(oldRead.options.signal.aborted,false);
  const next=unconfirmed({busy:false,message:'fresh nonbusy snapshot',interruptionNotice:unknown});f.setState(next);f.snapshot(next);
  assert.equal(oldRead.options.signal.aborted,true);assert.equal(f.get('reconnect').disabled,false);assert.equal(f.get('send').disabled,true);
  pending.resolve(state({busy:true,message:'late stale GET'}));await flush();
  assert.equal(f.get('status-text').textContent,'fresh nonbusy snapshot');assert.equal(f.get('reconnect').disabled,false);assert.equal(f.get('prompt').value,'fresh snapshot draft');assert.equal(f.posts().length,0);
});
