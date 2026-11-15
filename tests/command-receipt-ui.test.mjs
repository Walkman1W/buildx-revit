import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush,UiEvent} from '../test-support/model-input-ui-fixture.mjs';

const model={kind:'model',supportsModelContext:true};
const baseline={workspace:model,ready:true,directCommandsAvailable:true,historyAvailable:true,account:{required:false},connectionGeneration:1,codexAccount:{accountRevision:1,status:'verified'}};
const receipt=(extra={})=>({commandId:'document',conversationId:'chat-a',executionId:'exec-document',status:'unknown',canInspectReceipt:true,receiptCheck:{checking:false,revision:0,status:'pending'},error:{code:'COMMAND_READ_UNCONFIRMED',outcome:'unconfirmed',message:'原始结果尚未确认'},...extra});
const detail=(extra={})=>({commandId:'document',conversationId:'chat-a',executionId:'exec-document',...extra});
const row=(ui,id='document')=>ui.view().commands.find(command=>command.commandId===id);
const buttons=ui=>ui.document.body.querySelectorAll('.model-command-inspect');
async function setup(t,extra={}){const ui=await createInputUi(extra);t.after(()=>ui.close());if(!extra.kind||extra.kind==='model'){ui.emit('state',baseline);ui.emit('conversation',{busy:false,session:session(),command:receipt()});await flush();}return ui;}

test('only the server-approved unknown execution exposes a compact receipt check action',async t=>{
  const ui=await setup(t);assert.equal(buttons(ui)[0].hidden,false);assert.equal(buttons(ui)[0].textContent,'核对结果');
  ui.emit('conversation',{busy:false,session:session(),command:receipt({canInspectReceipt:false})});assert.equal(buttons(ui)[0].hidden,true);
  await ui.intent('buildx-model-command-check',detail());assert.equal(ui.requests.length,0);
  ui.emit('conversation',{busy:false,session:session(),command:receipt({status:'failed',canInspectReceipt:true})});assert.equal(buttons(ui)[0].hidden,true);await ui.intent('buildx-model-command-check',detail());assert.equal(ui.requests.length,0);
  ui.emit('conversation',{busy:false,session:session(),command:receipt({receiptCheck:{checking:false,revision:1,status:'pending'}})});
  await ui.intent('buildx-model-command-check',detail({executionId:'forged'}));await ui.intent('buildx-model-command-check',detail({conversationId:'other'}));assert.equal(ui.requests.length,0);
});

test('receipt lookup sends only exact UI identity and admission cannot invent a result',async t=>{
  const ui=await setup(t);ui.input('保留的聊天草稿');ui.get('include-selection').checked=true;
  await ui.intent('buildx-model-command-check',detail({path:'D:/forged.json',requestId:'browser-cannot-select-this'}));await ui.intent('buildx-model-command-check',detail());
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/command/check');assert.deepEqual(ui.requests[0].body,{client:'ui-id-1',conversationId:'chat-a',commandId:'document',executionId:'exec-document'});
  assert.equal(ui.view().blocked,true);assert.equal(buttons(ui)[0].textContent,'核对中…');assert.equal(buttons(ui)[0].disabled,true);
  await ui.respond(ui.requests[0],{ok:true});assert.equal(row(ui).status,'unknown');assert.equal(ui.view().blocked,true);assert.equal(ui.get('prompt').value,'保留的聊天草稿');assert.equal(ui.get('include-selection').checked,true);
  ui.emit('conversation',{busy:false,session:session(),command:receipt()});assert.equal(ui.view().blocked,true,'repeated revision0 snapshot is not a new lookup result');
  ui.emit('conversation',{busy:false,session:session(),command:receipt({receiptCheck:{checking:false,revision:1,status:'pending',message:'尚未收到回执'}})});
  assert.equal(ui.view().blocked,false);assert.equal(row(ui).status,'unknown');assert.equal(ui.get('transcript').children.length,0);assert.equal(ui.requests.length,1);
});

test('checking blocks other operations and cannot expose or send a generic Codex stop',async t=>{
  const ui=await setup(t);await ui.intent('buildx-model-command-check',detail());
  ui.emit('conversation',{busy:true,session:session(),command:receipt({receiptCheck:{checking:true,revision:1,status:'pending'}})});
  assert.equal(ui.get('stop').hidden,true);assert.equal(ui.get('new-chat').disabled,true);assert.equal(ui.get('reconnect').disabled,true);assert.equal(buttons(ui)[0].textContent,'核对中…');
  ui.input('不能趁核对发出');await ui.submit();await ui.intent('buildx-model-command',{commandId:'selection',parameters:{}});await ui.intent('buildx-model-command-stop',detail());ui.get('stop').click();ui.get('new-chat').click();ui.get('reconnect').click();await flush();assert.equal(ui.requests.length,1);
  ui.emit('conversation',{busy:false,session:session(),command:receipt({receiptCheck:{checking:false,revision:1,status:'received',message:'已收到回执'}})});
  assert.equal(row(ui).status,'unknown');assert.equal(row(ui).receiptCheck.status,'received');assert.equal(ui.view().blocked,false);assert.equal(ui.get('send').disabled,false);
  await ui.respond(ui.requests[0],{ok:true});assert.equal(ui.view().blocked,false);assert.equal(row(ui).status,'unknown');
});

test('a known negative late receipt may refine this exact row while older projections and ACKs cannot downgrade it',async t=>{
  const ui=await setup(t);await ui.intent('buildx-model-command-check',detail());const old=ui.requests[0];
  const failed=receipt({status:'failed',canInspectReceipt:false,error:{code:'COMMAND_REQUEST_EXPIRED',outcome:'expired',message:'原生过期事实'},receiptCheck:{checking:false,revision:1,status:'expired',originalError:{message:'原始结果尚未确认'}}});
  ui.emit('conversation',{busy:false,session:session(),command:failed});assert.equal(row(ui).status,'failed');assert.equal(buttons(ui)[0].hidden,true);
  ui.emit('conversation',{busy:false,session:session(),command:receipt()});assert.equal(row(ui).status,'failed');
  await ui.respond(old,{ok:true});assert.equal(row(ui).status,'failed');assert.equal(row(ui).receiptCheck.status,'expired');assert.equal(ui.view().blocked,false);
});

test('new execution removes older recovery capability and late check HTTP cannot overwrite or unlock it',async t=>{
  const ui=await setup(t);await ui.intent('buildx-model-command-check',detail());const old=ui.requests[0];
  const next=receipt({commandId:'levels',executionId:'exec-levels',status:'running',canInspectReceipt:false,receiptCheck:undefined});
  ui.emit('conversation',{busy:true,session:session(),command:next});assert.equal(row(ui).canInspectReceipt,false);assert.equal(buttons(ui)[0].hidden,true);assert.equal(row(ui,'levels').executionId,'exec-levels');
  await ui.reject(old,'迟到的核对连接失败');assert.equal(row(ui,'levels').status,'running');assert.equal(ui.view().busy,true);assert.equal(ui.view().blocked,true);
  ui.emit('conversation',{busy:false,session:session(),command:{...next,status:'completed',result:{data:{items:[],total:0,returned:0}}}});assert.equal(ui.view().blocked,false);assert.equal(row(ui).status,'unknown');assert.equal(row(ui,'levels').status,'completed');
});

test('conversation or account revision changes retire the exact check owner',async t=>{
  const ui=await setup(t);await ui.intent('buildx-model-command-check',detail());const old=ui.requests[0];
  ui.conversation('chat-b');await ui.respond(old,{ok:true});assert.equal(ui.view().commands.length,0);assert.equal(ui.view().blocked,false);
  ui.conversation('chat-a');ui.emit('conversation',{busy:false,session:session(),command:receipt()});await ui.intent('buildx-model-command-check',detail());const previous=ui.requests.at(-1);
  ui.emit('state',{...baseline,codexAccount:{accountRevision:2,status:'verified'}});await ui.respond(previous,{ok:true});assert.equal(ui.view().commands.length,0);assert.equal(ui.view().blocked,false);
});

test('lookup transport failure preserves unknown and never retries or reconnects',async t=>{
  const ui=await setup(t);ui.input('保留输入');await ui.intent('buildx-model-command-check',detail());await ui.reject(ui.requests[0],'核对连接中断');
  assert.equal(row(ui).status,'unknown');assert.equal(row(ui).error.message,'原始结果尚未确认');assert.equal(ui.get('prompt').value,'保留输入');assert.equal(ui.view().ready,true);assert.equal(ui.view().blocked,false);await flush();assert.equal(ui.requests.length,1);assert.equal(ui.requests.some(request=>request.url==='/api/reconnect'||request.url==='/api/turn'||request.url==='/api/interrupt'),false);
});

test('restricted workspaces ignore receipt intents without a model transport fallback',async t=>{
  for(const kind of ['source-development','customer-chat']){const ui=await setup(t,{kind});await ui.intent('buildx-model-command-check',detail());assert.equal(ui.requests.length,0);}
});
test('the original cleanup owner can retry receipt cleanup while new model work stays unready',async t=>{
  const ui=await setup(t);ui.emit('state',{...baseline,ready:false,cleanupPending:true});ui.emit('conversation',{busy:false,session:session(),command:receipt({receiptCheck:{checking:false,revision:1,status:'unconfirmed',cleanupPending:true}})});
  assert.equal(buttons(ui)[0].disabled,false);ui.input('不能发出新模型任务');await ui.submit();await ui.intent('buildx-model-command',{commandId:'document',parameters:{}});assert.equal(ui.requests.length,0);
  await ui.intent('buildx-model-command-check',detail());assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/command/check');
});

test('same-command rerun cleanup failure keeps the original execution when SSE precedes the rejection',async t=>{
  const ui=await setup(t);await ui.intent('buildx-model-command',{commandId:'document',parameters:{}});const rerun=ui.requests[0];assert.equal(row(ui).status,'pending');
  ui.emit('conversation',{busy:false,session:session(),command:receipt({receiptCheck:{checking:false,revision:0,cleanupPending:true,message:'清理待核对'}})});ui.emit('state',{...baseline,ready:false,cleanupPending:true});
  await ui.respond(rerun,{error:'旧回执清理尚未确认，未发送新查询'},false);assert.equal(row(ui).executionId,'exec-document');assert.equal(row(ui).status,'unknown');assert.equal(row(ui).receiptCheck.cleanupPending,true);assert.equal(buttons(ui)[0].disabled,false);
  await ui.intent('buildx-model-command-check',detail());assert.equal(ui.requests.at(-1).url,'/api/command/check');assert.equal(ui.requests.at(-1).body.executionId,'exec-document');
});

test('a rejected rerun without an SSE observation preserves the previous receipt entry',async t=>{
  const ui=await setup(t);await ui.intent('buildx-model-command',{commandId:'document',parameters:{}});await ui.respond(ui.requests[0],{error:'未接受新查询'},false);assert.equal(row(ui).executionId,'exec-document');assert.equal(row(ui).status,'unknown');assert.equal(row(ui).canInspectReceipt,true);
});
