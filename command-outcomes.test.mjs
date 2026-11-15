import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createReadCommandFixture} from './test-support/read-command-host.mjs';
import {modelCommandPresentation} from './public/model-workspace.mjs';
const directory=fileURLToPath(new URL('./workbench/validation/20261027-command-outcomes/',import.meta.url));
const wait=async fn=>{for(let i=0;i<500;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Controlled outcome deadline');};

test('typed request outcomes cross original HTTP/SSE into exact command labels without replay or chat changes',async t=>{
  const f=await createReadCommandFixture({directory,timeout:2000});t.after(()=>f.close());const login=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'}),cookie=login.cookie;assert.equal((await f.confirm(cookie)).status,200);
  const stream=await f.events(cookie),snapshot=(await stream.next()).data,id=snapshot.session.conversation.id,view=()=>f.app.snapshot('model-test-client');
  assert.equal((await f.post('turn',{message:'已有对话和引用保持'} ,cookie)).status,202);f.codex.finish(0,'completed','原回复');await wait(()=>!view().busy);
  await f.post('chat/draft',{conversationId:id,draft:{text:'保留的输入 @revit_list_levels',includeSelection:true}},cookie);
  const session=structuredClone(view().session),draft=structuredClone(view().draft),jsonl=(await fs.readdir(path.join(f.queueRoot,'history'),{recursive:true})).find(name=>name.endsWith(id+'.jsonl')),logFile=path.join(f.queueRoot,'history',jsonl),before=await fs.readFile(logFile);
  const cases=[['typed-not-started','failed','COMMAND_NOT_STARTED','not_started','未执行'],['typed-expired','failed','COMMAND_REQUEST_EXPIRED','expired','请求已过期'],['typed-failed','failed','COMMAND_QUERY_FAILED','failed','未完成'],['host-error','failed','COMMAND_QUERY_FAILED','failed','未完成'],['malformed-failure','unknown','COMMAND_READ_UNCONFIRMED','unconfirmed','结果待核对'],['timeout','unknown','COMMAND_READ_UNCONFIRMED','unconfirmed','结果待核对']];
  for(const [mode,status,code,outcome,label] of cases){
    f.setMode(mode);const start=f.queueRequests.length,accepted=await f.post('command',{conversationId:id,commandId:'selection',parameters:{}},cookie);assert.equal(accepted.status,202);
    let terminal;do{terminal=await stream.next();}while(terminal.data.command?.executionId!==accepted.body.executionId||['running','stopping'].includes(terminal.data.command.status));
    const command=terminal.data.command;assert.equal(command.status,status,mode);assert.equal(command.error.code,code,mode);assert.equal(command.error.outcome,outcome,mode);assert.equal(command.conversationId,id);assert.equal(modelCommandPresentation(command).status,label);assert.ok(!command.result);
    if(mode.startsWith('typed-')){assert.equal(command.error.nativeFailure.started,mode==='typed-failed');assert.equal(command.error.nativeFailure.phase,mode==='typed-failed'?'dispatch':'validation');assert.equal(command.error.nativeFailure.reason,mode==='typed-expired'?'expired':null);assert.equal(command.error.nativeFailure.requestId,f.queueRequests.at(-1).id);}
    const count=f.queueRequests.length;await new Promise(resolve=>setTimeout(resolve,35));assert.equal(f.queueRequests.length,count);assert.deepEqual(f.queueRequests.slice(start).map(request=>request.operation),mode==='timeout'?['status']:['status','get_selection'],mode);assert.equal(f.codex.turns.length,1);assert.equal(f.codex.interrupts.length,0);assert.deepEqual(view().session,session);assert.deepEqual(view().draft,draft);assert.deepEqual(await fs.readFile(logFile),before);
  }
});

test('display never infers expiry or a known failure from arbitrary exception words',()=>{
  for(const message of ['expired','WORKBENCH_REQUEST_EXPIRED','Request expired before execution; no operation was run.'])assert.equal(modelCommandPresentation({status:'unknown',error:{code:'COMMAND_READ_UNCONFIRMED',message,outcome:'unconfirmed'}}).status,'结果待核对');
  assert.equal(modelCommandPresentation({status:'failed',error:{code:'COMMAND_REQUEST_EXPIRED',outcome:'failed',message:'bad contract'}}).status,'未完成');
  const expired=modelCommandPresentation({status:'failed',error:{code:'COMMAND_REQUEST_EXPIRED',outcome:'expired',message:'native diagnostic'}});assert.equal(expired.error,'本次查询未执行。');assert.equal(expired.diagnostic,'native diagnostic');
  assert.equal(modelCommandPresentation({status:'failed',error:{code:'COMMAND_QUERY_FAILED',outcome:'failed',message:'native diagnostic'}}).error,'Revit 未能完成本次查询。');
});

test('queue settlement presents cancellation and expiry without inferring them from a pending receipt',()=>{
  const cancelled={status:'interrupted',error:{outcome:'not_started',nativeFailure:{phase:'queue',started:false,reason:'cancelled'}}};
  assert.equal(modelCommandPresentation(cancelled).error,'已取消，未执行。');
  const expired={status:'failed',error:{code:'COMMAND_REQUEST_EXPIRED',outcome:'expired',nativeFailure:{phase:'queue',started:false,reason:'expired'}}};
  assert.equal(modelCommandPresentation(expired).error,'请求在排队期间过期，未执行。');
  assert.equal(modelCommandPresentation({...cancelled,status:'unknown'}).status,'结果待核对');
});
