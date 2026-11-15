// Runs the production UI against isolated DOM and transport fixtures. No
// Codex, Revit, terminal, browser automation or real backend is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as chatView from './public/chat-view.mjs';

const source=await fs.readFile(new URL('./public/app.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.events=new Map();this.style={};this.dataset={};this.value='';this.textContent='';this.checked=false;this.hidden=false;this.disabled=false;this.className='';this.scrollHeight=60;this.scrollTop=0;this.clientHeight=300;this.isConnected=true;}
  addEventListener(name,fn){const items=this.events.get(name)||[];items.push(fn);this.events.set(name,items);}
  dispatchEvent(event){event.target=this;for(const fn of this.events.get(event.type)||[])fn(event);return true;}
  append(...items){for(const item of items){const el=typeof item==='string'?new Element():item;if(typeof item==='string')el.textContent=item;el.remove();el.parent=this;this.children.push(el);}}
  replaceChildren(...items){for(const child of this.children)child.parent=null;this.children=[];this.append(...items);}
  insertBefore(el,at){el.remove();el.parent=this;const i=this.children.indexOf(at);if(i<0)this.children.push(el);else this.children.splice(i,0,el);}
  remove(){if(this.parent){this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}}
  setAttribute(k,v){this[k]=v;} get childElementCount(){return this.children.length;} focus(){}
}
class UiEvent{constructor(type){this.type=type;}preventDefault(){}}
function session(id='conversation-a'){return {messages:[],context:{document:null,selection:null,capturedAt:null},contextEpoch:1,historyTruncated:false,conversation:{id,readOnly:false}};}
const workspace={kind:'model',supportsModelContext:true};
const approval=(override={})=>({id:'request-a',digest:'a'.repeat(64),kind:'terminal',action:'node.exe',target:'C:\\node.exe',cwd:'C:\\work',source:'Codex',parameters:'["<untrusted>","one"]',deadline:Date.now()+30000,conversationId:'conversation-a',...override});
async function setup({timers=null}={}){
  const elements=new Map(),requests=[];const get=id=>{if(!elements.has(id)){const el=new Element();if(id==='dynamic-approval')el.hidden=true;elements.set(id,el);}return elements.get(id);};
  class EventSource{static all=[];constructor(){this.events=new Map();EventSource.all.push(this);}addEventListener(name,fn){const a=this.events.get(name)||[];a.push(fn);this.events.set(name,a);}emit(name,data){for(const f of this.events.get(name)||[])f({data:JSON.stringify(data)});}close(){}}
  const win=new Element('window');let identity=0;
  const sandbox={__chatView:chatView,window:win,document:{getElementById:get,querySelectorAll:()=>[],createElement:tag=>new Element(tag),createTextNode:text=>{const el=new Element('#text');el.textContent=text;return el;},createDocumentFragment:()=>new Element('#fragment')},sessionStorage:{getItem:()=>null,setItem(){}},crypto:{randomUUID:()=>`id-${++identity}`},Event:UiEvent,CustomEvent:UiEvent,EventSource,navigator:{clipboard:{writeText:async()=>{}}},setTimeout:timers?.setTimeout??setTimeout,clearTimeout:timers?.clearTimeout??clearTimeout,queueMicrotask,
    fetch:async(url,options)=>{
      if(url==='/api/status')return {ok:true,json:async()=>({csrf:'csrf',ready:true,error:false,message:'ready',toolCount:0,toolCatalog:[],workspace,connectionGeneration:1,codexAccount:{accountRevision:1}})};
      return new Promise((resolve,reject)=>requests.push({url,body:JSON.parse(options.body),resolve,reject}));
    }};
  vm.runInContext(source.replace(/^import \{([^}]+)\} from '\.\/chat-view\.mjs';/,'const {$1} = __chatView;'),vm.createContext(sandbox));
  await flush();const stream=EventSource.all.at(-1);
  const emit=(name,data)=>stream.emit(name,data);
  emit('snapshot',{workspace,busy:false,session:session(),dynamicApproval:null});
  emit('state',{workspace,ready:true,connectionGeneration:1,codexAccount:{accountRevision:1}});await flush();
  const show=(data=approval(),overrides={})=>emit('conversation',{workspace,busy:true,session:session(),dynamicApproval:data,...overrides});
  const click=async el=>{el.dispatchEvent(new UiEvent('click'));await flush();};
  const respond=async(req,data)=>{req.resolve({ok:true,json:async()=>data});await flush();};
  return {get,requests,emit,show,click,respond};
}

test('full operation is displayed as text and only the one-use decision is submitted',async()=>{
  const ui=await setup(),box=ui.get('dynamic-approval');assert.equal(box.hidden,true);
  const p=approval();ui.show(p);const [title,detail,actions,feedback]=box.children;
  assert.equal(box.hidden,false);assert.match(title.textContent,/终端/);
  assert.equal(detail.children[1].textContent,p.action);assert.equal(detail.children[3].textContent,p.target);
  assert.equal(detail.children[5].textContent,p.parameters);assert.equal(detail.children[7].textContent,p.cwd);assert.equal(detail.children[9].textContent,p.source);
  await ui.click(actions.children[0]);await ui.click(actions.children[0]);
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/dynamic-approval');
  assert.deepEqual(ui.requests[0].body,{client:'id-1',conversationId:p.conversationId,requestId:p.id,digest:p.digest,decision:'accept'});
  await ui.respond(ui.requests[0],{ok:true,requestId:p.id,decision:'accept',status:'submitted'});
  assert.match(feedback.textContent,/执行结果需另行核对/);ui.show(p);await ui.click(actions.children[0]);assert.equal(ui.requests.length,1);
});

test('model approval shows full supplied parameters and warns about C# side effects',async()=>{
  const ui=await setup(),box=ui.get('dynamic-approval');
  const parameters=JSON.stringify({code:'File.WriteAllText("example", "x");',mode:'rollback'});
  const p=approval({kind:'model',action:'执行 C# 脚本',target:'示例模型',parameters});ui.show(p);
  const [title,detail,warning,actions]=box.children;
  assert.equal(box.hidden,false);assert.match(title.textContent,/模型/);assert.equal(detail.children[5].textContent,parameters);
  assert.match(warning.textContent,/事务外副作用/);await ui.click(actions.children[0]);
  assert.deepEqual(ui.requests[0].body,{client:'id-1',conversationId:p.conversationId,requestId:p.id,digest:p.digest,decision:'accept'});
  await ui.respond(ui.requests[0],{ok:true,requestId:p.id,decision:'accept',status:'submitted'});
});

test('a generated file requires one scoped approval and is opened by opaque ID',async()=>{
  const ui=await setup(),box=ui.get('dynamic-approval'),files=ui.get('generated-files');
  const proposal=approval({kind:'file',action:'buildx_generate_file',target:'端吸泵.rfa',cwd:'D:\\模型输出',parameters:'600 × 400 × 500 mm'});
  ui.show(proposal);
  const [title,detail,actions,approvalFeedback]=box.children;
  assert.equal(title.textContent,'生成文件');
  assert.deepEqual(detail.children.map(child=>child.textContent),['文件名',proposal.target,'保存目录',proposal.cwd,'生成规格',proposal.parameters]);
  assert.equal(actions.children[0].textContent,'允许本次生成');
  await ui.click(actions.children[0]);await ui.click(actions.children[0]);
  assert.equal(ui.requests.length,1);
  assert.deepEqual(ui.requests[0].body,{client:'id-1',conversationId:proposal.conversationId,requestId:proposal.id,digest:proposal.digest,decision:'accept'});
  await ui.respond(ui.requests[0],{ok:true,requestId:proposal.id,decision:'accept',status:'submitted'});
  assert.match(approvalFeedback.textContent,/已授权/);
  const file={kind:'file',artifactId:'e5f0f9f7-830c-4df2-8976-f8b2311b6f21',fileName:proposal.target,bytes:4096};
  ui.show(null,{busy:false,generatedFiles:[file,file,{...file,artifactId:'d5f0f9f7-830c-4df2-8976-f8b2311b6f21',fileName:'..\\其他.rfa'}]});
  assert.equal(files.hidden,false);
  const [open,feedback]=files.children;
  assert.equal(files.children.length,2);
  assert.match(open.textContent,/端吸泵\.rfa · 4 KiB/);
  await ui.click(open);await ui.click(open);
  assert.equal(ui.requests.length,2);
  assert.equal(ui.requests[1].url,'/api/chat-artifact/open');
  assert.deepEqual(ui.requests[1].body,{client:'id-1',conversationId:proposal.conversationId,artifactId:file.artifactId});
  await ui.respond(ui.requests[1],{ok:true});
  assert.match(feedback.textContent,/打开请求已提交/);
  ui.emit('conversation',{workspace,busy:false,session:session('conversation-b'),generatedFiles:[]});
  assert.equal(files.hidden,true);
  await ui.click(open);assert.equal(ui.requests.length,2);
});

test('a pending artifact checks its original receipt and appears as a file only after verification',async()=>{
  const ui=await setup(),files=ui.get('generated-files');
  const artifact={artifactId:'f5f0f9f7-830c-4df2-8976-f8b2311b6f21',fileName:'端吸泵.rfa'};
  ui.show(null,{busy:false,generatedFiles:[],generatedFilePending:[artifact]});
  assert.equal(files.hidden,false);
  const [check,feedback]=files.children;
  assert.match(check.textContent,/核对原回执/);
  await ui.click(check);await ui.click(check);
  assert.equal(ui.requests.length,1);
  assert.equal(ui.requests[0].url,'/api/chat-artifact/check');
  assert.deepEqual(ui.requests[0].body,{client:'id-1',conversationId:'conversation-a',artifactId:artifact.artifactId});
  await ui.respond(ui.requests[0],{ok:true,status:'pending'});
  assert.match(feedback.textContent,/原回执仍待核对/);
  ui.show(null,{busy:false,generatedFiles:[{...artifact,kind:'file',bytes:4096}],generatedFilePending:[artifact]});
  const [open]=files.children;
  assert.equal(files.children.length,2);
  assert.equal(open['aria-label'],'打开文件 '+artifact.fileName);
  await ui.click(check);assert.equal(ui.requests.length,1);
});

test('a terminal file failure keeps its own explanation and checks only the original artifact ID',async()=>{
  const ui=await setup(),files=ui.get('generated-files');
  const failure={status:'failed',artifactId:'a0c8ede3-2ba0-44d9-8f7e-0ab91db65eb0',
    fileName:'泵-a0c8ede32ba044d98f7e0ab91db65eb0.rfa',message:'Revit 未能定位进水口端面。'};
  ui.show(null,{busy:false,generatedFileFailures:[failure]});
  const [card,detail,feedback]=files.children;
  assert.match(card.textContent,/制作失败/);
  assert.match(card['aria-label'],/核对原回执/);
  assert.match(detail.textContent,/进水口端面/);
  assert.ok(detail.textContent.includes(failure.artifactId));
  await ui.click(card);
  assert.deepEqual(ui.requests.map(request=>({url:request.url,body:request.body})),[{
    url:'/api/chat-artifact/check',body:{client:'id-1',conversationId:'conversation-a',artifactId:failure.artifactId}
  }]);
  await ui.respond(ui.requests[0],{ok:true,...failure});
  assert.ok(feedback.textContent.includes(failure.artifactId));
  assert.match(feedback.textContent,/进水口端面/);
});

test('expired and malformed previews cannot be submitted',async()=>{
  const ui=await setup(),box=ui.get('dynamic-approval');ui.show(approval({deadline:Date.now()-1}));
  assert.match(box.children[3].textContent,/超时/);assert.equal(box.children[2].children[0].disabled,true);await ui.click(box.children[2].children[0]);assert.equal(ui.requests.length,0);
  ui.show(approval({id:'request-b',parameters:'x'.repeat(65537)}));assert.equal(box.hidden,true);assert.equal(ui.requests.length,0);
});

test('late or failed submission stays uncertain and cannot be replayed',async()=>{
  const ui=await setup(),box=ui.get('dynamic-approval'),p=approval();ui.show(p);const actions=box.children[2],feedback=box.children[3];
  await ui.click(actions.children[1]);ui.requests[0].reject(new Error('offline'));await flush();
  assert.match(feedback.textContent,/尚未核对/);ui.show(p);await ui.click(actions.children[1]);assert.equal(ui.requests.length,1);
});

test('server may clear the claimed proposal before the matching submission receipt',async()=>{
  const ui=await setup(),box=ui.get('dynamic-approval'),p=approval();ui.show(p);const actions=box.children[2],feedback=box.children[3];
  await ui.click(actions.children[0]);ui.show(null);assert.match(feedback.textContent,/正在提交/);
  await ui.respond(ui.requests[0],{ok:true,requestId:p.id,decision:'accept',status:'submitted'});
  assert.match(feedback.textContent,/执行结果需另行核对/);assert.equal(actions.children[0].disabled,true);
});

test('a changed payload for the same request cannot be approved',async()=>{
  const ui=await setup(),box=ui.get('dynamic-approval'),p=approval();ui.show(p);const actions=box.children[2];
  ui.show({...p,parameters:'["altered"]'});assert.equal(box.hidden,true);await ui.click(actions.children[0]);assert.equal(ui.requests.length,0);
  ui.show(p);assert.equal(box.hidden,true);
});

test('a changed conversation invalidates a pending response',async()=>{
  const ui=await setup(),box=ui.get('dynamic-approval'),p=approval();ui.show(p);const actions=box.children[2];await ui.click(actions.children[0]);
  ui.emit('conversation',{workspace,busy:true,session:session('conversation-b'),dynamicApproval:null});
  await ui.respond(ui.requests[0],{ok:true,requestId:p.id,decision:'accept',status:'submitted'});
  assert.equal(box.hidden,true);ui.show(p);assert.equal(box.hidden,true);
});

const modelResult=(p,overrides={})=>({requestId:p.id,digest:p.digest,conversationId:p.conversationId,status:'not_started',code:'MODEL_DOCUMENT_REVALIDATION_FAILED',...overrides});
test('a delayed model result replaces submitted feedback after the turn ends and permission is revoked',async()=>{
  let elapsed=0;const timers=[];
  const clock={setTimeout(fn,ms){const item={fn,at:elapsed+ms,cleared:false};timers.push(item);return item;},clearTimeout(item){if(item)item.cleared=true;}};
  const ui=await setup({timers:clock}),box=ui.get('dynamic-approval'),p=approval({kind:'model'});ui.show(p);
  const actions=box.children[3],feedback=box.children[4];await ui.click(actions.children[0]);
  await ui.respond(ui.requests[0],{ok:true,requestId:p.id,decision:'accept',status:'submitted'});
  assert.match(feedback.textContent,/等待模型操作结果/);
  ui.emit('conversation',{workspace,busy:true,session:session(),dynamicApproval:null,dynamicApprovalResult:null});
  assert.match(feedback.textContent,/等待模型操作结果/);
  elapsed=61000;for(const item of timers.filter(item=>!item.cleared&&item.at<=elapsed)){item.cleared=true;item.fn();}await flush();
  assert.match(feedback.textContent,/等待模型操作结果/);
  ui.emit('conversation',{workspace,busy:false,session:session(),dynamicApproval:null,dynamicApprovalResult:modelResult(p),modelPermission:{available:true,level:null,revision:2,conversationId:p.conversationId,documentLabel:'当前模型（选择后核实）',expiresAt:null}});
  assert.match(feedback.textContent,/本次操作未开始/);assert.match(feedback.textContent,/MODEL_DOCUMENT_REVALIDATION_FAILED/);
  assert.equal(actions.children[0].disabled,true);assert.equal(actions.children[1].disabled,true);
});

test('a terminal model SSE result arriving before the decision HTTP receipt cannot be overwritten',async()=>{
  const ui=await setup(),box=ui.get('dynamic-approval'),p=approval({kind:'model'});ui.show(p);
  const actions=box.children[3],feedback=box.children[4];await ui.click(actions.children[0]);
  ui.emit('conversation',{workspace,busy:false,session:session(),dynamicApproval:null,dynamicApprovalResult:modelResult(p)});
  assert.match(feedback.textContent,/本次操作未开始/);
  await ui.respond(ui.requests[0],{ok:true,requestId:p.id,decision:'accept',status:'submitted'});
  assert.match(feedback.textContent,/本次操作未开始/);assert.equal(actions.children[0].disabled,true);
});

test('completed and unconfirmed model outcomes remain distinct from submitting a confirmation',async()=>{
  for(const status of ['completed','unconfirmed']){
    const ui=await setup(),box=ui.get('dynamic-approval'),p=approval({kind:'model'});ui.show(p);
    const actions=box.children[3],feedback=box.children[4];await ui.click(actions.children[0]);
    await ui.respond(ui.requests[0],{ok:true,requestId:p.id,decision:'accept',status:'submitted'});
    ui.emit('conversation',{workspace,busy:false,session:session(),dynamicApproval:null,dynamicApprovalResult:modelResult(p,{status,code:undefined})});
    assert.match(feedback.textContent,status==='completed'?/模型操作已完成/:/结果尚未确认/);
    if(status==='unconfirmed'){
      ui.emit('conversation',{workspace,busy:false,session:session(),dynamicApproval:null,dynamicApprovalResult:modelResult(p,{status,code:undefined,operationOutcome:'not_started'})});
      assert.match(feedback.textContent,/模型操作未开始.*原回执仍需核对/);
    }
  }
});

test('old or mismatched model result identities cannot settle the current approval',async()=>{
  const ui=await setup(),box=ui.get('dynamic-approval'),p=approval({kind:'model'});ui.show(p);
  const actions=box.children[3],feedback=box.children[4];await ui.click(actions.children[0]);
  await ui.respond(ui.requests[0],{ok:true,requestId:p.id,decision:'accept',status:'submitted'});
  for(const changed of [{requestId:'other'},{digest:'b'.repeat(64)},{conversationId:'other'}]){
    ui.emit('conversation',{workspace,busy:true,session:session(),dynamicApproval:null,dynamicApprovalResult:modelResult(p,changed)});
    assert.match(feedback.textContent,/等待模型操作结果/);
  }
  ui.emit('state',{workspace,ready:true,connectionGeneration:2,codexAccount:{accountRevision:1}});
  ui.emit('conversation',{workspace,busy:false,session:session(),dynamicApproval:null,dynamicApprovalResult:modelResult(p)});
  assert.doesNotMatch(feedback.textContent,/MODEL_DOCUMENT_REVALIDATION_FAILED/);
  assert.match(feedback.textContent,/已提交操作的结果尚未核对/);assert.doesNotMatch(feedback.textContent,/等待模型操作结果/);
});

test('submitted model cards settle when their same-conversation context or account scope changes',async()=>{
  for(const changed of ['context','connection','account']){
    const ui=await setup(),box=ui.get('dynamic-approval'),p=approval({kind:'model'});ui.show(p);
    const actions=box.children[3],feedback=box.children[4];await ui.click(actions.children[0]);
    await ui.respond(ui.requests[0],{ok:true,requestId:p.id,decision:'accept',status:'submitted'});
    if(changed==='context')ui.emit('conversation',{workspace,busy:true,session:{...session(),contextEpoch:2},dynamicApproval:null});
    else ui.emit('state',{workspace,ready:true,connectionGeneration:changed==='connection'?2:1,codexAccount:{accountRevision:changed==='account'?2:1}});
    assert.match(feedback.textContent,/已提交操作的结果尚未核对/);assert.doesNotMatch(feedback.textContent,/等待模型操作结果/);
    ui.emit('conversation',{workspace,busy:false,session:{...session(),contextEpoch:changed==='context'?2:1},dynamicApproval:null,dynamicApprovalResult:modelResult(p)});
    assert.doesNotMatch(feedback.textContent,/MODEL_DOCUMENT_REVALIDATION_FAILED/);
    // Restoring an old-looking snapshot cannot revive this invalidated card.
    ui.emit('state',{workspace,ready:true,connectionGeneration:1,codexAccount:{accountRevision:1}});
    ui.emit('conversation',{workspace,busy:true,session:session(),dynamicApproval:p,dynamicApprovalResult:modelResult(p)});
    assert.match(feedback.textContent,/已提交操作的结果尚未核对/);assert.equal(actions.children[0].disabled,true);
    await ui.click(actions.children[0]);assert.equal(ui.requests.length,1);
  }
});

test('scope changes cannot reset a completed model card back to waiting or uncertainty',async()=>{
  const ui=await setup(),box=ui.get('dynamic-approval'),p=approval({kind:'model'});ui.show(p);
  const actions=box.children[3],feedback=box.children[4];await ui.click(actions.children[0]);
  await ui.respond(ui.requests[0],{ok:true,requestId:p.id,decision:'accept',status:'submitted'});
  ui.emit('conversation',{workspace,busy:false,session:session(),dynamicApproval:null,dynamicApprovalResult:modelResult(p,{status:'completed',code:undefined})});
  assert.match(feedback.textContent,/模型操作已完成/);
  ui.emit('conversation',{workspace,busy:false,session:{...session(),contextEpoch:2},dynamicApproval:null});
  ui.emit('state',{workspace,ready:true,connectionGeneration:2,codexAccount:{accountRevision:2}});
  ui.emit('conversation',{workspace,busy:false,session:{...session(),contextEpoch:2},dynamicApproval:null,dynamicApprovalResult:null});
  assert.match(feedback.textContent,/模型操作已完成/);assert.doesNotMatch(feedback.textContent,/等待|尚未核对/);
});
