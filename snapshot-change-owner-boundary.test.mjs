import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKBENCH_TOOLS} from './lib/workbench-client.mjs';
import {MODEL_AI_EFFECT_TOOLS,MODEL_AI_READ_TOOLS} from './lib/panel-tools.mjs';
import {modelOperationEffect,supportsModelPermissionTool} from './lib/model-operation-effects.mjs';
import {describeModelOperationSchema} from './lib/model-operation-contracts.mjs';

test('snapshot delta is classified only as a named read and never as write authority',()=>{
 const name='revit_get_snapshot_delta';
 assert.equal(WORKBENCH_TOOLS.filter(item=>item.name===name).length,1);
 assert.equal(MODEL_AI_READ_TOOLS.filter(item=>item.name===name).length,1);
 assert.equal(MODEL_AI_EFFECT_TOOLS.some(item=>item.name===name),false);
 assert.equal(modelOperationEffect(name).kind,'read');
 assert.equal(supportsModelPermissionTool(name),false);
 assert.equal(describeModelOperationSchema({tool:name}).ok,true);
});
