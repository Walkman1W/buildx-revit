import test from 'node:test';
import assert from 'node:assert/strict';
import {modelCommandPresentation} from '../public/model-workspace.mjs';
const fingerprint='a'.repeat(64);
const value={schema_version:1,coverage:'complete_current_document_instances',authorization:'not_granted',binding_attempted:false,instance_count:2,offset:0,limit:1,snapshot_id:fingerprint,has_more:true,instances:[{element_id:'101',category_id:'-2000011',unique_id:'uid-a'}]};
const command=data=>({commandId:'revit_preview_project_parameter_binding',status:'completed',result:{document:{title:'fixture'},data:{value:data}}});
test('binding preview states page coverage, future impact and continuation fingerprint',()=>{
 const view=modelCommandPresentation(command(value));assert.equal(view.status,'已完成');assert.deepEqual(view.rows,[['101','-2000011','uid-a']]);
 assert.match(view.summary,/第 1–1 项 \/ 共 2 项/);assert.match(view.summary,/未来实例/);assert.match(view.summary,/不授予写入权限/);assert.match(view.summary,new RegExp(fingerprint));
});
test('incomplete or falsely authorized impact is not rendered as complete',()=>{
 for(const changed of [{...value,coverage:'partial'},{...value,authorization:'granted'},{...value,binding_attempted:true},{...value,has_more:false}]){const view=modelCommandPresentation(command(changed));assert.equal(view.status,'结果待核对');assert.match(view.error,/原回执/);}
});
