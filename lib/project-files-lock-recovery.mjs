import {createHash,randomUUID} from 'node:crypto';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runRecoveryProcess} from './chat-lock-recovery.mjs';

const helper=fileURLToPath(new URL('./project-files-lock-recovery.ps1',import.meta.url));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const identity=info=>`${info.dev}:${info.ino}:${info.birthtimeNs}`;
export const validLibraryLock=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='owner,schema'&&value.schema===1&&uuid(value.owner));

// The helper obtains a Windows exclusive handle and holds every observed
// ancestor against replacement while verifying the exact original bytes.
// A PID is never used to decide whether an owner is still active.
export async function recoverAbandonedLibraryLock(file,chain){
  if(process.platform!=='win32'||!Array.isArray(chain)||chain.length<1||chain.length>65)return false;
  try{
    if(path.basename(file)!=='.library.lock'||path.dirname(file)!==chain.at(-1).path)return false;
    const before=await lstat(file,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>1024n||before.ino===0n)return false;
    const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let bytes;
    try{
      const info=await handle.stat({bigint:true});if(identity(info)!==identity(before)||info.size!==before.size)return false;
      const buffer=Buffer.alloc(1025);let used=0;
      while(used<buffer.length){const read=await handle.read(buffer,used,buffer.length-used,used);if(!read.bytesRead)break;used+=read.bytesRead;}
      const after=await handle.stat({bigint:true}),named=await lstat(file,{bigint:true});
      if(used>1024||identity(after)!==identity(before)||identity(named)!==identity(before)||after.size!==before.size||named.size!==before.size||after.mtimeNs!==before.mtimeNs||named.mtimeNs!==before.mtimeNs)return false;
      bytes=buffer.subarray(0,used);
    }finally{await handle.close();}
    if(bytes.length!==Number(before.size)||!validLibraryLock(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))))return false;
    const root=process.env.SystemRoot;if(typeof root!=='string'||!path.isAbsolute(root))return false;
    const request={file,archive:path.join(path.dirname(file),`.library.lock.recovered.${randomUUID()}`),chain,fileIdentity:identity(before),sha256:createHash('sha256').update(bytes).digest('hex')};
    return await runRecoveryProcess(path.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-File',helper],request);
  }catch{return false;}
}
