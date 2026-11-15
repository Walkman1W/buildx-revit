import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,flush} from '../test-support/model-input-ui-fixture.mjs';

test('tool display truncation is a separate notice and leaves unknown tool receipts visible',async t=>{
  const ui=await createInputUi();
  t.after(()=>ui.close());
  const message={id:'assistant-overflow',role:'assistant',text:'已收到 Codex 轮次回执。',status:'completed',toolHistoryTruncated:true,
    tools:[{id:'original-tool',name:'revit_get_element_parameters',label:'元素参数',status:'unknown'}]};
  ui.conversation('chat-a',[message]);
  await flush();

  const transcript=ui.get('transcript');
  assert.equal(transcript.querySelectorAll('.message-state')[0].classList.contains('completed'),true);
  assert.equal(transcript.querySelectorAll('.tool-call')[0].classList.contains('unknown'),true);
  const notices=transcript.querySelectorAll('.tool-history-notice');
  assert.equal(notices.length,1);
  assert.match(notices[0].textContent,/显示上限.*原始执行回执/);
  assert.doesNotMatch(transcript.textContent,/连接提示/);

  ui.conversation('chat-b',[{...message,toolHistoryTruncated:false}]);
  await flush();
  assert.equal(transcript.querySelectorAll('.tool-history-notice').length,0);
});
