import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatSession} from './lib/chat-session.mjs';

const params=(run,extra={})=>({threadId:run.threadId,turnId:run.turnId,...extra});
const attach=(session,text='查询')=>{const run=session.begin(text);assert.equal(session.bindThread(run,'native-thread'),true);run.turnId='native-turn';return run;};

test('logical conversations are distinct from each other and identify the panel source',()=>{
  const first=new ChatSession(),second=new ChatSession();
  assert.notEqual(first.conversationId,second.conversationId);
  assert.match(first.conversationId,/^[0-9a-f-]{36}$/);
  assert.deepEqual(first.view().conversation,{
    id:first.conversationId,source:'local-codex-panel',
    threadBinding:{threadId:null,contextEpoch:0,scope:'current-runtime',persistedResumeVerified:false},
    steerReceipts:[],steerReceiptsRevision:0,
  });
  assert.notEqual(first.view().conversation.source,'ui-preview');
  assert.equal(second.threadId,null);
});

test('conversation metadata and message/context views cannot mutate owner state',()=>{
  const session=new ChatSession(),run=attach(session);
  session.setContext({document:{title:'项目'},selection:null,capturedAt:'time'});
  const view=session.view();
  view.conversation.id='foreign-conversation';view.conversation.source='ui-preview';
  view.conversation.threadBinding.threadId='foreign-thread';view.conversation.threadBinding.contextEpoch=99;
  view.messages[0].text='改写';view.context.document.title='改写项目';
  assert.equal(session.view().conversation.id,run.conversationId);
  assert.equal(session.view().conversation.source,'local-codex-panel');
  assert.equal(session.threadId,'native-thread');assert.equal(session.contextEpoch,0);
  assert.equal(session.messages[0].text,'查询');assert.equal(session.context.document.title,'项目');
});

test('thread binding accepts only the exact current run and preserves opaque native IDs',()=>{
  const first=new ChatSession(),second=new ChatSession(),run=first.begin('first'),other=second.begin('second');
  const id=' native:线程 / opaque ';
  assert.equal(first.bindThread(other,id),false);assert.equal(first.threadId,null);
  assert.equal(first.bindThread({...run},id),false);
  assert.equal(first.bindThread(run,id),true);assert.equal(first.threadId,id);assert.equal(run.threadId,id);
  assert.equal(first.bindThread(run,id),true);
  assert.equal(first.bindThread(run,'different-native-thread'),false);assert.equal(first.threadId,id);
  assert.equal(second.threadId,null);
});

test('invalid thread identity is rejected without changing the owner or pending run',()=>{
  const session=new ChatSession(),run=session.begin('问题');
  for(const value of [null,undefined,'',123,[],{},'x'.repeat(201)]){
    assert.throws(()=>session.bindThread(run,value),/线程 ID/);
    assert.equal(session.threadId,null);assert.equal(run.threadId,null);assert.equal(session.run,run);
  }
  assert.equal(session.bindThread(run,'x'.repeat(200)),true);
});

test('a second turn retains logical and native identity while new chat rotates only its owner',()=>{
  const session=new ChatSession(),other=new ChatSession(),id=session.conversationId,otherId=other.conversationId;
  const first=attach(session,'原消息与引用 [doc](D:/reference.md)');session.finish(first,'completed');
  const second=session.begin('继续');
  assert.equal(second.conversationId,id);assert.equal(second.contextEpoch,0);assert.equal(second.threadId,'native-thread');
  assert.equal(session.bindThread(second,'native-thread'),true);assert.equal(session.bindThread(second,'replacement'),false);
  session.finish(second,'completed');
  const previous=session.view();session.newChat();
  assert.notEqual(session.conversationId,id);assert.equal(session.threadId,null);assert.equal(session.contextEpoch,1);
  assert.deepEqual(session.messages,[]);assert.equal(other.conversationId,otherId);
  assert.equal(previous.messages[0].text,'原消息与引用 [doc](D:/reference.md)');
  assert.equal(session.bindThread(first,'native-thread'),false);assert.equal(session.finish(first,'failed','迟到'),false);
});

test('active reset is rejected atomically until the original run has an explicit terminal outcome',()=>{
  const session=new ChatSession(),run=attach(session),before=session.view(),activity=session.activity;
  assert.throws(()=>session.resetContext(),/先结束当前对话/);
  assert.deepEqual(session.view(),before);assert.equal(session.activity,activity);assert.equal(session.run,run);
  assert.equal(session.notification(run,'item/agentMessage/delta',params(run,{itemId:'answer',delta:'回复'})).changed,true);
  assert.equal(session.finish(run,'completed'),true);assert.equal(session.run,null);
});

test('reset preserves conversation and old message snapshots, clears native binding and rejects obsolete runs',()=>{
  const session=new ChatSession(),run=attach(session,'旧问题');
  session.notification(run,'item/completed',params(run,{item:{id:'answer',type:'agentMessage',text:'旧回复'}}));
  session.finish(run,'completed');const old=session.view(),id=session.conversationId;
  session.resetContext();const after=session.view();
  assert.equal(session.conversationId,id);assert.equal(session.contextEpoch,1);assert.equal(session.threadId,null);
  assert.deepEqual(after.messages.slice(0,old.messages.length),old.messages);
  assert.equal(session.bindThread(run,'native-thread'),false);
  assert.deepEqual(session.notification(run,'item/agentMessage/delta',params(run,{itemId:'late',delta:'污染'})),{changed:false});
  assert.equal(session.finish(run,'failed','迟到错误'),false);
  const next=session.begin('新轮');assert.equal(next.conversationId,id);assert.equal(next.contextEpoch,1);
  assert.equal(session.bindThread(next,'new-native-thread'),true);
  assert.equal(session.finish(run,'completed'),false);assert.equal(session.run,next);
});

test('run identity and epoch are checked independently of object and native turn identity',()=>{
  for(const field of ['conversationId','contextEpoch']){
    const session=new ChatSession(),run=attach(session);const original=run[field];
    run[field]=field==='conversationId'?'foreign':original+1;
    const before=session.view();
    assert.equal(session.bindThread(run,'native-thread'),false);
    assert.equal(session.owns(run,params(run)),false);
    assert.deepEqual(session.notification(run,'item/agentMessage/delta',params(run,{itemId:'late',delta:'污染'})),{changed:false});
    assert.equal(session.finish(run,'completed'),false);assert.deepEqual(session.view(),before);
    run[field]=original;assert.equal(session.finish(run,'completed'),true);
  }
});

test('a current-runtime native ID never claims persisted resume verification',()=>{
  const session=new ChatSession(),run=attach(session);session.finish(run,'completed');
  assert.deepEqual(session.view().conversation.threadBinding,{
    threadId:'native-thread',contextEpoch:0,scope:'current-runtime',persistedResumeVerified:false,
  });
  const replacement=new ChatSession();
  assert.notEqual(replacement.conversationId,session.conversationId);
  assert.equal(replacement.view().conversation.threadBinding.threadId,null);
  assert.equal(replacement.view().conversation.threadBinding.persistedResumeVerified,false);
});
