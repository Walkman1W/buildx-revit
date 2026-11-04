import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from './lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {createPanelChatStore} from './lib/chat-store.mjs';
import {ChatSession} from './lib/chat-session.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root=fileURLToPath(new URL('.',import.meta.url)),id='12345678-1234-4123-8123-123456789abc';
class Fake extends EventEmitter {
  constructor(){super();this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.sent=[];this.turns=0;}
  async newThread(){return 'thread';} async turn(){this.turns++;return {turn:{id:'turn'}};} async interrupt(){} async close(){return {closed:true};}
  async steer(...args){this.sent.push(args);return this.onSteer?this.onSteer(...args):{turnId:args[1]};}
}
async function fixture(t,historyStore=null){const codex=new Fake(),app=createPanelServer({root,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,historyStore,invokeWorkbench:async()=>{throw new Error('unexpected model read');}});const {origin}=await app.listen(),status=await(await fetch(origin+'/api/status')).json();t.after(()=>app.close());const post=async(route,fields={})=>{const r=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Chat':status.csrf},body:JSON.stringify({client:'browser',...fields})});return {status:r.status,body:await r.json()};};return {codex,app,post,status};}
async function started(f){assert.equal((await f.post('turn',{message:'开始'})).status,202);return f.app.snapshot('browser').session.conversation.id;}
const payload=conversationId=>({conversationId,turnId:'turn',requestId:id,message:'保留露台'});
test('steering only accepts the owning active turn and records acceptance once',async t=>{
  const f=await fixture(t),conversationId=await started(f);assert.equal(f.status.steerAvailable,true);
  assert.equal((await f.post('steer',{...payload(conversationId),client:'other'})).status,409);
  assert.equal((await f.post('steer',{...payload(conversationId),turnId:'old'})).status,409);
  assert.equal((await f.post('steer',{...payload(conversationId),requestId:'bad'})).status,400);
  const accepted=await f.post('steer',payload(conversationId));assert.deepEqual(accepted,{status:200,body:{ok:true,status:'accepted'}});
  assert.deepEqual(f.codex.sent,[['thread','turn','保留露台',id]]);
  assert.equal((await f.post('steer',payload(conversationId))).status,409);assert.equal(f.codex.sent.length,1);
  assert.equal(f.app.snapshot('browser').session.conversation.steerReceipts[0].status,'accepted');
  f.codex.emit('notification','turn/completed',{threadId:'thread',turnId:'turn',turn:{id:'turn',status:'completed'}});
  assert.equal((await f.post('steer',{...payload(conversationId),requestId:'22345678-1234-4123-8123-123456789abc'})).status,409);
});
test('late acknowledgement after interruption or account change is unknown and never retried',async t=>{
  const f=await fixture(t),conversationId=await started(f);let release;
  f.codex.onSteer=()=>new Promise(resolve=>{release=resolve;});const pending=f.post('steer',payload(conversationId));
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.post('steer',payload(conversationId))).status,409);
  await f.post('interrupt');release({turnId:'turn'});const result=await pending;
  assert.equal(result.status,502);assert.equal(result.body.status,'unknown');assert.match(result.body.error,/勿自动重试/);assert.equal(f.codex.sent.length,1);
  assert.equal(f.app.snapshot('browser').session.conversation.steerReceipts[0].status,'unknown');
  f.codex.emit('notification','turn/completed',{threadId:'thread',turnId:'turn',turn:{id:'turn',status:'interrupted'}});
});
test('account revision change before an acknowledgement cannot confirm old steering',async t=>{
  const f=await fixture(t),conversationId=await started(f);let release;
  f.codex.onSteer=()=>new Promise(resolve=>{release=resolve;});const pending=f.post('steer',payload(conversationId));while(!release)await new Promise(resolve=>setImmediate(resolve));
  f.codex.state={...f.codex.state,codexAccount:{accountRevision:3}};release({turnId:'turn'});
  const result=await pending;assert.equal(result.status,502);assert.equal(result.body.status,'unknown');assert.equal(f.codex.sent.length,1);
});
test('steering preserves the acknowledged message in the correct local history scope',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-steer-')),store=createPanelChatStore({stateDirectory:dir}),f=await fixture(t,store);
  t.after(async()=>{await f.app.close();await fs.rm(dir,{recursive:true,force:true});});
  const conversationId=await started(f);
  // Turn startup may still be flushing its history; wait for the original save.
  while(f.app.snapshot('browser').session.conversation.persistence?.status==='pending')await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.post('steer',payload(conversationId))).status,200);
  while(f.app.snapshot('browser').session.conversation.persistence?.status==='pending')await new Promise(resolve=>setImmediate(resolve));
  const saved=await store.get('model:research-local',conversationId);assert.equal(saved.ok,true);
  assert.ok(saved.session.messages.some(message=>message.text.includes('补充指令：')&&message.text.includes('保留露台')));
  assert.deepEqual(saved.session.conversation.steerReceipts,[{requestId:id,turnId:'turn',message:'保留露台',status:'accepted'}]);
  f.codex.emit('notification','turn/completed',{threadId:'thread',turnId:'turn',turn:{id:'turn',status:'completed'}});
});
test('pending receipt is durable before dispatch, isolated by scope, and duplicate unknown text is not resent',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-steer-pending-')),store=createPanelChatStore({stateDirectory:dir}),f=await fixture(t,store);
  t.after(async()=>{await f.app.close();await fs.rm(dir,{recursive:true,force:true});});
  const conversationId=await started(f);while(f.app.snapshot('browser').session.conversation.persistence?.status==='pending')await new Promise(resolve=>setImmediate(resolve));
  let release;f.codex.onSteer=()=>new Promise(resolve=>{release=resolve;});const pending=f.post('steer',payload(conversationId));
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const saved=await store.get('model:research-local',conversationId);
  assert.equal(saved.ok,true);assert.deepEqual(saved.session.conversation.steerReceipts,[{requestId:id,turnId:'turn',message:'保留露台',status:'pending'}]);assert.equal(saved.session.conversation.steerReceiptsRevision,1);
  const restored=new ChatSession();restored.restoreHistory(saved.session);assert.deepEqual(restored.view().conversation.steerReceipts,saved.session.conversation.steerReceipts);assert.equal(restored.view().conversation.steerReceiptsRevision,1);assert.equal(restored.addSteerReceipt('32345678-1234-4123-8123-123456789abc','new-turn','保留露台'),false);
  assert.equal((await store.get('model:user:another',conversationId)).ok,false);
  await f.post('interrupt');release({turnId:'turn'});assert.equal((await pending).body.status,'unknown');
  while(f.app.snapshot('browser').session.conversation.persistence?.status==='pending')await new Promise(resolve=>setImmediate(resolve));
  f.codex.emit('notification','turn/completed',{threadId:'thread',turnId:'turn',turn:{id:'turn',status:'interrupted'}});
  while(f.app.snapshot('browser').session.conversation.persistence?.status==='pending')await new Promise(resolve=>setImmediate(resolve));
  const before=f.app.snapshot('browser').session.messages.length,blocked=await f.post('turn',{message:'保留露台'});assert.equal(blocked.status,409);assert.equal(blocked.body.status,'not_sent');assert.equal(f.codex.turns,1);assert.equal(f.app.snapshot('browser').session.messages.length,before);
  assert.equal((await f.post('turn',{message:'下一轮'})).status,202);
  assert.equal((await f.post('steer',{...payload(conversationId),requestId:'22345678-1234-4123-8123-123456789abc'})).status,409);
  assert.equal(f.codex.sent.length,1);
});
test('terminal receipts roll over while unresolved receipts and used request identities remain protected',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-steer-rollover-')),store=createPanelChatStore({stateDirectory:dir});
  t.after(async()=>{await store.close();await fs.rm(dir,{recursive:true,force:true});});
  const s=new ChatSession(),scope='model:user:one',request=i=>i.toString(16).padStart(8,'0')+'-1234-4123-8123-123456789abc';s.add('user','开始');
  for(let i=0;i<32;i++){assert.equal(s.addSteerReceipt(request(i),'turn','内容 '+i),true);assert.equal(s.settleSteerReceipt(request(i),i===0?'unknown':'accepted'),true);}
  assert.equal((await store.save(scope,s.view())).ok,true);assert.equal(s.addSteerReceipt(request(32),'turn','新补充'),true);
  assert.equal(s.steerReceipts.length,32);assert.ok(s.steerReceipts.some(value=>value.requestId===request(0)&&value.status==='unknown'));assert.ok(!s.steerReceipts.some(value=>value.requestId===request(1)));
  assert.equal((await store.save(scope,s.view())).ok,true);assert.equal(s.addSteerReceipt(request(1),'turn','另一条'),false);
  const saved=await store.get(scope,s.conversationId);assert.equal(saved.ok,true);assert.equal(saved.session.conversation.steerReceipts.length,32);
  const full=new ChatSession();for(let i=0;i<32;i++)assert.equal(full.addSteerReceipt(request(i),'turn','待核对 '+i),true);assert.equal(full.addSteerReceipt(request(33),'turn','额外'),false);assert.equal(full.steerReceipts.length,32);
});
test('one active turn accepts more than 32 confirmed supplements without reusing a pruned identity',async t=>{
  const f=await fixture(t),conversationId=await started(f),request=i=>i.toString(16).padStart(8,'0')+'-1234-4123-8123-123456789abc';
  for(let i=0;i<33;i++){
    const result=await f.post('steer',{conversationId,turnId:'turn',requestId:request(i),message:'补充 '+i});
    assert.equal(result.status,200,'supplement '+i+' should be accepted');
  }
  assert.equal(f.codex.sent.length,33);
  const receipts=f.app.snapshot('browser').session.conversation.steerReceipts;
  assert.equal(receipts.length,32);assert.ok(!receipts.some(item=>item.requestId===request(0)));assert.ok(receipts.some(item=>item.requestId===request(32)));
  const duplicate=await f.post('steer',{conversationId,turnId:'turn',requestId:request(0),message:'重复身份'});
  assert.equal(duplicate.status,409);assert.equal(f.codex.sent.length,33);
});
test('receipt transition is append-only and cannot rewrite a terminal result or regress its revision',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-steer-log-')),store=createPanelChatStore({stateDirectory:dir});
  t.after(async()=>{await store.close();await fs.rm(dir,{recursive:true,force:true});});
  const s=new ChatSession(),scope='model:user:one';s.add('user','开始');assert.equal((await store.save(scope,s.view())).ok,true);
  assert.equal(s.addSteerReceipt(id,'turn','保留露台'),true);assert.equal((await store.save(scope,s.view())).ok,true);
  assert.equal(s.settleSteerReceipt(id,'accepted'),true);assert.equal((await store.save(scope,s.view())).ok,true);
  const backwards=s.view();backwards.conversation.steerReceipts[0].status='pending';backwards.conversation.steerReceiptsRevision++;
  assert.equal((await store.save(scope,backwards)).ok,false);
  const stale=s.view();stale.conversation.steerReceiptsRevision=1;assert.equal((await store.save(scope,stale)).ok,false);
  const saved=await store.get(scope,s.conversationId);assert.equal(saved.ok,true);assert.equal(saved.session.conversation.steerReceipts[0].status,'accepted');
});
test('reopening production history exposes pending receipt without sending it again',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-steer-reopen-')),first=createPanelChatStore({stateDirectory:dir});
  const s=new ChatSession();s.add('user','原任务');assert.equal(s.addSteerReceipt(id,'old-turn','保留露台'),true);
  assert.equal((await first.save('model:research-local',s.view())).ok,true);assert.equal((await first.close()).ok,true);
  const reopened=createPanelChatStore({stateDirectory:dir}),f=await fixture(t,reopened);t.after(async()=>{await f.app.close();await fs.rm(dir,{recursive:true,force:true});});
  const result=await f.post('chat/select',{conversationId:s.conversationId,draft:{text:'',includeSelection:false}});
  assert.equal(result.status,200);assert.equal(result.body.session.conversation.readOnly,true);
  assert.deepEqual(result.body.session.conversation.steerReceipts,[{requestId:id,turnId:'old-turn',message:'保留露台',status:'pending'}]);
  assert.equal(result.body.session.conversation.steerReceiptsRevision,1);assert.deepEqual(f.codex.sent,[]);
});
test('failed pending receipt persistence fails closed before native dispatch',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-steer-fail-')),store=createPanelChatStore({stateDirectory:dir});
  const wrapper=Object.freeze({ready:(...args)=>store.ready(...args),list:(...args)=>store.list(...args),get:(...args)=>store.get(...args),close:(...args)=>store.close(...args),cleanup:(...args)=>store.cleanup(...args),save:(scope,view,draft)=>view.conversation.steerReceipts?.length?Promise.resolve({ok:false,error:{code:'TEST_SAVE_FAIL',message:'保存失败'}}):store.save(scope,view,draft)});
  const f=await fixture(t,wrapper);t.after(async()=>{await f.app.close();await fs.rm(dir,{recursive:true,force:true});});
  const conversationId=await started(f);while(f.app.snapshot('browser').session.conversation.persistence?.status==='pending')await new Promise(resolve=>setImmediate(resolve));
  const result=await f.post('steer',payload(conversationId));assert.equal(result.status,503);assert.equal(result.body.status,'not_sent');assert.equal(f.codex.sent.length,0);
});
