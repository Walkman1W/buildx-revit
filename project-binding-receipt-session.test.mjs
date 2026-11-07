import test from 'node:test';
import assert from 'node:assert/strict';
import {interpretModelWriteReceipt} from './lib/workbench-client.mjs';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',session='a'.repeat(32),other='b'.repeat(32),host={sessionId:session,pid:123},source={session,path:'D:\\fixture.rvt',title:'fixture'},args={expected_document:source.path,mode:'rollback',definition_guid:'33333333-3333-4333-8333-333333333333',definition_id:'100',data_type:'text',category_ids:['-2000011'],original_preparation_request_id:'11111111-1111-4111-8111-111111111111'};
const stamp=new Date().toISOString(),timing={schemaVersion:1,requestId:id,hostSession:session,schedulerCorrelation:'unmatched',executeEnteredUtc:stamp,claimedUtc:stamp,responsePreparedUtc:stamp,observedUtc:null,raiseReturnedUtc:null,dispatchStartedUtc:null,dispatchFinishedUtc:null,observedToExecuteMs:null,dispatchMs:null,validationMs:0,hostWorkMs:0,raiseResult:null};
const envelope={id,ok:true,completedUtc:stamp,timing,result:{operation:'bind_existing_project_parameter',hostSession:session,mode:'rollback',committed:false,document:source.title,value:{definition_guid:args.definition_guid,definition_id:args.definition_id,data_type:args.data_type,category_ids:args.category_ids,binding_kind:'instance',original_preparation_request_id:args.original_preparation_request_id}}};
const check=(e=envelope,s=source)=>interpretModelWriteReceipt(JSON.stringify(e),host,id,'bind_existing_project_parameter',args,s);
test('project binding receipt requires matching source, result and any envelope session',()=>{
 assert.equal(check().status,'received');assert.equal(check({...envelope,hostSession:session}).status,'received');
 for(const bad of [{...envelope,hostSession:other},{...envelope,result:{...envelope.result,hostSession:other}},{...envelope,result:{...envelope.result,hostSession:undefined}},{...envelope,timing:{...timing,hostSession:other}}]){const actual=check(bad);assert.equal(actual.status,'unconfirmed');assert.equal(actual.terminal,false);}
 for(const bad of [{...source,session:other},{...source,path:'D:\\other.rvt'}]){const actual=check(envelope,bad);assert.equal(actual.status,'unconfirmed');assert.equal(actual.terminal,false);}
});

test('legacy script write success remains compatible without result hostSession',()=>{
 const legacy={...envelope,result:{operation:'execute_csharp',mode:'rollback',committed:false,document:source.title,value:{}}};
 const result=interpretModelWriteReceipt(JSON.stringify(legacy),host,id,'execute_csharp',{mode:'rollback'},source);
 assert.equal(result.status,'received');assert.equal(result.terminal,true);
});
