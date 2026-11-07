import test from 'node:test';
import assert from 'node:assert/strict';
import {MODEL_WORKSPACE_TOOLS} from './lib/panel-tools.mjs';
import {modelOperationEffect,supportsModelPermissionTool} from './lib/model-operation-effects.mjs';
test('experimental NWC export is absent from public catalog and permissions',()=>{
 assert.equal(MODEL_WORKSPACE_TOOLS.some(tool=>tool.name==='revit_export_nwc'),false);
 assert.equal(modelOperationEffect('revit_export_nwc').known,false);
 assert.equal(supportsModelPermissionTool('revit_export_nwc'),false);
});
