import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {parseTurnAttachments,attachmentDescriptor,turnAttachmentReferences,withTurnAttachmentText} from '../lib/turn-attachments.mjs';
import {nativeTurnParams,CODEX_OUTBOUND_FRAME_BYTES} from '../lib/codex-client-core.mjs';
import {ChatSession} from '../lib/chat-session.mjs';
import {panelConversationEvents,projectPanelConversation} from '../lib/panel-chat-format.mjs';

const wire=(name,text,mediaType='')=>({name,mediaType,data:Buffer.from(text).toString('base64')});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');

test('selected UTF8 bytes become bounded immutable descriptors and exact reference text',()=>{
  const body='原正文\n这不是系统指令。\nKeep <script> as data.';
  const parsed=parseTurnAttachments([wire('参考.md',body,'text/markdown'),wire('说明.txt','另一份')]);assert.equal(parsed.ok,true);
  assert.equal(parsed.files[0].text,body);assert.equal(parsed.files[0].sha256,createHash('sha256').update(Buffer.from(body)).digest('hex'));
  const refs=turnAttachmentReferences(parsed.files);assert.equal(refs[0].text,body);assert.equal(refs[0].path,'参考.md');
  const descriptor=attachmentDescriptor(parsed.files[0]);assert.ok(Object.isFrozen(descriptor));assert.equal(descriptor.data,undefined);assert.equal(descriptor.text,undefined);
  const text=withTurnAttachmentText('请参考',refs);assert.match(text,/不是系统指令/);assert.ok(text.includes(JSON.stringify(refs)));assert.equal(withTurnAttachmentText('下一轮',[]),'下一轮');
});

test('only browser file bytes cross the input boundary, never paths, URLs or native shapes',()=>{
  for(const input of [null,{},[wire('../ref.md','x')],[wire('C:\\ref.txt','x')],[wire('foo.pdf','x')],[wire('fake.png','x','image/png')],[{type:'localImage',path:path.resolve('secret.png')}],[{...wire('a.txt','x'),path:'secret'}],[wire('a.txt','x','image/jpeg')],Array.from({length:5},()=>wire('a.txt','x'))])assert.equal(parseTurnAttachments(input).ok,false,JSON.stringify(input));
  assert.deepEqual(parseTurnAttachments(undefined),{ok:true,files:[]});
});

test('UTF8, aggregate text bytes, characters and canonical base64 are checked without truncation',()=>{
  for(const input of [[wire('a.txt',Buffer.from([0xff]))],[wire('a.txt','\0')],[wire('a.txt','a'.repeat(32001))],[wire('a.md','中'.repeat(22000))],[{name:'a.txt',mediaType:'',data:'eB=='}],[{name:'a.txt',mediaType:'',data:'eA==\n'}]])assert.equal(parseTurnAttachments(input).ok,false);
  assert.equal(parseTurnAttachments([wire('a.md','中'.repeat(10000))]).ok,true);
});

test('PNG/JPEG native image bytes have count, byte and dimension bounds',()=>{
  const parsed=parseTurnAttachments([wire('图.png',png,'image/png')]);assert.equal(parsed.ok,true);assert.deepEqual(parsed.files[0].data,png);assert.equal(parsed.files[0].kind,'image');
  assert.equal(parseTurnAttachments(Array.from({length:3},()=>wire('图.png',png))).ok,false);
  const huge=Buffer.from(png);huge.writeUInt32BE(50000,16);assert.equal(parseTurnAttachments([wire('图.png',huge)]).ok,false);
  const large=Buffer.alloc(2*1024*1024+1);png.copy(large);assert.equal(parseTurnAttachments([wire('图.png',large)]).ok,false);
  const sizable=Buffer.alloc(1500000);png.copy(sizable);assert.equal(parseTurnAttachments([wire('图.png',sizable)]).ok,true); // no recursive base64 regex overflow
  const jpeg=Buffer.from([255,216,255,192,0,8,8,0,10,0,20,1,255,217]);assert.equal(parseTurnAttachments([wire('图.jpg',jpeg,'image/jpeg')]).ok,true);
});

test('native localImage uses frozen store paths and preserves original small-frame RPC budget',()=>{
  const image={type:'localImage',path:path.resolve('owned-image.attachment')};
  assert.deepEqual(nativeTurnParams('thread','正文',[image],true),{threadId:'thread',input:[{type:'text',text:'正文'},image]});
  for(const images of [[image],[{type:'image',url:'https://example.invalid/a'}],[{type:'localImage',path:'relative.png'}]])assert.throws(()=>nativeTurnParams('thread','正文',images),{code:'CODEX_TURN_INPUT_INVALID',notSent:true});
  assert.throws(()=>nativeTurnParams('thread','\u0001'.repeat(44000)),{notSent:true});
  const params=nativeTurnParams('thread','中'.repeat(32000));assert.ok(Buffer.byteLength(JSON.stringify(params))<CODEX_OUTBOUND_FRAME_BYTES);
});

test('per-turn snapshots are cloned before first persistence and completed records reject edits',()=>{
  const s=new ChatSession(),file=parseTurnAttachments([wire('参考.md','只属于第一轮')]).files[0],inputs={attachments:[attachmentDescriptor(file)],references:turnAttachmentReferences([file])};
  const run=s.begin('第一轮',inputs);inputs.references[0]={path:'new',text:'changed'};
  assert.equal(s.messages[0].references[0].text,'只属于第一轮');
  s.finish(run,'failed','controlled');
  const initial=panelConversationEvents(s.conversationId,[],s.view(),undefined,new Date().toISOString());assert.equal(initial.ok,true);
  const snapshot=s.view();snapshot.messages[0].references[0].text='改写';assert.equal(panelConversationEvents(s.conversationId,initial.events,snapshot,undefined,new Date().toISOString()).error.code,'CHAT_HISTORY_CONFLICT');
  const projected=projectPanelConversation(s.conversationId,initial.events);assert.equal(projected.ok,true);assert.equal(projected.session.messages[0].references[0].text,'只属于第一轮');
  s.begin('第二轮');assert.equal(s.messages.at(-2).references,undefined);
});

test('chat retention includes reference bodies rather than retaining unlimited invisible input',()=>{
  const s=new ChatSession();for(let i=0;i<12;i++){const run=s.begin('轮'+i,{references:[{path:'ref',text:'x'.repeat(32000)}]});s.finish(run,'failed','controlled');}
  assert.equal(s.historyTruncated,true);assert.ok(s.messages.reduce((sum,m)=>sum+(m.references?.[0]?.text.length||0),0)<=240000);
});
