import {spawn as spawnChild} from 'node:child_process';
import path from 'node:path';
import {isIP} from 'node:net';

export const PANEL_PREFLIGHT_LIMITS=Object.freeze({queryTimeoutMs:5000,cleanupTimeoutMs:1000,stdoutBytes:128*1024,stderrBytes:64*1024});
const messages=Object.freeze({
  PREFLIGHT_CONFIG_INVALID:'本工程启动诊断配置无效。',PREFLIGHT_BUSY:'启动诊断仍在进行。',PREFLIGHT_CLOSED:'启动诊断已关闭。',
  PREFLIGHT_SPAWN_FAILED:'无法启动本工程只读诊断。',PREFLIGHT_PIPE_FAILED:'启动诊断管道未能完成。',PREFLIGHT_TIMEOUT:'启动诊断超过期限。',
  PREFLIGHT_STDOUT_LIMIT:'启动诊断输出超过上限。',PREFLIGHT_STDERR_LIMIT:'启动诊断错误输出超过上限。',PREFLIGHT_CHILD_FAILED:'启动诊断进程未正常结束。',
  PREFLIGHT_RESPONSE_INVALID:'启动诊断回执无法核对。',PREFLIGHT_QUERY_FAILED:'系统启动信息查询未完成，不能认定进程或监听不存在。',
  PREFLIGHT_IDENTITY_UNKNOWN:'存在无法核对的进程身份，不能继续自动启动或替换。',PREFLIGHT_CLEANUP_PENDING:'启动诊断清理尚未确认，仍保留自有进程。',
});
const ok=value=>({ok:true,value});
const fail=(code,cleanupPending=false)=>({ok:false,error:{code,message:messages[code],cleanupPending}});
const plain=value=>value!==null&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const keys=(value,names)=>plain(value)&&Reflect.ownKeys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const uint=value=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;
const pid=value=>uint(value)&&value>0;
const role=value=>value==='model'||value==='source';
const absolute=value=>typeof value==='string'&&value.length<=32767&&!/[\x00-\x1f\x7f]/u.test(value)&&/^[A-Za-z]:[\\/]/u.test(value)&&path.win32.isAbsolute(value);
const list=(value,max)=>Array.isArray(value)&&value.length<=max;
const iso=value=>{
  if(typeof value!=='string')return false;
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if(!match||!Number.isFinite(Date.parse(value)))return false;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const monthDays=[31,(year%4===0&&(year%100!==0||year%400===0))?29:28,31,30,31,30,31,31,30,31,30,31];
  return month>=1&&month<=12&&day>=1&&day<=monthDays[month-1]&&Number(match[4])<24&&Number(match[5])<60&&Number(match[6])<60&&(match[7]==='Z'||Number(match[8])<=14&&Number(match[9])<60&&(Number(match[8])<14||Number(match[9])===0));
};
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** Consume only the observer's named facts; CommandMatches is owned by its exact-argv parser. */
export function parsePanelSnapshot(bytes,{root}={}){
  if(!absolute(root)||!Buffer.isBuffer(bytes)||bytes.length>PANEL_PREFLIGHT_LIMITS.stdoutBytes)return fail('PREFLIGHT_RESPONSE_INVALID');
  let value;
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail('PREFLIGHT_RESPONSE_INVALID');}
  if(keys(value,['schemaVersion','complete','reason'])&&value.schemaVersion===1&&value.complete===false&&value.reason==='QUERY_FAILED')return fail('PREFLIGHT_QUERY_FAILED');
  if(!keys(value,['schemaVersion','complete','listeners','processes','ambiguousProcesses','unreadableNodeProcesses'])||value.schemaVersion!==1||value.complete!==true||!list(value.listeners,1024)||!list(value.processes,32)||!list(value.ambiguousProcesses,128)||!uint(value.unreadableNodeProcesses))return fail('PREFLIGHT_RESPONSE_INVALID');
  for(const item of value.listeners)if(!keys(item,['LocalAddress','LocalPort','OwningProcess'])||typeof item.LocalAddress!=='string'||item.LocalAddress.length>128||!isIP(item.LocalAddress)||![41873,41874].includes(item.LocalPort)||!pid(item.OwningProcess))return fail('PREFLIGHT_RESPONSE_INVALID');
  for(const item of value.processes)if(!keys(item,['Role','ProcessId','ExecutablePath','CreationDate','CommandLine','CommandMatches'])||!role(item.Role)||!pid(item.ProcessId)||!absolute(item.ExecutablePath)||path.win32.basename(item.ExecutablePath).toLowerCase()!=='node.exe'||!iso(item.CreationDate)||typeof item.CommandLine!=='string'||!item.CommandLine||item.CommandLine.length>32767||/[\x00\r\n]/u.test(item.CommandLine)||item.CommandMatches!==true)return fail('PREFLIGHT_RESPONSE_INVALID');
  for(const item of value.ambiguousProcesses)if(!keys(item,['Role','pid'])||!role(item.Role)||!pid(item.pid))return fail('PREFLIGHT_RESPONSE_INVALID');
  if(value.unreadableNodeProcesses!==0||value.ambiguousProcesses.length||new Set(value.processes.map(item=>item.Role)).size!==value.processes.length||new Set(value.processes.map(item=>item.ProcessId)).size!==value.processes.length)return fail('PREFLIGHT_IDENTITY_UNKNOWN');
  return ok(freeze(value));
}

/** Own a fresh, fixed read-only observer; never rediscover or terminate a service by PID. */
export function createPanelPreflight(configuration,internalDependencies={}){
  let root,powershellPath,launch,queryTimeoutMs,cleanupTimeoutMs;
  try{
    if(!keys(configuration,['root','powershellPath'])||!plain(internalDependencies)||Reflect.ownKeys(internalDependencies).some(key=>!['spawn','queryTimeoutMs','cleanupTimeoutMs'].includes(key)))throw new Error();
    root=configuration.root;powershellPath=configuration.powershellPath;
    launch=internalDependencies.spawn??spawnChild;queryTimeoutMs=internalDependencies.queryTimeoutMs??PANEL_PREFLIGHT_LIMITS.queryTimeoutMs;cleanupTimeoutMs=internalDependencies.cleanupTimeoutMs??PANEL_PREFLIGHT_LIMITS.cleanupTimeoutMs;
    if(!absolute(root)||!absolute(powershellPath)||!['pwsh.exe','powershell.exe'].includes(path.win32.basename(powershellPath).toLowerCase())||typeof launch!=='function'||!Number.isSafeInteger(queryTimeoutMs)||queryTimeoutMs<1||queryTimeoutMs>PANEL_PREFLIGHT_LIMITS.queryTimeoutMs||!Number.isSafeInteger(cleanupTimeoutMs)||cleanupTimeoutMs<1||cleanupTimeoutMs>PANEL_PREFLIGHT_LIMITS.cleanupTimeoutMs)throw new Error();
  }catch{const error=new Error(messages.PREFLIGHT_CONFIG_INVALID);error.code='PREFLIGHT_CONFIG_INVALID';throw error;}
  const script=path.win32.join(root,'tools','Read-PanelSnapshot.ps1');
  let active=null,disposed=false,closing=null,last=null,sequence=0;
  const capture=c=>({generation:c.generation,queryPending:!c.settled,ownedChild:!c.closeSeen,exitObserved:c.exitSeen,closeObserved:c.closeSeen,exitCode:c.exitCode,stdoutBytes:c.stdoutBytes,stderrBytesDiscarded:c.stderrBytes,killRequests:c.killRequests,failureCode:c.reason});
  function settle(c,result){
    if(c.settled)return;c.settled=true;if(!result.ok)c.reason??=result.error.code;clearTimeout(c.queryTimer);clearTimeout(c.cleanupTimer);c.buffer=Buffer.alloc(0);last=capture(c);c.resolve(result);
    if(c.closeSeen&&active===c)active=null;
  }
  function kill(c){if(c.closeSeen)return;c.killRequests++;try{c.child.kill();}catch{/* Keep ownership and return explicit unconfirmed cleanup. */}}
  function poison(c,reason){
    if(c.closeSeen||c.settled)return;c.reason??=reason;
    if(!c.stopping){c.stopping=true;kill(c);}
    if(c.closeSeen){settle(c,fail(c.reason));return;}
    if(!c.cleanupTimer)c.cleanupTimer=setTimeout(()=>settle(c,fail(c.reason,true)),Math.max(0,Math.min(cleanupTimeoutMs,c.deadlineAt-performance.now())));
  }
  function observeClose(c,code){
    if(c.closeSeen)return;c.closeSeen=true;clearTimeout(c.queryTimer);clearTimeout(c.cleanupTimer);
    for(const waiter of c.waiters)waiter();c.waiters.clear();
    if(!c.settled){
      if(c.reason)settle(c,fail(c.reason));
      else if(!c.exitSeen||c.exitCode!==0||code!==0)settle(c,fail('PREFLIGHT_CHILD_FAILED'));
      else settle(c,parsePanelSnapshot(c.buffer.subarray(0,c.used),{root}));
    }
    c.buffer=Buffer.alloc(0);last=capture(c);if(active===c)active=null;
  }
  function read(c,stream,chunk){
    if(c.closeSeen)return;
    if(!Buffer.isBuffer(chunk)){poison(c,'PREFLIGHT_PIPE_FAILED');return;}
    if(stream==='stderr'){c.stderrBytes=Math.min(Number.MAX_SAFE_INTEGER,c.stderrBytes+chunk.length);if(c.stderrBytes>PANEL_PREFLIGHT_LIMITS.stderrBytes)poison(c,'PREFLIGHT_STDERR_LIMIT');return;}
    c.stdoutBytes=Math.min(Number.MAX_SAFE_INTEGER,c.stdoutBytes+chunk.length);
    if(c.stdoutBytes>PANEL_PREFLIGHT_LIMITS.stdoutBytes){poison(c,'PREFLIGHT_STDOUT_LIMIT');return;}
    if(c.reason||c.settled)return;chunk.copy(c.buffer,c.used);c.used+=chunk.length;
  }
  async function snapshot(){
    if(disposed)return fail('PREFLIGHT_CLOSED',Boolean(active&&!active.closeSeen));
    if(active)return fail(active.settled?'PREFLIGHT_CLEANUP_PENDING':'PREFLIGHT_BUSY',active.settled&&!active.closeSeen);
    const started=performance.now();let child;
    try{child=launch(powershellPath,['-NoLogo','-NoProfile','-NonInteractive','-File',script],{cwd:root,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});}
    catch{return fail('PREFLIGHT_SPAWN_FAILED');}
    const c={child,generation:++sequence,buffer:Buffer.alloc(PANEL_PREFLIGHT_LIMITS.stdoutBytes),used:0,stdoutBytes:0,stderrBytes:0,exitSeen:false,exitCode:null,closeSeen:false,reason:null,stopping:false,killRequests:0,settled:false,resolve:null,queryTimer:null,cleanupTimer:null,waiters:new Set(),deadlineAt:started+queryTimeoutMs};
    active=c;const result=new Promise(resolve=>{c.resolve=resolve;});
    child.on('error',()=>poison(c,'PREFLIGHT_SPAWN_FAILED'));
    child.on('exit',code=>{c.exitSeen=true;c.exitCode=Number.isInteger(code)?code:null;if(code!==0)poison(c,'PREFLIGHT_CHILD_FAILED');});
    child.on('close',code=>observeClose(c,code));
    for(const stream of ['stdin','stdout','stderr']){const pipe=child[stream];if(!pipe||typeof pipe.on!=='function'){poison(c,'PREFLIGHT_PIPE_FAILED');continue;}pipe.on('error',()=>poison(c,'PREFLIGHT_PIPE_FAILED'));}
    child.stdout?.on('data',chunk=>read(c,'stdout',chunk));child.stderr?.on('data',chunk=>read(c,'stderr',chunk));
    if(!c.settled)c.queryTimer=setTimeout(()=>{c.reason??='PREFLIGHT_TIMEOUT';if(!c.stopping){c.stopping=true;kill(c);}if(!c.settled)settle(c,fail(c.reason,!c.closeSeen));},Math.max(0,c.deadlineAt-performance.now()));
    if(!c.reason&&!c.closeSeen){try{if(performance.now()>=c.deadlineAt){poison(c,'PREFLIGHT_TIMEOUT');}else{if(!child.stdin?.writable)throw new Error();child.stdin.write(JSON.stringify({schemaVersion:1,root})+'\n',error=>{if(error)poison(c,'PREFLIGHT_PIPE_FAILED');});child.stdin.end();}}catch{poison(c,'PREFLIGHT_PIPE_FAILED');}}
    return result;
  }
  function waitClose(c){
    if(c.closeSeen)return Promise.resolve();
    return new Promise(resolve=>{const finish=()=>{clearTimeout(timer);c.waiters.delete(finish);resolve();};const timer=setTimeout(finish,cleanupTimeoutMs);c.waiters.add(finish);});
  }
  async function close(){
    disposed=true;if(closing)return closing;if(!active)return ok({closed:true});const c=active;
    closing=(async()=>{if(!c.settled)poison(c,'PREFLIGHT_CLOSED');else kill(c);await waitClose(c);if(!c.closeSeen)return fail('PREFLIGHT_CLEANUP_PENDING',true);return ok({closed:true});})();
    try{return await closing;}finally{closing=null;}
  }
  return Object.freeze({snapshot,close,diagnostics:()=>({state:disposed?(active?'cleanup_pending':'closed'):active?(active.settled?'cleanup_pending':'running'):'idle',...(active?capture(active):last??{ownedChild:false,queryPending:false}),queryTimeoutMs,cleanupTimeoutMs})});
}
