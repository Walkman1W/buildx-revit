import path from 'node:path';
import {CodexClientCore} from './codex-client-core.mjs';
import {createPanelServerCore} from './panel-server-core.mjs';
import {createCustomerChatProfile} from './customer-chat-profile.mjs';
import {buildxRuntimeConfig} from './buildx-runtime-config.mjs';

const layoutKeys=new Set(['resourceRoot','dataRoot','codexHome']);
const applicationKeys=new Set(['root','accountAuth','codex','codexCwd','port','audit','auditLifecycle','turnTimeout','cancelTimeout']);
const reservedWindowsName=/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i;
const layoutFailure=()=>({ok:false,error:{code:'CUSTOMER_LAYOUT_INVALID',message:'客户目录只接受词法分离的本机Windows绝对目录；不接受相对、设备、UNC、ADS、点分段或别名歧义。'}});
function captureData(input,allowed){
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return null;
  const snapshot=Object.create(null);
  for(const key of Reflect.ownKeys(input)){
    if(typeof key!=='string'||!allowed.has(key))return null;
    const descriptor=Object.getOwnPropertyDescriptor(input,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value'))return null;
    snapshot[key]=descriptor.value;
  }
  return snapshot;
}
function windowsDirectory(value){
  if(typeof value!=='string'||value.length>=32767||! /^[a-zA-Z]:[\\/]/.test(value)||/[<>"|?*:\x00-\x1f]/.test(value.slice(2)))return null;
  const parts=value.slice(3).split(/[\\/]/);
  if(!parts.length||parts.some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||part.length>255||reservedWindowsName.test(part.split('.')[0].replace(/ +$/,''))))return null;
  const normalized=value[0].toUpperCase()+':\\'+parts.join('\\');
  return normalized.length<32767?normalized:null;
}
function overlap(left,right){
  const a=left.toLowerCase(),b=right.toLowerCase();
  return a===b||a.startsWith(b+'\\')||b.startsWith(a+'\\');
}
function configurationError(code,message){return Object.assign(new Error(message),{code});}

// Pure application directory roles. Lexical separation neither inspects a
// target nor grants write authority. Entry composition observes/consumes these
// roles separately; this pure result itself performs no entry integration.
export function customerChatLayout(input={}){
  try{
    const selected=captureData(input,layoutKeys);if(!selected)return layoutFailure();
    const resourceRoot=windowsDirectory(selected.resourceRoot),dataRoot=windowsDirectory(selected.dataRoot);
    if(!resourceRoot||!dataRoot||overlap(resourceRoot,dataRoot))return layoutFailure();
    const homeSpecified=Object.hasOwn(selected,'codexHome'),home=homeSpecified?windowsDirectory(selected.codexHome):null;
    if(homeSpecified&&!home)return layoutFailure();
    const runtime=path.win32.join(dataRoot,'runtime','customer-chat'),codexCwd=path.win32.join(dataRoot,'workspace');
    if(runtime.length>=32767||codexCwd.length>=32767)return layoutFailure();
    return {ok:true,value:Object.freeze({schemaVersion:1,resourceRoot,dataRoot,runtime,codexCwd,
      requested:Object.freeze({resourceRoot:selected.resourceRoot,dataRoot:selected.dataRoot,codexHome:homeSpecified?selected.codexHome:null}),
      codexHome:Object.freeze({selection:homeSpecified?'provided_absolute':'existing_core_default_unobserved',path:home,credentialsRead:false}),
      separation:'lexical_only',observations:Object.freeze({physicalIdentity:'not_checked',writable:'not_checked',links:'not_checked'}),
      entryIntegrated:false,writeAuthorized:false,filesystemInspectionPerformed:false,
      limitations:Object.freeze(['词法不同不证明物理目录不同或可写；未检查junction、权限或存活进程。','此数据不创建目录、不改环境或凭据；默认Codex主目录仍由既有Core后续解析。'])})};
  }catch{return layoutFailure();}
}

// A dedicated entry cannot be downgraded with the old research-mode switch.
// Read only these three named values; never persist the ambient environment.
export function customerChatConfiguration(env=process.env){
  if(env.BUILDX_MODE!==undefined&&env.BUILDX_MODE!=='customer')throw new Error('客户聊天入口只接受 customer 模式。');
  const selected={BUILDX_MODE:'customer'};
  for(const name of ['BUILDX_SUPABASE_URL','BUILDX_SUPABASE_PUBLISHABLE_KEY'])
    if(Object.hasOwn(env,name))selected[name]=env[name];
  return buildxRuntimeConfig(selected);
}

// Application composition only, not an HTTP-supplied profile or tool registry.
// A supplied test Codex/provider remains subject to the same core invariants.
export function createCustomerChatServer(options){
  let selected;try{selected=captureData(options,applicationKeys);}catch{}
  if(!selected)throw configurationError('CUSTOMER_APPLICATION_INVALID','客户聊天只接受固定应用配置。');
  const {root,accountAuth,codex,port=41875,audit,auditLifecycle,turnTimeout=null,cancelTimeout=15000}=selected;
  if(!Object.hasOwn(selected,'root')||!Object.hasOwn(selected,'accountAuth')||typeof root!=='string'||!path.isAbsolute(root)||!accountAuth||!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('客户聊天必须配置专用账号后端与本机根目录。');
  const home=Object.hasOwn(process.env,'CODEX_HOME')?process.env.CODEX_HOME:undefined;
  if(home!==undefined&&!windowsDirectory(home))throw configurationError('CUSTOMER_CODEX_HOME_INVALID','CODEX_HOME 必须是明确的本机Windows绝对目录；不会在新工作目录下猜测登录配置。');
  let workspace=root;
  if(Object.hasOwn(selected,'codexCwd')){
    const resource=windowsDirectory(root),cwd=windowsDirectory(selected.codexCwd);
    if(!resource||!cwd||overlap(resource,cwd))throw configurationError('CUSTOMER_LAYOUT_INVALID','客户Codex工作目录必须是与资源目录词法分离的本机Windows绝对目录。');
    workspace=cwd;
  }
  const composition=createCustomerChatProfile();
  return createPanelServerCore({root,accountAuth,requireAccount:true,
    codex:codex??new CodexClientCore(workspace,composition.codex),selection:composition.panel,
    port,audit,auditLifecycle,turnTimeout,cancelTimeout});
}
