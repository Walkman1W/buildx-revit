import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {inspectExistingPanelDirectory} from './panel-audit.mjs';
import {snapshotExternalMcpData} from './external-mcp-owner.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const uid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const label=x=>typeof x==='string'&&x.length>0&&x.length<=256&&!/[\x00-\x1f\x7f]/.test(x);
const ident=s=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
const copy=x=>JSON.parse(JSON.stringify(x));
const identity=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='accountId,connectionId,conversationId,sessionId'&&[value.accountId,value.connectionId,value.conversationId,value.sessionId].every(label)?copy(value):null;
const sameChain=(a,b)=>a.length===b.length&&a.every((v,i)=>v.path===b[i].path&&v.identity===b[i].identity);
const MAX_FILES=512,MAX_BYTES=32*1024*1024,MAX_RECORD=256*1024;

/**
 * The trusted panel must supply an existing user-private absolute root and a
 * frozen privateRootOwner.verify({root,accountDirectory}) callback which
 * validates its actual host ACL/ownership, not merely that a path was chosen.
 * Identity must come from the verified current account/session/connection/turn.
 * Files are append-only and never overwritten; unresolved attempts and stale
 * locks block any further dispatch. No source credentials should reach this
 * owner; explicitly marked sensitive values must already be redacted.
 */
export function createExternalMcpReceipts({root,identity:binding,privateRootOwner}={},dependencies={}){
  const who=identity(binding),descriptor=privateRootOwner&&Object.getOwnPropertyDescriptor(privateRootOwner,'verify');
  if(typeof root!=='string'||!path.isAbsolute(root)||root.includes('\0')||!who||!privateRootOwner||!Object.isFrozen(privateRootOwner)||!descriptor||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function'||!dependencies||Object.keys(dependencies).some(key=>key!=='open'||typeof dependencies[key]!=='function'))throw new TypeError('A verified private root and current identity are required');
  const openFile=dependencies.open??fs.open;
  root=path.resolve(root);const rootAtCreation=inspectExistingPanelDirectory(root);if(!rootAtCreation.ok)throw new Error('Private root is unavailable');
  const rootChain=rootAtCreation.value.chain,accountDir=path.join(root,'mcp-'+hash(who.accountId)),bindingId={accountHash:hash(who.accountId),sessionId:who.sessionId,connectionId:who.connectionId,conversationId:who.conversationId};
  let chain=null,lock=null,tail=Promise.resolve(),accepting=true,closed=false,blocked=null,pending=0;
  const stages=new Map(),handles=new Set();
  const result=(code)=>({ok:false,code});
  const serial=fn=>{if(pending>=8)return Promise.resolve(result('RECEIPT_BUSY'));pending++;const run=tail.then(fn,fn);tail=run.catch(()=>{});return run.finally(()=>{pending--;});};
  async function verify(){
    const observedRoot=inspectExistingPanelDirectory(root);if(!observedRoot.ok||!sameChain(observedRoot.value.chain,rootChain))throw new Error('RECEIPT_ROOT_CHANGED');
    if(chain){const observed=inspectExistingPanelDirectory(accountDir);if(!observed.ok||!sameChain(observed.value.chain,chain))throw new Error('RECEIPT_DIRECTORY_CHANGED');}
    if(await privateRootOwner.verify({root,accountDirectory:accountDir})!==true)throw new Error('RECEIPT_PRIVATE_ROOT_UNVERIFIED');
  }
  async function cleanupStage(stage){
    await verify();if(!stage.identity)throw new Error('RECEIPT_STAGE_OWNERSHIP_UNKNOWN');
    let current;try{current=await fs.lstat(stage.path,{bigint:true});}catch(e){if(e.code==='ENOENT'&&stage.removalAttempted){stages.delete(stage.path);return;}throw e;}
    if(!current.isFile()||current.isSymbolicLink()||ident(current)!==stage.identity||current.nlink<1n||current.nlink>2n)throw new Error('RECEIPT_STAGE_CHANGED');
    stage.removalAttempted=true;await fs.unlink(stage.path);stages.delete(stage.path);
  }
  async function unlock(){
    if(!lock)return;
    for(const handle of [...handles]){await handle.close();handles.delete(handle);}
    for(const stage of [...stages.values()])await cleanupStage(stage);
    const current=lock;if(!current.closed){if(ident(await current.handle.stat({bigint:true}))!==current.identity)throw new Error('RECEIPT_LOCK_CHANGED');await current.handle.close();current.closed=true;}
    await verify();const info=await fs.lstat(current.path,{bigint:true});if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n||ident(info)!==current.identity)throw new Error('RECEIPT_LOCK_CHANGED');
    await fs.unlink(current.path);lock=null;
  }
  async function prepare(){
    if(!accepting||closed||blocked)throw new Error(blocked??'RECEIPT_CLOSED');
    if(lock){await verify();return;}
    await verify();try{await fs.mkdir(accountDir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
    const info=inspectExistingPanelDirectory(accountDir);if(!info.ok||!sameChain(info.value.chain.slice(0,rootChain.length),rootChain))throw new Error('RECEIPT_DIRECTORY_CHANGED');
    chain=info.value.chain;await verify();
    const file=path.join(accountDir,'.external-mcp.lock');let handle;
    try{handle=await openFile(file,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new Error('RECEIPT_LOCKED');throw e;}
    lock={handle,path:file,identity:null,closed:false};
    try{
      const a=await handle.stat({bigint:true}),b=await fs.lstat(file,{bigint:true});
      if(!a.isFile()||!b.isFile()||a.nlink!==1n||b.nlink!==1n||a.ino===0n||ident(a)!==ident(b))throw new Error('RECEIPT_LOCK_CHANGED');
      lock.identity=ident(a);await handle.writeFile(JSON.stringify({schemaVersion:1,owner:randomUUID()})+'\n');await handle.sync();await verify();
    }catch(e){blocked=e.message;throw e;}
  }
  async function readRecord(file,limit=MAX_RECORD){
    const named=await fs.lstat(file,{bigint:true});if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1n||named.ino===0n||named.size>BigInt(limit))throw new Error('RECEIPT_RECORD_INVALID');
    const handle=await openFile(file,'r');handles.add(handle);let value,primary;
    try{
      const before=await handle.stat({bigint:true});if(ident(before)!==ident(named)||before.size!==named.size||before.mtimeNs!==named.mtimeNs)throw new Error('RECEIPT_RECORD_CHANGED');
      const data=Buffer.alloc(Number(before.size));let used=0;while(used<data.length){const part=await handle.read(data,used,data.length-used,used);if(!part.bytesRead)throw new Error('RECEIPT_RECORD_INVALID');used+=part.bytesRead;}
      const after=await handle.stat({bigint:true}),current=await fs.lstat(file,{bigint:true});if(ident(before)!==ident(after)||ident(after)!==ident(current)||before.size!==after.size||after.size!==current.size||before.mtimeNs!==after.mtimeNs||after.mtimeNs!==current.mtimeNs)throw new Error('RECEIPT_RECORD_CHANGED');
      await verify();value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
    }catch(e){primary=e;}
    try{await handle.close();handles.delete(handle);}catch{blocked='RECEIPT_CLEANUP_PENDING';throw new Error(blocked);}
    if(primary)throw primary;return value;
  }
  async function inventory(){
    await verify();let total=0,count=0;const attempts=new Map(),outcomes=new Map();
    const entries=await fs.readdir(accountDir,{withFileTypes:true});
    if(entries.length>MAX_FILES+1)throw new Error('RECEIPT_CAPACITY');
    for(const entry of entries){
      if(entry.name==='.external-mcp.lock')continue;
      if(!entry.isFile()||entry.isSymbolicLink()||!/^([ao])-([0-9a-f-]{36})\.json$/.test(entry.name))throw new Error('RECEIPT_RECOVERY_REQUIRED');
      const match=/^([ao])-([0-9a-f-]{36})\.json$/.exec(entry.name);if(!uid(match[2]))throw new Error('RECEIPT_RECORD_INVALID');
      const file=path.join(accountDir,entry.name),stat=await fs.lstat(file,{bigint:true});total+=Number(stat.size);count++;if(!Number.isSafeInteger(total)||total>MAX_BYTES)throw new Error('RECEIPT_CAPACITY');
      const record=await readRecord(file),expectedOutcome=match[1]==='a'?'unknown':'response_received';
      if(!record||record.schemaVersion!==1||record.kind!==(match[1]==='a'?'attempt':'outcome')||record.binding?.accountHash!==bindingId.accountHash||record.payload?.attemptId!==match[2]||![record.binding.sessionId,record.binding.connectionId,record.binding.conversationId].every(label)||!validReceipt(record.payload,expectedOutcome))throw new Error('RECEIPT_RECORD_INVALID');
      (match[1]==='a'?attempts:outcomes).set(match[2],record);
    }
    for(const [id,outcome] of outcomes){const attempt=attempts.get(id);if(!attempt||!sameReceipt(attempt.payload,outcome.payload)||JSON.stringify(attempt.binding)!==JSON.stringify(outcome.binding))throw new Error('RECEIPT_RECORD_INVALID');}
    await verify();return {attempts,outcomes,total,count};
  }
  function sameReceipt(a,b){
    try{
      const initial={...a},outcome={...b};delete initial.outcome;delete outcome.outcome;
      for(const key of ['responseDigest','isError','result'])delete outcome[key];
      return snapshotExternalMcpData(initial,MAX_RECORD).digest===snapshotExternalMcpData(outcome,MAX_RECORD).digest;
    }catch{return false;}
  }
  function validReceipt(value,outcome){
    if(!value||typeof value!=='object'||Array.isArray(value)||!uid(value.attemptId)||!uid(value.serverId)||!uid(value.generation)||!label(value.tool)||!(/^[0-9a-f]{64}$/.test(value.argumentDigest??''))||!(/^[0-9a-f]{64}$/.test(value.schemaDigest??''))||value.outcome!==outcome||!value.server||!value.inputSchema||!Object.hasOwn(value,'arguments')||!Array.isArray(value.sensitivePaths))return null;
    if(outcome==='response_received'&&(!/^[0-9a-f]{64}$/.test(value.responseDigest??'')||typeof value.isError!=='boolean'||!Object.hasOwn(value,'result')))return null;
    try{if(snapshotExternalMcpData(value.inputSchema).digest!==value.schemaDigest)return null;if(outcome==='response_received'&&snapshotExternalMcpData(value.result,65536).digest!==value.responseDigest)return null;return snapshotExternalMcpData(value,MAX_RECORD).value;}catch{return null;}
  }
  async function write(file,record,stats){
    const encoded=Buffer.from(JSON.stringify(record));if(encoded.length>MAX_RECORD||stats.count>=MAX_FILES||stats.total+encoded.length>MAX_BYTES)throw new Error('RECEIPT_CAPACITY');
    await verify();const stage={path:path.join(accountDir,'pending-'+randomUUID()+'.json'),identity:null,removalAttempted:false};stages.set(stage.path,stage);
    const handle=await openFile(stage.path,'wx',0o600);handles.add(handle);
    try{
      const stat=await handle.stat({bigint:true}),named=await fs.lstat(stage.path,{bigint:true});if(!stat.isFile()||stat.nlink!==1n||stat.ino===0n||ident(stat)!==ident(named))throw new Error('RECEIPT_STAGE_CHANGED');
      stage.identity=ident(stat);await handle.writeFile(encoded);await handle.sync();await verify();const after=await handle.stat({bigint:true});if(ident(after)!==stage.identity||after.size!==BigInt(encoded.length))throw new Error('RECEIPT_WRITE_UNKNOWN');
    }catch(e){blocked='RECEIPT_WRITE_UNKNOWN';throw e;}
    try{await handle.close();handles.delete(handle);}catch{blocked='RECEIPT_CLEANUP_PENDING';throw new Error(blocked);}
    await verify();await fs.link(stage.path,file);const final=await fs.lstat(file,{bigint:true});if(ident(final)!==stage.identity||final.nlink!==2n)throw new Error('RECEIPT_WRITE_UNKNOWN');
    await cleanupStage(stage);await verify();const confirmed=await fs.lstat(file,{bigint:true});if(ident(confirmed)!==stage.identity||confirmed.nlink!==1n||confirmed.size!==BigInt(encoded.length))throw new Error('RECEIPT_WRITE_UNKNOWN');
  }
  async function run(fn){
    try{await prepare();return await fn(await inventory());}
    catch(error){blocked=typeof error?.message==='string'&&/^RECEIPT_[A-Z_]+$/.test(error.message)?error.message:'RECEIPT_IO_ERROR';return result(blocked);}
  }
  return Object.freeze({
    ready:()=>serial(()=>run(async stats=>({ok:true,unresolved:[...stats.attempts].filter(([id])=>!stats.outcomes.has(id)).map(([,record])=>copy(record))}))),
    recordAttempt:receipt=>serial(()=>run(async stats=>{
      const value=validReceipt(receipt,'unknown');if(!value||stats.attempts.has(value.attemptId)||[...stats.attempts.keys()].some(id=>!stats.outcomes.has(id)))return false;
      await write(path.join(accountDir,'a-'+value.attemptId+'.json'),{schemaVersion:1,kind:'attempt',binding:bindingId,payload:value},stats);return true;
    })).then(value=>value===true),
    recordOutcome:receipt=>serial(()=>run(async stats=>{
      const value=validReceipt(receipt,'response_received'),original=value&&stats.attempts.get(value.attemptId);
      if(!original||stats.outcomes.has(value.attemptId)||!sameReceipt(original.payload,value)||JSON.stringify(original.binding)!==JSON.stringify(bindingId))return false;
      await write(path.join(accountDir,'o-'+value.attemptId+'.json'),{schemaVersion:1,kind:'outcome',binding:bindingId,payload:value},stats);return true;
    })).then(value=>value===true),
    status:()=>({blocked,closed,cleanupPending:Boolean(lock&&(blocked||!accepting))}),
    close:()=>serial(async()=>{accepting=false;try{await unlock();closed=true;return {ok:true};}catch{blocked='RECEIPT_CLEANUP_PENDING';return result(blocked);}}),
    cleanup:()=>serial(async()=>{if(accepting)return result('RECEIPT_OWNER_ACTIVE');try{await unlock();closed=true;blocked=null;return {ok:true};}catch{blocked='RECEIPT_CLEANUP_PENDING';return result(blocked);}}),
  });
}
