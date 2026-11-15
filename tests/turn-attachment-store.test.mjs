import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createChatStore,createPanelChatStore} from '../lib/chat-store.mjs';
import {ChatSession} from '../lib/chat-session.mjs';

const scope='model:user:turn-attachment-fixture';
const hash=value=>createHash('sha256').update(value).digest('hex');
const file=(text='附件正文',options={})=>{const data=Buffer.from(text);return {id:randomUUID(),name:'参考.md',kind:'text',mediaType:'text/markdown',bytes:data.length,sha256:hash(data),data,...options};};
async function fixture(t,dependencies={}){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-turn-files-')),stateDirectory=path.join(temporary,'history'),stores=[];
  const make=()=>{const owner=createPanelChatStore({stateDirectory},dependencies);stores.push(owner);return owner;},store=make();
  t.after(async()=>{for(const owner of stores){let closed=await owner.close();if(!closed.ok&&closed.error.cleanupId){await owner.cleanup(closed.error.cleanupId);closed=await owner.close();}assert.equal(closed.ok,true);}const target=path.resolve(temporary);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep));assert.equal((await fs.lstat(target)).isSymbolicLink(),false);assert.equal((await fs.realpath(target)).toLowerCase(),target.toLowerCase());await fs.rm(target,{recursive:true,force:true});});
  return {temporary,stateDirectory,store,make,directory:(partition=scope)=>path.join(stateDirectory,hash(partition)),attachment:(id,partition=scope)=>path.join(stateDirectory,hash(partition),id+'.attachment'),image:(id,mediaType='image/png',partition=scope)=>path.join(stateDirectory,hash(partition),id+(mediaType==='image/png'?'.attachment.png':'.attachment.jpg'))};
}

test('production owner snapshots bounded bytes once and restores exact content after close/reopen',async t=>{
  const f=await fixture(t),text=file(),image=file('not-decoded-in-store',{name:'image.png',kind:'image',mediaType:'image/png'});
  assert.equal(Object.isFrozen(f.store),true);const pending=f.store.saveTurnAttachments(scope,[text,image]);text.data.fill(0);
  const value=await pending;assert.equal(value.ok,true);assert.equal(Object.isFrozen(value.attachments),true);assert.equal(Object.isFrozen(value.attachments[0]),true);
  assert.equal(Object.hasOwn(value.attachments[0],'data'),false);assert.equal(Object.hasOwn(value.attachments[0],'text'),false);
  assert.deepEqual(value.localImages,[{type:'localImage',path:f.image(image.id)}]);
  const read=await f.store.readTurnAttachment(scope,text.id);assert.equal(read.bytes.toString(),'附件正文');assert.equal(read.sha256,text.sha256);assert.equal(read.size,Buffer.byteLength('附件正文'));
  assert.equal((await f.store.close()).ok,true);const restored=await f.make().readTurnAttachment(scope,image.id);assert.equal(restored.ok,true);assert.deepEqual(restored.bytes,image.data);
  assert.deepEqual((await fs.readdir(f.directory())).sort(),[text.id+'.attachment',image.id+'.attachment.png'].sort());
});

test('attachments are partitioned, have opaque names and do not change JSONL or history listing',async t=>{
  const f=await fixture(t),session=new ChatSession();session.add('user','已发送正文');assert.equal((await f.store.save(scope,session.view())).ok,true);
  const jsonl=path.join(f.directory(),session.conversationId+'.jsonl'),before=await fs.readFile(jsonl),attachment=file();
  assert.equal((await f.store.saveTurnAttachments(scope,[attachment])).ok,true);
  assert.equal((await f.store.readTurnAttachment('model:user:other',attachment.id)).error.code,'CHAT_SESSION_NOT_FOUND');
  assert.deepEqual(await fs.readFile(jsonl),before);assert.deepEqual((await f.store.list(scope)).sessions.map(item=>item.id),[session.conversationId]);
  assert.equal((await f.store.get(scope,session.conversationId)).session.messages[0].text,'已发送正文');
  assert.ok(!(await fs.readdir(f.directory())).some(name=>name.includes('参考')));
});

test('invalid attachment inputs reject before creating a directory',async t=>{
  const f=await fixture(t),valid=file(),tooLarge=Buffer.alloc(2*1024*1024+1);
  const invalid=[null,{},[...Array.from({length:5},()=>file())],[file('x',{id:'../outside'})],[file('x',{id:randomUUID().toUpperCase()})],[valid,{...valid}],[file('x',{kind:'image',mediaType:'text/plain'})],[file('x',{kind:'image',mediaType:'image/webp'})],[file('x',{name:'bad\0name'})],[file('x',{bytes:7})],[file('x',{sha256:'0'.repeat(64)})],[file('x',{data:'x'})],[file('x',{data:tooLarge,bytes:tooLarge.length,sha256:hash(tooLarge)})],[file('x',{unknown:true})]];
  for(const value of invalid)assert.equal((await f.store.saveTurnAttachments(scope,value)).ok,false);
  assert.equal((await f.store.saveTurnAttachments('',[valid])).error.code,'CHAT_SCOPE_INVALID');
  await assert.rejects(fs.lstat(f.stateDirectory),{code:'ENOENT'});
});

test('four MiB aggregate and matching media types are independent store bounds',async t=>{
  const f=await fixture(t),large=Buffer.alloc(2*1024*1024,1),a=file('x',{data:large,bytes:large.length,sha256:hash(large)}),b=file('x',{data:large,bytes:large.length,sha256:hash(large)});
  assert.equal((await f.store.saveTurnAttachments(scope,[a,b,file('extra')])).error.code,'CHAT_ATTACHMENT_LIMIT');
  await assert.rejects(fs.lstat(f.stateDirectory),{code:'ENOENT'});
  assert.equal((await f.store.saveTurnAttachments(scope,[a,b])).ok,true);
  const jpeg=file('jpeg-bytes',{name:'photo.jpg',kind:'image',mediaType:'image/jpeg'});assert.equal((await f.store.saveTurnAttachments(scope,[jpeg])).ok,true);
  const plain=file('text',{name:'readme.txt',kind:'text',mediaType:'text/plain'});assert.equal((await f.store.saveTurnAttachments(scope,[plain])).ok,true);
});

test('name conflicts are preflighted for the whole batch without overriding existing bytes',async t=>{
  const f=await fixture(t),existing=file('old'),next=file('new');assert.equal((await f.store.saveTurnAttachments(scope,[existing])).ok,true);
  const changed=file('replacement',{id:existing.id});assert.equal((await f.store.saveTurnAttachments(scope,[next,changed])).error.code,'CHAT_ATTACHMENT_EXISTS');
  assert.equal((await f.store.readTurnAttachment(scope,existing.id)).bytes.toString(),'old');await assert.rejects(fs.lstat(f.attachment(next.id)),{code:'ENOENT'});
});

test('one exclusive store owner covers both attachment and transcript methods',async t=>{
  const f=await fixture(t),attachment=file();assert.equal((await f.store.saveTurnAttachments(scope,[attachment])).ok,true);
  const other=f.make();assert.equal((await other.saveTurnAttachments(scope,[file()])).error.code,'CHAT_STORE_LOCKED');
  assert.equal((await other.readTurnAttachment(scope,attachment.id)).error.code,'CHAT_STORE_LOCKED');
  assert.equal((await other.close()).ok,true);assert.equal((await f.store.readTurnAttachment(scope,attachment.id)).ok,true);
});

test('partial write failure retains successful and incomplete snapshots without automatic deletion',async t=>{
  let opened=0;const f=await fixture(t,{open:async(name,flags)=>{const handle=await fs.open(name,flags);if(name.endsWith('.attachment')&&++opened===2)handle.writeFile=async()=>{throw new Error('fixture-write');};return handle;}}),a=file('first'),b=file('second');
  const result=await f.store.saveTurnAttachments(scope,[a,b]);assert.equal(result.ok,false);assert.equal(result.partial,true);assert.equal(result.retainedSnapshots,true);assert.deepEqual(result.createdIds,[a.id,b.id]);assert.deepEqual(result.attachments.map(value=>value.id),[a.id]);
  assert.equal((await f.store.readTurnAttachment(scope,a.id)).bytes.toString(),'first');assert.equal((await fs.lstat(f.attachment(b.id))).size,0);
  assert.equal((await f.store.saveTurnAttachments(scope,[file('retry',{id:b.id})])).error.code,'CHAT_ATTACHMENT_EXISTS');
});

test('attachment close failure retains its handle and blocks work until exact cleanup',async t=>{
  let failClose=true;const f=await fixture(t,{open:async(name,flags)=>{const handle=await fs.open(name,flags);if(name.endsWith('.attachment')){const close=handle.close.bind(handle);handle.close=async()=>{if(failClose){failClose=false;throw new Error('fixture-close');}return close();};}return handle;}}),attachment=file();
  const saved=await f.store.saveTurnAttachments(scope,[attachment]);assert.equal(saved.error.code,'CHAT_CLEANUP_PENDING');assert.ok(saved.error.cleanupId);assert.equal(saved.partial,true);
  assert.equal((await f.store.readTurnAttachment(scope,attachment.id)).error.code,'CHAT_CLEANUP_PENDING');
  assert.equal((await f.store.cleanup(saved.error.cleanupId)).ok,true);assert.deepEqual((await f.store.readTurnAttachment(scope,attachment.id)).bytes,attachment.data);
});

test('same-owner concurrent batches serialize name admission and close drains queued work',async t=>{
  const f=await fixture(t),attachment=file(),first=f.store.saveTurnAttachments(scope,[attachment]),second=f.store.saveTurnAttachments(scope,[attachment]),closing=f.store.close();
  assert.equal((await first).ok,true);assert.equal((await second).error.code,'CHAT_ATTACHMENT_EXISTS');assert.equal((await closing).ok,true);
  assert.equal((await f.store.saveTurnAttachments(scope,[file()])).error.code,'CHAT_STORE_CLOSED');assert.equal((await f.store.readTurnAttachment(scope,attachment.id)).error.code,'CHAT_STORE_CLOSED');
});

test('hardlinked attachments are refused on read and during capacity admission',async t=>{
  const f=await fixture(t),attachment=file();assert.equal((await f.store.saveTurnAttachments(scope,[attachment])).ok,true);const alias=path.join(f.temporary,'alias');await fs.link(f.attachment(attachment.id),alias);
  const before=await fs.readFile(alias);assert.equal((await f.store.readTurnAttachment(scope,attachment.id)).error.code,'CHAT_LOG_INVALID');
  const next=file();assert.equal((await f.store.saveTurnAttachments(scope,[next])).error.code,'CHAT_LOG_INVALID');assert.deepEqual(await fs.readFile(alias),before);await assert.rejects(fs.lstat(f.attachment(next.id)),{code:'ENOENT'});
});

test('symbolic attachment file cannot redirect a read or a new batch',async t=>{
  const f=await fixture(t),seed=file();await f.store.saveTurnAttachments(scope,[seed]);const outside=path.join(f.temporary,'outside'),id=randomUUID();await fs.writeFile(outside,'outside');
  try{await fs.symlink(outside,f.attachment(id),'file');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Host forbids symbolic file creation');return;}throw error;}
  assert.equal((await f.store.readTurnAttachment(scope,id)).ok,false);assert.equal((await f.store.saveTurnAttachments(scope,[file()])).ok,false);assert.equal(await fs.readFile(outside,'utf8'),'outside');
});

test('capacity counts partial zero-byte files and refuses the 513th snapshot before creating it',async t=>{
  const f=await fixture(t),seed=file();await f.store.saveTurnAttachments(scope,[seed]);
  for(let index=1;index<512;index++)await fs.writeFile(f.attachment(randomUUID()),'');
  const next=file(),value=await f.store.saveTurnAttachments(scope,[next]);assert.equal(value.error.code,'CHAT_ATTACHMENT_LIMIT');await assert.rejects(fs.lstat(f.attachment(next.id)),{code:'ENOENT'});assert.equal((await fs.readdir(f.directory())).length,512);
});

test('scope byte capacity is checked from actual stat sizes before saving another attachment',async t=>{
  // Only this internal test owner shrinks the same production quota algorithm;
  // browser input cannot configure it and values cannot exceed 256 MiB.
  const f=await fixture(t,{attachmentScopeBytes:2048}),seed=file('x');await f.store.saveTurnAttachments(scope,[seed]);await fs.truncate(f.attachment(seed.id),1024);
  await fs.writeFile(f.attachment(randomUUID()),Buffer.alloc(1024));
  const next=file();assert.equal((await f.store.saveTurnAttachments(scope,[next])).error.code,'CHAT_ATTACHMENT_LIMIT');await assert.rejects(fs.lstat(f.attachment(next.id)),{code:'ENOENT'});
  for(const quota of [0,-1,256*1024*1024+1,Infinity,'2048'])assert.throws(()=>createPanelChatStore({stateDirectory:f.stateDirectory},{attachmentScopeBytes:quota}));
});

test('unverifiable attachment names and oversized existing snapshots fail closed',async t=>{
  const f=await fixture(t),seed=file();await f.store.saveTurnAttachments(scope,[seed]);const invalid=path.join(f.directory(),'unknown.attachment');await fs.writeFile(invalid,'');
  assert.equal((await f.store.saveTurnAttachments(scope,[file()])).error.code,'CHAT_ATTACHMENT_INVALID');await fs.unlink(invalid);await fs.truncate(f.attachment(seed.id),2*1024*1024+1);
  assert.equal((await f.store.readTurnAttachment(scope,seed.id)).error.code,'CHAT_LOG_LIMIT');assert.equal((await f.store.saveTurnAttachments(scope,[file()])).error.code,'CHAT_ATTACHMENT_LIMIT');
});

test('scope directory replacement is rejected without adopting its replacement',async t=>{
  const f=await fixture(t),seed=file();await f.store.saveTurnAttachments(scope,[seed]);const moved=path.join(f.temporary,'original-scope');await fs.rename(f.directory(),moved);await fs.mkdir(f.directory());
  const next=file();assert.equal((await f.store.saveTurnAttachments(scope,[next])).error.code,'CHAT_DIRECTORY_CHANGED');assert.equal((await f.store.readTurnAttachment(scope,seed.id)).error.code,'CHAT_DIRECTORY_CHANGED');
  assert.deepEqual(await fs.readdir(f.directory()),[]);assert.deepEqual(await fs.readFile(path.join(moved,seed.id+'.attachment')),seed.data);
});

test('fixed extension candidates preserve image names, reject collisions and never guess ambiguous IDs',async t=>{
  const f=await fixture(t),png=file('png',{kind:'image',mediaType:'image/png',name:'a.png'}),jpeg=file('jpeg',{kind:'image',mediaType:'image/jpeg',name:'b.jpg'});
  const saved=await f.store.saveTurnAttachments(scope,[png,jpeg]);assert.equal(saved.ok,true);assert.deepEqual(saved.localImages.map(value=>value.path),[f.image(png.id),f.image(jpeg.id,'image/jpeg')]);
  assert.deepEqual((await f.store.readTurnAttachment(scope,png.id)).bytes,png.data);assert.deepEqual((await f.store.readTurnAttachment(scope,jpeg.id)).bytes,jpeg.data);
  assert.equal((await f.store.saveTurnAttachments(scope,[file('text-collision',{id:png.id})])).error.code,'CHAT_ATTACHMENT_EXISTS');
  await fs.writeFile(f.attachment(png.id),'ambiguous');assert.equal((await f.store.readTurnAttachment(scope,png.id)).error.code,'CHAT_ATTACHMENT_AMBIGUOUS');
  assert.equal((await f.store.saveTurnAttachments(scope,[file()])).error.code,'CHAT_ATTACHMENT_AMBIGUOUS');assert.deepEqual(await fs.readFile(f.image(png.id)),png.data);
});

test('replacing a created attachment name during write leaves an explicit unknown result',async t=>{
  let replaced=false;const f=await fixture(t,{open:async(name,flags)=>{const handle=await fs.open(name,flags);if(name.endsWith('.attachment')){const write=handle.writeFile.bind(handle);handle.writeFile=async data=>{if(!replaced){replaced=true;await fs.rename(name,name+'.original');await fs.writeFile(name,'replacement');}return write(data);};}return handle;}}),attachment=file();
  const value=await f.store.saveTurnAttachments(scope,[attachment]);assert.equal(value.error.code,'CHAT_WRITE_UNKNOWN');assert.equal(value.partial,true);assert.deepEqual(value.attachments,[]);assert.equal(value.localImages,undefined);
  assert.equal(await fs.readFile(f.attachment(attachment.id),'utf8'),'replacement');assert.deepEqual(await fs.readFile(f.attachment(attachment.id)+'.original'),attachment.data);
});

test('attachment capacity scanning retains the existing 4096 total-entry budget',async t=>{
  const f=await fixture(t),seed=file();await f.store.saveTurnAttachments(scope,[seed]);
  for(let start=0;start<4096;start+=32)await Promise.all(Array.from({length:32},(_,offset)=>fs.writeFile(path.join(f.directory(),'unrelated-'+(start+offset)),'')));
  const next=file();assert.equal((await f.store.saveTurnAttachments(scope,[next])).error.code,'CHAT_SESSION_LIMIT');await assert.rejects(fs.lstat(f.attachment(next.id)),{code:'ENOENT'});
});

test('attachments are not exposed by prototype store or accepted as transcript names',async t=>{
  const f=await fixture(t),legacy=createChatStore({stateDirectory:path.join(f.temporary,'prototype')});assert.equal(legacy.saveTurnAttachments,undefined);assert.equal(legacy.readTurnAttachment,undefined);await legacy.close();
  for(const id of ['../other','123',randomUUID()+'.attachment',randomUUID().toUpperCase()])assert.equal((await f.store.readTurnAttachment(scope,id)).ok,false);
});
