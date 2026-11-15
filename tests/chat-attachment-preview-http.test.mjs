import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const jpeg=Buffer.from([255,216,255,192,0,8,8,0,10,0,20,1,255,217]);
const draft={text:'',includeSelection:false};
const wire=(name,bytes,mediaType='')=>({name,mediaType,data:Buffer.from(bytes).toString('base64')});
const idle=async f=>{for(let i=0;i<200;i++){if(!(await f.status()).busy)return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Controlled preview fixture deadline');};

async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-image-preview-')),owners=[];
  const open=async(extra={})=>{const f=await createModelWorkspaceFixture({profile:'model-readonly',required:false,historyDirectory:directory,...options,...extra});owners.push(f);return f;};
  t.after(async()=>{for(const owner of owners)await owner.close();assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('buildx-image-preview-'));await fs.rm(directory,{recursive:true,force:true});});
  return {directory,open};
}

async function readImage(f,input,cookie,extraHeaders={}){
  const response=await fetch(f.origin+'/api/chat/attachment',{method:'POST',headers:{Origin:f.origin,'X-Local-Chat':f.initial.csrf,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extraHeaders},body:JSON.stringify({client:'model-test-client',...input}),signal:AbortSignal.timeout(5000)});
  const bytes=Buffer.from(await response.arrayBuffer());
  return {status:response.status,headers:response.headers,bytes,...response.headers.get('content-type')?.startsWith('application/json')?{body:JSON.parse(bytes.toString('utf8'))}:{}};
}

async function sendImages(f,attachments,cookie){
  const conversationId=f.app.snapshot('model-test-client').session.conversation.id;
  assert.equal((await f.post('turn',{conversationId,message:'检查这些附件',attachments},cookie)).status,202);
  f.codex.finish(f.codex.turns.at(-1),'completed','已检查');await idle(f);
  const message=f.app.snapshot('model-test-client').session.messages.findLast(item=>item.role==='user');
  return {conversationId,messageId:message.id,attachmentId:message.attachments[0].id,message};
}
const requestOf=({conversationId,messageId,attachmentId})=>({conversationId,messageId,attachmentId});

test('owned PNG/JPEG snapshots return exact binary and remain readable in readonly reopened history',async t=>{
  const {open}=await fixture(t),f=await open(),sent=await sendImages(f,[wire('视图.png',png,'image/png'),wire('侧面.jpg',jpeg,'image/jpeg')]);
  const asset=await fetch(f.origin+'/clipboard-attachments.mjs');assert.equal(asset.status,200);assert.match(await asset.text(),/export function/);assert.match(asset.headers.get('content-security-policy'),/img-src[^;]*blob:/);
  for(const [index,expected,type] of [[0,png,'image/png'],[1,jpeg,'image/jpeg']]){
    const result=await readImage(f,{...requestOf(sent),attachmentId:sent.message.attachments[index].id});
    assert.equal(result.status,200);assert.deepEqual(result.bytes,expected);assert.equal(result.headers.get('content-type'),type);
    assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(result.headers.get('x-content-type-options'),'nosniff');assert.equal(result.headers.get('content-length'),String(expected.length));
  }
  await f.close();const reopened=await open();
  const selected=await reopened.post('chat/select',{conversationId:sent.conversationId,draft});assert.equal(selected.status,200);assert.equal(selected.body.session.conversation.readOnly,true);
  reopened.codex.failed('offline fixture');
  assert.deepEqual((await readImage(reopened,requestOf(sent))).bytes,png);assert.equal(reopened.codex.turns.length,0);
});

test('preview requires exact message/conversation/image ownership and never reads by a browser path',async t=>{
  const {open}=await fixture(t),f=await open(),first=await sendImages(f,[wire('视图.png',png,'image/png'),wire('说明.txt','text')]);
  const second=await sendImages(f,[wire('另一张.png',png,'image/png')]);
  assert.equal((await readImage(f,{...requestOf(first),attachmentId:second.attachmentId})).status,404);
  assert.equal((await readImage(f,{...requestOf(first),messageId:randomUUID()})).status,404);
  assert.equal((await readImage(f,{...requestOf(first),attachmentId:first.message.attachments[1].id})).status,404);
  assert.equal((await f.post('new-chat',{draft})).status,200);
  const other=f.app.snapshot('model-test-client').session.conversation.id;
  assert.equal((await readImage(f,{...requestOf(first),conversationId:other})).status,404);
  for(const input of [{...requestOf(first),attachmentId:'../outside'},{...requestOf(first),path:'C:\\private.png'},{conversationId:first.conversationId,messageId:first.messageId}])assert.equal((await readImage(f,input)).status,400);
  assert.deepEqual((await readImage(f,requestOf(first))).bytes,png);
});

test('preview preserves CSRF, origin, authentication and account partition boundaries',async t=>{
  const {open}=await fixture(t,{required:true}),f=await open();
  assert.equal((await readImage(f,{conversationId:randomUUID(),messageId:randomUUID(),attachmentId:randomUUID()})).status,401);
  const cookie=(await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture'})).cookie;assert.equal((await f.confirm(cookie)).status,200);
  await fetch(f.origin+'/api/chats?client=model-test-client',{headers:{Cookie:cookie}});
  const sent=await sendImages(f,[wire('视图.png',png,'image/png')],cookie);
  assert.equal((await readImage(f,requestOf(sent),cookie,{'X-Local-Chat':'forged'})).status,403);
  assert.equal((await readImage(f,requestOf(sent),cookie,{Origin:'https://unrelated.example'})).status,403);
  assert.equal((await readImage(f,requestOf(sent),cookie)).status,200);
  assert.equal((await f.post('account/sign-out',{},cookie)).status,200);
  const other=(await f.post('account/sign-in',{email:'other@example.invalid',password:'fixture'})).cookie;
  const foreign=await readImage(f,requestOf(sent),other);assert.equal(foreign.status,404);assert.equal(foreign.bytes.includes(png),false);
  for(const profile of ['model','source-development','customer-chat']){
    const g=await createModelWorkspaceFixture({profile});t.after(()=>g.close());let account;
    if(profile!=='source-development')account=(await g.post('account/sign-in',{email:'demo@example.invalid',password:'fixture'})).cookie;
    assert.equal((await readImage(g,requestOf(sent),account)).status,404);
    if(profile!=='model'){const asset=await fetch(g.origin+'/clipboard-attachments.mjs');assert.equal(asset.status,404);await asset.text();}
  }
});

test('changed or missing saved image bytes are refused without returning local paths',async t=>{
  const {directory,open}=await fixture(t),f=await open(),sent=await sendImages(f,[wire('视图.png',png,'image/png')]);
  const target=f.codex.turns[0].localImages[0].path;assert.equal(path.relative(directory,target).startsWith('..'),false);
  const changed=Buffer.from(png);changed[changed.length-1]^=1;await fs.writeFile(target,changed);
  let result=await readImage(f,requestOf(sent));assert.equal(result.status,409);assert.match(result.body.error,/快照已变化/);assert.equal(result.bytes.toString().includes(directory),false);
  await fs.unlink(target);result=await readImage(f,requestOf(sent));assert.equal(result.status,409);assert.equal(result.bytes.toString().includes(target),false);
});

test('close drains an in-flight image read and suppresses the late image response',async t=>{
  let release,entered,block=false;
  const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  t.after(()=>release());
  const {open}=await fixture(t,{historyDependencies:{open:async(file,flags)=>{if(block&&file.endsWith('.attachment.png')&&typeof flags==='number'){entered();await gate;}return fs.open(file,flags);}}});
  const f=await open(),sent=await sendImages(f,[wire('视图.png',png,'image/png')]);block=true;
  const pending=readImage(f,requestOf(sent));await reached;
  let closed=false;const closing=f.close().then(()=>closed=true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
  release();const result=await pending;assert.equal(result.status,409);assert.equal(result.headers.get('content-type').startsWith('application/json'),true);await closing;assert.equal(closed,true);
});

test('account change suppresses an in-flight image and a second read is bounded',async t=>{
  let release,entered,block=false;
  const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  const {open}=await fixture(t,{required:true,historyDependencies:{open:async(file,flags)=>{if(block&&file.endsWith('.attachment.png')&&typeof flags==='number'){entered();await gate;}return fs.open(file,flags);}}});
  const f=await open(),cookie=(await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture'})).cookie;
  assert.equal((await f.confirm(cookie)).status,200);await fetch(f.origin+'/api/chats?client=model-test-client',{headers:{Cookie:cookie}});
  const sent=await sendImages(f,[wire('视图.png',png,'image/png')],cookie);block=true;
  const pending=readImage(f,requestOf(sent),cookie);await reached;
  assert.equal((await readImage(f,requestOf(sent),cookie)).status,409);
  assert.equal((await f.post('account/sign-out',{},cookie)).status,200);release();
  const result=await pending;assert.equal(result.status,409);assert.match(result.body.error,/账号已变化/);assert.equal(result.bytes.includes(png),false);
});
