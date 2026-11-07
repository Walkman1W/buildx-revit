import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKBENCH_TOOLS,validateToolArguments} from './lib/workbench-client.mjs';
import {MODEL_AI_EFFECT_TOOLS} from './lib/panel-tools.mjs';

test('internal delete preview does not register a model deletion or preview tool',()=>{
 for(const name of ['revit_delete_sheet','revit_delete_preview','revit_prepare_delete']){
  assert.equal(WORKBENCH_TOOLS.some(x=>x.name===name),false);assert.equal(MODEL_AI_EFFECT_TOOLS.some(x=>x.name===name),false);assert.throws(()=>validateToolArguments(name,{}));
 }
});
