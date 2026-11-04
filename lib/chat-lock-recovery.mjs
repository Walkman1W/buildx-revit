import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const helper=fileURLToPath(new URL('./chat-lock-recovery.ps1',import.meta.url));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const identity=info=>`${info.dev}:${info.ino}:${info.birthtimeNs}`;
const retained=new Set();

// Recovery does not use stdout/stderr/stdin pipes: a compiler descendant may
// inherit these and prevent child 'close' after PowerShell itself has exited.
// Keep any timed-out process owned until exit and block further local attempts.
export function runRecoveryProcess(executable,args,request,{timeoutMs=15000}={}){
  if(retained.size)return Promise.resolve(false);
  return new Promise(resolve=>{
    let child,timedOut=false,settled=false;
    try{child=spawn(executable,args,{windowsHide:true,stdio:'ignore',env:{...process.env,BUILDX_CHAT_LOCK_RECOVERY_REQUEST:JSON.stringify(request)}});}catch{return resolve(false);}
    retained.add(child);
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const release=()=>retained.delete(child);
    const timer=setTimeout(()=>{timedOut=true;try{child.kill();}catch{}finish(false);},timeoutMs);
    child.once('exit',code=>{release();finish(!timedOut&&code===0);});
    child.once('error',()=>{});
    // A failed spawn has no exit event; close is its terminal ownership signal.
    child.once('close',()=>{release();finish(false);});
  });
}

// Only a lock produced by this store can be archived. The helper obtains a
// Windows exclusive file handle and verifies both the original bytes and all
// ancestor identities while holding them against deletion/rename. It never
// uses a PID as proof that a live owner has exited.
export async function recoverAbandonedChatLock(file,chain){
  if(process.platform!=='win32'||!Array.isArray(chain)||chain.length<1||chain.length>65)return false;
  try{
    if(path.basename(file)!=='.panel-chat.lock'||path.dirname(file)!==chain.at(-1).path)return false;
    const before=await lstat(file,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>1024n||before.ino===0n)return false;
    const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let bytes;
    try{
      const info=await handle.stat({bigint:true});if(identity(info)!==identity(before)||info.size!==before.size)return false;
      // The path may still be modified by an active owner. Never allocate from
      // an untrusted changing length while merely inspecting the lock.
      const buffer=Buffer.alloc(1025);let used=0;
      while(used<buffer.length){const read=await handle.read(buffer,used,buffer.length-used,used);if(!read.bytesRead)break;used+=read.bytesRead;}
      const after=await handle.stat({bigint:true});if(used>1024||identity(after)!==identity(before)||after.size!==before.size)return false;
      bytes=buffer.subarray(0,used);
    }
    finally{await handle.close();}
    if(bytes.length!==Number(before.size))return false;
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='createdUtc,owner,pid,schemaVersion,source'||value.schemaVersion!==2||value.source!=='local-codex-panel'||!uuid(value.owner)||!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.createdUtc!=='string'||!Number.isFinite(Date.parse(value.createdUtc)))return false;
    const request={file,archive:path.join(path.dirname(file),`.panel-chat.lock.recovered.${randomUUID()}`),chain,fileIdentity:identity(before),sha256:createHash('sha256').update(bytes).digest('hex')};
    const root=process.env.SystemRoot;
    if(typeof root!=='string'||!path.isAbsolute(root))return false;
    const executable=path.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
    return await runRecoveryProcess(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',helper],request);
  }catch{return false;}
}
