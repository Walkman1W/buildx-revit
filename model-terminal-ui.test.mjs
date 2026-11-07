import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush} from './test-support/model-input-ui-fixture.mjs';

const workspace={kind:'model',supportsModelContext:true};
const projection=(overrides={})=>({available:true,enabled:false,eligible:true,...overrides});
const job=(overrides={})=>({
  requestId:'original-terminal-1',interpreter:'python',cwd:'D:\\项目 文件',script:'print("<script>中文</script>")',
  status:'running',stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false,exitCode:null,exitConfirmed:false,...overrides,
});
const emit=(ui,terminal,{id='chat-a',busy=false}={})=>ui.emit('conversation',{workspace,busy,session:session(id),terminal});
async function setup(t){
  const ui=await createInputUi();t.after(()=>ui.close());
  ui.emit('state',{workspace,ready:true,connectionGeneration:1,codexAccount:{accountRevision:1},historyAvailable:true});
  return ui;
}

test('undelivered terminal toggle stays hidden and cannot submit',async t=>{
  const ui=await setup(t),toggle=ui.get('model-terminal-toggle');
  for(const value of [projection({available:false,eligible:false}),projection({eligible:false}),projection(),projection({enabled:true})]){
    emit(ui,value);assert.equal(toggle.hidden,true);toggle.click();await flush();
  }
  assert.equal(ui.requests.length,0);
});

test('live output is literal and stopping waits for exit evidence on the original request',async t=>{
  const ui=await setup(t),panel=ui.get('model-terminal-panel'),stop=ui.get('model-terminal-stop'),check=ui.get('model-terminal-check');
  const running=projection({enabled:true,job:job({stdout:'<img onerror=alert(1)>',stderr:'错误',stdoutTruncated:true})});
  ui.emit('snapshot',{workspace,busy:true,session:session(),terminal:running});
  assert.equal(panel.hidden,false);
  assert.equal(ui.get('messages').contains(panel),true);
  assert.match(ui.get('model-terminal-meta').textContent,/Python.*退出码 未核实\n工作目录 D:\\项目 文件/);
  assert.equal(ui.get('model-terminal-script').textContent,job().script);
  assert.equal(ui.get('model-terminal-stdout').textContent,running.job.stdout);
  assert.equal(ui.get('model-terminal-stdout').childElementCount,0);
  assert.match(ui.get('model-terminal-stdout-label').textContent,/已截断/);
  assert.equal(ui.get('model-terminal-stderr').textContent,'错误');
  stop.click();await flush();
  assert.equal(ui.requests[0].url,'/api/terminal/cancel');
  const ids={client:'ui-id-1',conversationId:'chat-a',requestId:job().requestId};
  assert.deepEqual(ui.requests[0].body,ids);
  await ui.respond(ui.requests[0],{ok:true,terminal:{...running,job:{...running.job,status:'stop_requested'}}});
  assert.match(ui.get('model-terminal-state').textContent,/已请求停止，退出待核实/);
  assert.equal(stop.disabled,true);
  check.click();await flush();
  assert.equal(ui.requests[1].url,'/api/terminal/status');
  assert.deepEqual(ui.requests[1].body,ids);
  await ui.respond(ui.requests[1],{ok:true,terminal:{...running,job:{...running.job,status:'exited',outcome:'cancelled',exitCode:1,exitConfirmed:true}}});
  assert.match(ui.get('model-terminal-state').textContent,/已确认退出 · 已取消/);
  assert.match(ui.get('model-terminal-meta').textContent,/退出码 1/);
  assert.equal(ui.requests.length,2);
});

test('a stale HTTP response cannot replace a later stream projection or cross conversations',async t=>{
  const ui=await setup(t),check=ui.get('model-terminal-check'),panel=ui.get('model-terminal-panel');
  const running=projection({enabled:true,job:job()});
  const exited={...running,job:{...running.job,status:'exited',exitCode:0,exitConfirmed:true,outcome:'completed'}};
  emit(ui,running);check.click();await flush();
  emit(ui,exited);
  await ui.respond(ui.requests[0],{ok:true,terminal:running});
  assert.match(ui.get('model-terminal-state').textContent,/已确认退出 · 执行完成/);
  assert.match(ui.get('model-terminal-meta').textContent,/退出码 0/);
  check.click();await flush();emit(ui,projection(),{id:'chat-b'});
  await ui.respond(ui.requests[1],{ok:true,terminal:exited});
  assert.equal(panel.hidden,true);
  assert.equal(ui.get('model-terminal-script').textContent,'');
});

test('local receipt status remains available after the Codex connection changes',async t=>{
  const ui=await setup(t),check=ui.get('model-terminal-check');
  const running=projection({enabled:true,job:job()});
  emit(ui,running);
  ui.emit('state',{workspace,ready:false,connectionGeneration:2,codexAccount:{accountRevision:1}});
  assert.match(ui.get('model-terminal-state').textContent,/上次状态/);
  assert.equal(ui.get('model-terminal-toggle').disabled,true);
  check.click();await flush();
  assert.equal(ui.requests[0].url,'/api/terminal/status');
  await ui.reject(ui.requests[0],'socket lost');
  assert.match(ui.get('model-terminal-notice').textContent,/原请求状态尚未核实/);
  assert.equal(ui.requests.length,1);
});
