import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createReadCommandFixture} from './test-support/read-command-host.mjs';
import {createModelWorkspaceFixture} from './test-support/model-workspace-preview.mjs';

const evidence=fileURLToPath(new URL('./workbench/validation/20261026-command-page/',import.meta.url));
async function wait(predicate){const end=Date.now()+6000;while(!await predicate()){if(Date.now()>end)throw new Error('command fixture deadline');await new Promise(resolve=>setTimeout(resolve,10));}}
async function make(t,options={}){const f=await createReadCommandFixture({directory:evidence,...options});t.after(()=>f.close());return f;}
async function login(f){const response=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'});assert.equal(response.status,200);return response.cookie;}
async function ready(f){const cookie=await login(f);assert.equal((await f.confirm(cookie)).status,200);const events=await f.events(cookie);const initial=(await events.next()).data;return {cookie,events,id:initial.session.conversation.id};}
const state=f=>f.app.snapshot('model-test-client');
async function command(f,cookie,id,commandId,parameters={}){return f.post('command',{conversationId:id,commandId,parameters},cookie);}
async function terminal(f,executionId){await wait(()=>{const value=state(f).command;return value?.executionId===executionId&&!['running','stopping'].includes(value.status);});return state(f).command;}
async function savedFile(f,id){const directory=path.join(f.queueRoot,'history');for(const name of await fs.readdir(directory,{recursive:true}))if(name.endsWith(id+'.jsonl'))return path.join(directory,name);throw new Error('saved record not found');}

test('four command intents cross production HTTP/SSE and native queue without invoking Codex',async t=>{
  const f=await make(t),{cookie,events,id}=await ready(f),status=await f.status(cookie);
  assert.equal(status.directCommandsAvailable,true);
  for(const [commandId,tool] of [['document','revit_workbench_status'],['selection','revit_get_selection'],['levels','revit_list_levels'],['search','revit_search_elements']]){
    const response=await command(f,cookie,id,commandId,commandId==='search'?{keyword:'',category:'pipes'}:{});assert.equal(response.status,202,JSON.stringify(response.body));
    assert.equal(typeof response.body.executionId,'string');assert.ok(!response.body.result);
    const outcome=await terminal(f,response.body.executionId);assert.equal(outcome.status,'completed',JSON.stringify(outcome));assert.equal(outcome.commandId,commandId);
    assert.equal(outcome.result.tool,tool);assert.equal(outcome.result.document.title,'命令样例');
    assert.ok(outcome.result.requestIds.length>=2);assert.equal(state(f).busy,false);
  }
  const search=state(f).command.result;assert.equal(search.data.total,1);assert.equal(search.data.items[0].name,'管道-02');
  assert.equal(f.queueRequests.at(-2).args.category,'OST_PipeCurves');assert.equal(f.queueRequests.at(-2).args.limit,20);
  assert.equal(f.codex.turns.length,0);assert.equal(f.codex.threads,0);assert.equal(f.codex.interrupts.length,0);
  assert.equal(f.workbenchCalls.length,0);assert.deepEqual(state(f).session.messages,[]);assert.equal(state(f).session.context.capturedAt,null);
  assert.ok(f.queueRequests.every(item=>['status','get_selection','list_levels','search_elements'].includes(item.operation)));
  const completed=[];while(completed.length<4){const item=await events.next();if(item.data.command?.status==='completed'&&!completed.includes(item.data.command.executionId))completed.push(item.data.command.executionId);}
});

test('new endpoint retains authentication, explicit confirmation, CSRF and origin checks',async t=>{
  const f=await make(t);
  assert.equal((await f.post('command',{conversationId:'absent',commandId:'document',parameters:{}})).status,401);
  const cookie=await login(f),stream=await f.events(cookie),id=(await stream.next()).data.session.conversation.id;
  assert.equal((await command(f,cookie,id,'document')).status,403);
  assert.equal((await f.confirm(cookie)).status,200);
  for(const headers of [{'X-Local-Chat':'forged'},{Origin:'https://foreign.invalid'}]){
    assert.equal((await f.post('command',{conversationId:id,commandId:'document',parameters:{}},cookie,headers)).status,403);
  }
  assert.equal(f.queueRequests.length,0);assert.equal(f.codex.turns.length,0);
});

test('outer command identity rejects wrong conversations, arbitrary executors and paths',async t=>{
  const f=await make(t),{cookie,id}=await ready(f);
  for(const body of [
    {conversationId:'wrong',commandId:'document',parameters:{}},
    {commandId:'document',parameters:{}},
    {conversationId:id,commandId:'revit_execute_csharp',parameters:{}},
    {conversationId:id,commandId:'document',parameters:{},code:'return doc.Delete(1);'},
    {conversationId:id,commandId:'document',parameters:{},root:'D:\\foreign'},
  ]){const response=await f.post('command',body,cookie);assert.ok([400,409].includes(response.status),JSON.stringify(response));}
  assert.equal(f.queueRequests.length,0);
});

test('parameter failures produce no native request and cannot escape the fixed contract',async t=>{
  const f=await make(t),{cookie,id}=await ready(f);
  for(const [commandId,parameters] of [['selection',{expected_document:'D:\\forged.rvt'}],['search',{keyword:'x'.repeat(201)}],['search',{category:'OST_Walls'}],['search',{limit:201}],['search',{offset:-1}],['levels',{mode:'commit'}]]){
    const response=await command(f,cookie,id,commandId,parameters);
    if(response.status===202){const outcome=await terminal(f,response.body.executionId);assert.equal(outcome.status,'failed');assert.equal(outcome.error.code,'COMMAND_INPUT_INVALID');}
    else assert.equal(response.status,400);
    assert.equal(f.queueRequests.length,0);assert.equal(state(f).busy,false);
  }
});

test('a pending command blocks duplicate starts, dialogue, session controls and account mutation',async t=>{
  const f=await make(t),{cookie,id}=await ready(f);f.hold('status');
  const started=await command(f,cookie,id,'selection');assert.equal(started.status,202);await wait(()=>f.queuePending.length===1);
  for(const [route,input] of [['command',{conversationId:id,commandId:'levels',parameters:{}}],['turn',{message:'must not run'}],['new-chat',{}],['context',{includeDocument:true}],['reconnect',{}],['account/sign-out',{}],['codex-account/inspect',{}]]){
    assert.equal((await f.post(route,input,cookie)).status,409,route);
  }
  assert.equal((await f.post('interrupt',{executionId:'stale',conversationId:id},cookie)).status,409);assert.equal(state(f).command.status,'running');
  assert.equal((await f.post('interrupt',{},cookie)).status,409);
  await f.release();assert.equal((await terminal(f,started.body.executionId)).status,'completed');
  assert.equal(f.codex.turns.length,0);assert.equal(f.codex.interrupts.length,0);
});

test('stop before business read preserves busy until status settles and queues no following read',async t=>{
  const f=await make(t),{cookie,id}=await ready(f);f.hold('status');
  const started=await command(f,cookie,id,'selection');await wait(()=>f.queuePending.length===1);
  assert.equal((await f.post('interrupt',{executionId:started.body.executionId,conversationId:id},cookie)).status,202);
  assert.equal(state(f).command.status,'stopping');assert.equal(state(f).busy,true);
  await f.release();const outcome=await terminal(f,started.body.executionId);
  assert.equal(outcome.status,'interrupted');assert.ok(!outcome.result);assert.equal(state(f).busy,false);
  assert.deepEqual(f.queueRequests.map(item=>item.operation),['status']);assert.equal(f.codex.interrupts.length,0);
});

test('stop during an enqueued business read retains ownership and does not claim host cancellation',async t=>{
  const f=await make(t),{cookie,id}=await ready(f);f.hold('list_levels');
  const started=await command(f,cookie,id,'levels');await wait(()=>f.queuePending.length===1);
  await f.post('interrupt',{executionId:started.body.executionId,conversationId:id},cookie);
  assert.equal(state(f).busy,true);assert.equal(state(f).command.status,'stopping');
  assert.equal((await command(f,cookie,id,'document')).status,409);
  await f.release();const outcome=await terminal(f,started.body.executionId);
  assert.equal(outcome.status,'unknown');assert.ok(!outcome.result);assert.equal(outcome.cancelRequested,true);
  assert.deepEqual(f.queueRequests.map(item=>item.operation),['status','list_levels']);assert.equal(f.codex.interrupts.length,0);
});

test('stop after final status was enqueued preserves completed evidence when all receipts arrive',async t=>{
  const f=await make(t),{cookie,id}=await ready(f);f.hold('status',2);
  const started=await command(f,cookie,id,'selection');await wait(()=>f.queuePending.length===1);
  assert.deepEqual(f.queueRequests.map(item=>item.operation),['status','get_selection','status']);
  await f.post('interrupt',{executionId:started.body.executionId,conversationId:id},cookie);assert.equal(state(f).busy,true);
  await f.release();const outcome=await terminal(f,started.body.executionId);
  assert.equal(outcome.status,'completed');assert.equal(outcome.cancelRequested,true);assert.equal(outcome.result.requestIds.length,3);
});

test('timeouts and malformed receipts stay unknown without automatic replay',async t=>{
  for(const mode of ['timeout','malformed','document-changed','malformed-failure'])await t.test(mode,async t=>{
    const f=await make(t),{cookie,id}=await ready(f);f.setMode(mode);
    const started=await command(f,cookie,id,'selection'),outcome=await terminal(f,started.body.executionId);
    assert.equal(outcome.status,'unknown',JSON.stringify(outcome));assert.ok(!outcome.result);assert.ok(outcome.error?.message);
    const count=f.queueRequests.length;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.queueRequests.length,count);
    assert.equal(state(f).busy,false);assert.equal(f.codex.turns.length,0);assert.equal(f.codex.interrupts.length,0);
  });
});

test('no-document and empty-selection states do not invent model data',async t=>{
  const f=await make(t),{cookie,id}=await ready(f);f.setNativeDocument(null);
  const noDocument=await command(f,cookie,id,'document'),failed=await terminal(f,noDocument.body.executionId);
  assert.equal(failed.status,'failed');assert.match(failed.error.message,/打开.*模型|没有.*文档|无.*文档/);assert.ok(!failed.result);assert.equal(f.queueRequests.length,1);
  f.setNativeDocument({title:'空选择项目',path:'',activeViewId:12,activeViewType:'FloorPlan'});f.setMode('empty-selection');
  const empty=await command(f,cookie,id,'selection'),outcome=await terminal(f,empty.body.executionId);
  assert.equal(outcome.status,'completed');assert.equal(outcome.result.data.total,0);assert.deepEqual(outcome.result.data.items,[]);assert.equal(outcome.result.document.path,'');
});

test('command execution never changes existing conversation, context, thread, draft or JSONL references',async t=>{
  const f=await make(t),{cookie,id}=await ready(f);
  const sent=await f.post('turn',{message:'已有引用 [资料](D:/reference.md)'},cookie);assert.equal(sent.status,202);
  f.codex.finish(0,'completed','已有回复');await wait(()=>!state(f).busy);
  assert.equal((await f.post('chat/draft',{conversationId:id,draft:{text:'保留草稿',includeSelection:true}},cookie)).status,200);
  const before=state(f).session,filename=await savedFile(f,id),bytes=await fs.readFile(filename);
  const started=await command(f,cookie,id,'levels');await terminal(f,started.body.executionId);
  assert.deepEqual(state(f).session,before);assert.deepEqual(state(f).draft,{text:'保留草稿',includeSelection:true});
  assert.ok((await fs.readFile(filename)).equals(bytes));assert.equal(f.codex.turns.length,1);assert.equal(f.codex.threads,1);
});

test('identity invalidation withdraws results but retains active ownership until an issued read settles',async t=>{
  const f=await make(t),{cookie,id}=await ready(f);f.hold('get_selection');
  const started=await command(f,cookie,id,'selection');await wait(()=>f.queuePending.length===1);
  f.codex.emit('account-invalidated',{connectionGeneration:f.codex.state.connectionGeneration});
  assert.equal(state(f).busy,true);assert.equal(state(f).command??null,null);
  await f.release();await wait(()=>!state(f).busy);
  assert.equal(state(f).command??null,null);assert.deepEqual(state(f).session.messages,[]);assert.equal(f.codex.interrupts.length,0);
  assert.equal((await f.status(cookie)).busy,false);assert.equal(started.status,202);
});

test('close waits for an owned native command instead of dropping its pending work',async t=>{
  const f=await make(t),{cookie,id}=await ready(f);f.hold('get_selection');
  await command(f,cookie,id,'selection');await wait(()=>f.queuePending.length===1);
  let closed=false;const closing=f.app.close().then(result=>{closed=true;return result;});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(closed,false);
  await f.release();assert.deepEqual(await closing,{closed:true});assert.equal(state(f).command??null,null);assert.equal(f.codex.interrupts.length,0);
});

test('historical readonly conversations and failed local saves cannot start commands',async t=>{
  const first=await make(t),{cookie,id}=await ready(first);
  assert.equal((await first.post('chat/draft',{conversationId:id,draft:{text:'保存的引用草稿',includeSelection:false}},cookie)).status,200);
  const historyDirectory=path.join(first.queueRoot,'history');await first.close();
  const reopened=await make(t,{historyDirectory}),other=await ready(reopened);
  const selected=await reopened.post('chat/select',{conversationId:id,draft:{text:'',includeSelection:false}},other.cookie);assert.equal(selected.status,200);assert.equal(selected.body.session.conversation.readOnly,true);
  assert.equal((await command(reopened,other.cookie,id,'levels')).status,409);assert.equal(reopened.queueRequests.length,0);
  const failed=await make(t,{historyOptions:{maxFileBytes:500}}),third=await ready(failed);
  assert.equal((await failed.post('chat/draft',{conversationId:third.id,draft:{text:'x'.repeat(3000),includeSelection:false}},third.cookie)).status,503);
  assert.equal((await command(failed,third.cookie,third.id,'levels')).status,503);assert.equal(failed.queueRequests.length,0);
});

test('source and zero-tool customer profiles expose no direct command route',async t=>{
  for(const profile of ['source-development','customer-chat'])await t.test(profile,async t=>{
    const f=await createModelWorkspaceFixture({profile,required:profile==='customer-chat'});t.after(()=>f.close());
    const cookie=profile==='customer-chat'?await login(f):undefined;
    const response=await f.post('command',{conversationId:'none',commandId:'document',parameters:{}},cookie);
    assert.equal(response.status,404);assert.notEqual((await f.status(cookie)).directCommandsAvailable,true);
    assert.equal(f.workbenchCalls.length,0);assert.equal(f.codex.turns.length,0);
  });
});
