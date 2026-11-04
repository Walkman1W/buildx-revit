import {createHash} from 'node:crypto';
import {createApprovedTerminal} from './approved-terminal-gate.mjs';

// Opt-in composition component only. The panel must provide a trusted
// isCurrent closure and hold the sole decision channel; this is not an OS
// sandbox and does not intercept native Codex shell or Revit scripts.
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const data=v=>plain(v)&&Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>Object.hasOwn(d,'value'));
const exact=(v,keys)=>data(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const text=(v,max=200)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const outcome=(success,message)=>({success,contentItems:[{type:'inputText',text:message}]});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function createDynamicTerminalOwner({approvalTimeoutMs=60000,executionTimeoutMs=30000,maxEntries=32,maxHistory=4096}={}){
  if(!Number.isSafeInteger(approvalTimeoutMs)||approvalTimeoutMs<1||approvalTimeoutMs>120000||!Number.isSafeInteger(executionTimeoutMs)||executionTimeoutMs<1||executionTimeoutMs>120000||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>128||!Number.isSafeInteger(maxHistory)||maxHistory<maxEntries||maxHistory>65536)throw new TypeError('Invalid terminal owner configuration');
  const entries=new Map(),seen=new Set();let closing=false;
  const current=entry=>{try{return !closing&&entry.isCurrent()===true;}catch{return false;}};
  async function retire(entry){
    clearTimeout(entry.timer);
    const result=await entry.gate.close();
    if(result.ok)entries.delete(entry.ticket);
    return result.ok;
  }
  function propose({params,scope,isCurrent}={}){
    if(closing||entries.size>=maxEntries||seen.size>=maxHistory||typeof isCurrent!=='function'||isCurrent()!==true)throw new Error('Terminal request unavailable');
    if(!exact(params,['threadId','turnId','callId','tool','arguments'])||params.tool!=='buildx_terminal'||!text(params.threadId)||!text(params.turnId)||!text(params.callId)||
      !exact(params.arguments,['executable','args','cwd'])||!exact(scope,['client','conversationId','threadId','turnId','generation','revision','account'])||
      !['client','conversationId','threadId','turnId'].every(k=>text(scope[k]))||!Number.isSafeInteger(scope.generation)||scope.generation<1||!Number.isSafeInteger(scope.revision)||scope.revision<0||
      scope.threadId!==params.threadId||scope.turnId!==params.turnId)throw new Error('Terminal request invalid');
    const account=scope.account;
    if(account!==null&&(!exact(account,['scope','sessionId','userId','generation'])||account.scope!=='model'||!text(account.sessionId)||!text(account.userId)||!Number.isSafeInteger(account.generation)||account.generation<1))throw new Error('Terminal scope invalid');
    const args=params.arguments;
    if(typeof args.executable!=='string'||typeof args.cwd!=='string'||!Array.isArray(args.args))throw new Error('Terminal request invalid');
    let rendered;try{rendered=JSON.stringify(args.args);}catch{throw new Error('Terminal arguments invalid');}
    if(typeof rendered!=='string'||rendered.length>65536)throw new Error('Terminal arguments too large');
    // The unverified local mode is intentionally identified as such. The
    // caller's isCurrent owns the actual session/account checks.
    const scopeKey=[scope.client,scope.conversationId,scope.threadId,scope.turnId,scope.generation,scope.revision,account&&[account.scope,account.sessionId,account.userId,account.generation]];
    const requestKey=hash([scopeKey,params.callId]);if(seen.has(requestKey))throw new Error('Duplicate terminal request');
    const gateScope=Object.freeze({userId:account?'account-'+hash(scopeKey[6]):'local-unverified',sessionId:hash(scopeKey.slice(0,2)),threadId:scope.threadId,turnId:scope.turnId,generation:scope.generation,revision:scope.revision});
    const entry={isCurrent,gate:null,ticket:null,timer:null};
    // Bound raw output so JSON escaping cannot exceed the Codex response limit.
    entry.gate=createApprovedTerminal({currentScope:()=>current(entry)?gateScope:null,approvalTimeoutMs,executionTimeoutMs,maxOutputBytes:8192,maxJobs:1,maxRequests:1});
    const proposed=entry.gate.propose({scope:gateScope,requestId:params.callId,executable:args.executable,args:args.args,cwd:args.cwd});
    if(!proposed.ok)throw new Error('Terminal request invalid');
    const {approvalId,digest,command}=proposed.value;
    entry.ticket=approvalId;entry.digest=digest;entry.scope=gateScope;entry.used=false;entry.cancelled=false;
    seen.add(requestKey);entries.set(approvalId,entry);
    const deadline=Date.now()+approvalTimeoutMs;
    entry.timer=setTimeout(()=>{void cancel({ticket:approvalId});},approvalTimeoutMs);entry.timer.unref?.();
    return Object.freeze({ticket:approvalId,digest,kind:'terminal',action:command.executable,target:command.executable,cwd:command.cwd,source:'Codex',parameters:JSON.stringify(command.args),deadline});
  }
  async function decide({ticket,digest,decision}={}){
    const entry=entries.get(ticket);
    if(!entry||entry.used||entry.cancelled||!current(entry)||digest!==entry.digest||!['accept','decline'].includes(decision))throw new Error('Terminal approval unavailable');
    entry.used=true;clearTimeout(entry.timer);
    const response=entry.gate.respond({scope:entry.scope,approvalId:ticket,expectedDigest:digest,decision});
    if(!response.ok){await retire(entry);throw new Error('Terminal outcome unknown');}
    if(decision==='decline'){await retire(entry);return outcome(false,'用户拒绝了此终端操作。');}
    for(;;){
      if(!current(entry)||entry.cancelled){entry.gate.invalidate();await retire(entry);throw new Error('Terminal outcome unknown');}
      const result=entry.gate.status({scope:entry.scope,approvalId:ticket});
      if(!result.ok){await retire(entry);throw new Error('Terminal outcome unknown');}
      if(result.value.state==='completed'){
        const output=result.value.output,ok=output.exitCode===0;
        if(!await retire(entry))throw new Error('Terminal cleanup pending');
        return outcome(ok,JSON.stringify(output));
      }
      if(result.value.state==='unknown'||result.value.state==='cleaning'){
        await retire(entry);throw new Error('Terminal outcome unknown');
      }
      await delay(25);
    }
  }
  async function cancel({ticket}={}){
    const entry=entries.get(ticket);if(!entry)return false;
    entry.cancelled=true;
    if(current(entry))entry.gate.cancel({scope:entry.scope,approvalId:ticket});else entry.gate.invalidate();
    return retire(entry);
  }
  async function close(){
    closing=true;const results=await Promise.all([...entries.values()].map(entry=>{entry.cancelled=true;return retire(entry);}));
    return {closed:results.every(Boolean)&&entries.size===0};
  }
  return Object.freeze({propose,decide,cancel,close});
}
