import test from 'node:test';
import assert from 'node:assert/strict';
import {createFamilyCapabilityOwner} from '../../lib/family-capability-owner.mjs';
const host='a'.repeat(32);
const status=()=>({hostSession:host,capabilities:{familyLifecycleApprovalVersion:1},snapshot:{hostSession:host,capabilities:{atomicReadSnapshot:true,familyLifecycleApprovalVersion:1}}});
test('capability discovery demands a strict atomic host status and binds its session',async()=>{
  let call;const owner=createFamilyCapabilityOwner({read:async(...args)=>{call=args;return status();},timeoutMs:800});
  assert.deepEqual(await owner.observe(),{hostSession:host,version:1});assert.deepEqual(call,['revit_workbench_status',{}, {atomicRead:true,timeout:800}]);
});
test('missing, stale or contradictory capability evidence never enables the tools',async()=>{
  for(const changed of [null,{...status(),capabilities:{}},{...status(),snapshot:{hostSession:host,capabilities:{atomicReadSnapshot:true}}},{...status(),snapshot:{hostSession:'b'.repeat(32),capabilities:{atomicReadSnapshot:true,familyLifecycleApprovalVersion:1}}}]){
    await assert.rejects(createFamilyCapabilityOwner({read:async()=>changed}).observe(),/未核实/);
  }
});
test('concurrent checks share a single owned observation and later checks are fresh',async()=>{
  let count=0,release;const owner=createFamilyCapabilityOwner({read:()=>{count++;return new Promise(resolve=>{release=resolve;});}});
  const first=owner.observe(),second=owner.observe();await new Promise(resolve=>setImmediate(resolve));assert.equal(count,1);release(status());
  await Promise.all([first,second]);const third=owner.observe();await new Promise(resolve=>setImmediate(resolve));assert.equal(count,2);release(status());await third;
});
