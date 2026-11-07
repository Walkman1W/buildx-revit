import {spawn, spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {resolveLocalRuntimes} from './local-runtimes.mjs';

// Per-frame/retention limits, not tool permissions or total-turn quotas.
const FRAME_BYTES=8*1024*1024, OUTBOUND_FRAME_BYTES=256*1024;
export const CODEX_OUTBOUND_FRAME_BYTES=OUTBOUND_FRAME_BYTES;
const WRITE_BYTES=4*1024*1024, WRITE_FRAMES=64, MAX_PENDING=64;
// Only an owned visual-tool response can use a larger frame. Ordinary RPCs
// retain their existing limits; image expansion is admitted before decoding.
const VISUAL_FRAME_BYTES=8*1024*1024, visualFrameToken=Symbol('visual-tool-output');
const visualTools=new Set(['revit_capture_view','revit_inspect_elements']);
export function validateDynamicToolOutput(result,allowsImages=false){
  if(!plain(result)||Object.keys(result).some(key=>!['contentItems','success'].includes(key))||typeof result.success!=='boolean'||!Array.isArray(result.contentItems)||result.contentItems.length>16)return false;
  let images=0,total=0;
  for(const item of result.contentItems){
    if(!plain(item))return false;
    if(item.type==='inputText'){
      if(Object.keys(item).some(key=>!['type','text'].includes(key))||typeof item.text!=='string'||Buffer.byteLength(item.text)>65536)return false;
      continue;
    }
    if(!allowsImages||item.type!=='inputImage'||Object.keys(item).some(key=>!['type','imageUrl'].includes(key))||typeof item.imageUrl!=='string'||++images>3)return false;
    const prefix='data:image/png;base64,';
    if(!item.imageUrl.startsWith(prefix)||item.imageUrl.length>prefix.length+4*Math.ceil(2*1024*1024/3))return false;
    const data=item.imageUrl.slice(prefix.length);
    if(data.length<44||data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))return false;
    const size=data.length/4*3-(data.endsWith('==')?2:data.endsWith('=')?1:0);
    if(size>2*1024*1024||(total+=size)>4*1024*1024)return false;
    const bytes=Buffer.from(data,'base64');
    if(bytes.toString('base64')!==data||bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')return false;
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
    if(width<1||height<1||width>4096||height>4096||width*height>16000000)return false;
  }
  return Buffer.byteLength(JSON.stringify(result))<=(images?VISUAL_FRAME_BYTES:OUTBOUND_FRAME_BYTES)-1024;
}
// These are visible account/read facts, not a stable provider identity. Keep the
// schema's currently supported plans explicit; no token/workspace definitions
// that are unreachable from GetAccountResponse become account claims.
const ACCOUNT_PLANS=new Set(['free','go','plus','pro','prolite','promax','team','self_serve_business_prolite','self_serve_business_usage_based','business','ent26','enterprise_cbp_automation','enterprise_cbp_usage_based','enterprise','edu','edu_plus','edu_pro','sci','sci_plus','unknown']);
const SETUP_ISSUES=Object.freeze({CODEX_NOT_FOUND:'codex_missing',CODEX_PATH_INVALID:'codex_path_invalid',CODEX_PATH_AMBIGUOUS:'codex_path_ambiguous',CODEX_WRAPPER_ONLY:'codex_wrapper_only',PYTHON_NOT_FOUND:'python_missing',PYTHON_PATH_INVALID:'python_path_invalid',PYTHON_PATH_UNVERIFIED:'python_path_unverified'});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function fault(code,message,generation){const error=new Error(message);error.code=code;if(generation!==undefined)error.connectionGeneration=generation;return error;}
// Installed native UserInput contract. The application snapshot owner supplies
// local paths; remote URLs and browser-supplied native shapes are not accepted.
export function nativeTurnParams(threadId,text,localImages=[],supportsImages=false){
  const invalid=message=>Object.assign(fault('CODEX_TURN_INPUT_INVALID',message),{notSent:true});
  if(typeof threadId!=='string'||!threadId||threadId.length>200||typeof text!=='string'||!text.trim()||!Array.isArray(localImages)||localImages.length>2||localImages.length&&!supportsImages)throw invalid('本轮输入无效或当前连接不支持图片。');
  const input=[{type:'text',text}];
  for(const image of localImages){
    if(!image||Object.keys(image).length!==2||image.type!=='localImage'||typeof image.path!=='string'||image.path.length>4096||image.path.includes('\0')||!path.isAbsolute(image.path))throw invalid('图片快照路径无效。');
    input.push({type:'localImage',path:image.path});
  }
  const params={threadId,input};
  if(text.length>OUTBOUND_FRAME_BYTES||Buffer.byteLength(JSON.stringify({id:Number.MAX_SAFE_INTEGER,method:'turn/start',params})+'\n')>OUTBOUND_FRAME_BYTES)throw invalid('本轮正文和上下文过大，请减少附加文本后再发送。');
  return params;
}
function accountFacts(value,generation){
  if(!plain(value)||typeof value.requiresOpenaiAuth!=='boolean'||!plain(value.account))throw fault('CODEX_ACCOUNT_INVALID','Codex 账号状态未能核实，请重新连接。',generation);
  const account=value.account;
  if(account.type!=='chatgpt')throw fault('CODEX_ACCOUNT_UNSUPPORTED','当前 Codex 连接未提供受支持的 ChatGPT 账号，请重新连接。',generation);
  if(!(account.email===null||typeof account.email==='string'&&Buffer.byteLength(account.email)<=4096)||typeof account.planType!=='string'||!ACCOUNT_PLANS.has(account.planType))throw fault('CODEX_ACCOUNT_INVALID','Codex 账号响应不符合已核对的契约，请重新连接。',generation);
  return {type:'chatgpt',email:account.email,planType:account.planType};
}
function readConfiguredNames(python){
  const configPath=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'config.toml');
  const script='import json,tomllib,sys; print(json.dumps(list(tomllib.load(open(sys.argv[1],"rb")).get("mcp_servers",{}))))';
  const result=spawnSync(python,['-c',script,configPath],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:1024*1024});
  if(result.status!==0)throw fault('CODEX_CONFIG_UNAVAILABLE','无法读取 MCP 服务名称，已停止启动。');
  try{return JSON.parse(result.stdout);}catch{throw fault('CODEX_CONFIG_INVALID','MCP 服务名称响应无效，已停止启动。');}
}
// Disabled configuration entries carry no active MCP capabilities. A full
// terminal page must still prove empty tools, resources and resource templates.
function zeroMcpCatalog(value){
  if(!plain(value)||Object.keys(value).some(key=>!['data','nextCursor'].includes(key))||!Array.isArray(value.data)||value.data.length>100||Object.hasOwn(value,'nextCursor')&&value.nextCursor!==null)return false;
  const names=new Set(),authModes=new Set(['unknown','unsupported','notLoggedIn','bearerToken','oAuth']);
  for(const entry of value.data){
    if(!plain(entry)||typeof entry.name!=='string'||!entry.name||names.has(entry.name)||!authModes.has(entry.authStatus)||entry.runtimeStatus!=='disabled'||!plain(entry.tools)||Object.keys(entry.tools).length!==0||!Array.isArray(entry.resources)||entry.resources.length!==0||!Array.isArray(entry.resourceTemplates)||entry.resourceTemplates.length!==0||entry.toolsError!==undefined&&entry.toolsError!==null)return false;
    names.add(entry.name);
  }
  return true;
}
function dependencies(input){
  if(input===undefined)return Object.freeze({spawn,resolveRuntimes:resolveLocalRuntimes,readConfiguredNames,closeTimeoutMs:2500,killTimeoutMs:1000});
  if(!plain(input)||Reflect.ownKeys(input).some(key=>!['spawn','resolveRuntimes','readConfiguredNames','closeTimeoutMs','killTimeoutMs','apiProvider','skillCatalogMode','skillCatalogOwner','familyCapabilityOwner'].includes(key)))throw new Error('Codex内部依赖配置无效。');
  const snapshot={spawn:input.spawn??spawn,resolveRuntimes:input.resolveRuntimes??resolveLocalRuntimes,readConfiguredNames:input.readConfiguredNames??readConfiguredNames,closeTimeoutMs:input.closeTimeoutMs??2500,killTimeoutMs:input.killTimeoutMs??1000};
  if(['spawn','resolveRuntimes','readConfiguredNames'].some(key=>typeof snapshot[key]!=='function')||!Number.isSafeInteger(snapshot.closeTimeoutMs)||snapshot.closeTimeoutMs<1||snapshot.closeTimeoutMs>2500||!Number.isSafeInteger(snapshot.killTimeoutMs)||snapshot.killTimeoutMs<1||snapshot.killTimeoutMs>1000)throw new Error('Codex内部依赖配置无效。');
  return Object.freeze(snapshot);
}

// Internal one-shot launch owner: never accept this from HTTP or a mutable
// profile. Only public, non-secret configuration identity is retained here.
function captureApiProvider(input){
  if(input===undefined||input===null)return null;
  const invalid=()=>new Error('API 连接只接受内部冻结的启动所有者。');
  if(!plain(input)||!Object.isFrozen(input))throw invalid();
  const methods={};
  for(const name of ['describe','start','dispose']){
    const descriptor=Object.getOwnPropertyDescriptor(input,name);
    if(!descriptor||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function')throw invalid();
    methods[name]=descriptor.value;
  }
  let view;try{view=methods.describe.call(input);}catch{throw invalid();}
  const identity=view?.identity;
  if(!plain(view)||!Object.isFrozen(view)||!plain(identity)||!Object.isFrozen(identity)||
    Object.keys(identity).sort().join(',')!=='model,providerId,providerRevision,type'||identity.type!=='api_key'||
    typeof identity.providerId!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(identity.providerId)||
    typeof identity.providerRevision!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.providerRevision)||
    typeof identity.model!=='string'||!identity.model||identity.model.length>200||/[\x00-\x1f\x7f]/.test(identity.model)||view.status!=='unverified')throw invalid();
  const facts=Object.freeze({...identity});
  return Object.freeze({facts,start:args=>methods.start.call(input,args),dispose:()=>methods.dispose.call(input)});
}

// An internal composition owner supplies this profile, never browser input.
// Retain the same immutable data graph instead of taking mutable configuration
// or invoking accessors again after asynchronous connection work begins.
function trustedProfile(value){
  const invalid=()=>new Error('Codex 核心只接受内部冻结的会话profile。'),seen=new Set();
  const data=node=>{
    if(node===null||typeof node!=='object')return;
    if(seen.has(node))return;
    if(!Object.isFrozen(node)||!Array.isArray(node)&&Object.getPrototypeOf(node)!==Object.prototype&&Object.getPrototypeOf(node)!==null)throw invalid();
    seen.add(node);
    for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(node))){if(!Object.hasOwn(descriptor,'value'))throw invalid();data(descriptor.value);}
  };
  if(!plain(value))throw invalid();data(value);
  if(!Array.isArray(value.groups)||!Array.isArray(value.toolNames)||!plain(value.clientInfo)||typeof value.buildLaunchArgs!=='function'||typeof value.buildInstructions!=='function'||value.verifyWholeCatalog!==undefined&&typeof value.verifyWholeCatalog!=='function'||value.supportsTurnAttachments!==undefined&&typeof value.supportsTurnAttachments!=='boolean')throw invalid();
  // Only a trusted, immutable internal profile may register dynamic tools.
  // Model operations, five project reads and three policy-bound file tools
  // share a bounded catalog; the complete RPC retains its own byte budget.
  const checkDynamicTools=tools=>{
    if(!Array.isArray(tools)||tools.length<1||tools.length>12)throw invalid();
    const names=new Set();
    for(const spec of tools){
      if(!plain(spec)||Object.keys(spec).some(key=>!['type','name','description','inputSchema'].includes(key))||spec.type!=='function'||typeof spec.name!=='string'||!/^buildx_[a-z0-9_]{1,55}$/.test(spec.name)||names.has(spec.name)||typeof spec.description!=='string'||!spec.description||spec.description.length>1000||!plain(spec.inputSchema)||spec.inputSchema.type!=='object'||spec.inputSchema.additionalProperties!==false)throw invalid();
      names.add(spec.name);
    }
    try{if(Buffer.byteLength(JSON.stringify(tools))>32768)throw invalid();}catch{throw invalid();}
  };
  if(value.dynamicTools!==undefined)checkDynamicTools(value.dynamicTools);
  if(value.familyLifecycleDynamicTools!==undefined){
    if(value.id!=='model-workspace'||!value.dynamicTools)throw invalid();
    checkDynamicTools(value.familyLifecycleDynamicTools);
    const base=value.dynamicTools,extended=value.familyLifecycleDynamicTools;
    if(base.length!==extended.length)throw invalid();
    for(let i=0;i<base.length;i++){
      const a=base[i],b=extended[i];
      if(a.name!==b.name)throw invalid();
      if(a.name!=='buildx_model_operation'){if(JSON.stringify(a)!==JSON.stringify(b))throw invalid();continue;}
      const old=a.inputSchema?.properties?.tool?.enum,now=b.inputSchema?.properties?.tool?.enum;
      if(!Array.isArray(old)||!Array.isArray(now)||now.length!==old.length+2||old.some(name=>!now.includes(name))||!['revit_family_save_job','revit_family_close_job'].every(name=>!old.includes(name)&&now.includes(name))||new Set(now).size!==now.length)throw invalid();
      const normalize=spec=>{const copy=structuredClone(spec);copy.inputSchema.properties.tool.enum=[];return JSON.stringify(copy);};
      if(normalize(a)!==normalize(b))throw invalid();
    }
  }
  return value;
}

export class CodexClientCore extends EventEmitter {
  #apiProvider;
  #familyCapabilityOwner;
  constructor(root,trustedSessionProfile,internalDependencies){
    super();Object.defineProperty(this,'profile',{value:trustedProfile(trustedSessionProfile),writable:false,configurable:false});
    this.root=root;this.sequence=0;this.pending=new Map();this.initialized=false;this.authReady=false;this.toolsReady=false;this.preparedThread=null;this.child=null;this.error=null;
    const apiDescriptor=internalDependencies===undefined?undefined:Object.getOwnPropertyDescriptor(internalDependencies,'apiProvider');
    const skillModeDescriptor=internalDependencies===undefined?undefined:Object.getOwnPropertyDescriptor(internalDependencies,'skillCatalogMode');
    const skillOwnerDescriptor=internalDependencies===undefined?undefined:Object.getOwnPropertyDescriptor(internalDependencies,'skillCatalogOwner');
    const familyOwnerDescriptor=internalDependencies===undefined?undefined:Object.getOwnPropertyDescriptor(internalDependencies,'familyCapabilityOwner');
    if(familyOwnerDescriptor&&(!Object.hasOwn(familyOwnerDescriptor,'value')||!plain(familyOwnerDescriptor.value)||!Object.isFrozen(familyOwnerDescriptor.value)||Reflect.ownKeys(familyOwnerDescriptor.value).length!==1||typeof Object.getOwnPropertyDescriptor(familyOwnerDescriptor.value,'observe')?.value!=='function'||this.profile.id!=='model-workspace'||!this.profile.familyLifecycleDynamicTools))throw new Error('模型族能力只接受可信的冻结所有者。');
    this.#familyCapabilityOwner=familyOwnerDescriptor?.value??null;this._familyCapabilityWork=null;
    if(skillModeDescriptor&&(!Object.hasOwn(skillModeDescriptor,'value')||!['research','customer'].includes(skillModeDescriptor.value)))throw new Error('技能目录模式无效。');
    Object.defineProperty(this,'skillCatalogMode',{value:skillModeDescriptor?.value??'research',writable:false,configurable:false});
    const skillOwner=skillOwnerDescriptor?.value;
    if(skillOwnerDescriptor&&(!Object.hasOwn(skillOwnerDescriptor,'value')||!plain(skillOwner)||!Object.isFrozen(skillOwner)||Reflect.ownKeys(skillOwner).length!==1||typeof Object.getOwnPropertyDescriptor(skillOwner,'catalog')?.value!=='function'))throw new Error('技能目录只接受可信的冻结所有者。');
    Object.defineProperty(this,'_skillCatalogOwner',{value:skillOwner?.catalog??null,writable:false,configurable:false});
    if(apiDescriptor&&!Object.hasOwn(apiDescriptor,'value'))throw new Error('Codex内部依赖配置无效。');
    this.#apiProvider=captureApiProvider(apiDescriptor?.value);
    if(this.#apiProvider&&(this.profile.id!=='model-workspace'||typeof this.profile.verifyWholeCatalog!=='function'))throw new Error('API 连接只允许由完整目录核验的模型工作区内部组合。');
    this._deps=dependencies(internalDependencies);this._generation=0;this._connection=null;
    this._accountRevision=0;this._accountSequence=0;this._accountStatus='unknown';this._accountObservedAt=null;this._accountObservation=null;this._accountRead=null;
    this._modelCatalog=null;this._modelListSequence=0;this._setupIssue=null;
    this._skillsCatalog=null;this._skillsListSequence=0;
    this._dynamicThreads=new Map();this._dynamicCalls=new Map();
  }
  get state(){return {service:this.profile.service,ready:this.initialized&&this.authReady&&this.toolsReady&&!this._accountRead,error:Boolean(this.error),message:this.error||(this._accountRead?'正在核实 Codex 账号…':!this.initialized?'正在连接本地 Codex…':!this.authReady?'正在检查 Codex 登录…':!this.toolsReady?this.profile.connectingTools:'Codex · '+this.profile.toolNames.length+'项工具已加载'),mode:this.profile.mode,toolCount:this.toolsReady?this.profile.toolNames.length:0,connectionGeneration:this._generation,connectionStatus:this._connection?.phase??'closed',cleanupPending:Boolean(this._connection&&!this._connection.closed&&(this._connection.phase==='closing'||this._connection.fault)),setupIssue:this._setupIssue,codexAccount:{status:this._accountRead&&this._accountStatus!=='invalidated'?'checking':this._accountStatus,connectionGeneration:this._generation,accountRevision:this._accountRevision,observationSequence:this._accountSequence,observedAt:this._accountObservedAt,stableAccountId:null,workspaceId:null,...(this.#apiProvider&&this._accountStatus==='verified'?{...this.#apiProvider.facts,modelAvailability:'unverified'}:{})}};}
  _scope(){return this._connection??(this.child?{child:this.child,legacy:true}:null);}
  _current(c){return Boolean(c&&(c.legacy?this.child===c.child&&!this._connection:this._connection===c&&this.child===c.child&&!c.closed&&!c.fault&&c.phase!=='closing'));}
  _assert(c){if(!this._current(c))throw fault('CODEX_CONNECTION_CHANGED','Codex 连接已变化；旧请求不会重新执行。',c?.generation);}
  _assertAccount(c,revision){this._assert(c);if(this._accountRevision!==revision)throw fault('CODEX_ACCOUNT_REVISION_CHANGED','Codex 账号状态已失效，请重新连接；旧操作不会重试。',c?.generation);}
  async _observeFamilyCapability(c,revision){
    if(!this.#familyCapabilityOwner)return null;
    // One retained observation at a time; an unresponsive host must not start
    // an unbounded series of abandoned reads or stall the Codex connection.
    let owner=this._familyCapabilityWork;
    if(owner&&(owner.connection!==c||owner.revision!==revision))return null;
    if(!owner){
      const promise=Promise.resolve().then(()=>this.#familyCapabilityOwner.observe()).catch(()=>null);
      owner={promise,connection:c,revision};this._familyCapabilityWork=owner;
      void promise.then(()=>{if(this._familyCapabilityWork===owner)this._familyCapabilityWork=null;});
    }
    let timer;const value=await Promise.race([owner.promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1500);timer.unref?.();})]);clearTimeout(timer);
    this._assertAccount(c,revision);
    try{
      if(!plain(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
      const keys=Reflect.ownKeys(value);if(keys.some(key=>typeof key!=='string')||keys.sort().join(',')!=='hostSession,version')return null;
      const fields=Object.getOwnPropertyDescriptors(value);
      if(!Object.hasOwn(fields.version,'value')||!Object.hasOwn(fields.hostSession,'value')||fields.version.value!==1||typeof fields.hostSession.value!=='string'||!/^[a-f0-9]{32}$/.test(fields.hostSession.value))return null;
      return Object.freeze({hostSession:fields.hostSession.value,version:1});
    }catch{return null;}
  }
  _accountVerified(c){return Boolean(this._current(c)&&this._accountStatus==='verified'&&this._accountObservation?.connectionGeneration===c.generation&&this._accountObservation.accountRevision===this._accountRevision);}
  _forgetAccount(){this._invalidateSkills();this._accountStatus='unknown';this._accountObservedAt=null;this._accountObservation=null;this._accountRead=null;}
  _invalidateSkills(){this._skillsListSequence++;this._skillsCatalog=null;this.emit('skills-changed');}
  _cancelAccountDelays(c){if(c&&!c.legacy){for(const cancel of c.delays)cancel(fault('CODEX_ACCOUNT_REVISION_CHANGED','Codex 账号状态已失效，请重新连接；旧操作不会重试。',c.generation));c.delays.clear();}}
  _invalidateAccount(c,reason){
    this._assert(c);this._accountRevision++;this._accountStatus='invalidated';this._accountObservation=null;this.authReady=false;this.toolsReady=false;this.preparedThread=null;
    this._invalidateSkills();
    // An account notification invalidates previous setup facts too. A user may
    // have just signed in externally; only a new account/read can say so.
    if(reason==='account_updated'||reason==='account_login_completed')this._setupIssue=null;
    if(c.phase==='starting'&&['account_updated','account_login_completed'].includes(reason))c.bootstrapHintRevision=this._accountRevision;
    this._cancelAccountDelays(c);
    this.error='Codex 账号状态已失效，请重新连接后再次确认。';
    this.emit('account-invalidated',{connectionGeneration:c.generation,accountRevision:this._accountRevision,reason});this.emit('state',this.state);
  }
  _observeAccount(value,c,revision){
    this._assertAccount(c,revision);const previous=this._accountObservation;
    if(previous&&plain(value)&&plain(value.account)&&typeof value.account.type==='string'&&value.account.type!==previous.type){
      this._invalidateAccount(c,'account_observation_changed');throw fault('CODEX_ACCOUNT_CHANGED','Codex 可见账号信息发生变化，请重新连接后再次确认。',c.generation);
    }
    const facts=accountFacts(value,c.generation);
    if(previous&&(previous.type!==facts.type||previous.email!==facts.email||previous.planType!==facts.planType)){
      this._invalidateAccount(c,'account_observation_changed');throw fault('CODEX_ACCOUNT_CHANGED','Codex 可见账号信息发生变化，请重新连接后再次确认。',c.generation);
    }
    this._accountObservedAt=new Date().toISOString();this._accountStatus='verified';this._accountSequence++;
    this._accountObservation=Object.freeze({...facts,connectionGeneration:c.generation,accountRevision:revision,observationSequence:this._accountSequence,observedAt:this._accountObservedAt,stableAccountId:null,workspaceId:null});
    return {...this._accountObservation};
  }
  // Observation of the configured local provider is deliberately separate from
  // remote model availability. No network or credential validity is inferred.
  _observeApiProvider(c,revision){
    this._assertAccount(c,revision);
    if(!this.#apiProvider)throw fault('CODEX_ACCOUNT_INVALID','API 连接配置不可用。',c?.generation);
    const facts=this.#apiProvider.facts;
    this._accountObservedAt=new Date().toISOString();this._accountStatus='verified';this._accountSequence++;
    this._accountObservation=Object.freeze({...facts,modelAvailability:'unverified',connectionGeneration:c.generation,accountRevision:revision,observationSequence:this._accountSequence,observedAt:this._accountObservedAt,stableAccountId:null,workspaceId:null});
    return {...this._accountObservation};
  }
  refreshAccount(){
    if(this._accountRead)return this._accountRead.promise;
    const c=this._scope();
    try{this._assert(c);if(!this.state.ready||!this._accountVerified(c))throw fault('CODEX_ACCOUNT_NOT_READY','Codex 账号尚未就绪，请先重新连接。',c?.generation);}catch(error){return Promise.reject(error);}
    const revision=this._accountRevision,read={connection:c,revision,promise:null};this._accountRead=read;
    read.promise=Promise.resolve().then(async()=>{
      try{
        this._assertAccount(c,revision);
        if(this.#apiProvider)return this._observeApiProvider(c,revision);
        const result=await this.request('account/read',{refreshToken:false},45000,c);this._assertAccount(c,revision);
        return this._observeAccount(result,c,revision);
      }catch(error){
        if(this._current(c)&&this._accountRevision===revision)this._invalidateAccount(c,'account_read_failed');
        if(error?.code?.startsWith('CODEX_ACCOUNT_')||error?.code==='CODEX_CONNECTION_CHANGED')throw error;
        throw fault('CODEX_ACCOUNT_READ_FAILED','未能核实 Codex 账号，请重新连接；不会自动重试。',c.generation);
      }finally{if(this._accountRead===read){this._accountRead=null;this.emit('state',this.state);}}
    });
    this.emit('state',this.state);
    return read.promise;
  }
  _assertStartup(c){this._assert(c);if(c.startupCancelled)throw fault('CODEX_ACCOUNT_REVISION_CHANGED','Codex 启动已停止；迟到回执不会恢复连接。',c.generation);}
  _same(a,b){return a===b||Boolean(a?.legacy&&b?.legacy&&a.child===b.child);}
  _diagnostic(c,phase,reason,extra={}){this.emit('diagnostic',{code:'codex_lifecycle',phase,reason,generation:c.generation,...extra});}
  _rpcTiming(item,phase,extra={}){
    if(!item?.timing)return;
    const now=performance.now();
    try{this.emit('diagnostic',{code:'phase_timing',source:'codex_rpc',phase,observedUtc:new Date().toISOString(),generation:item.connection?.generation??0,rpcId:item.timing.id,method:item.timing.method,...item.timing.threadId?{threadId:item.timing.threadId}:{},elapsedMs:now-item.timing.start,...(item.timing.written===null?{}:{sinceWriteMs:now-item.timing.written}),...extra});}catch{/* Observation must not change the original RPC outcome. */}
  }
  _rejectPending(c,error){for(const [id,item] of this.pending){if(!this._same(item.connection,c))continue;this._rpcTiming(item,'rpc_aborted');clearTimeout(item.timer);this.pending.delete(id);item.reject(error);}}
  _clear(c){c.used=0;c.queue.length=0;c.queuedBytes=0;for(const cancel of c.delays)cancel();c.delays.clear();}
  _poison(c,code,message='Codex 连接中断；请重新连接，进行中的结果须另行核对。'){
    if(this._connection!==c||c.closed)return;
    const first=!c.fault;c.fault??=code;if(c.phase!=='closing')c.phase='failed';
    this._clear(c);this._rejectPending(c,fault(code,message,c.generation));
    if(first){this._diagnostic(c,'fault',code);this.failed(message);}
  }
  async start(){
    if(this._connection){
      if(this._connection.phase==='starting'&&!this._connection.fault)return this._connection.startPromise;
      if(this._connection.phase==='ready'&&!this._connection.fault)return;
      throw fault('CODEX_CLEANUP_REQUIRED','旧 Codex 连接尚未确认关闭，请先重试清理。',this._connection.generation);
    }
    if(this.child)throw fault('CODEX_CLEANUP_REQUIRED','旧 Codex 连接尚未确认关闭，请先重试清理。');
    this._setupIssue=null;
    let runtime,args,configuredNames;
    try{runtime=this._deps.resolveRuntimes();configuredNames=this._deps.readConfiguredNames(runtime.python);args=this.profile.buildLaunchArgs(configuredNames);}
    catch(error){this._setupIssue=Object.hasOwn(SETUP_ISSUES,error?.code)?SETUP_ISSUES[error.code]:null;throw error;}
    let child;
    try{child=this.#apiProvider?this.#apiProvider.start({spawn:this._deps.spawn,executable:runtime.codex,baseArgs:args,cwd:this.root,env:{...process.env}}):this._deps.spawn(runtime.codex,args,{cwd:this.root,env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});}
    catch{this.failed('无法启动本地 Codex，请核对程序路径。');throw fault('CODEX_SPAWN_ERROR',this.error);}
    for(const call of this._dynamicCalls.values())call.discard();this._dynamicCalls.clear();this._dynamicThreads.clear();
    // Retain only the names already consumed by this connection's launch
    // owner. This is a point-in-time snapshot, not a second TOML parser and
    // not proof that a configured server is connected or safe to execute.
    const names=Array.isArray(configuredNames)&&configuredNames.length<=100&&configuredNames.every(name=>typeof name==='string'&&name.length>0&&name.length<=1024)&&new Set(configuredNames).size===configuredNames.length?Object.freeze([...configuredNames]):null;
    const c={child,generation:++this._generation,phase:'starting',startupCancelled:false,bootstrapHintRevision:null,fault:null,closed:false,exitSeen:false,stdinEnded:false,configuredMcpNames:names,verifiedDisabledMcpNames:null,frame:Buffer.alloc(16*1024),used:0,queue:[],queuedBytes:0,writes:new Set(),writeBytes:0,blocked:false,pumping:false,delays:new Set(),closeWaiters:new Set(),closePromise:null,startPromise:null};
    this._connection=c;this.child=child;this.error=null;this._forgetAccount();this._attach(c);this._diagnostic(c,'spawn','codex_spawned');
    c.startPromise=this._start(c).catch(error=>{if(this._current(c)){if(this._accountStatus==='invalidated'){c.phase='ready';this.emit('state',this.state);}else if(error?.code==='CODEX_PROVIDER_UNVERIFIED')this._poison(c,'codex_provider_unverified',error.message);else this._poison(c,'codex_initialize_failed');}throw error;});
    return c.startPromise;
  }
  _attach(c){
    const child=c.child;
    child.on('error',()=>this._poison(c,'codex_child_error','无法启动或连接本地 Codex，请核对程序路径。'));
    child.on('exit',(code,signal)=>{
      c.exitSeen=true;if(this._connection!==c||c.closed)return;
      this.emit('diagnostic',{code:'codex_exit',generation:c.generation,exitCode:Number.isSafeInteger(code)?code:null,signal:typeof signal==='string'&&/^[A-Z0-9]+$/.test(signal)?signal:null});
      if(c.phase!=='closing')this._poison(c,'codex_process_ended','Codex 进程已结束。请点击重新连接。');
    });
    child.on('close',()=>{
      if(c.closed)return;
      if(this._connection===c&&c.phase!=='closing'&&!c.fault)this._poison(c,'codex_child_close');
      c.closed=true;c.phase='closed';this._clear(c);c.frame=Buffer.alloc(0);c.writes.clear();c.writeBytes=0;
      for(const resolve of c.closeWaiters)resolve();c.closeWaiters.clear();
      if(this._connection===c){this._connection=null;this.child=null;this._diagnostic(c,'closed','codex_close_confirmed');this.emit('state',this.state);}
    });
    for(const [name,pipe] of [['stdin',child.stdin],['stdout',child.stdout],['stderr',child.stderr]]){
      if(!pipe||typeof pipe.on!=='function'){this._poison(c,'codex_missing_pipe');continue;}
      pipe.on('error',()=>this._poison(c,'codex_'+name+'_error'));
      if(name==='stdin'){pipe.on('drain',()=>{if(this._current(c)){c.blocked=false;this._pump(c);}});pipe.on('close',()=>{if(c.phase!=='closing')this._poison(c,'codex_stdin_closed');});}
    }
    if(child.stdout?.on){child.stdout.on('data',chunk=>this._onData(c,chunk));child.stdout.on('end',()=>{if(c.phase!=='closing')this._poison(c,'codex_stdout_eof');});child.stdout.on('close',()=>{if(c.phase!=='closing')this._poison(c,'codex_stdout_closed');});}
    // Stderr can include account and conversation data. Consume without retaining.
    child.stderr?.on('data',()=>{});
  }
  async _start(c){
    this._assertStartup(c);await this.request('initialize',{clientInfo:this.profile.clientInfo,...(this.profile.id==='model-workspace'||this.profile.dynamicTools)?{capabilities:{experimentalApi:true}}:{}},45000,c);this._assertStartup(c);
    this.notify('initialized',undefined,c);this._assertStartup(c);this.initialized=true;
    // Preserve the existing ChatGPT login; never import credentials or select API billing.
    let revision=this._accountRevision;
    try{
      if(this.#apiProvider){this._assertStartup(c);this._observeApiProvider(c,revision);}
      else {
      for(let attempt=0;attempt<2;attempt++){
        revision=this._accountRevision;
        this._assertStartup(c);
        const account=await this.request('account/read',{refreshToken:false},45000,c);this._assertStartup(c);
        // App Server may announce its initial account during the handshake.
        // No facts or confirmation have been published yet. Discard a response
        // crossed by that notice and perform at most one fresh read of the new
        // revision; never retry a turn, login, failed RPC or established binding.
        if(attempt===0&&revision!==this._accountRevision&&c.bootstrapHintRevision===this._accountRevision&&this._accountObservation===null)continue;
        this._assertAccount(c,revision);
        if(plain(account)&&account.requiresOpenaiAuth===true&&Object.hasOwn(account,'account')&&account.account===null){
          this._setupIssue='sign_in_required';
          throw fault('CODEX_ACCOUNT_INVALID','未检测到 Codex 登录。请在本机 Codex 中登录自己的 ChatGPT 账号，完成后重新连接。',c.generation);
        }
        this._observeAccount(account,c,revision);break;
      }
      }
    }catch(error){
      if(this._current(c)&&this._accountRevision===revision)this._invalidateAccount(c,'account_read_failed');
      if(error?.code==='CODEX_ACCOUNT_UNSUPPORTED')this._setupIssue='unsupported_account';
      if(error?.code?.startsWith('CODEX_ACCOUNT_')||error?.code==='CODEX_CONNECTION_CHANGED')throw error;
      throw fault('CODEX_ACCOUNT_READ_FAILED','未能核实 Codex 账号，请重新连接；不会自动重试。',c.generation);
    }
    this.authReady=true;this.error=null;this.emit('state',this.state);
    const prepared=await this.prepareThread(c);this._assertAccount(c,revision);this.preparedThread=prepared;this.toolsReady=true;
    this._assertAccount(c,revision);c.phase='ready';this._diagnostic(c,'connected','codex_handshake_completed');this.emit('state',this.state);
  }
  _onData(c,chunk){
    if(!this._current(c))return;
    if(!Buffer.isBuffer(chunk)){this._poison(c,'codex_transport_type');return;}
    let start=0;
    while(start<chunk.length&&this._current(c)){
      const newline=chunk.indexOf(10,start),end=newline<0?chunk.length:newline,count=end-start,required=c.used+count;
      if(required>FRAME_BYTES){this._poison(c,'codex_frame_limit');return;}
      if(required>c.frame.length){const next=Buffer.alloc(Math.min(FRAME_BYTES,Math.max(required,c.frame.length*2)));c.frame.copy(next,0,0,c.used);c.frame=next;}
      chunk.copy(c.frame,c.used,start,end);c.used=required;
      if(newline<0)return;
      let length=c.used;if(length&&c.frame[length-1]===13)length--;c.used=0;
      if(length){let message;try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(c.frame.subarray(0,length)));}catch{this._poison(c,'invalid_rpc_line');return;}
        try{this.dispatch(message,c);}catch{this._poison(c,'invalid_rpc_envelope');return;}}
      start=newline+1;
    }
  }
  failed(message){if(this._connection?.phase==='starting')this._connection.startupCancelled=true;this._accountRevision++;this._cancelAccountDelays(this._scope());this.initialized=false;this.authReady=false;this.toolsReady=false;this.preparedThread=null;this._forgetAccount();this.error=message;for(const item of this.pending.values()){this._rpcTiming(item,'rpc_aborted');clearTimeout(item.timer);item.reject(new Error(message));}this.pending.clear();this.emit('state',this.state);}
  send(value,c=this._scope(),frameToken){
    this._assert(c);let serialized;try{serialized=JSON.stringify(value)+'\n';}catch{throw fault('CODEX_OUTBOUND_INVALID','Codex 请求无法序列化。',c?.generation);}
    const bytes=Buffer.byteLength(serialized);
    const visual=frameToken===visualFrameToken;
    if(bytes>(visual?VISUAL_FRAME_BYTES:OUTBOUND_FRAME_BYTES))throw fault('CODEX_OUTBOUND_LIMIT','Codex 请求超过传输上限。',c?.generation);
    // Compatibility with existing trusted protocol adapters that inject child directly.
    if(c.legacy){const pending=this.pending.get(value.id);if(pending?.timing){pending.timing.written=performance.now();this._rpcTiming(pending,'rpc_write_attempted');}c.child.stdin.write(serialized);return;}
    const visualReserved=[...c.queue,...c.writes].reduce((sum,frame)=>sum+(frame.visual?frame.bytes:0),0);
    if(c.queue.length+c.writes.size>=WRITE_FRAMES||(visual?visualReserved>0:c.queuedBytes+c.writeBytes-visualReserved+bytes>WRITE_BYTES)){this._poison(c,'codex_write_limit');throw fault('CODEX_WRITE_LIMIT','Codex 写入队列已满，请重新连接。',c.generation);}
    c.queue.push({serialized,bytes,id:value.id,visual});c.queuedBytes+=bytes;this._pump(c);this._assert(c);
  }
  _pump(c){
    if(c.pumping||c.blocked||!this._current(c))return;c.pumping=true;
    try{while(c.queue.length&&!c.blocked&&this._current(c)){
      const frame=c.queue.shift();c.queuedBytes-=frame.bytes;c.writes.add(frame);c.writeBytes+=frame.bytes;
      try{if(!c.child.stdin?.writable)throw new Error();
        const pending=this.pending.get(frame.id);if(pending?.timing){pending.timing.written=performance.now();this._rpcTiming(pending,'rpc_write_attempted');}
        const accepted=c.child.stdin.write(frame.serialized,error=>{if(c.writes.delete(frame))c.writeBytes-=frame.bytes;if(error)this._poison(c,'codex_stdin_write_error');else if(this._current(c))this._rpcTiming(pending,'rpc_write_completed');});
        if(accepted===false)c.blocked=true;
      }catch{if(c.writes.delete(frame))c.writeBytes-=frame.bytes;this._poison(c,'codex_stdin_write_error');}
    }}finally{c.pumping=false;}
  }
  _dropQueued(c,id){if(!c||c.legacy)return;c.queue=c.queue.filter(frame=>{if(frame.id!==id)return true;c.queuedBytes-=frame.bytes;return false;});}
  notify(method,params,c=this._scope()){this.send({method,...(params===undefined?{}:{params})},c);}
  request(method,params,timeout=45000,c=this._scope()){
    return new Promise((resolve,reject)=>{
      try{this._assert(c);if(this.pending.size>=MAX_PENDING)throw fault('CODEX_PENDING_LIMIT','Codex 请求数量超过上限。',c?.generation);if(!Number.isSafeInteger(timeout)||timeout<1||timeout>120000)throw fault('CODEX_TIMEOUT_INVALID','Codex 请求期限无效。');}catch(error){reject(error);return;}
      const id=++this.sequence,timer=setTimeout(()=>{const item=this.pending.get(id);if(!item)return;this._rpcTiming(item,'rpc_timeout');this.pending.delete(id);this._dropQueued(c,id);reject(fault('CODEX_REQUEST_TIMEOUT','Codex 请求响应超时；不会自动重试。',c?.generation));},timeout);
      const item={resolve,reject,timer,connection:c,timing:{id,method:['initialize','account/read','thread/start','mcpServerStatus/list','turn/start','turn/interrupt'].includes(method)?method:'other',...(typeof params?.threadId==='string'&&params.threadId.length<=200?{threadId:params.threadId}:{}),start:performance.now(),written:null}};this.pending.set(id,item);this._rpcTiming(item,'rpc_queued');
      try{this.send({id,method,params},c);}catch(error){if(this.pending.has(id))this._rpcTiming(item,'rpc_aborted');clearTimeout(timer);this.pending.delete(id);this._dropQueued(c,id);reject(error);}
    });
  }
  dispatch(message,c=this._scope()){
    if(!this._current(c))return;if(!plain(message))throw fault('CODEX_RPC_INVALID','Codex 响应格式无效。');
    if(message.id!==undefined&&!message.method){
      const item=this.pending.get(message.id);if(!item||!this._same(item.connection,c))return;
      if(Object.hasOwn(message,'result')===Object.hasOwn(message,'error'))throw fault('CODEX_RPC_INVALID','Codex 响应格式无效。');
      if(message.error&&(!plain(message.error)||!Number.isSafeInteger(message.error.code)))throw fault('CODEX_RPC_INVALID','Codex 响应格式无效。');
      clearTimeout(item.timer);this.pending.delete(message.id);
      this._rpcTiming(item,message.error?'rpc_failed':'rpc_acknowledged',item.timing?.method==='turn/start'&&typeof message.result?.turn?.id==='string'&&message.result.turn.id.length<=200?{turnId:message.result.turn.id}:{});
      if(message.error){const error=fault('CODEX_RPC_ERROR','Codex协议请求失败：'+message.error.code,c?.generation);error.rpcCode=message.error.code;error.rpcMessage=String(message.error.message||'').slice(0,2048);item.reject(error);}else item.resolve(message.result);return;
    }
    if(typeof message.method!=='string'||message.method.length>128)throw fault('CODEX_RPC_INVALID','Codex 响应格式无效。');
    if(message.id!==undefined){
      if(!Number.isSafeInteger(message.id)&&!(typeof message.id==='string'&&message.id.length<=200))throw fault('CODEX_RPC_INVALID','Codex 请求身份无效。');
      if(message.method==='item/tool/call'&&this.profile.dynamicTools&&this.listenerCount('dynamic-tool-request')){
        const p=message.params, bound=this._dynamicThreads.get(p?.threadId), revision=this._accountRevision;
        const string=v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\x00-\x1f\x7f]/.test(v);
        const selected=plain(p)&&bound?.dynamicTools?.some(spec=>spec.name===p.tool);
        let args=null;
        // Text writes carry the complete replacement. Allow their advertised
        // 1 MiB content plus worst-case JSON escaping, within the input frame.
        // Other dynamic tools retain the existing 64 KiB argument budget.
        try{if(plain(p?.arguments)){const fileWrite=selected&&p.tool==='buildx_file_write'&&typeof p.arguments.content==='string'&&Buffer.byteLength(p.arguments.content)<=1024*1024;
          const text=JSON.stringify(p.arguments);if(typeof text==='string'&&Buffer.byteLength(text)<=(fileWrite?7*1024*1024:65536))args=JSON.parse(text);}}catch{/* Untrusted arguments are rejected. */}
        const familyLifecycle=p?.tool==='buildx_model_operation'&&['revit_family_save_job','revit_family_close_job'].includes(args?.tool);
        const valid=selected&&args&&(!familyLifecycle||Boolean(bound?.family))&&string(p.threadId)&&string(p.turnId)&&string(p.callId)&&(p.namespace===undefined||p.namespace===null)&&bound?.connection===c&&bound.revision===revision&&this._accountVerified(c);
        const key=valid?JSON.stringify([c.generation,revision,p.threadId,p.turnId,p.callId]):null;
        const previous=valid?this._dynamicCalls.get(key):null;
        const sameRpcId=[...this._dynamicCalls.values()].find(call=>call.connection===c&&call.requestId===message.id);
        for(const conflict of new Set([previous,sameRpcId].filter(Boolean))){const wasPending=conflict.isPending();conflict.discard();if(wasPending&&conflict.requestId!==message.id)this.send({id:conflict.requestId,error:{code:-32600,message:'Duplicate dynamic tool call'}},c);}
        if(!valid||previous||sameRpcId||this._dynamicCalls.size>=4096){this.send({id:message.id,error:{code:-32600,message:'Dynamic tool call unavailable'}},c);return;}
        const stack=[[args,0]];let nodes=0,validTree=true;
        while(stack.length){const [node,depth]=stack.pop();if(++nodes>8192||depth>64){validTree=false;break;}if(node&&typeof node==='object'){const values=Object.values(node);if(values.length>8192-nodes){validTree=false;break;}for(const value of values)stack.push([value,depth+1]);Object.freeze(node);}}
        if(!validTree){this.send({id:message.id,error:{code:-32600,message:'Dynamic tool arguments exceed limits'}},c);return;}
        // The owning panel must additionally bind this request to its active
        // turn, authenticated user and approval; receipt is not authorization.
        let pending=true;const call={connection:c,revision,threadId:p.threadId,turnId:p.turnId,requestId:message.id,isPending:()=>pending,discard:()=>{pending=false;}};
        this._dynamicCalls.set(key,call);
        const settle=(result,error)=>{
          if(!pending)return false;
          const allowsImages=p.tool==='buildx_model_operation'&&visualTools.has(args.tool)&&this.profile.supportsTurnAttachments===true;
          if(!error&&!validateDynamicToolOutput(result,allowsImages))return false;
          pending=false;if(!this._current(c)||this._accountRevision!==revision||this._dynamicThreads.get(p.threadId)!==bound)return false;
          this.send(error?{id:message.id,error:{code:-32600,message:'Dynamic tool call unavailable'}}:{id:message.id,result},c,!error&&result.contentItems.some(item=>item.type==='inputImage')?visualFrameToken:undefined);return true;
        };
        const dispatch=()=>{
          if(!call.isPending()||!this._current(c)||this._accountRevision!==revision||this._dynamicThreads.get(p.threadId)!==bound||!this._accountVerified(c)){call.discard();return;}
          this.emit('dynamic-tool-request',{id:message.id,params:Object.freeze({threadId:p.threadId,turnId:p.turnId,callId:p.callId,tool:p.tool,arguments:args}),generation:c.generation,revision,respond:result=>settle(result,false),reject:()=>settle(null,true),discard:call.discard});
        };
        if(familyLifecycle){
          void this._observeFamilyCapability(c,revision).then(now=>{if(!now||now.hostSession!==bound.family.hostSession){settle(null,true);return;}dispatch();}).catch(()=>{settle(null,true);});
        }else dispatch();
        return;
      }
      if(message.method==='item/tool/requestUserInput'&&this.profile.id==='model-workspace'&&this.listenerCount('user-input-request')){
        const revision=this._accountRevision;let pending=true;
        const settle=(result,error)=>{if(!pending)return false;pending=false;if(!this._current(c)||this._accountRevision!==revision)return false;this.send(error?{id:message.id,error:{code:-32600,message:'User input unavailable'}}:{id:message.id,result},c);return true;};
        this.emit('user-input-request',{id:message.id,params:message.params,generation:c.generation,revision,respond:result=>settle(result,false),reject:()=>settle(null,true),discard:()=>{pending=false;}});return;
      }
      if(message.method==='item/commandExecution/requestApproval'||message.method==='item/fileChange/requestApproval')this.send({id:message.id,result:{decision:'decline'}},c);
      else this.send({id:message.id,error:{code:-32601,message:this.profile.denialMessage}},c);
      this.emit('approval-denied',{method:message.method});return;
    }
    if(message.method==='account/updated'||message.method==='account/login/completed'){
      this._invalidateAccount(c,message.method==='account/updated'?'account_updated':'account_login_completed');return;
    }
    if(message.method==='serverRequest/resolved')for(const call of this._dynamicCalls.values())if(call.connection===c&&call.threadId===message.params?.threadId&&call.requestId===message.params?.requestId)call.discard();
    if(message.method==='turn/completed')for(const call of this._dynamicCalls.values())if(call.connection===c&&call.threadId===message.params?.threadId&&call.turnId===(message.params?.turn?.id??message.params?.turnId))call.discard();
    if(message.method==='skills/changed')this._invalidateSkills();
    this.emit('notification',message.method,message.params||{});
  }
  async newThread(){
    if(!this.state.ready)throw new Error(this.state.message);const c=this._scope();this._assert(c);
    if(this.preparedThread){
      const id=this.preparedThread;this.preparedThread=null;
      if(this.#familyCapabilityOwner){
        const revision=this._accountRevision,bound=this._dynamicThreads.get(id),now=await this._observeFamilyCapability(c,revision);
        if(!bound||bound.connection!==c||bound.revision!==revision||(bound.family?.hostSession??null)!==(now?.hostSession??null)){this._dynamicThreads.delete(id);return this.prepareThread(c);}
      }
      return id;
    }
    return this.prepareThread(c);
  }
  _pause(c,delay){
    this._assert(c);if(!delay)return Promise.resolve();if(c.legacy)return new Promise(resolve=>setTimeout(resolve,delay));
    return new Promise((resolve,reject)=>{const cancel=error=>{clearTimeout(timer);c.delays.delete(cancel);reject(error??fault('CODEX_CONNECTION_CHANGED','Codex 连接已变化；旧请求不会重新执行。',c.generation));};const timer=setTimeout(()=>{c.delays.delete(cancel);resolve();},delay);c.delays.add(cancel);});
  }
  async prepareThread(c=this._scope()){
    const revision=this._accountRevision;this._assertAccount(c,revision);
    if(!c.legacy&&(!this.authReady||!this._accountVerified(c)))throw fault('CODEX_ACCOUNT_NOT_READY','Codex 账号尚未就绪，请先重新连接。',c.generation);
    try{
      if(this.profile.dynamicTools&&!this.listenerCount('dynamic-tool-request'))throw new Error('Dynamic tools require a trusted request owner');
      const family=this.profile.familyLifecycleDynamicTools?await this._observeFamilyCapability(c,revision):null;
      const dynamicTools=family?this.profile.familyLifecycleDynamicTools:this.profile.dynamicTools;
      const result=await this.request('thread/start',{cwd:this.root,approvalPolicy:'never',sandbox:'read-only',ephemeral:true,developerInstructions:this.profile.buildInstructions(),...(dynamicTools?{dynamicTools}:{})},45000,c);this._assertAccount(c,revision);
      if(this.#apiProvider&&(result?.modelProvider!==this.#apiProvider.facts.providerId||result?.model!==this.#apiProvider.facts.model))throw fault('CODEX_PROVIDER_UNVERIFIED','Codex 未确认所选 API 服务与模型，已停止连接。',c.generation);
      const threadId=result.thread?.id;if(typeof threadId!=='string'||!threadId||threadId.length>200)throw new Error('Codex 未返回可核对的会话 ID');
      if(this.profile.groups.length===0){
        // An empty configured whitelist alone is not runtime evidence. Query the
        // whole thread catalog, never a named-server subset or a partial page.
        try{
          if(this.profile.toolNames.length)throw fault('CODEX_ZERO_TOOLS_UNVERIFIED','零工具配置与目录不一致，已停止准备会话。',c.generation);
          const catalog=await this.request('mcpServerStatus/list',{threadId,detail:'toolsAndAuthOnly',limit:100},45000,c);this._assertAccount(c,revision);
          if(!zeroMcpCatalog(catalog))
            throw fault('CODEX_ZERO_TOOLS_UNVERIFIED','未取得明确完整的空工具目录，已停止准备会话。',c.generation);
        }catch(error){
          if(this._current(c)&&revision===this._accountRevision)this.failed('未能核实完整零工具范围，请重新连接；不会自动重发。');
          if(error?.code==='CODEX_CONNECTION_CHANGED'||error?.code==='CODEX_ACCOUNT_REVISION_CHANGED')throw error;
          throw fault('CODEX_ZERO_TOOLS_UNVERIFIED','未取得明确完整的空工具目录，已停止准备会话。',c.generation);
        }
        if(dynamicTools){if(this._dynamicThreads.size>=128)throw new Error('Dynamic thread capacity');this._dynamicThreads.set(threadId,{connection:c,revision,dynamicTools,family});}
        this.emit('diagnostic',{code:this.profile.verifiedDiagnostic,generation:c.generation,count:0});return threadId;
      }
      for(const delay of [0,500,1000,2000,4000,8000,8000,8000]){
        await this._pause(c,delay);this._assertAccount(c,revision);let groupsReady=true;
        for(const group of this.profile.groups){
          const catalog=await this.request('mcpServerStatus/list',{threadId,serverName:group.name,detail:'toolsAndAuthOnly',limit:100},group.statusTimeout,c);this._assertAccount(c,revision);
          const entry=catalog.data?.find(server=>server.name===group.name),names=Object.keys(entry?.tools||{});
          if(group.diagnosticCode){const detail=JSON.stringify(entry?.toolsError||''),failureMarkers=['timed out','timeout','handshake','connection closed','transport closed','ConnectionRefused','cannot find','not found','Permission denied','Access is denied','sandbox','helper_sandbox_lock_failed','SetNamedSecurityInfoW','initialize','invalid','spawn'].filter(word=>detail.toLowerCase().includes(word.toLowerCase()));this.emit('diagnostic',{code:group.diagnosticCode,generation:c.generation,runtimeStatus:entry?.runtimeStatus||'absent',toolNames:names,toolsErrorPresent:Boolean(entry?.toolsError),failureMarkers});}
          if(entry?.runtimeStatus==='failed'&&group.failFast)throw new Error(this.profile.catalogFailed);
          if(entry?.runtimeStatus!=='connected'||entry.toolsError||names.length!==group.toolNames.length||!group.toolNames.every(name=>names.includes(name))){groupsReady=false;break;}
        }
        if(groupsReady){
          if(this.profile.verifyWholeCatalog){
            const catalog=await this.request('mcpServerStatus/list',{threadId,detail:'full',limit:100},45000,c);
            this._assertAccount(c,revision);
            const proof=this.profile.verifyWholeCatalog(catalog);
            this._assertAccount(c,revision);
            if(proof?.ok!==true)throw fault('CODEX_TOOL_CATALOG_UNVERIFIED',this.profile.catalogNotReady,c.generation);
            if(this.profile.id==='model-workspace'&&Array.isArray(proof.value?.disabledServers)){
              // The proof owner already parsed the complete catalog. Retain
              // only names, never raw metadata, credentials or tool content.
              c.verifiedDisabledMcpNames=new Set(proof.value.disabledServers.map(entry=>entry.name));
            }
          }
          this._assertAccount(c,revision);if(dynamicTools){if(this._dynamicThreads.size>=128)throw new Error('Dynamic thread capacity');this._dynamicThreads.set(threadId,{connection:c,revision,dynamicTools,family});}this.emit('diagnostic',{code:this.profile.verifiedDiagnostic,generation:c.generation,count:this.profile.toolNames.length});return threadId;
        }
      }
      this._assertAccount(c,revision);throw new Error(this.profile.catalogNotReady);
    }catch(error){
      if(!this.profile.verifyWholeCatalog)throw error;
      // Thread creation, named readiness and whole-catalog proof share this owner.
      // A late failure cannot revoke a replacement connection or account revision.
      this._assertAccount(c,revision);
      // A mismatched API provider/model is not an MCP catalog failure. Keep
      // the actionable reason while still invalidating the incomplete thread.
      if(error?.code==='CODEX_PROVIDER_UNVERIFIED'){
        this.failed(error.message);
        throw error;
      }
      this.failed(this.profile.catalogNotReady);
      throw fault('CODEX_TOOL_CATALOG_UNVERIFIED',this.profile.catalogNotReady,c.generation);
    }
  }
  configuredMcpCandidates(){
    const c=this._connection;
    // A customer login cannot be assumed to own the Windows user's global
    // Codex configuration. The unbound research workspace is the only
    // composition presently allowed to expose this connection snapshot.
    if(this.profile.id!=='model-workspace'||this.skillCatalogMode!=='research')throw fault('MCP_CANDIDATES_UNAVAILABLE','此工作区不提供本机 MCP 配置快照。');
    if(!c||c.phase!=='ready'||c.fault||!this.state.ready)throw fault('MCP_CANDIDATES_UNAVAILABLE','连接尚未就绪，未取得 MCP 配置快照。');
    if(!c.configuredMcpNames)throw fault('MCP_CANDIDATES_LIMIT','配置名称快照无法完整显示。',c.generation);
    const disabled=c.verifiedDisabledMcpNames;
    return {generation:c.generation,revision:this._accountRevision,source:'launch_snapshot',
      servers:c.configuredMcpNames.map(name=>({name,status:name==='revit_workbench'?'reserved':disabled?.has(name)?'disabled':'unknown'}))};
  }
  // Fetch the complete visible catalog for this connection and account revision.
  // The selected `model` is the server's model value, not its display name or id.
  async listModels(){
    const c=this._scope();this._assert(c);if(!this.state.ready||!this._accountVerified(c))throw fault('CODEX_ACCOUNT_NOT_READY','Codex 账号状态尚未就绪，请重新连接后再读取模型。',c?.generation);
    const revision=this._accountRevision,sequence=++this._modelListSequence;this._modelCatalog=null;
    const models=[],seenModels=new Map(),seenCursors=new Set();let cursor=null;
    for(let page=0;page<20;page++){
      const result=await this.request('model/list',{limit:100,includeHidden:false,...(cursor===null?{}:{cursor})},45000,c);
      this._assertAccount(c,revision);if(!this.state.ready||!this._accountVerified(c))throw fault('CODEX_ACCOUNT_NOT_READY','Codex 账号状态尚未就绪，请重新读取模型。',c.generation);
      if(sequence!==this._modelListSequence)throw fault('CODEX_MODEL_LIST_SUPERSEDED','模型列表已更新，请使用最新列表。',c.generation);
      const invalid=()=>fault('CODEX_MODEL_LIST_INVALID','Codex 模型列表不完整或格式无效，请重新读取。',c.generation);
      if(!plain(result)||!Array.isArray(result.data)||result.data.length>100||!(result.nextCursor===undefined||result.nextCursor===null||typeof result.nextCursor==='string'&&result.nextCursor.length>0&&result.nextCursor.length<=4096))throw invalid();
      for(const entry of result.data){
        if(!plain(entry)||typeof entry.id!=='string'||!entry.id||entry.id.length>200||typeof entry.model!=='string'||!entry.model||entry.model.length>200||typeof entry.displayName!=='string'||entry.displayName.length>500||typeof entry.description!=='string'||entry.description.length>4000||typeof entry.hidden!=='boolean'||typeof entry.isDefault!=='boolean')throw invalid();
        if(entry.hidden)continue;
        if(seenModels.has(entry.model))throw invalid();
        // The installed protocol specifies text + image as the compatibility
        // default when older catalog responses omit inputModalities.
        const modalities=entry.inputModalities===undefined?['text','image']:entry.inputModalities;
        if(!Array.isArray(modalities)||modalities.length>16||modalities.some(value=>typeof value!=='string'||!value||value.length>80)||new Set(modalities).size!==modalities.length)throw invalid();
        const inputModalities=[...modalities];
        // Older catalogs did not advertise reasoning options. Preserve the
        // absence as unknown instead of guessing a model's supported values.
        let supportedReasoningEfforts=[],defaultReasoningEffort=null;
        if(entry.supportedReasoningEfforts!==undefined){
          const options=entry.supportedReasoningEfforts,defaultValue=entry.defaultReasoningEffort;
          if(!Array.isArray(options)||options.length>32||defaultValue!==undefined&&defaultValue!==null&&(typeof defaultValue!=='string'||!defaultValue||defaultValue.length>80)||options.some(option=>!plain(option)||typeof option.reasoningEffort!=='string'||!option.reasoningEffort||option.reasoningEffort.length>80||typeof option.description!=='string'||option.description.length>2000))throw invalid();
          const names=options.map(option=>option.reasoningEffort);
          if(new Set(names).size!==names.length)throw invalid();
          supportedReasoningEfforts=options.map(option=>({reasoningEffort:option.reasoningEffort,description:option.description}));defaultReasoningEffort=names.includes(defaultValue)?defaultValue:null;
        }
        seenModels.set(entry.model,{inputModalities,efforts:new Set(supportedReasoningEfforts.map(option=>option.reasoningEffort))});
        models.push({id:entry.id,model:entry.model,displayName:entry.displayName,description:entry.description,isDefault:entry.isDefault,inputModalities:[...inputModalities],supportedReasoningEfforts,defaultReasoningEffort});
      }
      cursor=result.nextCursor??null;
      if(cursor===null){this._modelCatalog={connection:c,revision,models:seenModels};return models;}
      if(seenCursors.has(cursor))throw invalid();seenCursors.add(cursor);
    }
    throw fault('CODEX_MODEL_LIST_INVALID','Codex 模型列表超过安全分页上限，请重新读取。',c.generation);
  }
  assertModelSelection(model,{requiresImages=false,effort}={}){
    const c=this._scope();this._assert(c);const catalog=this._modelCatalog;
    if(!this.state.ready||!this._accountVerified(c))throw fault('CODEX_ACCOUNT_NOT_READY','Codex 账号状态尚未就绪，请重新连接后再发送。',c?.generation);
    if(typeof model!=='string'||!catalog||!this._same(catalog.connection,c)||catalog.revision!==this._accountRevision||!catalog.models.has(model))throw Object.assign(fault('CODEX_MODEL_SELECTION_INVALID','所选模型不在当前账号的已核对模型列表中，请刷新后选择。',c.generation),{notSent:true});
    const capabilities=catalog.models.get(model);
    if(requiresImages&&!capabilities.inputModalities.includes('image'))throw Object.assign(fault('CODEX_MODEL_IMAGE_UNSUPPORTED','所选模型不支持图片，请移除图片或选择支持图片的模型。',c.generation),{notSent:true});
    if(effort!==undefined&&(typeof effort!=='string'||!capabilities.efforts.has(effort)))throw Object.assign(fault('CODEX_EFFORT_SELECTION_INVALID','所选推理强度不在当前模型的已核对选项中，请刷新后选择。',c.generation),{notSent:true});
  }
  async listSkills({toolStates={}}={}){
    const c=this._scope();this._assert(c);
    if(this.profile.id!=='model-workspace'||!this.state.ready||!this._accountVerified(c))
      throw fault('CODEX_SKILLS_UNAVAILABLE','当前连接无法核实 Skills，请先检查工作空间状态。',c?.generation);
    const revision=this._accountRevision,cwd=path.resolve(this.root);
    this._invalidateSkills();const sequence=this._skillsListSequence;
    const invalid=()=>fault('CODEX_SKILLS_UNAVAILABLE','Skills 列表不完整或无法核实，请重新读取。',c.generation);
    let result;
    try{result=await this.request('skills/list',{cwds:[cwd],forceReload:true},45000,c);}
    catch(error){this._assertAccount(c,revision);if(sequence!==this._skillsListSequence)throw invalid();throw invalid();}
    this._assertAccount(c,revision);
    if(sequence!==this._skillsListSequence||path.resolve(this.root)!==cwd||!this.state.ready||!this._accountVerified(c))throw invalid();
    if(!plain(result)||!Array.isArray(result.data)||result.data.length!==1)throw invalid();
    const row=result.data[0];
    const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
    if(!plain(row)||typeof row.cwd!=='string'||!path.isAbsolute(row.cwd)||!samePath(path.resolve(row.cwd),cwd)||
       !Array.isArray(row.errors)||row.errors.length!==0||!Array.isArray(row.skills)||row.skills.length>512)throw invalid();
    const seenNames=new Set(),seenPaths=new Set(),skills=new Map(),view=[],discovered=[];let retainedBytes=0;
    for(const entry of row.skills){
      if(!plain(entry)||typeof entry.enabled!=='boolean'||typeof entry.name!=='string'||!entry.name||entry.name.length>200||
         /[\x00-\x1f\x7f]/.test(entry.name)||typeof entry.description!=='string'||entry.description.length>4000||
         typeof entry.path!=='string'||!entry.path||entry.path.length>4096||entry.path.includes('\0')||!path.isAbsolute(entry.path)||
         !['user','repo','system','admin'].includes(entry.scope))throw invalid();
      if(!entry.enabled){if(this.skillCatalogMode==='customer')discovered.push({...entry});continue;}
      retainedBytes+=Buffer.byteLength(entry.name)+Buffer.byteLength(entry.description)+Buffer.byteLength(entry.path);
      if(retainedBytes>256*1024)throw invalid();
      const normalized=path.resolve(entry.path),key=process.platform==='win32'?normalized.toLowerCase():normalized;
      if(seenNames.has(entry.name)||seenPaths.has(key))throw invalid();
      seenNames.add(entry.name);seenPaths.add(key);
      const id=randomUUID();skills.set(id,Object.freeze({name:entry.name,path:entry.path}));
      if(this.skillCatalogMode==='customer')discovered.push({id,name:entry.name,path:entry.path,scope:entry.scope,enabled:true});
      else view.push({id,name:entry.name,description:entry.description});
    }
    if(this.skillCatalogMode==='customer'){
      // Dynamic tool registration does not prove current project or tool readiness.
      if(!this._skillCatalogOwner)throw fault('CODEX_SKILLS_UNAVAILABLE','客户技能目录所有者不可用。',c.generation);
      const customerView=this._skillCatalogOwner({root:cwd,discovered,toolStates});
      const allowed=new Set(customerView.filter(item=>item.selectable).map(item=>item.id));
      for(const id of skills.keys())if(!allowed.has(id))skills.delete(id);
      view.push(...customerView);
    }
    this._assertAccount(c,revision);if(sequence!==this._skillsListSequence)throw invalid();
    this._skillsCatalog={connection:c,revision,cwd,sequence,skills};return view;
  }
  _resolveSkillSelection(ids){
    const invalid=()=>Object.assign(fault('CODEX_SKILL_SELECTION_INVALID','所选 Skill 已失效或无法核实，请刷新列表后重新选择。'),{notSent:true});
    if(!Array.isArray(ids)||ids.length>8||ids.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))||new Set(ids).size!==ids.length)throw invalid();
    if(!ids.length)return [];
    const c=this._scope(),catalog=this._skillsCatalog;
    if(this.profile.id!=='model-workspace'||!this._current(c)||!this.state.ready||!this._accountVerified(c)||!catalog||
       !this._same(catalog.connection,c)||catalog.revision!==this._accountRevision||catalog.sequence!==this._skillsListSequence||
       catalog.cwd!==path.resolve(this.root)||ids.some(id=>!catalog.skills.has(id)))throw invalid();
    return ids.map(id=>catalog.skills.get(id));
  }
  assertSkillSelection(ids=[]){this._resolveSkillSelection(ids);}
  async turn(threadId,text,localImages=[],model,effort,skillIds=[]){
    const c=this._scope();this._assert(c);if(!this.state.ready||!this._accountVerified(c))throw fault('CODEX_ACCOUNT_NOT_READY','Codex 账号状态尚未就绪，请重新连接后再发送。',c?.generation);
    const params=nativeTurnParams(threadId,text,localImages,this.profile.supportsTurnAttachments===true);
    if(effort!==undefined&&model===undefined)throw Object.assign(fault('CODEX_EFFORT_SELECTION_INVALID','选择推理强度前请先选择模型。',c.generation),{notSent:true});
    if(model!==undefined){this.assertModelSelection(model,{requiresImages:localImages.length>0,effort});params.model=model;}
    if(effort!==undefined)params.effort=effort;
    for(const skill of this._resolveSkillSelection(skillIds))params.input.push({type:'skill',name:skill.name,path:skill.path});
    if(Buffer.byteLength(JSON.stringify({id:Number.MAX_SAFE_INTEGER,method:'turn/start',params})+'\n')>OUTBOUND_FRAME_BYTES)
      throw Object.assign(fault('CODEX_TURN_INPUT_INVALID','本轮内容过大，请减少选中的 Skill。',c.generation),{notSent:true});
    return this.request('turn/start',params,45000,c);
  }
  async steer(threadId,turnId,text,requestId){
    const c=this._scope();this._assert(c);if(!this.state.ready||!this._accountVerified(c))throw Object.assign(fault('CODEX_ACCOUNT_NOT_READY','Codex 账号状态尚未就绪，请重新连接。',c?.generation),{notSent:true});
    if(typeof turnId!=='string'||!turnId||turnId.length>200||typeof requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))throw Object.assign(fault('CODEX_STEER_INVALID','补充指令的轮次或请求身份无效。',c?.generation),{notSent:true});
    const revision=this._accountRevision,base=nativeTurnParams(threadId,text),params={...base,expectedTurnId:turnId,clientUserMessageId:requestId};
    const result=await this.request('turn/steer',params,45000,c);this._assertAccount(c,revision);
    if(!plain(result)||result.turnId!==turnId)throw fault('CODEX_STEER_UNCONFIRMED','补充指令回执无法核对，请勿自动重试。',c.generation);
    return result;
  }
  async interrupt(threadId,turnId){return this.request('turn/interrupt',{threadId,turnId});}
  _waitForClose(c,timeout){
    if(c.closed)return Promise.resolve();
    return new Promise(resolve=>{const done=()=>{clearTimeout(timer);c.closeWaiters.delete(done);resolve();};const timer=setTimeout(done,timeout);c.closeWaiters.add(done);});
  }
  async close(){
    // Dispose any unconsumed one-shot credential, including close before start.
    this.#apiProvider?.dispose();
    const c=this._connection;
    if(!c){if(this.child)throw fault('CODEX_CLEANUP_UNCONFIRMED','Codex 关闭结果未确认，仍保留连接资源。');this.failed('正在重新连接本地 Codex…');return {closed:true,generation:this._generation};}
    if(c.closePromise)return c.closePromise;c.phase='closing';this._diagnostic(c,'closing','codex_close_requested');
    this._clear(c);this._rejectPending(c,fault('CODEX_CLOSING','Codex 连接正在关闭；旧请求不会重新执行。',c.generation));this.failed('正在重新连接本地 Codex…');
    c.closePromise=(async()=>{
      if(!c.stdinEnded){c.stdinEnded=true;try{c.child.stdin?.end();}catch{/* Retain exact owned child for cleanup retry. */}}
      await this._waitForClose(c,this._deps.closeTimeoutMs);
      if(!c.closed){this._diagnostic(c,'closing','codex_kill_requested');try{c.child.kill();}catch{/* Kill is not close confirmation. */}await this._waitForClose(c,this._deps.killTimeoutMs);}
      if(!c.closed){this._diagnostic(c,'cleanup_pending','codex_cleanup_unconfirmed');this.error='Codex 关闭结果未确认，请重试清理；不会启动重叠进程。';this.emit('state',this.state);throw fault('CODEX_CLEANUP_UNCONFIRMED',this.error,c.generation);}
      return {closed:true,generation:c.generation};
    })();
    try{return await c.closePromise;}finally{c.closePromise=null;}
  }
}
