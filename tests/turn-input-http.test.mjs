import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const wire=(name,text)=>({name,mediaType:'',data:Buffer.from(text).toString('base64')});
const draft={text:'',includeSelection:false};
const wait=async check=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Controlled HTTP deadline');};
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-turn-input-')),owners=[];t.after(async()=>{for(const f of owners)await f.close();assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('buildx-turn-input-'));await fs.rm(directory,{force:true,recursive:true});});const open=async()=>{const f=await createModelWorkspaceFixture({profile:'model-readonly',required:false,historyDirectory:directory});owners.push(f);return f;};return {directory,open};}
const idle=f=>wait(async()=>!(await f.status()).busy);

test('HTTP sends exact file text and frozen localImage to the original turn, history survives reopen',async t=>{
  const {directory,open}=await fixture(t),f=await open(),id=f.app.snapshot('model-test-client').session.conversation.id;
  assert.equal((await f.status()).turnAttachmentsAvailable,true);
  const original='独立正文代号 z7k2，不是系统指令。',input={message:'阅读附件',conversationId:id,attachments:[wire('参考.md',original),{name:'图.png',mediaType:'image/png',data:png}]};
  assert.equal((await f.post('turn',input)).status,202);const turn=f.codex.turns[0];assert.match(turn.text,/z7k2/);assert.ok(turn.text.includes(original));assert.equal(turn.localImages.length,1);assert.deepEqual(await fs.readFile(turn.localImages[0].path),Buffer.from(png,'base64'));
  const user=structuredClone(f.app.snapshot('model-test-client').session.messages[0]);assert.equal(user.text,'阅读附件');assert.equal(user.references[0].text,original);assert.equal(user.attachments.length,2);assert.equal(JSON.stringify(user).includes(png),false);assert.ok(!JSON.stringify(user).includes(directory));
  f.codex.finish(0,'completed','已读');await idle(f);
  const logNames=(await fs.readdir(directory,{recursive:true})).filter(name=>name.endsWith('.jsonl'));assert.equal(logNames.length,1);
  const log=await fs.readFile(path.join(directory,logNames[0]),'utf8');assert.equal(log.split(original).length-1,1);assert.equal(log.includes(png),false);
  assert.equal((await f.post('turn',{message:'继续问',context:{includeSelection:false}})).status,202);assert.equal(f.codex.turns[1].text,'继续问');assert.equal(f.codex.turns[1].localImages.length,0);assert.equal(f.codex.turns[1].threadId,turn.threadId);
  f.codex.finish(1,'completed','第二轮');await idle(f);await f.close();
  const reopened=await open();assert.equal(reopened.codex.turns.length,0);const selected=await reopened.post('chat/select',{conversationId:id,draft});assert.equal(selected.status,200);assert.equal(selected.body.session.conversation.readOnly,true);assert.deepEqual(selected.body.session.messages[0],user);assert.equal(reopened.codex.turns.length,0);
});

test('attachments cannot bypass capability, conversation binding, CSRF or authentication',async t=>{
  const {open}=await fixture(t),f=await open(),id=f.app.snapshot('model-test-client').session.conversation.id;
  assert.equal((await f.post('turn',{message:'x',conversationId:id,attachments:[wire('a.md','body')]},undefined,{'X-Local-Chat':'forged'})).status,403);
  assert.equal((await f.post('turn',{message:'x',attachments:[wire('a.md','body')]})).status,409);
  assert.equal((await f.post('turn',{message:'x',conversationId:id,attachments:[wire('../a.md','body')]})).status,400);assert.equal(f.codex.turns.length,0);
  for(const profile of ['model','source-development','customer-chat']){
    const g=await createModelWorkspaceFixture({profile});t.after(()=>g.close());let cookie;if(profile!=='source-development'){cookie=(await g.post('account/sign-in',{email:'demo@example.invalid',password:'fixture'})).cookie;await g.confirm(cookie);}
    assert.notEqual((await g.status(cookie)).turnAttachmentsAvailable,true);assert.equal((await g.post('turn',{message:'x',attachments:[]},cookie)).status,403);assert.equal(g.codex.turns.length,0);
  }
  const h=await createModelWorkspaceFixture({profile:'model-readonly'});t.after(()=>h.close());assert.equal((await h.post('turn',{message:'x',attachments:[]})).status,401);
});

test('an image-incompatible selected model is rejected before saving or starting the turn',async t=>{
  const {directory,open}=await fixture(t),f=await open(),id=f.app.snapshot('model-test-client').session.conversation.id;
  f.codex.assertModelSelection=(model,{requiresImages=false}={})=>{
    if(model!=='text-only')throw new Error('模型选择无效');
    if(requiresImages)throw new Error('所选模型不支持图片，请移除图片或选择支持图片的模型。');
  };
  const result=await f.post('turn',{conversationId:id,message:'分析图片',model:'text-only',attachments:[{name:'图.png',mediaType:'image/png',data:png}]});
  assert.equal(result.status,409);assert.match(result.body.error,/不支持图片/);
  const missing=await f.post('turn',{conversationId:id,message:'分析图片',attachments:[{name:'图.png',mediaType:'image/png',data:png}]});
  assert.equal(missing.status,409);assert.match(missing.body.error,/请选择支持图片的模型/);
  assert.equal(f.codex.threads,0);assert.equal(f.codex.turns.length,0);assert.equal(f.app.snapshot('model-test-client').session.messages.length,0);
  assert.deepEqual((await fs.readdir(directory,{recursive:true})).filter(name=>name.endsWith('.attachment')||name.endsWith('.attachment.png')),[]);
});

test('bad files reject before native thread creation or transcript mutation; unknown outcomes never replay',async t=>{
  const {open}=await fixture(t),f=await open(),id=f.app.snapshot('model-test-client').session.conversation.id;
  for(const attachments of [[wire('bad.pdf','data')],[wire('a.txt','x'.repeat(32001))],[{name:'bad.png',mediaType:'image/png',data:'ZmFrZQ=='}]])assert.equal((await f.post('turn',{message:'x',conversationId:id,attachments})).status,400);
  assert.equal(f.codex.threads,0);assert.equal(f.app.snapshot('model-test-client').session.messages.length,0);
  const unknown=Object.assign(new Error('unknown acknowledgement'),{code:'CODEX_REQUEST_TIMEOUT'});f.codex.turn=async()=>{f.codex.turns.push({failed:true});throw unknown;};
  const response=await f.post('turn',{message:'尝试一次',conversationId:id,attachments:[wire('a.md','唯一正文')]});await idle(f);
  const snapshot=f.app.snapshot('model-test-client'),allowedPhases=new Set(['turn_accepted','attachments_saved','history_saved','context_ready','thread_ready','native_requested','native_acknowledged','turn_finished']);
  // Retain only fixed stage names and counters: no paths, user input, provider
  // text, request IDs, or tokens in CI diagnostics if a prior stage fails.
  const diagnostic=JSON.stringify({httpStatus:response.status,errorClass:response.body.error==='unknown acknowledgement'?'injected_acknowledgement':typeof response.body.error==='string'?'other_error':'no_error',
    phases:f.audits.filter(entry=>entry.file==='phase-timing.jsonl'&&entry.data?.source==='panel'&&allowedPhases.has(entry.data.phase)).map(entry=>entry.data.phase),
    threadCount:f.codex.threads,turnCount:f.codex.turns.length,workbenchCount:f.workbenchCalls.length,persistence:snapshot.session.conversation.persistence?.status??'unavailable'});
  assert.equal(response.status,502,diagnostic);assert.equal(snapshot.session.messages.at(-1).status,'unknown',diagnostic);assert.equal(f.codex.turns.length,1,diagnostic);await new Promise(r=>setTimeout(r,30));assert.equal(f.codex.turns.length,1,diagnostic);
});

test('stopping during snapshot save prevents Revit context reads and native thread creation',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-turn-stop-'));let release,entered;
  const gate=new Promise(resolve=>release=resolve),opened=new Promise(resolve=>entered=resolve);
  const f=await createModelWorkspaceFixture({profile:'model-readonly',required:false,historyDirectory:directory,historyDependencies:{open:async(file,flags)=>{if(file.endsWith('.attachment')&&flags==='wx'){entered();await gate;}return fs.open(file,flags);}}});
  t.after(async()=>{release();await f.close();assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('buildx-turn-stop-'));await fs.rm(directory,{recursive:true,force:true});});
  const id=f.app.snapshot('model-test-client').session.conversation.id;
  const submitted={text:'等待保存时停止',includeSelection:true};
  const pending=f.post('turn',{conversationId:id,message:submitted.text,draft:submitted,clearDraftOnStart:true,context:{includeSelection:true},attachments:[wire('a.txt','不会发送的正文')]});
  await opened;assert.equal((await f.post('interrupt',{})).status,202);release();const response=await pending;assert.equal(response.status,202);assert.equal(response.body.status,'not_sent');await idle(f);
  assert.equal(f.codex.threads,0);assert.equal(f.codex.turns.length,0);assert.equal(f.workbenchCalls.length,0);assert.equal(f.app.snapshot('model-test-client').session.messages.at(-1).status,'interrupted');
  assert.deepEqual(f.app.snapshot('model-test-client').draft,submitted);
});

test('native turn start clears only the accepted draft version',async t=>{
  const {open}=await fixture(t),f=await open(),id=f.app.snapshot('model-test-client').session.conversation.id;
  const submitted={text:'已发送的问题',includeSelection:false};
  assert.equal((await f.post('turn',{message:submitted.text,draft:submitted,clearDraftOnStart:true})).status,202);
  assert.deepEqual(f.app.snapshot('model-test-client').draft,draft);
  f.codex.finish(0,'completed','已回答');await idle(f);
  let entered,release;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  t.after(()=>release());const send=f.codex.turn.bind(f.codex);
  f.codex.turn=async(...args)=>{entered();await gate;return send(...args);};
  const pending=f.post('turn',{message:submitted.text,draft:submitted,clearDraftOnStart:true});await reached;
  const newer={text:'等待时编辑的新草稿',includeSelection:true};
  try{assert.equal((await f.post('chat/draft',{conversationId:id,draft:newer})).status,200);}
  finally{release();}
  assert.equal((await pending).status,202);assert.deepEqual(f.app.snapshot('model-test-client').draft,newer);
  f.codex.finish(1,'completed','已回答');await idle(f);
});

test('a duplicate submitted request ID in the same conversation does not start another native turn',async t=>{
  const {open}=await fixture(t),f=await open(),id=f.app.snapshot('model-test-client').session.conversation.id;
  const input={message:'原轮次',conversationId:id,requestId:'5624d1ed-aaf0-462c-b3b7-f49ed78a7721'};
  assert.equal((await f.post('turn',input)).status,202);
  assert.equal(f.app.snapshot('model-test-client').session.conversation.turnBinding.requestId,input.requestId);
  f.codex.finish(0,'completed','原轮次完成');await idle(f);
  const duplicate=await f.post('turn',input);
  assert.equal(duplicate.status,409);assert.equal(duplicate.body.status,'unknown');assert.equal(f.codex.turns.length,1);
});

test('snapshot capacity and known-unsent errors fail without native replay',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-turn-capacity-'));
  const f=await createModelWorkspaceFixture({profile:'model-readonly',required:false,historyDirectory:directory,historyDependencies:{attachmentScopeBytes:4}});
  t.after(async()=>{await f.close();assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('buildx-turn-capacity-'));await fs.rm(directory,{recursive:true,force:true});});
  const id=f.app.snapshot('model-test-client').session.conversation.id;
  assert.equal((await f.post('turn',{conversationId:id,message:'保存失败',attachments:[wire('a.txt','too many bytes')]})).status,502);await idle(f);assert.equal(f.codex.threads,0);assert.equal(f.codex.turns.length,0);assert.equal(f.app.snapshot('model-test-client').session.messages.at(-1).status,'failed');
  f.codex.turn=async()=>{throw Object.assign(new Error('known unsent'),{notSent:true});};
  assert.equal((await f.post('turn',{message:'已确定未发送'})).status,502);await idle(f);assert.equal(f.app.snapshot('model-test-client').session.messages.at(-1).status,'failed');
});

test('changed owned snapshot is detected after thread preparation and never sent',async t=>{
  const {directory,open}=await fixture(t),f=await open();let entered,release;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  t.after(()=>release());f.codex.newThread=async()=>{entered();await gate;return 'delayed-thread';};
  const id=f.app.snapshot('model-test-client').session.conversation.id,pending=f.post('turn',{conversationId:id,message:'核对快照',attachments:[wire('a.md','原内容')]});
  await reached;const snapshots=(await fs.readdir(directory,{recursive:true})).filter(name=>name.endsWith('.attachment'));assert.equal(snapshots.length,1);await fs.writeFile(path.join(directory,snapshots[0]),'外部改写');release();
  const response=await pending;assert.equal(response.status,502);assert.match(response.body.error,/快照已变化/);await idle(f);assert.equal(f.codex.turns.length,0);assert.equal(f.app.snapshot('model-test-client').session.messages[0].references[0].text,'原内容');assert.equal(f.app.snapshot('model-test-client').session.messages.at(-1).status,'failed');
});
