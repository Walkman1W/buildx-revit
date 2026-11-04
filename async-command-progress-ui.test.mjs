import test from 'node:test';
import assert from 'node:assert/strict';
import {modelCommandPresentation} from './public/model-workspace.mjs';
import {createInputUi,session,flush} from './test-support/model-input-ui-fixture.mjs';
import {MODEL_COMMAND_CATALOG} from './lib/model-command-catalog.mjs';

test('read and saved-write progress describes observed transport stages without claiming model execution',()=>{
  for(const commandId of ['document','revit_run_command']){
    const command={commandId,status:'running'};
    for(const [phase,label] of [['preparing','正在准备…'],['waiting_revit','等待 Revit 返回…'],['checking_result','正在核对结果…']]){
      const view=modelCommandPresentation({...command,progress:{phase,elapsedMs:25,requestId:'observed-request'}});
      assert.equal(view.status,label);assert.deepEqual(view.rows,[]);assert.equal(view.error,'');assert.ok(view.summary);
      assert.doesNotMatch(view.summary,/已完成|执行成功|开始执行/);
    }
  }
});

test('stopping, unknown and terminal outcomes take precedence over a stale progress projection',()=>{
  const progress={phase:'waiting_revit'};
  assert.equal(modelCommandPresentation({commandId:'document',status:'stopping',progress}).status,'正在停止…');
  assert.equal(modelCommandPresentation({commandId:'document',status:'running',cancelRequested:true,progress}).status,'正在停止…');
  const unknown=modelCommandPresentation({commandId:'revit_run_command',status:'unknown',progress});
  assert.equal(unknown.status,'结果待核对');assert.match(unknown.error,/不要重复提交/);
  assert.equal(modelCommandPresentation({commandId:'document',status:'completed',progress,result:{data:{activeView:{type:'Plan'}}}}).status,'已完成');
  for(const phase of ['PRIVATE','__proto__','constructor'])assert.equal(modelCommandPresentation({commandId:'document',status:'running',progress:{phase}}).summary,'');
});

test('the production composer shows SSE progress and result without submitting a new command or AI turn',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:false,commandsReady:true,directCommandsAvailable:true,commandCatalog:MODEL_COMMAND_CATALOG,historyAvailable:true,account:{required:false},connectionGeneration:1,codexAccount:{accountRevision:1,status:'unavailable'}});
  ui.emit('conversation',{busy:false,session:session()});await flush();
  const command={commandId:'document',conversationId:'chat-a',executionId:'async-1',status:'running',progress:{phase:'waiting_revit',elapsedMs:25,requestId:'request-1'}};
  ui.emit('conversation',{busy:true,session:session(),command});await flush();
  const row=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId==='document');
  assert.match(row.textContent,/等待 Revit 返回/);assert.equal(row.querySelectorAll('.model-command-stop')[0].hidden,false);
  ui.emit('conversation',{busy:false,session:session(),command:{...command,status:'completed',result:{document:{title:'样例'},data:{activeView:{type:'Plan'}}}}});await flush();
  assert.doesNotMatch(row.textContent,/等待 Revit 返回/);assert.match(row.textContent,/已完成/);assert.equal(row.querySelectorAll('.model-command-stop')[0].hidden,true);
  assert.equal(ui.requests.length,0);
});
