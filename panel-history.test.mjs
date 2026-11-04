import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createModelWorkspaceFixture} from './test-support/model-workspace-preview.mjs';

const wait=async(predicate)=>{const until=Date.now()+6000;while(!predicate()){if(Date.now()>until)throw new Error('fixture timeout');await new Promise(resolve=>setTimeout(resolve,10));}};
const fixtureOwners=new Map();
async function temporary(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-panel-history-')),directory=path.join(root,'history'),owners=[];fixtureOwners.set(directory,owners);
  t.after(async()=>{for(const value of owners)await value.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('buildx-panel-history-'));await fs.rm(root,{recursive:true,force:true});fixtureOwners.delete(directory);});return directory;}
async function setup(t,directory,options={}){const value=await createModelWorkspaceFixture({historyDirectory:directory,...options});fixtureOwners.get(directory).push(value);return value;}
async function login(f,email='demo@example.invalid'){
  const result=await f.post('account/sign-in',{email,password:'fixture-password'});assert.equal(result.status,200);return result.cookie;
}
async function ready(f,cookie){assert.equal((await f.confirm(cookie)).status,200);}
async function list(f,cookie,client='model-test-client'){
  const response=await fetch(f.origin+'/api/chats?client='+client,{headers:cookie?{Cookie:cookie}:{}});return {status:response.status,body:await response.json()};
}
const draft=(text='',includeSelection=false)=>({text,includeSelection});
async function savedDraft(f,cookie,id,text='',includeSelection=false){const response=await f.post('chat/draft',{conversationId:id,draft:draft(text,includeSelection)},cookie);assert.equal(response.status,200);}
async function file(directory,id){for(const entry of await fs.readdir(directory,{recursive:true})){if(path.basename(entry)===id+'.jsonl')return path.join(directory,entry);}throw new Error('transcript not found');}
async function complete(f,cookie,message,text){const result=await f.post('turn',{message},cookie);assert.equal(result.status,202);const turn=f.codex.turns.at(-1);f.codex.finish(turn,'completed',text);await wait(()=>!f.app.snapshot('model-test-client').busy);return turn;}

test('new and selected conversations keep their native threads, exact messages and independent drafts',async t=>{
  const directory=await temporary(t),f=await setup(t,directory),cookie=await login(f);await ready(f,cookie);
  const stream=await f.events(cookie);const initial=(await stream.next()).data.session,a=initial.conversation.id;
  const first=await complete(f,cookie,'A：引用 [原文](D:/资料/说明.md)','A 的回复');
  await savedDraft(f,cookie,a,'A 草稿',true);
  const original=await fs.readFile(await file(directory,a));
  const created=await f.post('new-chat',{draft:draft('A 草稿',true)},cookie);assert.equal(created.status,200);
  const b=created.body.session.conversation.id;assert.notEqual(a,b);assert.equal(created.body.draft.text,'');
  const second=await complete(f,cookie,'B：独立问题','B 的回复');assert.notEqual(first.threadId,second.threadId);
  await savedDraft(f,cookie,b,'B 草稿');
  const selected=await f.post('chat/select',{conversationId:a,draft:draft('B 草稿')},cookie);assert.equal(selected.status,200);
  assert.equal(selected.body.session.conversation.id,a);assert.equal(selected.body.session.conversation.threadBinding.threadId,first.threadId);
  assert.deepEqual(selected.body.draft,draft('A 草稿',true));
  assert.deepEqual(selected.body.session.messages.map(message=>message.text),['A：引用 [原文](D:/资料/说明.md)','A 的回复']);
  const third=await complete(f,cookie,'A 的后续问题','A 的后续回复');assert.equal(third.threadId,first.threadId);
  const roster=await list(f,cookie);assert.equal(roster.status,200);assert.ok(roster.body.sessions.some(item=>item.id===a));assert.ok(roster.body.sessions.some(item=>item.id===b));
  const later=await fs.readFile(await file(directory,a));assert.ok(later.subarray(0,original.length).equals(original));
  assert.equal(f.codex.threads,2);assert.equal(f.workbenchCalls.length,0);
});

test('normal close/reopen lists saved history without rewriting it or pretending an ephemeral native thread resumed',async t=>{
  const directory=await temporary(t),first=await setup(t,directory),cookie=await login(first);await ready(first,cookie);
  await list(first,cookie);const id=first.app.snapshot('model-test-client').session.conversation.id;
  await complete(first,cookie,'原问题：保留引用 [资料](D:/reference.md)','原回复');await savedDraft(first,cookie,id,'未提交草稿',true);
  const filename=await file(directory,id),before=await fs.readFile(filename);await first.close();
  const reopened=await setup(t,directory),newCookie=await login(reopened),roster=await list(reopened,newCookie);
  assert.ok(roster.body.sessions.some(item=>item.id===id));
  const selected=await reopened.post('chat/select',{conversationId:id,draft:draft()},newCookie);assert.equal(selected.status,200);
  assert.equal(selected.body.session.conversation.readOnly,true);assert.equal(selected.body.session.conversation.threadBinding.threadId,null);
  assert.equal(selected.body.session.conversation.threadBinding.persistedResumeVerified,false);
  assert.deepEqual(selected.body.draft,draft('未提交草稿',true));
  assert.equal((await reopened.post('chat/draft',{conversationId:id,draft:draft('不能伪称保存')},newCookie)).status,409);
  assert.deepEqual(selected.body.session.messages.map(message=>message.text),['原问题：保留引用 [资料](D:/reference.md)','原回复']);
  await ready(reopened,newCookie);
  assert.equal((await reopened.post('turn',{message:'不能伪装续聊'},newCookie)).status,409);
  assert.equal(reopened.codex.turns.length,0);assert.equal(reopened.codex.threads,0);
  const created=await reopened.post('new-chat',{draft:draft()},newCookie);assert.equal(created.status,200);
  assert.notEqual(created.body.session.conversation.id,id);assert.notEqual(created.body.session.conversation.readOnly,true);
  assert.ok((await fs.readFile(filename)).equals(before));
});

test('history requires the actual account partition, CSRF and idle selection; late events never follow a switched view',async t=>{
  const directory=await temporary(t),f=await setup(t,directory);
  assert.equal((await list(f)).status,401);assert.equal((await f.post('chat/select',{conversationId:'foreign',draft:draft()})).status,401);
  const cookie=await login(f);await ready(f,cookie);await list(f,cookie);
  const a=f.app.snapshot('model-test-client').session.conversation.id;
  await complete(f,cookie,'用户 A 的记录','用户 A 的回复');await savedDraft(f,cookie,a);
  const created=await f.post('new-chat',{draft:draft()},cookie),b=created.body.session.conversation.id;
  await f.post('turn',{message:'正在执行'},cookie);const active=f.codex.turns.at(-1);
  assert.equal((await f.post('chat/select',{conversationId:a,draft:draft()},cookie)).status,409);
  assert.equal(f.app.snapshot('model-test-client').session.conversation.id,b);
  await f.post('interrupt',{},cookie);f.codex.finish(active,'interrupted','');await savedDraft(f,cookie,b);
  assert.equal((await f.post('chat/select',{conversationId:a,draft:draft()},cookie,{'X-Local-Chat':'wrong'})).status,403);
  const selected=await f.post('chat/select',{conversationId:a,draft:draft()},cookie);assert.equal(selected.status,200);
  f.codex.notify('item/agentMessage/delta',active,{itemId:'late',delta:'旧轮次污染'});
  assert.doesNotMatch(JSON.stringify(f.app.snapshot('model-test-client').session),/旧轮次污染/);
  assert.equal((await f.post('account/sign-out',{},cookie)).status,200);
  const otherCookie=await login(f,'other@example.invalid'),other=await list(f,otherCookie);
  assert.ok(!other.body.sessions.some(item=>item.id===a||item.id===b));
  assert.notEqual((await f.post('chat/select',{conversationId:a,draft:draft()},otherCookie)).status,200);
  assert.equal(f.workbenchCalls.length,0);
});

test('read-only history restoration preserves quoted references and blocks begin/context mutation',()=>{
  // Parsed production views are the only restoration input; their native IDs
  // remain evidence and are never rebound to a newly constructed owner.
  return import('./lib/chat-session.mjs').then(({ChatSession})=>{
    const live=new ChatSession(),run=live.begin('原文');live.bindThread(run,'opaque-native-id');run.turnId='opaque-turn';
    live.messages[0].references=[{path:'说明.md',text:'原始引用内容'}];live.finish(run,'completed');const snapshot=live.view();
    const restored=new ChatSession();restored.restoreHistory(snapshot);snapshot.messages[0].references[0].text='外部后来修改';
    assert.equal(restored.view().messages[0].references[0].text,'原始引用内容');assert.equal(restored.threadId,null);
    assert.throws(()=>restored.begin('伪装继续'),/新建/);const before=restored.view();restored.resetContext();assert.deepEqual(restored.view(),before);
  });
});

test('manual context preview is never rebound to the preceding sent message when a later draft is saved',async t=>{
  const directory=await temporary(t),f=await setup(t,directory),cookie=await login(f);await ready(f,cookie);await list(f,cookie);
  const id=f.app.snapshot('model-test-client').session.conversation.id;
  f.setDocument({title:'模型 A',path:'D:\\samples\\a.rvt',activeViewId:1},[42]);
  assert.equal((await f.post('turn',{message:'A 的问题',context:{includeDocument:true,includeSelection:false}},cookie)).status,202);
  f.codex.finish(0,'completed','A 的回复');await savedDraft(f,cookie,id);
  const userId=f.app.snapshot('model-test-client').session.messages[0].id,filename=await file(directory,id),before=await fs.readFile(filename);
  f.setDocument({title:'模型 B',path:'D:\\samples\\b.rvt',activeViewId:2},[84]);
  assert.equal((await f.post('context',{includeDocument:true,includeSelection:false},cookie)).status,200);
  assert.equal(f.app.snapshot('model-test-client').session.contextMessageId,null);
  await savedDraft(f,cookie,id,'尚未发送的问题');
  const bytes=await fs.readFile(filename),events=bytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  assert.ok(bytes.subarray(0,before.length).equals(before));
  const states=events.filter(event=>['conversation.created','state.recorded'].includes(event.type)).map(event=>event.payload);
  assert.ok(states.some(state=>state.context.document?.title==='模型 A'&&state.contextMessageId===userId));
  assert.ok(states.some(state=>state.context.document?.title==='模型 B'&&state.contextMessageId===null));
  assert.ok(!states.some(state=>state.context.document?.title==='模型 B'&&state.contextMessageId===userId));
});

test('message and independent draft each retain the 16000-character budget under worst-case JSON escaping',async t=>{
  const directory=await temporary(t),f=await setup(t,directory),cookie=await login(f);await ready(f,cookie);await list(f,cookie);
  const id=f.app.snapshot('model-test-client').session.conversation.id,escaped='\\u6c49'.repeat(16000);
  const body='{"client":"model-test-client","message":"'+escaped+'","draft":{"text":"'+escaped+'","includeSelection":false}}';
  assert.ok(Buffer.byteLength(body)>128*1024);assert.ok(Buffer.byteLength(body)<256*1024);
  const response=await fetch(f.origin+'/api/turn',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json','X-Local-Chat':f.initial.csrf,Cookie:cookie},body});
  assert.equal(response.status,202);assert.equal(f.codex.turns[0].text,'汉'.repeat(16000));
  f.codex.finish(0,'completed','完成');await savedDraft(f,cookie,id,'汉'.repeat(16000));
  const stored=await f.historyStore.get('model:user:11111111-1111-1111-1111-111111111111',id);
  assert.equal(stored.ok,true);assert.equal(stored.draft.text,'汉'.repeat(16000));
});

test('a full transcript allows a new conversation while retaining the unsaved owner and original committed bytes',async t=>{
  const directory=await temporary(t),f=await setup(t,directory,{historyOptions:{maxFileBytes:12*1024}}),cookie=await login(f);await ready(f,cookie);await list(f,cookie);
  const a=f.app.snapshot('model-test-client').session.conversation.id;
  await complete(f,cookie,'原先已保存的问题','原先已保存的回复');await savedDraft(f,cookie,a);
  const filename=await file(directory,a),before=await fs.readFile(filename);
  const failed=await f.post('turn',{message:'x'.repeat(16000)},cookie);assert.equal(failed.status,502);
  await wait(()=>f.app.snapshot('model-test-client').session.conversation.persistence.status==='failed');
  assert.equal(f.codex.turns.length,1);assert.ok((await fs.readFile(filename)).equals(before));
  const created=await f.post('new-chat',{draft:draft()},cookie);assert.equal(created.status,200);
  assert.notEqual(created.body.session.conversation.id,a);
  const selected=await f.post('chat/select',{conversationId:a,draft:draft()},cookie);assert.equal(selected.status,200);
  assert.equal(selected.body.session.conversation.persistence.status,'failed');
  assert.ok(selected.body.session.messages.some(message=>message.text==='x'.repeat(16000)));
  assert.ok((await fs.readFile(filename)).equals(before));assert.equal(f.codex.turns.length,1);
});
