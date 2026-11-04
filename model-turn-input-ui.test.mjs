import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,file,deferred,flush,UiEvent} from './test-support/model-input-ui-fixture.mjs';

const names=ui=>Array.from(ui.view().attachments,item=>item.name);
test('model plus opens only the native file chooser and shows removable unsent metadata',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());
  const plus=ui.document.body.querySelectorAll('.model-add-file')[0],input=ui.get('composer').children.find(item=>item.tagName==='INPUT');
  assert.equal(plus.hidden,false);plus.click();assert.equal(input.clicked,true);
  assert.equal(input.accept,'.txt,.md,.markdown,.png,.jpg,.jpeg');
  input.files=[file('参考.md','这里是正文')];input.dispatchEvent(new UiEvent('change'));await flush();
  assert.equal(input.value,'');assert.deepEqual(names(ui),['参考.md']);
  const list=ui.document.body.querySelectorAll('.model-pending-attachments')[0];assert.equal(list.hidden,false);assert.match(list.textContent,/参考\.md.*文本/);
  assert.equal(JSON.stringify(ui.view()).includes(Buffer.from('这里是正文').toString('base64')),false);
  list.querySelectorAll('.model-remove-file')[0].click();await flush();assert.deepEqual(names(ui),[]);assert.equal(list.hidden,true);
});

test('send freezes exact raw file bytes and clears only its accepted attachment batch',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());
  const text='第一行\r\n😀原文',bytes=Uint8Array.of(255,216,255,224,5,6);
  await ui.add([file('正文.txt',text),file('照片.JPG',bytes)]);ui.input('  请结合附件回答  ');await ui.submit();
  const request=ui.requests.find(item=>item.url==='/api/turn');assert.equal(request.body.conversationId,'chat-a');assert.equal(request.body.message,'请结合附件回答');
  assert.deepEqual(request.body.attachments,[{name:'正文.txt',mediaType:'text/plain',data:Buffer.from(text).toString('base64')},{name:'照片.JPG',mediaType:'image/jpeg',data:Buffer.from(bytes).toString('base64')}]);
  assert.equal(Object.hasOwn(request.body.draft,'attachments'),false);
  await ui.add([file('下一轮.md','保留下一轮')]);ui.input('下一条草稿');await ui.respond(request);
  assert.deepEqual(names(ui),['下一轮.md']);assert.equal(ui.get('prompt').value,'下一条草稿');
  ui.emit('done',{});await ui.submit();assert.equal(ui.requests.filter(item=>item.url==='/api/turn').length,2);
  assert.deepEqual(ui.requests.filter(item=>item.url==='/api/turn')[1].body.attachments.map(item=>item.name),['下一轮.md']);
});

test('failure and unknown transport preserve staged files and never automatically resend',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());await ui.add([file('保留.txt','必须保留')]);ui.input('这轮请求');await ui.submit();
  const request=ui.requests.find(item=>item.url==='/api/turn');await ui.reject(request,'结果尚未确认');
  assert.deepEqual(names(ui),['保留.txt']);assert.equal(ui.get('prompt').value,'这轮请求');assert.match(ui.get('error-notice').textContent,/结果尚未确认/);
  ui.emit('state',{ready:true,message:'连接已恢复'});await flush();assert.equal(ui.requests.filter(item=>item.url==='/api/turn').length,1);
});

test('conversation switching retains only its own in-memory files and ignores stale reads',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());await ui.add([file('A.txt','A正文')]);
  ui.conversation('chat-b');assert.deepEqual(names(ui),[]);await ui.add([file('B.md','B正文')]);ui.conversation('chat-a');assert.deepEqual(names(ui),['A.txt']);
  const read=deferred();const pending=ui.add([{name:'迟到.txt',size:3,arrayBuffer:()=>read.promise}]);await flush();assert.equal(ui.view().attachmentReading,true);
  ui.conversation('chat-c');read.resolve(Uint8Array.of(65,66,67).buffer);await pending;
  assert.deepEqual(names(ui),[]);assert.equal(ui.view().attachmentReading,false);ui.conversation('chat-a');assert.deepEqual(names(ui),['A.txt']);
  const reopened=await createInputUi();t.after(()=>reopened.close());assert.deepEqual(names(reopened),[]);
});

test('account clear invalidates pending file reads and late turn acknowledgements',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());await ui.add([file('账号A.txt','私有内容')]);ui.input('A请求');await ui.submit();const request=ui.requests.find(item=>item.url==='/api/turn');
  const read=deferred(),pending=ui.add([{name:'迟到私有.txt',size:1,arrayBuffer:()=>read.promise}]);await flush();await ui.close();read.resolve(Uint8Array.of(65).buffer);await pending;await ui.respond(request);
  assert.deepEqual(names(ui),[]);assert.equal(JSON.stringify(ui.view()).includes('账号A.txt'),false);assert.equal(ui.get('prompt').value,'');
});

test('file admission rejects count, image, byte and text budgets before retaining any batch',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());let reads=0;
  const oversized=(name,size)=>({name,size,arrayBuffer:async()=>{reads++;throw new Error('应在读取前拒绝');}});
  for(const [files,expected] of [
    [Array.from({length:5},(_,i)=>file(i+'.txt','a')),/最多.*4/],
    [Array.from({length:3},(_,i)=>file(i+'.png',Uint8Array.of(1))),/最多.*2.*图片/],
    [[oversized('huge.png',2*1024*1024+1)],/2 MiB/],
    [[oversized('big.txt',64*1024+1)],/64 KiB/],
    [[oversized('a.png',2*1024*1024),oversized('b.png',2*1024*1024),oversized('c.txt',1)],/4 MiB/],
    [[file('unsupported.pdf','pdf')],/TXT.*Markdown/],
    [[file('invalid.txt',Uint8Array.of(255))],/UTF-8/],
    [[file('long.md','a'.repeat(32001))],/32000/],
  ]) {await ui.add(files);assert.deepEqual(names(ui),[]);assert.match(ui.get('error-notice').textContent,expected);}
  assert.equal(reads,0);
});

test('browser staging has a global bound across conversation drafts before reading another file',async t=>{
  const ui=await createInputUi({layout:false});t.after(()=>ui.close());
  const bytes=new Uint8Array(2*1024*1024);
  for(let index=0;index<4;index++) {
    ui.conversation('large-'+index);await ui.add([file('a.png',bytes),file('b.jpg',bytes)]);assert.equal(ui.view().attachments.length,2);
  }
  ui.conversation('large-next');let reads=0;await ui.add([{name:'overflow.png',size:1,arrayBuffer:async()=>{reads++;return new ArrayBuffer(1);}}]);
  assert.equal(reads,0);assert.deepEqual(names(ui),[]);assert.match(ui.get('error-notice').textContent,/待发送附件过多/);
});

test('a stale successful acceptance cannot clear files in either later conversation',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());await ui.add([file('A.txt','A')]);ui.input('请求A');await ui.submit();const request=ui.requests.find(item=>item.url==='/api/turn');
  ui.conversation('chat-b');await ui.add([file('B.txt','B')]);await ui.respond(request);
  assert.deepEqual(names(ui),['B.txt']);ui.conversation('chat-a');assert.deepEqual(names(ui),['A.txt']);
});

test('send waits for file read; selection removal excludes bytes from the outgoing request',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());const read=deferred();ui.input('准备发送');
  const pending=ui.add([{name:'读取中.txt',size:1,arrayBuffer:()=>read.promise}]);await flush();assert.equal(ui.get('send').disabled,true);await ui.submit();assert.equal(ui.requests.length,0);
  read.resolve(Uint8Array.of(65).buffer);await pending;await flush();assert.equal(ui.get('send').disabled,false);await ui.remove(ui.view().attachments[0].id);await ui.submit();
  const request=ui.requests.find(item=>item.url==='/api/turn');assert.equal(Object.hasOwn(request.body,'attachments'),false);
});

test('readonly sent metadata is visible without image URLs, encoded content or mutable controls',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());
  const message={id:'sent-user',role:'user',text:'看一下这张图',status:'completed',tools:[],attachments:[{id:'snapshot-id',name:'<img src=x>.png',kind:'image',mediaType:'image/png',bytes:2048,sha256:'a'.repeat(64)}]};
  const before=JSON.stringify(message);ui.conversation('chat-a',[message]);const files=ui.document.body.querySelectorAll('.model-sent-attachments')[0];
  assert.equal(files.hidden,false);assert.equal(files.textContent,'<img src=x>.png · 图片 · 2 KiB');assert.equal(files.querySelectorAll('.model-remove-file').length,0);assert.equal(files.children[0].tagName,'SPAN');
  await ui.add([file('新文件.txt','新正文')]);await ui.remove(ui.view().attachments[0].id);assert.equal(JSON.stringify(message),before);assert.equal(files.textContent,'<img src=x>.png · 图片 · 2 KiB');
});

test('readonly history, missing capability, source and customer cannot stage or send attachments',async t=>{
  for(const options of [{capability:false},{kind:'source-development'},{kind:'customer-chat'}]) {
    const ui=await createInputUi(options);t.after(()=>ui.close());await ui.add([file('禁止.txt','秘密')]);assert.deepEqual(names(ui),[]);
    const plus=ui.document.body.querySelectorAll('.model-add-file')[0];assert.equal(plus?.hidden??true,true);
  }
  const ui=await createInputUi();t.after(()=>ui.close());ui.conversation('past',[],true);await ui.add([file('禁止.txt','秘密')]);assert.deepEqual(names(ui),[]);assert.equal(ui.document.body.querySelectorAll('.model-add-file')[0].disabled,true);
});

test('model attachment controls preserve @ choice, Enter send and Shift+Enter/IME behavior',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());await ui.add([file('输入.txt','内容')]);
  ui.input('@');const prompt=ui.get('prompt');prompt.dispatchEvent(new UiEvent('keydown',{key:'Enter'}));await flush();assert.equal(ui.requests.length,0);assert.equal(prompt.value,'@revit_get_selection ');
  ui.input('发送消息');for(const extra of [{shiftKey:true},{isComposing:true}]){prompt.dispatchEvent(new UiEvent('keydown',{key:'Enter',...extra}));await flush();assert.equal(ui.requests.length,0);}
  prompt.dispatchEvent(new UiEvent('keydown',{key:'Enter'}));await flush();assert.equal(ui.requests.filter(item=>item.url==='/api/turn').length,1);
});
