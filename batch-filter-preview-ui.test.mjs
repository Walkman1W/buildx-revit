import test from 'node:test';
import assert from 'node:assert/strict';
import {modelCommandPresentation} from './public/model-workspace.mjs';

const value={schema_version:1,scope:'exact_category_type_level_instances',category:'OST_Walls',type_id:null,level_id:null,parameter_id:'-100',scanned:2,complete:true,total:2,items:[
  {element_id:'101',unique_id:'uid-a',parameter_id:'-100',storage_type:'String',has_value:true,value_internal:'',data_type:'text'},
  {element_id:'102',unique_id:'uid-b',parameter_id:'-100',storage_type:'Double',has_value:false,value_internal:null,data_type:'length'}],write_authorization:'not_granted'};
const command=data=>({commandId:'revit_preview_batch_parameter_filter',status:'completed',result:{document:{title:'fixture'},data:{value:data}}});
test('complete parameter preview displays instance rows and never grants write authority',()=>{
 const view=modelCommandPresentation(command(value));assert.equal(view.status,'已完成');assert.match(view.summary,/完整匹配 2 个实例.*不授予写入权限/);
 assert.equal(view.rows[0][3],'空字符串（""）');assert.equal(view.rows[1][3],'无值');assert.deepEqual(view.rows.map(row=>row[0]),['101','102']);
});
test('incomplete preview stays unconfirmed, and an empty complete result stays explicit',()=>{
 for(const changed of [{...value,complete:false},{...value,total:1},{...value,write_authorization:'granted'}]){const view=modelCommandPresentation(command(changed));assert.equal(view.status,'结果待核对');assert.match(view.error,/原回执/);}
 const empty=modelCommandPresentation(command({...value,total:0,items:[]}));assert.match(empty.summary,/完整匹配 0 个实例.*不授予写入权限/);
});
