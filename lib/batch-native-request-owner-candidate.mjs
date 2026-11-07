// Unregistered request-object candidate. Not a user-approval, queue or receipt
// owner. Production loading stays disabled until atomic native image trust exists.
import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {inspectExistingPanelDirectory} from './panel-audit.mjs';
const consumedRequestIds=new Set();
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function createCandidateNativeRequestOwner(native,root){
 if(!native||typeof native.create!=='function'||typeof native.close!=='function'||typeof root!=='string'||!path.isAbsolute(root))throw new Error('Candidate native request owner unavailable.');
 const observed=inspectExistingPanelDirectory(root);if(!observed.ok)throw new Error('Candidate request directory is unverified.');
 const chain=observed.value.chain,entries=new Map();
 const fileId=filename=>{const st=fs.lstatSync(filename,{bigint:true});if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1n||st.ino===0n)throw new Error("Request file identity unavailable.");return `${st.dev}:${st.ino}:${st.birthtimeNs}`;};
 const current=()=>{const value=inspectExistingPanelDirectory(root);return value.ok&&value.value.chain.length===chain.length&&value.value.chain.every((v,i)=>v.path===chain[i].path&&v.identity===chain[i].identity);};
 function prepare(requestId,input){
  if(!guid.test(requestId)||!Buffer.isBuffer(input)||input.length===0||input.length>131072||entries.has(requestId)||consumedRequestIds.has(requestId)||consumedRequestIds.size>=4096||!current())throw new Error('Candidate request rejected before creation.');
  consumedRequestIds.add(requestId);
  const bytes=Buffer.from(input),sha256=createHash('sha256').update(bytes).digest('hex'),filename=path.join(root,requestId+'.request');
  const entry={requestId,sha256,state:'unknown',handle:null};entries.set(requestId,entry);
  try{
   const handle=native.create(filename,bytes);
   if(typeof handle==='bigint'&&handle>0n)entry.handle=handle;
   if(typeof handle!=='bigint'||handle<=0n||!current())throw new Error('Native request creation or directory identity unconfirmed.');
   entry.identity=fileId(filename);entry.state='prepared';
  }catch(error){throw Object.assign(new Error('Native request outcome unknown; preserve evidence and do not replay.'),{cause:error,requestId});}
  return Object.freeze({requestId,sha256,
   inspect:()=>Object.freeze({requestId,sha256,state:entry.state}),
   consume:async send=>{
    if(entry.state!=='prepared'||typeof send!=='function')throw new Error('Candidate request cannot be consumed.');
    try{if(!current()||fileId(filename)!==entry.identity)throw new Error('Request identity changed.');}catch(cause){entry.state='unknown';throw Object.assign(new Error('Request identity unconfirmed; do not replay.'),{cause,requestId});}
    entry.state='unknown';
    try{await send(Object.freeze({requestId,sha256,handle:entry.handle}));entry.state='pending';}
    catch(cause){throw Object.assign(new Error('Candidate handoff outcome unknown; do not replay.'),{cause,requestId});}
   },
   releaseUnpublished:()=>{
    if(entry.state!=='prepared')throw new Error('Published or unknown request cannot be released by this owner.');
    entry.state='unknown';if(native.close(entry.handle)!==true)throw new Error('Native handle close outcome unknown.');entry.handle=null;entry.state='closed';
   }
  });
 }
 return Object.freeze({prepare});
}
