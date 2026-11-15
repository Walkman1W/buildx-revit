import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,flush} from '../test-support/model-input-ui-fixture.mjs';
import {receiptNoticeState} from '../public/chat-view.mjs';

test('settled legacy receipt notices are dismissible without hiding errors or unknown results',async t=>{
  const ui=await createInputUi(); t.after(()=>ui.close());
  const settled={id:'settled',role:'error',status:'failed',text:'原模型操作回执已核实（not_started）；后续操作已恢复。'};
  const error={id:'error',role:'error',status:'failed',text:'脚本执行失败，事务外影响仍未核实。'};
  const unknown={id:'unknown',role:'assistant',status:'unknown',text:'结果未知'};
  ui.conversation('chat-a',[settled,error,unknown]); await flush();
  const transcript=ui.get('transcript');
  const article=transcript.children[0];
  assert.match(article.textContent,/操作回执未执行/);
  assert.match(article.textContent,/后续操作已恢复/);
  assert.doesNotMatch(article.textContent,/回答失败|连接提示/);
  article.querySelectorAll('.dismiss-receipt-notice')[0].click();
  assert.equal(article.hidden,true);
  ui.conversation('chat-a',[settled,error,unknown]); await flush();
  assert.equal(transcript.children[0].hidden,true);
  assert.equal(transcript.children[1].hidden,false);
  assert.match(transcript.children[1].textContent,/回答失败/);
  assert.match(transcript.children[2].textContent,/结果未知/);
  ui.conversation('chat-b',[]); ui.conversation('chat-a',[settled,error,unknown]); await flush();
  assert.equal(transcript.children[0].hidden,true);
  for(const [text,label] of [
    ['脚本执行失败，已核实模型事务回滚；后续操作已恢复，事务外影响仍未核实。','事务外影响待核查'],
    ['脚本已报错结束；已由用户核查模型并恢复后续操作。回滚及事务外影响仍未确认。','回滚与影响待核查'],
  ]){
    ui.conversation('chat-a',[{...settled,text}]); await flush();
    const warning=transcript.children[0];
    assert.equal(warning.hidden,false);
    assert.equal(warning.querySelectorAll('.dismiss-receipt-notice')[0].hidden,true);
    assert.match(warning.textContent,new RegExp(label));
  }
  ui.conversation('chat-a',[{...settled,text:settled.text+' 附加错误'}]); await flush();
  assert.equal(transcript.children[0].hidden,false);
  assert.match(transcript.children[0].textContent,/回答失败/);
});

test('receipt labels preserve confirmed failures and match exact server templates',()=>{
  const settledFailure={role:'error',status:'failed',text:'原模型操作回执已核实（failed）；后续操作已恢复。'};
  assert.deepEqual(receiptNoticeState(settledFailure),{state:'failed',label:'操作失败',dismissible:true});
  assert.equal(receiptNoticeState({...settledFailure,role:'assistant'}),null);
  assert.equal(receiptNoticeState({...settledFailure,text:'原模型操作回执已核实（unknown）；后续操作已恢复。'}),null);
  assert.equal(receiptNoticeState({role:'error',status:'unknown',text:'原模型操作回执已自动核实；后续操作已恢复。'}),null);
});

test('dismissal survives reload in session storage and falls back safely',async()=>{
  const {receiptDismissalStore}=await import('../public/chat-view.mjs');
  const data=new Map();const storage={getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};
  const a=JSON.stringify(['account-a','chat-a','message-a']);
  const b=JSON.stringify(['account-b','chat-a','message-a']);
  const c=JSON.stringify(['account-a','chat-b','message-a']);
  receiptDismissalStore(storage).add(a);
  const restored=receiptDismissalStore(storage);
  assert.equal(restored.has(a),true);assert.equal(restored.has(b),false);assert.equal(restored.has(c),false);
  assert.doesNotMatch([...data.values()][0],/脚本|回执/);
  const unavailable=receiptDismissalStore({getItem(){throw Error('denied');},setItem(){throw Error('denied');}});
  unavailable.add(a);assert.equal(unavailable.has(a),true);
});
