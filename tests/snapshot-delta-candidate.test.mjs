import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSnapshotArgs,assertSnapshotResult,supportsSnapshotDelta} from '../lib/native-snapshot-delta.mjs';
const token='a'.repeat(32),base={expected_document:'D:\\fixture.rvt'};
test('candidate snapshot query requires explicit fixed token and bounded page',()=>{
 for(const action of ['status','start'])assert.doesNotThrow(()=>assertSnapshotArgs({...base,action}));
 const page={...base,action:'page',baseline_token:token,expected_version:3,offset:0,limit:2};assert.doesNotThrow(()=>assertSnapshotArgs(page));
 for(const bad of [{...page,baseline_token:'bad'},{...page,expected_version:-1},{...page,offset:5001},{...page,limit:101},{...page,mode:'rollback'},{...base,action:'start',limit:1}])assert.throws(()=>assertSnapshotArgs(bad));
 assert.equal(supportsSnapshotDelta({nativeSnapshotDeltaVersion:1,nativeSnapshotDeltaOperations:['get_snapshot_delta']}),true);assert.equal(supportsSnapshotDelta({nativeSnapshotDeltaVersion:1,nativeSnapshotDeltaOperations:[]}),false);
});
test('candidate result binds baseline token, version, complete pages and event identity',()=>{
 const none={schema_version:1,state:'none',baseline_token:null,version:null,baseline_count:null,reason:null};assert.doesNotThrow(()=>assertSnapshotResult(none,{...base,action:'status'}));
 const start={...none,state:'active',baseline_token:token,version:0,baseline_count:2};assert.doesNotThrow(()=>assertSnapshotResult(start,{...base,action:'start'}));
 const args={...base,action:'page',baseline_token:token,expected_version:3,offset:0,limit:2},value={schema_version:1,state:'active',baseline_token:token,version:3,offset:0,limit:2,total:3,has_more:true,items:[{version:1,kind:'deleted',element_id:'1',unique_id:'a'},{version:2,kind:'added',element_id:'2',unique_id:'b'}]};assert.doesNotThrow(()=>assertSnapshotResult(value,args));
 for(const bad of [{...value,version:2},{...value,baseline_token:'b'.repeat(32)},{...value,has_more:false},{...value,items:value.items.slice(0,1)},{...value,items:[value.items[0],{...value.items[0]}]},{...value,items:[value.items[1],value.items[0]]}])assert.throws(()=>assertSnapshotResult(bad,args));
});
