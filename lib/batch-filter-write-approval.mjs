import {buildBatchFilterWriteReview} from './batch-filter-write-review.mjs';
import {consumeTypeWriteUserDecision} from './type-parameter-write-approval.mjs';
const prepared=new WeakMap(),approved=new WeakMap();
const fail=()=>{throw new Error('Batch filter approval unavailable, expired or scope changed');};
const opaque=()=>Object.freeze(Object.create(null));
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const key=(args,document)=>JSON.stringify(stable([args,document]));
export function capturePreparedBatchWrite({args,preview,sourceDocument,nativePreparation}={}){
 const review=buildBatchFilterWriteReview(args,preview,sourceDocument), n=nativePreparation;
 if(!n||Object.keys(n).sort().join(',')!=='expires_utc,schema_version,token'||n.schema_version!==1||typeof n.token!=='string'||!/^[a-f0-9]{32}$/.test(n.token)||typeof n.expires_utc!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(n.expires_utc))fail();
 const expiresAt=Date.parse(n.expires_utc),now=Date.now();if(!Number.isSafeInteger(expiresAt)||new Date(expiresAt).toISOString()!==n.expires_utc||expiresAt<=now||expiresAt>now+120000)fail();
 const ref=opaque();prepared.set(ref,{binding:key(args,sourceDocument),review,native:structuredClone(n),expiresAt,used:false});return ref;
}
export function preparedBatchWriteReview(ref,{args,sourceDocument}={}){const r=prepared.get(ref);if(!r||r.used||r.expiresAt<=Date.now()||r.binding!==key(args,sourceDocument))fail();return Object.freeze({review:r.review,expiresAt:r.expiresAt});}
export function approvePreparedBatchWrite(ref,{args,sourceDocument,ticket,digest,deadline,userDecisionProof}={}){
 const r=prepared.get(ref);if(!r||r.used||r.expiresAt<=Date.now()||r.binding!==key(args,sourceDocument)||!Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline>r.expiresAt)fail();
 if(!consumeTypeWriteUserDecision(userDecisionProof,{ticket,digest,sourceDocument}))fail();
 r.used=true;const permit=opaque();approved.set(permit,{...r,deadline});return permit;
}
export function consumeApprovedBatchWrite(permit,{args,sourceDocument,host}={}){
 const r=approved.get(permit);if(!r)fail();approved.delete(permit);
 if(r.deadline<=Date.now()||r.expiresAt<=Date.now()||r.binding!==key(args,sourceDocument)||host?.sessionId!==sourceDocument.session)fail();
 return Object.freeze({schema_version:1,token:r.native.token,review:r.review});
}


