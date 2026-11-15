import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,file,flush,UiEvent,deferred} from '../test-support/model-input-ui-fixture.mjs';

const png=Uint8Array.of(137,80,78,71),attachmentId='11111111-1111-4111-8111-111111111111';
const sent=()=>({id:'sent-user',role:'user',text:'请检查截图',status:'completed',tools:[],attachments:[{id:attachmentId,name:'检查.png',kind:'image',mediaType:'image/png',bytes:png.length,sha256:'a'.repeat(64)}]});
const imageResponse=()=>({ok:true,headers:new Map([['Content-Type','image/png'],['Content-Length',String(png.length)]]),blob:async()=>new Blob([png],{type:'image/png'})});

test('image paste stages original bytes, leaves ordinary text paste alone, and keeps limits',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());
  const prompt=ui.get('prompt'),text=new UiEvent('paste',{clipboardData:{items:[{kind:'string',type:'text/plain'}],files:[]}});
  prompt.dispatchEvent(text);await flush();assert.equal(text.defaultPrevented,undefined);assert.equal(ui.view().attachments.length,0);
  const input=file('',png,'image/png'),paste=new UiEvent('paste',{clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:()=>input}],files:[input]}});
  prompt.dispatchEvent(paste);await flush();assert.equal(paste.defaultPrevented,true);assert.equal(ui.view().attachments.length,1);assert.equal(ui.view().attachments[0].name,'截图-1.png');
  const thumb=ui.document.body.querySelectorAll('.model-image-thumbnail')[0];assert.equal(thumb.children[0].src,ui.imageUrls[0].url);assert.equal(ui.requests.length,0);
  assert.deepEqual(new Uint8Array(await ui.imageUrls[0].blob.arrayBuffer()),png);
  const tooMany=new UiEvent('paste',{clipboardData:{items:Array.from({length:2},()=>({kind:'file',type:'image/png',getAsFile:()=>input}))}});
  prompt.dispatchEvent(tooMany);await flush();assert.equal(ui.view().attachments.length,1);assert.match(ui.get('error-notice').textContent,/最多.*2.*图片/);
});

test('file drop uses the same admission, blocks document navigation, and respects readonly mode',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());const transfer={types:['Files'],files:[file('原图.png',png,'image/png')]};
  const over=new UiEvent('dragover',{dataTransfer:transfer});ui.get('composer').dispatchEvent(over);assert.equal(over.defaultPrevented,true);assert.equal(transfer.dropEffect,'copy');
  const drop=new UiEvent('drop',{dataTransfer:transfer});ui.get('composer').dispatchEvent(drop);await flush();assert.equal(drop.defaultPrevented,true);assert.equal(ui.view().attachments.length,1);
  const outside=new UiEvent('drop',{dataTransfer:transfer});ui.document.dispatchEvent(outside);assert.equal(outside.defaultPrevented,true);assert.equal(ui.view().attachments.length,1);
  ui.conversation('history',[],true);const denied=new UiEvent('drop',{dataTransfer:transfer});ui.get('composer').dispatchEvent(denied);await flush();assert.equal(denied.defaultPrevented,true);assert.equal(ui.view().attachments.length,0);
  const paste=new UiEvent('paste',{clipboardData:transfer});ui.get('prompt').dispatchEvent(paste);await flush();assert.equal(ui.view().attachments.length,0);
});

test('pending image preview closes on context changes and draft URLs release on remove and account clear',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());await ui.add([file('A.png',png)]);
  ui.document.body.querySelectorAll('.model-image-thumbnail')[0].click();await flush();assert.equal(ui.document.body.querySelectorAll('.model-image-preview').length,1);
  ui.conversation('chat-b');assert.equal(ui.document.body.querySelectorAll('.model-image-preview').length,0);assert.equal(ui.imageUrls[0].revoked,false);
  ui.conversation('chat-a');await ui.remove(ui.view().attachments[0].id);assert.equal(ui.imageUrls[0].revoked,true);
  await ui.add([file('B.png',png)]);await ui.close();assert.equal(ui.imageUrls[1].revoked,true);
});

test('sent image loads only on click using exact auth and message binding and releases its URL on close',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());ui.conversation('past',[sent()],true);assert.equal(ui.requests.length,0);
  ui.document.body.querySelectorAll('.model-sent-image')[0].click();await flush();const request=ui.requests[0];
  assert.equal(request.url,'/api/chat/attachment');assert.equal(request.options.headers['X-Local-Chat'],'fixture-csrf');
  assert.deepEqual(request.body,{client:'ui-id-1',conversationId:'past',messageId:'sent-user',attachmentId});
  request.resolve(imageResponse());await flush();assert.equal(ui.document.body.querySelectorAll('.model-image-full')[0].src,ui.imageUrls[0].url);
  ui.document.body.querySelectorAll('.model-image-close')[0].click();assert.equal(ui.imageUrls[0].revoked,true);assert.equal(ui.document.body.querySelectorAll('.model-image-preview').length,0);
});

test('late image response after a conversation switch cannot create an image URL or show the old image',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());ui.conversation('chat-a',[sent()]);ui.document.body.querySelectorAll('.model-sent-image')[0].click();await flush();const request=ui.requests[0];
  ui.conversation('chat-b');assert.equal(request.options.signal.aborted,true);request.resolve(imageResponse());await flush();
  assert.equal(ui.imageUrls.length,0);assert.equal(ui.document.body.querySelectorAll('.model-image-preview').length,0);
});

test('mismatched image response is shown as a failure and never decoded',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());ui.conversation('chat-a',[sent()]);ui.document.body.querySelectorAll('.model-sent-image')[0].click();await flush();const request=ui.requests[0];let reads=0;
  request.resolve({ok:true,headers:new Map([['Content-Type','image/jpeg'],['Content-Length',String(png.length)]]),blob:async()=>{reads++;return new Blob();}});await flush();
  assert.equal(reads,0);assert.equal(ui.imageUrls.length,0);assert.match(ui.document.body.querySelectorAll('.model-image-status')[0].textContent,/不一致/);
});

test('Escape closes preview; pagehide releases drafts and invalidates an unfinished file read',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());await ui.add([file('A.png',png)]);
  ui.document.body.querySelectorAll('.model-image-thumbnail')[0].click();await flush();
  const escape=new UiEvent('keydown',{key:'Escape'});ui.window.dispatchEvent(escape);assert.equal(escape.defaultPrevented,true);assert.equal(ui.document.body.querySelectorAll('.model-image-preview').length,0);
  const read=deferred(),pending=ui.add([{name:'迟到.png',size:png.length,arrayBuffer:()=>read.promise}]);await flush();
  ui.window.dispatchEvent(new UiEvent('pagehide'));assert.equal(ui.imageUrls[0].revoked,true);read.resolve(png.slice().buffer);await pending;
  assert.equal(ui.view().attachments.length,0);assert.equal(ui.imageUrls.length,1);
});
