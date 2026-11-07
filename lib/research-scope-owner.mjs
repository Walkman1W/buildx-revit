// Isolated research prototype. The verifier must be a trusted receipt owner;
// never instantiate this with a caller-provided boolean or JSON field.
import {mkdir,open,readFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {claim,inspect} from './research-durable-claim.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function scopeKey(scope){
 if(!scope||typeof scope.document!=='string'||!scope.document||typeof scope.operation!=='string'||!scope.operation)throw new Error('invalid scope');
 return hash(JSON.stringify([scope.document,scope.operation]));
}
async function save(file,data){const fd=await open(file,'wx',0o600);try{await fd.writeFile(JSON.stringify(data));await fd.sync();}finally{await fd.close();}}
export function createResearchScopeOwner(root,verifyOriginalReceipt){
 if(typeof verifyOriginalReceipt!=='function')throw new TypeError('receipt owner required');
 const paths=scope=>{const key=scopeKey(scope);return {key,lock:path.join(root,'scopes',key)};};
 async function reserve(scope,id,request){
  const {key,lock}=paths(scope);
  await mkdir(lock); // Acquired first. Partial reservation stays blocked.
  const entry=await claim(path.join(root,'requests'),id,request);
  await save(path.join(lock,'owner.json'),{schema:1,key,id,digest:entry.digest});
  return entry;
 }
 async function pending(scope){
  const {key,lock}=paths(scope);let raw;
  try{raw=await readFile(path.join(lock,'owner.json'),'utf8');}catch(e){if(e.code==='ENOENT')return {state:'unknown'};throw e;}
  let row;try{row=JSON.parse(raw);}catch{return {state:'unknown'};}
  if(!row||Object.keys(row).sort().join(',')!=='digest,id,key,schema'||row.schema!==1||row.key!==key||!/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(row.id)||!/^[a-f0-9]{64}$/.test(row.digest))return {state:'unknown'};
  let original;try{original=await inspect(path.join(root,'requests'),row.id);}catch{return {state:'unknown'};}
  if(original.digest!==row.digest)return {state:'unknown'};
  return {state:'unknown',id:row.id,digest:row.digest};
 }
 async function settle(scope,receipt){
  const {key,lock}=paths(scope),original=await pending(scope);
  if(!original.id||!receipt||receipt.id!==original.id||receipt.digest!==original.digest||receipt.scopeKey!==key||!['committed','rolled_back'].includes(receipt.outcome))return false;
  if(await verifyOriginalReceipt(receipt,original)!==true)return false;
  // Immutable archival name: never delete the original reservation.
  await rename(lock,path.join(root,'archive',`${key}-${original.id}`));
  return true;
 }
 return Object.freeze({reserve,pending,settle});
}
