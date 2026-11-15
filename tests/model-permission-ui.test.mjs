import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush,UiEvent} from '../test-support/model-input-ui-fixture.mjs';

const permission=(overrides={})=>({available:true,level:'rollback',revision:1,conversationId:'chat-a',documentLabel:'项目一',expiresAt:null,...overrides});
async function setup(t,options={}){
  const ui=await createInputUi(options);t.after(()=>ui.close());
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,connectionGeneration:1,codexAccount:{accountRevision:1},historyAvailable:true});
  ui.emit('conversation',{busy:false,session:session()});await flush();return ui;
}
const change=async(ui,level)=>{const select=ui.get('model-permission-select');select.value=level;select.dispatchEvent(new UiEvent('change'));await flush();};
function manualTimers(){
  let now=0;const entries=[];
  return {setTimeout(fn,ms){const entry={fn,at:now+ms,cleared:false,unref(){}};entries.push(entry);return entry;},clearTimeout(entry){if(entry)entry.cleared=true;},advance(ms){now+=ms;for(const entry of entries.filter(item=>!item.cleared&&item.at<=now)){entry.cleared=true;entry.fn();}}};
}

test('a native permission check lasting 53 seconds stays owned and waits for the real receipt',async t=>{
  const timers=manualTimers(),ui=await setup(t,{timers}),select=ui.get('model-permission-select');
  ui.emit('conversation',{busy:false,session:session(),modelPermission:permission()});await change(ui,'confirm');
  const request=ui.requests[0];assert.equal(select.value,'__pending');assert.equal(ui.get('send').disabled,true);
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:false,busy:true,busyOperation:'model-permission-check',message:'正在等待 Revit 核实当前模型与执行权限…'});
  timers.advance(15000);await flush();
  assert.equal(select.value,'__pending');assert.equal(request.options.signal,undefined);assert.equal(ui.requests.length,1);
  assert.match(ui.get('model-permission-bar').textContent,/仍在等待 Revit/);assert.match(ui.get('activity-text').textContent,/仍在等待 Revit/);assert.equal(ui.get('stop').hidden,true);
  timers.advance(38000);await flush();assert.equal(select.value,'__pending');assert.equal(ui.requests.length,1);
  await ui.respond(request,{ok:true,modelPermission:permission({level:'confirm',revision:2})});
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,busy:false,busyOperation:null});
  assert.equal(select.value,'confirm');assert.equal(select.disabled,false);assert.equal(ui.get('activity').hidden,true);
});

test('connection, account and context changes still prevent delayed permission receipts reviving an old grant',async t=>{
  for(const invalidation of ['connection','account','context']){
    const timers=manualTimers(),ui=await setup(t,{timers}),select=ui.get('model-permission-select');
    ui.emit('conversation',{busy:false,session:session(),modelPermission:permission()});await change(ui,'confirm');const request=ui.requests[0];timers.advance(15000);
    if(invalidation==='connection')ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,connectionGeneration:2,codexAccount:{accountRevision:1}});
    if(invalidation==='account')await ui.intent('buildx-account-changed');
    if(invalidation==='context')ui.emit('conversation',{busy:false,session:{...session(),contextEpoch:1},modelPermission:{available:false,reason:'模型已变化。'}});
    timers.advance(38000);await ui.respond(request,{ok:true,modelPermission:permission({level:'confirm',revision:2})});
    assert.equal(select.value,'');assert.equal(select.disabled,true);
  }
});

test('a pending server permission operation is shown as model verification even after a page reconnect',async t=>{
  const ui=await setup(t);
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:false,busy:true,busyOperation:'model-permission-check',message:'正在等待 Revit 核实当前模型与执行权限…'});
  assert.match(ui.get('activity-text').textContent,/Revit.*核实/);assert.match(ui.get('status-text').textContent,/Revit.*核实/);assert.equal(ui.get('stop').hidden,true);
});

test('missing, invalid and unavailable server permissions cannot be selected or displayed as active',async t=>{
  const ui=await setup(t),select=ui.get('model-permission-select');
  assert.equal(ui.get('model-permission-bar').parent,ui.get('composer-bottom'));
  assert.equal(ui.get('composer-bottom').children[1],ui.get('model-permission-bar'));
  assert.equal(select.disabled,true);assert.equal(select.value,'');
  ui.emit('conversation',{busy:false,session:session(),modelPermission:permission({conversationId:'other'})});
  assert.equal(select.disabled,true);assert.equal(select.value,'');
  ui.emit('conversation',{busy:false,session:session(),modelPermission:{available:false,reason:'请先打开模型。'}});
  assert.equal(select.disabled,true);assert.match(ui.get('model-permission-bar').textContent,/请先打开模型/);
  await change(ui,'automatic');assert.equal(ui.requests.filter(item=>item.url==='/api/model-permission').length,0);
});

test('explicit selection posts scoped revision and shows changed level only after server receipt',async t=>{
  const ui=await setup(t),select=ui.get('model-permission-select');
  ui.emit('conversation',{busy:false,session:session(),modelPermission:permission()});assert.equal(select.disabled,false);assert.equal(select.value,'rollback');
  assert.match(ui.get('model-permission-bar').textContent,/项目一/);
  await change(ui,'automatic');assert.equal(select.value,'__pending');assert.equal(select.disabled,true);
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/model-permission');
  assert.deepEqual(ui.requests[0].body,{client:'ui-id-1',conversationId:'chat-a',level:'automatic',expectedRevision:1});
  await ui.respond(ui.requests[0],{ok:true,modelPermission:permission({level:'automatic',revision:2})});
  assert.equal(select.value,'automatic');assert.equal(select.disabled,false);
});

test('initial ungranted state allows choosing rollback and identifies the pending model check',async t=>{
  const ui=await setup(t),select=ui.get('model-permission-select');
  ui.emit('conversation',{busy:false,session:session(),modelPermission:permission({level:null,revision:0,documentLabel:'当前模型（选择后核实）'})});
  assert.equal(select.disabled,false);assert.equal(select.value,'');assert.match(ui.get('model-permission-bar').textContent,/尚未授权/);
  await change(ui,'rollback');assert.deepEqual(ui.requests[0].body,{client:'ui-id-1',conversationId:'chat-a',level:'rollback',expectedRevision:0});
  await ui.respond(ui.requests[0],{ok:true,modelPermission:permission({level:'rollback',revision:1})});
  assert.equal(select.value,'rollback');assert.match(ui.get('model-permission-bar').textContent,/项目一/);
});

test('late receipt after conversation or connection change cannot grant a displayed permission',async t=>{
  const ui=await setup(t),select=ui.get('model-permission-select');
  ui.emit('conversation',{busy:false,session:session(),modelPermission:permission()});await change(ui,'automatic');
  ui.emit('conversation',{busy:false,session:session('chat-b'),modelPermission:{available:false,reason:'新对话未授权。'}});
  await ui.respond(ui.requests[0],{ok:true,modelPermission:permission({level:'automatic',revision:2})});
  assert.equal(select.value,'');assert.equal(select.disabled,true);
  ui.emit('conversation',{busy:false,session:session('chat-b'),modelPermission:permission({conversationId:'chat-b'})});
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,connectionGeneration:2,codexAccount:{accountRevision:1}});
  assert.equal(select.value,'');assert.equal(select.disabled,true);
});

test('a conflicting snapshot with the same revision is not treated as an authorization',async t=>{
  const ui=await setup(t),select=ui.get('model-permission-select');
  ui.emit('conversation',{busy:false,session:session(),modelPermission:permission()});
  ui.emit('conversation',{busy:false,session:session(),modelPermission:permission({level:'automatic'})});
  assert.equal(select.value,'');assert.equal(select.disabled,true);assert.match(ui.get('model-permission-bar').textContent,/不一致/);
});

test('account switch invalidates the displayed authorization before a replacement snapshot arrives',async t=>{
  const ui=await setup(t),select=ui.get('model-permission-select');
  ui.emit('conversation',{busy:false,session:session(),modelPermission:permission({level:'automatic'})});
  assert.equal(select.value,'automatic');
  ui.window.dispatchEvent(new UiEvent('buildx-account-changed'));await flush();
  assert.equal(select.value,'');assert.equal(select.disabled,true);
});

const operation=(effectKind,tool='revit_move_elements')=>({id:tool,tool,label:'示例操作',description:'测试操作',group:'模型',readOnly:false,enabled:true,effectKind,inputSchema:{type:'object',properties:{mode:{type:'string',enum:['rollback','commit'],default:'rollback'}},required:[]}});
async function operationSetup(t,effectKind,level,tool){
  const ui=await setup(t),entry=operation(effectKind,tool);
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,commandsReady:true,directCommandsAvailable:true,connectionGeneration:1,codexAccount:{accountRevision:1},commandCatalog:[entry]});
  ui.emit('conversation',{busy:false,session:session(),modelPermission:permission({level})});await flush();
  const row=ui.document.body.querySelectorAll('.model-command-item')[0];
  return {ui,row,mode:ui.get('model-command-'+entry.id+'-mode'),confirm:row.querySelectorAll('.model-command-confirm')[0],run:row.querySelectorAll('.model-command-run')[0]};
}
test('known model transactions need no redundant checkbox for previews or automatic apply',async t=>{
  const {ui,mode,confirm,run}=await operationSetup(t,'model_transaction','automatic');
  assert.equal(confirm.hidden,true);mode.value='commit';mode.dispatchEvent(new UiEvent('change'));assert.equal(confirm.hidden,true);
  run.click();await flush();assert.equal(ui.requests[0].url,'/api/command');assert.equal(ui.requests[0].body.parameters.mode,'commit');assert.equal(Object.hasOwn(ui.requests[0].body,'confirmed'),false);
  await ui.respond(ui.requests[0],{ok:true,executionId:'a'});
});
test('confirm mode requires checking each explicit commit and editing invalidates confirmation',async t=>{
  const {ui,mode,confirm,run}=await operationSetup(t,'model_transaction','confirm');
  assert.equal(confirm.hidden,true);mode.value='commit';mode.dispatchEvent(new UiEvent('change'));assert.equal(confirm.hidden,false);
  run.click();await flush();assert.equal(ui.requests.length,0);
  confirm.children[0].checked=true;mode.dispatchEvent(new UiEvent('change'));assert.equal(confirm.children[0].checked,false);
  confirm.children[0].checked=true;run.click();await flush();assert.equal(ui.requests[0].body.confirmed,true);
  await ui.respond(ui.requests[0],{ok:true,executionId:'b'});
});
test('script effects still require explicit confirmation and rollback grant rejects commit',async t=>{
  const script=await operationSetup(t,'script_or_command','automatic','revit_execute_csharp');
  assert.equal(script.confirm.hidden,false);script.run.click();await flush();assert.equal(script.ui.requests.length,0);
  const model=await operationSetup(t,'model_transaction','rollback');model.mode.value='commit';model.mode.dispatchEvent(new UiEvent('change'));
  model.confirm.children[0].checked=true;model.run.click();await flush();assert.equal(model.ui.requests.length,0);assert.match(model.row.textContent,/当前权限为回滚预览/);
});
