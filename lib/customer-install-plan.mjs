import path from 'node:path';
import {verifyCustomerChatPackage,cleanupCustomerChatPackageReads} from './customer-chat-package.mjs';

// This composition only reads a current-source candidate through its existing
// verifier. A proposal is neither an installation receipt nor write authority.
export const cleanupCustomerInstallPlan=cleanupCustomerChatPackageReads;
const operations=new Set(['install','upgrade','rollback']);
const inputKeys=new Set(['root','artifact','targetRoot','operation']);
const invalid=message=>({ok:false,error:{code:'INVALID_INSTALL_PLAN_INPUT',message}});
const reserved=/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i;

function captureInput(input){
  if(input===null||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return null;
  const captured={};
  for(const key of Reflect.ownKeys(input)){
    if(typeof key!=='string'||!inputKeys.has(key))return null;
    const descriptor=Object.getOwnPropertyDescriptor(input,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value'))return null;
    captured[key]=descriptor.value;
  }
  if(!Object.hasOwn(captured,'operation'))captured.operation='install';
  return captured;
}

function proposedWindowsRoot(value){
  if(typeof value!=='string'||!value||! /^[a-zA-Z]:[\\/]/.test(value)||/[<>"|?*:\x00-\x1f]/.test(value.slice(2)))return null;
  const parts=value.slice(3).split(/[\\/]/);
  // Reject aliases before normalizing, rather than hiding a dot/device/ADS
  // path behind a display string. No directory or ancestor is inspected here.
  if(!parts.length||parts.some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||part.length>255||reserved.test(part.split('.')[0].replace(/ +$/,''))))return null;
  const normalized=value[0].toUpperCase()+':\\'+parts.join('\\');
  // Derived proposal paths must fit the Windows UTF-16 path limit. Whether
  // long paths are enabled on the eventual machine remains unobserved.
  if(path.win32.join(normalized,'releases','0'.repeat(64)).length>=32767)return null;
  return normalized;
}

export async function planCustomerInstall(input={}){
  let options;try{options=captureInput(input);}catch{return invalid('安装计划参数无法确定，未读取组件或目标。');}
  if(!options||!operations.has(options.operation)||typeof options.root!=='string'||!path.isAbsolute(options.root)||typeof options.artifact!=='string'||!path.isAbsolute(options.artifact))return invalid('只接受当前工程、组件绝对路径、提议的Windows目标根和install/upgrade/rollback计划操作。');
  const target=proposedWindowsRoot(options.targetRoot);
  if(!target)return invalid('目标仅接受明确的本机Windows绝对目录；不接受UNC、设备、根目录、相对路径、点分段、ADS或保留名称等歧义。');
  const verified=await verifyCustomerChatPackage({root:options.root,output:options.artifact});
  // In particular, keep the verifier's exact cleanupIds and primaryCodes. Do
  // not manufacture a second cleanup owner or retry verification implicitly.
  if(!verified.ok)return verified;
  const value=verified.value,metadata=value.buildManifest;
  if(!metadata||metadata.path!=='BUILD-MANIFEST.json'||typeof metadata.sha256!=='string'||!/^[a-f0-9]{64}$/.test(metadata.sha256)||!Number.isSafeInteger(metadata.byteLength)||metadata.byteLength<1)return {ok:false,error:{code:'INSTALL_PLAN_EVIDENCE_UNAVAILABLE',message:'验证器未提供同次读取的最终清单证据；未生成安装计划。'}};
  const releaseDirectory=path.win32.join(target,'releases',metadata.sha256);
  const blockers=[
    {code:'TARGET_IDENTITY_NOT_CHECKED',status:'not_checked',message:'目标及祖先的存在性、物理身份、链接与访问权限未检查；词法路径不是安全或空目录证明。'},
    {code:'ACTIVE_RELEASE_NOT_CHECKED',status:'not_checked',message:'当前激活版本及原选择回执未知；不推断首次安装、升级顺序或可回退版本。'},
    {code:'PROCESS_OWNERSHIP_NOT_CHECKED',status:'not_checked',message:'进程、监听、空闲与准确关闭未检查；没有启动、停止或切换服务。'},
    {code:'DATA_DIRECTORY_ADMISSION_NOT_CHECKED',status:'not_checked',message:'入口已要求显式BUILDX_DATA_ROOT、预存workspace与独立run；本计划未选择或核对实际数据目录、启动用户及写入适用性，代码接线不证明安装环境可用。'},
    {code:'HISTORICAL_RELEASE_TRUST_UNAVAILABLE',status:'blocked',message:'本计划只核对当前源码候选；登记版本可经独立只读入口核对字节，但本计划未选择或核对历史定义、撤销与安装适用性。产物自报清单或已知字节都不能授权回退。'},
    {code:'EXTERNAL_RUNTIME_AND_ACCOUNT_NOT_CHECKED',status:'not_checked',message:'启动用户、外部Node/Codex/Python、CODEX_HOME、专用认证配置未检查；不复制凭据或自动安装运行时。'},
    {code:'COMMERCIAL_ACCEPTANCE_PENDING',status:'blocked',message:'组件releaseReady=false；许可、产品权限、真实账号、客户端及安装验收尚未完成。'},
  ];
  return {ok:true,value:{
    schemaVersion:1,kind:'buildx-customer-component-install-plan',operation:options.operation,
    planOnly:true,readyToApply:false,releaseReady:false,
    artifact:{path:value.output,requestedPath:options.artifact,requestedSourceRoot:options.root,component:value.component,stage:value.stage,
      verifiedAgainst:'current_source_manifest',inputManifestSha256:value.inputManifestSha256,
      releaseIdentityKind:'build_manifest_sha256',releaseId:metadata.sha256,buildManifest:{...metadata},
      fileCount:value.fileCount,payloadBytesExcludingBuildManifest:value.totalBytes,
      totalFileBytes:value.totalBytes+metadata.byteLength},
    target:{requestedRoot:options.targetRoot,normalizedRoot:target,releaseDirectory,
      observation:'not_checked',physicalIdentity:'not_checked',existence:'not_checked',activeRelease:'not_checked',longPathSupport:'not_checked'},
    steps:[
      {id:'review_candidate',status:'verified_current_source',effect:'读取并核对当前未运行候选；此事实不授权写入。'},
      {id:'stage_release',status:'proposal_only',destination:releaseDirectory,replaceExisting:false,effect:'未来可在明确授权并复核身份后暂存独立版本；本计划未创建、复制或覆盖文件。'},
      {id:'select_release',status:'blocked',intent:options.operation,effect:'仅提议版本选择；没有active指针写入，不代表存活进程已切换。'},
      {id:'activate_and_verify',status:'blocked',effect:'须明确并核对实际数据目录、workspace及启动用户，再取得进程归属/空闲/关闭与具体启动授权；本计划没有执行。'},
    ],
    blockers,
    recovery:{globalRollback:false,retainedReleaseReceipt:'not_checked',
      codeSelectionDoesNotRestore:['BuildX登录与Codex连接确认','内存对话与上下文','日志及运行数据','云端状态','在途任务或未知执行结果'],
      unknownResultsAutomaticallyReplayed:false},
    sideEffects:{targetInspectionPerformed:false,targetMutationAttempted:false,
      filesystemScope:'current_source_and_artifact_verification_only',configurationChanges:0,
      processQueries:0,processControls:0,serviceStarts:0,cloudCalls:0},
    limitations:['文件核对不是签名信任、操作系统沙盒、安装成功或发布许可。','计划没有持续资源句柄或跨进程授权令牌；实际执行前必须重新核对。'],
  }};
}
