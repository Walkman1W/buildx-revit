import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from './lib/panel-server.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
class FakeCodex extends EventEmitter{
  constructor(){super();this.state={ready:true,error:false,message:'fake ready',toolCount:31};this.threads=0;this.turns=[];this.interrupts=[];this.starts=0;this.closes=0;}
  async start(){this.starts++;this.state={...this.state,ready:true,error:false};this.emit('state',this.state);}
  failed(message){this.state={...this.state,ready:false,error:true,message};this.emit('state',this.state);}
  async close(){this.closes++;this.failed('fake connection closed');return {closed:true};}
  async newThread(){return 'thread-'+(++this.threads);}
  async turn(threadId,text){const turnId='turn-'+(this.turns.length+1);this.turns.push({threadId,text,turnId});if(this.onTurn)await this.onTurn(this.turns.at(-1));return {turn:{id:turnId}};}
  async interrupt(threadId,turnId){this.interrupts.push({threadId,turnId});}
  notify(method,turn,params={}){this.emit('notification',method,{threadId:turn.threadId,turnId:turn.turnId,...params});}
}
async function setup(t,options={}){
  const codex=new FakeCodex(),calls=[],records=[];
  const app=createPanelServer({root,codex,port:0,invokeWorkbench:async(...args)=>{calls.push(args);throw new Error('unexpected Revit read');},audit:(file,data)=>records.push({file,data}),...options});
  const {origin}=await app.listen();const data=await(await fetch(origin+'/api/status')).json();
  const streams=[];
  t.after(async()=>{for(const stream of streams)stream.abort();await app.close();});
  async function post(route,value={},headers={}){const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':data.csrf,Origin:origin,...headers},body:JSON.stringify({client:'client-a',...value})});return {status:response.status,data:await response.json()};}
  async function events(client='client-a'){
    const controller=new AbortController();streams.push(controller);const response=await fetch(origin+'/api/events?client='+client,{signal:controller.signal});const reader=response.body.getReader();let buffer='';
    return {async next(){while(true){const index=buffer.indexOf('\n\n');if(index>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2);if(!block.startsWith('event: '))continue;return {event:block.slice(7,block.indexOf('\n')),data:JSON.parse(block.slice(block.indexOf('data: ')+6))};}const {value,done}=await reader.read();if(done)throw new Error('stream ended');buffer+=new TextDecoder().decode(value);}},abort:()=>controller.abort()};
  }
  return {app,codex,calls,records,origin,post,events};
}
test('model workspace reads model catalog and admits only a verified model selection',async t=>{
  const f=await setup(t);f.codex.state.codexAccount={connectionGeneration:1,accountRevision:0};
  let valid=false;f.codex.listModels=async()=>{valid=true;return [{id:'first',model:'model-first',displayName:'First',description:'',isDefault:true}];};
  f.codex.assertModelSelection=model=>{if(!valid||model!=='model-first')throw new Error('模型选择无效');};
  f.codex.turn=async(threadId,text,images,model)=>{f.codex.turns.push({threadId,text,images,model,turnId:'turn-1'});return {turn:{id:'turn-1'}};};
  assert.equal((await f.post('turn',{message:'before',model:'model-first'})).status,409);
  const catalog=await f.post('models');assert.equal(catalog.status,200);assert.equal(catalog.data.models[0].model,'model-first');
  assert.equal((await f.post('turn',{message:'bad',model:'unknown'})).status,409);assert.equal(f.codex.turns.length,0);
  assert.equal((await f.post('turn',{message:'hello',model:'model-first'})).status,202);assert.equal(f.codex.turns[0].model,'model-first');
});
test('late model list is discarded when the Codex account revision changes',async t=>{
  const f=await setup(t);f.codex.state.codexAccount={connectionGeneration:1,accountRevision:0};let release;
  f.codex.listModels=()=>new Promise(resolve=>{release=resolve;});f.codex.assertModelSelection=()=>{};
  const pending=f.post('models');while(!release)await new Promise(resolve=>setImmediate(resolve));
  f.codex.state.codexAccount={connectionGeneration:1,accountRevision:1};release([{id:'old',model:'old',displayName:'Old',description:'',isDefault:true}]);
  const response=await pending;assert.equal(response.status,409);assert.equal(response.data.models,undefined);
});
test('model effort is validated before a turn and sent with its chosen model',async t=>{
  const f=await setup(t);f.codex.state.codexAccount={connectionGeneration:1,accountRevision:0};
  let validated=[];
  f.codex.assertModelSelection=(model,{effort}={})=>{validated.push({model,effort});if(model!=='model-first'||effort!==undefined&&effort!=='high')throw new Error('模型或推理强度无效');};
  f.codex.turn=async(threadId,text,images,model,effort)=>{f.codex.turns.push({threadId,text,images,model,effort,turnId:'turn-1'});return {turn:{id:'turn-1'}};};
  assert.equal((await f.post('turn',{message:'without model',effort:'high'})).status,400);
  assert.equal((await f.post('turn',{message:'bad',model:'model-first',effort:'forged'})).status,409);
  assert.equal(f.codex.turns.length,0);assert.equal(f.codex.threads,0);
  assert.equal((await f.post('turn',{message:'hello',model:'model-first',effort:'high'})).status,202);
  assert.equal(f.codex.turns[0].model,'model-first');assert.equal(f.codex.turns[0].effort,'high');
  assert.ok(validated.some(item=>item.effort==='high'));
});
test('HTTP/SSE restores full multi-turn history; tools return/fail cards, private and late events ignored',async t=>{
  const f=await setup(t),stream=await f.events();assert.equal((await stream.next()).event,'snapshot');
  assert.equal((await f.post('turn',{message:'第一轮'})).status,202);const turn=f.codex.turns[0];
  f.codex.notify('item/started',turn,{item:{id:'tool-1',type:'mcpToolCall',tool:'revit_get_selection',arguments:{expected_document:'D:\\sample.rvt'}}});
  f.codex.notify('item/completed',turn,{item:{id:'tool-1',type:'mcpToolCall',tool:'revit_get_selection',status:'completed',result:{content:[{type:'text',text:'count=2'}]}}});
  f.codex.notify('item/completed',turn,{item:{id:'tool-2',type:'mcpToolCall',tool:'revit_search_elements',status:'completed',result:{isError:true,content:[]}}});
  f.codex.notify('item/agentMessage/delta',turn,{itemId:'a',delta:'正在核对'});
  f.codex.notify('item/completed',turn,{item:{id:'a',type:'agentMessage',text:'第一轮结果'}});
  f.codex.notify('item/started',turn,{item:{id:'r',type:'reasoning',text:'private reasoning'}});
  f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'completed'}});
  assert.equal((await f.post('turn',{message:'第二轮'})).status,202);const second=f.codex.turns[1];
  f.codex.notify('item/agentMessage/delta',turn,{itemId:'late',delta:'late contamination'});
  f.codex.emit('notification','item/agentMessage/delta',{delta:'unknown contamination'});
  f.codex.notify('item/agentMessage/delta',second,{itemId:'b',delta:'第二轮结果'});
  f.codex.notify('turn/completed',second,{turn:{id:second.turnId,status:'completed'}});
  const fresh=await f.events();const snapshot=(await fresh.next()).data;
  assert.deepEqual(snapshot.session.messages.map(message=>message.text),['第一轮','第一轮结果','第二轮','第二轮结果']);
  assert.deepEqual(snapshot.session.messages[1].tools.map(tool=>tool.status),['returned','unknown']);assert.equal(snapshot.busy,false);assert.equal(f.codex.threads,1);assert.equal(f.calls.length,0);
  assert.doesNotMatch(JSON.stringify(snapshot),/contamination|private reasoning/);assert.equal(f.records.filter(record=>record.file==='tool-calls.jsonl').length,3);assert.doesNotMatch(JSON.stringify(f.records),/expected_document|count=2/);
});

test('HTTP/SSE projects server-owned conversation identity and current-runtime thread binding without claiming persisted resume',async t=>{
  const f=await setup(t),stream=await f.events(),initial=(await stream.next()).data.session;
  assert.equal(initial.conversation.source,'local-codex-panel');
  assert.equal(initial.conversation.threadBinding.threadId,null);
  assert.equal(initial.conversation.threadBinding.scope,'current-runtime');
  assert.equal(initial.conversation.threadBinding.persistedResumeVerified,false);
  const id=initial.conversation.id;
  const other=f.app.snapshot('client-b').session;
  assert.notEqual(other.conversation.id,id);
  await f.post('turn',{message:'第一轮'});const first=f.codex.turns[0];
  f.codex.notify('item/completed',first,{item:{id:'answer-1',type:'agentMessage',text:'第一轮结果'}});
  f.codex.notify('turn/completed',first,{turn:{id:first.turnId,status:'completed'}});
  const bound=f.app.snapshot('client-a').session;
  assert.equal(bound.conversation.id,id);assert.equal(bound.conversation.threadBinding.threadId,first.threadId);
  await f.post('turn',{message:'第二轮'});const second=f.codex.turns[1];
  assert.equal(second.threadId,first.threadId);assert.equal(f.app.snapshot('client-a').session.conversation.id,id);
  f.codex.notify('turn/completed',second,{turn:{id:second.turnId,status:'completed'}});
  await f.post('reconnect');await new Promise(resolve=>setImmediate(resolve));
  const reset=f.app.snapshot('client-a').session;
  assert.equal(reset.conversation.id,id);assert.equal(reset.conversation.threadBinding.threadId,null);
  assert.equal(reset.conversation.threadBinding.contextEpoch,bound.contextEpoch+1);
  assert.equal(reset.messages[0].text,'第一轮');assert.equal(reset.messages[1].text,'第一轮结果');
  assert.equal(bound.conversation.threadBinding.threadId,first.threadId);
  const next=await f.post('new-chat');assert.equal(next.status,200);
  assert.notEqual(next.data.session.conversation.id,id);assert.deepEqual(next.data.session.messages,[]);
  f.codex.notify('item/agentMessage/delta',first,{itemId:'late',delta:'旧对话污染'});
  assert.equal(f.app.snapshot('client-a').session.conversation.id,next.data.session.conversation.id);
  assert.equal(f.app.snapshot('client-a').session.messages.length,0);
  assert.equal(f.app.snapshot('client-b').session.conversation.id,other.conversation.id);
  assert.equal(f.codex.threads,1);assert.equal(f.calls.length,0);
});
test('turn/start race is buffered by exact ownership, interrupted tools retain unknown outcome',async t=>{
  const f=await setup(t);
  f.codex.onTurn=turn=>{
    f.codex.notify('item/agentMessage/delta',turn,{itemId:'early',delta:'抢先送达'});
    f.codex.notify('item/agentMessage/delta',turn,{turnId:'foreign',itemId:'wrong',delta:'污染'});
    f.codex.notify('item/started',turn,{item:{id:'tool',type:'mcpToolCall',tool:'revit_create_wall',arguments:{height_mm:3000}}});
  };
  await f.post('turn',{message:'测试'});assert.equal((await f.post('turn',{client:'client-b',message:'第二窗口'})).status,409);
  await f.post('interrupt');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.codex.interrupts.length,1);
  const turn=f.codex.turns[0];f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'interrupted'}});
  const view=f.app.snapshot('client-a');assert.equal(view.session.messages[1].text,'抢先送达');assert.equal(view.session.messages[1].status,'interrupted');assert.equal(view.session.messages[1].tools[0].status,'unknown');assert.match(view.session.messages[2].text,/不保证|需要核对/);assert.equal(view.busy,false);
  assert.match(view.session.messages.at(-1).text,/你的请求/);
});
test('error notification does not release a turn before its native terminal event',async t=>{
  const f=await setup(t);await f.post('turn',{message:'等待错误回执'});const turn=f.codex.turns[0];
  f.codex.notify('item/started',turn,{item:{id:'tool',type:'mcpToolCall',tool:'revit_create_wall'}});
  f.codex.notify('error',turn,{willRetry:false,error:{message:'private'}});
  assert.equal(f.app.snapshot('client-a').busy,true);
  assert.equal((await f.post('turn',{message:'不应开始'})).status,409);
  f.codex.notify('item/completed',turn,{item:{id:'tool',type:'mcpToolCall',tool:'revit_create_wall',status:'completed'}});
  f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'failed'}});
  const view=f.app.snapshot('client-a');assert.equal(view.busy,false);assert.equal(view.session.messages[1].status,'failed');assert.equal(view.session.messages[1].tools[0].status,'returned');
  assert.doesNotMatch(JSON.stringify(view),/private/);
});
test('workbench transport error remains unknown and a full event budget still retires the turn',async t=>{
  const f=await setup(t);await f.post('turn',{message:'核对'});const turn=f.codex.turns[0];
  f.codex.notify('item/completed',turn,{item:{id:'tool',type:'mcpToolCall',server:'revit_workbench',tool:'revit_execute_csharp',status:'failed',error:{message:'opaque error'}}});
  assert.equal(f.app.snapshot('client-a').session.messages[1].tools[0].status,'unknown');
  for(let i=0;i<1024;i++)f.codex.notify('item/agentMessage/delta',turn,{eventId:'event-'+i,itemId:'one',delta:'x'});
  f.codex.notify('item/agentMessage/delta',turn,{eventId:'dropped',itemId:'one',delta:'missing'});
  f.codex.notify('turn/completed',turn,{eventId:'terminal',turn:{id:turn.turnId,status:'completed'}});
  const view=f.app.snapshot('client-a');assert.equal(view.busy,false);assert.equal(view.session.messages[1].status,'unknown');assert.match(view.session.messages.at(-1).text,/不完整/);
});
test('HTTP snapshot preserves the turn status when the tool-record display budget is exceeded',async t=>{
  const f=await setup(t);await f.post('turn',{message:'长任务'});const turn=f.codex.turns[0];
  for(let i=0;i<40;i++)f.codex.notify('item/completed',turn,{item:{id:'tool-'+i,type:'mcpToolCall',tool:'revit_get_selection',status:'completed'}});
  f.codex.notify('item/started',turn,{item:{id:'tool-40',type:'mcpToolCall',tool:'revit_execute_csharp',status:'inProgress'}});
  f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'completed'}});
  const view=f.app.snapshot('client-a');assert.equal(view.busy,false);assert.equal(view.session.messages[1].status,'completed');
  assert.equal(view.session.messages[1].tools.length,40);assert.equal(view.session.messages[1].toolHistoryTruncated,true);
});
test('non-retryable error without a terminal receipt eventually retires the connection as unknown',async t=>{
  const original=setTimeout;
  globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===45000?10:ms,...args);
  try{
    const f=await setup(t);await f.post('turn',{message:'等待回执'});const turn=f.codex.turns[0];
    f.codex.notify('item/started',turn,{item:{id:'tool',type:'mcpToolCall',tool:'revit_create_wall'}});
    f.codex.notify('error',turn,{willRetry:false,error:{message:'private'}});
    await new Promise(resolve=>original(resolve,40));const view=f.app.snapshot('client-a');
    assert.equal(view.busy,false);assert.equal(view.session.messages[1].status,'unknown');assert.equal(view.session.messages[1].tools[0].status,'unknown');assert.equal(f.codex.closes,1);assert.equal(f.codex.turns.length,1);
    f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'completed'}});
    assert.equal(f.app.snapshot('client-a').session.messages[1].status,'unknown');
  }finally{globalThis.setTimeout=original;}
});
test('a stop completion after error cancels the error receipt deadline and does not reset the connection',async t=>{
  const original=setTimeout;globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===45000?35:ms,...args);
  try{
    const f=await setup(t);await f.post('turn',{message:'停止'});const turn=f.codex.turns[0];
    f.codex.notify('error',turn,{willRetry:false,error:{message:'private'}});await f.post('interrupt');
    f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'interrupted'}});
    await new Promise(resolve=>original(resolve,60));assert.equal(f.codex.closes,0);assert.equal(f.codex.turns.length,1);
    assert.equal(f.app.snapshot('client-a').session.messages[1].status,'interrupted');
  }finally{globalThis.setTimeout=original;}
});
test('early notification overflow retains terminal identity and reports incomplete outcome',async t=>{
  const f=await setup(t);f.codex.onTurn=turn=>{
    for(let i=0;i<110;i++)f.codex.notify('item/agentMessage/delta',turn,{itemId:'early',delta:'x'});
    f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'completed'}});
  };
  assert.equal((await f.post('turn',{message:'事件较多'})).status,202);
  const view=f.app.snapshot('client-a');assert.equal(view.busy,false);assert.equal(view.session.messages[1].status,'unknown');assert.match(view.session.messages.at(-1).text,/事件超过.*上限/);
});
test('early overflow without a retained terminal resets to unknown instead of leaving an orphaned busy turn',async t=>{
  const f=await setup(t);f.codex.onTurn=turn=>{for(let i=0;i<110;i++)f.codex.notify('item/agentMessage/delta',turn,{itemId:'early',delta:'x'});};
  assert.equal((await f.post('turn',{message:'事件较多'})).status,202);
  await new Promise(resolve=>setImmediate(resolve));const view=f.app.snapshot('client-a');
  assert.equal(view.busy,false);assert.equal(view.session.messages[1].status,'unknown');assert.equal(f.codex.closes,1);
});
test('an early native interruption does not claim a stop was sent before turn/start acknowledges',async t=>{
  const f=await setup(t);let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.codex.onTurn=async()=>{entered();await gate;};
  const sending=f.post('turn',{message:'等待启动回执'});await started;
  assert.equal((await f.post('interrupt')).status,202);
  const turn=f.codex.turns[0];f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'interrupted'}});
  release();assert.equal((await sending).status,202);
  const view=f.app.snapshot('client-a');assert.equal(f.codex.interrupts.length,0);assert.equal(view.busy,false);
  assert.match(view.session.messages.at(-1).text,/停止指令尚未发送/);
  assert.doesNotMatch(view.session.messages.at(-1).text,/已按你的请求发送停止指令/);
});
test('the default turn has no three-minute deadline, and a later completion is retained',async t=>{
  const original=setTimeout;let oldDeadlineScheduled=false;
  globalThis.setTimeout=(fn,ms,...args)=>{if(ms===180000){oldDeadlineScheduled=true;return original(fn,5,...args);}return original(fn,ms,...args);};
  try{
    const f=await setup(t);await f.post('turn',{message:'长任务'});const turn=f.codex.turns[0];
    await new Promise(resolve=>original(resolve,30));
    assert.equal(oldDeadlineScheduled,false);assert.equal(f.codex.interrupts.length,0);assert.equal(f.app.snapshot('client-a').busy,true);
    f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'completed'}});
    assert.equal(f.app.snapshot('client-a').session.messages[1].status,'completed');
  }finally{globalThis.setTimeout=original;}
});
test('an explicitly configured turn deadline requests interruption and identifies its cause',async t=>{
  const f=await setup(t,{turnTimeout:15});await f.post('turn',{message:'限时任务'});const turn=f.codex.turns[0];
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.codex.interrupts.length,1);
  f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'interrupted'}});
  const view=f.app.snapshot('client-a');assert.equal(view.busy,false);assert.match(view.session.messages.at(-1).text,/配置的对话时限/);
});
test('a native interruption without a panel request is not attributed to a timeout or user',async t=>{
  const f=await setup(t);await f.post('turn',{message:'任务'});const turn=f.codex.turns[0];
  f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'interrupted'}});
  const view=f.app.snapshot('client-a');assert.equal(view.session.messages[1].status,'interrupted');assert.equal(f.codex.interrupts.length,0);
  assert.doesNotMatch(view.session.messages.map(message=>message.text).join(' '),/配置的对话时限|你的请求/);
});
test('invalid explicit turn deadlines are rejected instead of becoming immediate timers',()=>{
  for(const turnTimeout of [0,-1,1.5,NaN,Infinity,2147483648,'180000'])assert.throws(()=>createPanelServer({root,codex:new FakeCodex(),invokeWorkbench:async()=>{},audit:()=>{},turnTimeout}),/Invalid turn timeout/);
});
test('context must be explicitly refreshed for every turn and never trusts client-supplied model fields',async t=>{
  const calls=[];let version=0;
  const invoke=async(name,args)=>{calls.push({name,args});const document={title:'样例'+version,path:'D:\\samples\\a'+version+'.rvt',activeViewId:12,allowedSample:true};return name==='revit_workbench_status'?{hostSession:'s',document}:{operation:'get_selection',hostSession:'s',document,value:{total:1,returned:1,truncated:false,items:[{element_id:42}]}};};
  const f=await setup(t,{invokeWorkbench:invoke});
  const preview=await f.post('context',{includeDocument:true,includeSelection:true,document:{title:'forged'}});assert.equal(preview.status,200);assert.equal(preview.data.context.document.title,'样例0');assert.deepEqual(preview.data.context.selection.elementIds,['42']);
  version=1;
  await f.post('turn',{message:'只读统计',context:{includeDocument:true,includeSelection:true}});
  assert.match(f.codex.turns[0].text,/样例1/);assert.doesNotMatch(f.codex.turns[0].text,/样例0|forged/);assert.equal(calls.length,6);
  const turn=f.codex.turns[0];f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'completed'}});
  await f.post('turn',{message:'普通对话'});assert.equal(f.codex.turns[1].text,'普通对话');assert.equal(calls.length,6);assert.equal(f.app.snapshot('client-a').session.context.document,null);
});
test('cross-document context fails before Codex, reset retains history/epoch, new chat clears safely',async t=>{
  let reads=0;
  const f=await setup(t,{invokeWorkbench:async()=>({hostSession:'s',document:{title:'sample',path:reads++?'D:\\b.rvt':'D:\\a.rvt'}})});
  const result=await f.post('turn',{message:'读取当前模型',context:{includeDocument:true}});assert.equal(result.status,502);assert.equal(f.codex.turns.length,0);assert.equal(f.app.snapshot('client-a').session.messages[1].status,'failed');
  const before=f.app.snapshot('client-a').session.messages.length;
  assert.equal((await f.post('reconnect')).status,202);await new Promise(resolve=>setImmediate(resolve));
  const reset=f.app.snapshot('client-a').session;assert.equal(reset.contextEpoch,1);assert.equal(reset.messages.length,before+1);assert.match(reset.messages.at(-1).text,/AI 上下文已重置/);
  assert.equal((await f.post('new-chat')).status,200);assert.deepEqual(f.app.snapshot('client-a').session.messages,[]);assert.equal(f.app.snapshot('client-a').session.contextEpoch,2);
});
test('HTTP protects Host, Origin and CSRF while allowing only fixed static module paths',async t=>{
  const f=await setup(t);
  assert.equal((await f.post('turn',{message:'x'},{Origin:'http://evil.example'})).status,403);
  assert.equal((await f.post('turn',{message:'x'},{'X-Local-Chat':'wrong'})).status,403);
  const foreignHost=await new Promise((resolve,reject)=>{const req=http.get(f.origin+'/api/status',{headers:{Host:'evil.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});assert.equal(foreignHost,403);
  assert.equal((await f.post('new-chat',{client:'../bad'})).status,400);
  const file=await fetch(f.origin+'/app.js');assert.equal(file.status,200);assert.match(file.headers.get('content-security-policy'),/default-src 'self'/);
  assert.equal((await fetch(f.origin+'/server.mjs')).status,404);assert.equal((await fetch(f.origin+'/lib/chat-session.mjs')).status,404);
  assert.equal(f.codex.turns.length,0);
});
test('unconfirmed turn start or lost Codex connection is unknown, never completed',async t=>{
  const f=await setup(t);f.codex.onTurn=()=>{throw new Error('protocol timeout');};
  assert.equal((await f.post('turn',{message:'未知结果'})).status,502);assert.equal(f.app.snapshot('client-a').session.messages[1].status,'unknown');
  f.codex.onTurn=null;await f.post('turn',{message:'连接中断'});f.codex.failed('connection lost');
  const messages=f.app.snapshot('client-a').session.messages;assert.equal(messages.at(-2).status,'unknown');assert.equal(messages.at(-1).role,'error');
});
test('HTTP accepts 16000 Chinese characters and worst-case escaped JSON within the bounded request budget',async t=>{
  const f=await setup(t);const message='汉'.repeat(16000);
  assert.equal((await f.post('turn',{message})).status,202);assert.equal(f.codex.turns[0].text,message);
  const first=f.codex.turns[0];f.codex.notify('turn/completed',first,{turn:{id:first.turnId,status:'completed'}});
  const data=await(await fetch(f.origin+'/api/status')).json();
  const escaped='{"client":"client-a","message":"'+'\\u6c49'.repeat(16000)+'"}';
  const response=await fetch(f.origin+'/api/turn',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':data.csrf},body:escaped});assert.equal(response.status,202);assert.equal(f.codex.turns[1].text,message);
});
test('late thread creation cannot overwrite a new chat or a reconnected context epoch',async t=>{
  for(const action of ['new-chat','reconnect'])await t.test(action,async t=>{
    const f=await setup(t);let resolveOld,entered;
    const deferred=new Promise(resolve=>{resolveOld=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});let calls=0;
    f.codex.newThread=async()=>{if(++calls===1){entered();return deferred;}return 'fresh-thread';};
    const oldRequest=f.post('turn',{message:'旧轮次'});await waiting;
    f.codex.failed('connection lost during thread creation');
    assert.equal((await f.post(action)).status,action==='new-chat'?200:202);
    await new Promise(resolve=>setImmediate(resolve));if(action==='new-chat')await f.codex.start();
    const epoch=f.app.snapshot('client-a').session.contextEpoch;
    assert.equal((await f.post('turn',{message:'新轮次'})).status,202);
    assert.equal(f.codex.turns[0].threadId,'fresh-thread');
    resolveOld('stale-thread');const rejected=await oldRequest;
    assert.equal(rejected.status,503);assert.equal(f.codex.turns.length,1);assert.equal(f.app.snapshot('client-a').session.contextEpoch,epoch);assert.equal(f.app.snapshot('client-a').busy,true);
    const fresh=f.codex.turns[0];f.codex.notify('item/agentMessage/delta',fresh,{itemId:'answer',delta:'新轮次结果'});f.codex.notify('turn/completed',fresh,{turn:{id:fresh.turnId,status:'completed'}});
    assert.equal((await f.post('turn',{message:'继续新会话'})).status,202);
    assert.equal(f.codex.turns[1].threadId,'fresh-thread');assert.equal(calls,2);
    if(action==='new-chat')assert.deepEqual(f.app.snapshot('client-a').session.messages.map(message=>message.text),['新轮次','新轮次结果','继续新会话','']);
  });
});

function contextResult(name,model='A'){
  const document={title:'Model '+model,path:'D:\\samples\\'+model+'.rvt',activeViewId:12,allowedSample:true};
  return name==='revit_workbench_status'?{hostSession:'sample-host',document}:{operation:'get_selection',hostSession:'sample-host',document,value:{total:1,returned:1,truncated:false,items:[{element_id:model==='A'?42:84}]}};
}
function deferred(){let resolve,reject;const promise=new Promise((accept,fail)=>{resolve=accept;reject=fail;});return {promise,resolve,reject};}
async function contextEvent(stream,predicate){while(true){const event=await stream.next();if(event.event==='conversation'&&predicate(event.data.session.context))return event.data;}}

test('failed context refresh clears old model and selection in HTTP, SSE and restored snapshots without erasing tool history',{timeout:10000},async t=>{
  for(const route of ['context','turn'])await t.test(route,async t=>{
    let model='A',failure=null;
    const f=await setup(t,{invokeWorkbench:async name=>{if(failure)throw failure;return contextResult(name,model);}});
    await f.post('turn',{message:'已有的对话',...(route==='turn'?{context:{includeDocument:true,includeSelection:true}}:{})});const previous=f.codex.turns[0];
    f.codex.notify('item/completed',previous,{item:{id:'saved-tool',type:'mcpToolCall',tool:'revit_get_selection',status:'completed',result:{content:[{type:'text',text:'历史回执'}]}}});
    f.codex.notify('item/completed',previous,{item:{id:'saved-answer',type:'agentMessage',text:'已有的结果'}});
    f.codex.notify('turn/completed',previous,{turn:{id:previous.turnId,status:'completed'}});
    const history=f.app.snapshot('client-a').session.messages;
    if(route==='context')assert.equal((await f.post('context',{includeDocument:true,includeSelection:true})).status,200);
    const stream=await f.events(),initial=(await stream.next()).data.session.context;
    assert.equal(initial.document.title,'Model A');assert.deepEqual(initial.selection.elementIds,['42']);assert.ok(initial.capturedAt);
    failure=Object.assign(new Error('Revit 上下文读取失败'),{rpcCode:-32001});
    const failed=await f.post(route,route==='context'?{includeDocument:true,includeSelection:true}:{message:'读取新的上下文',context:{includeDocument:true,includeSelection:true}});
    assert.equal(failed.status,502);
    assert.deepEqual(failed.data.context,{document:null,selection:null,capturedAt:null,error:'Revit 上下文读取失败'});
    assert.equal(failed.data.error,failed.data.context.error);assert.equal(f.codex.turns.length,1);assert.equal(f.codex.threads,1);
    const emitted=await contextEvent(stream,context=>Boolean(context.error));
    assert.deepEqual(emitted.session.context,failed.data.context);
    const reloaded=await f.events(),snapshot=(await reloaded.next()).data;
    assert.deepEqual(snapshot.session.context,failed.data.context);assert.equal(snapshot.busy,false);
    assert.deepEqual(snapshot.session.messages.slice(0,history.length),history);
    if(route==='turn')assert.equal(snapshot.session.messages[history.length+1].status,'failed');
    failure=null;model='B';
    const recovered=await f.post('context',{includeDocument:true,includeSelection:true});assert.equal(recovered.status,200);
    assert.equal(recovered.data.context.document.title,'Model B');assert.deepEqual(recovered.data.context.selection.elementIds,['84']);assert.ok(recovered.data.context.capturedAt);assert.equal(recovered.data.context.error,undefined);
    const recoveryEvent=await contextEvent(stream,context=>context.document?.title==='Model B');assert.deepEqual(recoveryEvent.session.context,recovered.data.context);
    assert.deepEqual(f.app.snapshot('client-a').session.context,recovered.data.context);
  });
});

test('late context success or failure cannot overwrite a new chat or reconnected turn',{timeout:15000},async t=>{
  for(const route of ['context','turn'])for(const action of ['new-chat','reconnect'])for(const outcome of ['success','failure'])await t.test(route+'/'+action+'/'+outcome,async t=>{
    const pending=deferred(),entered=deferred();let paused=false,reads=0,model='A';
    const f=await setup(t,{invokeWorkbench:async name=>{if(paused&&++reads===3){paused=false;entered.resolve();return pending.promise;}return contextResult(name,model);}});
    await f.post('context',{includeDocument:true,includeSelection:true});assert.equal(f.app.snapshot('client-a').session.context.document.title,'Model A');paused=true;
    const request=f.post(route,route==='context'?{includeDocument:true,includeSelection:true}:{message:'旧的上下文请求',context:{includeDocument:true,includeSelection:true}});await entered.promise;
    f.codex.failed('context connection lost');assert.equal(f.app.snapshot('client-a').busy,false);
    const interrupted=f.app.snapshot('client-a').session.context;assert.equal(interrupted.document,null);assert.match(interrupted.error,/context connection lost/);
    model='B';
    assert.equal((await f.post(action)).status,action==='new-chat'?200:202);
    await new Promise(resolve=>setImmediate(resolve));if(action==='new-chat')await f.codex.start();
    assert.equal((await f.post('turn',{message:'新的上下文轮次',context:{includeDocument:true,includeSelection:true}})).status,202);
    const current=f.app.snapshot('client-a');assert.equal(current.session.context.document.title,'Model B');assert.equal(f.codex.turns.length,1);
    if(outcome==='failure')pending.reject(new Error('late stale context failure'));else pending.resolve(contextResult('revit_workbench_status','A'));
    assert.equal((await request).status,503);
    assert.deepEqual(f.app.snapshot('client-a').session,current.session);assert.equal(f.app.snapshot('client-a').busy,true);
    assert.equal(f.codex.turns.length,1);assert.match(f.codex.turns[0].text,/Model B/);assert.doesNotMatch(f.codex.turns[0].text,/Model A|late stale/);
  });
});

test('finishing an invalidated refresh cannot release ownership of a newer pending refresh',{timeout:10000},async t=>{
  const old=deferred(),fresh=deferred(),oldEntered=deferred(),freshEntered=deferred();let reads=0;
  const f=await setup(t,{invokeWorkbench:async name=>{if(++reads===1){oldEntered.resolve();return old.promise;}if(reads===2){freshEntered.resolve();return fresh.promise;}return contextResult(name,'B');}});
  const staleRequest=f.post('context',{includeDocument:true});await oldEntered.promise;
  f.codex.failed('lost connection');await f.post('new-chat');await f.codex.start();
  const freshRequest=f.post('context',{includeDocument:true});await freshEntered.promise;
  old.reject(new Error('late failure'));assert.equal((await staleRequest).status,503);
  assert.equal(f.app.snapshot('client-a').busy,true);assert.equal((await f.post('turn',{message:'不能抢占读取'})).status,409);
  fresh.resolve(contextResult('revit_workbench_status','B'));const restored=await freshRequest;
  assert.equal(restored.status,200);assert.equal(restored.data.context.document.title,'Model B');assert.equal(restored.data.context.error,undefined);assert.equal(f.app.snapshot('client-a').busy,false);
});

test('closing the server invalidates an in-flight refresh and never publishes its late result',{timeout:10000},async t=>{
  const pending=deferred(),entered=deferred();let pause=false;
  const f=await setup(t,{invokeWorkbench:async name=>{if(pause){pause=false;entered.resolve();return pending.promise;}return contextResult(name,'A');}});
  await f.post('context',{includeDocument:true,includeSelection:true});
  pause=true;const request=f.post('context',{includeDocument:true});await entered.promise;
  const closing=f.app.close();const stopped=f.app.snapshot('client-a');
  assert.deepEqual(stopped.session.context,{document:null,selection:null,capturedAt:null,error:'本地服务已停止，上下文读取已中断。'});assert.equal(stopped.busy,false);
  pending.resolve(contextResult('revit_workbench_status','A'));assert.equal((await request).status,503);await closing;
  assert.deepEqual(f.app.snapshot('client-a').session,stopped.session);assert.equal(f.codex.turns.length,0);
});
