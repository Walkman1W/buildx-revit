// Research only: caller supplies an already-approved immutable request. This
// component authenticates neither caller nor receipt and is not registered.
import {open, mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const identity=id=>{if(typeof id!=='string'||!/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(id))throw new Error('invalid request id');return id;};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function claim(root,id,requestBytes){
 identity(id);
 if(!Buffer.isBuffer(requestBytes)||requestBytes.length===0||requestBytes.length>1024*1024)throw new Error('invalid request');
 const dir=path.join(root,id);
 // The directory itself is the permanent claim. A crash at any later point
 // leaves it occupied, so a second process can never publish this identity.
 await mkdir(dir);
 const record=JSON.stringify({schema:1,id,digest:digest(requestBytes),request:requestBytes.toString('base64')});
 const fd=await open(path.join(dir,'request.json'),'wx',0o600);
 try {await fd.writeFile(record);await fd.sync();} finally {await fd.close();}
 return Object.freeze({id,digest:digest(requestBytes)});
}
export async function inspect(root,id){
 identity(id);
 try {
  const raw=await readFile(path.join(root,id,'request.json'),'utf8');
  const record=JSON.parse(raw);
  if(Object.keys(record).sort().join(',')!=='digest,id,request,schema'||record.schema!==1||record.id!==id||typeof record.request!=='string'||!/^[a-f0-9]{64}$/.test(record.digest)||Buffer.from(record.request,'base64').toString('base64')!==record.request||digest(Buffer.from(record.request,'base64'))!==record.digest)throw new Error('invalid claim');
  return {state:'unknown',id,digest:record.digest,request:Buffer.from(record.request,'base64')};
 } catch(error) {
  if(error.code==='ENOENT')return {state:'unknown',id,digest:null};
  throw error;
 }
}
