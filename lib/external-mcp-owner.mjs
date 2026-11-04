import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {open,realpath,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';

// This is NOT an OS sandbox. A selected executable can access files, network,
// credentials and model services under the user's operating-system authority.
// Do not expose this owner until real user approval and durable receipts are
// supplied by the trusted application composition.
const LIMITS=Object.freeze({args:32,argBytes:8192,executableBytes:256*1024*1024,jsonBytes:32768,outputBytes:65536,tools:40,proposals:1,receipts:64,startMs:10000,callMs:30000,closeMs:5000});
const fail=(code,outcome='not_started')=>({ok:false,code,outcome});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fileId=s=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
const sameFile=(a,b)=>a.isFile()&&b.isFile()&&fileId(a)===fileId(b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs;

// Copy only finite JSON data properties, rejecting accessors and cycles. Sorting
// keys once makes the approved digest bind the same snapshot sent to the MCP.
export function snapshotExternalMcpData(value,limit=LIMITS.jsonBytes){
  let nodes=0;const seen=new Set();
  function clone(x,depth){
    if(++nodes>4096||depth>24)throw new Error('JSON limit');
    if(x===null||typeof x==='boolean'||typeof x==='string')return x;
    if(typeof x==='number'&&Number.isFinite(x))return x;
    if(!x||typeof x!=='object'||seen.has(x)||!Array.isArray(x)&&!plain(x))throw new Error('invalid JSON');
    const descriptors=Object.getOwnPropertyDescriptors(x);
    if(Reflect.ownKeys(descriptors).some(k=>typeof k!=='string'||!Object.hasOwn(descriptors[k],'value')))throw new Error('invalid JSON');
    seen.add(x);let out;
    if(Array.isArray(x)){if(Object.keys(x).length!==x.length)throw new Error('invalid array');out=x.map(v=>clone(v,depth+1));}
    else{out=Object.create(null);for(const key of Object.keys(x).sort())out[key]=clone(descriptors[key].value,depth+1);}
    seen.delete(x);return out;
  }
  const json=JSON.stringify(clone(value,0));if(Buffer.byteLength(json)>limit)throw new Error('JSON limit');
  return {value:JSON.parse(json),digest:sha(json)};
}
const snapshot=snapshotExternalMcpData;
function frozenOwner(value,methods){
  if(!plain(value)||!Object.isFrozen(value))return false;
  return methods.every(name=>{const d=Object.getOwnPropertyDescriptor(value,name);return d&&Object.hasOwn(d,'value')&&typeof d.value==='function';});
}
function explicitRedaction(value,pointers){
  if(!Array.isArray(pointers)||pointers.length>64||pointers.some(x=>typeof x!=='string'||x.length>1024||x!==''&&!x.startsWith('/'))||new Set(pointers).size!==pointers.length)throw new Error('invalid sensitive paths');
  const original=snapshot(value).value;let redacted=snapshot(value).value;const secrets=[];
  // The first implementation accepts only non-empty strings at explicitly
  // marked pointers. Other JSON shapes need typed, unambiguous redaction;
  // treating numbers, null, arrays or objects as already masked would leak.
  function collect(x){if(typeof x!=='string'||!x)throw new Error('unsupported sensitive value');secrets.push(x);}
  for(const pointer of pointers){
    const parts=pointer===''?[]:pointer.slice(1).split('/').map(part=>{if(/~(?![01])/.test(part))throw new Error('invalid pointer');return part.replace(/~1/g,'/').replace(/~0/g,'~');});
    let target=original,copy=redacted;
    if(!parts.length){collect(target);redacted='[REDACTED]';continue;}
    for(let i=0;i<parts.length;i++){
      const key=parts[i];if(!target||typeof target!=='object'||!Object.hasOwn(target,key))throw new Error('unknown sensitive path');
      if(i===parts.length-1){collect(target[key]);if(copy&&typeof copy==='object'&&Object.hasOwn(copy,key))copy[key]='[REDACTED]';}
      else{target=target[key];copy=copy&&typeof copy==='object'?copy[key]:null;}
    }
  }
  return {value:redacted,secrets};
}
function redactOutput(value,secrets){
  if(typeof value==='string'){let out=value;for(const secret of secrets){
    if(process.platform==='win32')out=out.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),()=> '[REDACTED]');
    else out=out.split(secret).join('[REDACTED]');
  }return out;}
  if(value===null||typeof value==='number'||typeof value==='boolean'){
    const scalar=String(value);if(secrets.some(secret=>process.platform==='win32'?scalar.toLowerCase().includes(secret.toLowerCase()):scalar.includes(secret)))return '[REDACTED]';
    return value;
  }
  if(Array.isArray(value))return value.map(item=>redactOutput(item,secrets));
  if(value&&typeof value==='object'){
    const result=Object.create(null);
    for(const [key,item] of Object.entries(value)){const masked=redactOutput(key,secrets);if(Object.hasOwn(result,masked))throw new Error('redacted keys collide');result[masked]=redactOutput(item,secrets);}
    return result;
  }
  return value;
}
async function executableSnapshot(command){
  const resolved=await realpath(command),named=await lstat(resolved,{bigint:true});
  if(!named.isFile()||named.isSymbolicLink()||named.ino===0n||named.size<1n||named.size>BigInt(LIMITS.executableBytes))throw new Error('invalid executable');
  const handle=await open(resolved,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const initial=await handle.stat({bigint:true});if(!sameFile(named,initial))throw new Error('changed executable');
    const digest=createHash('sha256'),buffer=Buffer.alloc(64*1024);let position=0;
    while(true){const part=await handle.read(buffer,0,buffer.length,position);if(!part.bytesRead)break;position+=part.bytesRead;if(position>LIMITS.executableBytes)throw new Error('executable limit');digest.update(buffer.subarray(0,part.bytesRead));}
    const after=await handle.stat({bigint:true}),current=await lstat(resolved,{bigint:true});
    if(!sameFile(initial,after)||!sameFile(after,current)||BigInt(position)!==after.size)throw new Error('changed executable');
    return {path:resolved,identity:fileId(after),sha256:digest.digest('hex')};
  }finally{await handle.close();}
}
function minimalEnvironment(defaultNames){
  // SDK merges defaults even when explicit env is supplied. Clear *all*
  // defaults; only the Windows system root is needed to launch executables.
  const result=Object.fromEntries(defaultNames.map(name=>[name,'']));
  if(process.platform==='win32'){
    const root=process.env.SystemRoot??process.env.SYSTEMROOT;
    if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('system root unavailable');
    result.SYSTEMROOT=root;result.WINDIR=root;
  }
  return result;
}
function boundedWait(promise,ms){return new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),ms);Promise.resolve(promise).then(()=>{clearTimeout(timer);resolve(true);},()=>{clearTimeout(timer);resolve(false);});});}

/**
 * Trusted composition must bind approvalOwner.consume to a real, one-use human
 * approval for the exact proposal and current account/connection; the caller's
 * JSON must never be allowed to provide this callback. receiptOwner must durably
 * persist attempts/outcomes before returning true. No environment or credentials
 * can be configured in this initial version.
 */
export function createExternalMcpOwner({command,args=[],sensitiveArgumentIndexes=[],cwd,approvalOwner,receiptOwner,executionGuard=null,launchLease=null}={}){
  if(typeof command!=='string'||!path.isAbsolute(command)||command.includes('\0')||process.platform==='win32'&&path.extname(command).toLowerCase()!=='.exe'||
     typeof cwd!=='string'||!path.isAbsolute(cwd)||cwd.includes('\0')||!Array.isArray(args)||args.length>LIMITS.args||
     args.some(arg=>typeof arg!=='string'||arg.includes('\0'))||Buffer.byteLength(JSON.stringify(args))>LIMITS.argBytes||!Array.isArray(sensitiveArgumentIndexes)||
     sensitiveArgumentIndexes.some(i=>!Number.isSafeInteger(i)||i<0||i>=args.length)||new Set(sensitiveArgumentIndexes).size!==sensitiveArgumentIndexes.length||
     !frozenOwner(approvalOwner,['consume'])||!frozenOwner(receiptOwner,['ready','recordAttempt','recordOutcome'])||executionGuard!==null&&!frozenOwner(executionGuard,['createTransport'])||launchLease!==null&&!frozenOwner(launchLease,['current']))throw new TypeError('Invalid external MCP owner composition');
  const selectedArgs=Object.freeze([...args]),sensitiveArgs=new Set(sensitiveArgumentIndexes),serverId=randomUUID(),digestKey=randomBytes(32),state={phase:'new',generation:randomUUID(),launch:null,serverEvidence:null,tools:new Map(),proposal:null,receipt:null,unknown:false,closeRequested:false,closePromise:null,client:null,transport:null,unstarted:null,disposePromise:null,closedSignal:null,childClosed:false,catalogChanged:false,callDone:null};
  const eligible=()=>{try{return launchLease===null||launchLease.current()===true;}catch{return false;}};
  const startupSecrets=selectedArgs.filter((_,index)=>sensitiveArgs.has(index)).filter(Boolean);
  const containsSecrets=(value,secretValues)=>{
    const fold=s=>process.platform==='win32'?s.toLowerCase():s;
    const secrets=secretValues.map(fold);
    const seen=new Set();
    const visit=x=>{
      if(typeof x==='string')return secrets.some(secret=>fold(x).includes(secret));
      if(x===null||typeof x==='number'||typeof x==='boolean')return secrets.some(secret=>fold(String(x)).includes(secret));
      if(!x||typeof x!=='object')return false;
      if(seen.has(x))throw new Error('invalid value');seen.add(x);
      const found=Object.entries(x).some(([key,item])=>visit(key)||visit(item));seen.delete(x);return found;
    };
    return visit(value);
  };
  const containsStartupSecret=value=>containsSecrets(value,startupSecrets);
  const discloseSafe=(commandPath,directory)=>{
    const fold=s=>process.platform==='win32'?s.toLowerCase():s;
    const visible=[commandPath,directory,...selectedArgs.filter((_,index)=>!sensitiveArgs.has(index))].map(fold);
    return [...sensitiveArgs].every(index=>!selectedArgs[index]||visible.every(value=>!value.includes(fold(selectedArgs[index]))));
  };
  const copy=value=>JSON.parse(JSON.stringify(value));
  const view=()=>({serverId,generation:state.generation,phase:state.phase,unknown:state.unknown,receipt:state.receipt?copy(state.receipt):null});
  async function disposeUnstarted(){
    if(!state.unstarted)return true;
    const descriptor=Object.getOwnPropertyDescriptor(executionGuard,'disposeUnstarted');
    if(!descriptor||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function')return false;
    if(!state.disposePromise){
      const raw=state.unstarted;
      const pending=Promise.resolve().then(()=>descriptor.value.call(executionGuard,{transport:raw})).then(value=>{
        if(value!==true)throw new Error('unstarted cleanup unconfirmed');
        if(state.unstarted===raw)state.unstarted=null;
      });
      state.disposePromise=pending;
      pending.then(()=>{if(state.disposePromise===pending)state.disposePromise=null;},()=>{if(state.disposePromise===pending)state.disposePromise=null;});
    }
    return await boundedWait(state.disposePromise,LIMITS.closeMs)&&!state.unstarted;
  }
  async function close(){
    if(['new','preparing','prepared','authorizing'].includes(state.phase)&&!state.client&&!state.unstarted){state.closeRequested=true;state.phase='closed';return {ok:true,cleanup:'not_started',view:view()};}
    if(state.phase==='closed')return {ok:true,cleanup:'confirmed',view:view()};
    if(state.closePromise)return state.closePromise;
    state.closeRequested=true;state.proposal=null;
    if(state.phase==='starting')return fail('START_IN_PROGRESS','unknown');
    state.phase='closing';
    const attempt=(async()=>{
      if(state.unstarted){
        if(!await disposeUnstarted()){state.phase='cleanup_pending';return fail('CLEANUP_UNCONFIRMED','unknown');}
        if(!state.client){state.phase='closed';return {ok:true,cleanup:'confirmed',view:view()};}
      }
      const done=await boundedWait(Promise.resolve().then(()=>state.client?.close()),LIMITS.closeMs);
      const closed=state.closedSignal?await boundedWait(state.closedSignal,LIMITS.closeMs):false;
      if(!state.client){state.phase='closed';return {ok:true,cleanup:'confirmed',view:view()};}
      const callFinished=state.callDone?await boundedWait(state.callDone,LIMITS.closeMs):true;
      if(!done||!closed||!callFinished){state.phase='cleanup_pending';return fail('CLEANUP_UNCONFIRMED','unknown');}
      state.phase='closed';return {ok:true,cleanup:'confirmed',view:view()};
    })();state.closePromise=attempt;
    try{return await attempt;}finally{state.closePromise=null;}
  }
  return Object.freeze({
    view,
    async launchProposal(){
      if(state.phase!=='new')return fail('INVALID_STATE');
      if(!eligible())return fail('CONFIGURATION_REVOKED');
      state.phase='preparing';
      try{
        const executable=await executableSnapshot(command),directory=await realpath(cwd),d=await lstat(directory,{bigint:true});
        if(state.closeRequested)return fail('CANCELLED_BEFORE_START');
        if(!eligible()){state.phase='new';return fail('CONFIGURATION_REVOKED');}
        if(!d.isDirectory()||d.isSymbolicLink()||d.ino===0n)throw new Error('invalid cwd');
        if(!discloseSafe(executable.path,directory))throw new Error('unsafe disclosure');
        const proposal={proposalId:randomUUID(),serverId,generation:state.generation,command:executable.path,args:selectedArgs.map((arg,index)=>sensitiveArgs.has(index)?'[REDACTED]':arg),sensitiveArgumentIndexes:[...sensitiveArgs],cwd:directory,executableSha256:executable.sha256};
        state.launch={proposal,executable,cwdIdentity:fileId(d)};state.phase='prepared';return {ok:true,proposal:copy(proposal)};
      }catch{if(state.closeRequested)return fail('CANCELLED_BEFORE_START');state.phase='new';return fail('EXECUTABLE_UNAVAILABLE');}
    },
    async start({proposalId,approvalId}={}){
      if(state.phase!=='prepared'||!state.launch||state.launch.proposal.proposalId!==proposalId)return fail('PROPOSAL_INVALID');
      if(!eligible())return fail('CONFIGURATION_REVOKED');
      // Hashing then spawning by path has a replacement/write race. A trusted
      // platform owner must itself launch from within its proven guard; there
      // is no direct StdioClientTransport spawn or default guard in production.
      if(!executionGuard)return fail('EXECUTABLE_IDENTITY_UNVERIFIED');
      // A server can itself have side effects on startup. Never start a new
      // one while the account's earlier dispatch outcome is unresolved, or
      // while the durable receipt owner/root cannot be verified.
      state.phase='checking_receipts';let ready;
      try{ready=await receiptOwner.ready();}catch{ready=null;}
      if(state.closeRequested){state.phase='closed';return fail('CANCELLED_BEFORE_START');}
      if(!eligible()){state.phase='prepared';return fail('CONFIGURATION_REVOKED');}
      if(!ready||ready.ok!==true||!Array.isArray(ready.unresolved)||ready.unresolved.length){state.phase='prepared';return fail('RECEIPT_RECOVERY_REQUIRED');}
      state.phase='authorizing';const selected=state.launch;
      try{if(await approvalOwner.consume({approvalId,kind:'mcp_start',proposal:copy(selected.proposal)})!==true){if(!state.closeRequested)state.phase='prepared';return fail('EXECUTION_APPROVAL_REQUIRED');}}
      catch{if(!state.closeRequested)state.phase='prepared';return fail('EXECUTION_APPROVAL_REQUIRED');}
      if(state.closeRequested){state.phase='closed';return fail('CANCELLED_BEFORE_START');}
      if(!eligible()){state.phase='prepared';return fail('CONFIGURATION_REVOKED');}
      state.phase='starting';let preparedRuntime=false;
      try{
        const current=await executableSnapshot(selected.executable.path),directory=await lstat(selected.proposal.cwd,{bigint:true});
        if(current.identity!==selected.executable.identity||current.sha256!==selected.executable.sha256||fileId(directory)!==selected.cwdIdentity||!directory.isDirectory())throw new Error('launch identity changed');
        // Dependencies are deliberately lazy: the existing BuildX service must
        // still start normally when the optional MCP runtime is not installed.
        const [{Client},{StdioClientTransport,DEFAULT_INHERITED_ENV_VARS},{default:Ajv2020}]=await Promise.all([
          import('@modelcontextprotocol/client'),import('@modelcontextprotocol/client/stdio'),import('ajv/dist/2020.js')]);
        preparedRuntime=true;
        if(state.closeRequested){state.phase='closed';return fail('CANCELLED_BEFORE_START');}
        if(!eligible()){state.phase='prepared';return fail('CONFIGURATION_REVOKED');}
        const ajv=new Ajv2020({strict:true,allErrors:false,validateSchema:true});
        // createTransport must not itself spawn; its start() owns the atomic
        // guarded spawn and its onclose must represent confirmed process/pipe
        // closure. The guard is a trusted host dependency, never request data.
        const raw=await executionGuard.createTransport({command:selected.executable.path,args:[...selectedArgs],cwd:selected.proposal.cwd,executableIdentity:current.identity,executableSha256:current.sha256,cwdIdentity:selected.cwdIdentity,environment:minimalEnvironment(DEFAULT_INHERITED_ENV_VARS),maxBufferSize:LIMITS.outputBytes,StdioClientTransport});
        if(raw&&typeof raw==='object')state.unstarted=raw;
        if(!raw||typeof raw.start!=='function'||typeof raw.send!=='function'||typeof raw.close!=='function')throw new Error('guard transport unavailable');
        if(state.closeRequested||!eligible()){
          const cancelled=state.closeRequested;
          if(!await disposeUnstarted()){state.phase='cleanup_pending';return fail('CLEANUP_UNCONFIRMED','unknown');}
          state.phase=cancelled?'closed':'prepared';return fail(cancelled?'CANCELLED_BEFORE_START':'CONFIGURATION_REVOKED');
        }
        let observeClose;state.closedSignal=new Promise(resolve=>{observeClose=resolve;});
        // Wrap only the public Transport interface; SDK close() by itself is
        // not proof of child close. The public onclose fires on child 'close'.
        const transport={onclose:null,onerror:null,onmessage:null,start:()=>{if(!eligible())throw new Error('configuration revoked');return raw.start();},send:(...a)=>raw.send(...a),close:()=>raw.close()};
        raw.onclose=()=>{state.childClosed=true;observeClose();if(!state.closeRequested){state.proposal=null;if(state.phase==='calling'||state.phase==='recording')state.unknown=true;state.phase='faulted';}transport.onclose?.();};raw.onerror=error=>transport.onerror?.(error);raw.onmessage=message=>{
          if(message?.method==='notifications/tools/list_changed'){
            // A proposal refers to a point-in-time tool schema. A server can
            // change behavior without notifying, but an explicit change notice
            // must immediately invalidate pending approvals and future calls.
            state.catalogChanged=true;state.proposal=null;
            if(state.phase==='calling'||state.phase==='recording')state.unknown=true;
            else if(state.phase==='ready')state.phase='catalog_changed';
          }
          transport.onmessage?.(message);
        };
        state.transport=transport;state.client=new Client({name:'buildx-local-mcp',version:'0.1.0'},{listMaxPages:2,versionNegotiation:{mode:'legacy'}});state.unstarted=null;
        await state.client.connect(transport,{timeout:LIMITS.startMs});
        if(state.closeRequested)throw new Error('closed during startup');
        if(state.client.getProtocolEra()!=='legacy')throw new Error('unsupported protocol');
        const listed=await state.client.listTools(undefined,{timeout:LIMITS.startMs});
        if(state.closeRequested||state.childClosed||state.catalogChanged||!Array.isArray(listed.tools)||listed.tools.length>LIMITS.tools||Buffer.byteLength(JSON.stringify(listed))>LIMITS.outputBytes)throw new Error('catalog invalid');
        const tools=new Map();
        for(const tool of listed.tools){
          if(typeof tool.name!=='string'||!tool.name||tool.name.length>128||/[\x00-\x1f\x7f]/.test(tool.name)||tools.has(tool.name)||!plain(tool.inputSchema)||tool.inputSchema.type!=='object'||typeof tool.description!=='undefined'&&typeof tool.description!=='string')throw new Error('tool invalid');
          if(containsStartupSecret(tool))throw new Error('tool disclosure unsafe');
          const schema=snapshot(tool.inputSchema),dialect=schema.value.$schema;
          if(dialect!==undefined&&!['https://json-schema.org/draft/2020-12/schema','https://json-schema.org/draft/2020-12/schema#'].includes(dialect))throw new Error('unsupported dialect');
          const validate=ajv.compile(schema.value),definition=copy(tool);
          tools.set(tool.name,{definition,schema:schema.value,schemaDigest:schema.digest,validate,description:(tool.description??'').slice(0,1000)});
        }
        state.tools=tools;state.serverEvidence=copy(selected.proposal);state.launch=null;state.phase='ready';return this.listTools();
      }catch{
        if(!state.client){
          if(state.unstarted&&!await disposeUnstarted()){state.phase='cleanup_pending';return fail('CLEANUP_UNCONFIRMED','unknown');}
          state.phase='closed';return fail(!preparedRuntime?'MCP_RUNTIME_UNAVAILABLE':'EXECUTABLE_IDENTITY_UNVERIFIED');
        }
        // The child may have spawned even if initialization failed. Retain its
        // original owner until close is actually confirmed.
        state.phase='ready';const cleanup=await close();return cleanup.ok?fail('MCP_CONNECT_FAILED'):fail('CLEANUP_UNCONFIRMED','unknown');
      }
    },
    listTools(){
      if(state.phase!=='ready'||state.unknown)return fail('INVALID_STATE');
      return {ok:true,serverId,generation:state.generation,tools:[...state.tools].map(([name,t])=>({name,description:t.description,inputSchema:copy(t.schema),schemaDigest:t.schemaDigest,sideEffects:'unknown'}))};
    },
    prepareCall({name,args,sensitivePaths=[]}={}){
      if(state.phase!=='ready'||state.unknown||state.closeRequested||state.catalogChanged)return fail('INVALID_STATE');
      if(!state.tools.has(name)||!plain(args)||state.receipt&&state.receipt.outcome==='unknown')return fail('TOOL_OR_ARGUMENT_INVALID');
      const tool=state.tools.get(name);let snap,masked;
      try{
        snap=snapshot(args);if(!tool.validate(snap.value))return fail('ARGUMENTS_SCHEMA_INVALID');masked=explicitRedaction(snap.value,sensitivePaths);
        // The same marked input may appear under another argument, in an object
        // key, a JSON pointer, or the selected tool/schema/server evidence that
        // accompanies the proposal and attempt. Never publish such a snapshot.
        const secrets=[...startupSecrets,...masked.secrets];
        if([masked.value,sensitivePaths,name,tool.schema,state.serverEvidence].some(value=>containsSecrets(value,secrets)))return fail('ARGUMENTS_DISCLOSURE_UNSAFE');
      }catch{return fail('ARGUMENTS_INVALID');}
      // A public raw SHA digest of low-entropy explicitly marked secrets
      // permits guessing. This per-owner HMAC binds exact call bytes while
      // remaining non-recomputable after process termination.
      const argumentDigest=createHmac('sha256',digestKey).update(JSON.stringify(snap.value)).digest('hex');
      const proposal={proposalId:randomUUID(),serverId,generation:state.generation,tool:name,arguments:masked.value,sensitivePaths:[...sensitivePaths],argumentDigest,argumentDigestAlgorithm:'HMAC-SHA256-ephemeral',schemaDigest:tool.schemaDigest,sideEffects:'unknown'};
      state.proposal={proposal,tool,arguments:snap.value,secrets:[...masked.secrets,...selectedArgs.filter((_,index)=>sensitiveArgs.has(index))].filter(Boolean)};return {ok:true,proposal:copy(proposal)};
    },
    async call({proposalId,approvalId,signal,timeoutMs=LIMITS.callMs}={}){
      if(state.phase!=='ready'||state.unknown||state.closeRequested)return fail('INVALID_STATE');
      const selected=state.proposal;if(!selected||selected.proposal.proposalId!==proposalId)return fail('PROPOSAL_INVALID');
      if(!Number.isSafeInteger(timeoutMs)||timeoutMs<50||timeoutMs>LIMITS.callMs)return fail('TIMEOUT_INVALID');
      if(signal?.aborted)return fail('CANCELLED_BEFORE_SEND');
      let finishCall;const callDone=new Promise(resolve=>{finishCall=resolve;});state.callDone=callDone;
      try{
      state.proposal=null;state.phase='authorizing';
      try{if(await approvalOwner.consume({approvalId,kind:'mcp_call',proposal:copy(selected.proposal)})!==true){if(!state.closeRequested&&!state.childClosed)state.phase=state.catalogChanged?'catalog_changed':'ready';return fail('CALL_APPROVAL_REQUIRED');}}
      catch{if(!state.closeRequested&&!state.childClosed)state.phase=state.catalogChanged?'catalog_changed':'ready';return fail('CALL_APPROVAL_REQUIRED');}
      if(state.catalogChanged){if(!state.closeRequested&&!state.childClosed)state.phase='catalog_changed';return fail('TOOL_CATALOG_CHANGED');}
      if(state.closeRequested||state.childClosed||signal?.aborted){if(!state.closeRequested&&!state.childClosed)state.phase='ready';return fail('CANCELLED_BEFORE_SEND');}
      const receipt={attemptId:randomUUID(),serverId,generation:state.generation,tool:selected.proposal.tool,argumentDigest:selected.proposal.argumentDigest,argumentDigestAlgorithm:selected.proposal.argumentDigestAlgorithm,schemaDigest:selected.proposal.schemaDigest,server:copy(state.serverEvidence),inputSchema:copy(selected.tool.schema),arguments:copy(selected.proposal.arguments),sensitivePaths:[...selected.proposal.sensitivePaths],outcome:'unknown'};
      state.receipt=receipt;state.phase='recording';
      try{if(await receiptOwner.recordAttempt(copy(receipt))!==true){state.unknown=true;if(!state.closeRequested&&!state.childClosed)state.phase=state.catalogChanged?'catalog_changed':'ready';return fail('RECEIPT_UNCONFIRMED','unknown');}}
      catch{state.unknown=true;if(!state.closeRequested&&!state.childClosed)state.phase=state.catalogChanged?'catalog_changed':'ready';return fail('RECEIPT_UNCONFIRMED','unknown');}
      if(state.closeRequested||state.childClosed||signal?.aborted||state.catalogChanged){state.unknown=true;if(!state.closeRequested&&!state.childClosed)state.phase=state.catalogChanged?'catalog_changed':'ready';return {ok:false,code:'RESULT_UNKNOWN',receipt:copy(receipt)};}
      state.phase='calling';
      try{
        // Providing the exact captured toolDefinition and legacy protocol avoids
        // SDK's modern header-mismatch automatic call retry.
        const result=await state.client.callTool({name:selected.proposal.tool,arguments:selected.arguments},{timeout:timeoutMs,signal,toolDefinition:selected.tool.definition});
        if(state.closeRequested||state.catalogChanged||state.unknown){state.unknown=true;return {ok:false,code:'RESULT_UNKNOWN',receipt:copy(receipt)};}
        const resultSnap=snapshot(redactOutput(result,selected.secrets),LIMITS.outputBytes),outcome={...receipt,outcome:'response_received',responseDigest:resultSnap.digest,result:resultSnap.value,isError:result.isError===true};
        if(await receiptOwner.recordOutcome(copy(outcome))!==true)throw new Error('outcome not committed');
        state.receipt=outcome;if(!state.closeRequested&&!state.childClosed)state.phase=state.catalogChanged?'catalog_changed':'ready';return {ok:true,receipt:copy(outcome),result:resultSnap.value,...state.catalogChanged?{catalogChanged:true}:{}};
      }catch{state.unknown=true;if(!state.closeRequested&&!state.childClosed)state.phase=state.catalogChanged?'catalog_changed':'ready';return {ok:false,code:'RESULT_UNKNOWN',receipt:copy(receipt)};}
      }finally{if(state.callDone===callDone)state.callDone=null;finishCall();}
    },
    close,
  });
}
