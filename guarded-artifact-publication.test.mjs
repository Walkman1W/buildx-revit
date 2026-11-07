import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKBENCH_TOOLS,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {MODEL_WORKSPACE_TOOLS} from './lib/panel-tools.mjs';
import {modelOperationEffect} from './lib/model-operation-effects.mjs';
test('DWG remains unregistered until destination approval and manifest owner exist',()=>{
 for(const name of ['revit_export_dwg','revit_export_ifc','revit_export_nwc']){
  assert.equal(WORKBENCH_TOOLS.some(x=>x.name===name),false);assert.equal(MODEL_WORKSPACE_TOOLS.some(x=>x.name===name),false);assert.equal(modelOperationEffect(name).known,false);
 }
});
test('unknown request errors do not become a safe or retryable file result',()=>{
 const outcome=workbenchFailureEvidence(new Error('filesystem operation timed out'));assert.equal(outcome.outcome,'unconfirmed');assert.deepEqual(outcome.requestIds,[]);
});
