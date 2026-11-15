import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProjectBindingPreview} from '../../lib/project-instance-binding-preview.mjs';
import {MODEL_WORKSPACE_TOOLS} from '../../lib/panel-tools.mjs';
const args={expected_document:'C:\\test\\model.rvt',definition_guid:'d6c25563-54cb-43e7-8003-e7cf8df36916',definition_id:'45',data_type:'autodesk.spec.aec:string.text-1.0.0',category_ids:['-2000011']};
const result={schema_version:1,definition_guid:args.definition_guid,definition_id:args.definition_id,data_type:args.data_type,definition_name:'Test',document_title:'model',document_path:args.expected_document,binding_before:'unbound',proposed_binding:'instance',category_ids:['-2000011'],instance_count:1,instances:[{element_id:'9007199254740993',category_id:'-2000011',unique_id:'synthetic-1'}],offset:0,limit:50,snapshot_id:'a'.repeat(64),has_more:false,coverage:'complete_current_document_instances',future_instances_affected:true,authorization:'not_granted',host_session_bound:false,human_decision:false,binding_attempted:false,external_file_accessed:false};
test('exact bounded facts preserved without authority',()=>{const copy=validateProjectBindingPreview(result,args);assert.deepEqual(copy,result);assert.notEqual(copy,result);});
test('identity, evidence and completeness drift are refused',()=>{for(const patch of [{definition_id:'46'},{document_path:'C:\\other.rvt'},{authorization:'granted'},{human_decision:true},{coverage:'partial'},{instance_count:0},{category_ids:['-2000032']},{instances:[...result.instances,...result.instances],instance_count:2}])assert.throws(()=>validateProjectBindingPreview({...result,...patch},args));});
test('duplicates and malformed request rejected before use',()=>{for(const patch of [{category_ids:['-2000011','-2000011']},{definition_id:'9007199254740993000'},{definition_guid:'00000000-0000-0000-0000-000000000000'}])assert.throws(()=>validateProjectBindingPreview(result,{...args,...patch}));});
test('only the read preview is registered',()=>{assert.equal(MODEL_WORKSPACE_TOOLS.some(tool=>tool.name==='revit_preview_project_parameter_binding'),true);for(const name of ['revit_create_project_parameter','revit_create_shared_parameter'])assert.equal(MODEL_WORKSPACE_TOOLS.some(tool=>tool.name===name),false);});

test('pages require matching fingerprint and consistent complete-set count',()=>{
 const fingerprint='a'.repeat(64),first={...result,instance_count:2,offset:0,limit:1,snapshot_id:fingerprint,has_more:true};
 assert.equal(validateProjectBindingPreview(first,{...args,offset:0,limit:1}).has_more,true);
 const second={...first,offset:1,has_more:false,instances:[{element_id:'9007199254740994',category_id:'-2000011',unique_id:'synthetic-2'}]};
 assert.equal(validateProjectBindingPreview(second,{...args,offset:1,limit:1,expected_snapshot:fingerprint}).offset,1);
 assert.throws(()=>validateProjectBindingPreview(second,{...args,offset:1,limit:1}));
 assert.throws(()=>validateProjectBindingPreview(second,{...args,offset:1,limit:1,expected_snapshot:'b'.repeat(64)}));
 assert.throws(()=>validateProjectBindingPreview({...first,has_more:false},{...args,offset:0,limit:1}));
});
