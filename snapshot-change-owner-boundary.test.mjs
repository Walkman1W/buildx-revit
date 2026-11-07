import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKBENCH_TOOLS} from './lib/workbench-client.mjs';
import {MODEL_AI_EFFECT_TOOLS,MODEL_AI_READ_TOOLS} from './lib/panel-tools.mjs';
import {modelOperationEffect,supportsModelPermissionTool} from './lib/model-operation-effects.mjs';
import {describeModelOperationSchema} from './lib/model-operation-contracts.mjs';

test('unwired snapshot owner cannot advertise or execute an incomplete delta capability',()=>{
 const name='revit_get_snapshot_delta';
 assert.equal(WORKBENCH_TOOLS.some(item=>item.name===name),false);
 assert.equal([...MODEL_AI_READ_TOOLS,...MODEL_AI_EFFECT_TOOLS].some(item=>item.name===name),false);
 assert.equal(modelOperationEffect(name).known,false);
 assert.equal(supportsModelPermissionTool(name),false);
 assert.equal(describeModelOperationSchema({tool:name}).ok,false);
});
