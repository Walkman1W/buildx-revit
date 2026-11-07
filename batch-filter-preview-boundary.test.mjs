import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKBENCH_TOOLS} from './lib/workbench-client.mjs';
import {MODEL_AI_EFFECT_TOOLS,MODEL_AI_READ_TOOLS} from './lib/panel-tools.mjs';
import {modelOperationEffect,supportsModelPermissionTool} from './lib/model-operation-effects.mjs';
import {describeModelOperationSchema} from './lib/model-operation-contracts.mjs';

test('batch-filter preview does not advertise unimplemented write authority',()=>{
 const name='revit_batch_set_parameters_by_filter';
 assert.equal(WORKBENCH_TOOLS.some(tool=>tool.name===name),false);
 assert.equal([...MODEL_AI_EFFECT_TOOLS,...MODEL_AI_READ_TOOLS].some(tool=>tool.name===name),false);
 assert.equal(modelOperationEffect(name).known,false);
 assert.equal(supportsModelPermissionTool(name),false);
 assert.equal(describeModelOperationSchema({tool:name}).ok,false);
});
