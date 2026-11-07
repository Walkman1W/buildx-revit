import test from 'node:test';import assert from 'node:assert/strict';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {assertBatchPreviewArgs,assertBatchPreviewResult} from './lib/batch-filter-preview.mjs';
import {singleParameterWriteFixture,SOURCE_DOCUMENT,writeEnvelope} from './test-support/native-single-parameter-write-fixtures.mjs';
const name='revit_preview_batch_parameter_filter',operation='preview_batch_parameter_filter';
const host={version:'0.8.9',atomicReadSnapshot:true,nativeBatchFilterPreviewVersion:1,nativeBatchFilterPreviewOperations:[operation]};
const args={expected_document:SOURCE_DOCUMENT.path,category:'OST_Walls',type_id:'10',level_id:'20',parameter_id:'-100'};
const value={schema_version:1,scope:'exact_category_type_level_instances',category:'OST_Walls',type_id:'10',level_id:'20',parameter_id:'-100',scanned:1,complete:true,total:1,items:[{element_id:'101',unique_id:'uid-101',parameter_id:'-100',storage_type:'String',has_value:true,value_internal:'old',data_type:'text'}],write_authorization:'not_granted'};
const envelope=r=>{const e=writeEnvelope(r,{value});const document={title:SOURCE_DOCUMENT.title,path:SOURCE_DOCUMENT.path,activeViewId:12,activeViewType:'ThreeD',modified:false};e.result={operation,hostSession:SOURCE_DOCUMENT.session,atomicReadSnapshot:true,snapshot:{hostSession:SOURCE_DOCUMENT.session,hostVersion:host.version,document,capabilities:{atomicReadSnapshot:true,nativeBatchFilterPreviewVersion:1,nativeBatchFilterPreviewOperations:[operation]}},value:{operation,hostSession:SOURCE_DOCUMENT.session,document:{title:document.title,path:document.path},modifiedByOperation:false,value}};return e;};
test('preview contract rejects incomplete, drifted and malformed facts',()=>{assertBatchPreviewArgs(args);assertBatchPreviewResult(value,args);for(const v of [{...value,complete:false},{...value,total:2},{...value,items:[value.items[0],value.items[0]],total:2,scanned:2},{...value,write_authorization:'granted'},{...value,parameter_id:'-101'}])assert.throws(()=>assertBatchPreviewResult(v,args));for(const a of [{...args,category:'Walls'},{...args,parameter_id:'-1'},{...args,limit:1}])assert.throws(()=>assertBatchPreviewArgs(a));});
test('atomic preview checks capability and preserves original receipt',async t=>{const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:[operation],respondEnvelope:envelope});const result=await invokeWorkbench(name,args,f.options());f.remember(result.receiptOwner);assert.equal(result.value.write_authorization,'not_granted');assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(f.requests.length,1);assert.equal(f.requests[0].atomicRead,true);});
test('production MCP returns structured preview from one atomic request',async t=>{const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:[operation],respondEnvelope:envelope});const {client}=await f.connect(['--workspace']);const result=await client.callTool({name,arguments:args},{timeout:5000});assert.equal(result.isError,false);assert.equal(result.structuredContent.value.write_authorization,'not_granted');assert.equal(f.requests.length,1);assert.equal(f.requests[0].atomicRead,true);});
test('unsupported host refuses before publication and foreign result remains unknown',async t=>{const absent=await singleParameterWriteFixture(t,{hostPatch:{version:'0.8.9',atomicReadSnapshot:true},operations:[operation]});await assert.rejects(invokeWorkbench(name,args,absent.options()),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(absent.requests.length,0);const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:[operation],respondEnvelope:r=>{const e=envelope(r);e.result.value.document.path='D:\\other.rvt';return e;}});await assert.rejects(invokeWorkbench(name,args,f.options()),e=>{const facts=workbenchFailureEvidence(e);f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(f.requests.length,1);});
test('late original receipt is inspected without replay',async t=>{const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:[operation],respond:false,respondEnvelope:envelope});let owner;await assert.rejects(invokeWorkbench(name,args,f.options({timeout:350})),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(f.requests.length,1);assert.equal(owner.inspect().value.status,'pending');await f.publish(f.requests[0]);assert.equal(owner.inspect().value.status,'received');assert.equal(f.requests.length,1);});
import {describeModelOperationSchema} from './lib/model-operation-contracts.mjs';
import {modelCommandByTool} from './lib/model-command-catalog.mjs';
import {modelOperationEffect} from './lib/model-operation-effects.mjs';
test('preview is discoverable as read only without advertising batch writes',()=>{const c=describeModelOperationSchema({tool:name});assert.equal(c.ok,true);assert.equal(modelCommandByTool(name).readOnly,true);assert.equal(modelOperationEffect(name).kind,'read');assert.equal(modelCommandByTool('revit_batch_set_parameters_by_filter'),null);});
test('omitted document binds atomically and original receipt remains inspectable',async t=>{const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:[operation],respondEnvelope:envelope});const {expected_document,...bound}=args;const result=await invokeWorkbench(name,bound,f.options());f.remember(result.receiptOwner);assert.equal(f.requests[0].args.expected_document,undefined);assert.equal(result.receiptOwner.inspect().value.status,'received');});

test('batch native preparation retains original read receipt and binds the returned capability',async t=>{
 const proposal={...args,mode:'rollback',storage_type:'String',value:'new'};
 const respondEnvelope=r=>{const e=envelope(r);e.result.snapshot.capabilities.nativeBatchFilterPreparationVersion=1;e.result.batch_write_preparation={schema_version:1,token:'c'.repeat(32),expires_utc:new Date(Date.now()+60000).toISOString()};return e;};
 const f=await singleParameterWriteFixture(t,{hostPatch:{...host,nativeBatchFilterPreparationVersion:1},operations:[operation],respondEnvelope});
 const result=await invokeWorkbench(name,args,f.options({atomicRead:true,batchWriteProposal:proposal}));f.remember(result.receiptOwner);
 assert.ok(result.batchWritePreparation);assert.equal(Object.keys(result).includes('batchWritePreparation'),false);assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(f.requests.length,1);assert.equal(f.requests[0].args.batch_write_proposal.mode,'rollback');
 const {preparedBatchWriteReview}=await import('./lib/batch-filter-write-approval.mjs');assert.equal(preparedBatchWriteReview(result.batchWritePreparation,{args:proposal,sourceDocument:SOURCE_DOCUMENT}).review.total,1);
});
test('batch preparation cannot queue against old host or mismatched filter',async t=>{
 const proposal={...args,mode:'rollback',storage_type:'String',value:'new'};
 const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:[operation]});
 await assert.rejects(invokeWorkbench(name,args,f.options({atomicRead:true,batchWriteProposal:proposal})),e=>workbenchFailureEvidence(e).outcome==='not_started');
 await assert.rejects(invokeWorkbench(name,args,f.options({atomicRead:true,batchWriteProposal:{...proposal,category:'OST_Floors'}})),e=>workbenchFailureEvidence(e).outcome==='not_started');assert.equal(f.requests.length,0);
});

test('batch preparation timeout preserves only the original read receipt and never replays',async t=>{
 const proposal={...args,mode:'rollback',storage_type:'String',value:'new'};
 const respondEnvelope=r=>{const e=envelope(r);e.result.snapshot.capabilities.nativeBatchFilterPreparationVersion=1;e.result.batch_write_preparation={schema_version:1,token:'c'.repeat(32),expires_utc:new Date(Date.now()+60000).toISOString()};return e;};
 const f=await singleParameterWriteFixture(t,{hostPatch:{...host,nativeBatchFilterPreparationVersion:1},operations:[operation],respond:false,respondEnvelope});let owner;
 await assert.rejects(invokeWorkbench(name,args,f.options({atomicRead:true,batchWriteProposal:proposal,timeout:350})),e=>{const facts=workbenchFailureEvidence(e);owner=f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});
 assert.equal(f.requests.length,1);assert.equal(owner.inspect().value.status,'pending');await f.publish(f.requests[0]);assert.equal(owner.inspect().value.status,'received');assert.equal(f.requests.length,1);
});
test('malformed preparation token leaves original receipt owned and cannot be approved',async t=>{
 const proposal={...args,mode:'rollback',storage_type:'String',value:'new'};
 const respondEnvelope=r=>{const e=envelope(r);e.result.snapshot.capabilities.nativeBatchFilterPreparationVersion=1;e.result.batch_write_preparation={schema_version:1,token:'invalid',expires_utc:new Date(Date.now()+60000).toISOString()};return e;};
 const f=await singleParameterWriteFixture(t,{hostPatch:{...host,nativeBatchFilterPreparationVersion:1},operations:[operation],respondEnvelope});
 await assert.rejects(invokeWorkbench(name,args,f.options({atomicRead:true,batchWriteProposal:proposal})),e=>{const facts=workbenchFailureEvidence(e);f.remember(facts.receiptOwner);return facts.outcome==='unconfirmed';});assert.equal(f.requests.length,1);
});
