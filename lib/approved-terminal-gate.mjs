import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {spawn as spawnProcess} from 'node:child_process';

// A scoped command gateway, not an OS sandbox or an adapter for Codex's native
// shell. The host owns process-family isolation, UI authentication, trusted
// scope generation and scope-change notifications. All terminal access must
// route through this owner before it can enforce a per-command approval rule.
const id=s=>typeof s==='string'&&s.length>0&&s.length<=200&&!/[\x00-\x1f\x7f]/.test(s);
const absolute=s=>typeof s==='string'&&s.length>0&&s.length<=4096&&!s.includes('\0')&&(path.win32.isAbsolute(s)||path.posix.isAbsolute(s));
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&(Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
const data=x=>plain(x)&&Object.values(Object.getOwnPropertyDescriptors(x)).every(d=>Object.hasOwn(d,'value'));
const keys=['userId','sessionId','threadId','turnId','generation','revision'];
const validScope=s=>data(s)&&keys.every(k=>Object.hasOwn(s,k))&&keys.slice(0,4).every(k=>id(s[k]))&&Number.isSafeInteger(s.generation)&&s.generation>0&&Number.isSafeInteger(s.revision)&&s.revision>=0;
const same=(a,b)=>validScope(a)&&validScope(b)&&keys.every(k=>a[k]===b[k]);
const frozenScope=s=>Object.freeze(Object.fromEntries(keys.map(k=>[k,s[k]])));
const fail=code=>({ok:false,error:{code}});
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function createTerminalGate({currentScope,spawn,approvalTimeoutMs=60000,executionTimeoutMs=30000,cleanupWaitMs=1000,maxOutputBytes=65536,maxJobs=32,maxRequests=4096}={}){
  if(typeof currentScope!=='function'||typeof spawn!=='function'||![approvalTimeoutMs,executionTimeoutMs].every(x=>Number.isSafeInteger(x)&&x>0&&x<=120000)||
    !Number.isSafeInteger(cleanupWaitMs)||cleanupWaitMs<1||cleanupWaitMs>5000||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>1024*1024||!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>128||!Number.isSafeInteger(maxRequests)||maxRequests<maxJobs||maxRequests>65536)throw new Error('Invalid terminal gate configuration');
  const jobs=new Map(),requests=new Set();let closed=false;
  const current=s=>{try{return same(s,currentScope());}catch{return false;}};
  const view=j=>({approvalId:j.id,digest:j.digest,state:j.state,outcome:j.outcome,reason:j.reason,output:j.output?{...j.output}:null,cleanupPending:Boolean(j.child&&!j.childClosed)});
  function propose({scope,requestId,executable,args,cwd}={}){
    if(closed)return fail('GATE_CLOSED');
    if(!current(scope)||!id(requestId)||!absolute(executable)||!absolute(cwd)||!Array.isArray(args)||args.length>128||
      args.some(x=>typeof x!=='string'||x.includes('\0')||Buffer.byteLength(x)>16384)||Buffer.byteLength(JSON.stringify(args))>65536)return fail('REQUEST_INVALID');
    const requestKey=JSON.stringify([scope.generation,scope.revision,scope.userId,scope.sessionId,scope.threadId,scope.turnId,requestId]);
    if(requests.has(requestKey))return fail('DUPLICATE_REQUEST');
    if(jobs.size>=maxJobs)return fail('CAPACITY');
    if(requests.size>=maxRequests)return fail('REQUEST_HISTORY_FULL');
    const snapshot=Object.freeze({executable,args:Object.freeze([...args]),cwd});
    const scopeCopy=frozenScope(scope),job={id:randomUUID(),scope:scopeCopy,requestKey,snapshot,digest:digest(snapshot),state:'pending',outcome:'not_started',reason:null,child:null,childClosed:false,output:null,timer:null,expiresAt:performance.now()+approvalTimeoutMs,waiters:new Set()};
    requests.add(requestKey);jobs.set(job.id,job);
    job.timer=setTimeout(()=>{if(job.state==='pending'){job.state='expired';job.reason='approval_timeout';}},approvalTimeoutMs);job.timer.unref?.();
    return {ok:true,value:{approvalId:job.id,digest:job.digest,command:{executable:snapshot.executable,args:[...snapshot.args],cwd:snapshot.cwd},scope:scopeCopy}};
  }
  function kill(j){if(!j.child||j.childClosed)return;try{j.child.kill();}catch{/* Retain the exact handle for a later cleanup attempt. */}}
  function interrupt(j,reason){
    if(j.state==='pending'){clearTimeout(j.timer);j.state='cancelled';j.reason=reason;return;}
    if(j.state==='running'){clearTimeout(j.timer);j.state='cleaning';j.outcome='unknown';j.reason=reason;kill(j);}
    else if(j.state==='cleaning')kill(j);
  }
  function respond({scope,approvalId,decision,expectedDigest}={}){
    const j=jobs.get(approvalId);if(!j)return fail('NOT_FOUND');
    if(!same(scope,j.scope)||!current(j.scope))return fail('SCOPE_CHANGED');
    if(j.state!=='pending')return fail('ALREADY_SETTLED');
    // Timers can be delayed by a busy event loop. The deadline, not callback
    // ordering, decides whether a late approval is still admissible.
    if(performance.now()>=j.expiresAt){clearTimeout(j.timer);j.state='expired';j.reason='approval_timeout';return fail('ALREADY_SETTLED');}
    if(!['accept','decline'].includes(decision)||expectedDigest!==j.digest||digest(j.snapshot)!==j.digest)return fail('APPROVAL_INVALID');
    clearTimeout(j.timer);
    if(decision==='decline'){j.state='declined';j.reason='user_declined';return {ok:true,value:view(j)};}
    // Claim before executor invocation. A synchronous exception or an
    // unobservable launch is unknown, and this approval cannot be replayed.
    j.state='starting';j.outcome='unknown';
    let child;
    try{child=spawn(j.snapshot.executable,[...j.snapshot.args],{cwd:j.snapshot.cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}
    catch{j.state='unknown';j.reason='executor_failed';return fail('EXECUTION_UNKNOWN');}
    if(!child||typeof child.on!=='function'||typeof child.kill!=='function'||!child.stdout||typeof child.stdout.on!=='function'||!child.stderr||typeof child.stderr.on!=='function'){
      j.state='unknown';j.reason='executor_invalid';if(child&&typeof child.kill==='function'){
        j.child=child;
        if(typeof child.on==='function')child.on('close',()=>{j.childClosed=true;for(const wake of j.waiters)wake();j.waiters.clear();});
        kill(j);
      }return fail('EXECUTION_UNKNOWN');
    }
    j.child=child;j.state='running';let used=0,stdout=[],stderr=[];
    const append=(where,chunk)=>{
      if(j.state!=='running')return;
      let bytes;try{bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);}catch{interrupt(j,'output_invalid');return;}
      if(bytes.length>maxOutputBytes-used){interrupt(j,'output_limit');return;}
      used+=bytes.length;where.push(Buffer.from(bytes));
    };
    child.stdout.on('data',chunk=>append(stdout,chunk));child.stderr.on('data',chunk=>append(stderr,chunk));
    child.stdout.on('error',()=>interrupt(j,'output_error'));child.stderr.on('error',()=>interrupt(j,'output_error'));
    child.on('error',()=>interrupt(j,'process_error'));
    child.on('close',(code,signal)=>{
      if(j.childClosed)return;j.childClosed=true;clearTimeout(j.timer);
      if(j.state==='running'&&Number.isInteger(code)&&signal==null){j.state='completed';j.outcome='completed';j.reason=null;j.exitCode=code;j.output={stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),exitCode:code};}
      else{j.state='unknown';j.outcome='unknown';j.reason??='process_interrupted';}
      stdout=[];stderr=[];for(const wake of j.waiters)wake();j.waiters.clear();
    });
    j.timer=setTimeout(()=>interrupt(j,'execution_timeout'),executionTimeoutMs);j.timer.unref?.();
    // A synchronous scope change during launch is not permission to continue.
    if(!current(j.scope))interrupt(j,'scope_changed');
    return {ok:true,value:view(j)};
  }
  function cancel({scope,approvalId}={}){
    const j=jobs.get(approvalId);if(!j)return fail('NOT_FOUND');
    if(!same(scope,j.scope)||!current(j.scope))return fail('SCOPE_CHANGED');
    interrupt(j,'cancelled');return {ok:true,value:view(j)};
  }
  function invalidate(){for(const j of jobs.values())if(!current(j.scope))interrupt(j,'scope_changed');}
  function status({scope,approvalId}={}){const j=jobs.get(approvalId);if(!j)return fail('NOT_FOUND');if(!same(scope,j.scope)||!current(j.scope))return fail('SCOPE_CHANGED');return {ok:true,value:view(j)};}
  // A result can be discarded only after it has settled and no owned child is
  // left unobserved. Keep the request key to deny replay after its release.
  function release({scope,approvalId}={}){
    const j=jobs.get(approvalId);if(!j)return fail('NOT_FOUND');
    if(!same(scope,j.scope)||!current(j.scope))return fail('SCOPE_CHANGED');
    if(['pending','starting','running','cleaning'].includes(j.state)||(j.child&&!j.childClosed))return fail('NOT_SETTLED');
    jobs.delete(approvalId);return {ok:true};
  }
  async function retryCleanup(approvalId){
    const j=jobs.get(approvalId);if(!j)return fail('NOT_FOUND');
    if(!j.child||j.childClosed)return {ok:true,value:view(j)};
    interrupt(j,'cleanup_retry');if(j.childClosed)return {ok:true,value:view(j)};
    await new Promise(resolve=>{let timer;const wake=()=>{clearTimeout(timer);j.waiters.delete(wake);resolve();};j.waiters.add(wake);timer=setTimeout(wake,cleanupWaitMs);});
    return j.childClosed?{ok:true,value:view(j)}:fail('CLEANUP_PENDING');
  }
  async function close(){closed=true;for(const j of jobs.values())interrupt(j,'gate_closed');const results=await Promise.all([...jobs.values()].filter(j=>j.child&&!j.childClosed).map(j=>retryCleanup(j.id)));return results.every(x=>x.ok)?{ok:true}:fail('CLEANUP_PENDING');}
  return Object.freeze({propose,respond,cancel,invalidate,status,release,retryCleanup,close});
}

// Callers cannot substitute an executor. The gate spawns only after an exact
// scoped decision. Children spawned by the command are not independently
// intercepted and need OS-level process ownership and enforcement elsewhere.
export function createApprovedTerminal({currentScope,approvalTimeoutMs,executionTimeoutMs,cleanupWaitMs,maxOutputBytes,maxJobs,maxRequests}={}){
  return createTerminalGate({currentScope,spawn:spawnProcess,approvalTimeoutMs,executionTimeoutMs,cleanupWaitMs,maxOutputBytes,maxJobs,maxRequests});
}
