// BuildX-owned candidate for launching Codex with one user-selected Responses
// endpoint. This module does not save credentials, modify Codex configuration,
// connect to any endpoint, or prove a provider supports Codex tool calls.
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const LEGACY_ENV_KEY='BUILDX_PROVIDER_API_KEY';
// This public sentinel is a fixed test value, never an actual credential.
// Real API credentials cannot be supplied to this experimental launcher.
export const ISOLATED_API_FIXTURE_KEY='buildx-isolated-fixture-key';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const ownData=value=>plain(value)&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const exact=(value,keys)=>ownData(value)&&Reflect.ownKeys(value).every(key=>keys.includes(key));
const safeText=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const invalid=()=>new Error('API 连接配置无效。');

export function validateApiProvider(input={}){
  if(!exact(input,['baseUrl','model','allowLoopbackHttp','apiKey']))throw invalid();
  const {baseUrl,model,allowLoopbackHttp=false}=input;
  if(!safeText(baseUrl,2048)||!safeText(model,200)||model.trim()!==model||baseUrl.trim()!==baseUrl||typeof allowLoopbackHttp!=='boolean')throw invalid();
  let url;try{url=new URL(baseUrl);}catch{throw invalid();}
  // The supplied address is a base URL, not a credential container. The
  // original value is kept because path and trailing-slash semantics matter.
  if(url.username||url.password||baseUrl.includes('?')||baseUrl.includes('#')||!url.hostname||!['http:','https:'].includes(url.protocol))throw invalid();
  if(url.protocol==='http:'&&!(allowLoopbackHttp&&['127.0.0.1','[::1]'].includes(url.hostname)))throw invalid();
  return Object.freeze({baseUrl,model});
}

// The caller supplies a transient key, obtained through its own approved
// credential owner. Key material is captured privately, not returned by this
// object, printed, persisted, or embedded into Codex configuration arguments.
// The environment necessarily reaches the app-server process. A fresh random
// variable name prevents pre-existing static MCP env_vars from naming it, but
// does not isolate same-user processes or plugins that can inspect the parent.
export function createApiProviderLaunch(input){
  if(!exact(input,['baseUrl','model','apiKey','allowLoopbackHttp'])||!Object.hasOwn(input,'apiKey'))throw invalid();
  const {baseUrl,model}=validateApiProvider(input);
  const url=new URL(baseUrl);
  // No local client can keep a product-owned shared key secret from the
  // customer. Until a trusted remote credential boundary exists, the only
  // permitted execution is an explicitly selected literal loopback fixture.
  // Validation may still describe an HTTPS endpoint for future design work;
  // description is not authority to send a request or launch a process.
  const fixtureOnly=input.allowLoopbackHttp===true&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname);
  if(!fixtureOnly){const error=new Error('远程 API 启动未开放：需要受控服务端凭据边界。');error.code='API_REMOTE_DISABLED';throw error;}
  if(input.apiKey!==ISOLATED_API_FIXTURE_KEY){const error=new Error('此内部候选只接受公开的隔离测试标记，不接受真实密钥。');error.code='API_FIXTURE_KEY_REQUIRED';throw error;}
  if(!safeText(input.apiKey,16384)||input.apiKey.trim()!==input.apiKey)throw invalid();
  if(baseUrl.includes(input.apiKey)||model.includes(input.apiKey))throw invalid();
  let key=input.apiKey,used=false;
  // Random selection identity never derives from a key or endpoint.
  const providerRevision=randomUUID();
  // A fixed provider table can merge with arbitrary user config under that
  // same name. A fresh opaque identifier prevents pre-existing static tables
  // from silently changing headers, query parameters, or authentication.
  const PROVIDER='buildx_api_'+randomUUID().replaceAll('-','');
  const envKey='BUILDX_API_'+randomUUID().replaceAll('-','');
  const configOverrides=Object.freeze([
    '-c',`model_provider=${JSON.stringify(PROVIDER)}`,
    '-c',`model_providers.${PROVIDER}.name=${JSON.stringify('BuildX API')}`,
    '-c',`model_providers.${PROVIDER}.base_url=${JSON.stringify(baseUrl)}`,
    '-c',`model_providers.${PROVIDER}.env_key=${JSON.stringify(envKey)}`,
    '-c',`model_providers.${PROVIDER}.wire_api=${JSON.stringify('responses')}`,
    '-c',`model_providers.${PROVIDER}.requires_openai_auth=false`,
    '-c',`model_providers.${PROVIDER}.supports_websockets=false`,
    '-c',`model=${JSON.stringify(model)}`,
  ]);
  if(configOverrides.some(value=>value.includes(input.apiKey)))throw invalid();
  const identity=Object.freeze({type:'api_key',providerId:PROVIDER,providerRevision,model});
  const describe=()=>Object.freeze({identity,baseUrl,wireApi:'responses',status:'unverified'});
  function start({spawn,executable,baseArgs,cwd,env}={}){
    if(used||typeof spawn!=='function'||!safeText(executable,4096)||!path.isAbsolute(executable)||executable.includes(key)||!safeText(cwd,4096)||!path.isAbsolute(cwd)||cwd.includes(key)||
       !Array.isArray(baseArgs)||baseArgs.length>1000||baseArgs.some(value=>typeof value!=='string'||value.length>16384||value.includes('\0')||value.includes(key))||!ownData(env))throw invalid();
    // Only a trusted launch owner can supply env and spawn; never log these
    // arguments. Remove built-in auth variables so this provider is not
    // accidentally treated as the user's ChatGPT or OpenAI API identity.
    const childEnv={};
    for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(env))){
      // Windows environment names are not POSIX shell identifiers (for
      // example ProgramFiles(x86)). Node accepts any nonempty name without
      // NUL or '='; validate those actual environment-block constraints.
      if(!name||/[=\0]/.test(name)||typeof descriptor.value!=='string'||descriptor.value.includes('\0'))throw invalid();
      if(!['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN',LEGACY_ENV_KEY,envKey.toUpperCase()].includes(name.toUpperCase()))childEnv[name]=descriptor.value;
    }
    childEnv[envKey]=key;used=true;key=null;
    try{return spawn(executable,[...baseArgs,...configOverrides],{cwd,env:childEnv,windowsHide:true,stdio:['pipe','pipe','pipe']});}
    catch{throw new Error('API 服务启动失败。');}
  }
  function dispose(){used=true;key=null;}
  return Object.freeze({describe,configOverrides,start,dispose});
}
