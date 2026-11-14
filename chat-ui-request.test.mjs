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
  const statusProjection=options.omitStatusBusy?{}:{busy:options.statusBusy??false};
  const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const configuredWorkspace=options.workspace,configuredHistory=options.historyAvailable,configuredDirect=options.directCommandsAvailable;
  const suggestions=[new Element('button')];suggestions[0].dataset.prompt='检查当前模型';
  const requests=[],historyRequests=[];let identity=0,account=options.account??{required:false,signedIn:false},confirmation=Object.hasOwn(options,'confirmation')?options.confirmation:{localConnectionConfirmed:true};const window=new Element('window');
  class FakeEventSource{
    static instances=[];
    constructor(url){this.url=url;this.events=new Map();FakeEventSource.instances.push(this);}
    addEventListener(name,fn){const items=this.events.get(name)||[];items.push(fn);this.events.set(name,items);}
    emit(name,data){for(const fn of this.events.get(name)||[])fn({data:JSON.stringify(data)});}
    close(){this.closed=true;}
  }
  const sandbox={__chatView:chatView,window,document:{getElementById:get,querySelectorAll:()=>suggestions,createElement:tag=>new Element(tag),createTextNode:text=>{const node=new Element('#text');node.textContent=text;return node;},createDocumentFragment:()=>new Element('#fragment')},sessionStorage:{getItem:()=>null,setItem(){}},crypto:{randomUUID:()=>++identity===1?'id-1':`00000000-0000-4000-8000-${String(identity).padStart(12,'0')}`},Event:UiEvent,CustomEvent:UiEvent,EventSource:FakeEventSource,navigator:{clipboard:{writeText:async()=>{}}},setTimeout,clearTimeout,queueMicrotask,fetch:async(url,options)=>{
    if(url==='/api/status')return {ok:true,json:async()=>({csrf:'offline-csrf',...statusProjection,ready:!account?.required||account.signedIn,error:false,message:'离线 UI 传输',toolCount:31,toolCatalog:[],account,codexConfirmation:confirmation,workspace:configuredWorkspace,historyAvailable:configuredHistory,directCommandsAvailable:configuredDirect})};
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

test('model picker sends the selected catalog value and clears it on connection change',async()=>{
  const ui=await setup({workspace:{kind:'model',supportsModelContext:true}});const picker=[];
  ui.window.addEventListener('buildx-model-picker-view',event=>picker.push(event.detail));
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,modelSelectionAvailable:true,connectionGeneration:1,codexAccount:{accountRevision:0}});await flush();
  const list=ui.requests.find(item=>item.url==='/api/models');assert.ok(list);ui.input('使用指定模型');await ui.submit();assert.equal(ui.requests.filter(item=>item.url==='/api/turn').length,0);
  await ui.respond(list,{ok:true,models:[{model:'first',displayName:'First',isDefault:true},{model:'second',displayName:'Second',isDefault:false}]});
  ui.window.dispatchEvent(new UiEvent('buildx-model-picker-select',{detail:{model:'second'}}));await ui.submit();
  const turn=ui.requests.find(item=>item.url==='/api/turn');assert.equal(turn.body.model,'second');await ui.respond(turn);ui.emit('done',{});
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,modelSelectionAvailable:true,connectionGeneration:2,codexAccount:{accountRevision:1}});await flush();
  assert.equal(picker.at(-1).selected,'');assert.equal(ui.requests.filter(item=>item.url==='/api/models').length,2);
});

test('Skills are selected for one message using server IDs and cleared when the observed list changes',async()=>{
  const conversationId='11111111-1111-4111-8111-111111111111',skillId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ui=await setup({workspace:{kind:'model',supportsModelContext:true},historyAvailable:true,initialSession:{...session(),conversation:{id:conversationId,readOnly:false}}});
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,historyAvailable:true,skillsAvailable:true,skillsRevision:0,connectionGeneration:1,codexAccount:{accountRevision:0}});await flush();
  await ui.click('skills-refresh');const request=ui.requests.find(item=>item.url==='/api/skills');assert.ok(request);assert.equal(request.body.conversationId,conversationId);
  await ui.respond(request,{ok:true,conversationId,revision:1,skills:[{id:skillId,name:'Example',description:'Local instructions'}]});
  const checkbox=ui.get('skills-list').children[0].children[0].children[0];checkbox.checked=true;checkbox.dispatchEvent(new UiEvent('change'));
  assert.match(ui.get('skills-summary').textContent,/本轮已选 1/);ui.input('使用此技能');await ui.submit();
  const turn=ui.requests.find(item=>item.url==='/api/turn');assert.equal(turn.body.conversationId,conversationId);assert.deepEqual(turn.body.skillIds,[skillId]);assert.doesNotMatch(JSON.stringify(turn.body),/SKILL\.md/);
  await ui.respond(turn,{ok:true,status:'not_sent'});assert.equal(ui.get('prompt').value,'使用此技能');assert.match(ui.get('skills-summary').textContent,/本轮已选 1/);
  await ui.submit();const started=ui.requests.filter(item=>item.url==='/api/turn').at(-1);assert.notEqual(started,turn);assert.deepEqual(started.body.skillIds,[skillId]);
  await ui.respond(started,{ok:true});ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,skillsAvailable:true,skillsRevision:2,connectionGeneration:1,codexAccount:{accountRevision:0}});await flush();
  assert.equal(ui.get('skills-list').children.length,0);assert.match(ui.get('skills-message').textContent,/重新读取/);
});

test('a late skills response cannot present a list invalidated by a newer state',async()=>{
  const conversationId='11111111-1111-4111-8111-111111111111';
  const ui=await setup({workspace:{kind:'model',supportsModelContext:true},historyAvailable:true,initialSession:{...session(),conversation:{id:conversationId,readOnly:false}}});
  const state=revision=>({workspace:{kind:'model',supportsModelContext:true},ready:true,historyAvailable:true,skillsAvailable:true,skillsRevision:revision,connectionGeneration:1,codexAccount:{accountRevision:0}});
  ui.emit('state',state(0));await ui.click('skills-refresh');const request=ui.requests.find(item=>item.url==='/api/skills');
  ui.emit('state',state(2));await ui.respond(request,{ok:true,conversationId,revision:1,skills:[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Old',description:'Outdated'}]});
  assert.equal(ui.get('skills-list').children.length,0);assert.match(ui.get('skills-message').textContent,/重新读取/);assert.equal(ui.get('skills-refresh').disabled,false);
});

test('a changed skill catalog requires a new choice or explicit dismissal before sending',async()=>{
  const conversationId='11111111-1111-4111-8111-111111111111';
  const ui=await setup({workspace:{kind:'model',supportsModelContext:true},historyAvailable:true,initialSession:{...session(),conversation:{id:conversationId,readOnly:false}}});
  const state=revision=>({workspace:{kind:'model',supportsModelContext:true},ready:true,historyAvailable:true,skillsAvailable:true,skillsRevision:revision,connectionGeneration:1,codexAccount:{accountRevision:0}});
  ui.emit('state',state(0));await ui.click('skills-refresh');
  await ui.respond(ui.requests[0],{ok:true,conversationId,revision:0,skills:[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Example'}]});
  const checkbox=ui.get('skills-list').children[0].children[0].children[0];checkbox.checked=true;checkbox.dispatchEvent(new UiEvent('change'));
  ui.input('带技能的草稿');ui.emit('state',state(1));await ui.click('skills-refresh');
  await ui.respond(ui.requests[1],{ok:true,conversationId,revision:1,skills:[]});
  await ui.submit();assert.equal(ui.requests.length,2);assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('skills-clear-stale').hidden,false);
  await ui.click('skills-clear-stale');await ui.submit();assert.equal(ui.requests[2].url,'/api/turn');assert.equal(Object.hasOwn(ui.requests[2].body,'skillIds'),false);
  await ui.respond(ui.requests[2]);ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
});

test('reasoning effort follows the selected model and is sent for every supported turn',async()=>{
  const ui=await setup({workspace:{kind:'model',supportsModelContext:true}}),picker=[];
  ui.window.addEventListener('buildx-model-picker-view',event=>picker.push(event.detail));
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,modelSelectionAvailable:true,connectionGeneration:1,codexAccount:{accountRevision:0}});await flush();
  const list=ui.requests.find(item=>item.url==='/api/models');
  await ui.respond(list,{ok:true,models:[
    {model:'a',displayName:'A',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low',description:'fast'},{reasoningEffort:'medium',description:'balanced'}]},
    {model:'b',displayName:'B',isDefault:false,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high',description:'deep'},{reasoningEffort:'max',description:'deeper'}]},
    {model:'legacy',displayName:'Legacy',isDefault:false},
  ]});
  assert.equal(picker.at(-1).selectedEffort,'medium');
  ui.window.dispatchEvent(new UiEvent('buildx-model-effort-select',{detail:{effort:'low'}}));ui.input('first');await ui.submit();
  let turns=ui.requests.filter(item=>item.url==='/api/turn');assert.equal(turns[0].body.effort,'low');
  ui.window.dispatchEvent(new UiEvent('buildx-model-picker-select',{detail:{model:'b'}}));assert.equal(picker.at(-1).selected,'a');
  await ui.respond(turns[0]);ui.emit('done',{});
  ui.window.dispatchEvent(new UiEvent('buildx-model-picker-select',{detail:{model:'b'}}));assert.equal(picker.at(-1).selectedEffort,'high');
  ui.input('second');await ui.submit();turns=ui.requests.filter(item=>item.url==='/api/turn');assert.equal(turns[1].body.model,'b');assert.equal(turns[1].body.effort,'high');await ui.respond(turns[1]);ui.emit('done',{});
  ui.window.dispatchEvent(new UiEvent('buildx-model-picker-select',{detail:{model:'legacy'}}));assert.equal(picker.at(-1).efforts.length,0);ui.input('legacy');await ui.submit();
  turns=ui.requests.filter(item=>item.url==='/api/turn');assert.equal(Object.hasOwn(turns[2].body,'effort'),false);await ui.respond(turns[2]);ui.emit('done',{});
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,modelSelectionAvailable:true,connectionGeneration:2,codexAccount:{accountRevision:1}});await flush();
  assert.equal(picker.at(-1).selectedEffort,'');assert.equal(picker.at(-1).efforts.length,0);
});

test('an advertised effort without a valid default must be chosen and unadvertised values are ignored',async()=>{
  const ui=await setup({workspace:{kind:'model',supportsModelContext:true}}),picker=[];ui.window.addEventListener('buildx-model-picker-view',event=>picker.push(event.detail));
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,modelSelectionAvailable:true,connectionGeneration:1,codexAccount:{accountRevision:0}});await flush();
  await ui.respond(ui.requests.find(item=>item.url==='/api/models'),{ok:true,models:[{model:'a',displayName:'A',isDefault:true,defaultReasoningEffort:null,supportedReasoningEfforts:[{reasoningEffort:'high',description:'deep'}]}]});
  ui.input('question');ui.window.dispatchEvent(new UiEvent('buildx-model-effort-select',{detail:{effort:'unadvertised'}}));await ui.submit();assert.equal(ui.requests.filter(item=>item.url==='/api/turn').length,0);
  ui.window.dispatchEvent(new UiEvent('buildx-model-effort-select',{detail:{effort:'high'}}));await ui.submit();assert.equal(ui.requests.find(item=>item.url==='/api/turn').body.effort,'high');
});

test('valid long effort descriptions preserve the advertised choice; malformed metadata fails closed',async()=>{
  for(const length of [1001,2000,2001]){
    const ui=await setup({workspace:{kind:'model',supportsModelContext:true}}),picker=[];ui.window.addEventListener('buildx-model-picker-view',event=>picker.push(event.detail));
    ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,modelSelectionAvailable:true,connectionGeneration:1,codexAccount:{accountRevision:0}});await flush();
    await ui.respond(ui.requests.find(item=>item.url==='/api/models'),{ok:true,models:[{model:'a',displayName:'A',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high',description:'x'.repeat(length)}]}]});
    ui.input('question');await ui.submit();const turn=ui.requests.find(item=>item.url==='/api/turn');
    if(length<=2000){assert.equal(picker.at(-1).selectedEffort,'high');assert.equal(turn.body.effort,'high');await ui.respond(turn);}
    else{assert.equal(picker.at(-1).effortInvalid,true);assert.equal(ui.get('send').disabled,true);assert.equal(turn,undefined);}
  }
});

test('account change clears private UI history and ignores the previous stream and late HTTP acknowledgement',async()=>{
  const ui=await setup({account:{required:true,signedIn:true}});const old=ui.stream();
  ui.input('account-A-private');await ui.submit();const request=ui.requests[0];ui.emit('conversation',{busy:false,session:session(0,[{id:'A-user',role:'user',text:'account-A-private',tools:[]}])});ui.emit('done',{});
  assert.equal(ui.get('transcript').children.length,1);
  await ui.accountEvent('buildx-account-changed');assert.equal(ui.get('transcript').children.length,0);assert.notEqual(ui.stream(),old);
  old.emit('conversation',{busy:true,session:session(0,[{id:'A-late',role:'user',text:'late-private-A',tools:[]}])});
  await ui.respond(request,{session:session(0,[{id:'A-http',role:'user',text:'late-A-http',tools:[]}])});
  assert.equal(ui.get('transcript').children.length,0);assert.equal(ui.get('activity').hidden,true);
});
test('account refresh preserves same-user history during revalidation but clears it after definitive signout',async()=>{
  const ui=await setup({account:{required:true,signedIn:true}});
  ui.emit('conversation',{busy:false,session:session(0,[{id:'private',role:'user',text:'same-user-history',tools:[]}])});
  await ui.accountEvent('buildx-account-refreshed');assert.equal(ui.get('transcript').children.length,1);
  ui.setAccount({required:true,signedIn:false,retainedSession:true});await ui.accountEvent('buildx-account-refreshed');assert.equal(ui.get('transcript').children.length,1);assert.equal(ui.get('send').disabled,true);
  ui.setAccount({required:true,signedIn:false,retainedSession:false});await ui.accountEvent('buildx-account-refreshed');assert.equal(ui.get('transcript').children.length,0);
});

test('customer UI refuses missing or unconfirmed Codex proof even if an old endpoint reports ready',async()=>{
  const ui=await setup({account:{required:true,signedIn:true},confirmation:null});
  ui.input('requires explicit confirmation');await ui.submit();assert.equal(ui.requests.length,0);assert.equal(ui.get('send').disabled,true);
  ui.setConfirmation({localConnectionConfirmed:false});await ui.accountEvent('buildx-account-refreshed');await ui.submit();assert.equal(ui.requests.length,0);
  const observed=[];ui.window.addEventListener('buildx-status',event=>observed.push(event.detail));
  ui.setConfirmation({localConnectionConfirmed:true});await ui.accountEvent('buildx-account-refreshed');
  assert.equal(observed.at(-1).codexConfirmation.localConnectionConfirmed,true);
  await ui.submit();assert.equal(ui.requests.length,1);await ui.respond(ui.requests[0]);
});

test('late turn acknowledgement preserves a newly edited draft',async()=>{
  const ui=await setup();ui.input('先提交的问题');await ui.submit();const request=ui.requests[0];
  ui.input('下一条问题的草稿');await ui.respond(request);
  assert.equal(ui.get('prompt').value,'下一条问题的草稿');
});
test('editing back to the original text is still a new draft',async()=>{
  const ui=await setup();ui.input('问题');await ui.submit();ui.input('问题2');ui.input('问题');await ui.respond(ui.requests[0]);
  assert.equal(ui.get('prompt').value,'问题');
});
test('unchanged submitted draft clears normally; failed submission retains it',async()=>{
  const ui=await setup();ui.input('  问题  ');await ui.submit();assert.equal(ui.requests[0].body.message,'问题');await ui.respond(ui.requests[0]);
  assert.equal(ui.get('prompt').value,'');ui.conversation(false);ui.input('失败后保留');await ui.submit();await ui.reject(ui.requests[1],'离线提交失败');
  assert.equal(ui.get('prompt').value,'失败后保留');assert.equal(ui.get('error-notice').textContent,'离线提交失败');assert.equal(ui.get('send').disabled,false);
});
test('old failed turn cannot unlock or overwrite a newer SSE-confirmed turn',async()=>{
  const ui=await setup();ui.input('旧问题');await ui.submit();const old=ui.requests[0];ui.conversation(false);ui.emit('done',{});
  ui.input('新问题');await ui.submit();ui.conversation(true,0,{activity:'新轮次正在执行'});await ui.reject(old,'旧请求迟到失败');
  assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('activity-text').textContent,'新轮次正在执行');assert.equal(ui.get('error-notice').hidden,true);
});
test('HTTP transport failure cannot release a turn already confirmed busy by SSE',async()=>{
  const ui=await setup();ui.input('服务器已经接收');await ui.submit();ui.conversation(true,0,{activity:'工具运行中'});await ui.reject(ui.requests[0],'HTTP响应连接丢失');
  assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('stop').hidden,false);assert.equal(ui.get('activity-text').textContent,'工具运行中');
  ui.conversation(false);assert.equal(ui.get('send').disabled,false);
});
test('late successful turn cannot erase draft or change activity after new chat',async()=>{
  const ui=await setup();ui.input('旧问题');await ui.submit();const old=ui.requests[0];ui.conversation(false);ui.emit('done',{});
  await ui.click('new-chat');ui.conversation(false,1);await ui.respond(ui.requests[1],{ok:true,session:session(1)});
  ui.input('新对话草稿');ui.get('activity-text').textContent='新会话就绪';await ui.respond(old);
  assert.equal(ui.get('prompt').value,'新对话草稿');assert.equal(ui.get('activity-text').textContent,'新会话就绪');
});
test('late failed turn cannot post an old error after reconnect',async()=>{
  const ui=await setup();ui.input('旧问题');await ui.submit();const old=ui.requests[0];ui.conversation(false);ui.emit('done',{});
  await ui.click('reconnect');ui.conversation(false,1);await ui.respond(ui.requests[1]);ui.input('重连后的草稿');await ui.reject(old,'旧请求断线');
  assert.equal(ui.get('error-notice').hidden,true);assert.equal(ui.get('prompt').value,'重连后的草稿');
});
test('late context response cannot resurrect old model after new session epoch',async()=>{
  const ui=await setup();ui.get('include-document').checked=true;await ui.click('refresh-context');const old=ui.requests[0];
  ui.conversation(false,1);await ui.respond(old,{context:{document:{title:'旧模型不应复活',path:'D:\\old.rvt'},selection:null,capturedAt:'old-time'}});
  assert.doesNotMatch(ui.get('context-summary').textContent,/旧模型/);assert.equal(ui.get('refresh-context').textContent,'刷新');assert.equal(ui.get('refresh-context').disabled,false);
});
test('old context finally cannot unlock a newer context request',async()=>{
  const ui=await setup();ui.get('include-document').checked=true;await ui.click('refresh-context');const old=ui.requests[0];
  ui.conversation(false,1);await ui.click('refresh-context');assert.equal(ui.requests.length,2);ui.conversation(true,1);
  await ui.reject(old,'旧读取失败');assert.equal(ui.get('refresh-context').textContent,'读取中…');assert.equal(ui.get('refresh-context').disabled,true);assert.equal(ui.get('error-notice').hidden,true);
});
test('IME Ctrl+Enter does not submit and suggestions remain editable drafts',async()=>{
  const ui=await setup();ui.input('拼音中');ui.get('prompt').dispatchEvent(new UiEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true}));await flush();assert.equal(ui.requests.length,0);
  ui.suggestions[0].dispatchEvent(new UiEvent('click'));assert.equal(ui.get('prompt').value,'检查当前模型');assert.equal(ui.requests.length,0);
  ui.get('prompt').dispatchEvent(new UiEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:false}));await flush();assert.equal(ui.requests.length,1);
});

const modelWorkspace={kind:'model',supportsModelContext:true};
function activateModel(ui){ui.emit('state',{workspace:modelWorkspace,ready:true,toolCount:0});}
test('model Enter sends, Shift+Enter and IME do not; handled mention Enter never sends',async()=>{
  const ui=await setup();activateModel(ui);ui.input('先保留草稿');
  for(const extra of [{shiftKey:true},{isComposing:true},{keyCode:229},{defaultPrevented:true},{altKey:true}]){
    ui.get('prompt').dispatchEvent(new UiEvent('keydown',{key:'Enter',...extra}));
  }
  await flush();assert.equal(ui.requests.length,0);
  ui.get('prompt').dispatchEvent(new UiEvent('keydown',{key:'Enter'}));await flush();
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.message,'先保留草稿');
  assert.deepEqual(ui.requests[0].body.context,{includeDocument:false,includeSelection:false});
});
const commandIntent=(ui,commandId='document',parameters={})=>ui.window.dispatchEvent(new UiEvent('buildx-model-command',{detail:{commandId,parameters}}));
async function directSetup(extra={}){return setup({workspace:modelWorkspace,directCommandsAvailable:true,initialSession:historySession('chat-a'),...extra});}
const commandReceipt=(commandId='document',status='running',extra={})=>({executionId:'exec-'+commandId,conversationId:'chat-a',commandId,status,cancelRequested:false,...extra});
test('model commands use only the direct endpoint, retain the chat draft and block duplicate sends before receipt',async()=>{
  const ui=await directSetup(),views=[];ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  ui.input('我正在编辑的另一条问题');commandIntent(ui,'levels');commandIntent(ui,'selection');await ui.submit();await flush();
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/command');
  assert.deepEqual(ui.requests[0].body,{client:'id-1',commandId:'levels',parameters:{},conversationId:'chat-a'});
  assert.equal(views.at(-1).commands[0].status,'pending');assert.equal(ui.get('prompt').value,'我正在编辑的另一条问题');
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),command:null});commandIntent(ui);await flush();assert.equal(ui.requests.length,1);
  await ui.respond(ui.requests[0],{ok:true,executionId:'exec-levels'});
  assert.equal(views.at(-1).busy,true);assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('stop').hidden,true);
  assert.equal(ui.get('transcript').children.length,0);assert.equal(ui.get('prompt').value,'我正在编辑的另一条问题');
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),command:commandReceipt('levels','completed',{result:{data:{items:[],total:0,returned:0}}})});
  assert.equal(views.at(-1).busy,false);assert.equal(views.at(-1).commands[0].status,'completed');
});
test('model view is an owner projection and account change invalidates late command acknowledgements',async()=>{
  const ui=await directSetup({account:{required:true,signedIn:true}}),views=[];
  ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  await ui.accountEvent('buildx-model-mounted');assert.equal(views.at(-1).enabled,true);
  ui.input('原草稿');commandIntent(ui);await flush();
  const old=ui.requests[0];assert.equal(views.at(-1).blocked,true);
  ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
  assert.equal(views.at(-1).ready,false);assert.equal(views.at(-1).hasMessages,false);
  await ui.respond(old,{ok:true,executionId:'exec-private-old'});
  assert.equal(ui.get('transcript').children.length,0);assert.equal(ui.get('prompt').value,'原草稿');
  assert.equal(views.at(-1).commands.length,0);
});
test('SSE command results win over late acceptance and each command keeps its own result',async()=>{
  const ui=await directSetup(),views=[];ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  commandIntent(ui);await flush();const old=ui.requests[0];
  ui.emit('conversation',{busy:true,session:historySession('chat-a'),command:commandReceipt()});
  const result={document:{title:'项目A'},data:{activeView:{id:'7',type:'FloorPlan'}}};
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),command:commandReceipt('document','completed',{result})});
  commandIntent(ui,'search',{keyword:'风机',category:'equipment',limit:20,offset:0});await flush();
  await ui.respond(old,{ok:true,executionId:'exec-old'});assert.equal(views.at(-1).blocked,true);
  assert.equal(views.at(-1).commands.find(value=>value.commandId==='document').status,'completed');
  const search=commandReceipt('search','completed',{result:{data:{items:[],returned:0,total:0}}});
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),command:search});
  await ui.respond(ui.requests[1],{ok:true,executionId:'exec-search'});
  assert.equal(views.at(-1).busy,false);assert.equal(views.at(-1).commands.length,2);assert.equal(ui.get('transcript').children.length,0);
});
test('an old execution repeated by a draft checkpoint cannot accept or unlock an explicit re-run',async()=>{
  const ui=await directSetup(),views=[];ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),command:commandReceipt('document','failed',{error:{message:'上次读取失败'}})});
  commandIntent(ui);await flush();
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),command:commandReceipt('document','failed',{error:{message:'上次读取失败'}})});
  commandIntent(ui);await flush();assert.equal(ui.requests.length,1);assert.equal(views.at(-1).blocked,true);assert.equal(views.at(-1).commands[0].status,'pending');
  ui.emit('conversation',{busy:true,session:historySession('chat-a'),command:commandReceipt('document','running',{executionId:'exec-document-new'})});
  await ui.respond(ui.requests[0],{ok:true,executionId:'exec-document-new'});assert.equal(views.at(-1).commands[0].executionId,'exec-document-new');assert.equal(views.at(-1).busy,true);
});
test('direct command stop carries exact execution identity and stays busy until a terminal receipt',async()=>{
  const ui=await directSetup(),views=[];ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  commandIntent(ui,'levels');await flush();ui.emit('conversation',{busy:true,session:historySession('chat-a'),command:commandReceipt('levels')});
  ui.window.dispatchEvent(new UiEvent('buildx-model-command-stop',{detail:{executionId:'wrong',conversationId:'chat-a'}}));await flush();assert.equal(ui.requests.length,1);
  const stop=()=>ui.window.dispatchEvent(new UiEvent('buildx-model-command-stop',{detail:{executionId:'exec-levels',conversationId:'chat-a'}}));stop();stop();await flush();
  assert.equal(ui.requests.length,2);assert.deepEqual(ui.requests[1].body,{client:'id-1',executionId:'exec-levels',conversationId:'chat-a'});
  await ui.respond(ui.requests[1],{ok:true});assert.equal(views.at(-1).busy,true);
  ui.emit('conversation',{busy:true,session:historySession('chat-a'),command:commandReceipt('levels','stopping',{cancelRequested:true})});stop();await flush();assert.equal(ui.requests.length,2);
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),command:commandReceipt('levels','interrupted',{cancelRequested:true})});
  await ui.respond(ui.requests[0],{ok:true,executionId:'exec-levels'});assert.equal(views.at(-1).busy,false);assert.equal(views.at(-1).commands[0].status,'interrupted');
});
test('acceptance before SSE exposes the exact command stop identity without claiming completion',async()=>{
  const ui=await directSetup(),views=[];ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  ui.input('保留草稿');commandIntent(ui,'levels');await flush();await ui.respond(ui.requests[0],{ok:true,executionId:'exec-levels'});
  const accepted=views.at(-1).commands[0];assert.equal(accepted.status,'running');assert.equal(accepted.executionId,'exec-levels');assert.equal(Object.hasOwn(accepted,'result'),false);
  assert.equal(views.at(-1).busy,true);assert.equal(ui.get('stop').hidden,true);assert.equal(ui.get('send').disabled,true);
  ui.window.dispatchEvent(new UiEvent('buildx-model-command-stop',{detail:{executionId:accepted.executionId,conversationId:accepted.conversationId}}));await flush();
  assert.deepEqual(ui.requests[1].body,{client:'id-1',executionId:'exec-levels',conversationId:'chat-a'});await ui.respond(ui.requests[1],{ok:true});
  assert.equal(views.at(-1).busy,true);assert.equal(ui.get('prompt').value,'保留草稿');
  ui.emit('conversation',{busy:true,session:historySession('chat-a'),command:commandReceipt('levels','stopping',{cancelRequested:true})});
  assert.equal(views.at(-1).busy,true);assert.equal(views.at(-1).commands[0].status,'stopping');
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),command:commandReceipt('levels','interrupted',{cancelRequested:true})});
  assert.equal(views.at(-1).busy,false);assert.equal(ui.get('send').disabled,false);assert.equal(views.at(-1).commands[0].status,'interrupted');
});
test('a pending command with only busy state has no generic stop without an execution identity',async()=>{
  const ui=await directSetup();commandIntent(ui);await flush();
  ui.emit('state',{workspace:modelWorkspace,ready:true,directCommandsAvailable:true,busy:true});
  assert.equal(ui.get('stop').hidden,true);await ui.click('stop');assert.equal(ui.requests.length,1);
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),command:commandReceipt('document','interrupted')});
  await ui.respond(ui.requests[0],{ok:true,executionId:'exec-document'});
});
test('explicit connection, account revision, user or confirmation change clears old command rows before another snapshot',async()=>{
  const account={required:true,signedIn:true,user:{id:'user-a'}},codexConfirmation={required:true,localConnectionConfirmed:true,phase:'confirmed'};
  const baseline={workspace:modelWorkspace,ready:true,directCommandsAvailable:true,connectionGeneration:2,codexAccount:{accountRevision:4,status:'verified'},account,codexConfirmation};
  for(const change of [{connectionGeneration:3},{codexAccount:{accountRevision:5,status:'verified'}},{account:{...account,user:{id:'user-b'}}},{codexConfirmation:{required:true,localConnectionConfirmed:false,phase:'unavailable'}}]){
    const ui=await directSetup({account}),views=[];ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));ui.emit('state',baseline);
    ui.emit('conversation',{busy:false,session:historySession('chat-a'),command:commandReceipt('document','completed',{result:{data:{activeView:{id:'2',type:'Plan'}}}})});
    assert.equal(views.at(-1).commands.length,1);ui.emit('state',{...baseline,...change});assert.equal(views.at(-1).commands.length,0);
  }
});
test('temporary identity checking hides the old row and a verified same identity can reveal it again',async()=>{
  const account={required:true,signedIn:true,user:{id:'user-a'}},proof={required:true,localConnectionConfirmed:true,phase:'confirmed'};
  const ui=await directSetup({account}),views=[];ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  const baseline={workspace:modelWorkspace,ready:true,directCommandsAvailable:true,connectionGeneration:2,codexAccount:{accountRevision:4,status:'verified'},account,codexConfirmation:proof};ui.emit('state',baseline);
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),command:commandReceipt('document','completed',{result:{data:{activeView:{id:'2',type:'Plan'}}}})});
  ui.emit('conversation',{busy:false,state:{...baseline,ready:false,account:{required:true,signedIn:false,retainedSession:true},codexConfirmation:{required:true,localConnectionConfirmed:false,phase:'checking'}},session:historySession('chat-a'),command:null});
  assert.equal(views.at(-1).commands.length,0);assert.equal(views.at(-1).ready,false);
  ui.emit('state',baseline);assert.equal(views.at(-1).commands.length,1);assert.equal(views.at(-1).commands[0].status,'completed');
});
test('unknown and failed commands remain explicit and never replay through chat or automatic retry',async()=>{
  const ui=await directSetup(),views=[];ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  commandIntent(ui);await flush();await ui.reject(ui.requests[0],'回执连接丢失');
  assert.equal(views.at(-1).commands[0].status,'unknown');assert.equal(views.at(-1).ready,false);assert.equal(ui.requests.length,1);
  ui.emit('conversation',{busy:false,state:{workspace:modelWorkspace,ready:true,directCommandsAvailable:true},session:historySession('chat-a'),command:commandReceipt('document','unknown',{error:{code:'unknown',message:'等待核对'}})});
  await flush();assert.equal(ui.requests.length,1);
  commandIntent(ui,'selection');await flush();assert.equal(ui.requests[1].url,'/api/command');
  await ui.respond(ui.requests[1],{error:'没有打开模型'},false);
  assert.equal(views.at(-1).commands.find(value=>value.commandId==='selection').status,'failed');assert.equal(views.at(-1).busy,false);
  assert.equal(ui.requests.some(value=>value.url==='/api/turn'),false);
});
test('missing direct capability, readonly history and failed persistence never fall back to a turn',async()=>{
  for(const options of [{directCommandsAvailable:false},{initialSession:historySession('chat-a','旧记录',true),historyAvailable:true},{initialSession:{...historySession('chat-a'),conversation:{...historySession('chat-a').conversation,persistence:{status:'failed'}}},historyAvailable:true}]){
    const ui=await directSetup(options);ui.input('保留草稿');commandIntent(ui);await flush();
    assert.equal(ui.requests.length,0);assert.equal(ui.get('prompt').value,'保留草稿');
    ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
  }
});
test('a conversation transition clears command results and ignores the old HTTP acceptance',async()=>{
  const ui=await directSetup(),views=[];ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  commandIntent(ui);await flush();const old=ui.requests[0];
  ui.emit('conversation',{busy:false,session:historySession('chat-b'),command:null});await ui.respond(old,{ok:true,executionId:'exec-old'});
  assert.equal(views.at(-1).commands.length,0);assert.equal(views.at(-1).busy,false);
  commandIntent(ui,'selection');await flush();assert.equal(ui.requests[1].body.conversationId,'chat-b');
});
test('a late chat HTTP snapshot cannot erase a later command receipt or return its busy state',async()=>{
  const ui=await directSetup(),views=[];ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  ui.input('前一轮对话');await ui.submit();const old=ui.requests[0];
  ui.emit('conversation',{busy:false,session:historySession('chat-a','前一轮对话'),command:null});ui.emit('done',{});
  commandIntent(ui,'levels');await flush();ui.emit('conversation',{busy:false,session:historySession('chat-a','前一轮对话'),command:commandReceipt('levels','completed',{result:{data:{total:0,items:[]}}})});
  await ui.respond(old,{ok:true,busy:true,session:historySession('chat-a','旧HTTP快照'),command:null});
  assert.equal(views.at(-1).busy,false);assert.equal(views.at(-1).commands[0].status,'completed');
  assert.equal(ui.get('transcript').children[0].children.at(-1).textContent,'前一轮对话');
});
test('legacy and restricted workspaces ignore model intents and retain their Enter policy',async()=>{
  for(const workspace of [undefined,{kind:'source-development',supportsModelContext:false},{kind:'customer-chat',supportsModelContext:false}]){
    const ui=await setup();if(workspace)ui.emit('state',{workspace,ready:true,toolCount:0});
    ui.input('保留草稿');ui.get('prompt').dispatchEvent(new UiEvent('keydown',{key:'Enter'}));
    commandIntent(ui);await flush();
    assert.equal(ui.requests.length,0);
  }
});

function historySession(id,text='',readOnly=false){return {...session(0,text?[{id:id+'-message',role:'user',text,tools:[]}]:[]),conversation:{id,source:'local-codex-panel',readOnly}};}
const historyCatalog=(activeId,ids=['chat-a','chat-b'])=>({available:true,activeId,sessions:ids.map(id=>({id,title:id,updatedAt:'2026-10-26T00:00:00.000Z',messageCount:1,preview:id}))});
async function historySetup(extra={}){return setup({workspace:modelWorkspace,historyAvailable:true,initialSession:historySession('chat-a'),history:historyCatalog('chat-a'),draft:{text:'',includeSelection:false},...extra});}

function streamingHistory(id='chat-a',turnId='turn-a'){
  const value=historySession(id);value.conversation.turnBinding={turnId,status:'streaming'};return value;
}
function receiptSession(id,revision,receipts,readOnly=false){
  const value=historySession(id,'',readOnly);value.conversation.steerReceiptsRevision=revision;value.conversation.steerReceipts=receipts;return value;
}
const steerReceipt=(status='unknown',message='先处理这一层',requestId='11111111-1111-4111-8111-111111111111')=>({requestId,turnId:'turn-a',message,status});
async function enableReceiptContract(ui,session){
  ui.emit('state',{workspace:modelWorkspace,ready:true,steerAvailable:true,steerReceiptsAvailable:true,connectionGeneration:1,codexAccount:{accountRevision:1}});
  ui.emit('conversation',{busy:false,session,history:historyCatalog(session.conversation.id),userInput:null});await flush();
}
test('restored pending or unknown receipts warn and prevent duplicate sends without reading transcript text',async()=>{
  for(const status of ['pending','unknown']){
    const session=receiptSession('chat-a',1,[steerReceipt(status)]),ui=await historySetup({initialSession:session});await enableReceiptContract(ui,session);
    ui.input('先处理这一层');assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('steer-feedback').hidden,false);assert.match(ui.get('steer-feedback').textContent,/尚未确认.*不要重复/);
    await ui.submit();assert.equal(ui.requests.filter(item=>item.url==='/api/turn').length,0);ui.input('检查另一层');assert.equal(ui.get('send').disabled,false);
  }
});
test('revisioned receipts ignore older snapshots and reject inconsistent equal revisions',async()=>{
  const session=receiptSession('chat-a',1,[steerReceipt('unknown')]),ui=await historySetup({initialSession:session});await enableReceiptContract(ui,session);ui.input('先处理这一层');
  const accepted=receiptSession('chat-a',2,[steerReceipt('accepted')]);ui.emit('conversation',{busy:false,session:accepted});assert.equal(ui.get('send').disabled,false);assert.match(ui.get('steer-feedback').textContent,/已由 Codex 接收.*尚待确认/);
  ui.emit('conversation',{busy:false,session});assert.equal(ui.get('send').disabled,false);
  ui.emit('conversation',{busy:false,session:receiptSession('chat-a',2,[steerReceipt('unknown')])});assert.equal(ui.get('send').disabled,true);assert.match(ui.get('steer-feedback').textContent,/回执尚未核对/);
  ui.emit('conversation',{busy:false,session:receiptSession('chat-a',3,[steerReceipt('not_sent')])});assert.equal(ui.get('send').disabled,false);assert.match(ui.get('steer-feedback').textContent,/未发送/);
});
test('missing or malformed structured receipt snapshots fail closed when supported',async()=>{
  const session=receiptSession('chat-a',1,[steerReceipt()]),ui=await historySetup({initialSession:session});await enableReceiptContract(ui,session);ui.input('不同的新消息');
  ui.emit('conversation',{busy:false,session:historySession('chat-a')});assert.equal(ui.get('send').disabled,true);await ui.submit();assert.equal(ui.requests.filter(item=>item.url==='/api/turn').length,0);
  const invalid=receiptSession('chat-a',2,[steerReceipt('invented')]);ui.emit('conversation',{busy:false,session:invalid});assert.equal(ui.get('send').disabled,true);
  ui.emit('conversation',{busy:false,session:receiptSession('chat-a',2,[])});assert.equal(ui.get('send').disabled,false);
});
test('receipt protection is scoped by conversation and account and clears on account change',async()=>{
  const original=receiptSession('chat-a',1,[steerReceipt()]),ui=await historySetup({initialSession:original});await enableReceiptContract(ui,original);ui.input('先处理这一层');assert.equal(ui.get('send').disabled,true);
  const other=receiptSession('chat-b',0,[]);ui.emit('conversation',{busy:false,session:other,draft:{text:'先处理这一层',includeSelection:false},history:historyCatalog('chat-b')});assert.equal(ui.get('send').disabled,false);assert.equal(ui.get('steer-feedback').hidden,true);
  ui.emit('conversation',{busy:false,session:original,draft:{text:'先处理这一层',includeSelection:false},history:historyCatalog('chat-a')});assert.equal(ui.get('send').disabled,true);
  await ui.accountEvent('buildx-account-changed');const fresh=receiptSession('chat-a',0,[]);await enableReceiptContract(ui,fresh);ui.input('先处理这一层');assert.equal(ui.get('send').disabled,false);assert.equal(ui.get('steer-feedback').hidden,true);
});
test('same-session unknown steer is released only by newer structured status for the exact request',async()=>{
  const active=streamingHistory();active.conversation.steerReceiptsRevision=0;active.conversation.steerReceipts=[];
  const ui=await historySetup({initialSession:active});ui.emit('state',{workspace:modelWorkspace,ready:true,steerAvailable:true,steerReceiptsAvailable:true,connectionGeneration:1,codexAccount:{accountRevision:1}});ui.emit('conversation',{busy:true,session:active,userInput:null});
  ui.input('原补充');await ui.click('steer');const request=ui.requests.find(item=>item.url==='/api/steer');assert.ok(request);
  await ui.reject(request,'连接断开');assert.equal(ui.get('steer').disabled,true);
  const pending=streamingHistory();pending.conversation.steerReceiptsRevision=1;pending.conversation.steerReceipts=[steerReceipt('unknown','原补充',request.body.requestId)];ui.emit('conversation',{busy:true,session:pending});assert.equal(ui.get('steer').disabled,true);
  const absent=streamingHistory();absent.conversation.steerReceiptsRevision=2;absent.conversation.steerReceipts=[];ui.emit('conversation',{busy:true,session:absent});assert.equal(ui.get('steer').disabled,true);
  const accepted=streamingHistory();accepted.conversation.steerReceiptsRevision=3;accepted.conversation.steerReceipts=[steerReceipt('accepted','原补充',request.body.requestId)];ui.emit('conversation',{busy:true,session:accepted});assert.equal(ui.get('steer').disabled,false);assert.match(ui.get('steer-feedback').textContent,/已由 Codex 接收/);
});
test('authoritative acceptance may precede a lost HTTP response without being downgraded',async()=>{
  for(const edited of [false,true]){
    const active=streamingHistory();active.conversation.steerReceiptsRevision=0;active.conversation.steerReceipts=[];
    const ui=await historySetup({initialSession:active});ui.emit('state',{workspace:modelWorkspace,ready:true,steerAvailable:true,steerReceiptsAvailable:true,connectionGeneration:1,codexAccount:{accountRevision:1}});ui.emit('conversation',{busy:true,session:active,userInput:null});
    ui.input('原补充');await ui.click('steer');const request=ui.requests.find(item=>item.url==='/api/steer');if(edited)ui.input('后来编辑的草稿');
    const accepted=streamingHistory();accepted.conversation.steerReceiptsRevision=1;accepted.conversation.steerReceipts=[steerReceipt('accepted','原补充',request.body.requestId)];ui.emit('conversation',{busy:true,session:accepted});
    assert.equal(ui.get('prompt').value,edited?'后来编辑的草稿':'');assert.match(ui.get('steer-feedback').textContent,/已由 Codex 接收/);
    await ui.reject(request,'连接断开');assert.match(ui.get('steer-feedback').textContent,/已由 Codex 接收/);assert.equal(ui.get('prompt').value,edited?'后来编辑的草稿':'');
  }
});
async function steeringSetup(){
  const ui=await historySetup();
  ui.emit('state',{workspace:modelWorkspace,ready:true,steerAvailable:true,connectionGeneration:1,codexAccount:{accountRevision:1}});
  ui.emit('conversation',{busy:true,session:streamingHistory(),history:{available:true,activeId:'chat-a'},userInput:null});
  return ui;
}
test('steering is an explicit active-turn action and acceptance does not claim application',async()=>{
  const ui=await steeringSetup();ui.input('保留露台');
  assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('steer').hidden,false);assert.equal(ui.get('steer').disabled,false);
  await ui.submit();assert.equal(ui.requests.filter(item=>item.url==='/api/steer').length,0);
  await ui.click('steer');const request=ui.requests.find(item=>item.url==='/api/steer');assert.ok(request);
  assert.equal(request.body.conversationId,'chat-a');assert.equal(request.body.turnId,'turn-a');assert.equal(request.body.message,'保留露台');assert.ok(request.body.requestId);
  await ui.click('steer');assert.equal(ui.requests.filter(item=>item.url==='/api/steer').length,1);
  await ui.respond(request,{ok:true,status:'accepted'});assert.equal(ui.get('prompt').value,'');assert.match(ui.get('steer-feedback').textContent,/已接收.*是否已应用/);
});
test('an unknown steer outcome blocks an accidental repeat while preserving the draft',async()=>{
  const ui=await steeringSetup();ui.input('原补充');await ui.click('steer');const request=ui.requests.find(item=>item.url==='/api/steer');
  await ui.reject(request,'连接断开');assert.equal(ui.get('prompt').value,'原补充');assert.equal(ui.get('steer').disabled,true);assert.match(ui.get('steer-feedback').textContent,/不要重复提交/);
  await ui.click('steer');assert.equal(ui.requests.filter(item=>item.url==='/api/steer').length,1);
  ui.input('另一条补充');assert.equal(ui.get('steer').disabled,false);
});
test('a stale steer acknowledgement cannot clear a new conversation draft',async()=>{
  const ui=await steeringSetup();ui.input('旧轮次补充');await ui.click('steer');const request=ui.requests.find(item=>item.url==='/api/steer');
  ui.emit('conversation',{busy:false,session:historySession('chat-b'),draft:{text:'新对话草稿',includeSelection:false},history:historyCatalog('chat-b')});
  await ui.respond(request,{ok:true,status:'accepted'});assert.equal(ui.get('prompt').value,'新对话草稿');assert.equal(ui.get('steer').hidden,true);
});
test('terminal turn before steer receipt preserves the warning and blocks duplicate normal send',async()=>{
  const ui=await steeringSetup();ui.input('先处理这一层');await ui.click('steer');const request=ui.requests.find(item=>item.url==='/api/steer');
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),history:historyCatalog('chat-a'),userInput:null});ui.emit('done',{});
  assert.equal(ui.get('prompt').value,'先处理这一层');assert.equal(ui.get('steer-feedback').hidden,false);assert.match(ui.get('steer-feedback').textContent,/尚未确认.*不要重复/);assert.equal(ui.get('send').disabled,true);
  await ui.submit();assert.equal(ui.requests.filter(item=>item.url==='/api/turn').length,0);
  await ui.respond(request,{ok:true,status:'accepted'});assert.equal(ui.get('prompt').value,'先处理这一层');assert.equal(ui.get('send').disabled,true);assert.match(ui.get('steer-feedback').textContent,/尚未确认/);
  ui.input('接下来处理另一层');assert.equal(ui.get('send').disabled,false);
});
test('unconfirmed steer is scoped to its original conversation across a switch',async()=>{
  const ui=await steeringSetup();ui.input('保留露台');await ui.click('steer');const request=ui.requests.find(item=>item.url==='/api/steer');
  ui.emit('conversation',{busy:false,session:historySession('chat-b'),draft:{text:'保留露台',includeSelection:false},history:historyCatalog('chat-b')});
  assert.equal(ui.get('steer-feedback').hidden,true);assert.equal(ui.get('send').disabled,false);
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),draft:{text:'保留露台',includeSelection:false},history:historyCatalog('chat-a')});
  assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('steer-feedback').hidden,false);assert.match(ui.get('steer-feedback').textContent,/尚未确认/);
  await ui.respond(request,{ok:true,status:'accepted'});assert.equal(ui.get('send').disabled,true);
});
test('account change clears the prior account uncertain steer warning and draft guard',async()=>{
  const ui=await steeringSetup();ui.input('保留露台');await ui.click('steer');const request=ui.requests.find(item=>item.url==='/api/steer');
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),history:historyCatalog('chat-a')});assert.equal(ui.get('send').disabled,true);
  await ui.accountEvent('buildx-account-changed');ui.emit('snapshot',{busy:false,session:historySession('chat-a'),history:historyCatalog('chat-a')});ui.input('保留露台');
  assert.equal(ui.get('steer-feedback').hidden,true);assert.equal(ui.get('send').disabled,false);
  await ui.respond(request,{ok:true,status:'accepted'});assert.equal(ui.get('steer-feedback').hidden,true);assert.equal(ui.get('prompt').value,'保留露台');
});
test('steering is unavailable for pending questions, stopping or an unbound turn',async()=>{
  const ui=await steeringSetup();ui.input('补充条件');
  ui.emit('conversation',{busy:true,session:streamingHistory(),userInput:{id:'question',conversationId:'chat-a',questions:[{id:'q',question:'请选择',options:[],isOther:true}]}});
  assert.equal(ui.get('steer').disabled,true);await ui.click('steer');assert.equal(ui.requests.filter(item=>item.url==='/api/steer').length,0);
  ui.emit('conversation',{busy:true,session:streamingHistory(),userInput:null});await ui.click('stop');assert.equal(ui.get('steer').disabled,true);
  await ui.click('steer');assert.equal(ui.requests.filter(item=>item.url==='/api/steer').length,0);
});

test('history transport is absent from legacy, source and customer profiles even with synthetic history intents',async()=>{
  for(const workspace of [undefined,{kind:'source-development',supportsModelContext:false},{kind:'customer-chat',supportsModelContext:false}]){
    const ui=await setup({workspace,historyAvailable:true});
    await ui.accountEvent('buildx-history-refresh');await ui.selectHistory('chat-b');
    assert.equal(ui.historyRequests.length,0);assert.equal(ui.requests.length,0);
  }
});
test('conversation identity switches independently of context epoch and late select ACK cannot replace a later conversation',async()=>{
  const ui=await historySetup();ui.input('A 私有草稿');ui.get('include-selection').checked=true;
  await ui.selectHistory('chat-b');const first=ui.requests[0];
  assert.equal(first.url,'/api/chat/select');assert.deepEqual(first.body.draft,{text:'A 私有草稿',includeSelection:true});
  ui.emit('conversation',{busy:false,session:historySession('chat-b','B 记录'),draft:{text:'B 草稿',includeSelection:false},history:historyCatalog('chat-b')});
  assert.equal(ui.get('prompt').value,'B 草稿');assert.equal(ui.get('include-selection').checked,false);
  await ui.selectHistory('chat-c');const next=ui.requests[1];
  await ui.respond(next,{ok:true,session:historySession('chat-c','C 记录'),draft:{text:'C 草稿',includeSelection:true},history:historyCatalog('chat-c',['chat-a','chat-b','chat-c'])});
  await ui.respond(first,{ok:true,session:historySession('chat-b','旧 B 回执'),draft:{text:'旧 B 草稿',includeSelection:false},history:historyCatalog('chat-b')});
  assert.equal(ui.get('prompt').value,'C 草稿');assert.equal(ui.get('include-selection').checked,true);
  assert.equal(ui.get('transcript').children[0].children.at(-1).textContent,'C 记录');
  assert.equal(ui.get('context-reset').hidden,true);
});
test('switching sessions preserves each draft and selection; a new conversation starts empty',async()=>{
  const ui=await historySetup();ui.input('A 草稿');ui.get('include-selection').checked=true;
  await ui.selectHistory('chat-b');await ui.respond(ui.requests[0],{ok:true,session:historySession('chat-b'),draft:{text:'B 原草稿',includeSelection:false},history:historyCatalog('chat-b')});
  ui.input('B 新草稿');await ui.selectHistory('chat-a');await ui.respond(ui.requests[1],{ok:true,session:historySession('chat-a'),draft:{text:'服务器旧 A',includeSelection:false},history:historyCatalog('chat-a')});
  assert.equal(ui.get('prompt').value,'A 草稿');assert.equal(ui.get('include-selection').checked,true);
  await ui.selectHistory('chat-b');await ui.respond(ui.requests[2],{ok:true,session:historySession('chat-b'),draft:{text:'服务器旧 B',includeSelection:true},history:historyCatalog('chat-b')});
  assert.equal(ui.get('prompt').value,'B 新草稿');assert.equal(ui.get('include-selection').checked,false);
  await ui.click('new-chat');assert.deepEqual(ui.requests[3].body.draft,{text:'B 新草稿',includeSelection:false});
  ui.emit('conversation',{busy:false,session:historySession('chat-new'),draft:{text:'',includeSelection:false},history:historyCatalog('chat-new')});
  ui.input('新对话输入');await ui.respond(ui.requests[3],{ok:true,session:historySession('chat-new'),draft:{text:'',includeSelection:false},history:historyCatalog('chat-new')});
  assert.equal(ui.get('prompt').value,'新对话输入');
});
test('restored history is viewable but cannot send or apply a command until new chat',async()=>{
  const ui=await historySetup({initialSession:historySession('chat-history','已保存正文',true),draft:{text:'未发送草稿',includeSelection:false}});
  assert.equal(ui.get('prompt').readOnly,true);assert.equal(ui.get('send').disabled,true);
  await ui.submit();commandIntent(ui);await flush();
  assert.equal(ui.requests.length,0);assert.equal(ui.get('transcript').children.length,1);
  await ui.click('new-chat');await ui.respond(ui.requests[0],{ok:true,session:historySession('chat-live'),draft:{text:'',includeSelection:false},history:historyCatalog('chat-live')});
  assert.equal(ui.get('prompt').readOnly,false);ui.input('新问题');await ui.submit();
  assert.equal(ui.requests[1].url,'/api/turn');
});
test('history reads and saved drafts from an old account cannot restore private UI state',async()=>{
  const ui=await historySetup({account:{required:true,signedIn:true}}),views=[];
  ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  await ui.accountEvent('buildx-history-refresh');const oldRead=ui.historyRequests.at(-1);
  ui.input('A 私有草稿');ui.get('prompt').dispatchEvent(new UiEvent('blur'));await flush();const oldSave=ui.requests[0];
  assert.equal(oldSave.url,'/api/chat/draft');
  ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
  await ui.respond(oldRead,{ok:true,...historyCatalog('private-old',['private-old'])});await ui.respond(oldSave,{ok:true});
  assert.equal(ui.get('prompt').value,'');assert.equal(ui.get('transcript').children.length,0);
  assert.equal(views.at(-1).history.sessions.length,0);assert.equal(views.at(-1).history.activeId,null);
});
test('a draft save acknowledgement does not replace a later edit or normal same-session SSE draft',async()=>{
  const ui=await historySetup();ui.input('先保存的草稿');ui.get('prompt').dispatchEvent(new UiEvent('blur'));await flush();
  assert.equal(ui.requests[0].url,'/api/chat/draft');assert.equal(ui.requests[0].body.conversationId,'chat-a');
  ui.input('后来的草稿');await ui.respond(ui.requests[0],{ok:true});
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),draft:{text:'服务端较早草稿',includeSelection:true}});
  assert.equal(ui.get('prompt').value,'后来的草稿');assert.equal(ui.get('include-selection').checked,false);
  ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
});
test('paged history appends distinct entries and the cursor cannot be invented by a UI intent',async()=>{
  const ui=await historySetup(),views=[];ui.window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  await ui.accountEvent('buildx-history-refresh');await ui.respond(ui.historyRequests.at(-1),{ok:true,...historyCatalog('chat-a',['chat-a']),complete:false,nextCursor:'page-two'});
  ui.window.dispatchEvent(new UiEvent('buildx-history-refresh',{detail:{cursor:'invented'}}));await flush();const count=ui.historyRequests.length;
  ui.window.dispatchEvent(new UiEvent('buildx-history-refresh',{detail:{cursor:'page-two'}}));await flush();
  assert.equal(ui.historyRequests.length,count+1);assert.match(ui.historyRequests.at(-1).url,/cursor=page-two/);
  await ui.respond(ui.historyRequests.at(-1),{ok:true,...historyCatalog('chat-a',['chat-a','chat-b']),complete:true,nextCursor:null});
  assert.deepEqual(Array.from(views.at(-1).history.sessions,item=>item.id),['chat-a','chat-b']);assert.equal(views.at(-1).history.nextCursor,null);
});
test('sending waits for the owned draft write and a draft snapshot cannot unlock its preflight',async()=>{
  const ui=await historySetup();ui.input('发出的内容');ui.get('prompt').dispatchEvent(new UiEvent('blur'));await flush();
  const draft=ui.requests[0];await ui.submit();assert.equal(ui.requests.length,1);
  ui.emit('conversation',{busy:false,session:historySession('chat-a'),draft:{text:'更早的草稿',includeSelection:false},history:{available:true,activeId:'chat-a'}});
  assert.equal(ui.get('send').disabled,true);await ui.respond(draft,{ok:true});
  assert.equal(ui.requests[1].url,'/api/turn');assert.equal(ui.requests[1].body.message,'发出的内容');
  await ui.respond(ui.requests[1],{ok:true});ui.emit('done',{});
  ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
});
test('stopping while the composer waits for a draft checkpoint never submits a turn',async()=>{
  const ui=await historySetup();ui.input('保留待发送的草稿');ui.get('prompt').dispatchEvent(new UiEvent('blur'));await flush();
  const draft=ui.requests[0];await ui.submit();await ui.click('stop');await ui.respond(draft,{ok:true});
  assert.equal(ui.requests.length,1);assert.equal(ui.get('prompt').value,'保留待发送的草稿');assert.equal(ui.get('send').disabled,false);
  ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
});
test('failed local persistence blocks new AI requests without clearing the editable draft',async()=>{
  const failed=historySession('chat-a');failed.conversation.persistence={status:'failed',message:'本地保存未确认'};
  const ui=await historySetup({initialSession:failed});ui.input('保留的新草稿');
  assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('prompt').readOnly,false);
  await ui.submit();commandIntent(ui);await flush();
  assert.equal(ui.requests.length,0);assert.equal(ui.get('prompt').value,'保留的新草稿');
  const saved=historySession('chat-a');saved.conversation.persistence={status:'saved'};
  ui.emit('conversation',{busy:false,session:saved,history:{available:true,activeId:'chat-a'}});
  assert.equal(ui.get('send').disabled,false);
  ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
});
test('an earlier draft checkpoint is not native busy proof after the following turn submission fails',async()=>{
  const ui=await historySetup();ui.input('提交失败后保留');ui.get('prompt').dispatchEvent(new UiEvent('blur'));await flush();
  await ui.submit();ui.emit('conversation',{busy:false,session:historySession('chat-a'),draft:{text:'更早保存',includeSelection:false},history:{available:true,activeId:'chat-a'}});
  await ui.respond(ui.requests[0],{ok:true});await ui.reject(ui.requests[1],'提交没有成功');
  assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('prompt').value,'提交失败后保留');
  ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
});
test('a lost send response blocks another submission until the original turn ID is observed',async()=>{
  const ui=await historySetup();ui.input('核对原轮次');await ui.submit();const sent=ui.requests[0];
  ui.emit('conversation',{busy:false,session:historySession('chat-a')});await ui.submit();assert.equal(ui.requests.length,1);
  await ui.reject(sent,'网络响应中断');assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('prompt').value,'核对原轮次');
  const snapshot=historySession('chat-a');snapshot.conversation.turnBinding={requestId:'unrelated',turnId:'another-turn',status:'completed'};
  ui.emit('conversation',{busy:false,session:snapshot});await ui.submit();assert.equal(ui.requests.length,1);
  snapshot.conversation.turnBinding={requestId:sent.body.requestId,turnId:'native-turn',status:'completed'};
  ui.emit('conversation',{busy:false,session:snapshot});assert.equal(ui.get('prompt').value,'');
  ui.input('确认后再问');await ui.submit();assert.equal(ui.requests.length,2);assert.notEqual(ui.requests[1].body.requestId,sent.body.requestId);
  await ui.respond(ui.requests[1]);ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
});
test('a direct command never submits the chat draft while an ordinary turn explicitly clears its submitted draft',async()=>{
  for(const command of [false,true]){
    const ui=await historySetup({directCommandsAvailable:true});ui.input('正在编辑的聊天草稿');ui.get('include-selection').checked=true;
    if(command){commandIntent(ui);await flush();}else await ui.submit();
    assert.equal(ui.requests[0].url,command?'/api/command':'/api/turn');
    if(command)assert.equal(Object.hasOwn(ui.requests[0].body,'draft'),false);
    else {assert.deepEqual(ui.requests[0].body.draft,{text:'正在编辑的聊天草稿',includeSelection:true});assert.equal(ui.requests[0].body.clearDraftOnStart,true);}
    await ui.respond(ui.requests[0],{ok:true,executionId:'exec-document'});
    assert.equal(ui.get('prompt').value,command?'正在编辑的聊天草稿':'');
    ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
  }
});
test('a newly edited draft can be saved during an active native turn without changing the turn or composer',async()=>{
  const ui=await historySetup();ui.input('第一条问题');await ui.submit();await ui.respond(ui.requests[0],{ok:true});
  ui.emit('conversation',{busy:true,session:historySession('chat-a','第一条问题'),history:{available:true,activeId:'chat-a'}});
  ui.input('生成中编辑的下一条草稿');ui.get('prompt').dispatchEvent(new UiEvent('blur'));await flush();
  assert.equal(ui.requests[1].url,'/api/chat/draft');assert.equal(ui.requests[1].body.draft.text,'生成中编辑的下一条草稿');
  await ui.respond(ui.requests[1],{ok:true});
  assert.equal(ui.get('prompt').value,'生成中编辑的下一条草稿');assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('stop').hidden,false);
  assert.equal(ui.requests.filter(request=>request.url==='/api/turn').length,1);
  ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
});
test('an edit made while the submitted turn awaits its draft checkpoint is sent as the retained next draft',async()=>{
  const ui=await historySetup();ui.input('已点击发送的问题');ui.get('prompt').dispatchEvent(new UiEvent('blur'));await flush();
  await ui.submit();ui.input('等待期间的新草稿');await ui.respond(ui.requests[0],{ok:true});
  assert.equal(ui.requests[1].url,'/api/turn');assert.equal(ui.requests[1].body.message,'已点击发送的问题');
  assert.deepEqual(ui.requests[1].body.draft,{text:'等待期间的新草稿',includeSelection:false});
  assert.equal(Object.hasOwn(ui.requests[1].body,'clearDraftOnStart'),false);
  await ui.respond(ui.requests[1],{ok:true});assert.equal(ui.get('prompt').value,'等待期间的新草稿');
  ui.setAccount({required:true,signedIn:false});await ui.accountEvent('buildx-account-changed');
});
test('SSE terminal before HTTP acknowledgement still clears an unchanged draft',async()=>{
  const ui=await setup();ui.input('已结束的问题');await ui.submit();ui.conversation(true);ui.conversation(false);ui.emit('done',{});
  ui.get('activity-text').textContent='本轮已经结束';await ui.respond(ui.requests[0]);
  assert.equal(ui.get('prompt').value,'');assert.equal(ui.get('activity').hidden,true);assert.equal(ui.get('activity-text').textContent,'本轮已经结束');
});
test('old successful acknowledgement cannot clear a newer turn draft or activity',async()=>{
  const ui=await setup();ui.input('旧问题');await ui.submit();const old=ui.requests[0];ui.conversation(false);ui.emit('done',{});
  ui.input('第二轮问题');await ui.submit();ui.conversation(true,0,{activity:'第二轮执行中'});ui.input('第三轮草稿');await ui.respond(old);
  assert.equal(ui.get('prompt').value,'第三轮草稿');assert.equal(ui.get('activity-text').textContent,'第二轮执行中');assert.equal(ui.get('send').disabled,true);
});
test('new chat blocks duplicate controls only until its authoritative session transition',async()=>{
  const ui=await setup();ui.get('include-document').checked=true;ui.get('include-selection').checked=true;await ui.click('new-chat');const old=ui.requests[0];
  assert.equal(ui.get('new-chat').disabled,true);await ui.click('new-chat');await ui.click('reconnect');ui.input('还未重置');await ui.submit();assert.equal(ui.requests.length,1);
  ui.conversation(false,1);assert.equal(ui.get('new-chat').disabled,false);assert.equal(ui.get('include-document').checked,false);assert.equal(ui.get('include-selection').checked,false);assert.equal(ui.get('context-reset').hidden,true);
  ui.input('新问题');await ui.submit();const freshSession=session(1,[{id:'fresh-user',role:'user',text:'新问题',tools:[]}]);ui.emit('conversation',{busy:true,session:freshSession,activity:'新请求执行中'});
  await ui.respond(old,{ok:true,session:session(1)});assert.equal(ui.get('transcript').children.length,1);assert.equal(ui.get('activity-text').textContent,'新请求执行中');assert.equal(ui.get('send').disabled,true);
});
test('late failed new-chat control cannot replace a newer session error or busy state',async()=>{
  const ui=await setup();await ui.click('new-chat');const old=ui.requests[0];ui.conversation(false,1);ui.input('新问题');await ui.submit();ui.conversation(true,1,{activity:'新轮次执行中',error:'当前执行提示'});
  await ui.reject(old,'旧新对话失败');assert.equal(ui.get('error-notice').textContent,'当前执行提示');assert.equal(ui.get('send').disabled,true);
});
test('late reconnect response cannot replace a stream after a newer turn starts',async()=>{
  const ui=await setup();await ui.click('reconnect');const old=ui.requests[0],stream=ui.stream();ui.conversation(false,1);ui.input('新问题');await ui.submit();ui.conversation(true,1,{activity:'重连后的新轮次'});
  await ui.respond(old);assert.equal(ui.stream(),stream);assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('activity-text').textContent,'重连后的新轮次');
});
test('late context from a previous action cannot overwrite a newer turn snapshot in the same epoch',async()=>{
  const ui=await setup();ui.get('include-document').checked=true;await ui.click('refresh-context');const old=ui.requests[0];ui.conversation(false);
  ui.input('新轮次');await ui.submit();const fresh=session();fresh.context={document:{title:'当前模型'},selection:null,capturedAt:'new-time'};ui.emit('conversation',{busy:true,session:fresh,activity:'读取当前模型'});
  await ui.respond(old,{context:{document:{title:'旧模型'},selection:null,capturedAt:'old-time'}});assert.equal(ui.get('context-summary').textContent,'当前模型');assert.equal(ui.get('send').disabled,true);
});
test('late interrupt success or failure cannot change a completed or subsequent turn',async()=>{
  const ui=await setup();ui.input('旧问题');await ui.submit();ui.conversation(true);await ui.click('stop');const interrupt=ui.requests[1];ui.conversation(false);ui.emit('done',{});ui.get('activity-text').textContent='已取得终态';
  await ui.respond(interrupt);assert.equal(ui.get('activity-text').textContent,'已取得终态');
  ui.input('新问题');await ui.submit();ui.conversation(true);await ui.click('stop');const secondInterrupt=ui.requests[3];ui.conversation(false);ui.emit('done',{});ui.input('下一轮');await ui.submit();ui.conversation(true,0,{activity:'下一轮处理中'});
  await ui.reject(secondInterrupt,'旧停止回执失败');assert.equal(ui.get('error-notice').hidden,true);assert.equal(ui.get('activity-text').textContent,'下一轮处理中');assert.equal(ui.get('send').disabled,true);
});

test('model user-input form presents choices, preserves edits on repeated snapshots and submits only a user-selected answer',async()=>{
  const ui=await setup({workspace:{kind:'model',supportsModelContext:true}});
  const question={id:'request-token',conversationId:'chat-a',isBlocking:true,questions:[{id:'q',header:'范围',question:'请选择范围',isOther:true,options:[{label:'选区',description:'当前选择'},{label:'全模型',description:'所有对象'}]}]};
  ui.emit('conversation',{busy:true,workspace:{kind:'model',supportsModelContext:true},session:session(),userInput:question});
  const box=ui.get('user-input'),form=box.children[1],group=form.children[0],radio=group.children[1].children[0],other=group.children[3].children[0];assert.equal(box.hidden,false);
  other.value='自定义范围';other.dispatchEvent(new UiEvent('input'));ui.emit('conversation',{busy:true,workspace:{kind:'model',supportsModelContext:true},session:session(),userInput:question});assert.equal(box.children[1],form);assert.equal(other.value,'自定义范围');
  radio.checked=true;radio.dispatchEvent(new UiEvent('change'));assert.equal(other.value,'');form.dispatchEvent(new UiEvent('submit'));await flush();const post=ui.requests.find(item=>item.url==='/api/user-input');assert.ok(post);assert.equal(post.body.requestId,'request-token');assert.equal(post.body.answers.q,'选区');
  await ui.respond(post);ui.emit('conversation',{busy:false,workspace:{kind:'model',supportsModelContext:true},session:session(),userInput:null});assert.equal(box.hidden,true);
});

test('skills busy rejection stays actionable and does not resend a command',async()=>{
 const conversationId='11111111-1111-4111-8111-111111111111';
 const ui=await setup({workspace:{kind:'model',supportsModelContext:true},historyAvailable:true,initialSession:{...session(),conversation:{id:conversationId,readOnly:false}}});
 ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,historyAvailable:true,skillsAvailable:true,skillsRevision:0,connectionGeneration:1,codexAccount:{accountRevision:0}});
 await ui.click('skills-refresh');const request=ui.requests.find(item=>item.url==='/api/skills');assert.ok(request);
 await ui.respond(request,{error:'请等待当前操作结束。'},false);
 assert.match(ui.get('skills-message').textContent,/原操作回执/);assert.equal(ui.get('skills-list').children.length,0);
 assert.equal(ui.requests.filter(item=>item.url==='/api/command'||item.url==='/api/turn').length,0);
});

for(const [label,extra] of [['busy',{statusBusy:true}],['unknown',{omitStatusBusy:true}]]){
 test('reconnect does not post when service busy state is '+label,async()=>{
  const ui=await setup({...extra,workspace:{kind:'model',supportsModelContext:true},directCommandsAvailable:true});
  await ui.click('reconnect');
  assert.equal(ui.requests.filter(request=>request.url==='/api/reconnect').length,0);
  assert.match(ui.get('error-notice').textContent,/没有请求重连/);
 });
}
