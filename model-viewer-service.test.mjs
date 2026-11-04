import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelViewerService} from './lib/model-viewer-service.mjs';
import {validateTool,ATOMIC_WORKBENCH_TOOL_NAMES,invokeAtomicWorkbenchRead} from './lib/workbench-client.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fixture=()=>({hostSession:'abc',document:{title:'A',path:'A.rvt'},value:{schemaVersion:1,geometry:'axis_aligned_bounding_box',units:'mm',coordinateSystem:'revit_internal',items:[{element_id:'9223372036854775807',unique_id:'uid',name:'墙',category:'墙',min:{x:-304.8,y:0,z:0},max:{x:304.8,y:100,z:500}}],coverage:{examined:2,exported:1,missingBoundingBox:1,failed:0,truncated:true,enumerationComplete:false,order:'revit_collector'}}});

test('capture preserves identity, millimetres, large element IDs and honest coverage',async()=>{
  let value=fixture(),status={hostSession:'abc',document:{title:'A',path:'A.rvt'}};
  const service=createModelViewerService({capture:async()=>value,readStatus:async()=>status,now:()=> 'time'});
  assert.equal((await service.status()).value.state,'empty');
  const result=await service.refresh({limit:2});assert.equal(result.ok,true);
  const s=result.value;assert.equal(s.value.items[0].min.x,-304.8);assert.equal(s.value.coverage.truncated,true);
  assert.equal((await service.status()).value.state,'freshness_unknown');
  assert.equal(service.locate(s.snapshotId,'9223372036854775807').value.item.unique_id,'uid');
  assert.equal(service.locate(s.snapshotId,'1').error.code,'ELEMENT_NOT_IN_SNAPSHOT');
  result.value.value.items[0].name='tampered';value.value.items[0].name='also changed';
  assert.equal(service.get(s.snapshotId).value.value.items[0].name,'墙');
  status={hostSession:'other',document:{title:'A',path:'A.rvt'}};
  assert.equal((await service.status()).value.state,'different_document');
  status=null;assert.equal((await service.status()).value.state,'freshness_unknown');
});

test('rejects malformed geometry, coverage, identity, capacity and preserves prior snapshot on failure',async()=>{
  let value=fixture();const service=createModelViewerService({capture:async()=>value,readStatus:async()=>value});
  const first=(await service.refresh({limit:2})).value;
  assert.equal((await service.refresh({limit:301})).error.code,'INVALID_LIMIT');
  for(const mutate of [x=>x.value.items[0].min.x=Infinity,x=>x.value.items[0].element_id='0',x=>x.value.items[0].max.x=-500,x=>x.value.coverage.examined=3,x=>x.value.coverage.enumerationComplete=true,x=>x.document=null]){
    value=fixture();mutate(value);assert.equal((await service.refresh({limit:2})).error.code,'CAPTURE_FAILED');
    assert.equal(service.get(first.snapshotId).ok,true);
  }
  value=fixture();value.value.items[0].name='new';const second=(await service.refresh({limit:2})).value;
  assert.notEqual(first.snapshotId,second.snapshotId);assert.equal(service.get(first.snapshotId).error.code,'SNAPSHOT_NOT_FOUND');
});

test('capture is serialized and workbench contract is bounded and named',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const service=createModelViewerService({capture:()=>pending,readStatus:async()=>fixture()});
  const first=service.refresh({limit:2});assert.equal((await service.refresh()).error.code,'CAPTURE_BUSY');finish(fixture());assert.equal((await first).ok,true);
  assert.equal(ATOMIC_WORKBENCH_TOOL_NAMES.includes('revit_capture_model_snapshot'),true);
  assert.deepEqual(validateTool('revit_capture_model_snapshot',{expected_document:'A.rvt'}),{operation:'capture_model_snapshot',args:{expected_document:'A.rvt',limit:200}});
  assert.throws(()=>validateTool('revit_capture_model_snapshot',{expected_document:'A.rvt',limit:301}));
});

test('older atomic host is rejected before any capture is queued',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-viewer-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'queue'));await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:'d'.repeat(32),pid:process.pid,version:'0.6.4',atomicReadSnapshot:true}));
  await assert.rejects(invokeAtomicWorkbenchRead('revit_capture_model_snapshot',{limit:1},{root}),/updated atomic-capable host/);
  assert.deepEqual(await fs.readdir(path.join(root,'queue')),['host.json']);
});

test('unconfirmed capture keeps the original request identity and does not retry',async()=>{
  let calls=0;
  const requestId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const service=createModelViewerService({capture:async()=>{calls++;const e=new Error('lost response');e.requestId=requestId;throw e;},readStatus:async()=>fixture()});
  const result=await service.refresh();assert.equal(result.error.outcome,'unconfirmed');assert.deepEqual(result.evidence.requestIds,[requestId]);assert.equal(calls,1);
});

const meshFixture=()=>{
  const x=fixture();x.value.geometry='triangle_mesh_with_bounds';
  Object.assign(x.value.items[0],{mesh:[-304.8,0,0,304.8,0,0,0,100,500],meshStatus:'partial'});
  Object.assign(x.value.coverage,{triangles:1,meshComplete:0,meshMissing:0,meshPartial:1,meshFailed:0,triangleLimit:2400,elementTriangleLimit:300,objectLimit:5000,elapsedLimitMs:2500});
  return x;
};
test('mesh keeps element identity, coordinates and honest partial coverage alongside legacy bounds',async()=>{
  const sample=meshFixture(),service=createModelViewerService({capture:async()=>sample,readStatus:async()=>sample});
  const result=await service.refresh({limit:2});assert.equal(result.ok,true);
  assert.deepEqual(service.locate(result.value.snapshotId,'9223372036854775807').value.item.mesh,sample.value.items[0].mesh);
  assert.equal((await service.status()).value.coverage.meshPartial,1);
});
test('rejects malformed, over-budget or misreported meshes while retaining previous snapshot',async()=>{
  let sample=meshFixture();const service=createModelViewerService({capture:async()=>sample,readStatus:async()=>sample});
  const prior=(await service.refresh({limit:2})).value;
  for(const mutate of [
    x=>x.value.items[0].mesh.pop(),x=>x.value.items[0].mesh[0]=Infinity,
    x=>x.value.items[0].mesh=new Array(2709).fill(0),x=>x.value.items[0].meshStatus='invented',
    x=>x.value.items[0].meshStatus='missing',x=>x.value.coverage.triangles=0,
    x=>x.value.coverage.meshPartial=0,x=>x.value.coverage.triangleLimit=2401]){
    sample=meshFixture();mutate(sample);assert.equal((await service.refresh({limit:2})).error.code,'CAPTURE_FAILED');
    assert.equal(service.get(prior.snapshotId).ok,true);
  }
});
test('serialization-budget omissions and partial meshes retain explicit valid coverage',async()=>{
  const sample=meshFixture();Object.assign(sample.value.coverage,{examined:3,omittedBudget:1,meshBudgetLimited:1,serializationLimit:250000,serializationReserved:249980});
  const service=createModelViewerService({capture:async()=>sample,readStatus:async()=>sample});
  assert.equal((await service.refresh({limit:3})).ok,true);
  for(const mutate of [x=>x.value.coverage.omittedBudget=0,x=>x.value.coverage.meshBudgetLimited=2,x=>x.value.coverage.serializationReserved=250001]){
    const v=meshFixture();Object.assign(v.value.coverage,{examined:3,omittedBudget:1,meshBudgetLimited:1,serializationLimit:250000,serializationReserved:249980});mutate(v);
    const bad=createModelViewerService({capture:async()=>v,readStatus:async()=>v});assert.equal((await bad.refresh({limit:3})).error.code,'CAPTURE_FAILED');
  }
});
