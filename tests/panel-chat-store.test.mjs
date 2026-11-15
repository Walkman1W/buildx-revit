import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {ChatSession} from '../lib/chat-session.mjs';
import {createChatStore,createPanelChatStore} from '../lib/chat-store.mjs';

const scope='model:user:storage-fixture';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t,options={},dependencies){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-panel-history-'));
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));
  const stateDirectory=path.join(temporary,'history'),stores=[];
  const make=()=>{const store=createPanelChatStore({stateDirectory,...options},dependencies);stores.push(store);return store;};
  const store=make();
  t.after(async()=>{for(const owner of stores){let closed=await owner.close();if(!closed.ok&&closed.error.cleanupId){await owner.cleanup(closed.error.cleanupId);closed=await owner.close();}assert.equal(closed.ok,true);}const target=path.resolve(temporary);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep));assert.equal((await fs.lstat(target)).isSymbolicLink(),false);const real=await fs.realpath(target);assert.equal(process.platform==='win32'?real.toLowerCase():real,process.platform==='win32'?target.toLowerCase():target);await fs.rm(target,{recursive:true,force:true});});
  return {temporary,stateDirectory,store,make,file:(id,partition=scope)=>path.join(stateDirectory,hash(partition),id+'.jsonl')};
}
function conversation(text='第一条问题'){
  const session=new ChatSession();session.add('user',text);session.add('assistant','真实回复');return session;
}

test('production JSONL is partitioned, append-only, idempotent and survives an owned close/reopen',async t=>{
  const f=await fixture(t),session=conversation(),id=session.conversationId;
  assert.equal((await f.store.ready()).ok,true);
  assert.equal((await f.store.save(scope,session.view(),{text:'下一条草稿',includeSelection:true})).ok,true);
  const first=await fs.readFile(f.file(id));
  assert.equal((await f.store.save(scope,session.view())).changed,false);assert.deepEqual(await fs.readFile(f.file(id)),first);
  session.add('user','第二轮');session.add('assistant','第二轮回复');assert.equal((await f.store.save(scope,session.view())).ok,true);
  const bytes=await fs.readFile(f.file(id));assert.ok(bytes.subarray(0,first.length).equals(first));
  const events=bytes.toString().trimEnd().split('\n').map(JSON.parse);
  assert.ok(events.every(event=>event.schemaVersion===2&&event.source==='local-codex-panel'));
  assert.equal(events.filter(event=>event.type==='message.recorded').length,4);
  assert.ok(!bytes.includes(Buffer.from(scope)));
  assert.equal((await f.store.close()).value.closed,true);
  const reopened=f.make(),restored=await reopened.get(scope,id);
  assert.equal(restored.ok,true);assert.equal(restored.session.messages.length,4);
  assert.deepEqual(restored.draft,{text:'下一条草稿',includeSelection:true});
  assert.equal((await reopened.list(scope)).sessions[0].id,id);
});

test('partitions never adopt another user conversation or expose a raw account identity',async t=>{
  const f=await fixture(t),a=conversation('账号 A'),b=conversation('账号 B');
  await f.store.save(scope,a.view());await f.store.save('model:user:other',b.view());
  assert.equal((await f.store.get('model:user:other',a.conversationId)).error.code,'CHAT_SESSION_NOT_FOUND');
  assert.deepEqual((await f.store.list(scope)).sessions.map(item=>item.id),[a.conversationId]);
  assert.deepEqual((await f.store.list('model:user:other')).sessions.map(item=>item.id),[b.conversationId]);
  assert.ok(!((await fs.readFile(f.file(a.conversationId))).toString().includes('model:user')));
});

test('sent reference snapshots and terminal messages cannot be rewritten by later edits',async t=>{
  const f=await fixture(t),session=new ChatSession(),run=session.begin('带参考的问题');
  session.messages[0].references=[{path:'参考/规范.md',text:'当时正文',startLine:8,endLine:9}];
  const started=session.view(),saving=f.store.save(scope,started);started.messages[0].references[0].text='调用者后来修改';
  assert.equal((await saving).ok,true);const prefix=await fs.readFile(f.file(session.conversationId));
  session.messages[1].text='完成回复';session.finish(run,'completed');
  assert.equal((await f.store.save(scope,session.view())).ok,true);
  const before=await fs.readFile(f.file(session.conversationId));assert.ok(before.subarray(0,prefix.length).equals(prefix));
  session.messages[0].references[0].text='不允许修改已发送参考';
  assert.equal((await f.store.save(scope,session.view())).error.code,'CHAT_HISTORY_CONFLICT');
  assert.deepEqual(await fs.readFile(f.file(session.conversationId)),before);
  assert.equal((await f.store.get(scope,session.conversationId)).session.messages[0].references[0].text,'当时正文');
});

test('native IDs remain opaque and per-turn context snapshots retain explicit message identity',async t=>{
  const f=await fixture(t),session=new ChatSession(),run=session.begin('当前选择');
  const native='Opaque-Native/v7:THREAD';session.bindThread(run,native);run.turnId='Turn-v7:Exact';
  const view=session.view();view.conversation.turnBinding={requestId:run.id,threadId:native,turnId:run.turnId,messageId:run.messageId,contextEpoch:0,status:'streaming'};
  view.context={document:{title:'当时模型'},selection:{elementIds:['42']},capturedAt:'first'};
  view.contextMessageId=run.userMessageId;
  assert.equal((await f.store.save(scope,view)).ok,true);
  const next=structuredClone(view);next.context={document:{title:'后来模型'},selection:{elementIds:['84']},capturedAt:'later'};
  assert.equal((await f.store.save(scope,next)).ok,true);
  const events=(await fs.readFile(f.file(session.conversationId),'utf8')).trimEnd().split('\n').map(JSON.parse);
  const snapshots=events.filter(event=>['conversation.created','state.recorded'].includes(event.type));
  assert.equal(snapshots[0].payload.contextMessageId,view.messages[0].id);
  assert.equal(snapshots[0].payload.context.document.title,'当时模型');
  assert.equal(snapshots.at(-1).payload.context.document.title,'后来模型');
  const restored=await f.store.get(scope,session.conversationId);
  assert.equal(restored.session.conversation.threadBinding.threadId,native);
  assert.equal(restored.session.conversation.turnBinding.turnId,'Turn-v7:Exact');
  assert.equal(restored.session.conversation.threadBinding.persistedResumeVerified,false);
});

test('two turn captures and idle previews retain explicit context ownership without rewriting prior bytes',async t=>{
  const f=await fixture(t),session=new ChatSession(),first=session.begin('第一轮 A');
  session.setContext({document:{title:'A'},selection:{elementIds:['1']},capturedAt:'turn-A'},null,first.userMessageId);
  session.messages[0].references=[{path:'规范.md',text:'第一轮正文'}];
  session.finish(first,'completed');
  assert.equal((await f.store.save(scope,session.view())).ok,true);
  const prefix=await fs.readFile(f.file(session.conversationId));
  session.setContext({document:{title:'B'},selection:{elementIds:['2']},capturedAt:'idle-preview'});
  assert.equal((await f.store.save(scope,session.view(),{text:'尚未发送 B',includeSelection:true})).ok,true);
  const preview=await f.store.get(scope,session.conversationId);
  assert.equal(preview.session.contextMessageId,null);assert.equal(preview.session.context.document.title,'B');
  assert.deepEqual(preview.draft,{text:'尚未发送 B',includeSelection:true});
  const second=session.begin('第二轮 C');
  session.setContext({document:{title:'C'},selection:{elementIds:['3']},capturedAt:'turn-C'},null,second.userMessageId);
  session.finish(second,'completed');
  assert.equal((await f.store.save(scope,session.view())).ok,true);
  session.setContext();assert.equal((await f.store.save(scope,session.view())).ok,true);
  const bytes=await fs.readFile(f.file(session.conversationId));assert.ok(bytes.subarray(0,prefix.length).equals(prefix));
  const states=bytes.toString().trimEnd().split('\n').map(JSON.parse).filter(event=>['conversation.created','state.recorded'].includes(event.type)).map(event=>event.payload);
  assert.deepEqual(states.map(state=>state.contextMessageId),[first.userMessageId,null,second.userMessageId,null]);
  assert.equal(states[0].context.document.title,'A');assert.equal(states[1].context.document.title,'B');assert.equal(states[2].context.document.title,'C');
  const restored=await f.store.get(scope,session.conversationId);
  assert.equal(restored.session.contextMessageId,null);assert.equal(restored.session.messages[0].references[0].text,'第一轮正文');
});

test('missing context ownership stays unknown and invalid or orphaned ownership is never inferred',async t=>{
  const f=await fixture(t),session=conversation(),view=session.view();delete view.contextMessageId;
  assert.equal((await f.store.save(scope,view)).ok,true);
  assert.equal((await f.store.get(scope,session.conversationId)).session.contextMessageId,null);
  const before=await fs.readFile(f.file(session.conversationId));
  for(const invalid of ['invalid-id',view.messages[1].id,randomUUID()]){
    const next=structuredClone(view);next.contextMessageId=invalid;
    assert.equal((await f.store.save(scope,next)).error.code,'CHAT_SNAPSHOT_INVALID');
  }
  const orphan=structuredClone(view);orphan.contextMessageId=randomUUID();orphan.historyTruncated=true;
  assert.equal((await f.store.save(scope,orphan)).error.code,'CHAT_LOG_INVALID');
  assert.deepEqual(await fs.readFile(f.file(session.conversationId)),before);
  // A later null checkpoint must not hide a malformed earlier association.
  const events=before.toString().trimEnd().split('\n').map(JSON.parse);events[0].payload.contextMessageId=randomUUID();
  events.push({...structuredClone(events[0]),id:randomUUID(),type:'state.recorded',payload:{...events[0].payload,contextMessageId:null}});
  await fs.writeFile(f.file(session.conversationId),events.map(event=>JSON.stringify(event)+'\n').join(''));
  assert.equal((await f.store.get(scope,session.conversationId)).error.code,'CHAT_LOG_INVALID');
});

test('view trimming is not deletion of older recorded messages',async t=>{
  const f=await fixture(t),session=new ChatSession();for(let i=0;i<24;i++){session.add('user','问题 '+i);session.add('assistant','回复 '+i);}
  const oldest=session.messages[0].id;await f.store.save(scope,session.view());
  const before=await fs.readFile(f.file(session.conversationId));session.add('user','新问题');session.add('assistant','新回复');
  assert.equal(session.messages.length,48);const trimmed=session.view();trimmed.contextMessageId=oldest;assert.equal((await f.store.save(scope,trimmed)).ok,true);
  const after=await fs.readFile(f.file(session.conversationId));assert.ok(after.subarray(0,before.length).equals(before));
  const value=await f.store.get(scope,session.conversationId);assert.equal(value.summary.messageCount,50);assert.equal(value.session.messages.length,48);assert.equal(value.session.historyTruncated,true);
  assert.ok(after.toString().includes(oldest));assert.equal(value.session.contextMessageId,oldest);
  assert.equal((await f.store.save(scope,value.session)).changed,false);
  assert.deepEqual(await fs.readFile(f.file(session.conversationId)),after);
  const rewritten=structuredClone(value.session);rewritten.messages[0].text='不允许改写';
  assert.equal((await f.store.save(scope,rewritten)).error.code,'CHAT_HISTORY_CONFLICT');
  assert.deepEqual(await fs.readFile(f.file(session.conversationId)),after);
});

test('tool display truncation survives history storage and restoration',async t=>{
  const f=await fixture(t),session=conversation();
  session.messages[1].toolHistoryTruncated=true;
  assert.equal((await f.store.save(scope,session.view())).ok,true);
  const saved=await f.store.get(scope,session.conversationId);
  assert.equal(saved.session.messages[1].toolHistoryTruncated,true);
  const restored=new ChatSession();restored.restoreHistory(saved.session);
  assert.equal(restored.view().messages[1].toolHistoryTruncated,true);
});

test('incomplete and malformed files remain unchanged and appear as list issues with bounded paging',async t=>{
  const f=await fixture(t),sessions=[conversation('A'),conversation('B'),conversation('C')];
  for(const session of sessions)await f.store.save(scope,session.view());
  const bad=f.file(sessions[1].conversationId);await fs.appendFile(bad,'{"unfinished":');const before=await fs.readFile(bad);
  assert.equal((await f.store.get(scope,sessions[1].conversationId)).error.code,'CHAT_LOG_INCOMPLETE');
  assert.equal((await f.store.save(scope,sessions[1].view())).ok,false);assert.deepEqual(await fs.readFile(bad),before);
  const first=await f.store.list(scope,{limit:2}),second=await f.store.list(scope,{cursor:first.nextCursor,limit:2});
  assert.equal(first.complete,false);assert.equal(second.complete,true);
  assert.equal(first.sessions.length+first.issues.length+second.sessions.length+second.issues.length,3);
  assert.equal(first.issues.length+second.issues.length,1);
});

test('malformed-file reads consume the whole-list byte budget',async t=>{
  const f=await fixture(t,{maxListReadBytes:500});
  for(let i=0;i<3;i++){const session=conversation();await f.store.save(scope,session.view());await fs.writeFile(f.file(session.conversationId),'{'+ ' '.repeat(400)+'\n');}
  const list=await f.store.list(scope);assert.equal(list.ok,true);assert.equal(list.complete,false);assert.equal(list.issues.length,1);assert.equal(list.bytesRead,402);assert.ok(list.nextCursor);
});

test('capacity and file budgets reject saves before modifying committed history',async t=>{
  const f=await fixture(t,{maxSessions:1,maxFileBytes:2000}),session=new ChatSession();
  assert.equal((await f.store.save(scope,session.view())).ok,true);const before=await fs.readFile(f.file(session.conversationId));
  assert.equal((await f.store.save(scope,new ChatSession().view())).error.code,'CHAT_SESSION_LIMIT');
  session.add('user','x'.repeat(3000));assert.equal((await f.store.save(scope,session.view())).error.code,'CHAT_LOG_LIMIT');
  assert.deepEqual(await fs.readFile(f.file(session.conversationId)),before);
});

test('one production owner holds the directory until explicit close and no other owner deletes its lock',async t=>{
  const f=await fixture(t),session=conversation();assert.equal((await f.store.ready()).ok,true);
  const other=f.make();assert.equal((await other.ready()).error.code,'CHAT_STORE_LOCKED');assert.equal((await other.close()).ok,true);
  assert.equal((await f.store.save(scope,session.view())).ok,true);
  assert.equal((await f.store.close()).ok,true);const reopened=f.make();assert.equal((await reopened.get(scope,session.conversationId)).ok,true);
});

test('hardlinked transcript is refused without changing either name',async t=>{
  const f=await fixture(t),session=conversation();await f.store.save(scope,session.view());const file=f.file(session.conversationId),alias=path.join(f.temporary,'alias.jsonl');
  await fs.link(file,alias);const before=await fs.readFile(file);
  assert.equal((await f.store.get(scope,session.conversationId)).error.code,'CHAT_LOG_INVALID');
  assert.equal((await f.store.save(scope,session.view())).ok,false);assert.deepEqual(await fs.readFile(alias),before);
});

test('parent junction or symlink is rejected before any transcript write',async t=>{
  const f=await fixture(t),outside=path.join(f.temporary,'outside'),alias=path.join(f.temporary,'alias');await fs.mkdir(outside);
  try{await fs.symlink(outside,alias,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Symlink creation not permitted by this host');return;}throw error;}
  const rejected=createPanelChatStore({stateDirectory:path.join(alias,'history')});assert.equal((await rejected.ready()).ok,false);assert.equal((await rejected.close()).ok,true);
  assert.deepEqual(await fs.readdir(outside),[]);
});

test('close failure retains the exact handle and blocks saves until matching cleanup; replay is idempotent',async t=>{
  let failClose=true;const f=await fixture(t,{}, {open:async(file,flags)=>{const handle=await fs.open(file,flags);if(file.endsWith('.jsonl')){const original=handle.close.bind(handle);handle.close=async()=>{if(failClose){failClose=false;throw new Error('fixture-close');}return original();};}return handle;}});
  const session=conversation(),first=await f.store.save(scope,session.view());assert.equal(first.ok,false);assert.equal(first.error.code,'CHAT_CLEANUP_PENDING');assert.ok(first.error.cleanupId);
  const before=await fs.readFile(f.file(session.conversationId));assert.equal((await f.store.save(scope,session.view())).error.code,'CHAT_CLEANUP_PENDING');
  assert.equal((await f.store.cleanup(randomUUID())).error.code,'CHAT_CLEANUP_ID_INVALID');assert.equal((await f.store.cleanup(first.error.cleanupId)).ok,true);
  const retry=await f.store.save(scope,session.view());assert.equal(retry.ok,true);assert.equal(retry.changed,false);assert.deepEqual(await fs.readFile(f.file(session.conversationId)),before);
});

test('a failed fsync is not later called saved merely because unchanged bytes can be read',async t=>{
  let syncs=0;const f=await fixture(t,{}, {open:async(file,flags)=>{const handle=await fs.open(file,flags);if(file.endsWith('.jsonl')){const original=handle.sync.bind(handle);handle.sync=async()=>{syncs++;if(syncs===1)throw new Error('fixture-sync');return original();};}return handle;}});
  const session=conversation();assert.equal((await f.store.save(scope,session.view())).ok,false);
  const result=await f.store.save(scope,session.view());assert.equal(result.ok,true);assert.equal(result.changed,false);assert.equal(syncs,2);
});

test('partial write remains unknown and is neither repaired nor appended on another save',async t=>{
  let first=true;const f=await fixture(t,{}, {open:async(file,flags)=>{const handle=await fs.open(file,flags);if(file.endsWith('.jsonl')){const original=handle.writeFile.bind(handle);handle.writeFile=async value=>{if(first){first=false;await original('{"partial":');throw new Error('fixture-partial');}return original(value);};}return handle;}});
  const session=conversation();assert.equal((await f.store.save(scope,session.view())).ok,false);const before=await fs.readFile(f.file(session.conversationId));
  assert.equal((await f.store.save(scope,session.view())).error.code,'CHAT_LOG_INCOMPLETE');assert.deepEqual(await fs.readFile(f.file(session.conversationId)),before);
});

test('v1 preview format remains separate and is never relabeled as a production session',async t=>{
  const f=await fixture(t),legacyDirectory=path.join(f.temporary,'preview'),legacy=createChatStore({stateDirectory:legacyDirectory}),id=randomUUID();
  await legacy.createSession(id);const bytes=await fs.readFile(path.join(legacyDirectory,id+'.jsonl'));
  const session=conversation();await f.store.save(scope,session.view());await fs.writeFile(f.file(id),bytes);
  assert.equal((await f.store.get(scope,id)).error.code,'CHAT_LOG_INVALID');assert.deepEqual(await fs.readFile(path.join(legacyDirectory,id+'.jsonl')),bytes);
  assert.equal((await legacy.getSession(id)).ok,true);await legacy.close();
});
