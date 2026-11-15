import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush,UiEvent} from '../test-support/model-input-ui-fixture.mjs';

const receipt=(overrides={})=>({ticket:'ticket-a',conversationId:'chat-a',tool:'revit_move_elements',checking:false,checkRevision:0,check:null,...overrides});
async function setup(t){
  const ui=await createInputUi();t.after(()=>ui.close());
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,connectionGeneration:1,codexAccount:{accountRevision:1},historyAvailable:true});
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:receipt()});await flush();return ui;
}

test('unknown model operation requires a terminal receipt before explicit acknowledgement',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel'),check=panel.querySelectorAll('.model-receipt-check')[0],ack=panel.querySelectorAll('.model-receipt-acknowledge')[0];
  assert.equal(panel.hidden,false);assert.match(panel.textContent,/勿重复执行/);assert.equal(ack.hidden,true);
  ack.click();await flush();assert.equal(ui.requests.length,0);
  check.click();await flush();assert.equal(check.disabled,true);
  assert.deepEqual(ui.requests[0].body,{client:'ui-id-1',conversationId:'chat-a',ticket:'ticket-a'});assert.equal(ui.requests[0].url,'/api/model-receipt/check');
  const terminal={status:'received',terminal:true,requestId:'original-1',evidence:{message:'<script>text</script>'}};
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:receipt({checkRevision:1,check:terminal})});
  await ui.respond(ui.requests[0],{ok:true});assert.equal(ack.hidden,false);assert.equal(ack.disabled,false);
  assert.match(panel.querySelectorAll('.model-receipt-evidence')[0].textContent,/<script>text<\/script>/);
  ack.click();await flush();assert.equal(ui.requests[1].url,'/api/model-receipt/acknowledge');assert.equal(ack.textContent,'确认中…');assert.notEqual(check.textContent,'核查中…');
  assert.deepEqual(ui.requests[1].body,{client:'ui-id-1',conversationId:'chat-a',ticket:'ticket-a',checkRevision:1,confirmed:true});
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:null});await ui.respond(ui.requests[1],{ok:true});assert.equal(panel.hidden,true);
});

test('nonterminal or failed check stays unresolved and cannot be acknowledged',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel'),check=panel.querySelectorAll('.model-receipt-check')[0],ack=panel.querySelectorAll('.model-receipt-acknowledge')[0];
  check.click();await flush();await ui.respond(ui.requests[0],{error:'原回执仍未核实，请勿重复执行。'},false);
  assert.equal(panel.hidden,false);assert.match(panel.textContent,/仍未核实/);assert.equal(ack.hidden,true);
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:receipt({checkRevision:1,check:{status:'pending',terminal:false}})});
  assert.equal(ack.hidden,true);ack.click();await flush();assert.equal(ui.requests.length,1);
});

test('a late response cannot cross conversations or claim success after uncertain acknowledgement',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel'),ack=panel.querySelectorAll('.model-receipt-acknowledge')[0];
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:receipt({checkRevision:2,check:{status:'failed',terminal:true}})});
  ack.click();await flush();await ui.reject(ui.requests[0],'连接中断');
  assert.equal(panel.hidden,false);assert.equal(ack.disabled,true);assert.match(panel.textContent,/尚未核实/);
  ack.click();await flush();assert.equal(ui.requests.length,1);
  ui.emit('conversation',{busy:false,session:session('chat-b'),modelReceipt:null});assert.equal(panel.hidden,true);
  ui.emit('conversation',{busy:false,session:session('chat-b'),modelReceipt:receipt()});assert.equal(panel.hidden,true);
});

test('account change removes the old receipt and ignores pending completion',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel'),check=panel.querySelectorAll('.model-receipt-check')[0];
  check.click();await flush();ui.window.dispatchEvent(new UiEvent('buildx-account-changed'));await flush();
  await ui.respond(ui.requests[0],{ok:true});assert.equal(panel.hidden,true);
});

test('existing saved version does not imply it was created by this request',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel');
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:receipt({checkRevision:1,check:{status:'version_present',terminal:true}})});
  assert.match(panel.textContent,/准确版本存在；无法判断是否由本次请求新建/);
});

test('one collapsed receipt control leaves the conversation log and composer clear',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel'),notice=ui.get('model-receipt-notice'),details=ui.get('model-receipt-details');
  assert.equal(ui.get('messages').contains(panel),false);
  assert.equal(ui.get('transcript').contains(panel),false);
  assert.equal(ui.get('composer').contains(panel),false);
  assert.equal(panel.parent.children.indexOf(panel)+1,panel.parent.children.indexOf(ui.get('composer')));
  assert.equal(panel.contains(notice),true);assert.equal(notice.querySelectorAll('.model-receipt-evidence').length,0);
  assert.match(notice.textContent,/模型写入已暂停/);assert.equal(details.open,false);
  assert.equal(panel.dataset.ticket,'ticket-a');assert.equal(panel.dataset.conversationId,'chat-a');
  ui.get('model-receipt-open').click();await flush();
  assert.equal(details.open,true);assert.equal(ui.get('model-receipt-open').getAttribute('aria-expanded'),'true');
  assert.equal(ui.requests.length,0,'opening details must not check, acknowledge or replay');
  details.open=false;details.dispatchEvent(new UiEvent('toggle'));
  assert.equal(ui.get('model-receipt-open').getAttribute('aria-expanded'),'false');
});

test('a native script error is useful evidence without implying rollback or enabling acknowledgement',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel'),check=panel.querySelectorAll('.model-receipt-check')[0],ack=panel.querySelectorAll('.model-receipt-acknowledge')[0];
  const original=receipt({tool:'revit_execute_csharp',checkRevision:1,check:{status:'unconfirmed',terminal:false,requestId:'original-1',evidence:{nativeFailure:{code:'ArgumentNullException',message:'Value cannot be null. <script>',outcome:'failed',phase:'dispatch',started:true}}}});
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:original});
  assert.match(panel.querySelectorAll('.model-receipt-status')[0].textContent,/脚本执行报错；是否回滚仍未核实/);
  assert.match(panel.querySelectorAll('.model-receipt-failure')[0].textContent,/ArgumentNullException.*Value cannot be null\. <script>/);
  assert.match(panel.querySelectorAll('.model-receipt-next')[0].textContent,/只读核查/);
  assert.equal(panel.querySelectorAll('.model-receipt-raw')[0].open,false,'technical JSON remains collapsed');
  assert.equal(ack.hidden,true);ack.click();await flush();assert.equal(ui.requests.length,0);
  check.click();await flush();assert.equal(check.disabled,true);assert.match(panel.querySelectorAll('.model-receipt-status')[0].textContent,/正在检查原回执/);
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:{...original,checkRevision:2}});
  await ui.respond(ui.requests[0],{ok:true});
  assert.equal(check.disabled,false);assert.match(check.textContent,/再次核查/);
  assert.match(panel.querySelectorAll('.model-receipt-status')[0].textContent,/仍未核实/);
  assert.equal(ack.hidden,true);assert.equal(ui.requests.length,1);
});

test('new receipt identities close details and old actions cannot drift to another conversation',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel'),details=ui.get('model-receipt-details'),open=ui.get('model-receipt-open');
  open.click();assert.equal(details.open,true);
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:receipt({ticket:'ticket-b'})});
  assert.equal(details.open,false);assert.equal(panel.dataset.ticket,'ticket-b');
  await ui.intent('buildx-model-receipt-check',{conversationId:'chat-a',ticket:'ticket-a'});
  assert.equal(ui.requests.length,0);
  ui.emit('conversation',{busy:false,session:session('chat-b'),modelReceipt:null});
  assert.equal(panel.hidden,true);assert.equal(ui.get('model-receipt-notice').hidden,true);
  assert.equal(panel.dataset.ticket,undefined);assert.equal(panel.querySelectorAll('.model-receipt-evidence')[0].textContent,'');
  open.click();await flush();assert.equal(details.open,false);assert.equal(ui.requests.length,0);
});

test('receipt notice does not block ordinary chat or submit model operations itself',async t=>{
  const ui=await setup(t);
  ui.input('请只读核查模型的实际结果，不要重新执行。');
  assert.equal(ui.get('send').disabled,false);
  await ui.submit();assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/turn');
  assert.equal(ui.get('model-receipt-panel').hidden,false);
  assert.equal(ui.get('model-receipt-notice').hidden,false);
});

const scriptRecovery=(overrides={})=>receipt({tool:'revit_execute_csharp',checkRevision:3,check:{status:'unconfirmed',terminal:false,requestId:'original-1',recovery:{kind:'script_failure',requiresReview:true,modelRollback:'unknown',externalEffects:'unknown'},evidence:{nativeFailure:{code:'InvalidOperationException',message:'The script failed.',outcome:'failed',phase:'dispatch',started:true}}},...overrides});

test('only a completed script failure exposes the explicit reviewed recovery action',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel'),recover=panel.querySelectorAll('.model-receipt-recover')[0];
  assert.equal(recover.hidden,true);recover.click();await flush();assert.equal(ui.requests.length,0);
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:scriptRecovery()});
  assert.equal(recover.hidden,false);assert.equal(recover.disabled,false);assert.match(panel.querySelectorAll('.model-receipt-next')[0].textContent,/回滚与事务外影响尚未确认/);
  assert.match(panel.querySelectorAll('.model-receipt-next')[0].textContent,/不会重跑原脚本/);
  await ui.intent('buildx-model-receipt-recover',{ticket:'ticket-a',conversationId:'chat-a',checkRevision:2});assert.equal(ui.requests.length,0,'stale recovery cannot confirm a newer check');
  recover.click();await flush();assert.equal(recover.disabled,true);assert.equal(ui.requests[0].url,'/api/model-receipt/recover');
  assert.deepEqual(ui.requests[0].body,{client:'ui-id-1',conversationId:'chat-a',ticket:'ticket-a',checkRevision:3,confirmed:true});
  await ui.reject(ui.requests[0],'连接中断');assert.equal(recover.disabled,true);recover.click();await flush();assert.equal(ui.requests.length,1,'an uncertain recovery must not be submitted twice');
});

test('read-only receipt refresh remains available while chat is busy, recovery waits for idle',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel'),check=panel.querySelectorAll('.model-receipt-check')[0],recover=panel.querySelectorAll('.model-receipt-recover')[0];
  ui.emit('conversation',{busy:true,session:session(),modelReceipt:scriptRecovery()});
  assert.equal(check.disabled,false);assert.equal(recover.disabled,true);recover.click();await flush();assert.equal(ui.requests.length,0);
  check.click();await flush();assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/model-receipt/check');await ui.respond(ui.requests[0]);
});

test('a Codex disconnect preserves local receipt inspection and confirmation without restoring AI authority',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel'),check=panel.querySelectorAll('.model-receipt-check')[0],ack=panel.querySelectorAll('.model-receipt-acknowledge')[0];
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:false,error:true,message:'Codex 已断开',connectionGeneration:2,codexAccount:{status:'invalidated',accountRevision:2},busy:false});
  assert.equal(panel.hidden,false);assert.equal(check.disabled,false);ui.input('继续建模');assert.equal(ui.get('send').disabled,true);
  check.click();await flush();assert.equal(ui.requests[0].url,'/api/model-receipt/check');
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:receipt({checkRevision:1,check:{status:'received',terminal:true}})});await ui.respond(ui.requests[0]);
  assert.equal(ack.disabled,false);ack.click();await flush();assert.equal(ui.requests[1].url,'/api/model-receipt/acknowledge');await ui.respond(ui.requests[1]);
  assert.equal(ui.get('send').disabled,true);
});

test('local script recovery remains available after Codex failure and still requires the current account',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel');
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,account:{required:true,signedIn:true,user:{id:'account-a'}}});
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:scriptRecovery()});
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:false,error:true,account:{required:true,signedIn:true,user:{id:'account-a'}},connectionGeneration:2,codexAccount:{status:'invalidated',accountRevision:2},busy:false});
  const recover=panel.querySelectorAll('.model-receipt-recover')[0];assert.equal(panel.hidden,false);assert.equal(recover.disabled,false);
  recover.click();await flush();assert.equal(ui.requests[0].url,'/api/model-receipt/recover');await ui.respond(ui.requests[0]);
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:false,error:true,account:{required:true,signedIn:false,user:null}});
  assert.equal(panel.hidden,true);recover.click();await flush();assert.equal(ui.requests.length,1);
});

test('a failed personal C# command uses the same explicit recovery without replaying its revision',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel');
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:scriptRecovery({tool:'revit_run_command'})});
  const recover=panel.querySelectorAll('.model-receipt-recover')[0];assert.equal(recover.hidden,false);assert.equal(recover.disabled,false);
  recover.click();await flush();assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/model-receipt/recover');assert.equal(Object.hasOwn(ui.requests[0].body,'revision'),false);await ui.respond(ui.requests[0]);
});

test('automatic receipt progress stays collapsed and never causes a browser polling request',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel');
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:receipt({autoCheck:{active:true,attempts:2}})});await flush();
  assert.match(panel.querySelectorAll('.model-receipt-state')[0].textContent,/正在自动核查/);assert.equal(ui.get('model-receipt-details').open,false);assert.equal(ui.requests.length,0);
  ui.get('model-receipt-open').click();ui.get('model-receipt-open').click();assert.equal(ui.get('model-receipt-details').open,false);assert.equal(ui.requests.length,0);
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:null});assert.equal(panel.hidden,true);
});

test('a terminal receipt with unfinished cleanup shows its server-owned reason instead of endless recovery',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel'),status=panel.querySelectorAll('.model-receipt-status')[0];
  const pending=receipt({checkRevision:2,check:{status:'received',terminal:true},autoCheck:{active:false,attempts:4,message:'请切回原模型，再核查此操作。'}});
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:pending});
  assert.equal(panel.querySelectorAll('.model-receipt-state')[0].textContent,'等待处理');assert.equal(status.textContent,'请切回原模型，再核查此操作。');
  panel.querySelectorAll('.model-receipt-check')[0].click();await flush();assert.match(status.textContent,/正在检查原回执/,'manual request feedback takes precedence over the previous server reason');
  ui.emit('conversation',{busy:false,session:session(),modelReceipt:{...pending,checkRevision:3}});await ui.respond(ui.requests[0],{ok:true});assert.equal(status.textContent,'请切回原模型，再核查此操作。');
});

test('new conversation remains available and carries the original pending receipt without stale actions',async t=>{
  const ui=await setup(t),panel=ui.get('model-receipt-panel');
  assert.equal(ui.get('new-chat').disabled,false);
  ui.get('model-receipt-open').click();assert.equal(ui.get('model-receipt-details').open,true);
  ui.emit('conversation',{busy:false,session:session('chat-b'),modelReceipt:receipt({conversationId:'chat-b',sourceConversationId:'chat-a'})});
  assert.equal(panel.hidden,false);assert.equal(ui.get('model-receipt-details').open,false);assert.match(panel.querySelectorAll('.model-receipt-description')[0].textContent,/来自另一段对话/);
  await ui.intent('buildx-model-receipt-check',{ticket:'ticket-a',conversationId:'chat-a'});assert.equal(ui.requests.length,0);
  panel.querySelectorAll('.model-receipt-check')[0].click();await flush();assert.equal(ui.requests[0].body.conversationId,'chat-b');await ui.respond(ui.requests[0]);
});
