import fs from 'node:fs/promises';
import path from 'node:path';

// Isolated research prototype, deliberately not imported by any production
// router. The caller must supply a trustworthy receipt verifier and storage
// owner; neither JSON nor this module establishes either authority.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const session=/^[a-f0-9]{32}$/;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const identityKeys=['request_id','request_sha256','host_session','document_sha256'];
const identity=value=>{
 if(!plain(value)||Object.keys(value).length!==4||!identityKeys.every(k=>Object.hasOwn(value,k))||!uuid.test(value.request_id)||!hash.test(value.request_sha256)||!session.test(value.host_session)||!hash.test(value.document_sha256))throw new Error('Invalid request identity');
 return Object.freeze({...value});
};
const equal=(a,b)=>identityKeys.every(k=>a[k]===b[k]);
const terminal=new Set(['declined','rolled_back','committed']);
const serial=value=>JSON.stringify(value);

// Research-only file store. Its directory must be independently controlled by
// the test; path equality and Node file APIs do not prove a production security
// boundary, anti-tamper identity, durable directory fsync or trusted handles.
export function createUnregisteredFileStore(root){
 if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('Absolute isolated root required');
 const dir=id=>path.join(root,id), lock=id=>path.join(dir(id),'lock');
 async function read(id){
  const listing=await fs.readdir(dir(id));if(listing.some(n=>n!=='lock'&&!/^\d{8}\.json$/.test(n)))throw new Error('Unexpected journal entry');
  const entries=listing.filter(n=>/^\d{8}\.json$/.test(n)).sort();
  if(!entries.length)return null;
  for(let i=0;i<entries.length;i++)if(entries[i]!==String(i).padStart(8,'0')+'.json')throw new Error('Journal sequence invalid');
  const records=[];for(const name of entries)records.push(JSON.parse(await fs.readFile(path.join(dir(id),name),'utf8')));
  return records;
 }
 async function append(id,record,index){
  const file=path.join(dir(id),String(index).padStart(8,'0')+'.json');const bytes=serial(record);const handle=await fs.open(file,'wx');
  try{await handle.writeFile(bytes,'utf8');await handle.sync();}finally{await handle.close();}
  if(await fs.readFile(file,'utf8')!==bytes)throw new Error('Journal write verification failed');
 }
 return Object.freeze({
  async create(id,record){await fs.mkdir(dir(id));await append(id,record,0);},
  async inspect(id){try{await fs.access(lock(id));throw new Error('Journal lock remains held');}catch(error){if(error?.code!=='ENOENT')throw error;}return read(id);},
  async locked(id,fn){
   await fs.mkdir(lock(id));
   try{const records=await read(id);let index=records.length;return await fn(records,async record=>{await append(id,record,index);index++;});}
   finally{await fs.rmdir(lock(id));}
  },
 });
}

export function createUnregisteredReceiptOwner({store,verifyEvidence,authorizePublication}={}){
 if(!store||typeof store.create!=='function'||typeof store.inspect!=='function'||typeof store.locked!=='function')throw new Error('Independent storage owner required');
 // Absent verifier can never make a human decision or a terminal claim.
 const verify=typeof verifyEvidence==='function'?verifyEvidence:()=>null;
 const authorize=typeof authorizePublication==='function'?authorizePublication:()=>false;
 function current(records,expected){
  if(!Array.isArray(records)||!records.length)throw new Error('Missing original receipt');
  let previous=null;
  for(let i=0;i<records.length;i++){
   const r=records[i];if(!plain(r)||r.version!==1||r.sequence!==i||!equal(r.identity,expected)||typeof r.state!=='string'||r.previous!==previous)throw new Error('Receipt chain invalid');
   const allowed=previous===null?['reserved']:previous==='reserved'?['publishing']:previous==='publishing'?['published','declined','rolled_back','committed','unknown']:previous==='published'||previous==='unknown'?['declined','rolled_back','committed','unknown']:[];
   if(!allowed.includes(r.state)||(terminal.has(r.state)&&!hash.test(r.receipt_sha256)))throw new Error('Invalid receipt transition');
   previous=r.state;
  }
  return records.at(-1);
 }
 const next=(id,state,prior,sequence,receipt_sha256)=>({version:1,sequence,identity:id,state,previous:prior,...receipt_sha256?{receipt_sha256}:{}});
 async function locked(id,action){
  try{return await store.locked(id.request_id,async(records,append)=>action(current(records,id),append,records.length));}
  catch{return {status:'unknown',terminal:false,no_replay:true};}
 }
 return Object.freeze({
  async reserve(value){
   const id=identity(value);
   try{await store.create(id.request_id,next(id,'reserved',null,0));return {status:'reserved',terminal:false,no_replay:true};}
   catch{return {status:'unknown',terminal:false,no_replay:true};}
  },
  async publish(value,publisher,permit){
   const id=identity(value);if(typeof publisher!=='function')throw new Error('Publisher required');
   return locked(id,async(record,append,index)=>{
    if(record.state!=='reserved')return {status:'unknown',terminal:false,no_replay:true};
    if(await authorize(permit,id)!==true)return {status:'not_started',terminal:true,no_replay:true};
    await append(next(id,'publishing',record.state,index));
    try{await publisher();}catch{return {status:'unknown',terminal:false,no_replay:true};}
    // Delivery can have succeeded even if this durable record fails.
    try{await append(next(id,'published','publishing',index+1));return {status:'published',terminal:false,no_replay:true};}
    catch{return {status:'unknown',terminal:false,no_replay:true};}
   });
  },
  async inspect(value){
   const id=identity(value);try{const records=await store.inspect(id.request_id),record=current(records,id);return {status:record.state==='publishing'?'unknown':record.state,terminal:terminal.has(record.state),no_replay:true};}
   catch{return {status:'unknown',terminal:false,no_replay:true};}
  },
  async acceptOriginalReceipt(value,evidence){
   const id=identity(value);
   return locked(id,async(record,append,index)=>{
    if(!['published','publishing','unknown'].includes(record.state))return {status:'unknown',terminal:false,no_replay:true};
    const facts=await verify(evidence,id);
    if(!plain(facts)||!identityKeys.every(k=>facts[k]===id[k])||!['declined','rolled_back','committed','unknown'].includes(facts.status)||!hash.test(facts.receipt_sha256))return {status:'unknown',terminal:false,no_replay:true};
    if(facts.status==='committed'&&(facts.readback_verified!==true||facts.side_effects_verified!==true))return {status:'unknown',terminal:false,no_replay:true};
    if(facts.status==='rolled_back'&&(facts.rollback_verified!==true||facts.side_effects_verified!==true))return {status:'unknown',terminal:false,no_replay:true};
    await append(next(id,facts.status,record.state,index,facts.receipt_sha256));return {status:facts.status,terminal:terminal.has(facts.status),no_replay:true};
   });
  }
 });
}
