import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBatchFilterWriteReview} from './lib/batch-filter-write-review.mjs';
const doc={session:'a'.repeat(32),title:'test',path:'D:\\fixture.rvt'};
const args={expected_document:doc.path,category:'OST_Walls',parameter_id:'-100',mode:'rollback',storage_type:'Integer',value:9};
const row={element_id:'101',unique_id:'u1',parameter_id:'-100',storage_type:'Integer',has_value:true,value_internal:1,data_type:'number'};
const preview={schema_version:1,scope:'exact_category_type_level_instances',category:'OST_Walls',type_id:null,level_id:null,parameter_id:'-100',scanned:1,complete:true,total:1,items:[row],write_authorization:'not_granted'};
test('review freezes exact complete source facts and scope',()=>{const r=buildBatchFilterWriteReview(args,preview,doc);assert.equal(r.items[0].value_internal,1);assert.ok(Object.isFrozen(r.items[0]));row.value_internal=7;assert.equal(r.items[0].value_internal,1);row.value_internal=1;});
test('scope, stale document, storage, unit, empty and incomplete facts fail closed',()=>{for(const [a,p,d] of [[{...args,category:'OST_Floors'},preview,doc],[args,preview,{...doc,path:'D:\\other.rvt'}],[{...args,storage_type:'String',value:'x'},preview,doc],[{...args,value_unit:'internal'},preview,doc],[args,{...preview,total:0,items:[]},doc],[args,{...preview,complete:false},doc]])assert.throws(()=>buildBatchFilterWriteReview(a,p,d));});
