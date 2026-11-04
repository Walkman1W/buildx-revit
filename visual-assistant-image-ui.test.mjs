import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createInputUi,flush} from './test-support/model-input-ui-fixture.mjs';

test('assistant native screenshots are viewable in readonly history through the same bound image endpoint',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());
  const message={id:randomUUID(),role:'assistant',text:'已隔离并截图，原视图保持不变。',status:'completed',tools:[],attachments:[{id:randomUUID(),name:'视图截图-isometric.png',kind:'image',mediaType:'image/png',bytes:33,sha256:'a'.repeat(64)}]};
  const before=JSON.stringify(message);ui.conversation('history-chat',[message],true);
  const card=ui.document.body.querySelectorAll('.model-sent-image')[0];assert.ok(card);card.click();await flush();
  const request=ui.requests.find(item=>item.url==='/api/chat/attachment');assert.ok(request);assert.equal(request.body.conversationId,'history-chat');assert.equal(request.body.messageId,message.id);assert.equal(request.body.attachmentId,message.attachments[0].id);assert.equal(request.options.headers['X-Local-Chat'],'fixture-csrf');
  request.resolve({ok:true,headers:new Map([['Content-Type','image/png'],['Content-Length','33']]),blob:async()=>new Blob([new Uint8Array(33)],{type:'image/png'})});await flush();
  assert.equal(ui.imageUrls.length,1);assert.equal(JSON.stringify(message),before);
  ui.conversation('another-chat');assert.equal(ui.imageUrls[0].revoked,true);assert.equal(ui.document.body.querySelectorAll('.model-image-preview').length,0);
});
