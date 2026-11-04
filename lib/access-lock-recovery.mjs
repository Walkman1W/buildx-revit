import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('./access-lock-recovery.cs',import.meta.url));
const identity=info=>`${info.dev}:${info.ino}:${info.birthtimeNs}`;
const fingerprint=info=>`${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const regular=info=>info.isFile()&&!info.isSymbolicLink()&&info.nlink===1n&&info.ino!==0n;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const failure=code=>({ok:false,error:{code}});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
const retained=new Map();
const busy=new Set();

async function chain(directory){
  const paths=[];let cursor=directory;
  while(true){paths.unshift(cursor);const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
  if(paths.length>65)throw new Error('chain');
  const records=[];
  for(const item of paths){const info=await fs.lstat(item,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink()||!same(item,await fs.realpath(item)))throw new Error('chain');records.push({path:item,id:identity(info)});}
  return records;
}
async function verify(records){for(const item of records){const info=await fs.lstat(item.path,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink()||identity(info)!==item.id)throw new Error('chain-changed');}}
async function ensureDirectory(directory,ancestors){try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}await verify(ancestors);return chain(directory);}

// Four fixed compiler slots bound crash remnants across processes. A slot is
// claimed with atomic mkdir and removed only by its recorded current owner.
// Closed but unowned old slots are deliberately not reclaimed on a time/PID guess.
async function claimSlot(root,rootChain){
  const directory=path.join(root,'access-lock-recovery-helpers'),records=await ensureDirectory(directory,rootChain);
  const entries=await fs.readdir(directory,{withFileTypes:true});
  if(entries.length>4||entries.some(item=>!/^slot-[0-3]$/u.test(item.name)||!item.isDirectory()||item.isSymbolicLink()))throw new Error('cache-budget');
  for(let index=0;index<4;index++){
    const slot=path.join(directory,`slot-${index}`);
    try{await fs.mkdir(slot,{mode:0o700});}catch(error){if(error.code==='EEXIST')continue;throw error;}
    await verify(records);const info=await fs.lstat(slot,{bigint:true});
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('cache-directory');
    const owner={path:slot,id:identity(info),executable:path.join(slot,'helper.exe'),fileId:null,records:await chain(slot),running:false};retained.set(slot,owner);return owner;
  }
  throw new Error('cache-capacity');
}
async function cleanup(owner){
  if(owner.running)return false;
  try{
    await verify(owner.records);
    const entries=await fs.readdir(owner.path);
    if(entries.some(item=>item!=='helper.exe'))return false;
    if(entries.length){const info=await fs.lstat(owner.executable,{bigint:true});if(!regular(info)||owner.fileId&&identity(info)!==owner.fileId)return false;await fs.unlink(owner.executable);}
    const info=await fs.lstat(owner.path,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink()||identity(info)!==owner.id)return false;
    await fs.rmdir(owner.path);retained.delete(owner.path);return true;
  }catch{return false;}
}
function run(executable,args,input,owner,{timeoutMs=15000,maxOutput=16384}={}){
  return new Promise(resolve=>{
    let child,output='',used=0,failed=false,settled=false,finalTimer;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(finalTimer);resolve(value);};
    const abort=()=>{failed=true;try{child.kill();}catch{};finalTimer??=setTimeout(()=>finish({ok:false,running:owner.running}),2000);};
    try{child=spawn(executable,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot,TEMP:owner.path,TMP:owner.path}});owner.running=true;}
    catch{return resolve({ok:false,running:false});}
    const timer=setTimeout(abort,timeoutMs);
    const receive=(chunk,keep)=>{used+=chunk.length;if(used>maxOutput)return abort();if(keep)output+=chunk.toString('utf8');};
    child.stdout.on('data',chunk=>receive(chunk,true));child.stderr.on('data',chunk=>receive(chunk,false));child.stdin.on('error',()=>{});
    child.once('error',()=>{failed=true;});
    child.once('close',code=>{const previouslySettled=settled;owner.running=false;finish({ok:!failed&&code===0,output});if(previouslySettled)void cleanup(owner);});
    child.stdin.end(input);
  });
}

// The inspection is bounded and read-only. The C# boundary rechecks these exact
// facts while holding kernel leases before it may archive anything.
export async function prepareAccessLockRecovery({stateDirectory,file,sourceChain}={}){
  if(process.platform!=='win32')return failure('ACCESS_LOCK_RECOVERY_UNAVAILABLE');
  try{
    if(!path.isAbsolute(stateDirectory)||!path.isAbsolute(file)||!same(path.dirname(path.dirname(file)),stateDirectory)||path.basename(file)!=='.owner.lock'||!/^access-[a-f0-9]{32}$/u.test(path.basename(path.dirname(file)))||!Array.isArray(sourceChain)||!same(sourceChain.at(-1)?.path??'',path.dirname(file)))throw new Error('path');
    const observed=await fs.lstat(file,{bigint:true});if(!regular(observed)||observed.size>1024n)throw new Error('lock');
    const handle=await fs.open(file,'r');let bytes;
    try{
      const before=await handle.stat({bigint:true});if(fingerprint(before)!==fingerprint(observed))throw new Error('identity');
      const buffer=Buffer.alloc(1025);let used=0;
      while(used<buffer.length){const read=await handle.read(buffer,used,buffer.length-used,used);if(!read.bytesRead)break;used+=read.bytesRead;}
      if(used!==Number(observed.size)||used>1024||fingerprint(await handle.stat({bigint:true}))!==fingerprint(observed)||fingerprint(await fs.lstat(file,{bigint:true}))!==fingerprint(observed))throw new Error('changed');bytes=buffer.subarray(0,used);
    }finally{await handle.close();}
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),value=JSON.parse(text);
    if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='owner,schema'||value.schema!==1||!uuid(value.owner)||text!==JSON.stringify({schema:1,owner:value.owner}))throw new Error('schema');
    const rootChain=await chain(stateDirectory);await verify(sourceChain);
    const archiveDirectory=path.join(stateDirectory,'access-lock-recovery'),archiveChain=await ensureDirectory(archiveDirectory,rootChain);
    return {ok:true,value:{stateDirectory,file,sourceChain,archiveDirectory,archiveChain,archiveName:`owner-lock-${randomUUID()}.bak`,fileIdentity:identity(observed),sha256:sha(bytes)}};
  }catch{return failure('ACCESS_LOCK_NOT_RECOVERABLE');}
}

export async function recoverAbandonedAccessLock(input){
  if(process.platform!=='win32')return failure('ACCESS_LOCK_RECOVERY_UNAVAILABLE');
  const root=input?.stateDirectory;
  if(typeof root!=='string'||busy.has(root))return failure('ACCESS_LOCK_RECOVERY_UNAVAILABLE');
  busy.add(root);let owner;
  try{
    for(const prior of retained.values())if(same(path.dirname(path.dirname(prior.path)),root)&&!await cleanup(prior))return failure('ACCESS_LOCK_RECOVERY_CLEANUP_PENDING');
    const prepared=await prepareAccessLockRecovery(input);if(!prepared.ok)return prepared;
    const systemRoot=process.env.SystemRoot;if(typeof systemRoot!=='string'||!path.isAbsolute(systemRoot)||systemRoot.startsWith('\\\\'))return failure('ACCESS_LOCK_RECOVERY_UNAVAILABLE');
    const compiler=path.join(systemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
    const compilerInfo=await fs.lstat(compiler);if(!compilerInfo.isFile()||compilerInfo.isSymbolicLink())return failure('ACCESS_LOCK_RECOVERY_UNAVAILABLE');
    const sourceInfo=await fs.lstat(source);if(!sourceInfo.isFile()||sourceInfo.isSymbolicLink()||sourceInfo.size>65536)return failure('ACCESS_LOCK_RECOVERY_UNAVAILABLE');
    const rootChain=await chain(root);owner=await claimSlot(root,rootChain);
    const compiled=await run(compiler,['/nologo','/target:exe','/optimize+','/debug-','/reference:System.Web.Extensions.dll',`/out:${owner.executable}`,source],'',owner);
    if(!compiled.ok)return failure('ACCESS_LOCK_RECOVERY_UNAVAILABLE');
    await verify(owner.records);const info=await fs.lstat(owner.executable,{bigint:true});
    if(!regular(info)||info.size>1048576n)throw new Error('compiled-helper');owner.fileId=identity(info);
    const result=await run(owner.executable,[],JSON.stringify(prepared.value),owner);
    if(!result.ok)return failure('ACCESS_LOCK_RECOVERY_UNAVAILABLE');
    let parsed;try{parsed=JSON.parse(result.output);}catch{return failure('ACCESS_LOCK_RECOVERY_UNAVAILABLE');}
    if(parsed?.ok!==true)return failure(['ACCESS_LOCK_NOT_RECOVERABLE','ACCESS_LOCK_ARCHIVE_UNCONFIRMED','ACCESS_LOCK_REQUEST_INVALID'].includes(parsed?.error?.code)?parsed.error.code:'ACCESS_LOCK_RECOVERY_UNAVAILABLE');
    const value=parsed.value,request=prepared.value;
    if(value?.archiveName!==request.archiveName||value.sha256!==request.sha256||value.fileIdentity!==request.fileIdentity||value.evidenceName!==request.archiveName.replace(/\.bak$/u,'.json'))return failure('ACCESS_LOCK_ARCHIVE_UNCONFIRMED');
    return {ok:true,value};
  }catch{return failure('ACCESS_LOCK_RECOVERY_UNAVAILABLE');}
  finally{if(owner)await cleanup(owner);busy.delete(root);}
}
