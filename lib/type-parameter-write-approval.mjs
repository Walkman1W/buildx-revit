import {buildTypeParameterWriteReview,assertTypeParameterWriteReview,typeParameterWriteBindingKey,supportsNativeTypeParameterWrites} from './native-type-parameter-writes.mjs';

// These capabilities are process-local identities. JSON, HTTP fields and a
// caller's acknowledgement cannot construct a prepared or approved write.
const preparedWrites=new WeakMap(),userDecisions=new WeakMap(),approvedWrites=new WeakMap();
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fields=(value,keys)=>plain(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const opaque=()=>Object.freeze(Object.create(null));
const fail=()=>{throw new Error('Type parameter write approval is unavailable, expired or does not match the bound request.');};
function documentKey(value){
  if(!fields(value,['session','path','title'])||typeof value.session!=='string'||!/^[a-f0-9]{32}$/.test(value.session)||
    typeof value.path!=='string'||!value.path||value.path.length>32768||typeof value.title!=='string'||!value.title||value.title.length>1024||/[\0\r\n]/.test(value.path+value.title))fail();
  return JSON.stringify([value.session,value.path,value.title]);
}
function binding(args,sourceDocument){documentKey(sourceDocument);return typeParameterWriteBindingKey(args,sourceDocument);}
function preparedRecord(prepared,args,sourceDocument){
  const record=preparedWrites.get(prepared);
  if(!record||record.approved||record.expiresAt<=Date.now()||record.binding!==binding(args,sourceDocument))fail();
  return record;
}
export function capturePreparedTypeWrite({args,impact,sourceDocument,nativePreparation}={}){
  const key=binding(args,sourceDocument),review=buildTypeParameterWriteReview(args,impact,sourceDocument);assertTypeParameterWriteReview(review);
  if(!fields(nativePreparation,['schema_version','token','expires_utc'])||nativePreparation.schema_version!==1||typeof nativePreparation.token!=='string'||
    !/^[a-f0-9]{32}$/.test(nativePreparation.token)||typeof nativePreparation.expires_utc!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(nativePreparation.expires_utc))fail();
  const expiresAt=Date.parse(nativePreparation.expires_utc);
  if(!Number.isSafeInteger(expiresAt)||new Date(expiresAt).toISOString()!==nativePreparation.expires_utc||expiresAt<=Date.now()||expiresAt>Date.now()+120000)fail();
  const prepared=opaque();preparedWrites.set(prepared,{binding:key,document:documentKey(sourceDocument),review:freeze(structuredClone(review)),
    nativePreparation:freeze(structuredClone(nativePreparation)),expiresAt,approved:false});return prepared;
}
export function preparedTypeWriteReview(prepared,{args,sourceDocument}={}){
  const record=preparedRecord(prepared,args,sourceDocument);
  return Object.freeze({review:freeze(structuredClone(record.review)),expiresAt:record.expiresAt});
}
export function issueTypeWriteUserDecision({ticket,digest,sourceDocument,deadline}={}){
  if(typeof ticket!=='string'||!/^[a-f0-9-]{36}$/.test(ticket)||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||
    !Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline>Date.now()+120000)fail();
  const proof=opaque();userDecisions.set(proof,{ticket,digest,document:documentKey(sourceDocument),deadline});return proof;
}
export function consumeTypeWriteUserDecision(proof,{ticket,digest,sourceDocument}={}){
  const record=userDecisions.get(proof);if(!record)return false;userDecisions.delete(proof);
  try{return record.ticket===ticket&&record.digest===digest&&record.document===documentKey(sourceDocument)&&record.deadline>Date.now();}catch{return false;}
}
export function approvePreparedTypeWrite(prepared,{args,sourceDocument,deadline}={}){
  const record=preparedRecord(prepared,args,sourceDocument);
  if(!Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline>record.expiresAt)fail();
  record.approved=true;const approved=opaque();approvedWrites.set(approved,{...record,deadline});return approved;
}
export function consumeApprovedTypeWrite(approved,{args,sourceDocument,host}={}){
  const record=approvedWrites.get(approved);if(!record)fail();approvedWrites.delete(approved);
  if(record.deadline<=Date.now()||record.expiresAt<=Date.now()||record.binding!==binding(args,sourceDocument)||record.document!==documentKey(sourceDocument)||
    host?.sessionId!==sourceDocument.session||!supportsNativeTypeParameterWrites(host))fail();
  return freeze(structuredClone(record.nativePreparation));
}
