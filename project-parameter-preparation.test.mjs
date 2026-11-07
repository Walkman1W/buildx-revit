import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProjectParameterPreparation as validate} from './lib/project-parameter-preparation.mjs';
const base={schema_version:1,guid:'f173029f-a81a-48c3-a5af-7c7b9a857b4a',state:'absent',parameter_id:null,name:null,data_type:null,binding_kind:null,bound_category_ids:[],requested_categories:[{category_id:'-2000011',category_name:'Walls'}],scope:'current_document_top_level_categories',write_authorization:'not_granted',external_definition_verified:false,impact_assessed:false,shared_parameter_file_accessed:false};
test('unregistered parameter preparation validates binding facts and never grants write authority',()=>{
 assert.deepEqual(validate(base),base);const bound={...base,state:'bound',parameter_id:'9007199254740993',name:'P',data_type:'text',binding_kind:'instance',bound_category_ids:['-2000011']};assert.deepEqual(validate(bound),bound);
 for(const patch of [{write_authorization:'granted'},{external_definition_verified:true},{impact_assessed:true},{state:'bound'},{guid:'00000000-0000-0000-0000-000000000000'},{requested_categories:[{category_id:'-1',category_name:'bad'}]},{bound_category_ids:['-1']},{extra:true}])assert.throws(()=>validate({...base,...patch}));
});
import {WORKBENCH_TOOLS} from './lib/workbench-client.mjs';
import {MODEL_WORKSPACE_TOOLS} from './lib/panel-tools.mjs';
test('preparation remains unregistered and does not expose parameter creation writes',()=>{
 for(const name of ['revit_create_project_parameter','revit_create_shared_parameter','revit_prepare_project_parameter']){
  assert.equal(WORKBENCH_TOOLS.some(tool=>tool.name===name),false);assert.equal(MODEL_WORKSPACE_TOOLS.some(tool=>tool.name===name),false);
 }
});
