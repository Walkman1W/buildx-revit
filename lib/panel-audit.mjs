import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const codes=new Set(['codex_lifecycle','codex_exit','revit_tool_catalog','revit_tools_verified','source_tool_catalog','source_tools_verified','customer_chat_tools_verified','service_started','service_stopping','service_closed','service_cleanup_pending','service_start_failed']);
const phases=new Set(['spawn','connected','fault','closing','closed','cleanup_pending']);
const reasons=new Set(['codex_spawned','codex_handshake_completed','codex_child_error','codex_missing_pipe','codex_stdin_error','codex_stdout_error','codex_stderr_error','codex_stdin_closed','codex_stdout_eof','codex_stdout_closed','codex_process_ended','codex_child_close','codex_transport_type','codex_frame_limit','invalid_rpc_line','invalid_rpc_envelope','codex_write_limit','codex_stdin_write_error','codex_initialize_failed','codex_close_requested','codex_kill_requested','codex_cleanup_unconfirmed','codex_close_confirmed','manual_stop','SIGINT','SIGTERM','startup']);
const safeName=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,120}$/.test(value);
const timingPhases=new Set(['turn_accepted','attachments_saved','history_saved','context_ready','thread_ready','native_requested','native_acknowledged','first_native_event','first_text_received','first_text_ready_for_sse','native_terminal_received','tool_started','tool_completed','turn_finished','command_started','command_finished','rpc_queued','rpc_write_attempted','rpc_write_completed','rpc_acknowledged','rpc_failed','rpc_aborted','rpc_timeout','request_prepared','temp_ready','published','cancellation_requested','receipt_received','late_receipt_received','transport_finished']);
export function sanitizePanelAudit(file,input){
  if(!input||typeof input!=='object')return null;
  if(file==='phase-timing.jsonl'){
    if(input.code!=='phase_timing'||!['panel','codex_rpc','workbench'].includes(input.source)||!timingPhases.has(input.phase))return null;
    const result={code:input.code,source:input.source,phase:input.phase};
    for(const key of ['observedUtc','hostObservedUtc','hostExecuteEnteredUtc','hostClaimedUtc','hostResponsePreparedUtc','hostQueueSettledUtc'])if(typeof input[key]==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(input[key])&&Number.isFinite(Date.parse(input[key])))result[key]=input[key];
    for(const key of ['elapsedMs','durationMs','sinceWriteMs','sinceNativeRequestMs','hostObservedToExecuteMs','hostObservedToQueueSettlementMs','hostValidationMs','hostDispatchMs','hostWorkMs'])if(input[key]===null||Number.isFinite(input[key])&&input[key]>=0&&input[key]<=Number.MAX_SAFE_INTEGER)result[key]=input[key];
    for(const key of ['generation','rpcId'])if(Number.isSafeInteger(input[key])&&input[key]>=0)result[key]=input[key];
    for(const key of ['conversationId','messageId','threadId','turnId','executionId','itemId','requestId','hostSession'])if(typeof input[key]==='string'&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(input[key]))result[key]=input[key];
    for(const key of ['method','operation','commandId','tool','outcome'])if(safeName(input[key]))result[key]=input[key];
    if(['unavailable','invalid','valid'].includes(input.hostTimingState))result.hostTimingState=input.hostTimingState;
    if(['matched','unmatched'].includes(input.hostSchedulerCorrelation))result.hostSchedulerCorrelation=input.hostSchedulerCorrelation;
    return result;
  }
  if(file==='tool-calls.jsonl'){
    if(input.kind==='dynamic_model'){
      if(input.tool!=='buildx_model_operation'||!['received','rejected','verifying','awaiting_approval','accepted','dispatching','completed'].includes(input.phase)||!['admission','binding','proposal','approval','execution','decision'].includes(input.stage))return null;
      const result={kind:'dynamic_model',phase:input.phase,tool:input.tool,stage:input.stage,hasCurrentGrant:input.hasCurrentGrant===true};
      for(const key of ['conversationId','threadId','turnId','callId'])if(typeof input[key]==='string'&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(input[key]))result[key]=input[key];
      if(safeName(input.modelTool))result.modelTool=input.modelTool;
      if(typeof input.code==='string'&&/^MODEL_[A-Z0-9_]{1,80}$/.test(input.code))result.code=input.code;
      if(['not_started','completed','unconfirmed','declined'].includes(input.outcome))result.outcome=input.outcome;
      if(['undefined','null','object','array','string','number','boolean'].includes(input.parametersType))result.parametersType=input.parametersType;
      for(const key of ['argumentKeys','parameterKeys'])if(Array.isArray(input[key]))result[key]=input[key].filter(safeName).slice(0,32);
      if(Number.isFinite(input.elapsedMs)&&input.elapsedMs>=0&&input.elapsedMs<=Number.MAX_SAFE_INTEGER)result.elapsedMs=input.elapsedMs;
      return result;
    }
    if(!['started','completed'].includes(input.phase)||!safeName(input.tool))return null;
    return {phase:input.phase,tool:input.tool,protocolStatus:['inProgress','completed','failed'].includes(input.protocolStatus)?input.protocolStatus:null,errorPresent:input.errorPresent===true,resultIsError:typeof input.resultIsError==='boolean'?input.resultIsError:null};
  }
  if(!['connection-status.json','lifecycle.jsonl'].includes(file)||!codes.has(input.code))return null;
  const result={code:input.code};
  if(input.code==='service_start_failed'&&typeof input.error_code==='string'&&/^[A-Z0-9_]{1,80}$/.test(input.error_code))result.error_code=input.error_code;
  if(phases.has(input.phase))result.phase=input.phase;
  if(reasons.has(input.reason))result.reason=input.reason;
  for(const key of ['generation','pid','count'])if(Number.isSafeInteger(input[key])&&input[key]>=0)result[key]=input[key];
  if(input.exitCode===null||Number.isSafeInteger(input.exitCode))result.exitCode=input.exitCode;
  if(input.signal===null||['SIGINT','SIGTERM','SIGKILL','SIGABRT'].includes(input.signal))result.signal=input.signal;
  if(['stdin','stdout','stderr'].includes(input.stream))result.stream=input.stream;
  if(['connected','failed','starting','absent','connecting','disconnected'].includes(input.runtimeStatus))result.runtimeStatus=input.runtimeStatus;
  if(typeof input.toolsErrorPresent==='boolean')result.toolsErrorPresent=input.toolsErrorPresent;
  // Known catalog names are bounded display identifiers, never raw error bodies.
  if(Array.isArray(input.toolNames))result.toolNames=input.toolNames.filter(safeName).slice(0,100);
  return result;
}

const auditFiles=['connection-status.json','lifecycle.jsonl','tool-calls.jsonl','phase-timing.jsonl'];
const fault=code=>Object.assign(new Error(code),{auditCode:code});
const classify=error=>typeof error?.auditCode==='string'?error.auditCode:'audit_io_failed';
const samePath=(left,right)=>process.platform==='win32'?path.normalize(left).toLowerCase()===path.normalize(right).toLowerCase():left===right;
function identity(stat){
  if(typeof stat.dev!=='bigint'||typeof stat.ino!=='bigint'||stat.ino===0n||typeof stat.birthtimeNs!=='bigint')throw fault('audit_identity_unknown');
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
function ordinaryDirectory(stat){
  if(stat.isSymbolicLink())throw fault('audit_directory_link');
  if(!stat.isDirectory())throw fault('audit_not_directory');
  return identity(stat);
}
function ordinaryFile(stat){
  if(stat.isSymbolicLink())throw fault('audit_target_link');
  if(!stat.isFile())throw fault('audit_target_not_file');
  if(stat.nlink!==1n)throw fault('audit_target_hardlink');
  return identity(stat);
}
function directoryNames(directory){
  if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.includes('\0'))throw fault('audit_directory_path_invalid');
  const root=path.parse(directory).root;
  // Only ordinary local paths are supported. Device, UNC, URL, drive-relative,
  // dot-segment, ADS and Windows name aliases are never grants to write.
  if(process.platform==='win32'&&!/^[A-Za-z]:[\\/]$/.test(root))throw fault('audit_directory_path_invalid');
  const segments=directory.slice(root.length).split(process.platform==='win32'?/[\\/]/:/\//).filter(Boolean);
  if(segments.length>64||segments.some(part=>part==='.'||part==='..'||(process.platform==='win32'&&(/[<>:"|?*]|[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))))throw fault('audit_directory_path_invalid');
  const names=[root];for(const segment of segments)names.push(path.join(names.at(-1),segment));
  return names;
}

// Capture existing ancestors in the factory's call stack: queued work must not
// adopt a replacement directory as its original destination. lstat/realpath and
// subsequent I/O are separate observations, not an OS sandbox or atomic lease.
function captureDirectory(directory){
  const names=directoryNames(directory),chain=[];
  let missing=false;
  for(const name of names){
    if(missing){chain.push({path:name,identity:null});continue;}
    let stat;
    try{stat=fsSync.lstatSync(name,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;missing=true;chain.push({path:name,identity:null});continue;}
    const id=ordinaryDirectory(stat);
    if(!samePath(name,fsSync.realpathSync(name)))throw fault('audit_directory_alias');
    chain.push({path:name,identity:id});
  }
  return chain;
}

// Read-only facts at this observation, not a directory lease or write grant.
// Audit construction still captures its own original chain independently.
export function inspectExistingPanelDirectory(directory){
  try{
    const chain=captureDirectory(directory);
    if(chain.some(part=>part.identity===null))throw fault('audit_directory_missing');
    return {ok:true,value:Object.freeze({path:chain.at(-1).path,requested:directory,observedAt:new Date().toISOString(),
      chain:Object.freeze(chain.map(part=>Object.freeze({...part})))})};
  }catch(error){return {ok:false,error:{code:classify(error)}};}
}

// A prior immutable observation may only narrow admission to the configured
// destination. Capture its consumed facts once; it never chooses a write path.
function captureExpectedAncestor(value){
  if(value===undefined)return null;
  const invalid=()=>fault('audit_ancestor_constraint_invalid');
  try{
    const data=node=>{
      if(!node||typeof node!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(node))||!Object.isFrozen(node))throw invalid();
      const descriptors=Object.getOwnPropertyDescriptors(node);
      for(const key of Reflect.ownKeys(descriptors))if(typeof key!=='string'||!Object.hasOwn(descriptors[key],'value'))throw invalid();
      return descriptors;
    };
    const ownValue=(descriptors,key)=>Object.hasOwn(descriptors,key)?descriptors[key].value:undefined;
    const top=data(value),pathValue=ownValue(top,'path'),chainValue=ownValue(top,'chain');
    if(typeof pathValue!=='string'||!pathValue||pathValue.length>=32767||!Array.isArray(chainValue)||!Object.isFrozen(chainValue))throw invalid();
    const descriptors=Object.getOwnPropertyDescriptors(chainValue),length=ownValue(descriptors,'length');
    if(!Number.isSafeInteger(length)||length<1||length>65||Reflect.ownKeys(descriptors).length!==length+1)throw invalid();
    const chain=[];
    for(let index=0;index<length;index++){
      const element=Object.hasOwn(descriptors,index)?descriptors[index]:null;if(!element||!Object.hasOwn(element,'value'))throw invalid();
      const row=data(element.value),path=ownValue(row,'path'),identity=ownValue(row,'identity');
      if(typeof path!=='string'||!path||path.length>=32767||typeof identity!=='string'||!identity||identity.length>1024)throw invalid();
      chain.push(Object.freeze({path,identity}));
    }
    if(!samePath(pathValue,chain.at(-1).path))throw invalid();
    return Object.freeze({path:pathValue,chain:Object.freeze(chain)});
  }catch{throw invalid();}
}

// Stop retaining at the file/queue limits; never delete existing evidence. One
// owner retains each opened handle until close is observed, including failures.
export function createPanelAudit(directory,{service='revit-local-codex',maxFileBytes=1024*1024,maxQueued=64,requireNewDirectory=false,expectedAncestor}={}){
  if(!safeName(service)||!Number.isSafeInteger(maxFileBytes)||maxFileBytes<1024||maxFileBytes>1024*1024||!Number.isSafeInteger(maxQueued)||maxQueued<1||maxQueued>64||typeof requireNewDirectory!=='boolean')throw new Error('Invalid audit configuration');
  let writes=Promise.resolve(),queued=0,dropped=0,failures=0,blockedReason=null,owned=null,accepting=true,closed=false,closingPromise=null,retentionTimer=null;
  let chain=[];
  const files=new Map();
  function block(error){failures++;blockedReason??=classify(error);}
  try{
    const constraint=captureExpectedAncestor(expectedAncestor);
    chain=captureDirectory(directory);directory=chain.at(-1).path;
    if(constraint&&(constraint.chain.length>chain.length||constraint.chain.some((part,index)=>!samePath(part.path,chain[index].path)||part.identity!==chain[index].identity)))throw fault('audit_directory_changed');
    // Strict run admission never adopts an existing terminal directory or
    // inspects its logs. The original missing-name mkdir path owns creation;
    // EEXIST or an unknown outcome remains blocked, without another name/retry.
    if(requireNewDirectory&&chain.at(-1).identity!==null)throw fault('audit_directory_exists');
    for(const file of auditFiles){
      let stat;
      if(chain.at(-1).identity!==null)try{stat=fsSync.lstatSync(path.join(directory,file),{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}
      files.set(file,stat?ordinaryFile(stat):null);
    }
  }catch(error){block(error);}
  function state(){return {queued,dropped,failures,closed:closed&&!accepting&&queued===0&&!owned,processRetained:retentionTimer!==null,status:owned?.cleanupPending?'cleanup_pending':blockedReason?'blocked':closed?'closed':accepting?'ready':'closing',reason:blockedReason,cleanupId:owned?.cleanupPending?owned.cleanupId:null};}
  function result(){
    const value=state();
    return owned?{ok:false,error:{code:'audit_cleanup_pending',cleanupId:owned.cleanupId,...(blockedReason?{primaryCode:blockedReason}:{})},value}:blockedReason?{ok:false,error:{code:blockedReason},value}:{ok:true,value};
  }
  async function verifyChain(count=chain.length){
    for(const part of chain.slice(0,count)){
      const stat=await fs.lstat(part.path,{bigint:true});
      const observed=ordinaryDirectory(stat);
      if(part.identity===null||observed!==part.identity)throw fault('audit_directory_changed');
      if(!samePath(part.path,await fs.realpath(part.path)))throw fault('audit_directory_alias');
    }
  }
  async function prepareDirectory(){
    for(let index=0;index<chain.length;index++){
      if(chain[index].identity!==null)continue;
      await verifyChain(index);
      // A name absent at construction may only be created by this owner. An
      // EEXIST outcome is not permission to adopt whatever appeared there.
      try{await fs.mkdir(chain[index].path);}catch(error){if(error.code==='EEXIST')throw fault('audit_directory_changed');throw error;}
      const stat=await fs.lstat(chain[index].path,{bigint:true});
      const id=ordinaryDirectory(stat);
      if(!samePath(chain[index].path,await fs.realpath(chain[index].path)))throw fault('audit_directory_alias');
      chain[index].identity=id;
    }
    await verifyChain();
  }
  async function observeFile(file){
    let observed;
    try{observed=await fs.lstat(path.join(directory,file),{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}
    const expected=files.get(file);
    if(observed){if(ordinaryFile(observed)!==expected)throw fault('audit_target_changed');}
    else if(expected!==null)throw fault('audit_target_changed');
    return observed;
  }
  async function closeOwned(){
    const current=owned;if(!current)return;
    // Retain the same object and handle if close throws. Do not reopen, infer
    // closure from a pathname, replay a write, or silently retry on flush.
    try{await current.handle.close();}catch(error){
      current.cleanupPending=true;
      // Retain this process owner even during failed startup without a listener
      // or child. This timer does no work and never retries I/O.
      retentionTimer??=setInterval(()=>{},2**30);
      throw error;
    }
    if(owned===current){owned=null;if(retentionTimer!==null){clearInterval(retentionTimer);retentionTimer=null;}}
  }
  async function write(file,text,append){
    if(blockedReason||owned){dropped++;return;}
    await prepareDirectory();
    const destination=path.join(directory,file),expected=files.get(file);
    const observed=await observeFile(file);
    await verifyChain();
    const flags=observed?fsSync.constants.O_RDWR|(append?fsSync.constants.O_APPEND:0)|(fsSync.constants.O_NOFOLLOW??0):'wx';
    const cleanupId=randomUUID();
    let handle;
    try{handle=await fs.open(destination,flags);}catch(error){if(error.code==='EEXIST'||error.code==='ELOOP')throw fault('audit_target_changed');throw error;}
    owned={handle,cleanupId,cleanupPending:false};
    try{
      const opened=await handle.stat({bigint:true});
      const openedIdentity=ordinaryFile(opened);
      if(observed&&openedIdentity!==expected)throw fault('audit_target_changed');
      const current=await fs.lstat(destination,{bigint:true});
      if(ordinaryFile(current)!==openedIdentity)throw fault('audit_target_changed');
      await verifyChain();
      files.set(file,openedIdentity);
      const size=append?opened.size:0n;
      if(size+BigInt(Buffer.byteLength(text))>BigInt(maxFileBytes)){dropped++;return;}
      if(!append)await handle.truncate(0);
      // New files use wx; their first append starts at offset zero. Existing
      // append handles use O_APPEND, with no destructive open-time truncation.
      await handle.writeFile(text);
    }catch(error){block(error);}
    finally{try{await closeOwned();}catch{block(fault('audit_close_failed'));}}
  }
  function schedule(action){
    const operation=writes.then(action);
    writes=operation.catch(error=>{block(error);});
    return writes;
  }
  function audit(file,value,append=false){
    const data=sanitizePanelAudit(file,value);if(!data)return;
    const text=JSON.stringify({...data,service,recordedAt:new Date().toISOString()})+'\n';
    if(!accepting||blockedReason||owned?.cleanupPending||Buffer.byteLength(text)>8192||queued>=maxQueued){dropped++;return;}
    queued++;
    schedule(async()=>{try{await write(file,text,append);}finally{queued--;}});
  }
  function ready(){
    if(!accepting)return Promise.resolve({ok:false,error:{code:'audit_closed'},value:state()});
    return schedule(async()=>{
      if(blockedReason||owned)return;
      await prepareDirectory();
      for(const file of auditFiles)await observeFile(file);
      await verifyChain();
    }).then(result);
  }
  function close(){
    accepting=false;
    closingPromise??=writes.then(()=>{if(!owned)closed=true;});
    return closingPromise.then(result);
  }
  function cleanup(cleanupId){
    let invalid=false;
    return schedule(async()=>{
      if(typeof cleanupId!=='string'||!owned||owned.cleanupId!==cleanupId){invalid=true;return;}
      try{await closeOwned();if(!accepting)closed=true;}catch{block(fault('audit_close_failed'));}
    }).then(()=>invalid?{ok:false,error:{code:'audit_cleanup_id_invalid'},value:state()}:owned?result():{ok:true,value:state()});
  }
  return Object.freeze({audit,ready,flush:()=>writes.then(result),state,close,cleanup});
}
