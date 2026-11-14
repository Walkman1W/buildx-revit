import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,file,deferred,flush,UiEvent} from './test-support/model-input-ui-fixture.mjs';

const snapshot=(name,contents,extra={})=>{const bytes=Buffer.from(contents);return {name,attachmentName:name,sourceFormat:'original',mediaType:'text/plain',byteLength:bytes.length,data:bytes.toString('base64'),...extra};};
function begin(ui){let value;ui.window.dispatchEvent(new UiEvent('buildx-project-attach-begin',{detail:{resolve:result=>{value=result;}}}));return value;}
async function attach(ui,value,binding){let response;ui.window.dispatchEvent(new UiEvent('buildx-project-attach',{detail:{value,binding,resolve:result=>{response=result;}}}));await flush();return response;}
const names=ui=>Array.from(ui.view().attachments,item=>item.name);

test('library snapshot stages exact text bytes in the selected conversation without submitting a turn',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());ui.input('保留现有草稿');
  const captured=begin(ui);assert.equal(captured.ok,true);const source=snapshot('资料.txt','中文\r\n原文');
  assert.equal((await attach(ui,source,captured.binding)).ok,true);assert.deepEqual(names(ui),['资料.txt']);
  assert.equal(ui.get('prompt').value,'保留现有草稿');assert.equal(ui.requests.filter(request=>request.url==='/api/turn').length,0);
  await ui.submit();const request=ui.requests.find(item=>item.url==='/api/turn');assert.deepEqual(request.body.attachments,[{name:'资料.txt',mediaType:'text/plain',data:source.data}]);await ui.respond(request);
});

test('a turn stopped before native submission retains its staged library attachment',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());ui.input('保留这条草稿');
  assert.equal((await attach(ui,snapshot('资料.txt','受控正文'),begin(ui).binding)).ok,true);
  await ui.submit();const request=ui.requests.find(item=>item.url==='/api/turn');
  await ui.respond(request,{ok:true,status:'not_sent'});
  assert.equal(ui.get('prompt').value,'保留这条草稿');assert.deepEqual(names(ui),['资料.txt']);
  assert.equal(ui.requests.filter(item=>item.url==='/api/turn').length,1);
});

for(const [extension,notice] of [['pdf','图片或扫描页中的文字可能遗漏'],['docx','页眉、页脚等内容可能遗漏'],['xlsx','缓存的值，可能已过期']])test(`extracted ${extension} limitation appears in attachment card and sent text`,async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());const name='说明.'+extension,source=snapshot(name,'提取内容',{attachmentName:name+'.txt',sourceFormat:'extracted'});
  assert.equal((await attach(ui,source,begin(ui).binding)).ok,true);assert.deepEqual(names(ui),[name+'.txt']);
  const item=ui.view().attachments[0];assert.equal(item.sourceFormat,'extracted');assert.equal(item.sourceName,name);assert.equal(item.kind,'text');assert.ok(item.extractionNotice.includes(notice));
  const cards=ui.document.body.querySelectorAll('.model-extraction-notice');assert.equal(cards.length,1);assert.ok(cards[0].textContent.includes(notice));
  ui.input('请阅读');await ui.submit();const request=ui.requests.find(item=>item.url==='/api/turn');const sent=Buffer.from(request.body.attachments[0].data,'base64').toString('utf8');
  assert.ok(sent.includes(notice));assert.ok(sent.includes('不是完整原文件'));assert.ok(sent.endsWith('提取内容'));assert.equal(item.bytes,Buffer.byteLength(sent));await ui.respond(request);
});

test('extraction notices count against attachment limits and leave the draft untouched when rejected',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());ui.input('原草稿');const name='大文件.pdf';
  const source=snapshot(name,'x'.repeat(65500),{attachmentName:name+'.txt',sourceFormat:'extracted'});
  const result=await attach(ui,source,begin(ui).binding);assert.equal(result.ok,false);assert.deepEqual(names(ui),[]);assert.equal(ui.get('prompt').value,'原草稿');assert.equal(ui.requests.filter(item=>item.url==='/api/turn').length,0);
});

test('a library image keeps its exact bytes and media type when eventually sent',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aU8AAAAASUVORK5CYII=','base64');
  const source=snapshot('图纸.png',bytes,{mediaType:'image/png'});assert.equal((await attach(ui,source,begin(ui).binding)).ok,true);
  ui.input('请看这张图');await ui.submit();const request=ui.requests.find(item=>item.url==='/api/turn');
  assert.deepEqual(request.body.attachments,[{name:'图纸.png',mediaType:'image/png',data:source.data}]);await ui.respond(request);
});

test('invalid, ambiguous, mismatched and oversized snapshots are rejected without staging',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());
  for(const value of [snapshot('A.txt','x',{data:'%%=='}),snapshot('A.txt','x',{byteLength:2}),snapshot('A.txt','x',{mediaType:'image/png'}),snapshot('../A.txt','x'),snapshot('A.txt','x',{attachmentName:'B.txt'}),snapshot('A.pdf','x',{attachmentName:'A.txt',sourceFormat:'extracted'}),snapshot('A.txt','x',{byteLength:65537,data:'A'.repeat(87384)}),snapshot('bad.txt',Uint8Array.of(255))]){
    const result=await attach(ui,value,begin(ui).binding);assert.equal(result.ok,false);assert.deepEqual(names(ui),[]);
  }
});

test('a binding cannot cross a conversation switch, a switch back, context reset or account change',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());
  let captured=begin(ui);ui.conversation('chat-b');assert.equal((await attach(ui,snapshot('A.txt','A'),captured.binding)).ok,false);
  captured=begin(ui);ui.conversation('chat-a');ui.conversation('chat-b');assert.equal((await attach(ui,snapshot('B.txt','B'),captured.binding)).ok,false);
  captured=begin(ui);ui.emit('conversation',{busy:false,session:{conversation:{id:'chat-b',readOnly:false},messages:[],context:{document:null,selection:null},contextEpoch:1},history:{available:true,activeId:'chat-b'}});await flush();assert.equal((await attach(ui,snapshot('C.txt','C'),captured.binding)).ok,false);
  captured=begin(ui);await ui.close();assert.equal((await attach(ui,snapshot('D.txt','D'),captured.binding)).ok,false);assert.deepEqual(names(ui),[]);
});

test('binding is one-use and file capacity, pending reads and disabled contexts report failure',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());const captured=begin(ui);
  assert.equal((await attach(ui,snapshot('A.txt','A'),captured.binding)).ok,true);assert.equal((await attach(ui,snapshot('A.txt','A'),captured.binding)).ok,false);
  await ui.add([file('b.txt','b'),file('c.txt','c'),file('d.txt','d')]);assert.equal((await attach(ui,snapshot('e.txt','e'),begin(ui).binding)).ok,false);assert.equal(names(ui).length,4);
  const pending=deferred();await ui.remove(ui.view().attachments[0].id);void ui.add([{name:'pending.txt',size:1,arrayBuffer:()=>pending.promise}]);await flush();assert.equal(begin(ui).ok,false);pending.resolve(Uint8Array.of(1).buffer);await flush();
  const disabled=await createInputUi({capability:false});t.after(()=>disabled.close());assert.match(begin(disabled).error,/暂不支持/);
});
