import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from '../lib/panel-server.mjs';
import {SOURCE_TOOLS} from '../lib/source-tools.mjs';
import {panelProfile} from '../lib/panel-profile.mjs';

const root=path.resolve(fileURLToPath(new URL("../", import.meta.url)));
class FakeCodex extends EventEmitter{
  constructor(profile='source-development'){
    super();this.state={ready:true,error:false,message:'fixture ready',mode:profile==='model'?'document-workbench':profile,
      toolCount:profile==='model'?37:6};this.turns=[];this.threads=0;this.closes=0;this.interrupts=[];
  }
  async start(){this.state={...this.state,ready:true,error:false};this.emit('state',this.state);}
  async close(){this.closes++;return {closed:true};}
  failed(message){this.state={...this.state,error:true,ready:false,message};this.emit('state',this.state);}
  async newThread(){return 'source-thread-'+(++this.threads);}
  async turn(threadId,text){const value={threadId,text,turnId:'source-turn-'+(this.turns.length+1)};this.turns.push(value);await this.onTurn?.(value);return {turn:{id:value.turnId}};}
  async interrupt(threadId,turnId){this.interrupts.push({threadId,turnId});}
  notify(method,turn,params={}){this.emit('notification',method,{threadId:turn.threadId,turnId:turn.turnId,...params});}
}
async function fixture(t,profile='source-development'){
  const codex=new FakeCodex(profile),workbenchCalls=[];
  const app=createPanelServer({root,codex,profile,port:0,invokeWorkbench:async(...args)=>{workbenchCalls.push(args);throw new Error('Revit must not be called');}});
  const {origin}=await app.listen(),status=await(await fetch(origin+'/api/status')).json(),aborters=[];
  t.after(async()=>{for(const controller of aborters)controller.abort();await app.close();});
  const post=async(route,data={})=>{
    const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':status.csrf},body:JSON.stringify({client:'source-client',...data})});
    return {status:response.status,body:await response.json()};
  };
  async function events(){
    const controller=new AbortController();aborters.push(controller);
    const response=await fetch(origin+'/api/events?client=source-client',{signal:controller.signal}),reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    return {async next(){for(;;){const split=buffer.indexOf('\n\n');if(split!==-1){const frame=buffer.slice(0,split);buffer=buffer.slice(split+2);if(!frame.startsWith('event: '))continue;return {event:frame.slice(7,frame.indexOf('\n')),data:JSON.parse(frame.slice(frame.indexOf('data: ')+6))};}const chunk=await reader.read();if(chunk.done)throw new Error('SSE ended');buffer+=decoder.decode(chunk.value,{stream:true});}}};
  }
  return {app,codex,origin,status,post,events,workbenchCalls};
}
function complete(codex,turn,text='source result'){
  codex.notify('item/completed',turn,{item:{id:'answer',type:'agentMessage',text}});
  codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'completed'}});
}

test('source profile advertises exactly six read-only tools and profile identity over HTTP and SSE',async t=>{
  const f=await fixture(t),stream=await f.events(),snapshot=(await stream.next()).data;
  const expected={kind:'source-development',supportsModelContext:false};
  assert.deepEqual(f.status.workspace,expected);assert.deepEqual(snapshot.workspace,expected);assert.deepEqual(snapshot.state.workspace,expected);
  assert.equal(f.status.toolCount,6);assert.deepEqual(f.status.toolCatalog.map(t=>t.name),SOURCE_TOOLS.map(t=>t.name));
  assert.ok(f.status.toolCatalog.every(t=>t.readOnly));assert.doesNotMatch(JSON.stringify(f.status.toolCatalog),/revit_health|revit_execute_csharp/);
});

test('source context endpoints and forged model flags are rejected before history, thread, turn or Revit',async t=>{
  const f=await fixture(t);
  for(const value of [{},{includeDocument:true},{includeSelection:true}])assert.equal((await f.post('context',value)).status,403);
  for(const context of [{includeDocument:true},{includeSelection:true},{includeDocument:true,includeSelection:true}]){
    assert.equal((await f.post('turn',{message:'forged context',context})).status,403);
  }
  assert.equal(f.codex.threads,0);assert.equal(f.codex.turns.length,0);assert.equal(f.workbenchCalls.length,0);
  assert.deepEqual(f.app.snapshot('source-client').session.messages,[]);
  assert.equal((await f.post('turn',{message:'ordinary source conversation',context:{includeDocument:false,includeSelection:false}})).status,202);
  assert.equal(f.codex.turns[0].text,'ordinary source conversation');assert.equal(f.workbenchCalls.length,0);
});

test('source HTTP/SSE reuses exact ownership, source labels, bounded cards, multi-turn history and reload',async t=>{
  const f=await fixture(t);
  f.codex.onTurn=turn=>{
    f.codex.notify('item/completed',turn,{turnId:'foreign',item:{id:'wrong',type:'agentMessage',text:'foreign contamination'}});
    f.codex.notify('item/completed',turn,{item:{id:'source-call',type:'mcpToolCall',tool:'buildx_source_read_file',status:'completed',
      arguments:{rootId:'argus-source',path:'Example.cs'},result:{content:[{type:'text',text:JSON.stringify({ok:true,value:{sha256:'a'.repeat(64),completeness:'partial',lines:[]}})}]}}});
    complete(f.codex,turn,'SHA verified; partial');
  };
  assert.equal((await f.post('turn',{message:'read source'})).status,202);
  assert.equal((await f.post('turn',{message:'next source question'})).status,202);
  const snapshot=(await(await f.events()).next()).data;
  assert.equal(snapshot.busy,false);assert.equal(f.codex.threads,1);assert.equal(snapshot.session.messages.length,4);
  assert.equal(snapshot.session.messages[1].tools[0].label,'读取源码页');
  assert.equal(snapshot.session.messages[1].tools[0].status,'returned');
  assert.match(snapshot.session.messages[1].tools[0].resultPreview,/partial/);
  assert.doesNotMatch(JSON.stringify(snapshot),/foreign contamination/);assert.equal(f.workbenchCalls.length,0);
});

test('new source chat and reconnect preserve profile while clearing AI context independently',async t=>{
  const f=await fixture(t);await f.post('turn',{message:'source question'});complete(f.codex,f.codex.turns[0]);
  assert.equal((await f.post('reconnect')).status,202);await new Promise(resolve=>setImmediate(resolve));
  const after=f.app.snapshot('source-client');assert.equal(after.workspace.supportsModelContext,false);assert.equal(after.session.contextEpoch,1);
  assert.match(after.session.messages.at(-1).text,/源码/);assert.doesNotMatch(after.session.messages.at(-1).text,/重新核对模型/);
  assert.equal((await f.post('new-chat')).status,200);assert.deepEqual(f.app.snapshot('source-client').session.messages,[]);
  assert.equal((await f.post('turn',{message:'fresh source question'})).status,202);assert.equal(f.codex.threads,2);assert.equal(f.workbenchCalls.length,0);
});

test('source stop keeps pending reads unknown and uses source-specific notices',async t=>{
  const f=await fixture(t);await f.post('turn',{message:'long source read'});const turn=f.codex.turns[0];
  f.codex.notify('item/started',turn,{item:{id:'pending',type:'mcpToolCall',tool:'buildx_source_read_file'}});
  assert.equal((await f.post('interrupt')).status,202);await new Promise(resolve=>setImmediate(resolve));
  f.codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'interrupted'}});
  const view=f.app.snapshot('source-client');assert.equal(view.session.messages[1].tools[0].status,'unknown');
  assert.match(view.session.messages[1].tools[0].error,/源码/);assert.equal(f.codex.interrupts.length,1);assert.equal(view.busy,false);
  assert.match(view.session.messages.at(-1).text,/不会操作Revit模型/);
});

test('fixed server profiles reject source/model client mismatch and cannot be selected by HTTP arguments',async t=>{
  assert.throws(()=>createPanelServer({root,codex:new FakeCodex('model'),profile:'source-development',port:0}),/source-only/);
  assert.throws(()=>createPanelServer({root,codex:new FakeCodex(),profile:'model',invokeWorkbench:async()=>{},port:0}),/model-only/);
  assert.throws(()=>createPanelServer({root,codex:new FakeCodex('unknown'),profile:'model',invokeWorkbench:async()=>{},port:0}),/model-only/);
  assert.throws(()=>createPanelServer({root,codex:new FakeCodex(),profile:'anything',port:0}),/Unknown panel profile/);
  const f=await fixture(t);await f.post('turn',{message:'source only',profile:'model',workspace:{kind:'model'}});
  assert.deepEqual(f.app.snapshot('source-client').workspace,{kind:'source-development',supportsModelContext:false});
  assert.equal(f.status.toolCatalog.length,6);assert.equal(f.workbenchCalls.length,0);
});

test('both server profiles own frozen catalog copies so labels and visible tool contracts cannot drift',()=>{
  for(const kind of ['model','source-development']){
    const selected=panelProfile(kind),length=selected.catalog.length,first=selected.catalog[0].readOnly;
    assert.throws(()=>selected.catalog.push({name:'unexpected'}),TypeError);
    assert.throws(()=>{selected.catalog[0].readOnly=!first;},TypeError);
    assert.equal(panelProfile(kind).catalog.length,length);assert.equal(panelProfile(kind).catalog[0].readOnly,first);
    assert.throws(()=>{selected.workspace.kind='anything';},TypeError);
  }
});

test('default model HTTP profile keeps its model tool catalog and original context behavior',async t=>{
  const codex=new FakeCodex('model'),calls=[];
  const app=createPanelServer({root,codex,port:0,invokeWorkbench:async(name)=>{calls.push(name);return {hostSession:'fake',document:{title:'sample',path:'D:\\sample.rvt'}};}});
  const {origin}=await app.listen();t.after(()=>app.close());
  const status=await(await fetch(origin+'/api/status')).json();
  assert.deepEqual(status.workspace,{kind:'model',supportsModelContext:true});assert.equal(status.toolCatalog.length,37);
  const response=await fetch(origin+'/api/context',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':status.csrf},body:JSON.stringify({client:'model-client',includeDocument:true})});
  assert.equal(response.status,200);assert.equal((await response.json()).context.document.title,'sample');assert.equal(calls.length,2);
});
