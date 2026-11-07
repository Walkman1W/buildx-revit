import {validateAtomicProjectBindingReview} from './project-binding-atomic-review.mjs';
const entries=new WeakMap(),permits=new WeakMap();
const opaque=()=>Object.freeze(Object.create(null));
const fail=()=>{throw new Error('Project binding preparation unavailable or mismatched');};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const key=(args,doc)=>canonical([args,doc]);
export function capturePreparedProjectBinding({args,sourceDocument,review,preparation,requestId}={}){
 if(!sourceDocument||!/^[a-f0-9]{32}$/.test(sourceDocument.session)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId))fail();
 const checked=validateAtomicProjectBindingReview(review,preparation,args,sourceDocument,requestId),token=opaque();
 entries.set(token,{key:key(args,sourceDocument),review:structuredClone({document:sourceDocument,mode:args.mode,...checked.review}),preparation:checked.preparation,expiresAt:Date.parse(preparation.expires_utc),used:false});return token;
}
function record(token,args,doc){const r=entries.get(token);if(!r||r.used||r.expiresAt<=Date.now()||r.key!==key(args,doc))fail();return r;}
export function preparedProjectBindingReview(token,{args,sourceDocument}={}){const r=record(token,args,sourceDocument);return {review:structuredClone(r.review),expiresAt:r.expiresAt};}
export function approvePreparedProjectBinding(token,{args,sourceDocument,deadline}={}){const r=record(token,args,sourceDocument);if(!Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline>r.expiresAt)fail();r.used=true;const permit=opaque();permits.set(permit,{...r,deadline});return permit;}
export function consumeApprovedProjectBinding(token,{args,sourceDocument,host}={}){const r=permits.get(token);if(!r)fail();permits.delete(token);if(r.deadline<=Date.now()||r.expiresAt<=Date.now()||r.key!==key(args,sourceDocument)||host?.sessionId!==sourceDocument.session)fail();return structuredClone(r.preparation);}
