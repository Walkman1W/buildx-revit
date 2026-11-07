// Isolated owner. Root identity is anchored outside the mutable recovery root.
import {mkdir,open,readFile,rename,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {claim,inspect} from './research-durable-claim.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function scopeKey(scope){if(!scope||typeof scope.document!=='string'||!scope.document||typeof scope.operation!=='string'||!scope.operation)throw new Error('invalid scope');return hash(JSON.stringify([scope.document,scope.operation]));}
const rootPath=root=>{if(!path.isAbsolute(root))throw new Error('absolute recovery root required');return path.resolve(root);};
const anchorPath=root=>rootPath(root)+'.identity';
async function identity(p){const s=await lstat(p,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||s.ino===0n)throw new Error('recovery directory identity unavailable');return `${s.dev}:${s.ino}:${s.birthtimeNs}`;}
async function current(root){root=rootPath(root);if((await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error('recovery root is not canonical');const paths=[root,...['scopes','requests','archive','records'].map(x=>path.join(root,x))];const identities=[];for(const p of paths)identities.push(await identity(p));return {schema:1,root,identities};}
async function save(file,data){const fd=await open(file,'wx',0o600);try{await fd.writeFile(JSON.stringify(data));await fd.sync();}finally{await fd.close();}}
// Explicit setup is separate from use. It never creates a missing root or
// replaces an existing anchor; it must run only during trusted provisioning.
export async function initializeResearchRoot(root){const facts=await current(root);await save(anchorPath(root),facts);return facts;}
async function verifyRoot(root){const facts=await current(root),a=anchorPath(root),stat=await lstat(a,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size>16384n)throw new Error('recovery identity anchor invalid');const raw=await readFile(a,'utf8');let saved;try{saved=JSON.parse(raw);}catch{throw new Error('recovery identity anchor invalid');}if(JSON.stringify(saved)!==JSON.stringify(facts))throw new Error('recovery root identity changed');return facts;}
export function createResearchScopeOwner(root,verifyOriginalReceipt){
 root=rootPath(root);if(typeof verifyOriginalReceipt!=='function')throw new TypeError('receipt owner required');
 const paths=scope=>{const key=scopeKey(scope);return {key,lock:path.join(root,'scopes',key)};};
 async function reserve(scope,id,request){
  await verifyRoot(root);const {key,lock}=paths(scope);await mkdir(lock);await verifyRoot(root);
  const entry=await claim(path.join(root,'requests'),id,request);await verifyRoot(root);await save(path.join(lock,'owner.json'),{schema:1,key,id,digest:entry.digest});await verifyRoot(root);return entry;
 }
 async function pending(scope){
  try{await verifyRoot(root);}catch{return {state:'unknown'};}
  const {key,lock}=paths(scope);let raw;try{raw=await readFile(path.join(lock,'owner.json'),'utf8');}catch(e){if(e.code==='ENOENT')return {state:'unknown'};throw e;}
  let row;try{row=JSON.parse(raw);}catch{return {state:'unknown'};}
  if(!row||Object.keys(row).sort().join(',')!=='digest,id,key,schema'||row.schema!==1||row.key!==key||!/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(row.id)||!/^[a-f0-9]{64}$/.test(row.digest))return {state:'unknown'};
  let original;try{original=await inspect(path.join(root,'requests'),row.id);await verifyRoot(root);}catch{return {state:'unknown'};}
  if(original.digest!==row.digest)return {state:'unknown'};return {state:'unknown',id:row.id,digest:row.digest};
 }
 async function settle(scope,receipt){
  const {key,lock}=paths(scope),original=await pending(scope);
  if(!original.id||!receipt||receipt.id!==original.id||receipt.digest!==original.digest||receipt.scopeKey!==key||!['committed','rolled_back'].includes(receipt.outcome))return false;
  if(await verifyOriginalReceipt(receipt,original)!==true)return false;
  try{await verifyRoot(root);await rename(lock,path.join(root,'archive',`${key}-${original.id}`));await verifyRoot(root);}catch{return false;}
  return true;
 }
 return Object.freeze({reserve,pending,settle});
}
