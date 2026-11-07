import test from 'node:test';
import assert from 'node:assert/strict';
import {interpretBatchFilterCandidateReceipt as inspect} from './lib/batch-filter-receipt-candidate.mjs';
const session='a'.repeat(32),id='3a75a346-0f5d-4eb8-9f74-b80674a5b831',host={sessionId:session},source={session,title:'Fixture',path:'D:\\fixture.rvt'},args={expected_document:source.path,mode:'commit',category:'OST_Walls',type_id:'10',level_id:'20',parameter_id:'-100',value:'new'};
const row={element_id:'101',unique_id:'uid-101',parameter_id:'-100',storage_type:'String',has_value:true,value_internal:'old',data_type:'text'};
const preview={schema_version:1,scope:'exact_category_type_level_instances',category:'OST_Walls',type_id:'10',level_id:'20',parameter_id:'-100',scanned:1,complete:true,total:1,items:[row],write_authorization:'not_granted'};
const envelope=()=>({id,ok:true,completedUtc:new Date().toISOString(),timing:{schemaVersion:1,requestId:id,hostSession:session},result:{operation:'batch_set_parameters_by_filter',request_id:id,hostSession:session,document:{title:source.title,path:source.path},effect:'model_transaction',context_current_after:true,value:{status:'completed',selected_count:1,committed:true,mode:'commit',saved:false,reviewed:preview,target:'new',value_unit:null}}});
test('candidate receipt binds original request, host, document and complete reviewed facts',()=>{assert.equal(inspect(JSON.stringify(envelope()),host,id,args,source).status,'received');});
test('candidate receipt fails closed on unknown, foreign or mismatched facts',()=>{
 for(const change of [e=>{e.result.context_current_after=false},e=>{e.result.hostSession='b'.repeat(32)},e=>{e.result.document.path='D:\\other.rvt'},e=>{e.result.value.reviewed={...preview,complete:false}},e=>{e.result.value.target='other'},e=>{e.result.value.reviewed={...preview,items:[row,row],total:2}},e=>{e.ok=false}]){const e=structuredClone(envelope());change(e);assert.equal(inspect(JSON.stringify(e),host,id,args,source).status,'unconfirmed');}
});
