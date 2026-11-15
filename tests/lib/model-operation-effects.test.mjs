import test from 'node:test';
import assert from 'node:assert/strict';
import {modelOperationEffect,supportsModelPermissionTool} from '../../lib/model-operation-effects.mjs';
import {MODEL_WORKSPACE_TOOLS,PANEL_CONFIRMED_ONLY_TOOLS} from '../../lib/panel-tools.mjs';

test('every currently exposed workspace and confirmed-only tool has an explicit effect',()=>{
  for(const tool of [...MODEL_WORKSPACE_TOOLS,...PANEL_CONFIRMED_ONLY_TOOLS]) {
    const effect=modelOperationEffect(tool.name);
    assert.equal(effect.known,true,tool.name);
    assert.equal(effect.kind==='read',tool.annotations?.readOnlyHint===true,tool.name);
  }
});

test('arbitrary scripts, indirect commands, files and family lifecycle never appear as model-only transactions',()=>{
  for(const name of ['revit_execute_csharp','revit_run_command'])assert.equal(modelOperationEffect(name).kind,'script_or_command',name);
  assert.equal(modelOperationEffect('revit_save_command').kind,'local_file');
  for(const name of ['revit_family_create_valve','revit_family_save_job','revit_family_load_job','revit_family_close_job','revit_family_create_cabinet','revit_family_save_cabinet','revit_family_close_cabinet'])
    assert.equal(modelOperationEffect(name).kind,'family',name);
  for(const name of ['revit_smart_annotate','revit_build_schematic'])assert.equal(modelOperationEffect(name).kind,'other_effects',name);
});

test('unknown and malformed names remain unknown, including prototype keys',()=>{
  for(const name of ['revit_new_tool','__proto__','constructor','',undefined,null,{},42])
    assert.deepEqual(modelOperationEffect(name),{kind:'unknown',known:false});
  assert.ok(Object.isFrozen(modelOperationEffect('revit_set_parameters')));
  assert.ok(Object.isFrozen(modelOperationEffect('unknown')));
});

test('permission-supported tool set is explicit, independent of broad effect classification',()=>{
  const supported=MODEL_WORKSPACE_TOOLS.filter(tool=>supportsModelPermissionTool(tool.name)).map(tool=>tool.name);
  assert.equal(supported.length,57);
  assert.equal(modelOperationEffect('revit_place_door').kind,'model_transaction');
  assert.ok(supported.includes('revit_place_door'));
  for(const name of ['revit_execute_csharp','revit_save_command','revit_run_command','revit_family_load_job','revit_family_create_valve','revit_smart_annotate','revit_build_schematic','revit_capture_view','revit_inspect_elements','revit_restore_visual_session'])assert.ok(supported.includes(name),name);
  for(const name of ['revit_family_save_job','revit_family_close_job','revit_family_create_cabinet','constructor','unknown'])assert.equal(supportsModelPermissionTool(name),false,name);
});
