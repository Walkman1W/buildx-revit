import {createHash} from 'node:crypto';

// Private owner for a future native delete workflow. No delete tool is registered.
// The creator must supply a trusted, one-use native receipt verifier. Passing an
// arbitrary JSON preview to this owner is never sufficient evidence.
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const fields=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const fail=()=>{throw new Error('Delete approval unavailable, expired, unverified or mismatched');};
const opaque=()=>Object.freeze(Object.create(null));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const hash=v=>createHash('sha256').update(JSON.stringify(v),'utf8').digest('hex');
const str=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\0\r\n]/.test(v);
function id(v){if(typeof v!=='string'||!/^[1-9]\d{0,18}$/.test(v))fail();const n=BigInt(v);if(n>9223372036854775807n)fail();return n;}
function document(v){if(!fields(v,['session','path','title'])||typeof v.session!=='string'||!/^[a-f0-9]{32}$/.test(v.session)||!str(v.path,32768)||!str(v.title,1024))fail();return [v.session,v.path,v.title];}
function request(v,doc){if(!fields(v,['expected_document','mode','target_id','target_unique_id'])||v.expected_document!==doc.path||!['rollback','commit'].includes(v.mode)||!str(v.target_unique_id,1024))fail();id(v.target_id);return [v.expected_document,v.mode,v.target_id,v.target_unique_id];}
function observation(v,args){
 if(!fields(v,['schema_version','request_id','host_session','rollback_status','complete','deleted','native_token','expires_utc'])||v.schema_version!==1||
  typeof v.request_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v.request_id)||
  v.rollback_status!=='rolled_back'||v.complete!==true||!Array.isArray(v.deleted)||v.deleted.length<1||v.deleted.length>500||
  typeof v.native_token!=='string'||!/^[a-f0-9]{32}$/.test(v.native_token)||typeof v.expires_utc!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.expires_utc))fail();
 let prev=0n;const uids=new Set();let found=false;
 for(const row of v.deleted){if(!fields(row,['element_id','unique_id'])||!str(row.unique_id,1024)||uids.has(row.unique_id))fail();const n=id(row.element_id);if(n<=prev)fail();prev=n;uids.add(row.unique_id);if(row.element_id===args.target_id&&row.unique_id===args.target_unique_id)found=true;}
 if(!found)fail();const expiresAt=Date.parse(v.expires_utc);if(!Number.isSafeInteger(expiresAt)||new Date(expiresAt).toISOString()!==v.expires_utc||expiresAt<=Date.now()||expiresAt>Date.now()+120000)fail();return expiresAt;
}
export function createDeleteApprovalOwner({consumeVerifiedPreview}={}){
 if(typeof consumeVerifiedPreview!=='function')throw new TypeError('Trusted native preview verifier required');
 const prepared=new WeakMap(),decisions=new WeakMap(),approved=new WeakMap();
 async function capture({args,sourceDocument,previewReceipt}={}){
  const docKey=document(sourceDocument),reqKey=request(args,sourceDocument);
  const boundArgs=freeze(structuredClone(args)),boundDoc=freeze(structuredClone(sourceDocument));
  // Verifier must atomically consume a producing transport receipt, validate its
  // host/document/request binding and explicit rollback completion, and return
  // null on any uncertainty. An integration has not yet been implemented.
  const receipt=await consumeVerifiedPreview(previewReceipt,{args:boundArgs,sourceDocument:boundDoc});
  const expiresAt=observation(receipt,boundArgs);if(receipt.host_session!==boundDoc.session)fail();
  const review=freeze({schema_version:1,document:structuredClone(boundDoc),target_id:boundArgs.target_id,target_unique_id:boundArgs.target_unique_id,mode:boundArgs.mode,
   preview_request_id:receipt.request_id,deleted:structuredClone(receipt.deleted),count:receipt.deleted.length,scope:'native_rollback_preview',external_effects:'not_assessed'});
  const digest=hash([docKey,reqKey,review,receipt.native_token,receipt.expires_utc]);const token=opaque();prepared.set(token,{docKey,reqKey,review,digest,nativeToken:receipt.native_token,expiresAt,used:false});return token;
 }
 function peek(token,{args,sourceDocument}={}){const r=prepared.get(token);if(!r||r.used||r.expiresAt<=Date.now()||JSON.stringify(r.docKey)!==JSON.stringify(document(sourceDocument))||JSON.stringify(r.reqKey)!==JSON.stringify(request(args,sourceDocument)))fail();return r;}
 function review(token,bindings){const r=peek(token,bindings);return freeze({review:structuredClone(r.review),digest:r.digest,expiresAt:r.expiresAt});}
 function issueDecision(token,{args,sourceDocument,ticket,deadline}={}){
  const r=peek(token,{args,sourceDocument});if(typeof ticket!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(ticket)||!Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline>r.expiresAt)fail();
  const proof=opaque();decisions.set(proof,{token,ticket,digest:r.digest,deadline});return proof;
 }
 function approve(token,proof,{args,sourceDocument,ticket,digest}={}){
  const decision=decisions.get(proof);if(!decision)fail();decisions.delete(proof);const r=peek(token,{args,sourceDocument});
  if(decision.token!==token||decision.ticket!==ticket||decision.digest!==digest||digest!==r.digest||decision.deadline<=Date.now())fail();
  r.used=true;const permit=opaque();approved.set(permit,{...r,deadline:decision.deadline});return permit;
 }
 function consume(permit,{args,sourceDocument,host}={}){
  const r=approved.get(permit);if(!r)fail();approved.delete(permit);
  if(r.deadline<=Date.now()||r.expiresAt<=Date.now()||JSON.stringify(r.docKey)!==JSON.stringify(document(sourceDocument))||JSON.stringify(r.reqKey)!==JSON.stringify(request(args,sourceDocument))||!plain(host)||host.sessionId!==sourceDocument.session||host.nativeDeletePrepareVersion!==1||!Array.isArray(host.nativeDeleteOperations)||!host.nativeDeleteOperations.includes('delete_sheet')||new Set(host.nativeDeleteOperations).size!==host.nativeDeleteOperations.length)fail();
  return freeze({native_token:r.nativeToken,preview_request_id:r.review.preview_request_id,review_digest:r.digest,expected_deleted:structuredClone(r.review.deleted)});
 }
 return Object.freeze({capture,review,issueDecision,approve,consume});
}
