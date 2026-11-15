import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeleteApprovalOwner} from '../lib/delete-approval-owner.mjs';
const doc={session:'a'.repeat(32),path:'D:\\controlled\\demo.rvt',title:'demo'};
const args={expected_document:doc.path,mode:'commit',target_id:'3',target_unique_id:'uid-3'};
const ticket='f9ab319a-0e99-44a5-8a22-d61db9dc799a',requestId='3dd22134-29e8-4b12-a71a-c24503c99139';
const preview=()=>({schema_version:1,request_id:requestId,host_session:doc.session,rollback_status:'rolled_back',complete:true,deleted:[{element_id:'3',unique_id:'uid-3'},{element_id:'15',unique_id:'uid-15'}],native_token:'b'.repeat(32),expires_utc:new Date(Date.now()+60000).toISOString()});
const host={sessionId:doc.session,nativeDeletePrepareVersion:1,nativeDeleteOperations:['delete_sheet']};
function fixture(value=preview()){
 const source=Object.freeze({}),used=new Set();
 const owner=createDeleteApprovalOwner({consumeVerifiedPreview:async proof=>{if(proof!==source||used.has(proof))return null;used.add(proof);return structuredClone(value);}});return {owner,source};
}
test('trusted preview, explicit decision and native permit are request-bound and one use',async()=>{
 const {owner,source}=fixture();const prepared=await owner.capture({args,sourceDocument:doc,previewReceipt:source});const review=owner.review(prepared,{args,sourceDocument:doc});
 assert.equal(review.review.count,2);assert.equal(review.review.preview_request_id,requestId);assert.equal(review.review.external_effects,'not_assessed');
 const deadline=Date.now()+30000,proof=owner.issueDecision(prepared,{args,sourceDocument:doc,ticket,deadline});
 const permit=owner.approve(prepared,proof,{args,sourceDocument:doc,ticket,digest:review.digest});
 assert.throws(()=>owner.approve(prepared,proof,{args,sourceDocument:doc,ticket,digest:review.digest}));
 const native=owner.consume(permit,{args,sourceDocument:doc,host});assert.equal(native.native_token,'b'.repeat(32));assert.deepEqual(native.expected_deleted,review.review.deleted);
 assert.throws(()=>owner.consume(permit,{args,sourceDocument:doc,host}));assert.throws(()=>owner.review(prepared,{args,sourceDocument:doc}));
});
test('unverified or consumed preview cannot become authority',async()=>{
 const {owner,source}=fixture();await assert.rejects(owner.capture({args,sourceDocument:doc,previewReceipt:preview()}));
 await owner.capture({args,sourceDocument:doc,previewReceipt:source});await assert.rejects(owner.capture({args,sourceDocument:doc,previewReceipt:source}));
});
test('incomplete rollback, wrong host and malformed impact fail closed',async()=>{
 for(const change of [{rollback_status:'unknown'},{complete:false},{host_session:'c'.repeat(32)},{deleted:[]},{deleted:[{element_id:'3',unique_id:'wrong'}]},{deleted:[{element_id:'15',unique_id:'uid-15'},{element_id:'3',unique_id:'uid-3'}]},{deleted:[{element_id:'3',unique_id:'uid-3'},{element_id:'15',unique_id:'uid-3'}]},{expires_utc:new Date(Date.now()-1000).toISOString()}]){
  const {owner,source}=fixture({...preview(),...change});await assert.rejects(owner.capture({args,sourceDocument:doc,previewReceipt:source}));
 }
});
test('document, request, decision digest and host drift reject without authorizing',async()=>{
 for(const mutation of ['document','target','mode','digest','host','capability']){
  const {owner,source}=fixture();const p=await owner.capture({args,sourceDocument:doc,previewReceipt:source});const r=owner.review(p,{args,sourceDocument:doc});const deadline=Date.now()+30000;
  if(mutation==='document'){assert.throws(()=>owner.issueDecision(p,{args,sourceDocument:{...doc,path:'other'},ticket,deadline}));continue;}
  if(mutation==='target'||mutation==='mode'){assert.throws(()=>owner.issueDecision(p,{args:{...args,...mutation==='target'?{target_unique_id:'different'}:{mode:'rollback'}},sourceDocument:doc,ticket,deadline}));continue;}
  const proof=owner.issueDecision(p,{args,sourceDocument:doc,ticket,deadline});
  if(mutation==='digest'){assert.throws(()=>owner.approve(p,proof,{args,sourceDocument:doc,ticket,digest:'0'.repeat(64)}));continue;}
  const permit=owner.approve(p,proof,{args,sourceDocument:doc,ticket,digest:r.digest});assert.throws(()=>owner.consume(permit,{args,sourceDocument:doc,host:mutation==='host'?{...host,sessionId:'c'.repeat(32)}:{...host,nativeDeletePrepareVersion:0}}));
  assert.throws(()=>owner.consume(permit,{args,sourceDocument:doc,host}));
 }
});
test('no JSON proof, invalid deadline or forged prepared object is accepted',async()=>{
 const {owner,source}=fixture();const p=await owner.capture({args,sourceDocument:doc,previewReceipt:source});const r=owner.review(p,{args,sourceDocument:doc});
 assert.throws(()=>owner.review({}, {args,sourceDocument:doc}));assert.throws(()=>owner.issueDecision(p,{args,sourceDocument:doc,ticket,deadline:Date.now()-1}));
 assert.throws(()=>owner.approve(p,{confirmed:true},{args,sourceDocument:doc,ticket,digest:r.digest}));
});

test('mutation while the trusted verifier is pending cannot alter bound request or review',async()=>{
 const localArgs={...args},localDoc={...doc},source={};let release;const gate=new Promise(r=>release=r);
 const owner=createDeleteApprovalOwner({consumeVerifiedPreview:async(ref,binding)=>{assert.equal(ref,source);await gate;assert.equal(binding.args.target_id,'3');return preview();}});
 const pending=owner.capture({args:localArgs,sourceDocument:localDoc,previewReceipt:source});localArgs.target_id='15';localDoc.path='changed';release();const p=await pending;
 assert.equal(owner.review(p,{args,sourceDocument:doc}).review.target_id,'3');assert.throws(()=>owner.review(p,{args:localArgs,sourceDocument:localDoc}));
});

test('preview enforces bounded unique canonical identities and exact target',async()=>{
 const rows=Array.from({length:501},(_,i)=>({element_id:String(i+1),unique_id:'uid-'+(i+1)}));
 for(const deleted of [rows,[{element_id:'03',unique_id:'uid-3'}],[{element_id:'3',unique_id:'uid-3'},{element_id:'3',unique_id:'different'}],[{element_id:'9223372036854775808',unique_id:'other'}]]){
  const f=fixture({...preview(),deleted});await assert.rejects(f.owner.capture({args,sourceDocument:doc,previewReceipt:f.source}));
 }
});
