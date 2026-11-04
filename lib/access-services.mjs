import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createAccessPolicy,accessDirectoryChain,verifyAccessDirectoryChain} from './access-policy.mjs';
import {ACCESS_FILE_TOOLS,createAccessFileTools} from './access-file-tools.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const identity=s=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
const regular=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.ino!==0n;
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(v);
const inactive=()=>({schemaVersion:1,id:randomUUID(),revision:1,mode:'read-only',roots:[],accountScope:'inactive'});
const closed=result=>result?.closed===true||result?.value?.closed===true;
const diagnosticCode=value=>typeof value==='string'&&/^ACCESS_[A-Z0-9_]{1,80}$/u.test(value)?value:'ACCESS_POLICY_UNAVAILABLE';
const policyError=result=>Object.assign(new Error(result?.error?.message||'访问策略无法读取。'),{accessCode:diagnosticCode(result?.error?.code),...(result?.error?.recoveryCode?{recoveryCode:diagnosticCode(result.error.recoveryCode)}:{})});
export const ACCESS_SERVICE_LIMITS=Object.freeze({owners:64,projectionBytes:65536,backupEntries:128,backupBytes:8*1024*1024});

// Trusted composition owns publication and rollback. File/model tools consume
// the selected policy, and cannot publish or select authorization themselves.
export function createAccessServices({root,stateDirectory,policyFactory=createAccessPolicy,fileToolsFactory=createAccessFileTools,maxOwners=ACCESS_SERVICE_LIMITS.owners}={}){
  if(!path.isAbsolute(root??'')||!path.isAbsolute(stateDirectory??'')||typeof policyFactory!=='function'||typeof fileToolsFactory!=='function'||!Number.isSafeInteger(maxOwners)||maxOwners<1||maxOwners>64)throw new TypeError('Absolute access service directories and bounded owners required.');
  const nativeDirectory=path.join(root,'workbench'),projectionFile=path.join(nativeDirectory,'access-policy.json'),backups=path.join(stateDirectory,'native-policy-backups');
  const owners=new Map(),retained=new Set(),temporaries=new Map(),preparations=new Map();let active=null,closing=false,serial=Promise.resolve(),stateChain=null,nativeChain=null,revocationPending=false,activeTask=null;
  const stage=(task,phase,step=null)=>{if(!task?.pending)return;task.phase=phase;task.step=step;task.updatedAt=new Date().toISOString();};
  const failed=(task,code,recoveryCode)=>{if(!task?.pending)return;task.failurePhase??=task.phase;const parsed=diagnosticCode(code);if(!task.errorCode||task.errorCode==='ACCESS_POLICY_UNAVAILABLE')task.errorCode=parsed;if(recoveryCode)task.recoveryCode=diagnosticCode(recoveryCode);};
  function queue(action,{scope=null,operation}={}){
    const now=new Date().toISOString(),task={operation,phase:'queued',step:null,pending:true,queuedAt:now,startedAt:null,updatedAt:now};let entry=null;
    if(typeof scope==='string'&&scope&&scope.length<=512&&(preparations.has(scope)||preparations.size<maxOwners)){
      entry=preparations.get(scope);if(!entry){entry={queued:0,current:task};preparations.set(scope,entry);}entry.queued++;if(!entry.current.pending)entry.current=task;
    }
    const run=async()=>{if(entry){entry.queued--;entry.current=task;}activeTask=task;task.startedAt=new Date().toISOString();stage(task,'starting');
      try{const result=await action(task);if(result?.ok===false||result?.closed===false){failed(task,result?.error?.code??(revocationPending?'ACCESS_POLICY_REVOCATION_PENDING':'ACCESS_POLICY_UNAVAILABLE'));stage(task,'error');}else stage(task,'settled');return result;}
      catch(error){failed(task,error.accessCode,error.recoveryCode);stage(task,'error');throw error;}
      finally{task.pending=false;if(activeTask===task)activeTask=null;}
    };
    const work=serial.then(run,run);serial=work.catch(()=>{});return work;
  }
  function diagnostics(scope){
    const entry=preparations.get(scope);if(!entry)return null;const task=entry.current,waiting=!task.startedAt&&activeTask&&activeTask!==task;
    return Object.freeze({operation:task.operation,phase:task.phase,...task.step?{step:task.step}:{},pending:task.pending||entry.queued>0,queued:Math.min(entry.queued,1000000),queuedAt:task.queuedAt,startedAt:task.startedAt,updatedAt:task.updatedAt,...task.errorCode?{errorCode:task.errorCode}:{},...task.recoveryCode?{recoveryCode:task.recoveryCode}:{},...task.failurePhase?{failurePhase:task.failurePhase}:{},...waiting?{blockingOperation:activeTask.operation,blockingPhase:activeTask.phase,...activeTask.step?{blockingStep:activeTask.step}:{}}:{}});
  }
  const failure=(message,code='ACCESS_POLICY_UNAVAILABLE')=>({ok:false,error:{code,message},...(revocationPending?{revocationPending:true}:{})});
  async function closeHandle(handle){try{await handle.close();}catch(error){retained.add(handle);throw error;}}
  async function ensureState(task){
    stage(task,'state-directories','verify');
    if(stateChain){await verifyAccessDirectoryChain(stateChain);return;}
    let ancestor=stateDirectory;while(true){try{await fs.lstat(ancestor);break;}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;}}
    const prior=await accessDirectoryChain(ancestor);stage(task,'state-directories','create');await fs.mkdir(stateDirectory,{recursive:true});stage(task,'state-directories','verify');await verifyAccessDirectoryChain(prior);stateChain=await accessDirectoryChain(stateDirectory);
  }
  async function directories(task){await ensureState(task);stage(task,'native-directories','verify');if(!nativeChain)nativeChain=await accessDirectoryChain(nativeDirectory);await verifyAccessDirectoryChain(nativeChain);await verifyAccessDirectoryChain(stateChain);}
  async function readBounded(filename){
    const named=await fs.lstat(filename,{bigint:true});if(!regular(named)||named.size>BigInt(ACCESS_SERVICE_LIMITS.projectionBytes))throw new Error('访问策略文件无效或超出预算。');
    const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{const before=await handle.stat({bigint:true});if(!regular(before)||!sameFile(named,before))throw new Error('访问策略文件身份已变化。');const bytes=Buffer.alloc(Number(before.size));let offset=0;while(offset<bytes.length){const part=await handle.read(bytes,offset,bytes.length-offset,offset);if(!part.bytesRead)throw new Error('访问策略文件已变化。');offset+=part.bytesRead;}if(!sameFile(before,await handle.stat({bigint:true}))||!sameFile(before,await fs.lstat(filename,{bigint:true})))throw new Error('访问策略文件已变化。');return {bytes,stat:before};}finally{await closeHandle(handle);}
  }
  function projectionBytes(value){
    if(!value||Object.keys(value).sort().join(',')!=='accountScope,id,mode,revision,roots,schemaVersion'||value.schemaVersion!==1||!uuid(value.id)||!Number.isSafeInteger(value.revision)||value.revision<0||!['read-only','project-write','full-access'].includes(value.mode)||typeof value.accountScope!=='string'||!value.accountScope||value.accountScope.length>512||!Array.isArray(value.roots)||value.roots.length>64||value.roots.some(p=>typeof p!=='string'||!path.isAbsolute(p)||p.includes('\0'))||value.roots.reduce((sum,p)=>sum+p.length,0)>48000)throw new Error('访问策略投影无效。');
    const bytes=Buffer.from(JSON.stringify(value,null,2));if(bytes.length>ACCESS_SERVICE_LIMITS.projectionBytes)throw new Error('访问策略超出发布预算。');return bytes;
  }
  async function backup(prior,emergency,task){
    stage(task,'publish','backup-directory');try{await fs.mkdir(backups,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}await directories(task);stage(task,'publish','backup-scan');const chain=await accessDirectoryChain(backups),handle=await fs.opendir(backups);let count=0,total=0;
    try{while(true){const entry=await handle.read();if(!entry)break;if(++count>ACCESS_SERVICE_LIMITS.backupEntries||!/^\d{13}-[a-f0-9-]{36}\.json$/u.test(entry.name))throw new Error('访问策略备份目录无法核实或已达到上限。');const stat=await fs.lstat(path.join(backups,entry.name),{bigint:true});if(!regular(stat)||stat.size>BigInt(ACCESS_SERVICE_LIMITS.projectionBytes))throw new Error('访问策略备份身份无法核实。');total+=Number(stat.size);}}finally{await closeHandle(handle);}
    // Reserve one file and one full frame for emergency readonly publication.
    if(count+1>ACCESS_SERVICE_LIMITS.backupEntries-(emergency?0:1)||total+prior.bytes.length+(emergency?0:ACCESS_SERVICE_LIMITS.projectionBytes)>ACCESS_SERVICE_LIMITS.backupBytes)throw new Error('访问策略备份空间已达到上限；原证据保留。');
    stage(task,'publish','backup-write');const filename=path.join(backups,Date.now()+'-'+randomUUID()+'.json'),file=await fs.open(filename,'wx',0o600);try{await file.writeFile(prior.bytes);await file.sync();}finally{await closeHandle(file);}await verifyAccessDirectoryChain(chain);if(hash((await readBounded(filename)).bytes)!==hash(prior.bytes))throw new Error('访问策略备份未确认。');
  }
  async function cleanup(){
    for(const handle of [...retained])try{await handle.close();retained.delete(handle);}catch{}
    if(retained.size)return {closed:false};for(const [filename,owner] of temporaries)try{const stat=await fs.lstat(filename,{bigint:true});if(stat.isSymbolicLink()||identity(stat)!==owner)continue;await fs.unlink(filename);temporaries.delete(filename);}catch(error){if(error.code==='ENOENT')temporaries.delete(filename);}
    return {closed:retained.size===0&&temporaries.size===0};
  }
  async function publish(value,{emergency=false,task}={}){
    stage(task,'publish','cleanup');if(!closed(await cleanup()))throw new Error('访问策略发布句柄尚未清理。');await directories(task);stage(task,'publish','read-current');const bytes=projectionBytes(value);let prior=null;
    try{prior=await readBounded(projectionFile);projectionBytes(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(prior.bytes)));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(prior?.bytes.equals(bytes))return;
    if(prior)await backup(prior,emergency,task);
    stage(task,'publish','stage-write');const temporary=projectionFile+'.'+randomUUID()+'.tmp',handle=await fs.open(temporary,'wx',0o600);temporaries.set(temporary,identity(await handle.stat({bigint:true})));
    try{await handle.writeFile(bytes);await handle.sync();}finally{await closeHandle(handle);}
    await directories(task);stage(task,'publish','verify-current');
    if(prior){const now=await readBounded(projectionFile);if(!sameFile(prior.stat,now.stat)||!prior.bytes.equals(now.bytes))throw new Error('宿主访问策略在发布期间发生变化。');}
    else{try{await fs.lstat(projectionFile);throw new Error('宿主访问策略在发布期间出现。');}catch(error){if(error.code!=='ENOENT')throw error;}}
    stage(task,'publish','replace');await fs.rename(temporary,projectionFile);temporaries.delete(temporary);await directories(task);stage(task,'publish','readback');if(!(await readBounded(projectionFile)).bytes.equals(bytes))throw new Error('宿主访问策略发布未确认。');
  }
  async function revokeProjection(task){
    stage(task,'revoke');active=null;revocationPending=true;try{await publish(inactive(),{emergency:true,task});revocationPending=false;return true;}catch{return false;}
  }
  async function release(entry){
    try{await entry.ready;}catch{/* Initialization can fail after obtaining the lock. */}
    try{if(entry.files&&!closed(await entry.files.close()))return false;}catch{return false;}
    try{if(entry.policy&&!closed(await entry.policy.close()))return false;}catch{return false;}
    return true;
  }
  async function get(scope,task,{retryFailed=false}={}){
    if(closing||typeof scope!=='string'||!scope||scope.length>512)return Promise.reject(new Error('访问策略账号范围无效。'));
    let entry=owners.get(scope);if(entry){
      if(task)entry.trace=task;
      if(!retryFailed||!entry.failed){stage(task,'policy-init');return entry.ready;}
      stage(task,'policy-cleanup');
      if(!await release(entry))throw policyError({error:{code:'ACCESS_POLICY_CLEANUP_PENDING',message:'访问策略旧所有者尚未完成清理；原锁已保留。'}});
      owners.delete(scope);
    }
    if(owners.size>=maxOwners)return Promise.reject(new Error('访问策略账号数量已达到上限。'));
    // Install the promise before any await so cold concurrent requests share
    // exactly one policy/lock owner, including a partially initialized owner.
    entry={policy:null,files:null,ready:null,snapshot:null,trace:task,failed:false};owners.set(scope,entry);
    entry.ready=Promise.resolve().then(async()=>{
      await ensureState(entry.trace);stage(entry.trace,'policy-init');
      entry.policy=policyFactory({stateDirectory,accountScope:scope,protectedPaths:[projectionFile,path.join(root,'workbench','workbench-config.json'),stateDirectory,path.join(root,'runtime','install-record.json'),path.join(root,'runtime','installation.json')],onStage:event=>{
        if(!['directories','lock','journal','ready','error'].includes(event?.phase))return;stage(entry.trace,'policy-'+event.phase);
        if(event.errorCode&&entry.trace?.pending){failed(entry.trace,event.errorCode,event.recoveryCode);if(['directories','lock','journal'].includes(event.failurePhase))entry.trace.failurePhase='policy-'+event.failurePhase;}
      }});
      const result=await entry.policy.ready();if(!result.ok)throw policyError(result);entry.snapshot=result.value;entry.files=fileToolsFactory({policy:entry.policy});return entry;
    }).catch(error=>{entry.failed=true;entry.snapshot=null;throw error;});
    entry.ready.catch(()=>{});return entry.ready;
  }
  function view(scope){return owners.get(scope)?.snapshot??null;}
  async function activate(scope){return queue(async task=>{
    try{if(revocationPending&&!await revokeProjection(task))return failure('宿主访问策略撤销仍未确认。','ACCESS_POLICY_REVOCATION_PENDING');const entry=await get(scope,task,{retryFailed:true});stage(task,'journal');const snapshot=await entry.policy.describe();if(!snapshot.ok)throw policyError(snapshot);entry.snapshot=snapshot.value;
      if(!active||active.scope!==scope||active.id!==snapshot.value.id||active.revision!==snapshot.value.revision){stage(task,'projection');const projection=await entry.policy.nativeProjection();if(!projection.ok)throw policyError(projection);await publish(projection.value,{task});active={scope,id:snapshot.value.id,revision:snapshot.value.revision};}return {ok:true,value:snapshot.value};
    }catch(error){failed(task,error.accessCode,error.recoveryCode);await revokeProjection(task);return failure(error.message||'访问策略未就绪。',diagnosticCode(error.accessCode));}
  },{scope,operation:'activate'});}
  async function select(scope,{mode,roots=[],confirmed=false,expectedRevision}={}){return queue(async task=>{
    let entry,changed;const wasActive=active;
    try{entry=await get(scope,task);active=null;stage(task,'journal','update');changed=await entry.policy.update({mode,roots,confirmedFullAccess:mode==='full-access'&&confirmed===true,expectedRevision});if(!changed.ok){if(wasActive&&entry.policy.isCurrent(wasActive))active=wasActive;return changed;}
      stage(task,'projection');const projection=await entry.policy.nativeProjection();if(!projection.ok)throw policyError(projection);await publish(projection.value,{task});const snapshot=changed.value.policy;entry.snapshot=snapshot;active={scope,id:snapshot.id,revision:snapshot.revision};revocationPending=false;return {ok:true,value:snapshot};
    }catch(error){
      active=null;failed(task,error.accessCode,error.recoveryCode);
      if(entry?.policy&&changed?.ok&&changed.value.changed)try{await entry.policy.revert({expectedRevision:changed.value.policy.revision});const prior=await entry.policy.describe();if(prior.ok){if(prior.value.mode!=='read-only')await entry.policy.update({mode:'read-only',roots:prior.value.roots,expectedRevision:prior.value.revision});const after=await entry.policy.describe();if(after.ok)entry.snapshot=after.value;}}catch{}
      const revoked=await revokeProjection(task);return failure(revoked?(error.message||'访问策略发布未完成，已撤销宿主写入范围。'):'访问策略发布失败，宿主撤销仍待恢复；本地已阻止新操作。',revoked?'ACCESS_POLICY_PUBLISH_FAILED':'ACCESS_POLICY_REVOCATION_PENDING');
    }
  },{scope,operation:'select'});}
  function current(scope,snapshot){const entry=owners.get(scope);return !closing&&!revocationPending&&active?.scope===scope&&active.id===snapshot?.id&&active.revision===snapshot?.revision&&entry?.policy.isCurrent(snapshot)===true;}
  function control(scope){const snapshot=view(scope);return snapshot&&current(scope,snapshot)?{id:snapshot.id,revision:snapshot.revision,accountScope:snapshot.accountScope,mode:snapshot.mode}:null;}
  async function invoke(tool,args,{scope,isCurrent}={}){
    try{const entry=await get(scope),snapshot=view(scope),valid=()=>current(scope,snapshot)&&isCurrent?.()===true;if(!valid())return failure('访问策略或当前对话已变化，文件操作未执行。');return await entry.files.invoke(tool,args,{isCurrent:valid});}catch(error){return failure(error.message||'文件访问策略未就绪。');}
  }
  async function authorize(scope,target,{write=false}={}){try{const entry=await get(scope),snapshot=view(scope);if(!current(scope,snapshot))return failure('访问策略已变化。');const result=await entry.policy.authorize(target,{write});return current(scope,snapshot)?result:failure('访问策略已变化。');}catch(error){return failure(error.message||'文件访问策略未就绪。');}}
  async function deactivate(){return queue(async task=>({closed:await revokeProjection(task)}),{operation:'deactivate'});}
  async function close(){
    closing=true;await serial;const revoked=await revokeProjection();let released=true;
    for(const entry of owners.values())if(!await release(entry))released=false;
    return {closed:revoked&&released&&closed(await cleanup())};
  }
  return Object.freeze({tools:ACCESS_FILE_TOOLS,view,diagnostics,activate,select,current,control,authorize,invoke,deactivate,close});
}
