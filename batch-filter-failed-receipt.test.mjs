import test from 'node:test';
import assert from 'node:assert/strict';
import {interpretModelWriteReceipt} from './lib/workbench-client.mjs';
test('batch dispatch failure receipt retains unknown rollback and is not terminal',()=>{
 const host={sessionId:'fixture-host'}, id='fixture-request';
 const envelope={id,ok:false,hostSession:host.sessionId,error:{code:'InvalidOperationException',message:'Outer rollback not confirmed.'},execution:{started:true,phase:'dispatch',reason:null},completedUtc:new Date().toISOString()};
 const result=interpretModelWriteReceipt(JSON.stringify(envelope),host,id,'batch_set_parameters_by_filter',{mode:'commit'},{path:'fixture.rvt',title:'fixture'});
 assert.equal(result.status,'unconfirmed');assert.equal(result.terminal,false);assert.equal(result.evidence.nativeFailure.started,true);
});
