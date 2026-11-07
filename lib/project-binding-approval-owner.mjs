import {createHash} from 'node:crypto';

// Unregistered preparation primitive. The injected verifier and decision path
// must be supplied by a future trusted transport; neither exists here.
const fail=()=>{throw new Error('Binding approval unavailable or mismatched');};
const opaque=()=>Object.freeze(Object.create(null));
const text=(x,n=1024)=>typeof x==='string'&&x.length>0&&x.length<=n&&!/[\0\r\n]/.test(x);
const positive=x=>typeof x==='string'&&/^[1-9]\d{0,18}$/.test(x)&&BigInt(x)<=9223372036854775807n;
const signed=x=>typeof x==='string'&&/^-?[1-9]\d{0,18}$/.test(x)&&BigInt(x)>=-9223372036854775808n&&BigInt(x)<=9223372036854775807n;
const guid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x)&&x!=='00000000-0000-0000-0000-000000000000';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const keys=(v,k)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===k.length&&k.every(x=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,x)??{},'value'));
function validate(doc,args,receipt){
 if(!keys(doc,['session','path','title'])||!/^[a-f0-9]{32}$/.test(doc.session)||!text(doc.path,32768)||!text(doc.title))fail();
 if(!keys(args,['expected_document','definition_guid','definition_id','data_type','category_ids'])||args.expected_document!==doc.path||!guid(args.definition_guid)||!positive(args.definition_id)||!text(args.data_type)||!Array.isArray(args.category_ids)||args.category_ids.length<1||args.category_ids.length>30||args.category_ids.some(x=>!signed(x))||new Set(args.category_ids).size!==args.category_ids.length)fail();
 if(!keys(receipt,['request_id','host_session','document','definition_guid','definition_id','data_type','category_ids','instances','snapshot_id','complete','authorization','expires_utc'])||!uuid(receipt.request_id)||receipt.host_session!==doc.session||JSON.stringify(receipt.document)!==JSON.stringify(doc)||receipt.definition_guid!==args.definition_guid||receipt.definition_id!==args.definition_id||receipt.data_type!==args.data_type||JSON.stringify(receipt.category_ids)!==JSON.stringify(args.category_ids)||receipt.complete!==true||receipt.authorization!=='not_granted'||!/^[a-f0-9]{64}$/.test(receipt.snapshot_id)||!Array.isArray(receipt.instances)||receipt.instances.length>500)fail();
 let previous=0n;const uids=new Set();for(const row of receipt.instances){if(!keys(row,['element_id','category_id','unique_id'])||!positive(row.element_id)||!args.category_ids.includes(row.category_id)||!text(row.unique_id)||uids.has(row.unique_id)||BigInt(row.element_id)<=previous)fail();previous=BigInt(row.element_id);uids.add(row.unique_id);}
 const expiry=Date.parse(receipt.expires_utc);if(!Number.isSafeInteger(expiry)||new Date(expiry).toISOString()!==receipt.expires_utc||expiry<=Date.now()||expiry>Date.now()+120000)fail();return expiry;
}
export function createProjectBindingApprovalOwner({consumeVerifiedReceipt}={}){
 if(typeof consumeVerifiedReceipt!=='function')throw new TypeError('Trusted one-use original receipt verifier required');
 const prepared=new WeakMap(),decisions=new WeakMap(),permits=new WeakMap();
 async function capture({args,sourceDocument,originalReceipt}={}){
  // Validate and freeze caller input before asynchronous verifier invocation.
  if(!args||!sourceDocument)fail();const a=structuredClone(args),d=structuredClone(sourceDocument);
  const receipt=await consumeVerifiedReceipt(originalReceipt,{args:structuredClone(a),sourceDocument:structuredClone(d)});
  const expiry=validate(d,a,receipt),review=structuredClone({document:d,args:a,request_id:receipt.request_id,snapshot_id:receipt.snapshot_id,instances:receipt.instances,future_instances_affected:true});
  const digest=createHash('sha256').update(JSON.stringify(review)).digest('hex'),token=opaque();prepared.set(token,{review,digest,expiry,used:false});return token;
 }
 function get(token){const x=prepared.get(token);if(!x||x.used||x.expiry<=Date.now())fail();return x;}
 function review(token){const x=get(token);return structuredClone({review:x.review,digest:x.digest,expiresAt:x.expiry});}
 // Only a trusted human decision path may invoke this. No production path is wired.
 function issueDecision(token,{ticket,deadline}={}){const x=get(token);if(!uuid(ticket)||!Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline>x.expiry)fail();const proof=opaque();decisions.set(proof,{token,ticket,digest:x.digest,deadline});return proof;}
 function approve(token,proof,{ticket,digest}={}){const decision=decisions.get(proof);if(!decision)fail();decisions.delete(proof);const x=get(token);if(decision.token!==token||decision.ticket!==ticket||decision.digest!==digest||x.digest!==digest||decision.deadline<=Date.now())fail();x.used=true;const permit=opaque();permits.set(permit,{...x,deadline:decision.deadline});return permit;}
 function consume(permit,{args,sourceDocument}={}){const x=permits.get(permit);if(!x)fail();permits.delete(permit);if(x.deadline<=Date.now()||x.expiry<=Date.now()||JSON.stringify(x.review.args)!==JSON.stringify(args)||JSON.stringify(x.review.document)!==JSON.stringify(sourceDocument))fail();return structuredClone({preview_request_id:x.review.request_id,snapshot_id:x.review.snapshot_id,review_digest:x.digest});}
 return Object.freeze({capture,review,issueDecision,approve,consume});
}
