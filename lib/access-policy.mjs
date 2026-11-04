import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {recoverAbandonedAccessLock} from './access-lock-recovery.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const ok=value=>({ok:true,value});
const fail=(code,message='访问策略未能核实，原记录已保留。')=>({ok:false,error:{code,message}});
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const modes=new Set(['read-only','project-write','full-access']);
const recoveryCodes=new Set(['ACCESS_LOCK_NOT_RECOVERABLE','ACCESS_LOCK_RECOVERY_UNAVAILABLE','ACCESS_LOCK_RECOVERY_CLEANUP_PENDING','ACCESS_LOCK_ARCHIVE_UNCONFIRMED','ACCESS_LOCK_REQUEST_INVALID']);
const normal=value=>process.platform==='win32'?value.toLowerCase():value;
const samePath=(a,b)=>normal(path.resolve(a))===normal(path.resolve(b));
export function accessPathContains(parent,child){const relative=path.relative(normal(path.resolve(parent)),normal(path.resolve(child)));return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
export function normalizeAccessPath(value){
  if(typeof value!=='string'||!value||value.length>32767||/[\0-\x1f]/u.test(value)||!path.isAbsolute(value))throw new Error('path');
  if(process.platform==='win32'){
    if(value.startsWith('\\\\')||value.slice(2).includes(':'))throw new Error('local-path');
    for(const segment of value.slice(path.parse(value).root.length).split(/[\\/]/u))if(segment&&(/[. ]$/u.test(segment)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)))throw new Error('windows-path');
  }
  return path.resolve(value);
}
const identity=s=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
const fingerprint=s=>`${identity(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const regular=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.ino!==0n;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const clone=value=>structuredClone(value);
export async function accessDirectoryChain(directory){
  const paths=[];let cursor=directory;while(true){paths.unshift(cursor);const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
  const records=[];for(const item of paths){const stat=await fs.lstat(item,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||!samePath(item,await fs.realpath(item)))throw new Error('directory');records.push({path:item,id:identity(stat)});}return records;
}
export async function verifyAccessDirectoryChain(records){for(const item of records){const stat=await fs.lstat(item.path,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||identity(stat)!==item.id)throw new Error('directory-changed');}}

// One account-owned, serial policy journal. A policy is durable authority only
// after its exact append is read back. Session/host/turn identities stay outside.
export function createAccessPolicy({stateDirectory,accountScope,protectedPaths=[],maxRecords=1024,onStage}={}){
  if(typeof stateDirectory!=='string'||!path.isAbsolute(stateDirectory)||typeof accountScope!=='string'||!accountScope||accountScope.length>512||accountScope.includes('\0')||!Array.isArray(protectedPaths)||!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>1024||onStage!==undefined&&typeof onStage!=='function')throw new TypeError('Access policy requires an absolute state directory and account scope.');
  const root=normalizeAccessPath(stateDirectory),directory=path.join(root,'access-'+hash(accountScope).slice(0,32)),backupDirectory=path.join(directory,'file-backups');
  const protectedRoots=[directory,...protectedPaths.map(normalizeAccessPath)],lockPath=path.join(directory,'.owner.lock');
  let state=freeze({id:randomUUID(),revision:0,mode:'read-only',roots:[],accountScope}),previous=null,loaded=false,closing=false,closed=false,faulted=false,tail=Promise.resolve(),lock=null,lockUnlinked=false,chain=null,lastHash='0'.repeat(64);
  const retained=new Set();
  // Fixed producer stages are diagnostics only; observers cannot change an
  // ownership or authorization result and receive no paths or journal data.
  const stage=(phase,extra={})=>{try{onStage?.(Object.freeze({phase,...extra}));}catch{}};
  const serial=fn=>{const work=tail.then(fn,fn);tail=work.catch(()=>{});return work;};
  async function closeHandle(handle){try{await handle.close();}catch(error){retained.add(handle);throw error;}}
  async function readRecord(filename){
    const named=await fs.lstat(filename,{bigint:true});if(!regular(named)||named.size>65536n)throw new Error('record');
    const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{const opened=await handle.stat({bigint:true});if(!regular(opened)||fingerprint(opened)!==fingerprint(named))throw new Error('record');const bytes=await handle.readFile();if(fingerprint(opened)!==fingerprint(await handle.stat({bigint:true}))||fingerprint(opened)!==fingerprint(await fs.lstat(filename,{bigint:true})))throw new Error('record-changed');return bytes;}finally{await closeHandle(handle);}
  }
  const validPolicy=value=>plain(value)&&Object.keys(value).sort().join(',')==='accountScope,id,mode,revision,roots'&&uuid(value.id)&&Number.isSafeInteger(value.revision)&&value.revision>=0&&modes.has(value.mode)&&value.accountScope===accountScope&&Array.isArray(value.roots)&&value.roots.length<=64&&value.roots.every(item=>plain(item)&&Object.keys(item).sort().join(',')==='identity,path'&&typeof item.identity==='string'&&item.identity.length<=200&&typeof item.path==='string'&&samePath(item.path,normalizeAccessPath(item.path)))&&new Set(value.roots.map(item=>normal(item.path))).size===value.roots.length&&(value.mode!=='project-write'||value.roots.length>0)&&(value.mode!=='full-access'||value.roots.length===0);
  async function verify(){
    await verifyAccessDirectoryChain(chain);if(!lock||!regular(await lock.stat({bigint:true}))||identity(await lock.stat({bigint:true}))!==identity(await fs.lstat(lockPath,{bigint:true})))throw new Error('lock');
  }
  async function scan(){
    await verify();const entries=await fs.readdir(directory,{withFileTypes:true});if(entries.length>maxRecords+2)throw new Error('capacity');
    const names=[];for(const entry of entries){if(entry.name==='.owner.lock')continue;if(entry.name==='file-backups'){if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error('backup-directory');continue;}if(!/^policy-\d{8}\.json$/u.test(entry.name)||!entry.isFile())throw new Error('unknown-record');names.push(entry.name);}names.sort();
    let prior='0'.repeat(64),policy=null;for(let index=0;index<names.length;index++){
      if(names[index]!==`policy-${String(index+1).padStart(8,'0')}.json`)throw new Error('sequence');const bytes=await readRecord(path.join(directory,names[index]));const event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      if(!plain(event)||Object.keys(event).sort().join(',')!=='policy,previous,schema,sequence'||event.schema!==1||event.sequence!==index+1||event.previous!==prior||!validPolicy(event.policy)||event.policy.revision!==index+1||policy&&event.policy.id!==policy.id)throw new Error('journal');
      policy=event.policy;prior=hash(bytes);
    }await verify();return {policy,lastHash:prior,count:names.length};
  }
  async function ready(){return serial(async()=>{
    if(loaded&&!faulted&&!closing){stage('ready');return ok(clone(state));}if(closing||closed||faulted){stage('error',{errorCode:'ACCESS_POLICY_UNAVAILABLE'});return fail('ACCESS_POLICY_UNAVAILABLE');}
    let currentStage='directories',recoveryCode=null;
    try{
      stage(currentStage);const ancestors=await accessDirectoryChain(root);try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}await verifyAccessDirectoryChain(ancestors);chain=await accessDirectoryChain(directory);
      currentStage='lock';stage(currentStage);
      try{lock=await fs.open(lockPath,'wx',0o600);}catch(error){
        if(error.code!=='EEXIST'||process.platform!=='win32')throw error;
        const recovery=await recoverAbandonedAccessLock({stateDirectory:root,file:lockPath,sourceChain:chain});
        if(!recovery.ok){recoveryCode=recoveryCodes.has(recovery.error?.code)?recovery.error.code:'ACCESS_LOCK_RECOVERY_UNAVAILABLE';throw error;}
        await verifyAccessDirectoryChain(chain);
        // An archive is not ownership. Competing processes must still win the
        // original atomic exclusive create; retry exactly once.
        lock=await fs.open(lockPath,'wx',0o600);
      }
      await lock.writeFile(JSON.stringify({schema:1,owner:randomUUID()}));await lock.sync();
      currentStage='journal';stage(currentStage);const found=await scan();if(found.policy)state=freeze(found.policy);lastHash=found.lastHash;loaded=true;stage('ready');return ok(clone(state));
    }catch(error){
      faulted=true;const code=recoveryCode&&recoveryCode!=='ACCESS_LOCK_NOT_RECOVERABLE'?recoveryCode:error.code==='EEXIST'?'ACCESS_POLICY_LOCKED':'ACCESS_POLICY_INVALID',extra=recoveryCode?{recoveryCode}:{};stage('error',{errorCode:code,failurePhase:currentStage,...extra});
      const result=fail(code,code==='ACCESS_POLICY_LOCKED'?'访问策略被另一服务占用，或旧所有权锁尚未恢复；原锁和权限记录已保留。':undefined);return {...result,error:{...result.error,...extra}};
    }
  });}
  async function describe(){return serial(async()=>{
    if(!loaded||faulted||closing)return fail('ACCESS_POLICY_UNAVAILABLE');try{const found=await scan();if(found.count!==state.revision||found.lastHash!==lastHash)throw new Error('changed');return ok(clone(state));}catch{faulted=true;return fail('ACCESS_POLICY_INVALID');}
  });}
  async function persist(next){
    const found=await scan();if(found.count!==state.revision||found.lastHash!==lastHash||found.count>=maxRecords)throw new Error('changed-or-capacity');
    const filename=path.join(directory,`policy-${String(next.revision).padStart(8,'0')}.json`),bytes=Buffer.from(JSON.stringify({schema:1,sequence:next.revision,previous:lastHash,policy:next}));
    const handle=await fs.open(filename,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await closeHandle(handle);}
    if(!(await readRecord(filename)).equals(bytes))throw new Error('write-unknown');state=freeze(next);lastHash=hash(bytes);
  }
  async function update(input={}){return serial(async()=>{
    if(!loaded||closing||faulted)return fail('ACCESS_POLICY_UNAVAILABLE');
    if(!plain(input)||Object.keys(input).some(key=>!['mode','roots','confirmedFullAccess','expectedRevision'].includes(key))||!modes.has(input.mode)||input.expectedRevision!==state.revision||!Array.isArray(input.roots??[])||(input.roots??[]).length>64)return fail('ACCESS_POLICY_INPUT_INVALID','访问范围或策略版本无效，请刷新后重试。');
    if(input.mode==='full-access'&&input.confirmedFullAccess!==true)return fail('ACCESS_FULL_CONFIRMATION_REQUIRED','完全访问需要用户在面板明确选择并确认。');
    let roots=[];
    try{if(input.mode!=='full-access')for(const chosen of input.roots??[]){const absolute=normalizeAccessPath(typeof chosen==='string'?chosen:chosen?.path),records=await accessDirectoryChain(absolute);if(!roots.some(item=>samePath(item.path,absolute)))roots.push({path:absolute,identity:records.at(-1).id});}if(input.mode==='project-write'&&!roots.length)return fail('ACCESS_PROJECT_ROOT_REQUIRED','请先选择可读写的项目目录。');}
    catch{return fail('ACCESS_ROOT_UNAVAILABLE','所选项目目录不可访问、含链接或身份已变化。');}
    const prior=clone(state);if(prior.mode===input.mode&&JSON.stringify(prior.roots)===JSON.stringify(roots))return ok({policy:prior,previous:prior,changed:false});
    try{await persist({...prior,revision:prior.revision+1,mode:input.mode,roots});previous=prior;return ok({policy:clone(state),previous:prior,changed:true});}catch{faulted=true;return fail('ACCESS_POLICY_WRITE_UNKNOWN','访问策略保存结果未确认；原记录已保留，未继续授权。');}
  });}
  async function revert({expectedRevision}={}){return serial(async()=>{
    if(!loaded||closing||faulted||!previous||expectedRevision!==state.revision)return fail('ACCESS_POLICY_REVERT_UNAVAILABLE');
    const prior=clone(state),restore=clone(previous);try{await persist({...restore,revision:state.revision+1});previous=null;return ok({policy:clone(state),previous:prior,changed:true});}catch{faulted=true;return fail('ACCESS_POLICY_WRITE_UNKNOWN');}
  });}
  const isCurrent=token=>loaded&&!closing&&!closed&&!faulted&&retained.size===0&&token?.id===state.id&&token?.revision===state.revision;
  async function authorize(chosen,{write=false,allowMissing=false}={}){return serial(async()=>{
    if(!loaded||faulted||closing)return fail('ACCESS_POLICY_UNAVAILABLE');const token={id:state.id,revision:state.revision},snapshot=state;
    try{
      let journal;try{journal=await scan();}catch{faulted=true;return fail('ACCESS_POLICY_INVALID');}if(journal.count!==state.revision||journal.lastHash!==lastHash){faulted=true;return fail('ACCESS_POLICY_INVALID');}
      const absolute=normalizeAccessPath(chosen);if(write&&protectedRoots.some(protectedPath=>accessPathContains(protectedPath,absolute)))return fail('ACCESS_POLICY_PATH_RESERVED','BuildX 自身的访问策略和授权状态只能通过面板管理。');
      if(write&&snapshot.mode==='read-only')return fail('ACCESS_READ_ONLY','当前访问权限为只读。');
      const rootEntry=snapshot.mode==='full-access'?null:snapshot.roots.find(item=>accessPathContains(item.path,absolute));
      if(snapshot.mode!=='full-access'&&!rootEntry)return fail('ACCESS_PATH_OUTSIDE_SCOPE','路径不在已选访问范围内，请设置项目目录或明确选择完全访问。');
      if(rootEntry){const roots=await accessDirectoryChain(rootEntry.path);if(roots.at(-1).id!==rootEntry.identity)return fail('ACCESS_ROOT_CHANGED','工作区目录身份已变化，请重新选择。');}
      let stat;try{stat=await fs.lstat(absolute,{bigint:true});}catch(error){if(error.code!=='ENOENT'||!allowMissing)throw error;}
      await accessDirectoryChain(stat?.isDirectory()?absolute:path.dirname(absolute));
      if(stat&&(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1n||!stat.isDirectory()&&!stat.isFile()||!samePath(absolute,await fs.realpath(absolute))))throw new Error('target');
      if(!isCurrent(token))return fail('ACCESS_POLICY_CHANGED','访问策略已变化，请重新发起操作。');
      return ok({path:absolute,policy:token,exists:Boolean(stat),...(rootEntry?{rootPath:rootEntry.path}:{})});
    }catch{return fail('ACCESS_PATH_UNAVAILABLE','文件路径不可访问、含链接或其身份无法核实。');}
  });}
  async function nativeProjection(){const result=await describe();if(!result.ok)return result;const p=result.value;try{for(const item of p.roots){const records=await accessDirectoryChain(item.path);if(records.at(-1).id!==item.identity)return fail('ACCESS_ROOT_CHANGED','工作区目录身份已变化，请重新选择。');}if(!isCurrent(p))return fail('ACCESS_POLICY_CHANGED');return ok({schemaVersion:1,id:p.id,revision:p.revision,mode:p.mode,accountScope:p.accountScope,roots:p.roots.map(item=>item.path)});}catch{return fail('ACCESS_ROOT_UNAVAILABLE','工作区目录不可访问或身份已变化。');}}
  async function close(){closing=true;return serial(async()=>{
    for(const handle of [...retained])try{await handle.close();retained.delete(handle);}catch{}
    if(retained.size)return {closed:false};if(closed)return {closed:true};
    if(lock){try{if(!lockUnlinked){const observed=await fs.lstat(lockPath,{bigint:true}),opened=await lock.stat({bigint:true});if(identity(observed)!==identity(opened))throw new Error('lock');await fs.unlink(lockPath);lockUnlinked=true;}await lock.close();lock=null;}catch{return {closed:false};}}
    closed=true;return {closed:true};
  });}
  return Object.freeze({ready,describe,update,revert,authorize,isCurrent,nativeProjection,close,storageDirectory:directory,backupDirectory});
}
