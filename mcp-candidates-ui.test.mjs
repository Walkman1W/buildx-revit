import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush,UiEvent} from './test-support/model-input-ui-fixture.mjs';

const state={workspace:{kind:'model',supportsModelContext:true},ready:true,busy:false,mcpCandidatesAvailable:true,
  account:{required:false},connectionGeneration:7,codexAccount:{accountRevision:3,status:'verified'}};

async function setup(t){
  const ui=await createInputUi();t.after(()=>ui.close());
  ui.emit('state',state);ui.emit('conversation',{busy:false,session:session()});await flush();return ui;
}

test('candidate UI shows only explicit snapshot information and never enables or invokes MCP',async t=>{
  const ui=await setup(t),panel=ui.get('model-mcp-candidates');assert.equal(panel.hidden,false);
  panel.querySelectorAll('.model-mcp-read')[0].click();await flush();
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/mcp-candidates');
  assert.deepEqual(Object.keys(ui.requests[0].body),['client']);
  await ui.respond(ui.requests[0],{source:'launch_snapshot',generation:7,servers:[
    {name:'configured_server',status:'disabled'},{name:'revit_workbench',status:'reserved'},{name:'pending',status:'unknown'}]});
  assert.match(panel.textContent,/configured_server · 本连接已禁用/);
  assert.match(panel.textContent,/revit_workbench · BuildX 内建服务名称/);
  assert.match(panel.textContent,/pending · 状态尚未核实/);
  assert.match(panel.textContent,/不会连接、启动或授权第三方 MCP/);
  assert.equal(ui.requests.length,1);
});

test('a late configuration response cannot cross an account or connection change',async t=>{
  const ui=await setup(t),panel=ui.get('model-mcp-candidates');
  panel.querySelectorAll('.model-mcp-read')[0].click();await flush();assert.equal(ui.requests.length,1);
  ui.emit('state',{...state,connectionGeneration:8,codexAccount:{accountRevision:4,status:'verified'}});
  await ui.respond(ui.requests[0],{source:'launch_snapshot',generation:7,servers:[{name:'OLD_NAME',status:'disabled'}]});
  assert.doesNotMatch(panel.textContent,/OLD_NAME/);
  panel.querySelectorAll('.model-mcp-read')[0].click();await flush();assert.equal(ui.requests.length,2);
  ui.window.dispatchEvent(new UiEvent('buildx-account-changed'));await flush();
  await ui.respond(ui.requests[1],{source:'launch_snapshot',generation:8,servers:[{name:'OTHER_OLD_NAME',status:'disabled'}]});
  assert.doesNotMatch(panel.textContent,/OTHER_OLD_NAME/);
});

test('read-only and customer chat never expose the model workspace control',async t=>{
  const ui=await createInputUi({kind:'customer-chat',layout:false});t.after(()=>ui.close());
  await ui.intent('buildx-mcp-candidates-read');assert.equal(ui.requests.length,0);
});
