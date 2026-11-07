import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {singleParameterWriteFixture,SOURCE_DOCUMENT,writeEnvelope} from './test-support/native-single-parameter-write-fixtures.mjs';
const name='revit_get_snapshot_delta',operation='get_snapshot_delta',token='a'.repeat(32),host={version:'0.8.9',atomicReadSnapshot:true,nativeSnapshotDeltaVersion:1,nativeSnapshotDeltaOperations:[operation]},args=(more)=>({expected_document:SOURCE_DOCUMENT.path,...more});
const business={status:{schema_version:1,state:'none',baseline_token:null,version:null,baseline_count:null,reason:null},start:{schema_version:1,state:'active',baseline_token:token,version:0,baseline_count:2,reason:null},page:{schema_version:1,state:'active',baseline_token:token,version:1,offset:0,limit:1,total:1,has_more:false,items:[{version:1,kind:'deleted',element_id:'9',unique_id:'uid-9'}]}};
const envelope=(r,override={})=>{const e=writeEnvelope(r,{value:business[r.args.action]});const doc={title:SOURCE_DOCUMENT.title,path:SOURCE_DOCUMENT.path,activeViewId:12,activeViewType:'ThreeD',modified:false};const capabilities={atomicReadSnapshot:true,nativeSnapshotDeltaVersion:1,nativeSnapshotDeltaOperations:[operation]};e.result={operation,hostSession:SOURCE_DOCUMENT.session,atomicReadSnapshot:true,snapshot:{hostSession:SOURCE_DOCUMENT.session,hostVersion:host.version,document:doc,capabilities},value:{operation,hostSession:SOURCE_DOCUMENT.session,document:{title:doc.title,path:doc.path},modifiedByOperation:false,value:business[r.args.action]},...override};return e;};
test('atomic snapshot candidate binds capability and explicit status/start/page original receipts',async t=>{
 const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:[operation],respondEnvelope:envelope});
 for(const input of [{action:'status'},{action:'start'},{action:'page',baseline_token:token,expected_version:1,offset:0,limit:1}]){const result=await invokeWorkbench(name,args(input),f.options());f.remember(result.receiptOwner);assert.equal(result.value.state,input.action==='status'?'none':'active');assert.equal(result.receiptOwner.inspect().value.status,'received');}
 assert.equal(f.requests.length,3);assert.ok(f.requests.every(x=>x.atomicRead===true&&x.operation===operation));
});
test('snapshot query fails closed before publication for absent capability and invalid pages',async t=>{
 const absent=await singleParameterWriteFixture(t,{hostPatch:{version:'0.8.9',atomicReadSnapshot:true},operations:[operation]});await assert.rejects(invokeWorkbench(name,args({action:'status'}),absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);
 const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:[operation],respondEnvelope:envelope});for(const bad of [{action:'page'},{action:'start',offset:0},{action:'page',baseline_token:token,expected_version:1,offset:0,limit:101}])await assert.rejects(invokeWorkbench(name,args(bad),f.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
});
test('mismatched host, capability, version and document never publish a successful page',async t=>{
 const page={action:'page',baseline_token:token,expected_version:1,offset:0,limit:1};
 for(const change of [r=>{r.snapshot.hostSession='b'.repeat(32)},r=>{r.snapshot.capabilities.nativeSnapshotDeltaVersion=0},r=>{r.value.document.path='D:\\other.rvt'},r=>{r.value.value.version=2}]){
  const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:[operation],respondEnvelope:r=>{const e=envelope(r);e.result=structuredClone(e.result);change(e.result);return e;}});let owner;
  await assert.rejects(invokeWorkbench(name,args(page),f.options()),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(f.requests.length,1);assert.ok(owner);
 }
});


test('omitted document is atomically bound by host and retained receipt validates it',async t=>{
 const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:[operation],respondEnvelope:envelope});const result=await invokeWorkbench(name,{action:'status'},f.options());f.remember(result.receiptOwner);assert.equal(result.value.state,'none');assert.equal(f.requests[0].args.expected_document,undefined);assert.equal(result.receiptOwner.inspect().value.status,'received');
});

test('late start receipt is inspected on original request and never replayed',async t=>{
 const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:[operation],respond:false,respondEnvelope:envelope});let owner;
 await assert.rejects(invokeWorkbench(name,args({action:'start'}),f.options({timeout:350})),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
 assert.equal(f.requests.length,1);assert.ok(owner);assert.equal(owner.inspect().value.status,'pending');await f.publish(f.requests[0]);const observed=owner.inspect();assert.equal(observed.ok,true);assert.equal(observed.value.status,'received');assert.equal(f.requests.length,1);
});
