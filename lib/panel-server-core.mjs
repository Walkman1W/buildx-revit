import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {ChatSession,safeChatText,boundedChatNotification} from './chat-session.mjs';
import {captureChatContext,contextOptions,withChatContext} from './chat-context.mjs';
import {createPanelAccounts} from './panel-accounts.mjs';
import {createCodexConfirmation} from './codex-confirmation.mjs';
import {createModelPermissionOwner,modelPermissionErrorView,validateModelOperationParameters,isRecoverableModelScriptReceipt} from './model-permission-owner.mjs';
import {modelOperationEffect} from './model-operation-effects.mjs';
import {sameWorkbenchDocumentIdentity} from './workbench-contracts.mjs';
import {panelConversationId} from './panel-chat-format.mjs';
import {createVisualArtifactOwner} from './visual-artifact-owner.mjs';
import {describeModelOperationSchema} from './model-operation-contracts.mjs';
import {isNativeTypeParameterWrite} from './native-type-parameter-writes.mjs';
import {issueTypeWriteUserDecision} from './type-parameter-write-approval.mjs';

function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req,budget=128*1024){
  // History-enabled /turn carries two 16,000 UTF-16 strings: input and draft.
  // Each character may expand to six bytes as JSON escapes. Other routes keep
  // their original 128 KiB limit; field-level budgets remain unchanged.
  const declared=req.headers['content-length'];
  if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>budget))throw new Error('输入超过本地请求预算');
  const bytes=Buffer.alloc(declared===undefined?budget+1:Number(declared));let length=0;
  for await(const chunk of req){if(length+chunk.length>budget)throw new Error('输入超过本地请求预算');chunk.copy(bytes,length);length+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));
}
const validClient=value=>typeof value==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(value);
const plainData=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const validCommandSourceDocument=value=>plainData(value)&&Object.keys(value).length===3&&['session','title','path'].every(key=>typeof value[key]==='string')&&value.session.length>0;
function approvedFamilyFacts(result,document,handle){
  const job=result?.value,save=job?.save,validString=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
  if(!plainData(result)||result.operation!=='family_inspect_job'||result.hostSession!==document.session||!plainData(job)||job.operation!=='family_inspect_job'||job.host_session!==document.session||job.success!==true||job.code!=='FAMILY_JOB_INSPECTED'||job.job_handle!==handle||job.job_scope!=='bound_project'||job.core_registry_current!==true||job.cleanup_pending!==false||!validString(job.project_handle,1024)||!validString(job.project_fingerprint,1024)||!plainData(save)||save.state!=='saved_reopened_verified_closed'||save.independently_reopened_verified!==true||!validString(save.path,2048)||!path.win32.isAbsolute(save.path)||!save.path.toLowerCase().endsWith('.rfa')||typeof save.sha256!=='string'||!/^[a-f0-9]{64}$/.test(save.sha256)||job.effects?.project_load?.outcome==='unknown')throw new Error('Family job facts unavailable');
  return Object.freeze({job_handle:handle,project_handle:job.project_handle,project_fingerprint:job.project_fingerprint,save:Object.freeze({path:save.path,sha256:save.sha256})});
}
function sameApprovedFamily(a,b){return Boolean(a&&b&&a.job_handle===b.job_handle&&a.project_handle===b.project_handle&&a.project_fingerprint===b.project_fingerprint&&a.save?.path===b.save?.path&&a.save?.sha256===b.save?.sha256);}
// Only the trusted host's inspection can supply this token. It is never read
// from a tool argument or an HTTP request, and the preview omits both tokens.
function approvedLifecycleFacts(result,document,handle,tool){
  const job=result?.value,approval=job?.approval,review=approval?.review,save=review?.save;
  const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
  const expiresAt=typeof approval?.expires_utc==='string'?Date.parse(approval.expires_utc):NaN,operation=tool.slice('revit_'.length),token=operation==='family_save_job'?approval?.save_token:approval?.close_token;
  if(!['family_save_job','family_close_job'].includes(operation)||!plainData(result)||result.operation!=='family_inspect_job'||result.hostSession!==document.session||!plainData(job)||job.operation!=='family_inspect_job'||job.host_session!==document.session||job.success!==true||job.code!=='FAMILY_JOB_INSPECTED'||job.job_handle!==handle||job.job_scope!=='bound_project'||job.core_registry_current!==true||job.cleanup_pending!==false||!plainData(approval)||approval.schema_version!==1||typeof approval.change_version!=='string'||!/^\d+$/.test(approval.change_version)||!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+120000||typeof token!=='string'||!/^[a-f0-9]{32}$/.test(token)||!plainData(review)||review.host_session!==document.session||!Number.isSafeInteger(review.revit_pid)||review.revit_pid<1||review.revit_pid!==job.revit_pid||review.job_handle!==handle||review.project_handle!==job.project_handle||review.project_fingerprint!==job.project_fingerprint||!text(review.project_handle,1024)||!text(review.project_fingerprint,1024)||!text(review.template_id,120)||!(operation==='family_close_job'&&review.template_sha256===null||typeof review.template_sha256==='string'&&/^[a-f0-9]{64}$/.test(review.template_sha256))||!text(review.stage,120)||!text(review.build_state,120)||typeof review.build_complete!=='boolean'||typeof review.owned!=='boolean'||typeof review.resource_retained!=='boolean'||typeof review.ownership_conflict!=='boolean'||typeof review.family_document_live!=='boolean'||!(review.family_document_modified===null||typeof review.family_document_modified==='boolean')||review.cleanup_pending!==false||!plainData(save)||typeof save.attempted!=='boolean'||!text(save.state,120)||!(save.path===null||typeof save.path==='string')||!(save.sha256===null||typeof save.sha256==='string'&&/^[a-f0-9]{64}$/.test(save.sha256))||typeof save.independently_reopened_verified!=='boolean'||Buffer.byteLength(JSON.stringify(review),'utf8')>60000)throw new Error('Family lifecycle approval unavailable');
  if(!plainData(job.save)||['attempted','state','path','sha256','independently_reopened_verified'].some(key=>job.save[key]!==save[key])||job.stage!==review.stage||job.build_state!==review.build_state)throw new Error('Family approval does not match its inspection');
  if(operation==='family_save_job'&&(!review.build_complete||!review.family_document_live||save.attempted))throw new Error('Family is not ready for save');
  return {review:structuredClone(review),expiresAt,approvedLifecycle:{schema_version:1,operation,approval_token:token},approvedFamilyIdentity:{job_handle:handle,project_handle:review.project_handle,project_fingerprint:review.project_fingerprint,template:{template_id:review.template_id,sha256:review.template_sha256},save:structuredClone(save)}};
}
// User-input requests are transient protocol data, never chat history or authority.
function parseUserQuestions(value){
  const text=(v,n)=>typeof v==='string'&&v.trim().length>0&&v.length<=n;
  if(!plainData(value)||!text(value.threadId,200)||!text(value.turnId,200)||!text(value.itemId,200)||typeof value.isBlocking!=='boolean'||!Array.isArray(value.questions)||value.questions.length<1||value.questions.length>3)return null;
  const ids=new Set(),questions=[];
  for(const q of value.questions){
    if(!plainData(q)||!text(q.id,100)||ids.has(q.id)||!text(q.header,100)||!text(q.question,2000)||q.isSecret===true||q.isOther!==undefined&&typeof q.isOther!=='boolean'||q.isSecret!==undefined&&typeof q.isSecret!=='boolean'||q.options!==undefined&&q.options!==null&&!Array.isArray(q.options))return null;
    ids.add(q.id);const options=q.options??[];if(options.length>10||options.some(o=>!plainData(o)||!text(o.label,300)||typeof o.description!=='string'||o.description.length>1000)||new Set(options.map(o=>o.label)).size!==options.length)return null;
    questions.push({id:q.id,header:q.header,question:q.question,isOther:q.isOther===true,options:options.map(o=>({label:o.label,description:o.description}))});
  }
  return {threadId:value.threadId,turnId:value.turnId,itemId:value.itemId,isBlocking:value.isBlocking,questions};
}
const commandFailureOutcomes=Object.freeze({COMMAND_INPUT_INVALID:'not_started',COMMAND_NO_DOCUMENT:'not_started',COMMAND_HOST_UNAVAILABLE:'not_started',COMMAND_NOT_STARTED:'not_started',COMMAND_REQUEST_EXPIRED:'expired',COMMAND_QUERY_FAILED:'failed'});
const CABINET_WRITE_IDS=Object.freeze(['revit_family_create_cabinet','revit_family_save_cabinet','revit_family_close_cabinet']);
const CABINET_BLOCK_REASON='柜族写入暂不可用：未知回执尚不能在账号切换或进程重启后安全恢复，且动态与面板写入尚未共用保护门。';
// Only bounded producer facts cross the display boundary. These facts never
// select an operation or turn an unconfirmed command into a confirmed failure.
function commandNativeFailure(value){
  if(!plainData(value))return null;
  const facts={};
  for(const [key,limit] of [['code',160],['phase',80],['outcome',24],['requestId',36],['hostSession',32],['completedUtc',40]]){const entry=Object.getOwnPropertyDescriptor(value,key);if(entry&&Object.hasOwn(entry,'value')&&typeof entry.value==='string'&&entry.value.length<=limit)facts[key]=entry.value;}
  for(const key of ['started','reason']){const entry=Object.getOwnPropertyDescriptor(value,key);if(entry&&Object.hasOwn(entry,'value')&&(key==='started'?typeof entry.value==='boolean':entry.value===null||entry.value==='expired'))facts[key]=entry.value;}
  return Object.keys(facts).length?facts:null;
}
const INTERRUPTION_NOTICE=Object.freeze({code:'turn_result_unknown',message:'上一轮对话的结果未知；请核对后再明确发起新消息。'});
function captureReceiptOwner(value){
  if(!plainData(value)||!Object.isFrozen(value))return null;
  const methods={};for(const key of ['inspect','close']){const entry=Object.getOwnPropertyDescriptor(value,key);if(!entry||!Object.hasOwn(entry,'value')||typeof entry.value!=='function')return null;methods[key]=(...args)=>entry.value.call(value,...args);}
  return Object.freeze(methods);
}

// Trusted application resource owner, never an HTTP option or a parsed DTO.
// Capture the original methods once so writes and cleanup cannot drift apart.
function captureAuditLifecycle(owner){
  if(owner===null||owner===undefined)return null;
  try{
    if(!owner||typeof owner!=='object'||!Object.isFrozen(owner))throw new Error();
    const methods={};
    for(const name of ['audit','ready','close','cleanup']){
      const descriptor=Object.getOwnPropertyDescriptor(owner,name);
      if(!descriptor||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function')throw new Error();
      methods[name]=descriptor.value;
    }
    return Object.freeze({audit:methods.audit,ready:()=>methods.ready.call(owner),close:()=>methods.close.call(owner),cleanup:id=>methods.cleanup.call(owner,id)});
  }catch{throw new Error('Panel audit lifecycle requires one immutable trusted owner');}
}

function captureHistoryStore(owner){
  if(owner===null||owner===undefined)return null;
  if(!Object.isFrozen(owner))throw new Error('Conversation store requires an immutable trusted owner');
  const methods={};
  for(const name of ['ready','list','get','save','close','cleanup']){
    const descriptor=Object.getOwnPropertyDescriptor(owner,name);
    if(!descriptor||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function')throw new Error('Invalid conversation store owner');
    methods[name]=(...args)=>descriptor.value.call(owner,...args);
  }
  for(const name of ['saveTurnAttachments','readTurnAttachment']){
    const descriptor=Object.getOwnPropertyDescriptor(owner,name);
    if(descriptor!==undefined){if(!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function')throw new Error('Invalid attachment store owner');methods[name]=(...args)=>descriptor.value.call(owner,...args);}
  }
  return Object.freeze(methods);
}

// Internal-only capability owner. No HTTP input can install or replace it.
function captureDynamicApprovalOwner(owner){
  if(owner===null||owner===undefined)return null;
  if(!owner||typeof owner!=='object'||!Object.isFrozen(owner))throw new Error('Dynamic approval requires an immutable trusted owner');
  const methods={};
  for(const name of ['propose','decide','cancel','close']){
    const item=Object.getOwnPropertyDescriptor(owner,name);
    if(!item||!Object.hasOwn(item,'value')||typeof item.value!=='function')throw new Error('Invalid dynamic approval owner');
    methods[name]=(...args)=>item.value.call(owner,...args);
  }
  return Object.freeze(methods);
}


// Internal composition data comes from the application, never HTTP input. The
// core owns consumption of one immutable selection, but does not import model
// catalogs or source-development implementations to discover it.
function trustedPanelComposition(value){
  const seen=new Set(),data=entry=>entry!==null&&typeof entry==='object'&&!Array.isArray(entry)&&
    [Object.prototype,null].includes(Object.getPrototypeOf(entry));
  const frozen=entry=>{
    if(entry===null||typeof entry!=='object'||seen.has(entry))return true;
    if(!Object.isFrozen(entry)||!Array.isArray(entry)&&!data(entry))return false;
    seen.add(entry);
    return Reflect.ownKeys(entry).every(key=>typeof key==='string'&&
      Object.hasOwn(Object.getOwnPropertyDescriptor(entry,key),'value')&&frozen(Object.getOwnPropertyDescriptor(entry,key).value));
  };
  if(!data(value)||!frozen(value)||!data(value.workspace)||!['model','source-development','customer-chat'].includes(value.workspace.kind)||value.workspace.supportsModelContext!==(value.workspace.kind==='model')||!Array.isArray(value.catalog)||value.catalog.length>128)throw new Error('Panel core requires immutable trusted composition');
  if(value.catalog.some(item=>!data(item)||typeof item.name!=='string'||!item.name||typeof item.label!=='string')||new Set(value.catalog.map(item=>item.name)).size!==value.catalog.length)throw new Error('Invalid panel composition catalog');
  for(const key of ['cancelMessage','interruptUnconfirmed','interruptTimeout','stopUnknown'])if(typeof value[key]!=='string'||value[key].length>4096)throw new Error('Invalid panel composition notices');
  if(value.sessionNotices!==undefined&&(!data(value.sessionNotices)||Object.values(value.sessionNotices).some(text=>typeof text!=='string'||text.length>4096)))throw new Error('Invalid panel session notices');
  if(value.commands!==undefined&&(!Array.isArray(value.commands)||value.workspace.kind!=='model'||value.commands.length>128||value.commands.some(item=>!data(item)||typeof item.id!=='string'||!item.id||typeof item.tool!=='string'||typeof item.enabled!=='boolean'||typeof item.readOnly!=='boolean')||new Set(value.commands.map(item=>item.id)).size!==value.commands.length))throw new Error('Invalid named model command catalog');
  if(value.commandReadiness!==undefined&&value.commandReadiness!=='local')throw new Error('Unknown command readiness owner');
  return value;
}

// Injectable dependencies keep HTTP/SSE checks away from production Codex and Revit.
export function createPanelServerCore({root,dataRoot=root,codex,invokeWorkbench,invokeReadonlyCommand=null,turnInput=null,readToolTiming=null,selection,port=41873,audit,auditLifecycle=null,historyStore=null,turnTimeout=null,cancelTimeout=15000,accountAuth=null,requireAccount=false,requireLicense=false,installationId=null,dynamicApprovalOwner=null,modelPermissionServices=null,familyCapabilityOwner=null,accessServices=null,projectKnowledgeFactory=null,projectHistoryFactory=null,materialIndexFactory=null,materialStoreFactory=null,materialPicker=null,materialOpener=null,viewerService=null,verifyViewerDocument=null,projectAgent=null,projectPollMs=30000,modelReceiptPollDelays=[750,1500,3000,5000,10000,30000],cabinetFixtureTesting=false}){
  if(turnTimeout!==null&&(!Number.isSafeInteger(turnTimeout)||turnTimeout<1||turnTimeout>2147483647))throw new Error('Invalid turn timeout');
  if(!Array.isArray(modelReceiptPollDelays)||modelReceiptPollDelays.length<1||modelReceiptPollDelays.length>12||modelReceiptPollDelays.some(value=>!Number.isSafeInteger(value)||value<10||value>60000))throw new Error('Invalid model receipt poll intervals');
  modelReceiptPollDelays=[...modelReceiptPollDelays];
  const selected=trustedPanelComposition(selection),workspace=selected.workspace;
  if(typeof requireLicense!=='boolean'||requireLicense&&(!requireAccount||!accountAuth||workspace.kind!=='model'))throw new Error('License gate requires an explicitly configured model account');
  if(projectKnowledgeFactory!==null&&(workspace.kind!=='model'||typeof projectKnowledgeFactory!=='function'))throw new Error('Project knowledge requires a model-only trusted factory');
  if(materialIndexFactory!==null&&(workspace.kind!=='model'||typeof materialIndexFactory!=='function'))throw new Error('Library requires a model-only trusted factory');
  if(accessServices!==null&&(workspace.kind!=='model'||!Object.isFrozen(accessServices)||!Array.isArray(accessServices.tools)||['view','activate','select','current','control','authorize','invoke','deactivate','close'].some(name=>typeof accessServices[name]!=='function')))throw new Error('Access policies require a trusted model-only owner');
  if(materialStoreFactory!==null&&(workspace.kind!=='model'||typeof materialStoreFactory!=='function'||!materialIndexFactory))throw new Error('Library storage requires a model-only trusted factory');
  if(materialPicker!==null&&(workspace.kind!=='model'||!Object.isFrozen(materialPicker)||typeof materialPicker.pick!=='function'||typeof materialPicker.close!=='function'))throw new Error('Library picker requires a trusted owner');
  if(materialOpener!==null&&(workspace.kind!=='model'||!Object.isFrozen(materialOpener)||typeof materialOpener.open!=='function'||typeof materialOpener.close!=='function'))throw new Error('Library opener requires a trusted owner');
  if(projectHistoryFactory!==null&&(workspace.kind!=='model'||typeof projectHistoryFactory!=='function'||!projectKnowledgeFactory))throw new Error('Project history requires a model-only trusted factory');
  if(!Number.isSafeInteger(projectPollMs)||projectPollMs<50||projectPollMs>3600000)throw new Error('Invalid project refresh interval');
  if(viewerService!==null&&(workspace.kind!=='model'||!Object.isFrozen(viewerService)||['refresh','status','get','locate'].some(key=>typeof viewerService[key]!=='function')))throw new Error('Model viewer requires a trusted service');
  if(verifyViewerDocument!==null&&typeof verifyViewerDocument!=='function')throw new Error('Viewer identity verification requires a trusted function');
  if(projectAgent!==null&&(workspace.kind!=='model'||!Object.isFrozen(projectAgent)||!Array.isArray(projectAgent.tools)||typeof projectAgent.invoke!=='function'||!Array.isArray(codex.profile?.dynamicTools)))throw new Error('Project agent requires an explicit model profile');
  let projectKnowledge=null,projectBind=null,projectRefreshWork=null,projectRefreshTimer=null;const projectHistoryOwners=new Map();
  let materialOwner=null,materialQueue=Promise.resolve(),materialStatusPending=null;const materialStores=new Map();
  let viewerOwner=null,viewerProject=null,viewerPending=null,viewerAttempt=null,viewerBusy=false;
  const dynamicApproval=captureDynamicApprovalOwner(dynamicApprovalOwner);
  if(familyCapabilityOwner!==null&&(!modelPermissionServices||workspace.kind!=='model'||!Object.isFrozen(familyCapabilityOwner)||typeof Object.getOwnPropertyDescriptor(familyCapabilityOwner,'observe')?.value!=='function'))throw new Error('Family lifecycle needs explicit trusted model composition');
  const isLifecycleCapable=async document=>{try{const observed=await familyCapabilityOwner?.observe();return Boolean(plainData(observed)&&observed.version===1&&typeof observed.hostSession==='string'&&/^[a-f0-9]{32}$/.test(observed.hostSession)&&observed.hostSession===document.session);}catch{return false;}};
  if(modelPermissionServices!==null&&(!Object.isFrozen(modelPermissionServices)||workspace.kind!=='model'||codex?.profile?.id!=='model-workspace'||typeof modelPermissionServices.observeDocument!=='function'||typeof modelPermissionServices.invoke!=='function'||typeof modelPermissionServices.readCommand!=='function'||typeof modelPermissionServices.inspectFamilyJob!=='function'||!Array.isArray(codex.profile.dynamicTools)||!codex.profile.dynamicTools.some(tool=>tool.name==='buildx_model_operation')))throw new Error('Model permission requires trusted model services and a routed dynamic tool');
  const modelPermission=modelPermissionServices?createModelPermissionOwner({
    familyLifecycleEnabled:familyCapabilityOwner!==null,
    verifyDocument:async (expected,control={})=>{
      try{if(control.accessPolicy&&accessServices){const retained=control.recovery&&[...modelReceipts.values()].find(receipt=>receipt.scope.account===control.receiptScope?.account&&sameWorkbenchDocumentIdentity(receipt.scope.document,expected)&&modelReceiptAccountCurrent(receipt));const scope=retained?.facts.scope??(!control.recovery?modelGrant?.facts?.scope:null);if(!scope||!accessServices.current(scope,control.accessPolicy)||(await accessServices.authorize(scope,expected.path,{write:true})).ok!==true)return false;}if(sameWorkbenchDocumentIdentity(expected,await modelPermissionServices.observeDocument({accessPolicy:control.accessPolicy})))return true;}catch{}
      revokeModelGrant();allConversations();return false;
    },
    verifyFamily:async (expected,document,control)=>{try{return sameApprovedFamily(approvedFamilyFacts(await modelPermissionServices.inspectFamilyJob(expected.job_handle,control),document,expected.job_handle),expected);}catch{return false;}},
    verifyLifecycle:document=>isLifecycleCapable(document),
    invoke:(tool,args,control)=>modelPermissionServices.invoke(tool,args,control),
  }):null;
  if(dynamicApproval&&(workspace.kind!=='model'||codex?.profile?.id!=='model-workspace'||!Array.isArray(codex.profile.dynamicTools)))throw new Error('Dynamic approval requires an explicitly enabled model profile');
  if(dynamicApproval&&projectAgent&&!codex.profile.dynamicTools.some(tool=>!['buildx_model_operation','buildx_model_operation_schema'].includes(tool.name)&&!projectAgent.tools.some(project=>project.name===tool.name)))throw new Error('Dynamic approval requires an explicitly enabled approval tool');
  if(invokeReadonlyCommand!==null&&(typeof invokeReadonlyCommand!=='function'||workspace.kind!=='model'))throw new Error('Direct commands require an explicitly injected model-only owner');
  const directCommandsAvailable=workspace.kind==='model'&&typeof invokeReadonlyCommand==='function';
  const skillsAvailable=workspace.kind==='model'&&codex?.profile?.id==='model-workspace'&&typeof codex.listSkills==='function'&&typeof codex.assertSkillSelection==='function';
  const mcpCandidatesAvailable=workspace.kind==='model'&&!requireAccount&&!accountAuth&&codex?.profile?.id==='model-workspace'&&codex?.skillCatalogMode==='research'&&typeof codex.configuredMcpCandidates==='function';
  const commandsIndependent=directCommandsAvailable&&selected.commandReadiness==='local';
  if(typeof cabinetFixtureTesting!=='boolean')throw new Error('Invalid cabinet fixture setting');
  const displayedCommands=selected.commands?.map(command=>{
    const entry=CABINET_WRITE_IDS.includes(command.id)&&!cabinetFixtureTesting?{...command,enabled:false,unavailableReason:CABINET_BLOCK_REASON}:command;
    return modelPermission?{...entry,effectKind:modelOperationEffect(entry.tool).kind}:entry;
  });
  const commandDefinitions=new Map((displayedCommands??[]).map(command=>[command.id,command]));
  const commandIds=new Set(displayedCommands?commandDefinitions.keys():['document','selection','levels','search']);
  if(readToolTiming!==null&&(workspace.kind!=='model'||typeof readToolTiming!=='function'))throw new Error('Tool timings require a model-only composition owner');
  const history=captureHistoryStore(historyStore);
  if(turnInput!==null&&(!Object.isFrozen(turnInput)||workspace.kind!=='model'||Reflect.ownKeys(turnInput).some(key=>!['httpBytes','parse','descriptor','references','withText','prepare'].includes(key))||Object.values(Object.getOwnPropertyDescriptors(turnInput)).some(descriptor=>!Object.hasOwn(descriptor,'value'))||!Number.isSafeInteger(turnInput.httpBytes)||turnInput.httpBytes<1||turnInput.httpBytes>6*1024*1024||['parse','descriptor','references','withText','prepare'].some(key=>typeof turnInput[key]!=='function')))throw new Error('Model inputs require one immutable trusted composition');
  const turnAttachmentsAvailable=turnInput!==null&&workspace.kind==='model'&&codex.profile?.supportsTurnAttachments===true&&typeof history?.saveTurnAttachments==='function'&&typeof history?.readTurnAttachment==='function';
  // Program resources stay under root/public. Only trusted composition selects
  // the separate data root used by the native visual-capture owner.
  const visualArtifacts=turnAttachmentsAvailable&&modelPermission?createVisualArtifactOwner({root:dataRoot}):null;
  if(history&&workspace.kind!=='model')throw new Error('Conversation history is only configured for the model workspace');
  const ownedAudit=captureAuditLifecycle(auditLifecycle);
  if(ownedAudit&&audit!==undefined&&audit!==ownedAudit.audit)throw new Error('Panel audit writes and cleanup must have the same owner');
  audit=ownedAudit?.audit??audit??(()=>{});
  if(typeof audit!=='function')throw new Error('Panel audit callback is required');
  const phaseClock=()=>({ticks:performance.now(),utc:new Date().toISOString()});
  function phaseTiming(run,phase,stamp=phaseClock(),extra={}){
    if(!run?.phaseTiming)return;
    try{audit('phase-timing.jsonl',{code:'phase_timing',source:'panel',phase,observedUtc:stamp.utc,elapsedMs:Math.max(0,stamp.ticks-run.phaseTiming.start.ticks),...(run.phaseTiming.native?{sinceNativeRequestMs:Math.max(0,stamp.ticks-run.phaseTiming.native.ticks)}:{}),conversationId:run.conversationId,...run.owner?{messageId:run.owner.messageId}:{},...run.threadId?{threadId:run.threadId}:{},...run.turnId?{turnId:run.turnId}:{},...run.executionId?{executionId:run.executionId,commandId:run.commandId}:{},...extra},true);}catch{/* Diagnostics never replace the business outcome. */}
  }
  let auditCleanupId=null,historyCleanupId=null;
  if(!root||!codex||(workspace.supportsModelContext&&typeof invokeWorkbench!=='function'))throw new Error('Panel dependencies are required');
  if(!workspace.supportsModelContext)invokeWorkbench=async()=>{throw new Error('此工作区不提供Revit操作');};
  if(workspace.kind==='source-development'&&(accountAuth||requireAccount))throw new Error('Source core composition does not accept customer identity configuration');
  const profileMatches=state=>workspace.kind!=='customer-chat'||state?.mode==='customer-chat'&&state?.toolCount===0;
  if(workspace.kind==='customer-chat'&&(requireAccount!==true||!accountAuth||!profileMatches(codex.state)||selected.catalog.length!==0))throw new Error('Customer chat requires its own profile, authentication and empty tool catalog');
  function confirmationFacts(req,clientId='installation-status'){
    const state=codex.state,meta=state.codexAccount;
    // The original ChatGPT client omits type from its public status. Preserve
    // that representation only when the field is absent; an explicitly named
    // API provider (or an unknown type) must never be projected as ChatGPT.
    const hasObservation=meta&&['verified','checking'].includes(meta.status)&&meta.observationSequence>0;
    const type=hasObservation?(Object.hasOwn(meta,'type')?meta.type:'chatgpt'):null;
    return {scope:workspace.kind,clientId,buildx:accounts.bindingIdentity(req),codex:meta&&profileMatches(state)?{...meta,type,ready:state.ready===true}:null};
  }
  function interruptionIdentity(identity){
    return identity?{scope:workspace.kind,sessionId:identity.sessionId,userId:identity.userId,generation:identity.generation}:null;
  }
  const sameIdentity=(left,right)=>Boolean(left&&right&&left.scope===right.scope&&left.sessionId===right.sessionId&&left.userId===right.userId&&left.generation===right.generation);
  function clearInterruption(identity){if(!sameIdentity(interruptionOwner,identity))return false;interruptionOwner=null;return true;}
  function stateView(account=accounts.view(),identity=accounts.bindingIdentity()){
    const raw={...codex.state,...(skillsAvailable?{skillsAvailable:true,skillsRevision}:{}),...(mcpCandidatesAvailable?{mcpCandidatesAvailable:true}:{}),...(turnAttachmentsAvailable?{turnAttachmentsAvailable:true}:{}),...(workspace.kind==='model'&&typeof codex.listModels==='function'&&typeof codex.assertModelSelection==='function'?{modelSelectionAvailable:true}:{}),...(workspace.kind==='model'&&codex.profile?.id==='model-workspace'&&typeof codex.steer==='function'?{steerAvailable:true,...(history?{steerReceiptsAvailable:true}:{})}:{})},confirmed=confirmation.status(confirmationFacts());
    return {...raw,workspace,account,...(history?{historyAvailable:true}:{}),...(directCommandsAvailable?{directCommandsAvailable:true,...commandsIndependent?{commandReadiness:'local'}:{},commandsReady:Boolean(!closing&&!resetting&&!receiptCleanupFaults.size&&(!accounts.required||account.signedIn&&identity?.verified===true)&&(commandsIndependent||raw.ready===true&&profileMatches(raw)&&(!accounts.required||confirmed.localConnectionConfirmed)))}:{}),interruptionNotice:account.signedIn&&identity?.verified===true&&sameIdentity(interruptionOwner,interruptionIdentity(identity))?INTERRUPTION_NOTICE:null,codexConnectionReady:raw.ready===true&&profileMatches(raw),codexConfirmation:confirmed,busy:Boolean(active||contextBusy||accountDraining||codexOperation||historyControl||historyWrites.size),busyOperation:codexOperation?.kind==='model-permission-check'?'model-permission-check':null,
      ready:Boolean(!closing&&!codexOperation&&!receiptCleanupFaults.size&&raw.ready&&profileMatches(raw)&&(!accounts.required||account.signedIn&&confirmed.localConnectionConfirmed)),cleanupPending:closing&&!closed||receiptCleanupFaults.size>0,
      ...!profileMatches(raw)?{message:'客户聊天连接的模式或工具目录不匹配，已停止使用该连接。'}:accounts.required&&!account.signedIn?{message:account.message}:accounts.required&&!confirmed.localConnectionConfirmed?{message:confirmed.message}:codexOperation?.kind==='model-permission-check'?{message:'正在等待 Revit 核实当前模型与执行权限…'}:{}};
  }
  const csrf=randomBytes(24).toString('hex'),sessions=new Map(),streams=new Map(),conversations=new Map(),historyWrites=new Set(),labels=new Map(selected.catalog.map(tool=>[tool.name,tool.label]));
  let historyControl=null,attachmentIntake=null,attachmentPreviewRead=null;
  const skillSelections=new Map();let skillsRevision=0;
  const receiptOwners=new Set(),receiptCleanupFaults=new Set(),receiptClosing=new Map(),cabinetReceiptOwners=new Set();
  const cabinetReceiptCommand=id=>CABINET_WRITE_IDS.includes(id);
  const requestWorks=new Set(),projectAgentWorks=new Set();
  let commandViews=new WeakMap(),commandReviews=new WeakMap();
  let active=null,connecting=false,resetting=false,contextBusy=null,closing=false,closePromise=null,closed=false,connectionEpoch=0,accountDraining=false,shutdownOwner=null,codexOperation=null,interruptionOwner=null;
  let modelGrant=null,modelPermissionRevision=0;
  const accessPreparations=new Map(),accessMessages=new Map();
  function accessScope(s){return s.historyScope??historyIdentity().scope;}
  function prepareAccess(scope){
    if(!accessServices||accessPreparations.has(scope))return accessPreparations.get(scope);
    const work=Promise.resolve().then(()=>accessServices.activate(scope)).catch(()=>({ok:false,error:{message:'访问范围读取失败，请重新连接后重试。'}})).then(result=>{
      if(accessPreparations.get(scope)===work){if(!result.ok)accessMessages.set(scope,{accessUnavailable:true,modelWritable:false,modelMessage:result.error?.message||'访问范围未能核实，请重新连接后重试。'});else if(accessMessages.get(scope)?.accessUnavailable)accessMessages.delete(scope);}return result;
    }).finally(()=>{if(accessPreparations.get(scope)===work)allConversations();});
    accessPreparations.set(scope,work);return work;
  }
  function accessPolicyView(s){
    if(!accessServices)return {available:false};
    const scope=accessScope(s),message=accessMessages.get(scope),preparation=accessServices.diagnostics?.(scope);if(message?.accessUnavailable)return {available:false,reason:message.modelMessage,...preparation?{preparation}:{}};
    const snapshot=accessServices.view(scope);if(!snapshot){void prepareAccess(scope);return {available:true,loading:true,mode:'read-only',revision:0,roots:[],modelWritable:false,...preparation?{preparation}:{}};}
    if(!accessServices.control(scope)&&!accessPreparations.has(scope))void prepareAccess(scope);
    const grant=modelGrant?.session===s&&modelGrantCurrent(modelGrant)?modelGrant:null,cached=accessMessages.get(scope);
    const model=grant?{modelWritable:true,modelMessage:grant.scope.document.title+' · 已核实此模型可编辑。'}:cached?.modelWritable===false?cached:{modelWritable:false,modelMessage:snapshot.mode==='read-only'?'当前为只读访问。':'对话或上下文已变化，下次模型操作将重新核实。'};
    return {available:true,...snapshot,...model,...preparation?{preparation}:{}};
  }
  async function bindAccessGrant(client,s,facts,level=s.executionLevel??'rollback'){
    const ready=await accessServices.activate(facts.scope);if(!ready.ok)throw new Error(ready.error?.message||'访问范围无法核实。');
    const accessPolicy=accessServices.control(facts.scope);if(!accessPolicy||accessPolicy.mode==='read-only')throw new Error('当前为只读访问，请先选择项目读写或完全访问。');
    const epoch=connectionEpoch,generation=codex.state.connectionGeneration,revision=codex.state.codexAccount?.accountRevision,contextEpoch=s.contextEpoch;
    const document=await modelPermissionServices.observeDocument({accessPolicy});
    const authorized=await accessServices.authorize(facts.scope,document.path,{write:true});if(!authorized.ok)throw new Error(authorized.error?.message||'当前模型不在所选范围内。');
    if(closing||accountDraining||resetting||sessions.get(client)!==s||s.contextEpoch!==contextEpoch||connectionEpoch!==epoch||codex.state.connectionGeneration!==generation||codex.state.codexAccount?.accountRevision!==revision||!sameHistoryIdentity(facts)||!accessServices.current(facts.scope,accessPolicy))throw new Error('访问范围、账号或对话已变化。');
    const scope=Object.freeze({client,conversationId:s.conversationId,generation,revision,account:JSON.stringify(facts),document:Object.freeze({...document}),accessPolicy:Object.freeze({...accessPolicy})});
    const next={client,session:s,conversationId:s.conversationId,contextEpoch,connectionEpoch:epoch,facts,scope,level};
    modelGrant=next;modelPermission.setLevel({level,scope,isCurrent:()=>modelGrant===next&&modelGrantCurrent(next)});modelPermissionRevision++;s.executionLevel=level;
    accessMessages.set(facts.scope,{modelWritable:true,modelMessage:document.title+' · 当前模型可编辑。'});return document;
  }
  const modelReceipts=new Map(),modelReceiptWorks=new Set(),modelOperationsInFlight=new Set(),modelApprovalResults=new WeakMap(),modelReceiptResolutions=new Map();
  function modelGrantCurrent(grant){
    try{return Boolean(grant&&!closing&&!resetting&&!accountDraining&&sessions.get(grant.client)===grant.session&&grant.session.conversationId===grant.conversationId&&grant.session.contextEpoch===grant.contextEpoch&&connectionEpoch===grant.connectionEpoch&&codex.state.ready===true&&codex.state.connectionGeneration===grant.scope.generation&&codex.state.codexAccount?.accountRevision===grant.scope.revision&&sameHistoryIdentity(grant.facts)&&(!grant.scope.accessPolicy||accessServices?.current(grant.facts.scope,grant.scope.accessPolicy))&&(!accounts.required||confirmation.status(confirmationFacts()).localConnectionConfirmed));}catch{return false;}
  }
  function revokeModelGrant(){if(!modelGrant)return;modelGrant=null;modelPermissionRevision++;modelPermission?.revoke();}
  function currentModelGrant(client,s){if(modelGrant&&!modelGrantCurrent(modelGrant))revokeModelGrant();return modelGrant?.client===client&&modelGrant.session===s?modelGrant:null;}
  function modelPermissionView(client,s){
    if(!modelPermission)return {available:false};
    const grant=currentModelGrant(client,s),ready=!closing&&!resetting&&!accountDraining&&codex.state.ready===true&&(!accounts.required||confirmation.status(confirmationFacts()).localConnectionConfirmed);
    if(!ready)return {available:false};
    return {available:true,level:grant?.level??null,revision:modelPermissionRevision,conversationId:s.conversationId,documentLabel:grant?.scope.document.title??'当前模型（选择后核实）',expiresAt:null};
  }
  function modelReceiptAccountCurrent(receipt,req){
    const current=accounts.bindingIdentity(req);
    return receipt.facts.identity?current?.verified===true&&current.userId===receipt.facts.identity.userId:!accounts.required&&!current?.verified;
  }
  function modelReceiptView(client,s){
    const receipt=[...modelReceipts.values()].find(item=>modelReceiptAccountCurrent(item));
    return receipt?{ticket:receipt.ticket,conversationId:s.conversationId,sourceConversationId:receipt.conversationId,tool:receipt.tool,checking:receipt.checking,checkRevision:receipt.checkRevision,check:receipt.checkView??null,autoCheck:{attempts:receipt.attempts,active:Boolean(receipt.timer||receipt.checking),...(receipt.nextCheckAt?{nextCheckAt:receipt.nextCheckAt}:{}),...(receipt.message?{message:receipt.message}:{})}}:null;
  }
  const modelReceiptCurrent=receipt=>!closing&&modelReceipts.get(receipt.ticket)===receipt&&modelReceiptAccountCurrent(receipt);
  function retainModelReceipt(receipt){
    receipt.attempts=0;
    modelReceipts.set(receipt.ticket,receipt);scheduleModelReceipt(receipt);
  }
  function scheduleModelReceipt(receipt){
    if(closing||receipt.timer||receipt.checking||modelReceipts.get(receipt.ticket)!==receipt||isRecoverableModelScriptReceipt(receipt.tool,receipt.checked)||receipt.checked?.status==='host_changed')return;
    const delay=modelReceiptPollDelays[Math.min(receipt.attempts,modelReceiptPollDelays.length-1)];
    receipt.nextCheckAt=new Date(Date.now()+delay).toISOString();
    receipt.timer=setTimeout(()=>{
      receipt.timer=null;receipt.nextCheckAt=null;
      if(!modelReceiptCurrent(receipt)){scheduleModelReceipt(receipt);return;}
      const work=checkModelReceipt(receipt,{automatic:true}).catch(()=>{}).finally(()=>modelReceiptWorks.delete(work));modelReceiptWorks.add(work);
    },delay);receipt.timer.unref?.();
  }
  async function inspectModelReceipt(receipt){
    const result=receipt.directOwner?await receipt.directOwner.inspect():await modelPermission.inspect({ticket:receipt.ticket,scope:receipt.scope});
    if(!modelReceiptCurrent(receipt)||result?.ok!==true||!plainData(result.value)||typeof result.value.status!=='string'||typeof result.value.terminal!=='boolean'||Buffer.byteLength(JSON.stringify(result.value))>65536)throw new Error('原回执尚未核实。');
    return structuredClone(result.value);
  }
  function projectModelReceipt(receipt,checked){
    receipt.checked=checked;receipt.checkRevision++;
    receipt.checkView={status:checked.status,terminal:checked.terminal,...typeof checked.requestId==='string'?{requestId:checked.requestId}:{},...checked.evidence!==undefined?{evidence:checked.evidence}:{},...checked.recovery?{recovery:checked.recovery}:{}};
  }
  async function verifyModelReceiptDocument(receipt){
    if(!modelReceiptCurrent(receipt))throw new Error('原回执账号已变化。');
    const policy=receipt.scope.accessPolicy;
    if(policy&&accessServices&&(!accessServices.current(receipt.facts.scope,policy)||(await accessServices.authorize(receipt.facts.scope,receipt.scope.document.path,{write:true})).ok!==true))throw new Error('原模型访问范围已变化。');
    const observed=await modelPermissionServices.observeDocument({accessPolicy:policy});
    if(!modelReceiptCurrent(receipt)||!sameWorkbenchDocumentIdentity(receipt.scope.document,observed))throw new Error('请切回原模型，再核查此操作。');
  }
  function resolvedModelReceipt(receipt,review){
    clearTimeout(receipt.timer);receipt.timer=null;modelReceipts.delete(receipt.ticket);
    const checked=receipt.checked,status=review?'failed_reviewed':checked.status;
    const message=review?'脚本已报错结束；已由用户核查模型并恢复后续操作。回滚及事务外影响仍未确认。':status==='failed_rolled_back'?'脚本执行失败，已核实模型事务回滚；后续操作已恢复，事务外影响仍未核实。':status==='received'?'原模型操作回执已自动核实；后续操作已恢复。':`原模型操作回执已核实（${status}）；后续操作已恢复。`;
    const resolution={requestId:checked.requestId??null,tool:receipt.tool,status,message};
    const recent=modelReceiptResolutions.get(receipt.facts.scope)??[];recent.push(resolution);if(recent.length>8)recent.shift();modelReceiptResolutions.set(receipt.facts.scope,recent);
    const target=receipt.sourceSession;
    if(target?.conversationId===receipt.conversationId){target.add('error',message,status==='received'?'completed':'failed');if(history)void persist(target,receipt.facts.scope);}
    audit('lifecycle.jsonl',{code:'model_receipt_resolved',outcome:status},true);
  }
  async function settleModelReceipt(receipt,{review=false}={}){
    const expected=receipt.checked;
    if(review?!isRecoverableModelScriptReceipt(receipt.tool,expected):expected?.terminal!==true)throw new Error('原回执仍未核实。');
    await verifyModelReceiptDocument(receipt);
    if(receipt.directOwner){
      const actual=await inspectModelReceipt(receipt),stable=value=>{const copy=structuredClone(value);delete copy.checkedAt;return JSON.stringify(copy);};
      if(stable(actual)!==stable(expected)||review&&actual.evidence.nativeFailure.hostSession!==receipt.scope.document.session||!await releaseReceiptOwner(receipt.directOwner,true))throw new Error('原回执或清理状态已变化。');
      const view=receipt.sourceSession&&commandViews.get(receipt.sourceSession);if(view?.view?.executionId===receipt.executionId){delete view.receiptOwner;view.view={...view.view,receiptAcknowledged:true,canInspectReceipt:false,error:{...view.view.error,message:'原回执已核对，请以检查结果为准。'}};}
    }else{
      const method=review?'recover':'acknowledge';await modelPermission[method]({ticket:receipt.ticket,scope:receipt.scope,expected});
    }
    resolvedModelReceipt(receipt,review);
  }
  async function checkModelReceipt(receipt,{automatic=false}={}){
    if(!modelReceiptCurrent(receipt)||receipt.checking)throw new Error('回执正在核查或已变化。');
    clearTimeout(receipt.timer);receipt.timer=null;receipt.nextCheckAt=null;receipt.checking=true;
    if(automatic)receipt.attempts++;
    receipt.message=null;allConversations();
    try{
      projectModelReceipt(receipt,await inspectModelReceipt(receipt));
      if(automatic&&receipt.checked.terminal===true)await settleModelReceipt(receipt);
    }catch(error){
      if(modelReceiptCurrent(receipt))receipt.message=safeChatText(error.message||'自动核查尚未完成，将继续回查。',1000);
      if(modelReceiptCurrent(receipt)&&!receipt.checked?.terminal)projectModelReceipt(receipt,{status:'unconfirmed',terminal:false});
      if(!automatic)throw error;
    }finally{receipt.checking=false;scheduleModelReceipt(receipt);allConversations();allState();}
  }
  // Only an already-ready model app-server may be restarted automatically,
  // after that exact child has both exited and closed. A short bounded wait
  // lets ongoing owned work settle without replaying it or dropping receipts.
  let autoReadyGeneration=null,autoExited=null,autoTimer=null,autoAttempts=0;
  function cancelAutoReconnect(){if(autoTimer){clearTimeout(autoTimer);autoTimer=null;}autoExited=null;}
  function observeAutoDiagnostic(data){
    if(workspace.kind!=='model'||codex.profile?.id!=='model-workspace'||closing||resetting||shutdownOwner)return;
    if(data.code==='codex_exit'&&Number.isSafeInteger(data.generation)&&data.generation===autoReadyGeneration){
      const identity=accounts.required?accounts.bindingIdentity():null;
      if(accounts.required&&identity?.verified!==true)return;
      autoExited={generation:data.generation,epoch:connectionEpoch,identity};return;
    }
    if(data.code!=='codex_lifecycle'||data.phase!=='closed'||data.reason!=='codex_close_confirmed'||!autoExited||data.generation!==autoExited.generation||autoAttempts>=3)return;
    const owner=autoExited;autoExited=null;autoReadyGeneration=null;let remaining=20;
    const retry=()=>{
      autoTimer=null;
      const state=codex.state;
      if(closing||resetting||shutdownOwner||connectionEpoch!==owner.epoch||state.connectionGeneration!==owner.generation||state.connectionStatus!=='closed'||state.cleanupPending||state.ready)return;
      if(accounts.required&&(!sameIdentity(owner.identity,accounts.bindingIdentity())||accounts.bindingIdentity()?.verified!==true))return;
      if(connecting||active||contextBusy||accountDraining||codexOperation||historyControl||historyWrites.size||requestWorks.size||projectAgentWorks.size||projectBind||projectRefreshWork||viewerBusy||viewerPending||receiptOwners.size||receiptCleanupFaults.size){
        if(--remaining>0){autoTimer=setTimeout(retry,250);autoTimer.unref?.();}return;
      }
      autoAttempts++;
      // Existing unknown turn and receipt state stays owned; only context and
      // thread bindings are invalidated before the new connection is started.
      resetting=true;
      void (async()=>{
        let saved=true;
        try{
          const writes=[];
          for(const s of new Set([...sessions.values(),...conversations.values()])){s.resetContext();if(history)writes.push(persist(s));}
          if(writes.length)saved=(await Promise.all(writes)).every(result=>result?.ok===true);
        }catch{saved=false;}
        if(!saved)codex.failed('连接中断后的对话状态保存尚未确认，请检查后手动重连。');
        resetting=false;allConversations();allState();
        if(saved&&!closing&&!accountDraining&&!shutdownOwner&&connectionEpoch===owner.epoch&&codex.state.connectionGeneration===owner.generation&&codex.state.connectionStatus==='closed'&&(!accounts.required||sameIdentity(owner.identity,accounts.bindingIdentity())&&accounts.bindingIdentity()?.verified===true))await connect();
      })();
    };
    autoTimer=setTimeout(retry,250);autoTimer.unref?.();
  }
  const dynamicText=(v,max,empty=false)=>typeof v==='string'&&v.length<=max&&(empty||v.length>0)&&!v.includes('\0');
  function discardDynamic(run,entry,{reject=false}={}){
    if(entry.done)return;entry.done=true;clearTimeout(entry.timer);
    if(entry.ticket!==null){try{Promise.resolve((entry.model?modelPermission:dynamicApproval)?.cancel({ticket:entry.ticket})).catch(()=>{});}catch{}}
    try{if(reject)entry.request.reject();else entry.request.discard();}catch{}
    const index=run.dynamicRequests?.indexOf(entry)??-1;if(index>=0)run.dynamicRequests.splice(index,1);
  }
  function discardAllDynamic(run){for(const entry of [...(run.dynamicRequests??[])])discardDynamic(run,entry);}
  function currentDynamic(run,entry){
    const s=sessions.get(run.client);
    return !closing&&!resetting&&!accountDraining&&active===run&&!run.cancelRequested&&run.turnId===entry.params.turnId&&
      s?.conversationId===run.conversationId&&s.contextEpoch===run.contextEpoch&&s.run===run.owner&&
      connectionEpoch===run.connectionEpoch&&codex.state.ready===true&&codex.state.connectionGeneration===run.codexGeneration&&
      codex.state.codexAccount?.accountRevision===run.codexRevision&&entry.request.generation===run.codexGeneration&&entry.request.revision===run.codexRevision&&
      (!accounts.required||sameIdentity(run.accountIdentity,interruptionIdentity(accounts.bindingIdentity()))&&confirmation.status(confirmationFacts()).localConnectionConfirmed);
  }
  function sameLiveProjectIdentity(facts){
    const current=accounts.bindingIdentity();
    if(facts?.identity)return current?.verified===true&&current.sessionId===facts.identity.sessionId&&current.userId===facts.identity.userId&&current.generation===facts.identity.generation;
    return facts?.scope==='model:research-local'&&!accounts.required&&!current?.verified;
  }
  function skillLibraryCurrent(selection,req,client,target){
    const now=codex.state.codexAccount,account=selection?.account,library=selection?.library;
    return Boolean(library&&!closing&&!resetting&&!accountDraining&&materialOwner===library&&library.revision===selection.libraryRevision&&
      sameLiveProjectIdentity(library.facts)&&sameHistoryIdentity(library.facts,req)&&sessions.get(client)===target&&
      codex.state.ready===true&&now?.connectionGeneration===account?.connectionGeneration&&now?.accountRevision===account?.accountRevision&&
      (!accounts.required||confirmation.status(confirmationFacts(req,client)).localConnectionConfirmed));
  }
  function sameReceiptAccount(facts,req){
    const current=accounts.bindingIdentity(req);
    if(facts?.identity)return current?.verified===true&&current.userId===facts.identity.userId;
    return facts?.scope==='model:research-local'&&!accounts.required&&!current?.verified;
  }
  function projectHistoryFor(facts){
    if(!projectHistoryFactory)return null;
    const account=facts?.identity?.userId?'user:'+facts.identity.userId:!accounts.required?'research:local':null;
    if(!account)throw new Error('项目历史需要已核验的账号身份。');
    if(projectHistoryOwners.has(account))return projectHistoryOwners.get(account);
    const made=projectHistoryFactory(account);
    if(!made?.ok||!Object.isFrozen(made.value)||['bind','currentBinding','saveVersion','readVersion','cleanup'].some(name=>typeof made.value[name]!=='function'))throw new Error('项目历史目录未能核实。');
    projectHistoryOwners.set(account,made.value);return made.value;
  }
  function auditModelDynamic(run,entry,phase,details={}){
    const args=entry.params.arguments,type=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
    entry.modelAuditStarted??=performance.now();
    try{audit('tool-calls.jsonl',{kind:'dynamic_model',phase,tool:'buildx_model_operation',
      conversationId:run.conversationId,threadId:entry.params.threadId,turnId:entry.params.turnId,callId:entry.params.callId,
      modelTool:typeof args?.tool==='string'?args.tool:null,argumentKeys:plainData(args)?Object.keys(args):[],
      parametersType:type(args?.parameters),parameterKeys:plainData(args?.parameters)?Object.keys(args.parameters):[],
      hasCurrentGrant:Boolean(modelGrant?.client===run.client&&modelGrant?.session===sessions.get(run.client)&&modelGrantCurrent(modelGrant)),
      elapsedMs:Math.max(0,performance.now()-entry.modelAuditStarted),...details},true);}catch{/* Diagnostics never replace the business outcome. */}
  }
  function recordModelApprovalResult(run,entry,result){
    if(!entry.preview||!currentDynamic(run,entry)||!['completed','not_started','unconfirmed','declined'].includes(result?.status))return;
    const view=Object.freeze({requestId:entry.preview.id,digest:entry.preview.digest,conversationId:run.conversationId,status:result.status,
      ...typeof result.code==='string'&&/^MODEL_[A-Z0-9_]{1,100}$/.test(result.code)?{code:result.code}:{},
      ...result.operationOutcome==='not_started'?{operationOutcome:'not_started'}:{}});
    modelApprovalResults.set(sessions.get(run.client),{client:run.client,contextEpoch:run.contextEpoch,connectionEpoch:run.connectionEpoch,
      generation:run.codexGeneration,revision:run.codexRevision,facts:entry.modelGrant.facts,view});
  }
  function modelApprovalResultView(client,s){
    const owned=modelApprovalResults.get(s);
    // A final result survives the AI turn and permission revocation, while the
    // client, conversation, account, context and connection still own it.
    if(!owned||owned.client!==client||owned.view.conversationId!==s.conversationId||owned.contextEpoch!==s.contextEpoch||
       owned.connectionEpoch!==connectionEpoch||owned.generation!==codex.state.connectionGeneration||owned.revision!==codex.state.codexAccount?.accountRevision||
       closing||resetting||accountDraining||!sameHistoryIdentity(owned.facts))return null;
    return owned.view;
  }
  function rejectModelDynamic(run,entry,code,message,stage='admission',details=undefined){
    auditModelDynamic(run,entry,'rejected',{code,stage,outcome:'not_started'});
    entry.done=true;clearTimeout(entry.timer);const index=run.dynamicRequests?.indexOf(entry)??-1;if(index>=0)run.dynamicRequests.splice(index,1);
    try{entry.request.respond({success:false,contentItems:[{type:'inputText',text:JSON.stringify({ok:false,error:{code,message,outcome:'not_started',stage,...details?{details}:{}}})}]});}catch{}
  }
  async function expireModelProposal(run,entry){
    if(!entry.model||!entry.preview||entry.done||entry.deciding||entry.modelDispatched||entry.preview.deadline>Date.now())return false;
    if(!currentDynamic(run,entry)){discardDynamic(run,entry,{reject:true});return false;}
    // Claim the still-unaccepted proposal through the same one-use gate as
    // HTTP decisions. Only a confirmed cancellation of the original proposed
    // owner proves this expiry is not a dispatched or uncertain operation.
    entry.deciding=true;clearTimeout(entry.timer);
    let cancelled=false;try{cancelled=await modelPermission.cancel({ticket:entry.ticket});}catch{}
    if(entry.done)return false;
    if(cancelled!==true||!currentDynamic(run,entry)){discardDynamic(run,entry,{reject:true});if(active===run)conversation(run.client);return false;}
    recordModelApprovalResult(run,entry,{status:'not_started',code:'MODEL_APPROVAL_EXPIRED'});
    rejectModelDynamic(run,entry,'MODEL_APPROVAL_EXPIRED','本次模型操作在确认前已过期，未接受决定，未发送模型操作；请基于当前模型重新发起并确认。','approval');
    if(active===run)conversation(run.client);return true;
  }
  function prepareModelProposal(run,entry,grant,args,reviewedCommand,reviewedFamily,reviewedLifecycle,reviewedTypeWrite){
      let proposal;
      try{proposal=modelPermission.propose({scope:grant.scope,callId:JSON.stringify([entry.params.threadId,entry.params.turnId,entry.params.callId]),tool:args.tool,parameters:args.parameters,reviewedCommand,reviewedFamily,reviewedLifecycle,reviewedTypeWrite,isCurrent:()=>currentDynamic(run,entry)&&modelGrantCurrent(grant),onStage:event=>{if(event.phase==='dispatching')entry.modelDispatched=true;auditModelDynamic(run,entry,event.phase,{stage:'execution',...event.outcome?{outcome:event.outcome}:{}});}});}catch(cause){
        const failure=modelPermissionErrorView(cause);rejectModelDynamic(run,entry,failure.code,failure.message,'proposal',failure.details);return;
      }
      entry.model=true;entry.ticket=proposal.ticket;entry.modelGrant=grant;entry.modelTool=proposal.tool;
      if(isNativeTypeParameterWrite(proposal.tool)&&proposal.requiresApproval!==true){void modelPermission.cancel({ticket:proposal.ticket});rejectModelDynamic(run,entry,'MODEL_APPROVAL_UNAVAILABLE','类型参数操作必须逐次确认，未发送到 Revit。','approval');return;}
      auditModelDynamic(run,entry,proposal.requiresApproval?'awaiting_approval':'accepted',{stage:'proposal'});
      if(!proposal.requiresApproval){entry.deciding=true;void decideModelDynamic(run,entry,proposal.digest,'accept');return;}
      const parameters=proposal.typeParameterReview?'请核对下方类型参数、原始值、新值、执行方式及完整直接影响范围。':JSON.stringify(proposal.reviewedCommand?{parameters:proposal.parameters,command:proposal.reviewedCommand}:proposal.reviewedFamily?{parameters:proposal.parameters,family:proposal.reviewedFamily}:proposal.reviewedLifecycle?{parameters:proposal.parameters,family:proposal.reviewedLifecycle}:proposal.parameters);
      if(parameters.length>65536){discardDynamic(run,entry,{reject:true});return;}
      entry.preview=Object.freeze({id:entry.token,digest:proposal.digest,kind:'model',action:proposal.tool,target:proposal.document.title+' · '+proposal.document.path,cwd:'',source:proposal.notice??'应用修改会保留在当前模型中，文件不会自动保存。',parameters,...proposal.typeParameterReview?{typeParameterReview:proposal.typeParameterReview}:{},deadline:proposal.deadline,conversationId:run.conversationId});
      entry.timer=setTimeout(()=>{void expireModelProposal(run,entry);},Math.max(1,proposal.deadline-Date.now()));entry.timer.unref?.();
  }
  function prepareDynamic(run,entry){
    if(!currentDynamic(run,entry)){discardDynamic(run,entry,{reject:true});return;}
    if(entry.params.tool==='buildx_model_operation_schema'){
      const result=describeModelOperationSchema(entry.params.arguments);
      entry.done=true;const index=run.dynamicRequests?.indexOf(entry)??-1;if(index>=0)run.dynamicRequests.splice(index,1);
      try{entry.request.respond({success:result.ok,contentItems:[{type:'inputText',text:JSON.stringify(result)}]});}catch{entry.request.discard();}return;
    }
    if(accessServices?.tools.some(tool=>tool.name===entry.params.tool)){
      const facts=historyIdentity(),policy=accessServices.view(facts.scope),current=()=>currentDynamic(run,entry)&&sameHistoryIdentity(facts)&&accessServices.current(facts.scope,policy);
      const work=Promise.resolve().then(()=>accessServices.invoke(entry.params.tool,entry.params.arguments,{scope:facts.scope,isCurrent:current})).then(result=>{
        if(!currentDynamic(run,entry)||!sameHistoryIdentity(facts)){discardDynamic(run,entry);return;}
        entry.done=true;const index=run.dynamicRequests?.indexOf(entry)??-1;if(index>=0)run.dynamicRequests.splice(index,1);
        if(!entry.request.respond({success:result?.ok===true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]}))entry.request.discard();
      }).catch(()=>discardDynamic(run,entry,{reject:true})).finally(()=>projectAgentWorks.delete(work));projectAgentWorks.add(work);return;
    }
    if(entry.params.tool==='buildx_model_operation'){
      if(!modelPermission){discardDynamic(run,entry,{reject:true});return;}
      // Parse the advertised outer contract once, before observing a model or
      // obtaining a grant. Malformed calls are data errors, not missing rights.
      const args=entry.params.arguments;
      if(!entry.modelAdmissionChecked){
        entry.modelAdmissionChecked=true;auditModelDynamic(run,entry,'received',{stage:'admission'});
        if(!plainData(args)||Object.keys(args).length!==2||!Object.hasOwn(args,'tool')||!Object.hasOwn(args,'parameters')||typeof args.tool!=='string'||!args.tool||!plainData(args.parameters)){
          rejectModelDynamic(run,entry,'MODEL_OPERATION_ARGUMENTS_INVALID','模型操作调用的外层格式应为 {"tool":"准确工具名","parameters":{}}，仅允许这两个字段。请按选定工具的契约填写 parameters；事务 mode 必须位于 parameters 内，不接受 tool_name 或顶层 mode。');return;
        }
        try{validateModelOperationParameters(args.tool,args.parameters,{allowDocumentBinding:true});}catch(cause){
          const failure=modelPermissionErrorView(cause);rejectModelDynamic(run,entry,failure.code,failure.message,'admission',failure.details);return;
        }
      }
      if(modelReceipts.size||modelOperationsInFlight.size){entry.done=true;const i=run.dynamicRequests?.indexOf(entry)??-1;if(i>=0)run.dynamicRequests.splice(i,1);try{entry.request.respond({success:false,contentItems:[{type:'inputText',text:'上一项模型操作仍在执行或结果尚未核对，系统正在回查；本次未执行，请勿重复原操作。'}]});}catch{}return;}
      const target=sessions.get(run.client);
      if(accessServices&&!currentModelGrant(run.client,target)&&!entry.accessChecked){
        entry.accessChecked=true;const facts=historyIdentity();
        auditModelDynamic(run,entry,'verifying',{stage:'binding'});
        const work=bindAccessGrant(run.client,target,facts).then(()=>{if(currentDynamic(run,entry))prepareDynamic(run,entry);else discardDynamic(run,entry);}).catch(error=>{
          accessMessages.set(facts.scope,{modelWritable:false,modelMessage:safeChatText(error.message)});
          if(currentDynamic(run,entry))rejectModelDynamic(run,entry,'MODEL_ACCESS_BINDING_FAILED',safeChatText(error.message||'未能核实当前模型的访问范围。'),'binding');else discardDynamic(run,entry);
        }).finally(()=>{projectAgentWorks.delete(work);allConversations();});projectAgentWorks.add(work);return;
      }
      const grant=currentModelGrant(run.client,target);
      if(!grant){
        rejectModelDynamic(run,entry,'MODEL_PERMISSION_MISSING','当前对话尚无有效的模型执行授权，请在面板选择执行方式并核实当前模型。','binding');return;
      }
      if(isNativeTypeParameterWrite(args.tool)){
        if(entry.typeWritePreparing)return;entry.typeWritePreparing=true;
        if(typeof modelPermissionServices.prepareTypeParameterWrite!=='function'){rejectModelDynamic(run,entry,'MODEL_TYPE_PARAMETER_REVIEW_UNAVAILABLE','类型参数原态核查尚未接通，未发送写入。','proposal');return;}
        let chosen;
        try{chosen=structuredClone(args.parameters);chosen.mode=grant.level==='rollback'?'rollback':chosen.mode??'rollback';
          if(!Object.hasOwn(chosen,'expected_document'))chosen.expected_document=grant.scope.document.path;
          chosen=validateModelOperationParameters(args.tool,chosen);
        }catch(cause){const failure=modelPermissionErrorView(cause);rejectModelDynamic(run,entry,failure.code,failure.message,'proposal',failure.details);return;}
        const work=Promise.resolve().then(()=>modelPermissionServices.prepareTypeParameterWrite(chosen,{sourceDocument:grant.scope.document,accessPolicy:grant.scope.accessPolicy,
          shouldContinue:()=>currentDynamic(run,entry)&&modelGrantCurrent(grant)})).then(prepared=>{
          if(!entry.done&&currentDynamic(run,entry)&&modelGrantCurrent(grant))prepareModelProposal(run,entry,grant,{tool:args.tool,parameters:chosen},undefined,undefined,undefined,prepared);
          else discardDynamic(run,entry,{reject:true});
        }).catch(cause=>{
          const recovery=captureReceiptOwner(cause?.receiptOwner);let details;
          if(recovery){
            receiptOwners.add(recovery);cabinetReceiptOwners.add(recovery);const ticket=randomUUID();
            retainModelReceipt({ticket,executionId:ticket,client:run.client,sourceSession:grant.session,conversationId:run.conversationId,tool:'revit_get_type_parameter_impact',
              scope:grant.scope,facts:grant.facts,directOwner:recovery,checking:false,checkRevision:0,checkView:null,checked:null});
            details={preparationOutcome:'unconfirmed',recoveryPending:true,...typeof cause?.requestId==='string'&&/^[a-f0-9-]{36}$/.test(cause.requestId)?{requestId:cause.requestId}:{}};
            allConversations();allState();
          }
          if(!entry.done&&currentDynamic(run,entry))rejectModelDynamic(run,entry,'MODEL_TYPE_PARAMETER_REVIEW_UNAVAILABLE',recovery?'本次类型写入尚未发送；原准备读取或其清理结果仍待核对，已保留原回执，核对后不会自动执行类型写入。':'类型参数原态、完整影响清单或宿主确认准备未通过，本次未发送写入。','proposal',details);
          else discardDynamic(run,entry,{reject:true});
        }).finally(()=>projectAgentWorks.delete(work));
        projectAgentWorks.add(work);return;
      }
      if(args.tool==='revit_run_command'){
        let chosen;try{chosen=structuredClone(args.parameters);}catch{discardDynamic(run,entry,{reject:true});return;}
        if(typeof chosen.command_id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(chosen.command_id)||typeof chosen.revision!=='string'||!/^[a-f0-9]{64}$/.test(chosen.revision)){discardDynamic(run,entry,{reject:true});return;}
        const work=Promise.resolve().then(()=>modelPermissionServices.readCommand({command_id:chosen.command_id,revision:chosen.revision},{sourceDocument:grant.scope.document,shouldContinue:()=>currentDynamic(run,entry)&&modelGrantCurrent(grant)})).then(reviewed=>{
          if(!entry.done&&currentDynamic(run,entry)&&modelGrantCurrent(grant))prepareModelProposal(run,entry,grant,{tool:args.tool,parameters:chosen},reviewed);
          else discardDynamic(run,entry,{reject:true});
        }).catch(()=>discardDynamic(run,entry,{reject:true})).finally(()=>projectAgentWorks.delete(work));
        projectAgentWorks.add(work);return;
      }
      if(args.tool==='revit_family_load_job'){
        let chosen;try{chosen=structuredClone(args.parameters);}catch{discardDynamic(run,entry,{reject:true});return;}
        if(typeof chosen.job_handle!=='string'||!chosen.job_handle.trim()||chosen.job_handle.length>180||/[\r\n\0]/.test(chosen.job_handle)){discardDynamic(run,entry,{reject:true});return;}
        const work=Promise.resolve().then(()=>modelPermissionServices.inspectFamilyJob(chosen.job_handle,{sourceDocument:grant.scope.document,shouldContinue:()=>currentDynamic(run,entry)&&modelGrantCurrent(grant)})).then(result=>{
          if(!entry.done&&currentDynamic(run,entry)&&modelGrantCurrent(grant))prepareModelProposal(run,entry,grant,{tool:args.tool,parameters:chosen},undefined,approvedFamilyFacts(result,grant.scope.document,chosen.job_handle));
          else discardDynamic(run,entry,{reject:true});
        }).catch(()=>discardDynamic(run,entry,{reject:true})).finally(()=>projectAgentWorks.delete(work));
        projectAgentWorks.add(work);return;
      }
      if(['revit_family_save_job','revit_family_close_job'].includes(args.tool)){
        if(!familyCapabilityOwner){discardDynamic(run,entry,{reject:true});return;}
        let chosen;try{chosen=structuredClone(args.parameters);}catch{discardDynamic(run,entry,{reject:true});return;}
        if(typeof chosen.job_handle!=='string'||!chosen.job_handle.trim()||chosen.job_handle.length>180||/[\r\n\0]/.test(chosen.job_handle)){discardDynamic(run,entry,{reject:true});return;}
        const work=Promise.resolve().then(async()=>{if(!await isLifecycleCapable(grant.scope.document)||!currentDynamic(run,entry)||!modelGrantCurrent(grant))throw new Error('capability changed');return modelPermissionServices.inspectFamilyJob(chosen.job_handle,{sourceDocument:grant.scope.document,requestLifecycleApproval:true,shouldContinue:()=>currentDynamic(run,entry)&&modelGrantCurrent(grant)});}).then(result=>{
          if(!entry.done&&currentDynamic(run,entry)&&modelGrantCurrent(grant))prepareModelProposal(run,entry,grant,{tool:args.tool,parameters:chosen},undefined,undefined,approvedLifecycleFacts(result,grant.scope.document,chosen.job_handle,args.tool));
          else discardDynamic(run,entry,{reject:true});
        }).catch(()=>discardDynamic(run,entry,{reject:true})).finally(()=>projectAgentWorks.delete(work));
        projectAgentWorks.add(work);return;
      }
      prepareModelProposal(run,entry,grant,args);return;
    }
    if(projectAgent?.tools.some(tool=>tool.name===entry.params.tool)){
      const knowledge=projectKnowledge,viewer=viewerOwner,project=projectKnowledge,alive=()=>!entry.done&&currentDynamic(run,entry);
      const liveIdentity=accounts.bindingIdentity(),facts={scope:liveIdentity?.verified?'model:user:'+liveIdentity.userId:'model:research-local',identity:liveIdentity?.verified?{sessionId:liveIdentity.sessionId,userId:liveIdentity.userId,generation:liveIdentity.generation}:null};
      const material=entry.params.tool.startsWith('buildx_materials_')?libraryOwner(facts):null;
      const materialCurrent=()=>alive()&&materialOwner===material&&sameLiveProjectIdentity(facts);
      const materialService=material?Object.freeze({
        listRoots:async()=>{const result=await libraryOperation(material,'listRoots',{},materialCurrent);return result?.ok===true?{...result,value:{...result.value,roots:result.value.roots.filter(item=>item.status==='available')}}:result;},
        listChildren:args=>libraryOperation(material,'listChildren',args,materialCurrent),
        readFile:args=>libraryOperation(material,'readFile',args,materialCurrent)
      }):null;
      const refreshViewer=entry.params.tool==='buildx_viewer_refresh';
      const viewerCurrent=()=>alive()&&projectKnowledge===project&&sameLiveProjectIdentity(facts)&&(refreshViewer||viewerOwner===viewer&&viewerProject===project);
      const refresh=async args=>{
        if(!viewerCurrent()||viewerBusy||viewerPending||projectBind)return {ok:false,error:{outcome:'not_started'}};
        if(requireLicense&&!(await accounts.authorizeCurrentLicense()).allowed)return {ok:false,error:{outcome:'not_started'}};
        if(!viewerCurrent()||viewerBusy||viewerPending||projectBind)return {ok:false,error:{outcome:'not_started'}};
        viewerBusy=true;const requestId=randomUUID();viewerAttempt={requestId,facts,state:'pending'};
        try{
          let result;try{result=await viewerService.refresh(args);}catch{result={ok:false,error:{outcome:'unconfirmed'}};}
          const recovery=captureReceiptOwner(result?.receiptOwner);if(recovery)receiptOwners.add(recovery);
          if(result?.error?.outcome==='unconfirmed')viewerPending={facts,owner:recovery,evidence:result.evidence};
          else if(recovery)await releaseReceiptOwner(recovery);
          if(result.ok){viewerAttempt.state='received';viewerAttempt.snapshotId=result.value?.snapshotId;if(viewerCurrent()){viewerOwner=facts;viewerProject=project;}}
          else viewerAttempt.state=result?.error?.outcome==='unconfirmed'?'unknown':'failed';
          if(!result.ok)return {ok:false,error:{outcome:result.error?.outcome??'not_started'},evidence:{requestId}};
          return {ok:true,value:{snapshotId:result.value.snapshotId,identity:result.value.identity,coverage:result.value.value.coverage,capturedAt:result.value.capturedAt}};
        }finally{viewerBusy=false;}
      };
      const context={isCurrent:alive,
        knowledge:knowledge?{service:knowledge.service,isCurrent:()=>projectKnowledge===knowledge&&sameLiveProjectIdentity(knowledge.facts)}:null,
        materials:material?{service:materialService,isCurrent:materialCurrent}:null,
        viewer:viewerService&&(refreshViewer||viewer&&viewerProject===project)?{service:viewerService,isCurrent:viewerCurrent,...(refreshViewer?{refresh}:{}),...(verifyViewerDocument?{verifyDocument:verifyViewerDocument}:{})}:null};
      const work=Promise.resolve().then(()=>projectAgent.invoke(entry.params.tool,entry.params.arguments,context)).then(result=>{
        if(!alive()){discardDynamic(run,entry);return;}
        entry.done=true;const index=run.dynamicRequests?.indexOf(entry)??-1;if(index>=0)run.dynamicRequests.splice(index,1);
        try{if(!entry.request.respond({success:result?.ok===true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]}))entry.request.discard();}catch{try{entry.request.discard();}catch{}}
      }).catch(()=>{discardDynamic(run,entry,{reject:true});}).finally(()=>projectAgentWorks.delete(work));
      projectAgentWorks.add(work);
      return;
    }
    if(!dynamicApproval){discardDynamic(run,entry,{reject:true});return;}
    let proposal;
    const scope=Object.freeze({client:run.client,conversationId:run.conversationId,threadId:run.threadId,turnId:run.turnId,generation:run.codexGeneration,revision:run.codexRevision,account:run.accountIdentity?Object.freeze({...run.accountIdentity}):null});
    try{proposal=dynamicApproval.propose(Object.freeze({params:entry.params,scope,isCurrent:()=>currentDynamic(run,entry)}));}catch{discardDynamic(run,entry,{reject:true});return;}
    if(!plainData(proposal)||!Object.isFrozen(proposal)||Object.values(Object.getOwnPropertyDescriptors(proposal)).some(item=>!Object.hasOwn(item,'value'))||!dynamicText(proposal.ticket,200)||!/^([0-9a-f]{64})$/.test(proposal.digest)||!['terminal','browser','plugin'].includes(proposal.kind)||
       !dynamicText(proposal.action,16384)||!dynamicText(proposal.target,4096)||!dynamicText(proposal.cwd,4096,true)||!dynamicText(proposal.source,512)||!dynamicText(proposal.parameters,65536,true)||
       !Number.isSafeInteger(proposal.deadline)||proposal.deadline<=Date.now()||proposal.deadline>Date.now()+120000){
      if(plainData(proposal)&&dynamicText(proposal.ticket,200)){entry.ticket=proposal.ticket;}discardDynamic(run,entry,{reject:true});return;
    }
    const {ticket,digest,kind,action,target,cwd,source,parameters,deadline}=proposal;
    entry.ticket=ticket;entry.preview=Object.freeze({id:entry.token,digest,kind,action,target,cwd,source,parameters,deadline,conversationId:run.conversationId});
    entry.timer=setTimeout(()=>{discardDynamic(run,entry,{reject:true});if(active===run)conversation(run.client);},Math.max(1,deadline-Date.now()));entry.timer.unref?.();
  }
  async function visualDynamicOutput(run,entry,result){
    const receipt=result?.result?.value;
    if(result?.status!=='completed'||!['revit_capture_view','revit_inspect_elements'].includes(entry.modelTool))return null;
    const target=sessions.get(run.client),current=()=>currentDynamic(run,entry)&&target===sessions.get(run.client)&&target.historyScope===run.historyScope;
    try{
      if(!visualArtifacts||!current())throw new Error('当前对话未开放图片保存或会话已变化，视觉复核未完成。');
      if(typeof codex.assertModelSelection==='function'){
        if(typeof run.nativeModel!=='string')throw new Error('请先选择已核实支持图片的模型；截图已生成，视觉复核未完成。');
        codex.assertModelSelection(run.nativeModel,{requiresImages:true,effort:run.nativeEffort});
      }
      if(receipt?.hostSession!==entry.modelGrant.scope.document.session||!sameWorkbenchDocumentIdentity(entry.modelGrant.scope.document,{session:receipt?.hostSession,title:receipt?.document?.title,path:receipt?.document?.path}))throw new Error('截图回执的宿主或文档不一致，视觉复核未完成。');
      const captured=await visualArtifacts.read(receipt,{shouldContinue:current});
      if(!current())throw new Error('会话已变化，图片未发送。');
      const saved=await history.saveTurnAttachments(run.historyScope,captured.files);
      if(!saved?.ok)throw new Error(saved?.error?.message||'视图图片保存未确认，视觉复核未完成。');
      if(!current()||!target.attachAssistantImages(run.owner,saved.attachments))throw new Error('会话已变化或本轮图片已达上限，视觉复核未完成。');
      const persisted=await persist(target,run.historyScope);
      if(!persisted?.ok)throw new Error('截图已读取，但聊天记录保存未确认，视觉复核未完成。');
      if(!current())throw new Error('会话已变化，图片未发送。');
      const images=receipt.value.images.map(({path,...image},index)=>({...image,attachment_id:saved.attachments[index].id}));
      const response={...result,result:{...result.result,value:{...receipt,value:{...receipt.value,images}}},visualReview:{status:'images_ready',imageCount:images.length,note:'请根据实际收到的图片复核，区分图中观察、模型数据确认和未确认；图片不是精确碰撞检测。'}};
      return {success:true,contentItems:[{type:'inputText',text:JSON.stringify(response)},...captured.contentItems]};
    }catch(error){
      return {success:false,contentItems:[{type:'inputText',text:JSON.stringify({status:'visual_review_incomplete',visualReview:{status:'incomplete',message:safeChatText(error?.message??'视图图片未能核实，视觉复核未完成。')},restoration:receipt?.value?.restoration??null})}]};
    }
  }
  async function decideModelDynamic(run,entry,digest,decision,userDecisionProof){
    modelOperationsInFlight.add(entry.ticket);
    try{
      if(decision==='accept'&&requireLicense&&!(await accounts.authorizeCurrentLicense()).allowed){
        await modelPermission.cancel({ticket:entry.ticket});
        recordModelApprovalResult(run,entry,{status:'not_started',code:'MODEL_LICENSE_REVALIDATION_FAILED'});
        if(!entry.done&&currentDynamic(run,entry)){entry.done=true;const i=run.dynamicRequests?.indexOf(entry)??-1;if(i>=0)run.dynamicRequests.splice(i,1);try{entry.request.respond({success:false,contentItems:[{type:'inputText',text:'软件授权未通过实时核验，本次未执行。'}]});}catch{}}
        return;
      }
      if(entry.done||!currentDynamic(run,entry)){discardDynamic(run,entry,{reject:true});return;}
      const result=await modelPermission.decide({ticket:entry.ticket,digest,decision,...userDecisionProof?{userDecisionProof}:{}});
      recordModelApprovalResult(run,entry,result);
      if(result?.status==='unconfirmed')retainModelReceipt({ticket:entry.ticket,client:run.client,sourceSession:entry.modelGrant.session,conversationId:run.conversationId,tool:entry.modelTool,scope:entry.modelGrant.scope,facts:entry.modelGrant.facts,checking:false,checkRevision:0,checkView:null,checked:null});
      if(entry.done)return;
      const visualWork=visualDynamicOutput(run,entry,result);projectAgentWorks.add(visualWork);
      let visualOutput;try{visualOutput=await visualWork;}finally{projectAgentWorks.delete(visualWork);}
      if(entry.done)return;
      entry.done=true;clearTimeout(entry.timer);const i=run.dynamicRequests?.indexOf(entry)??-1;if(i>=0)run.dynamicRequests.splice(i,1);
      if(currentDynamic(run,entry))try{entry.request.respond(visualOutput??{success:result.status==='completed',contentItems:[{type:'inputText',text:JSON.stringify(result)}]});}catch{}
      else try{entry.request.discard();}catch{}
      if(active===run)conversation(run.client);
    }catch(cause){const failure=modelPermissionErrorView(cause);recordModelApprovalResult(run,entry,{status:entry.modelDispatched?'unconfirmed':'not_started',code:failure.code});auditModelDynamic(run,entry,'rejected',{stage:'decision',code:failure.code,outcome:entry.modelDispatched?'unconfirmed':'not_started'});discardDynamic(run,entry,{reject:true});if(active===run)conversation(run.client);}
    finally{modelOperationsInFlight.delete(entry.ticket);allConversations();allState();}
  }
  function requestShutdown(client){
    if(!shutdownOwner)shutdownOwner={client,proof:randomBytes(24).toString('hex')};
    audit('lifecycle.jsonl',{code:'service_stopping',reason:'manual_stop'},true);
    // The owned writer is closed by close(); do not enqueue a fictitious final
    // log afterward or mistake its historical write error for retained handles.
    void close().then(()=>{if(!ownedAudit)audit('lifecycle.jsonl',{code:'service_closed'},true);}).catch(()=>{if(!ownedAudit)audit('lifecycle.jsonl',{code:'service_cleanup_pending'},true);});
  }
  function channel(id){if(!streams.has(id))streams.set(id,new Set());return streams.get(id);}
  function closeStreams(id){const outputs=[...(streams.get(id)||[])];streams.delete(id);for(const output of outputs)if(!output.writableEnded&&!output.destroyed)output.end();}
  function clearSessions(){skillSelections.clear();sessions.clear();conversations.clear();commandReviews=new WeakMap();for(const owner of receiptOwners)if(owner!==viewerPending?.owner)void releaseReceiptOwner(owner);}
  function retireCommandViews(){const inspecting=active?.inspection?active.receiptOwner:null;commandViews=new WeakMap();commandReviews=new WeakMap();for(const owner of receiptOwners)if(owner!==inspecting&&owner!==viewerPending?.owner)void releaseReceiptOwner(owner);}
  function clearAccountSessions(reason){
    cancelAutoReconnect();autoReadyGeneration=null;
    if(accessServices){accessPreparations.clear();accessMessages.clear();const work=accessServices.deactivate().finally(()=>projectAgentWorks.delete(work));projectAgentWorks.add(work);void work.catch(()=>{});}
    projectKnowledge=null;projectBind=null;viewerOwner=null;viewerProject=null;materialOwner=null;
    interruptionOwner=null;codexOperation=null;confirmation.invalidate('buildx_changed');retireSessions(reason);
  }
  function retireSessions(reason){
    revokeModelGrant();
    retireCommandViews();
    interruptContextRefresh(reason);
    for(const id of [...streams.keys()])closeStreams(id);
    if(active){if(active.kind==='command')retireCommand(active,reason);if(!accountDraining){accountDraining=true;void cancel(active,'account');}}
    else clearSessions();
  }
  const accounts=createPanelAccounts({cookieName:workspace.kind==='customer-chat'?'buildx_customer_chat_session':'buildx_model_session',auth:accountAuth,required:requireAccount,getBusy:()=>Boolean(active||contextBusy||viewerBusy||resetting||accountDraining||closing||codexOperation||historyControl||historyWrites.size||receiptCleanupFaults.size),onClear:clearAccountSessions});
  const confirmation=createCodexConfirmation({required:workspace.kind!=='source-development'&&accounts.required,onInvalidate:()=>{
    retireSessions('本机Codex连接确认已失效；旧上下文和任务结果需重新核对。');
  }});
  function historyIdentity(req){
    const identity=accounts.bindingIdentity(req);
    if(accounts.required&&!identity?.verified)throw new Error('请先登录并核验 BuildX 账号。');
    return {scope:identity?.verified?'model:user:'+identity.userId:'model:research-local',identity:identity?{sessionId:identity.sessionId,userId:identity.userId,generation:identity.generation}:null};
  }
  function sameHistoryIdentity(facts,req){
    if(closing)return false;
    try{const current=historyIdentity(req);return current.scope===facts.scope&&JSON.stringify(current.identity)===JSON.stringify(facts.identity);}catch{return false;}
  }
  function libraryBinding(req,client){
    const facts=historyIdentity(req),target=session(client,history?facts.scope:undefined),state=codex.state;
    return {facts,target,client,conversationId:target.conversationId,epoch:connectionEpoch,generation:state.connectionGeneration,revision:state.codexAccount?.accountRevision};
  }
  function libraryBindingCurrent(binding,req){
    const state=codex.state;
    return !resetting&&!accountDraining&&sameHistoryIdentity(binding.facts,req)&&sessions.get(binding.client)===binding.target&&binding.target.conversationId===binding.conversationId&&connectionEpoch===binding.epoch&&state.connectionGeneration===binding.generation&&state.codexAccount?.accountRevision===binding.revision;
  }
  function libraryOwner(facts){
    if(!materialIndexFactory)return null;
    if(materialOwner&&JSON.stringify(materialOwner.facts)===JSON.stringify(facts))return materialOwner;
    const service=materialIndexFactory();
    if(!Object.isFrozen(service)||['addRoot','removeRoot','listRoots','listChildren','readFile','setProjectDocument',...(materialStoreFactory?['restoreRoot']:[])].some(name=>typeof service[name]!=='function'))throw new Error('资料库服务不可用。');
    const owner={facts,service,documentKey:null,revision:0,store:null,storageError:null};
    owner.ready=(async()=>{
      if(!materialStoreFactory)return;
      let entry=materialStores.get(facts.scope);
      if(!entry){
        const store=materialStoreFactory(facts.scope);
        if(!Object.isFrozen(store)||['ready','list','add','remove','close'].some(name=>typeof store[name]!=='function'))throw new Error('资料库存储不可用。');
        entry={store,ready:store.ready()};materialStores.set(facts.scope,entry);
      }
      owner.store=entry.store;
      const ready=await entry.ready;if(ready?.ok!==true){owner.storageError=ready?.error??{message:'资料地址存储不可用。'};return;}
      const loaded=await owner.store.list();if(loaded?.ok!==true){owner.storageError=loaded?.error??{message:'资料地址读取失败。'};return;}
      for(const item of loaded.value.entries){const restored=await service.restoreRoot(item);if(restored?.ok!==true){owner.storageError=restored?.error??{message:'资料地址恢复失败。'};return;}}
    })().catch(()=>{owner.storageError={message:'资料地址存储不可用。'};});
    materialOwner=owner;return owner;
  }
  async function refreshLibraryProject(owner,current){
    let key='unavailable',documentPath='__unavailable__';
    try{
      if(!materialStatusPending){
        const pending=Promise.resolve().then(()=>invokeWorkbench('revit_workbench_status',{},{timeout:1200})).catch(()=>null);
        materialStatusPending=pending;void pending.finally(()=>{if(materialStatusPending===pending)materialStatusPending=null;});
      }
      let timer;const status=await Promise.race([materialStatusPending,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1200);})]).finally(()=>clearTimeout(timer));
      if(status&&typeof status.hostSession==='string'&&status.hostSession&&status.document&&typeof status.document.title==='string'&&typeof status.document.path==='string'){
        documentPath=status.document.path;key=JSON.stringify([status.hostSession,status.document.title,documentPath]);
      }
    }catch{/* The selected roots still work while Revit is unavailable. */}
    if(!current())return false;
    if(owner.documentKey!==key){
      const result=await owner.service.setProjectDocument({documentPath});
      if(!current()||result?.ok!==true)return false;
      owner.documentKey=key;owner.revision++;
    }
    return current();
  }
  function libraryOperation(owner,method,parameters,current,{mutating=false}={}){
    const work=materialQueue.then(async()=>{
      if(!current())return {ok:false,error:{code:'LIBRARY_CHANGED',message:'账号或当前项目已变化，请刷新资料库。'}};
      await owner.ready;if(!current())return {ok:false,error:{code:'LIBRARY_CHANGED',message:'账号或当前项目已变化，请刷新资料库。'}};
      if(mutating&&owner.storageError)return {ok:false,error:owner.storageError};
      const roots=owner.service.listRoots(),projectRoot=roots?.ok===true&&roots.value?.roots?.some(item=>item.id===parameters?.rootId&&item.source==='project');
      const checkProject=method==='listRoots'||projectRoot;
      if(checkProject&&!await refreshLibraryProject(owner,current))return {ok:false,error:{code:'LIBRARY_CHANGED',message:'账号或当前项目已变化，请刷新资料库。'}};
      const revision=owner.revision;
      const rootToRemove=method==='removeRoot'?owner.service.listRoots()?.value?.roots?.find(item=>item.id===parameters?.id&&item.source==='user'):null;
      if(method==='removeRoot'&&owner.store&&rootToRemove){
        const saved=await owner.store.remove({path:rootToRemove.path,kind:rootToRemove.kind});
        if(saved?.ok!==true){owner.storageError=saved?.error??{message:'资料地址移除结果尚未确认。'};return saved;}
      }
      if(typeof owner.service[method]!=='function')return {ok:false,error:{code:'LIBRARY_UNAVAILABLE',message:'当前资料库暂不支持此操作。'}};
      const result=await owner.service[method](parameters,{isCurrent:()=>current()&&owner.revision===revision});
      if(method==='addRoot'&&owner.store&&result?.ok===true&&!result.value.existing){
        const added=result.value.root,saved=await owner.store.add({path:added.path,kind:added.kind});
        if(saved?.ok!==true){owner.storageError=saved?.error??{message:'资料地址保存结果尚未确认。'};return saved;}
      }
      if(!current())return {ok:false,error:{code:['openFile','openFolder'].includes(method)?'LIBRARY_OPEN_UNCONFIRMED':'LIBRARY_CHANGED',message:['openFile','openFolder'].includes(method)?'账号或连接已变化；打开请求可能已发送，请检查 Windows 窗口。':'账号或当前项目已变化，请刷新资料库。'}};
      if(mutating){if(result?.ok===true)owner.revision++;return result;}
      if(projectRoot&&(!await refreshLibraryProject(owner,current)||owner.revision!==revision))return {ok:false,error:{code:['openFile','openFolder'].includes(method)?'LIBRARY_OPEN_UNCONFIRMED':'LIBRARY_CHANGED',message:['openFile','openFolder'].includes(method)?'当前项目已变化；打开请求可能已发送，请检查 Windows 窗口。':'当前项目已变化，请刷新资料库。'}};
      if(method==='listRoots'&&result?.ok===true&&owner.storageError)return {...result,value:{...result.value,storageStatus:'unavailable',storageMessage:owner.storageError.message}};
      return result;
    }).catch(()=>({ok:false,error:{code:'LIBRARY_UNAVAILABLE',message:'资料库暂不可用。'}}));
    materialQueue=work.then(()=>{},()=>{});return work;
  }
  function remember(s,scope){
    if(!history||!scope)return;
    if(!conversations.has(s.conversationId)&&conversations.size>=64){
      const selectedSessions=new Set(sessions.values()),free=[...conversations].find(([,value])=>!selectedSessions.has(value)&&!value.run&&![...modelReceipts.values()].some(receipt=>receipt.sourceSession===value)&&value.persistence?.status!=='failed'&&(value.historyReadOnly||value.persistence?.status==='saved'||!value.messages.length&&!value.historyDraft?.text));
      if(!free)throw new Error('已打开的对话过多，请关闭多余页面。');const abandoned=commandViews.get(free[1])?.receiptOwner;if(abandoned)void releaseReceiptOwner(abandoned);conversations.delete(free[0]);
    }
    s.historyScope=scope;conversations.set(s.conversationId,s);
  }
  const session=(id,scope)=>{
    if(!sessions.has(id)){
      if(sessions.size>=24){const free=[...sessions].find(([key])=>!streams.get(key)?.size&&active?.client!==key&&contextBusy?.client!==key);if(!free)throw new Error('面板会话过多，请关闭多余页面');if(!conversations.has(free[1].conversationId)){const owner=commandViews.get(free[1])?.receiptOwner;if(owner)void releaseReceiptOwner(owner);}skillSelections.delete(free[0]);sessions.delete(free[0]);}
      const s=new ChatSession({notices:selected.sessionNotices});remember(s,scope);sessions.set(id,s);
    }
    const s=sessions.get(id);if(history&&scope&&s.historyScope!==scope){if(s.historyScope)throw new Error('对话身份已变化，请刷新。');remember(s,scope);}return s;
  };
  const draftOf=s=>({... (s.historyDraft??{text:'',includeSelection:false})});
  function setDraft(s,value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['text','includeSelection'].includes(key))||typeof value.text!=='string'||value.text.length>16000||typeof value.includeSelection!=='boolean')throw new Error('草稿格式无效。');
    s.historyDraft={text:value.text,includeSelection:value.includeSelection};
  }
  function sessionView(s){const value=s.view();if(history)value.conversation.persistence={...(s.persistence??{status:'unsaved'})};if(accessServices)value.accessPolicy=accessPolicyView(s);return value;}
  const emit=(id,event,data)=>{const outputs=streams.get(id);for(const res of outputs||[]){if(res.writableEnded||res.destroyed){outputs.delete(res);continue;}res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');}};
  const snapshot=id=>{
    const s=session(id),activity=codexOperation?.kind==='model-permission-check'?'正在等待 Revit 核实当前模型与执行权限…':active?.kind==='command'&&active.session===s?(active.inspection?'正在核对回执…':active.cancelRequested?'正在停止；等待已发出查询的回执…':'正在读取模型…'):s.activity;
    const input=active?.kind==='chat'&&active.client===id&&!active.cancelRequested&&active.turnId?active.userInputs?.find(entry=>entry.params.turnId===active.turnId):null;
    const pending=(dynamicApproval||modelPermission)&&active?.kind==='chat'&&active.client===id&&!active.cancelRequested&&active.turnId?active.dynamicRequests?.find(entry=>entry.preview&&!entry.done&&!entry.deciding&&entry.preview.deadline>Date.now()&&currentDynamic(active,entry)):null;
    return {state:stateView(),workspace,busy:Boolean(active||contextBusy||codexOperation),session:sessionView(s),...(input?{userInput:{id:input.token,conversationId:active.conversationId,questions:input.params.questions,isBlocking:input.params.isBlocking}}:{userInput:null}),...(dynamicApproval||modelPermission?{dynamicApproval:pending?.preview??null}:{}),...(modelPermission?{dynamicApprovalResult:modelApprovalResultView(id,s),modelPermission:modelPermissionView(id,s),modelReceipt:modelReceiptView(id,s)}:{}),...(directCommandsAvailable?{command:commandView(s)}:{}),...(history?{draft:draftOf(s),history:{available:true,activeId:s.conversationId}}:{}),activity,error:s.error||(s.persistence?.status==='failed'?s.persistence.message:null)};
  };
  const conversation=id=>{const target=session(id);for(const [clientId,s] of sessions)if(s===target)emit(clientId,'conversation',snapshot(clientId));};
  const allConversations=()=>{for(const id of sessions.keys())emit(id,'conversation',snapshot(id));};
  const allState=()=>{for(const id of sessions.keys())emit(id,'state',stateView());};
  function persist(s,scope=s.historyScope,force=false){
    if(!history||s.historyReadOnly||!scope)return Promise.resolve({ok:true});
    if(!force&&!s.persistence&&!s.messages.length&&!draftOf(s).text)return Promise.resolve({ok:true});
    const view=s.view(),draft=draftOf(s),saveOwner={};s.historySaveOwner=saveOwner;s.persistence={status:'pending'};s.historyUpdatedAt=new Date().toISOString();allConversations();
    const work=(async()=>{let result;try{result=await history.save(scope,view,draft);}catch{result={ok:false,error:{code:'CHAT_SAVE_UNKNOWN',message:'本地保存尚未确认，请保留当前对话并核对。'}};}
      if(s.historySaveOwner===saveOwner){s.persistence=result.ok?{status:'saved'}:{status:'failed',message:safeChatText(result.error?.message||'本地保存尚未确认，请先核对。')};allConversations();}return result;
    })();historyWrites.add(work);void work.finally(()=>historyWrites.delete(work)).catch(()=>{});return work;
  }
  async function drainHistory(){while(historyWrites.size)await Promise.all([...historyWrites]);}
  async function historyView(scope,activeId,cursor){
    const result=await history.list(scope,{...(cursor?{cursor}:{}),limit:100});if(!result.ok)throw new Error(result.error?.message||'无法读取历史对话。');
    const list=new Map((result.sessions||[]).map(item=>[item.id,{...item,readOnly:true}]));
    for(const s of conversations.values())if(s.historyScope===scope&&!cursor){const first=s.messages.find(item=>item.role==='user');list.set(s.conversationId,{id:s.conversationId,title:first?.text.replace(/\s+/gu,' ').slice(0,50)||'新对话',updatedAt:s.historyUpdatedAt||list.get(s.conversationId)?.updatedAt||new Date().toISOString(),messageCount:s.messages.length,preview:s.messages.at(-1)?.text.slice(0,100)||'',readOnly:s.historyReadOnly===true});}
    return {available:true,activeId,sessions:[...list.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id)),complete:result.complete!==false,nextCursor:result.nextCursor??null,...(result.issues?.length?{issues:result.issues}:{})};
  }
  async function captureContext(id,s,options,current,messageId=null){
    if(!current())return false;
    let context;
    try{context=await captureChatContext(options,invokeWorkbench);}
    catch(error){if(current()){s.setContext(null,safeChatText(error.message||'上下文读取失败，请重新读取。'),messageId);conversation(id);}throw error;}
    if(!current())return false;
    s.setContext(context,null,messageId);conversation(id);return true;
  }
  function interruptContextRefresh(reason){
    const read=contextBusy;if(!read)return;
    if(read.current())read.session.setContext(null,reason);
    contextBusy=null;allConversations();
  }
  function commandBinding(){
    if(commandsIndependent)return {local:true,identity:interruptionIdentity(accounts.bindingIdentity())};
    return {connectionEpoch,connectionGeneration:codex.state.connectionGeneration??null,accountRevision:codex.state.codexAccount?.accountRevision??null,identity:interruptionIdentity(accounts.bindingIdentity())};
  }
  function sameCommandBinding(binding){
    const current=commandBinding(),identity=accounts.bindingIdentity();
    if(commandsIndependent)return !closing&&!resetting&&binding.local===true&&(binding.identity===null?current.identity===null:sameIdentity(binding.identity,current.identity))&&(!accounts.required||identity?.verified===true);
    return !closing&&!resetting&&codex.state.ready===true&&profileMatches(codex.state)&&binding.connectionEpoch===current.connectionEpoch&&binding.connectionGeneration===current.connectionGeneration&&binding.accountRevision===current.accountRevision&&
      (binding.identity===null?current.identity===null:sameIdentity(binding.identity,current.identity))&&(!accounts.required||identity?.verified===true);
  }
  function commandView(s){
    const value=commandViews.get(s);
    return value&&value.view.conversationId===s.conversationId&&sameCommandBinding(value.binding)?structuredClone(value.view):null;
  }
  function reviewedCommandSnapshot(record){
    if(!plainData(record)||typeof record.command_id!=='string'||typeof record.revision!=='string'||typeof record.name!=='string'||typeof record.description!=='string'||(typeof record.code==='string')===Array.isArray(record.steps))return null;
    const result={};for(const key of ['schema_version','command_id','revision','name','description','code','steps','parameters','parameter_labels','parameter_options'])if(Object.hasOwn(record,key))result[key]=record[key];
    try{const copy=structuredClone(result);return JSON.stringify(copy).length<=65536?copy:null;}catch{return null;}
  }
  function commandCurrent(run){return active===run&&!run.retired&&sessions.get(run.client)===run.session&&run.session.conversationId===run.conversationId&&run.session.contextEpoch===run.contextEpoch&&sameCommandBinding(run.binding);}
  function commandProgress(run,event){
    // Transport events are observations, never proof that a Revit API operation
    // has started. A cancelled, retired or completed run cannot be revived.
    if(!commandCurrent(run)||run.cancelRequested||!plainData(event)||event.code!=='phase_timing'||event.source!=='workbench')return;
    const phases={request_prepared:'preparing',published:'waiting_revit',receipt_received:'checking_result'},phase=Object.hasOwn(phases,event.phase)?phases[event.phase]:null;
    const requestId=event.requestId,operation=event.operation;
    if(!phase||typeof requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)||typeof operation!=='string'||!/^[A-Za-z0-9_.:-]{1,120}$/.test(operation))return;
    const entry=commandViews.get(run.session);
    if(!entry||entry.view.executionId!==run.executionId||entry.view.status!=='running')return;
    if(event.phase==='request_prepared'){
      if(run.progressRequestId!==requestId){
        run.progressRequests??=new Set();
        if(run.progressRequests.has(requestId)||run.progressRequests.size>=256)return;
        run.progressRequests.add(requestId);run.progressRequestId=requestId;run.progressOperation=operation;run.progressOrder=0;
      }
    }else if(!run.progressRequestId){
      run.progressRequests=new Set([requestId]);run.progressRequestId=requestId;run.progressOperation=operation;run.progressOrder=0;
    }
    const order={preparing:0,waiting_revit:1,checking_result:2}[phase];
    if(requestId!==run.progressRequestId||operation!==run.progressOperation||order<run.progressOrder)return;
    run.progressOrder=order;
    if(entry.view.progress?.phase===phase&&entry.view.progress.requestId===requestId&&entry.view.progress.operation===operation)return;
    const stamp=phaseClock(),changed=entry.view.progress?.phase!==phase;
    entry.view={...entry.view,progress:{phase,requestId,operation,updatedAt:stamp.utc,elapsedMs:Math.max(0,stamp.ticks-run.phaseTiming.start.ticks)}};
    if(changed)conversation(run.client);
  }
  function retireCommand(run,reason){
    if(run.kind!=='command')return;
    run.retired=true;run.cancelRequested=true;run.retireReason=reason;commandViews.delete(run.session);commandReviews.delete(run.session);
  }
  async function releaseReceiptOwner(owner,confirmedCabinet=false){
    if(cabinetReceiptOwners.has(owner)&&!confirmedCabinet)return false;
    if(!owner)return true;
    if(receiptClosing.has(owner))return receiptClosing.get(owner);
    const work=(async()=>{try{const result=await owner.close();if(result?.ok!==true||result.value?.closed!==true)throw new Error();receiptOwners.delete(owner);cabinetReceiptOwners.delete(owner);receiptCleanupFaults.delete(owner);return true;}
      catch{receiptOwners.add(owner);receiptCleanupFaults.add(owner);return false;}})();receiptClosing.set(owner,work);
    try{return await work;}finally{receiptClosing.delete(owner);}
  }
  function completeCommand(run,result){
    if(active!==run)return;
    phaseTiming(run,'command_finished',phaseClock(),{outcome:result?.ok===true?'received':result?.error?.outcome||'unconfirmed'});
    let recovery=captureReceiptOwner(result?.receiptOwner),successCleanupPending=false;if(recovery){receiptOwners.add(recovery);if(cabinetReceiptCommand(run.commandId))cabinetReceiptOwners.add(recovery);}
    const retainedDirect=Boolean(recovery&&run.permissionGrant&&(result?.ok!==true||run.cancelRequested||!commandCurrent(run)));
    if(retainedDirect){
      cabinetReceiptOwners.add(recovery);const ticket=randomUUID();
      retainModelReceipt({ticket,client:run.client,sourceSession:run.session,conversationId:run.conversationId,executionId:run.executionId,tool:run.commandId,scope:run.permissionGrant.scope,facts:run.permissionGrant.facts,directOwner:recovery,checking:false,checkRevision:0,checkView:null,checked:null});
    }
    if(commandCurrent(run)){
      let privateLifecycleInspection=null;
      let view={executionId:run.executionId,conversationId:run.conversationId,commandId:run.commandId,status:'unknown',cancelRequested:run.cancelRequested};
      if(result?.ok===true&&plainData(result.value)&&result.value.command===run.commandId){
        try{
          view.result=structuredClone(result.value);
          if(run.lifecycleInspectionGrant&&run.commandId==='revit_family_inspect_job'){
            privateLifecycleInspection=structuredClone(result.value.data);
            const body=view.result?.data?.value;
            if(plainData(body?.approval)){delete body.approval.save_token;delete body.approval.close_token;}
            if(plainData(body?.approval_validation))delete body.approval_validation.approval_token;
          }
          view.requestIds=[...(result.value.requestIds||[])];view.status='completed';
        }
        catch{view.status='unknown';view.error={code:'COMMAND_READ_UNCONFIRMED',outcome:'unconfirmed',message:'结果投影尚未确认，请核对原回执。'};}
      }
      else{
        const error=result?.error;
        view.status=error?.code==='COMMAND_INTERRUPTED'&&error.outcome==='not_started'?'interrupted':Object.hasOwn(commandFailureOutcomes,error?.code)&&commandFailureOutcomes[error.code]===error.outcome?'failed':'unknown';
        view.error={code:typeof error?.code==='string'?error.code:'COMMAND_READ_UNCONFIRMED',message:safeChatText(error?.message||'命令回执尚未确认；不会自动重试。'),...(typeof error?.stage==='string'?{stage:error.stage}:{}),...(typeof error?.outcome==='string'?{outcome:error.outcome}:{})};
        const nativeFailure=commandNativeFailure(error?.nativeFailure);if(nativeFailure)view.error.nativeFailure=nativeFailure;
        if(Array.isArray(result?.evidence?.requestIds))view.requestIds=[...result.evidence.requestIds];
        const execution=result?.evidence?.producerResult?.execution;
        if(plainData(execution)&&['unknown','partial','failed','not_started'].includes(execution.status)&&Array.isArray(execution.steps)&&execution.steps.length<=10&&execution.steps.every(step=>plainData(step)&&typeof step.id==='string'&&step.id.length<=64&&typeof step.tool==='string'&&step.tool.length<=100&&['succeeded','failed','unknown','not_started'].includes(step.status))){
          view.sequence={status:execution.status,steps:execution.steps.map(step=>({id:step.id,tool:step.tool,status:step.status}))};
        }
      }
      // Build the complete view first. The verified success owner's close and
      // the view assignment below then happen without an asynchronous gap.
      if(recovery&&cabinetReceiptCommand(run.commandId)&&view.status==='completed'&&run.confirmed===true&&!run.cancelRequested){
        let cleanup;try{cleanup=recovery.close();}catch{}
        if(plainData(cleanup)&&cleanup.ok===true&&cleanup.value?.closed===true){receiptOwners.delete(recovery);cabinetReceiptOwners.delete(recovery);receiptCleanupFaults.delete(recovery);recovery=null;}
        else{receiptCleanupFaults.add(recovery);successCleanupPending=true;}
      }
      if(recovery&&cabinetReceiptCommand(run.commandId)&&view.status==='completed'){view.status='unknown';view.error={code:'COMMAND_READ_UNCONFIRMED',outcome:'unconfirmed',message:'回执资源仍需核对与清理；请核对原回执。'};}
      if(recovery&&view.status==='unknown'&&retainedDirect){view.canInspectReceipt=false;view.error={...view.error,message:'请在对话中核对并确认此模型操作的原回执，不要重复执行。'};}
      else if(recovery&&view.status==='unknown'){view.canInspectReceipt=true;view.receiptCheck={checking:false,revision:0,...successCleanupPending?{cleanupPending:true}:{}};}
      else if(recovery)void releaseReceiptOwner(recovery);
      // The last displayed result and the reviewed source have different
      // lifetimes. Model dropdown reads replace the former, while this exact
      // revision remains reviewed in its original conversation and context.
      if(run.commandId==='revit_get_command'){
        const record=view.status==='completed'?reviewedCommandSnapshot(view.result?.data?.value??view.result?.data):null;
        if(record&&record.command_id===run.commandReviewIdentity?.command_id&&record.revision===run.commandReviewIdentity?.revision)commandReviews.set(run.session,{binding:run.binding,conversationId:run.conversationId,contextEpoch:run.contextEpoch,record});
        else commandReviews.delete(run.session);
      }
      commandViews.set(run.session,{view,binding:run.binding,...privateLifecycleInspection?{privateLifecycleInspection}:{},...recovery&&view.status==='unknown'&&!retainedDirect?{receiptOwner:recovery}:{}});
    }else{commandViews.delete(run.session);commandReviews.delete(run.session);if(recovery)void releaseReceiptOwner(recovery);}
    active=null;
    if(accountDraining){for(const id of [...streams.keys()])closeStreams(id);clearSessions();accountDraining=false;}
    allConversations();allState();
  }
  function startCommand(client,s,commandId,parameters,confirmed=false,sourceDocument=undefined,permissionGrant=null,reviewedCommand=null,reviewedFamily=null,reviewedLifecycle=null,lifecycleInspectionGrant=null,explicitInspectionSource=false){
    const previous=commandViews.get(s);
    const run={kind:'command',client,session:s,executionId:randomUUID(),conversationId:s.conversationId,contextEpoch:s.contextEpoch,commandId,confirmed,permissionGrant,lifecycleInspectionGrant,cancelRequested:false,retired:false,binding:commandBinding(),commandReviewIdentity:commandId==='revit_get_command'?{command_id:parameters.command_id,revision:parameters.revision}:null,work:null};
    run.phaseTiming={start:phaseClock()};
    let accept;run.acceptance=new Promise(resolve=>{accept=resolve;});active=run;
    run.work=Promise.resolve().then(async()=>{
      const modelDirectOwners=new Set([...modelReceipts.values()].map(receipt=>receipt.directOwner).filter(Boolean));
      if([...cabinetReceiptOwners].some(owner=>!modelDirectOwners.has(owner))){accept(false);if(active===run)active=null;allConversations();allState();return;}
      if(previous?.receiptOwner&&!await releaseReceiptOwner(previous.receiptOwner)){
        if(commandCurrent(run)&&commandViews.get(s)===previous){previous.view={...previous.view,canInspectReceipt:true,receiptCheck:{...previous.view.receiptCheck,checking:false,cleanupPending:true,message:'原回执句柄清理尚未确认，请再次核对。'}};}
        accept(false);if(active===run)active=null;
        if(accountDraining){for(const id of [...streams.keys()])closeStreams(id);clearSessions();accountDraining=false;}
        allConversations();allState();return;
      }
      if(!commandCurrent(run)){accept(false);completeCommand(run,{ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',message:'连接已变化，未发送新查询。',outcome:'unconfirmed'}});return;}
      if(lifecycleInspectionGrant){
        const capable=await isLifecycleCapable(lifecycleInspectionGrant.scope.document);
        if(modelGrant!==lifecycleInspectionGrant||!modelGrantCurrent(lifecycleInspectionGrant)||!commandCurrent(run)){accept(false);completeCommand(run,{ok:false,error:{code:'COMMAND_NOT_STARTED',message:'模型或权限已变化，未读取作业。',outcome:'not_started'}});return;}
        // Older hosts retain their existing read-only inspection; they cannot
        // issue the private token and therefore never enable save/close.
        if(!capable){lifecycleInspectionGrant=null;run.lifecycleInspectionGrant=null;if(!explicitInspectionSource)sourceDocument=undefined;}
      }
      if(permissionGrant){
        let matches=false;try{matches=modelGrant===permissionGrant&&modelGrantCurrent(permissionGrant)&&sameWorkbenchDocumentIdentity(permissionGrant.scope.document,await modelPermissionServices.observeDocument({accessPolicy:permissionGrant.scope.accessPolicy}));if(matches&&accessServices)matches=(await accessServices.authorize(permissionGrant.facts.scope,permissionGrant.scope.document.path,{write:true})).ok===true;}catch{}
        if(!matches||modelGrant!==permissionGrant||!modelGrantCurrent(permissionGrant)||!commandCurrent(run)){revokeModelGrant();accept(false);completeCommand(run,{ok:false,error:{code:'COMMAND_NOT_STARTED',message:'模型或权限已变化，命令未发送。',outcome:'not_started'}});return;}
      }
      if(reviewedCommand){
        let same=false;try{const fresh=await modelPermissionServices.readCommand({command_id:parameters.command_id,revision:parameters.revision},{sourceDocument,shouldContinue:()=>commandCurrent(run)&&modelGrant===permissionGrant&&modelGrantCurrent(permissionGrant)});same=JSON.stringify(reviewedCommandSnapshot(fresh))===JSON.stringify(reviewedCommand);}catch{}
        if(!same||!commandCurrent(run)||modelGrant!==permissionGrant||!modelGrantCurrent(permissionGrant)){accept(false);completeCommand(run,{ok:false,error:{code:'COMMAND_NOT_STARTED',message:'个人命令准确版本或权限已变化，未执行。',outcome:'not_started'}});return;}
      }
      if(reviewedFamily){
        let same=false;try{const fresh=await modelPermissionServices.inspectFamilyJob(reviewedFamily.job_handle,{sourceDocument,shouldContinue:()=>commandCurrent(run)&&modelGrant===permissionGrant&&modelGrantCurrent(permissionGrant)});same=sameApprovedFamily(approvedFamilyFacts(fresh,permissionGrant.scope.document,reviewedFamily.job_handle),reviewedFamily);}catch{}
        if(!same||!commandCurrent(run)||modelGrant!==permissionGrant||!modelGrantCurrent(permissionGrant)){accept(false);completeCommand(run,{ok:false,error:{code:'COMMAND_NOT_STARTED',message:'族作业、文件或模型权限已变化，未执行。',outcome:'not_started'}});return;}
      }
      if(reviewedLifecycle&&(!await isLifecycleCapable(permissionGrant.scope.document)||Date.now()>=reviewedLifecycle.expiresAt||!commandCurrent(run)||!modelGrantCurrent(permissionGrant))){accept(false);completeCommand(run,{ok:false,error:{code:'COMMAND_NOT_STARTED',message:'族作业确认已过期或宿主能力已变化，请重新读取并确认。',outcome:'not_started'}});return;}
      commandViews.set(s,{binding:run.binding,view:{executionId:run.executionId,conversationId:run.conversationId,commandId,status:'running',cancelRequested:false,progress:{phase:'preparing',updatedAt:run.phaseTiming.start.utc,elapsedMs:0}}});accept(true);allConversations();
      phaseTiming(run,'command_started');
      let result;
      try{result=await invokeReadonlyCommand(commandId,parameters,{confirmed,...permissionGrant?.scope.accessPolicy?{accessPolicy:permissionGrant.scope.accessPolicy,creationScope:{account:permissionGrant.scope.account,conversationId:permissionGrant.scope.conversationId}}:{},...sourceDocument===undefined?{}:{sourceDocument},...lifecycleInspectionGrant?{requestLifecycleApproval:true,expectedHostSession:lifecycleInspectionGrant.scope.document.session}:{},...reviewedFamily?{approvedFamily:reviewedFamily}:{},...reviewedLifecycle?{approvedLifecycle:reviewedLifecycle.approvedLifecycle,approvedFamilyIdentity:reviewedLifecycle.approvedFamilyIdentity}:{},shouldContinue:()=>commandCurrent(run)&&!run.cancelRequested&&(!permissionGrant||modelGrant===permissionGrant&&modelGrantCurrent(permissionGrant))&&(!lifecycleInspectionGrant||modelGrant===lifecycleInspectionGrant&&modelGrantCurrent(lifecycleInspectionGrant))&&(!reviewedLifecycle||Date.now()<reviewedLifecycle.expiresAt),onTiming:event=>{try{commandProgress(run,event);}catch{/* Diagnostic observers cannot change execution. */}}});}
      catch(error){result={ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',message:error?.message||'命令回执尚未确认；不会自动重试。',outcome:'unconfirmed'}};}
      try{completeCommand(run,result);}catch(error){
        completeCommand(run,{ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',message:error?.message||'命令结果无法核对。',outcome:'unconfirmed'}});
      }
    });
    allConversations();return run;
  }
  function startReceiptCheck(client,s,entry){
    const run={kind:'command',inspection:true,receiptOwner:entry.receiptOwner,client,session:s,executionId:entry.view.executionId,conversationId:s.conversationId,contextEpoch:s.contextEpoch,commandId:entry.view.commandId,cancelRequested:false,retired:false,binding:entry.binding,work:null};
    const revision=(entry.view.receiptCheck?.revision??0)+1,originalError=structuredClone(entry.view.error);
    entry.view={...entry.view,receiptCheck:{...entry.view.receiptCheck,checking:true,revision}};active=run;
    run.work=Promise.resolve().then(async()=>{
      let checked;try{checked=await entry.receiptOwner.inspect();}catch{checked={ok:false,error:{code:'RECEIPT_UNCONFIRMED'}};}
      const sameEntry=commandViews.get(s)===entry;
      if(commandCurrent(run)&&sameEntry){
        const allowed=['pending','received','unconfirmed','host_changed','failed','expired','not_started'],data=checked?.ok===true&&plainData(checked.value)&&allowed.includes(checked.value.status)?checked.value:null;
        const cleanupPending=checked?.error?.code==='RECEIPT_CLEANUP_PENDING';
        if(cleanupPending)receiptCleanupFaults.add(entry.receiptOwner);else receiptCleanupFaults.delete(entry.receiptOwner);
        const status=data?.status??'unconfirmed';
        const check={checking:false,revision,status,cleanupPending,checkedAt:typeof data?.checkedAt==='string'?data.checkedAt:new Date().toISOString(),message:safeChatText(data?.message||checked?.error?.message||'回执仍待核对。'),originalError:entry.view.receiptCheck?.originalError??originalError};
        const nativeFailure=commandNativeFailure(data?.nativeFailure);if(nativeFailure)check.nativeFailure=nativeFailure;
        const cabinet=cabinetReceiptCommand(entry.view.commandId);
        if(cabinet&&plainData(data?.evidence))check.evidence=structuredClone(data.evidence);
        if(cabinet){entry.cabinetRecovery=plainData(data?.recovery)&&plainData(data.recovery.hostIdentity)&&typeof data.recovery.jobHandle==='string'?structuredClone(data.recovery):null;entry.view.canInspectCabinetJob=Boolean(entry.cabinetRecovery);}
        entry.view={...entry.view,receiptCheck:check,canInspectReceipt:data?data.canCheckAgain===true:true};
        if(cabinet){entry.view.canAcknowledgeReceipt=data?.terminal===true&&!cleanupPending;}
        if(!cabinet&&['failed','expired','not_started'].includes(status)&&originalError?.stage!=='postflight'){
          const codes={failed:'COMMAND_QUERY_FAILED',expired:'COMMAND_REQUEST_EXPIRED',not_started:'COMMAND_NOT_STARTED'};
          entry.view.status='failed';entry.view.error={code:codes[status],message:check.message,outcome:status,...nativeFailure?{nativeFailure}:{}};entry.view.canInspectReceipt=false;
        }
        if(!cabinet&&!entry.view.canInspectReceipt&&!await releaseReceiptOwner(entry.receiptOwner)){entry.view.status='unknown';entry.view.error=originalError;entry.view.canInspectReceipt=true;entry.view.receiptCheck.cleanupPending=true;entry.view.receiptCheck.message='原回执句柄清理尚未确认，请再次核对。';}
      }else if(sameEntry&&!run.retired&&!closing){entry.view={...entry.view,receiptCheck:{...entry.view.receiptCheck,checking:false,message:'账号核验变化，本次核对结果未应用。'}};}
      else await releaseReceiptOwner(entry.receiptOwner);
      if(active===run)active=null;
      if(accountDraining){for(const id of [...streams.keys()])closeStreams(id);clearSessions();accountDraining=false;}
      allConversations();allState();
    });
    allConversations();return revision;
  }
  function startCabinetRecovery(client,s,entry){
    const run={kind:'command',inspection:true,receiptOwner:entry.receiptOwner,client,session:s,executionId:entry.view.executionId,conversationId:s.conversationId,contextEpoch:s.contextEpoch,commandId:entry.view.commandId,cancelRequested:false,retired:false,binding:entry.binding,work:null};
    const bound=structuredClone(entry.cabinetRecovery);active=run;entry.view.cabinetRecoveryInspection={checking:true};
    run.work=Promise.resolve().then(async()=>{
      try{
        const fresh=await entry.receiptOwner.inspect();
        if(!commandCurrent(run)||commandViews.get(s)!==entry||fresh?.ok!==true||JSON.stringify(fresh.value?.recovery)!==JSON.stringify(bound))throw new Error('原回执或宿主身份已变化。');
        const result=await invokeReadonlyCommand('revit_family_inspect_job',{job_handle:bound.jobHandle},{expectedHostSession:bound.hostIdentity.sessionId,expectedHostIdentity:bound.hostIdentity,shouldContinue:()=>commandCurrent(run)&&!run.cancelRequested});
        const data=result?.value?.data,job=data?.value;
        const after=await entry.receiptOwner.inspect();
        if(!commandCurrent(run)||commandViews.get(s)!==entry||after?.ok!==true||JSON.stringify(after.value?.recovery)!==JSON.stringify(bound)||result?.ok!==true||data?.operation!=='family_inspect_job'||data.hostSession!==bound.hostIdentity.sessionId||!plainData(job)||job.operation!=='family_inspect_job'||job.host_session!==bound.hostIdentity.sessionId||job.revit_pid!==bound.hostIdentity.pid||job.job_handle!==bound.jobHandle||job.success!==true||Buffer.byteLength(JSON.stringify(job),'utf8')>128*1024)throw new Error('只读作业回执或原身份未确认。');
        entry.view.cabinetRecoveryInspection={checking:false,status:'received',job:structuredClone(job)};
      }catch(error){if(commandCurrent(run)&&commandViews.get(s)===entry)entry.view.cabinetRecoveryInspection={checking:false,status:'unconfirmed',message:safeChatText(error.message||'作业读取尚未确认。')};}
      if(active===run)active=null;if(accountDraining){for(const id of [...streams.keys()])closeStreams(id);clearSessions();accountDraining=false;}allConversations();allState();
    });allConversations();return run;
  }
  function finish(run,status,error){
    if(active!==run)return;
    if(run.kind==='command'){retireCommand(run,error||'连接已变化，命令回执须另行核对。');allConversations();return;}
    for(const entry of run.userInputs??[])entry.request.discard();run.userInputs=[];
    discardAllDynamic(run);
    phaseTiming(run,'turn_finished',phaseClock(),{outcome:status});
    clearTimeout(run.deadline);clearTimeout(run.cancelDeadline);clearTimeout(run.errorDeadline);const s=session(run.client);if(run.contextPending)s.setContext(null,error||'上下文读取已中断，请重新读取。');s.finish(run.owner,status,error);
    if(status==='interrupted'&&run.cancelReason==='timeout')s.add('error','已达到配置的对话时限并请求停止；Codex 已报告本轮中断。','interrupted');
    else if(status==='interrupted'&&run.cancelReason==='user')s.add('error',!run.startRequested?'已按你的请求停止，本轮尚未开始。':run.interrupting?'已按你的请求尝试停止；Codex 已报告本轮中断。':'你请求停止后 Codex 报告本轮中断；停止指令尚未发送。','interrupted');
    else if(status==='interrupted'&&run.cancelReason==='account')s.add('error',!run.startRequested?'账号状态发生变化，本轮尚未开始。':run.interrupting?'账号状态发生变化，已尝试停止；Codex 已报告本轮中断。':'账号状态发生变化后 Codex 报告本轮中断；停止指令尚未发送。','interrupted');
    active=null;
    const outcome=s.messages.find(message=>message.id===run.owner.messageId)?.status||status;
    if(history){
      // A submitted answer may still be saving when the native turn ends.
      // Do not silently retry a failed answer save while finalizing the turn.
      if(run.userInputSave||run.steerSave)void Promise.all([run.userInputSave,run.steerSave].filter(Boolean)).then(results=>{if(results.every(result=>result.ok))void persist(s,run.historyScope);});
      else if(s.persistence?.status!=='failed')void persist(s,run.historyScope);
    }
    // Session owns the terminal outcome. Retain only a fixed notice for this
    // run's original still-owned BuildX identity, never retired chat content.
    // Temporary verification failure hides this projection, not its ownership.
    if(!closing&&workspace.kind==='customer-chat'&&outcome==='unknown'&&sameIdentity(run.accountIdentity,interruptionIdentity(accounts.bindingIdentity())))interruptionOwner=run.accountIdentity;
    allConversations();emit(run.client,outcome==='failed'||outcome==='unknown'?'failure':'done',{status:outcome,...(s.error?{message:s.error}:{})});
    if(accountDraining){for(const id of [...streams.keys()])closeStreams(id);clearSessions();accountDraining=false;}
  }
  async function connect(){if(connecting||closing)return;const owner=++connectionEpoch;connecting=true;try{await codex.start();}catch(error){if(owner===connectionEpoch&&!closing)codex.failed(error.rpcCode?'Codex初始化未完成（'+error.rpcCode+'）。':safeChatText(error.message));}finally{if(owner===connectionEpoch){connecting=false;allState();}}}
  async function reset(reason){
    if(resetting||closing)return;cancelAutoReconnect();const pendingCommand=active?.kind==='command'?active:null;resetting=true;connectionEpoch++;connecting=false;codexOperation=null;commandViews=new WeakMap();commandReviews=new WeakMap();confirmation.invalidate('connection_changed');interruptContextRefresh(reason);if(active)finish(active,'unknown',reason);
    let confirmed=false;
    try{if(pendingCommand)await pendingCommand.work;for(const owner of [...receiptOwners])if(!await releaseReceiptOwner(owner))throw new Error('Receipt cleanup unconfirmed');const result=await codex.close();if(result?.closed!==true)throw new Error('Codex cleanup unconfirmed');confirmed=true;}catch{codex.failed('旧连接或原回执的清理尚未确认，请核对后重试清理。');}finally{for(const s of new Set([...sessions.values(),...conversations.values()])){s.resetContext();if(history)void persist(s);}allConversations();resetting=false;}
    if(!confirmed)return;
    await connect();
  }
  async function cancel(run,reason='user'){
    if(active!==run)return;run.cancelReason??=reason;run.cancelRequested=true;
    for(const entry of run.userInputs??[])entry.request.discard();run.userInputs=[];
    discardAllDynamic(run);
    if(run.kind==='command'){
      const value=commandViews.get(run.session);if(value&&value.view.executionId===run.executionId){value.view.status='stopping';value.view.cancelRequested=true;}
      allConversations();return;
    }
    session(run.client).activity=selected.cancelMessage;conversation(run.client);
    if(!run.turnId||run.interrupting)return;run.interrupting=true;
    try{await codex.interrupt(run.threadId,run.turnId);}catch{if(active===run)void reset(selected.interruptUnconfirmed);return;}
    if(active===run)run.cancelDeadline=setTimeout(()=>{if(active===run)void reset(selected.interruptTimeout);},cancelTimeout);
  }
  function applyNotification(run,method,params,observed=phaseClock(),toolTiming=[]){
    const s=session(run.client),result=s.notification(run.owner,method,params,name=>labels.get(name));
    if(method==='error'&&params.willRetry===false&&s.owns(run.owner,params)&&!run.errorDeadline){
      // Bound only the wait for a terminal receipt after a non-retryable
      // protocol error; a normal long-running turn has no total deadline.
      run.errorDeadline=setTimeout(()=>{if(active===run)void reset('Codex 报告错误后未收到本轮结束回执；结果未知，请核对原工具回执。');},45000);
    }
    if(result.changed||result.terminal){
      const timing=run.phaseTiming;
      if(timing&&!timing.firstNative){timing.firstNative=true;phaseTiming(run,'first_native_event',observed);}
      if(timing&&!timing.firstText&&(method==='item/agentMessage/delta'&&params.delta?.length||method==='item/completed'&&params.item?.type==='agentMessage'&&params.item.text?.length)){timing.firstText=true;phaseTiming(run,'first_text_received',observed);phaseTiming(run,'first_text_ready_for_sse');}
      if(result.terminal)phaseTiming(run,'native_terminal_received',observed);
      if(timing&&params.item?.type==='mcpToolCall'&&['item/started','item/completed'].includes(method)){
        const id=params.item.id,tool=params.item.tool||params.item.name,opened=timing.tools.get(id);
        if(method==='item/started'&&!opened&&timing.tools.size<64)timing.tools.set(id,observed);
        if(method==='item/completed')timing.tools.delete(id);
        phaseTiming(run,method==='item/started'?'tool_started':'tool_completed',observed,{itemId:id,tool,...method==='item/completed'?{durationMs:opened?Math.max(0,observed.ticks-opened.ticks):null}:{}});
        if(method==='item/completed')for(const data of toolTiming){try{audit('phase-timing.jsonl',{...data,conversationId:run.conversationId,threadId:run.threadId,turnId:run.turnId,itemId:id,tool},true);}catch{}}
      }
    }
    if(result.changed&&(method==='item/started'||method==='item/completed')&&params.item?.type==='mcpToolCall')audit('tool-calls.jsonl',{phase:method==='item/started'?'started':'completed',tool:params.item.tool||params.item.name,protocolStatus:params.item.status||null,errorPresent:Boolean(params.item.error),resultIsError:typeof params.item.resultIsError==='boolean'?params.item.resultIsError:null},true);
    if(result.changed){if(result.delta)emit(run.client,'delta',result.delta);conversation(run.client);}
    if(result.overflow){s.activity='回复超过面板上限，正在停止等待…';void cancel(run,'overflow');}
    if(result.terminal){
      if(run.pendingOverflow)finish(run,'unknown','启动回执前的事件超过面板保留上限；显示内容及本轮结果不完整，请核对原工具回执。');
      else finish(run,result.terminal,result.error||(result.terminal==='failed'?'本轮对话未完成，请检查 Codex 账号和网络。':null));
    }
  }
  const listeners={
    'skills-changed':()=>{skillSelections.clear();skillsRevision++;allState();},
    'user-input-request':request=>{
      const run=active,p=parseUserQuestions(request.params);
      if(workspace.kind!=='model'||codex.profile?.id!=='model-workspace'||!run||run.kind!=='chat'||run.cancelRequested||!run.startRequested||!p||p.threadId!==run.threadId||run.turnId&&p.turnId!==run.turnId||request.generation!==codex.state.connectionGeneration||request.revision!==codex.state.codexAccount?.accountRevision||run.userInputs?.length>=8){request.reject();return;}
      if(run.userInputs?.some(entry=>entry.request.id===request.id)){request.discard();return;}
      run.userInputs??=[];run.userInputs.push({request,params:p,token:randomUUID()});if(run.turnId)conversation(run.client);
    },
    diagnostic:data=>{observeAutoDiagnostic(data);if(data.code==='phase_timing'){try{audit('phase-timing.jsonl',data,true);}catch{}}else if(['revit_tool_catalog','revit_tools_verified','readonly_workbench_tool_catalog','readonly_workbench_tools_verified','source_tool_catalog','source_tools_verified','customer_chat_tools_verified'].includes(data.code))audit('connection-status.json',data);else if(['codex_lifecycle','codex_exit'].includes(data.code))audit('lifecycle.jsonl',data,true);},
    state:state=>{if(state.ready&&!state.error&&Number.isSafeInteger(state.connectionGeneration))autoReadyGeneration=state.connectionGeneration;if(!profileMatches(state)&&!resetting&&!closing){codexOperation=null;confirmation.invalidate('connection_changed');retireSessions('客户聊天连接配置不匹配，旧任务与上下文已退出使用。');}if(state.error&&!resetting&&!closing){codexOperation=null;if(!commandsIndependent)retireCommandViews();confirmation.invalidate('connection_changed');interruptContextRefresh('上下文读取已中断：'+safeChatText(state.message));if(active&&!(commandsIndependent&&active.kind==='command'))finish(active,'unknown',safeChatText(state.message));}allState();},
    'account-invalidated':data=>{
      if(data?.connectionGeneration!==codex.state.connectionGeneration)return;
      cancelAutoReconnect();autoReadyGeneration=null;
      codexOperation=null;confirmation.invalidate('codex_changed');retireSessions('Codex账号信息已失效，请重新连接并确认；已开始的模型操作仍需回查。');allState();
    },
    'approval-denied':()=>{if(active&&active.kind!=='command'){session(active.client).activity='已拒绝工具范围之外的权限请求。';conversation(active.client);}},
    notification:(method,raw)=>{
      if(method==='serverRequest/resolved'){
        const run=active;if(run?.kind==='chat'&&raw?.threadId===run.threadId){const index=run.userInputs?.findIndex(entry=>entry.request.id===raw.requestId)??-1;if(index>=0){run.userInputs[index].request.discard();run.userInputs.splice(index,1);conversation(run.client);}const dynamic=run.dynamicRequests?.find(entry=>entry.request.id===raw.requestId);if(dynamic){discardDynamic(run,dynamic);conversation(run.client);}}return;
      }
      const params=boundedChatNotification(method,raw);if(!params)return;
      const run=active;if(!run||run.kind==='command')return;const turnId=params.turnId||params.turn?.id;
      if(params.threadId!==run.threadId||typeof turnId!=='string'||!turnId)return;
      const observed=phaseClock();
      let toolTiming=[];if(method==='item/completed'&&readToolTiming)try{toolTiming=readToolTiming(raw.item);}catch{}
      if(!run.turnId){
        if(run.pending.length<96)run.pending.push([method,params,observed,toolTiming]);
        else{
          run.pendingOverflow=true;
          // Preserve bounded terminal candidates independently of the normal
          // event budget; turn identity is not authoritative until the ack.
          if(method==='turn/completed'){
            run.pendingTerminals??=new Map();
            if(run.pendingTerminals.has(turnId)||run.pendingTerminals.size<96)run.pendingTerminals.set(turnId,[method,params,observed,toolTiming]);
          }
        }
        return;
      }
      if(turnId!==run.turnId)return;
      applyNotification(run,method,params,observed,toolTiming);
    }
  };
  if(dynamicApproval||projectAgent||modelPermission||accessServices)listeners['dynamic-tool-request']=request=>{
    const run=active,p=request?.params;
    if(!run||run.kind!=='chat'||run.cancelRequested||!run.startRequested||!plainData(p)||!Object.isFrozen(p)||
       !dynamicText(p.threadId,200)||!dynamicText(p.turnId,200)||!dynamicText(p.callId,200)||!dynamicText(p.tool,80)||!plainData(p.arguments)||!Object.isFrozen(p.arguments)||
       p.threadId!==run.threadId||run.turnId&&p.turnId!==run.turnId||request.generation!==run.codexGeneration||request.revision!==run.codexRevision||
       codex.state.connectionGeneration!==run.codexGeneration||codex.state.codexAccount?.accountRevision!==run.codexRevision||run.dynamicRequests?.length>=8||
       !codex.profile.dynamicTools.some(tool=>tool.name===p.tool)){
      try{request.reject();}catch{}return;
    }
    if(run.dynamicRequests?.some(entry=>entry.request.id===request.id||entry.params.callId===p.callId)){try{request.reject();}catch{}return;}
    const entry={request,params:p,token:randomUUID(),ticket:null,preview:null,timer:null,done:false,deciding:false};
    run.dynamicRequests??=[];run.dynamicRequests.push(entry);
    if(run.turnId){prepareDynamic(run,entry);conversation(run.client);}
  };
  for(const [event,listener] of Object.entries(listeners))codex.on(event,listener);
  const allowedHost=req=>req.headers.host==='127.0.0.1:'+server.address()?.port||req.headers.host==='localhost:'+server.address()?.port;
  const allowedOrigin=value=>value===undefined||value==='http://127.0.0.1:'+server.address()?.port||value==='http://localhost:'+server.address()?.port;
  const server=http.createServer(async(req,res)=>{
    let settleRequest,requestWork=null;
    let ownsAttachmentIntake=false;
    try{
      if(!allowedHost(req)){json(res,403,{error:'本地地址不匹配'});return;}
      const url=new URL(req.url,'http://127.0.0.1');
      // The native launcher needs installation identity only. Keep this probe
      // independent of account checks, Codex readiness and growing tool catalogs.
      if(req.method==='GET'&&url.pathname==='/api/service-identity'){
        if(!allowedOrigin(req.headers.origin)){json(res,403,{error:'请求来源不匹配'});return;}
        json(res,200,{service:'revit-local-codex',installationId});return;
      }
      if(req.method==='POST'&&['/api/model-viewer','/api/project-knowledge','/api/project-files','/api/chat/attachment','/api/access-policy','/api/model-receipt/check','/api/model-receipt/acknowledge','/api/model-receipt/recover'].includes(url.pathname)){requestWork=new Promise(resolve=>{settleRequest=resolve;});requestWorks.add(requestWork);}
      if(req.method==='GET'&&url.pathname==='/api/status'){const account=await accounts.status(req);json(res,200,{...stateView(account,accounts.bindingIdentity(req)),...(installationId?{installationId}:{}),csrf,busy:Boolean(active||contextBusy||accountDraining||codexOperation||historyControl||historyWrites.size),toolCatalog:selected.catalog,...directCommandsAvailable&&selected.commands?{commandCatalogAvailable:true}:{}});return;}
      if(req.method==='GET'&&url.pathname==='/api/account/status'){json(res,200,await accounts.status(req));return;}
      if(req.method==='GET'&&url.pathname==='/api/command-catalog'){
        if(!directCommandsAvailable||!selected.commands){json(res,404,{error:'此工作区未提供命令目录。'});return;}
        const access=await accounts.authorize(req);if(!access.allowed){json(res,401,{error:'请先登录并核验 BuildX 账号。'});return;}
        json(res,200,{commands:displayedCommands});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/chats'){
        if(!history){json(res,404,{error:'当前工作区未启用历史对话。'});return;}
        const access=await accounts.authorize(req);if(!access.allowed){json(res,401,{error:'请先登录并核验 BuildX 账号。'});return;}
        const client=url.searchParams.get('client');if(!validClient(client)){json(res,400,{error:'无效会话'});return;}
        const facts=historyIdentity(req),s=session(client,facts.scope),view=await historyView(facts.scope,s.conversationId,url.searchParams.get('cursor'));
        if(!sameHistoryIdentity(facts,req)){json(res,409,{error:'账号或连接已变化，请刷新历史对话。'});return;}
        json(res,200,{ok:true,...view});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/events'){
        if(closing||accountDraining){json(res,503,{error:'本地连接正在结束，请稍后重试。'});return;}
        const access=await accounts.authorize(req);if(!access.allowed){json(res,401,{error:'请先登录并核验 BuildX 账号。'});return;}
        const identity=accounts.bindingIdentity(req);if(accounts.required&&(identity?.verified!==true||access.account.user?.id!==identity.userId)){json(res,401,{error:'BuildX 登录已变化，请重新核验。'});return;}
        if(closing||accountDraining){json(res,503,{error:'本地连接正在结束，请稍后重试。'});return;}
        const id=url.searchParams.get('client');if(!validClient(id)){json(res,400,{error:'无效会话'});return;}
        const target=session(id,history?historyIdentity(req).scope:undefined);const outputs=channel(id);if(outputs.size>=3){json(res,429,{error:'连接过多'});return;}
        // A new authorized event stream is an explicit re-read. Failed loads
        // remain terminal between reads, so broadcasts cannot spin on failure.
        if(accessServices){const scope=accessScope(target);if(accessMessages.get(scope)?.accessUnavailable){accessPreparations.delete(scope);accessMessages.delete(scope);}}
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});outputs.add(res);res.write('event: snapshot\ndata: '+JSON.stringify(snapshot(id))+'\n\n');
        const keep=setInterval(()=>res.write(': keepalive\n\n'),20000);res.on('close',()=>{clearInterval(keep);outputs.delete(res);});return;
      }
      if(req.method==='POST'){
        if(!allowedOrigin(req.headers.origin)){json(res,403,{error:'请求来源不匹配'});return;}
        if(req.headers['x-local-chat']!==csrf||!String(req.headers['content-type']||'').startsWith('application/json')){json(res,403,{error:'请重新连接面板后重试'});return;}
        if(url.pathname==='/api/turn'&&turnAttachmentsAvailable){
          if(attachmentIntake||active||contextBusy||historyControl||codexOperation){json(res,409,{error:'请等待当前输入处理结束。'});return;}
          attachmentIntake=req;ownsAttachmentIntake=true;
        }
        const input=await body(req,url.pathname==='/api/turn'&&turnAttachmentsAvailable?turnInput.httpBytes:history&&url.pathname==='/api/turn'?256*1024:128*1024);if(!validClient(input.client)){json(res,400,{error:'无效会话'});return;}
        if(closing){
          if(url.pathname==='/api/stop-service'&&shutdownOwner?.client===input.client&&(!accounts.required||input.cleanupId===shutdownOwner.proof)){
            json(res,202,{ok:true,cleanupId:shutdownOwner.proof});requestShutdown(input.client);return;
          }
          json(res,503,{error:'本地服务正在停止；仅原停机请求可重试清理。'});return;
        }
        if(url.pathname.startsWith('/api/account/')){
          const action=url.pathname.slice('/api/account/'.length),identity=accounts.bindingIdentity(req);
          if(['sign-in','sign-up','sign-out'].includes(action)&&identity?.verified===true&&[...modelReceipts.values()].some(receipt=>receipt.facts.identity?.userId===identity.userId)){json(res,409,{error:'原模型操作回执尚未核对，请先核实并确认后再切换账号。'});return;}
          if(accessServices&&['sign-in','sign-out'].includes(action)){await accessServices.deactivate();revokeModelGrant();accessPreparations.clear();}
          const result=await accounts.action(action,input,req,res);if(accounts.bindingIdentity()?.verified===true&&codex.state.ready&&!codex.state.error&&Number.isSafeInteger(codex.state.connectionGeneration))autoReadyGeneration=codex.state.connectionGeneration;allState();if(res.destroyed||res.writableEnded)return;if(result.cookie)res.setHeader('Set-Cookie',result.cookie);json(res,result.status,result.body);return;
        }
        const access=await accounts.authorize(req);if(!access.allowed){json(res,401,{error:'请先登录并核验 BuildX 账号。'});return;}
        if(closing){json(res,503,{error:'本地服务正在停止'});return;}
        if(url.pathname==='/api/access-policy'){
          if(!accessServices){json(res,404,{error:'当前工作区未提供访问范围设置。'});return;}
          if(Object.keys(input).some(key=>!['client','mode','confirmed','rootId','expectedRevision'].includes(key))||!['read-only','project-write','full-access'].includes(input.mode)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.mode!=='read-only'&&input.confirmed!==true||input.mode==='project-write'&&typeof input.rootId!=='string'||input.mode!=='project-write'&&input.rootId!==undefined){json(res,400,{error:'请选择明确的访问范围并确认。'});return;}
          const facts=historyIdentity(req),s=session(input.client,history?facts.scope:undefined);
          if(s.historyReadOnly||active||contextBusy||codexOperation||historyControl||resetting||accountDraining||modelReceipts.size||receiptCleanupFaults.size||projectAgentWorks.size){json(res,409,{error:'请先结束当前操作并核对原回执，再修改访问范围。'});return;}
          const change={},epoch=connectionEpoch,contextEpoch=s.contextEpoch;codexOperation=change;allState();
          try{
            const ready=await accessServices.activate(facts.scope);if(!ready.ok)throw new Error(ready.error?.message);
            if(ready.value.revision!==input.expectedRevision)throw new Error('访问策略版本已变化，请刷新后重试。');
            let roots=[];
            if(input.mode==='project-write'){
              const library=libraryOwner(facts);if(!library)throw new Error('请先在资料库添加项目目录。');await library.ready;
              const result=library.service.listRoots(),rootEntry=result?.value?.roots?.find(item=>item.id===input.rootId&&item.kind==='directory'&&item.status==='available');
              if(result?.ok!==true||!rootEntry)throw new Error('项目目录未能核实，请在资料库重新选择。');roots=[rootEntry.path];
            }
            if(!sameHistoryIdentity(facts,req)||sessions.get(input.client)!==s||s.contextEpoch!==contextEpoch||connectionEpoch!==epoch||closing||resetting||accountDraining)throw new Error('账号或对话已变化，未更改访问范围。');
            revokeModelGrant();
            const changed=await accessServices.select(facts.scope,{mode:input.mode,roots,confirmed:input.confirmed===true,expectedRevision:input.expectedRevision});if(!changed.ok)throw new Error(changed.error?.message);
            if(!sameHistoryIdentity(facts,req)||sessions.get(input.client)!==s||s.contextEpoch!==contextEpoch||connectionEpoch!==epoch){await accessServices.deactivate();throw new Error('账号或对话已变化，请重新核实访问范围。');}
            accessMessages.set(facts.scope,{modelWritable:false,modelMessage:input.mode==='read-only'?'当前为只读访问。':'文件范围已更新，正在核实 Revit 模型。'});
            if(input.mode!=='read-only'&&modelPermission)try{await bindAccessGrant(input.client,s,facts);}catch(error){accessMessages.set(facts.scope,{modelWritable:false,modelMessage:safeChatText(error.message||'Revit 模型尚未核实；请加载 0.8.0 宿主。')});}
            json(res,200,{ok:true,accessPolicy:accessPolicyView(s),modelPermission:modelPermissionView(input.client,s),session:sessionView(s)});
          }catch(error){json(res,409,{error:safeChatText(error.message||'访问范围未能更新。'),accessPolicy:accessPolicyView(s)});}
          finally{if(codexOperation===change)codexOperation=null;allState();allConversations();}return;
        }
        if(url.pathname==='/api/chat/attachment'){
          if(!turnAttachmentsAvailable){json(res,404,{error:'当前工作区未开放图片附件。'});return;}
          if(Object.keys(input).length!==4||Object.keys(input).some(key=>!['client','conversationId','messageId','attachmentId'].includes(key))||![input.conversationId,input.messageId,input.attachmentId].every(panelConversationId)){json(res,400,{error:'图片附件请求无效。'});return;}
          if(attachmentPreviewRead||accountDraining){json(res,409,{error:'图片或账号正在读取，请稍后重试。'});return;}
          const facts=historyIdentity(req),owner={};attachmentPreviewRead=owner;
          const current=()=>!accountDraining&&attachmentPreviewRead===owner&&sameHistoryIdentity(facts,req);
          try{
            // A snapshot ID is not authority to read a file. Resolve its exact
            // message attachment in the authenticated transcript partition.
            const known=conversations.get(input.conversationId);
            let messages=known?.historyScope===facts.scope?known.messages:null;
            if(!messages){
              const found=await history.get(facts.scope,input.conversationId);
              if(!current()){json(res,409,{error:'账号已变化，请重新打开图片。'});return;}
              if(!found.ok){json(res,404,{error:'未找到这条对话中的图片附件。'});return;}
              messages=found.session?.messages;
            }
            const matching=Array.isArray(messages)?messages.filter(message=>message?.id===input.messageId&&['user','assistant'].includes(message.role)):[];
            const attachments=matching.length===1&&Array.isArray(matching[0].attachments)?matching[0].attachments.filter(item=>item?.id===input.attachmentId):[];
            const image=attachments.length===1?attachments[0]:null;
            if(!plainData(image)||image.kind!=='image'||!['image/png','image/jpeg'].includes(image.mediaType)||!Number.isSafeInteger(image.bytes)||image.bytes<1||image.bytes>2*1024*1024||typeof image.sha256!=='string'||!/^[a-f0-9]{64}$/.test(image.sha256)){json(res,404,{error:'未找到这条消息中的图片附件。'});return;}
            const saved=await history.readTurnAttachment(facts.scope,input.attachmentId);
            const authorized=await accounts.authorize(req);
            if(!authorized.allowed||!current()){json(res,409,{error:'账号已变化，请重新打开图片。'});return;}
            if(!saved.ok||!Buffer.isBuffer(saved.bytes)||saved.bytes.length!==image.bytes||saved.size!==image.bytes||saved.sha256!==image.sha256){json(res,409,{error:'图片快照已变化或无法核对，未显示图片。'});return;}
            res.writeHead(200,{'Content-Type':image.mediaType,'Content-Length':saved.bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(saved.bytes);
          }catch{json(res,503,{error:'图片附件暂时无法读取，请稍后重试。'});}
          finally{if(attachmentPreviewRead===owner)attachmentPreviewRead=null;}
          return;
        }
        if(['/api/model-receipt/check','/api/model-receipt/acknowledge','/api/model-receipt/recover'].includes(url.pathname)){
          if(!modelPermission){json(res,404,{error:'当前工作区未开放模型回执核对。'});return;}
          const action=url.pathname.split('/').at(-1),settling=action!=='check',review=action==='recover';
          const allowed=['client','conversationId','ticket',...(settling?['checkRevision','confirmed']:[])];
          if(Object.keys(input).some(key=>!allowed.includes(key))||typeof input.conversationId!=='string'||typeof input.ticket!=='string'||settling&&(!Number.isSafeInteger(input.checkRevision)||input.confirmed!==true)){json(res,400,{error:'回执核对请求无效。'});return;}
          const receipt=modelReceipts.get(input.ticket),s=sessions.get(input.client),current=()=>receipt&&modelReceipts.get(input.ticket)===receipt&&sessions.get(input.client)===s&&s?.conversationId===input.conversationId&&modelReceiptAccountCurrent(receipt,req)&&!closing;
          if(!current()||receipt.checking){json(res,409,{error:'原回执、账号或对话已变化，请刷新后核对。'});return;}
          if(settling&&(receipt.checkRevision!==input.checkRevision||(review?!isRecoverableModelScriptReceipt(receipt.tool,receipt.checked):receipt.checked?.terminal!==true))){json(res,409,{error:'请先核对原回执；仅已结束的脚本失败可在人工核查后继续。'});return;}
          if(review&&(active||contextBusy||codexOperation)){json(res,409,{error:'请等待当前操作结束后，再确认已核查的模型结果。'});return;}
          try{
            if(!settling)await checkModelReceipt(receipt);
            else{clearTimeout(receipt.timer);receipt.timer=null;receipt.checking=true;allConversations();await settleModelReceipt(receipt,{review});}
            json(res,200,{ok:true});
          }catch(error){if(modelReceiptCurrent(receipt))receipt.message=safeChatText(error.message||'原回执仍未核实。',1000);json(res,409,{error:safeChatText(error.message||'原回执仍未核实或发生变化；请保留记录，不要重复执行。')});}
          finally{receipt.checking=false;scheduleModelReceipt(receipt);allConversations();allState();}
          return;
        }
        if(url.pathname==='/api/model-permission'){
          if(!modelPermission){json(res,404,{error:'当前工作区未开放模型操作权限。'});return;}
          if(Object.keys(input).some(key=>!['client','conversationId','level','expectedRevision'].includes(key))||typeof input.conversationId!=='string'||!['rollback','confirm','automatic'].includes(input.level)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0){json(res,400,{error:'模型权限选择无效。'});return;}
          const facts=historyIdentity(req),s=session(input.client,history?facts.scope:undefined);
          currentModelGrant(input.client,s);
          if(s.conversationId!==input.conversationId||s.historyReadOnly||input.expectedRevision!==modelPermissionRevision||active||contextBusy||codexOperation||historyControl||resetting||accountDraining||!codex.state.ready||!Number.isSafeInteger(codex.state.connectionGeneration)||codex.state.connectionGeneration<1||!Number.isSafeInteger(codex.state.codexAccount?.accountRevision)||accounts.required&&!confirmation.status(confirmationFacts(req,input.client)).localConnectionConfirmed){json(res,409,{error:'对话、模型权限或连接已变化，请刷新后重试。'});return;}
          const change={kind:'model-permission-check'},epoch=connectionEpoch,generation=codex.state.connectionGeneration,revision=codex.state.codexAccount.accountRevision,contextEpoch=s.contextEpoch;codexOperation=change;allState();
          try{
            if(accessServices){await bindAccessGrant(input.client,s,facts,input.level);json(res,200,{ok:true,modelPermission:modelPermissionView(input.client,s),accessPolicy:accessPolicyView(s)});return;}
            const document=await modelPermissionServices.observeDocument();
            if(modelGrant&&!sameWorkbenchDocumentIdentity(modelGrant.scope.document,document))revokeModelGrant();
            if(closing||resetting||accountDraining||codexOperation!==change||active||contextBusy||sessions.get(input.client)!==s||s.conversationId!==input.conversationId||s.contextEpoch!==contextEpoch||connectionEpoch!==epoch||codex.state.ready!==true||codex.state.connectionGeneration!==generation||codex.state.codexAccount?.accountRevision!==revision||!sameHistoryIdentity(facts,req)||accounts.required&&!confirmation.status(confirmationFacts(req,input.client)).localConnectionConfirmed)throw new Error('连接或对话已变化');
            const scope=Object.freeze({client:input.client,conversationId:s.conversationId,generation,revision,account:JSON.stringify(facts),document:Object.freeze({session:document.session,path:document.path,title:document.title})});
            const next={client:input.client,session:s,conversationId:s.conversationId,contextEpoch,connectionEpoch:epoch,facts,scope,level:input.level};
            modelGrant=next;modelPermission.setLevel({level:input.level,scope,isCurrent:()=>modelGrant===next&&modelGrantCurrent(next)});modelPermissionRevision++;
            json(res,200,{ok:true,modelPermission:modelPermissionView(input.client,s)});
          }catch{revokeModelGrant();json(res,409,{error:'未能核实当前模型或连接；模型需已保存且在允许范围内，权限未启用。'});}
          finally{if(codexOperation===change)codexOperation=null;allState();allConversations();}
          return;
        }
        if(url.pathname==='/api/mcp-candidates'){
          if(!mcpCandidatesAvailable){json(res,404,{error:'此工作区不提供本机 MCP 配置快照。'});return;}
          if(Object.keys(input).some(key=>key!=='client')){json(res,400,{error:'MCP 配置读取请求无效。'});return;}
          if(resetting||accountDraining){json(res,409,{error:'连接正在变化，请稍后读取。'});return;}
          try{
            const value=codex.configuredMcpCandidates(),state=codex.state,names=new Set();
            if(!plainData(value)||value.source!=='launch_snapshot'||!Number.isSafeInteger(value.generation)||value.generation!==state.connectionGeneration||value.revision!==state.codexAccount?.accountRevision||state.ready!==true||!Array.isArray(value.servers)||value.servers.length>100)throw new Error('invalid snapshot');
            for(const item of value.servers){
              if(!plainData(item)||typeof item.name!=='string'||!/^[A-Za-z0-9_-]{1,1024}$/.test(item.name)||names.has(item.name)||!['reserved','disabled','unknown'].includes(item.status))throw new Error('invalid snapshot');
              names.add(item.name);
            }
            json(res,200,{source:'launch_snapshot',generation:value.generation,servers:value.servers.map(item=>({name:item.name,status:item.status}))});
          }catch{json(res,503,{error:'本机 MCP 配置快照尚未核实，请先重新连接。'});}
          return;
        }
        if(requireLicense&&(['/api/turn','/api/command','/api/context','/api/steer','/api/user-input'].includes(url.pathname)||url.pathname==='/api/dynamic-approval'&&input.decision==='accept'||url.pathname==='/api/project-knowledge'&&['bind','restore-binding','refresh'].includes(input.action)||url.pathname==='/api/model-viewer'&&input.action==='refresh')){
          const facts=historyIdentity(req),licensed=await accounts.authorizeLicense(req);
          if(!licensed.allowed||!sameHistoryIdentity(facts,req)){json(res,403,{error:'软件授权未通过实时核验；请查询授权状态。既有历史仍可读取。',licenseStatus:licensed.license?.status??null});return;}
        }
        if(url.pathname==='/api/project-files'){
          if(!materialIndexFactory){json(res,404,{error:'此工作区未开放资料库。'});return;}
          if(input.action==='choose'){
            if(!materialPicker||Object.keys(input).some(key=>!['client','action','parameters'].includes(key))||!plainData(input.parameters)||Object.keys(input.parameters).some(key=>key!=='kind')||!['file','directory'].includes(input.parameters.kind)){json(res,400,{error:'文件选择请求无效。'});return;}
            const binding=libraryBinding(req,input.client),controller=new AbortController();
            const disconnected=()=>{if(!res.writableEnded)controller.abort();};res.once('close',disconnected);
            let result;try{result=await materialPicker.pick({kind:input.parameters.kind,signal:controller.signal});}finally{res.off('close',disconnected);}
            if((await accounts.authorize(req)).allowed!==true||!libraryBindingCurrent(binding,req)){json(res,409,{error:'账号或连接已变化，请重新选择。'});return;}
            json(res,result?.ok?200:400,result);return;
          }
          const methods={'list-roots':'listRoots','add-root':'addRoot','remove-root':'removeRoot','list-children':'listChildren','read-file':'readFile','open-file':'openFile','open-folder':'openFolder','read-attachment':'readAttachment'};
          const fields={'list-roots':[],'add-root':['path','kind'],'remove-root':['id'],'list-children':['rootId','path','cursor'],'read-file':['rootId','path'],'open-file':['rootId','path'],'open-folder':['rootId','path'],'read-attachment':['rootId','path']};
          const action=input.action,params=input.parameters;
          if(!Object.hasOwn(methods,action)||Object.keys(input).some(key=>!['client','action','parameters'].includes(key))||!plainData(params)||Object.keys(params).some(key=>!fields[action].includes(key))){json(res,400,{error:'资料库请求无效。'});return;}
          const binding=libraryBinding(req,input.client),owner=libraryOwner(binding.facts),current=()=>materialOwner===owner&&libraryBindingCurrent(binding,req);
          const result=await libraryOperation(owner,methods[action],params,current,{mutating:['add-root','remove-root'].includes(action)});
          if((await accounts.authorize(req)).allowed!==true||!current()){if(materialOwner===owner)materialOwner=null;json(res,409,{error:['open-file','open-folder'].includes(action)?'账号或连接已变化；打开请求可能已发送，请检查 Windows 窗口。':'账号或连接已变化，请刷新资料库。'});return;}
          json(res,result?.ok?200:400,result);return;
        }
        if(url.pathname==='/api/model-viewer'){
          if(!viewerService){json(res,404,{error:'此工作区未连接模型快照服务。'});return;}
          const action=input.action,params=input.parameters;
          if(!['refresh','status','get','locate','check','pending'].includes(action)||Object.keys(input).some(key=>!['client','action','parameters'].includes(key))||!plainData(params)){json(res,400,{error:'模型查看请求无效。'});return;}
          const permitted={refresh:['limit','requestId'],status:[],get:['snapshotId'],locate:['snapshotId','elementId'],check:['requestId'],pending:[]};
          if(Object.keys(params).some(key=>!permitted[action].includes(key))){json(res,400,{error:'模型查看参数无效。'});return;}
          if(['refresh','check'].includes(action)&&(typeof params.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.requestId))){json(res,400,{error:'快照请求身份无效。'});return;}
          if(viewerBusy){json(res,409,{error:'模型快照操作正在进行。'});return;}
          const facts=historyIdentity(req);
          if(!['refresh','check','pending'].includes(action)&&viewerOwner&&!sameHistoryIdentity(viewerOwner,req)){json(res,409,{error:'账号已变化，请重新生成快照。'});return;}
          if(action==='refresh'&&viewerAttempt?.requestId===params.requestId){json(res,409,{error:'此快照请求已提交，请核对原结果。'});return;}
          if(action==='refresh'&&(active||contextBusy||projectBind||viewerPending)){json(res,409,{error:viewerPending?'原快照请求尚待核对，请勿重复提交。':'请等待当前任务结束。'});return;}
          viewerBusy=true;
          try{
            let result;
            if(action==='refresh'){
              viewerAttempt={requestId:params.requestId,facts,state:'pending'};
              try{result=await viewerService.refresh({limit:params.limit});}catch{result={ok:false,error:{code:'CAPTURE_REQUEST_UNKNOWN',outcome:'unconfirmed',message:'采集结果尚未确认，请核对原回执。'}};}
              const recovery=captureReceiptOwner(result?.receiptOwner);
              if(recovery)receiptOwners.add(recovery);
              if(result?.error?.outcome==='unconfirmed')viewerPending={facts,owner:recovery,evidence:result.evidence};
              else if(recovery)await releaseReceiptOwner(recovery);
              if(result.ok){viewerOwner=facts;viewerProject=projectKnowledge;viewerAttempt.state='received';viewerAttempt.snapshotId=result.value?.snapshotId;}
              else viewerAttempt.state=result?.error?.outcome==='unconfirmed'?'unknown':'failed';
            }else if(action==='check'){
              if(!viewerAttempt||viewerAttempt.requestId!==params.requestId||!sameReceiptAccount(viewerAttempt.facts,req)){json(res,409,{error:'未找到本账号的原快照请求；不能推断它未执行。'});return;}
              if(!viewerPending){result={ok:true,value:{status:viewerAttempt.state,snapshotId:viewerAttempt.snapshotId??null,canCheckAgain:viewerAttempt.state==='pending'}};}
              else{
              if(!sameReceiptAccount(viewerPending.facts,req)){json(res,409,{error:'原回执不属于当前账号。'});return;}
              if(!viewerPending.owner){json(res,409,{error:'原回执句柄不可用，请根据请求标识人工核对。',evidence:viewerPending.evidence});return;}
              const checked=await viewerPending.owner.inspect();
              const terminal=checked?.ok===true&&['received','failed','expired','not_started'].includes(checked.value?.status)&&checked.value?.canCheckAgain!==true;
              if(terminal&&await releaseReceiptOwner(viewerPending.owner)){viewerPending=null;viewerAttempt.state=checked.value.status;}
              result=checked;
              }
            }else if(action==='pending')result={ok:true,value:viewerPending&&viewerAttempt&&sameReceiptAccount(viewerAttempt.facts,req)?{requestId:viewerAttempt.requestId,state:'unknown'}:null};
            else if(action==='status')result=viewerOwner?await viewerService.status():{ok:true,value:{state:'empty'}};
            else if(!viewerOwner){json(res,409,{error:'请先生成模型快照。'});return;}
            else if(action==='get')result=viewerService.get(params.snapshotId);
            else result=viewerService.locate(params.snapshotId,params.elementId);
            if((await accounts.authorize(req)).allowed!==true||!sameHistoryIdentity(facts,req)){json(res,409,{error:'账号已变化，结果未显示；请核对原回执。'});return;}
            json(res,result?.ok?200:400,result);return;
          }finally{viewerBusy=false;}
        }
        if(url.pathname==='/api/project-knowledge'){
          if(!projectKnowledgeFactory){json(res,404,{error:'此工作区未开放项目资料。'});return;}
          const facts=historyIdentity(req), action=input.action;
          if(!['bind','restore-binding','history-cleanup','refresh','list','search','read','table','restore-read','restore-table'].includes(action)||Object.keys(input).some(key=>!['client','action','parameters'].includes(key))||!plainData(input.parameters)){json(res,400,{error:'项目资料请求无效。'});return;}
          const params=input.parameters;
          if(action==='history-cleanup'){
            if(Object.keys(params).length||!projectHistoryFactory){json(res,400,{error:'项目历史清理请求无效。'});return;}
            const owner=projectHistoryFor(facts),result=await owner.cleanup();
            if(!sameHistoryIdentity(facts,req)){json(res,409,{error:'账号已变化，清理结果未应用。'});return;}
            json(res,result.ok?200:409,result);return;
          }
          if(['bind','restore-binding'].includes(action)){
            if(active||contextBusy||viewerBusy||projectBind){json(res,409,{error:'请等待当前任务结束后绑定项目资料。'});return;}
            if(action==='bind'?Object.keys(params).some(key=>!['projectId','rootPath'].includes(key)):Object.keys(params).length){json(res,400,{error:'项目绑定参数无效。'});return;}
            const historyOwner=projectHistoryFor(facts);
            if(action==='restore-binding'&&!historyOwner){json(res,404,{error:'未配置可恢复的项目历史目录。'});return;}
            const pending={};projectBind=pending;
            try{
              let binding=params;
              if(action==='restore-binding'){
                const restored=await historyOwner.currentBinding();
                if(!restored.ok||!restored.value){json(res,409,restored.ok?{error:'没有可恢复的项目绑定。'}:restored);return;}
                binding=restored.value;
              }
              if(projectBind!==pending||!sameHistoryIdentity(facts,req)){json(res,409,{error:'账号或项目已变化。'});return;}
              const created=projectKnowledgeFactory({...binding,...historyOwner?{history:historyOwner}:{}});if(!created.ok){json(res,400,created);return;}
              if(historyOwner&&action==='bind'){
                const saved=await historyOwner.bind(binding);
                if(!saved.ok){json(res,409,saved);return;}
                if(projectBind!==pending||(await accounts.authorize(req)).allowed!==true||!sameHistoryIdentity(facts,req)){json(res,409,{error:'账号或项目绑定已变化；未采用旧结果。'});return;}
              }
              const result=await created.value.refresh({isCancelled:()=>closing||projectBind!==pending||!sameHistoryIdentity(facts,req)});
              if(projectBind!==pending||(await accounts.authorize(req)).allowed!==true||!sameHistoryIdentity(facts,req)){json(res,409,{error:'账号或项目绑定已变化；未采用旧结果。'});return;}
              if(!result.ok&&historyOwner&&action==='bind'){json(res,409,{...result,bindingSaved:true,error:{...result.error,message:'项目绑定已保存，但资料索引未完成；请核查目录后恢复该项目。'}});return;}
              if(result.ok){projectKnowledge={facts,service:created.value,historyOwner};viewerOwner=null;viewerProject=null;if(codex.skillCatalogMode==='customer'){skillSelections.clear();skillsRevision++;allState();}}
              json(res,result.ok?200:400,result);
            }finally{if(projectBind===pending)projectBind=null;}
            return;
          }
          const owner=projectKnowledge;
          if(!owner||!sameHistoryIdentity(owner.facts,req)){json(res,409,{error:'请先在本账号绑定项目资料目录。'});return;}
          if(action==='refresh'&&(active||contextBusy)){json(res,409,{error:'请等待当前任务结束后刷新资料。'});return;}
          if(['refresh','list'].includes(action)&&Object.keys(params).length){json(res,400,{error:'项目资料请求参数无效。'});return;}
          let result;
          if(action==='restore-read'||action==='restore-table'){
            const restored=await owner.service.restoreVersion(params);
            if(!restored.ok)result=restored;
            else if(projectKnowledge!==owner||!sameHistoryIdentity(owner.facts,req)){json(res,409,{error:'账号或项目已变化；未返回旧资料。'});return;}
            else result=owner.service[action==='restore-read'?'read':'table'](params);
          }else if(action==='refresh')result=await owner.service.refresh({isCancelled:()=>closing||projectKnowledge!==owner||!sameHistoryIdentity(owner.facts,req)});
          else result=await owner.service[action](params);
          if((await accounts.authorize(req)).allowed!==true||projectKnowledge!==owner||!sameHistoryIdentity(owner.facts,req)){json(res,409,{error:'账号或项目已变化；未返回旧资料。'});return;}
          json(res,result.ok?200:400,result);return;
        }
        if(url.pathname==='/api/models'){
          if(workspace.kind!=='model'||typeof codex.listModels!=='function'||typeof codex.assertModelSelection!=='function'){json(res,404,{error:'此工作区未开放模型选择。'});return;}
          if(Object.keys(input).some(key=>key!=='client')){json(res,400,{error:'模型目录请求无效。'});return;}
          if(active||contextBusy||resetting||accountDraining||codexOperation||historyControl||closing){json(res,409,{error:'请等待当前操作结束。'});return;}
          if(!codex.state.ready||accounts.required&&!confirmation.status(confirmationFacts(req,input.client)).localConnectionConfirmed){json(res,403,{error:'请先连接并确认本机 Codex。'});return;}
          const identity=historyIdentity(req),before=codex.state.codexAccount,owner={};codexOperation=owner;allState();
          try{const models=await codex.listModels(),after=codex.state.codexAccount,accessAfter=await accounts.authorize(req);
            if(codexOperation!==owner||!accessAfter.allowed||!sameHistoryIdentity(identity,req)||!after||after.connectionGeneration!==before?.connectionGeneration||after.accountRevision!==before?.accountRevision||accounts.required&&!confirmation.status(confirmationFacts(req,input.client)).localConnectionConfirmed){json(res,409,{error:'账号或连接已变化，请重新读取模型。'});return;}
            json(res,200,{ok:true,models});
          }catch(error){json(res,503,{error:safeChatText(error.message||'模型目录读取失败。')});}
          finally{if(codexOperation===owner){codexOperation=null;allState();}}return;
        }
        if(url.pathname==='/api/skills'){
          if(!skillsAvailable){json(res,404,{error:'此工作区未开放技能读取。'});return;}
          if(Object.keys(input).some(key=>!['client','conversationId'].includes(key))||typeof input.conversationId!=='string'||input.conversationId.length>200){json(res,400,{error:'技能读取请求无效。'});return;}
          if(active||contextBusy||resetting||accountDraining||codexOperation||historyControl||closing){json(res,409,{error:'请等待当前操作结束。'});return;}
          if(!codex.state.ready||accounts.required&&!confirmation.status(confirmationFacts(req,input.client)).localConnectionConfirmed){json(res,403,{error:'请先连接并确认本机 Codex。'});return;}
          const identity=historyIdentity(req),target=session(input.client,history?identity.scope:undefined),before=codex.state.codexAccount,owner={};
          if(input.conversationId!==target.conversationId){json(res,409,{error:'对话已变化，请重新读取技能。'});return;}
          codexOperation=owner;allState();
          try{
            const library=codex.skillCatalogMode==='customer'?libraryOwner(identity):null;
            const libraryCurrent=()=>codexOperation===owner&&target.conversationId===input.conversationId&&materialOwner===library&&sameHistoryIdentity(identity,req)&&sessions.get(input.client)===target;
            const roots=library?await libraryOperation(library,'listRoots',{},libraryCurrent):null;
            const libraryRevision=library?.revision;
            const ready=Boolean(roots?.ok&&roots.value?.roots?.some(item=>item.status==='available')&&projectAgent?.tools.some(item=>item.name==='buildx_materials_list')&&projectAgent?.tools.some(item=>item.name==='buildx_materials_read'));
            const toolStates=ready?{buildx_materials_list:'available',buildx_materials_read:'available'}:{};
            const skills=await codex.listSkills(...(codex.skillCatalogMode==='customer'?[{toolStates}]:[])),discoveredRevision=skillsRevision,after=codex.state.codexAccount;
            const accessAfter=await accounts.authorize(req);
            if(skillsRevision!==discoveredRevision||codexOperation!==owner||!accessAfter.allowed||!sameHistoryIdentity(identity,req)||sessions.get(input.client)!==target||target.conversationId!==input.conversationId||!after||after.connectionGeneration!==before?.connectionGeneration||after.accountRevision!==before?.accountRevision||ready&&(!libraryCurrent()||library.revision!==libraryRevision)||accounts.required&&!confirmation.status(confirmationFacts(req,input.client)).localConnectionConfirmed){json(res,409,{error:'账号、连接、资料库或对话已变化，请重新读取技能。'});return;}
            skillSelections.set(input.client,{session:target,conversationId:target.conversationId,revision:skillsRevision,ids:new Set(skills.filter(item=>typeof item.id==='string').map(item=>item.id)),...(ready?{library,libraryRevision,account:before}:{})});
            json(res,200,{ok:true,skills,revision:skillsRevision,conversationId:target.conversationId});
          }catch{json(res,503,{error:'技能列表未能核实，请稍后重新读取。'});}
          finally{if(codexOperation===owner){codexOperation=null;allState();}}return;
        }
        if(receiptCleanupFaults.size&&!['/api/command/check','/api/command/recover','/api/command/acknowledge','/api/stop-service'].includes(url.pathname)){json(res,409,{error:'原回执读取清理尚未确认，请先再次核对或结束本地服务。'});return;}
        if(url.pathname.startsWith('/api/codex-account/')){
          if(workspace.kind==='source-development'||!accounts.required||!access.account.signedIn){json(res,403,{error:'此工作区没有可确认的BuildX用户身份。'});return;}
          // This public UI and its response contract are specifically for the
          // user's ChatGPT login. A future internal API service needs its own
          // trusted confirmation path; never present it as an account login.
          const visibleType=codex.state?.codexAccount?.type;
          if(visibleType!==undefined&&visibleType!==null&&visibleType!=='chatgpt'){json(res,403,{error:'当前连接不能通过此账号界面确认。'});return;}
          const confirm=url.pathname==='/api/codex-account/confirm';
          if(!confirm&&url.pathname!=='/api/codex-account/inspect'){json(res,404,{error:'未知Codex确认操作'});return;}
          if(Object.keys(input).some(key=>!['client',...(confirm?['challengeId']:[])].includes(key))||confirm&&(typeof input.challengeId!=='string'||input.challengeId.length>160)){json(res,400,{error:'确认只接收本机请求标识和挑战回执，不接收账号或凭据。'});return;}
          if(active||contextBusy||resetting||accountDraining||codexOperation){json(res,409,{error:'请等待当前对话或核对完成。'});return;}
          if(!codex.state.ready||!profileMatches(codex.state)||typeof codex.refreshAccount!=='function'){json(res,503,{error:'请先重新连接本机Codex，再读取和确认。'});return;}
          const before=confirmationFacts(req,input.client),owner={before};codexOperation=owner;allState();
          const same=(a,b)=>Boolean(a?.buildx&&b?.buildx&&a.scope===b.scope&&a.buildx.sessionId===b.buildx.sessionId&&a.buildx.userId===b.buildx.userId&&a.buildx.generation===b.buildx.generation&&a.codex?.connectionGeneration===b.codex?.connectionGeneration&&a.codex?.accountRevision===b.codex?.accountRevision&&a.codex?.type===b.codex?.type&&a.codex?.providerId===b.codex?.providerId&&a.codex?.providerRevision===b.codex?.providerRevision&&a.codex?.model===b.codex?.model);
          try{
            const observed=await codex.refreshAccount();
            const postflight=await accounts.authorize(req),facts=confirmationFacts(req,input.client);
            if(closing||codexOperation!==owner||!postflight.allowed||!postflight.account.signedIn||!same(before,facts)||observed.type!==facts.codex?.type||observed.connectionGeneration!==facts.codex?.connectionGeneration||observed.accountRevision!==facts.codex?.accountRevision||observed.observationSequence!==facts.codex?.observationSequence){json(res,409,{error:'账号或连接已变化，旧核对结果未应用。'});return;}
            const result=confirm?confirmation.confirm(input.challengeId,facts):confirmation.prepare(facts);
            if(!result.ok){json(res,409,{error:result.error.message,codexConfirmation:confirmation.status(facts)});return;}
            if(confirm)json(res,200,{ok:true,confirmation:result.value.confirmation});
            else json(res,200,{ok:true,challengeId:result.value.challengeId,expiresAt:result.value.expiresAt,display:{type:observed.type,email:observed.email,planType:observed.planType,observedAt:observed.observedAt},confirmation:result.value.confirmation});
          }catch{json(res,503,{error:'本机Codex核对未完成，请先重新连接后再核对；不会自动提交确认。'});}
          finally{if(codexOperation===owner){codexOperation=null;allState();}}
          return;
        }
        if(url.pathname==='/api/steer'){
          if(workspace.kind!=='model'||codex.profile?.id!=='model-workspace'||typeof codex.steer!=='function'){json(res,404,{error:'此工作区不支持运行中补充指令。'});return;}
          if(!plainData(input)||Object.keys(input).some(key=>!['client','conversationId','turnId','requestId','message'].includes(key))||typeof input.message!=='string'||!input.message.trim()||input.message.length>16000||typeof input.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)){json(res,400,{error:'补充指令或请求身份无效，本次未发送。'});return;}
          const run=active,target=sessions.get(input.client);
          const current=()=>!closing&&!resetting&&!accountDraining&&active===run&&run?.kind==='chat'&&!run.cancelRequested&&run.client===input.client&&run.conversationId===input.conversationId&&run.turnId===input.turnId&&run.turnId&&target===sessions.get(input.client)&&target?.conversationId===run.conversationId&&target.contextEpoch===run.contextEpoch&&target.run===run.owner&&codex.state.ready===true&&connectionEpoch===run.connectionEpoch&&codex.state.connectionGeneration===run.codexGeneration&&codex.state.codexAccount?.accountRevision===run.codexRevision&&(!accounts.required||sameIdentity(run.accountIdentity,interruptionIdentity(accounts.bindingIdentity(req)))&&confirmation.status(confirmationFacts(req,input.client)).localConnectionConfirmed);
          if(!current()||run.userInputs?.length){json(res,409,{error:'对话、轮次或连接已变化，或有提问等待回答；本次未发送。'});return;}
          if(history&&['pending','failed'].includes(target.persistence?.status)){json(res,409,{error:'本地对话保存尚未确认，本次补充指令未发送。'});return;}
          if(run.steerPending){json(res,409,{error:'补充指令正在处理，本次未再次发送。'});return;}
          const requestId=input.requestId.toLowerCase(),message=input.message.trim();
          if(!target.addSteerReceipt(requestId,run.turnId,message)){json(res,409,{status:'not_sent',error:'存在相同的待核对指令，或本对话回执已满；本次未发送。'});return;}
          run.steerPending=true;
          target.add('user','补充指令：\n'+message);conversation(run.client);
          try{
            // Commit an owned pending receipt before native submission. A crash
            // after this point is conservatively unknown, never an auto-retry.
            if(history){run.steerSave=persist(target,run.historyScope);const saved=await run.steerSave;if(!saved.ok){target.settleSteerReceipt(requestId,'not_sent');conversation(run.client);json(res,503,{status:'not_sent',error:'补充指令的本地回执未能保存，本次未发送。'});return;}}
            if(requireLicense&&!(await accounts.authorizeLicense(req)).allowed||!current()){target.settleSteerReceipt(requestId,'not_sent');if(history&&target.persistence?.status!=='failed')run.steerSave=persist(target,run.historyScope);json(res,409,{status:'not_sent',error:'授权、对话或连接已变化，本次补充指令未发送。'});return;}
            const result=await codex.steer(run.threadId,run.turnId,message,requestId);
            if(!current()||result?.turnId!==run.turnId){target.settleSteerReceipt(requestId,'unknown');if(history&&target.persistence?.status!=='failed')run.steerSave=persist(target,run.historyScope);json(res,502,{status:'unknown',error:'补充指令的接收结果尚未确认，请勿自动重试。'});return;}
            target.settleSteerReceipt(requestId,'accepted');conversation(run.client);
            if(history)run.steerSave=persist(target,run.historyScope);
            json(res,200,{ok:true,status:'accepted'});return;
          }catch(error){
            target.settleSteerReceipt(requestId,error?.notSent===true?'not_sent':'unknown');
            if(current())conversation(run.client);
            if(history&&target.persistence?.status!=='failed')run.steerSave=persist(target,run.historyScope);
            json(res,error?.notSent===true?409:502,{status:error?.notSent===true?'not_sent':'unknown',error:error?.notSent===true?'补充指令未发送。':'补充指令的接收结果尚未确认，请勿自动重试。'});return;
          }finally{run.steerPending=false;}
        }
        if(url.pathname==='/api/dynamic-approval'){
          if(!dynamicApproval&&!modelPermission){json(res,404,{error:'此工作区未开放动态操作审批。'});return;}
          if(req.headers.origin!=='http://'+req.headers.host){json(res,403,{error:'审批需要来自当前本地面板。'});return;}
          if(!plainData(input)||Object.keys(input).some(key=>!['client','conversationId','requestId','digest','decision'].includes(key))||
             !dynamicText(input.conversationId,200)||!dynamicText(input.requestId,200)||!/^([0-9a-f]{64})$/.test(input.digest)||!['accept','decline'].includes(input.decision)){
            json(res,400,{error:'审批请求无效。'});return;
          }
          const run=active,identity=interruptionIdentity(accounts.bindingIdentity(req));
          const entry=run?.dynamicRequests?.find(item=>item.token===input.requestId);
          if(!entry||entry.done||entry.deciding||!entry.preview||entry.preview.digest!==input.digest||
             run.client!==input.client||run.conversationId!==input.conversationId||!currentDynamic(run,entry)||
             accounts.required&&(!sameIdentity(run.accountIdentity,identity)||!confirmation.status(confirmationFacts(req,input.client)).localConnectionConfirmed)){
            json(res,409,{error:'审批所属操作、对话或连接已变化。'});return;
          }
          if(entry.preview.deadline<=Date.now()){
            const expired=entry.model&&await expireModelProposal(run,entry);
            json(res,409,expired?{error:'本次确认已过期，模型操作未开始。',code:'MODEL_APPROVAL_EXPIRED',outcome:'not_started',stage:'approval'}:{error:'审批所属操作、对话或连接已变化。'});return;
          }
          entry.deciding=true;clearTimeout(entry.timer);conversation(run.client);
          if(entry.model){
            let userDecisionProof;
            if(isNativeTypeParameterWrite(entry.modelTool)&&input.decision==='accept')try{userDecisionProof=issueTypeWriteUserDecision({ticket:entry.ticket,digest:entry.preview.digest,sourceDocument:entry.modelGrant.scope.document,deadline:entry.preview.deadline});}
            catch{discardDynamic(run,entry,{reject:true});json(res,409,{error:'类型参数确认已失效，本次未发送写入。'});return;}
            void decideModelDynamic(run,entry,entry.preview.digest,input.decision,userDecisionProof);json(res,200,{ok:true,requestId:input.requestId,decision:input.decision,status:'submitted'});return;
          }
          // Claim once before invoking the owner. The owner receives only the
          // already captured ticket and must independently enforce its scope.
          void Promise.resolve().then(()=>{
            if(entry.done||!currentDynamic(run,entry))throw new Error('scope changed');
            return dynamicApproval.decide({ticket:entry.ticket,digest:entry.preview.digest,decision:input.decision});
          }).then(result=>{
            if(entry.done)return;
            if(!currentDynamic(run,entry)){discardDynamic(run,entry);return;}
            entry.done=true;const index=run.dynamicRequests?.indexOf(entry)??-1;if(index>=0)run.dynamicRequests.splice(index,1);
            try{if(!entry.request.respond(result))entry.request.discard();}catch{try{entry.request.discard();}catch{}}
            if(active===run)conversation(run.client);
          }).catch(()=>{
            if(entry.done)return;
            if(!currentDynamic(run,entry)){discardDynamic(run,entry);return;}
            entry.done=true;const index=run.dynamicRequests?.indexOf(entry)??-1;if(index>=0)run.dynamicRequests.splice(index,1);
            try{entry.request.respond({success:false,contentItems:[{type:'inputText',text:'操作结果未知，请核对原回执；不要自动重试。'}]});}catch{}
            if(active===run)conversation(run.client);
          });
          json(res,200,{ok:true,requestId:input.requestId,decision:input.decision,status:'submitted'});return;
        }
        if(url.pathname==='/api/user-input'){
          if(workspace.kind!=='model'){json(res,404,{error:'此工作区不提供回合内提问。'});return;}
          const run=active,identity=interruptionIdentity(accounts.bindingIdentity(req));
          if(!plainData(input)||Object.keys(input).some(key=>!['client','conversationId','requestId','answers'].includes(key))||!run||run.kind!=='chat'||run.cancelRequested||run.client!==input.client||run.conversationId!==input.conversationId||!run.turnId||!plainData(input.answers)||accounts.required&&(!sameIdentity(run.accountIdentity,identity)||!confirmation.status(confirmationFacts(req,input.client)).localConnectionConfirmed)) {json(res,409,{error:'提问所属对话、账号或连接已变化。'});return;}
          const index=(run.userInputs??[]).findIndex(entry=>entry.token===input.requestId&&entry.params.turnId===run.turnId),entry=run.userInputs?.[index];
          const target=sessions.get(run.client);
          if(!entry||!target||target.conversationId!==run.conversationId||target.contextEpoch!==run.contextEpoch||target.run!==run.owner||entry.request.generation!==codex.state.connectionGeneration||entry.request.revision!==codex.state.codexAccount?.accountRevision||Object.keys(input.answers).length!==entry.params.questions.length){json(res,409,{error:'提问已结束或答案不完整。'});return;}
          const answers=Object.create(null);for(const q of entry.params.questions){
            const value=Object.hasOwn(input.answers,q.id)?input.answers[q.id]:null;
            if(typeof value!=='string'||!value.trim()||value.length>4000||q.options.length&&!q.isOther&&!q.options.some(option=>option.label===value)){json(res,400,{error:'请回答每个问题并使用提供的选项。'});return;}
            answers[q.id]={answers:[value]};
          }
          run.userInputs.splice(index,1);try{if(!entry.request.respond({answers}))throw new Error();}catch{conversation(run.client);json(res,409,{error:'连接已变化；答案是否送达尚未确认。'});return;}
          const record=entry.params.questions.map(q=>'问题：'+q.question+'\n回答：'+answers[q.id].answers[0]).join('\n\n');
          target.add('user','已在本地提交回答；Codex 是否收到尚未确认。\n\n'+record);
          if(history)run.userInputSave=persist(target,run.historyScope);
          conversation(run.client);json(res,200,{ok:true});return;
        }
        if(url.pathname==='/api/interrupt'){
          if(active?.inspection){json(res,409,{error:'正在只读核对回执，未发出新查询。'});return;}
          if(active?.kind==='command'){
            if(active.client!==input.client||input.executionId!==active.executionId||input.conversationId!==undefined&&input.conversationId!==active.conversationId||Object.keys(input).some(key=>!['client','executionId','conversationId'].includes(key))){json(res,409,{error:'命令已变化，旧停止请求未应用。'});return;}
            void cancel(active);
          }else{
            if(input.executionId!==undefined){json(res,409,{error:'命令已结束或已变化，旧停止请求未应用。'});return;}
            if(active?.client===input.client)void cancel(active);
          }
          json(res,202,{ok:true});return;
        }
        if(url.pathname==='/api/command'){
          if(input.commandId==='revit_set_type_parameter'||isNativeTypeParameterWrite(commandDefinitions.get(input.commandId)?.tool)){
            json(res,403,{error:'类型参数写入仅支持聊天中的逐次审批，请在聊天发起并核对本次完整影响；手动命令不能授予此权限。',outcome:'not_started'});return;
          }
          if(!directCommandsAvailable){json(res,404,{error:'此工作区未开放直接命令。'});return;}
          if(!plainData(input)||Object.keys(input).some(key=>!['client','commandId','parameters','conversationId','confirmed','sourceDocument'].includes(key))||!commandIds.has(input.commandId)||!plainData(input.parameters)||Object.hasOwn(input.parameters,'sourceDocument')||typeof input.conversationId!=='string'||input.confirmed!==undefined&&typeof input.confirmed!=='boolean'||Object.hasOwn(input,'sourceDocument')&&!validCommandSourceDocument(input.sourceDocument)){json(res,400,{error:'请选择具名命令并提供当前对话、来源文档与有效参数。'});return;}
          const definition=commandDefinitions.get(input.commandId);
          if(definition?.enabled===false){json(res,409,{error:definition.unavailableReason||'此命令尚未就绪。'});return;}
          if(definition?.readOnly===false&&input.confirmed!==true){
            const grant=modelPermission?currentModelGrant(input.client,sessions.get(input.client)):null;
            const exempt=grant&&modelOperationEffect(definition.tool).kind==='model_transaction'&&(grant.level==='automatic'||input.parameters.mode!=='commit');
            if(!exempt){json(res,403,{error:'请先确认这条命令的具体操作和参数。'});return;}
          }
        }
        if(['/api/command/check','/api/command/recover','/api/command/acknowledge'].includes(url.pathname)){
          if(!directCommandsAvailable){json(res,404,{error:'此工作区未开放回执核对。'});return;}
          if(Object.keys(input).some(key=>!['client','conversationId','commandId','executionId',...(url.pathname==='/api/command/acknowledge'?['revision','confirmed']:[])].includes(key))||!commandIds.has(input.commandId)||typeof input.conversationId!=='string'||typeof input.executionId!=='string'||url.pathname==='/api/command/acknowledge'&&(!Number.isSafeInteger(input.revision)||input.confirmed!==true)){json(res,400,{error:'仅可核对当前命令的原执行记录。'});return;}
        }
        if(!['/api/stop-service','/api/reconnect','/api/new-chat','/api/context','/api/turn',...(directCommandsAvailable?['/api/command','/api/command/check','/api/command/recover','/api/command/acknowledge']:[]),...(history?['/api/chat/select','/api/chat/draft']:[])].includes(url.pathname)){json(res,404,{error:'未知接口'});return;}
        if(history&&['/api/chat/select','/api/chat/draft'].includes(url.pathname)){
          if(historyControl||resetting||accountDraining||codexOperation||url.pathname==='/api/chat/select'&&(active||contextBusy)){json(res,409,{error:'请等待当前操作结束。'});return;}
          const facts=historyIdentity(req),s=session(input.client,facts.scope);
          if(url.pathname==='/api/chat/draft'){
            if(input.conversationId!==s.conversationId){json(res,409,{error:'对话已切换，旧草稿未应用。'});return;}
            if(s.historyReadOnly){json(res,409,{error:'历史对话仅供查看，请新建对话继续。'});return;}
            setDraft(s,input.draft);const saved=await persist(s,facts.scope);
            if(!sameHistoryIdentity(facts,req)){json(res,409,{error:'账号已变化，旧草稿回执未应用。'});return;}
            json(res,saved.ok?200:503,saved.ok?{ok:true,conversationId:s.conversationId}: {error:saved.error?.message||'草稿保存未确认。'});return;
          }
          const control={};historyControl=control;
          try{
            await drainHistory();if(!sameHistoryIdentity(facts,req))throw new Error('账号已变化，请刷新。');
            if(!s.historyReadOnly)setDraft(s,input.draft);const saved=s.persistence?.status==='failed'?{ok:true}:await persist(s,facts.scope);if(!saved.ok)throw new Error(saved.error?.message||'当前对话保存未确认。');
            let target=conversations.get(input.conversationId);
            if(target&&target.historyScope!==facts.scope)target=null;
            if(!target){const found=await history.get(facts.scope,input.conversationId);if(!found.ok)throw new Error(found.error?.message||'无法读取历史对话。');target=new ChatSession({notices:selected.sessionNotices});target.restoreHistory(found.session);target.historyDraft=found.draft??{text:'',includeSelection:false};target.persistence={status:'saved'};remember(target,facts.scope);}
            const roster=await historyView(facts.scope,target.conversationId);
            if(!sameHistoryIdentity(facts,req))throw new Error('账号已变化，旧历史未应用。');
            sessions.set(input.client,target);conversation(input.client);json(res,200,{ok:true,session:sessionView(target),draft:draftOf(target),history:roster});
          }catch(error){json(res,409,{error:safeChatText(error.message||'切换对话未完成。')});}
          finally{if(historyControl===control)historyControl=null;allState();}
          return;
        }
        if(active||contextBusy||codexOperation||historyControl){json(res,409,{error:'上一轮对话或上下文读取尚未结束'});return;}
        if(accounts.required&&['/api/turn','/api/context',...commandsIndependent?[]:['/api/command','/api/command/check','/api/command/recover','/api/command/acknowledge']].includes(url.pathname)&&!confirmation.status(confirmationFacts(req,input.client)).localConnectionConfirmed){json(res,403,{error:'请先读取并明确确认本机Codex连接。'});return;}
        if(url.pathname==='/api/stop-service'){if(modelReceipts.size||modelOperationsInFlight.size){json(res,409,{error:'模型操作的原回执尚未核对，请先核实并确认后再停止服务。'});return;}shutdownOwner={client:input.client,proof:randomBytes(24).toString('hex')};json(res,202,{ok:true,cleanupId:shutdownOwner.proof});requestShutdown(input.client);return;}
        if(url.pathname==='/api/reconnect'){if(!resetting){autoAttempts=0;void reset('重新连接');}json(res,202,{ok:true});return;}
        const historyFacts=history?historyIdentity(req):null,s=session(input.client,historyFacts?.scope);
        if(history){await drainHistory();if(!sameHistoryIdentity(historyFacts,req)||sessions.get(input.client)!==s){json(res,409,{error:'账号或对话已变化，请刷新。'});return;}
          if(active||contextBusy||codexOperation||historyControl){json(res,409,{error:'上一轮操作尚未结束。'});return;}}
        if(url.pathname==='/api/new-chat'){
          if(history){const control={};historyControl=control;
            try{if(!s.historyReadOnly&&input.draft!==undefined)setDraft(s,input.draft);const saved=s.persistence?.status==='failed'?{ok:true}:await persist(s,historyFacts.scope);if(!saved.ok)throw new Error(saved.error?.message||'当前对话保存未确认。');
              const next=new ChatSession({notices:selected.sessionNotices});remember(next,historyFacts.scope);const created=await persist(next,historyFacts.scope,true);if(!created.ok)throw new Error(created.error?.message||'新对话保存未确认。');
              const roster=await historyView(historyFacts.scope,next.conversationId);if(!sameHistoryIdentity(historyFacts,req))throw new Error('账号已变化，新对话未切换。');
              sessions.set(input.client,next);conversation(input.client);json(res,200,{ok:true,session:sessionView(next),draft:draftOf(next),history:roster});
            }catch(error){json(res,503,{error:safeChatText(error.message||'新对话未完成。')});}finally{if(historyControl===control)historyControl=null;allState();}return;
          }
          const next=new ChatSession({notices:selected.sessionNotices});next.contextEpoch=s.contextEpoch+1;sessions.set(input.client,next);
          clearInterruption(interruptionIdentity(accounts.bindingIdentity(req)));conversation(input.client);json(res,200,{ok:true,session:sessionView(sessions.get(input.client))});return;
        }
        if(history&&s.historyReadOnly){json(res,409,{error:'这是历史对话，请新建对话继续。'});return;}
        if(history&&s.persistence?.status==='failed'){json(res,503,{error:s.persistence.message||'本地保存未确认，请先核对。'});return;}
        if(url.pathname==='/api/context'){
          if(!workspace.supportsModelContext){json(res,403,{error:'此工作区不读取Revit模型或选择上下文'});return;}
          const options=contextOptions({includeDocument:input.includeDocument??false,includeSelection:input.includeSelection??false});
          const read={client:input.client,session:s,conversationId:s.conversationId,epoch:s.contextEpoch};read.current=()=>!closing&&contextBusy===read&&sessions.get(read.client)===s&&s.conversationId===read.conversationId&&s.contextEpoch===read.epoch;contextBusy=read;allConversations();
          try{if(await captureContext(read.client,s,options,read.current))json(res,200,{context:s.view().context});else json(res,503,{error:'连接或会话已变化，请重新读取上下文'});}
          catch{if(read.current())json(res,502,{error:s.context.error,context:s.view().context});else json(res,503,{error:'连接或会话已变化，请重新读取上下文'});}
          finally{if(contextBusy===read){contextBusy=null;allConversations();}}return;
        }
        if(!codex.state.ready&&!(commandsIndependent&&['/api/command','/api/command/check','/api/command/recover','/api/command/acknowledge'].includes(url.pathname))){json(res,503,{error:codex.state.message});return;}
        if(url.pathname==='/api/command/recover'){
          const entry=commandViews.get(s);
          if(active||input.conversationId!==s.conversationId||!entry?.receiptOwner||!cabinetReceiptOwners.has(entry.receiptOwner)||entry.view.executionId!==input.executionId||entry.view.commandId!==input.commandId||!entry.cabinetRecovery||entry.view.canInspectCabinetJob!==true||!sameCommandBinding(entry.binding)){json(res,409,{error:'原作业、宿主或账号尚未核实。'});return;}
          startCabinetRecovery(input.client,s,entry);json(res,202,{ok:true,executionId:input.executionId});return;
        }
        if(url.pathname==='/api/command/acknowledge'){
          const entry=commandViews.get(s);
          if(active||input.conversationId!==s.conversationId||!entry?.receiptOwner||!cabinetReceiptOwners.has(entry.receiptOwner)||entry.view.executionId!==input.executionId||entry.view.commandId!==input.commandId||entry.view.canAcknowledgeReceipt!==true||entry.view.receiptCheck?.revision!==input.revision||!sameCommandBinding(entry.binding)){json(res,409,{error:'原回执尚未核实或账号、对话、命令已变化。'});return;}
          let rechecked;try{rechecked=await entry.receiptOwner.inspect();}catch{}
          if(commandViews.get(s)!==entry||!sameCommandBinding(entry.binding)||s.conversationId!==input.conversationId||rechecked?.ok!==true||rechecked.value?.terminal!==true||rechecked.value.status!==entry.view.receiptCheck.status||JSON.stringify(rechecked.value.evidence??null)!==JSON.stringify(entry.view.receiptCheck.evidence??null)){entry.view.canAcknowledgeReceipt=false;entry.view.canInspectReceipt=true;allConversations();json(res,409,{error:'原回执或连接已变化，请重新核对。'});return;}
          if(!await releaseReceiptOwner(entry.receiptOwner,true)){entry.view.receiptCheck.cleanupPending=true;json(res,503,{error:'原回执清理尚未确认，请重试确认。'});allConversations();return;}
          entry.view.canAcknowledgeReceipt=false;entry.view.receiptAcknowledged=true;delete entry.receiptOwner;allConversations();allState();json(res,200,{ok:true,executionId:input.executionId});return;
        }
        if(url.pathname==='/api/command/check'){
          const entry=commandViews.get(s);
          if(input.conversationId!==s.conversationId||!entry?.receiptOwner||entry.view.executionId!==input.executionId||entry.view.commandId!==input.commandId||entry.view.canInspectReceipt!==true||!sameCommandBinding(entry.binding)){json(res,409,{error:'原命令或连接已变化，旧回执未读取。'});return;}
          const revision=startReceiptCheck(input.client,s,entry);json(res,202,{ok:true,executionId:input.executionId,receiptCheckRevision:revision});return;
        }
        if(url.pathname==='/api/command'){
          if(input.conversationId!==s.conversationId){json(res,409,{error:'对话已切换，旧命令未执行。'});return;}
          if(closing||resetting||accountDraining||active||contextBusy||codexOperation||historyControl){json(res,409,{error:'请等待当前操作结束。'});return;}
          if(accounts.required&&(!accounts.bindingIdentity(req)?.verified||!commandsIndependent&&!confirmation.status(confirmationFacts(req,input.client)).localConnectionConfirmed)){json(res,403,{error:'账号或本机 Codex 确认已变化，请重新核验。'});return;}
          const definition=commandDefinitions.get(input.commandId),chosen=structuredClone(input.parameters);let permissionGrant=null,reviewedCommand=null,reviewedFamily=null,reviewedLifecycle=null,lifecycleInspectionGrant=null,confirmed=input.confirmed===true,source=input.sourceDocument===undefined?undefined:structuredClone(input.sourceDocument);
          if(familyCapabilityOwner&&definition?.tool==='revit_family_inspect_job'&&typeof chosen.job_handle==='string'&&chosen.job_handle){
            lifecycleInspectionGrant=currentModelGrant(input.client,s);
            if(lifecycleInspectionGrant){if(source&&!sameWorkbenchDocumentIdentity(source,lifecycleInspectionGrant.scope.document)){json(res,409,{error:'来源模型与已授权模型不同，请重新选择。'});return;}source=lifecycleInspectionGrant.scope.document;}
          }
          if(modelPermission&&definition?.readOnly===false){
            if(modelReceipts.size||modelOperationsInFlight.size){json(res,409,{error:'上一项模型操作仍在执行或结果尚未核对，系统正在回查；可以继续聊天，请勿重复原操作。'});return;}
            permissionGrant=currentModelGrant(input.client,s);
            if(!permissionGrant&&accessServices)try{await bindAccessGrant(input.client,s,historyIdentity(req));permissionGrant=currentModelGrant(input.client,s);}catch(error){json(res,403,{error:safeChatText(error.message)});return;}
            if(!permissionGrant){json(res,403,{error:'请先选择模型操作权限并核实当前模型。'});return;}
            if(!modelOperationEffect(definition.tool).known){json(res,403,{error:'此命令的操作范围尚未核实，本次未执行。'});return;}
            if(definition.tool==='revit_run_command'){
              const review=commandReviews.get(s);
              reviewedCommand=review&&review.conversationId===s.conversationId&&review.contextEpoch===s.contextEpoch&&sameCommandBinding(review.binding)?structuredClone(review.record):null;
              if(!reviewedCommand||reviewedCommand.command_id!==chosen.command_id||reviewedCommand.revision!==chosen.revision){json(res,403,{error:'请先读取并核对该个人命令的准确版本、完整源码和参数。'});return;}
            }
            if(definition.tool==='revit_family_load_job'){
              const prior=commandViews.get(s);
              try{if(prior?.view?.commandId!=='revit_family_inspect_job'||prior.view.status!=='completed'||!sameCommandBinding(prior.binding))throw new Error();reviewedFamily=approvedFamilyFacts(prior.view.result.data,permissionGrant.scope.document,chosen.job_handle);}catch{json(res,403,{error:'请先读取并核对该族作业、RFA 文件和当前模型。'});return;}
            }
            if(['revit_family_save_job','revit_family_close_job'].includes(definition.tool)){
              if(!familyCapabilityOwner){json(res,403,{error:'当前 Revit 插件尚不支持逐次核对族作业；本次未执行。'});return;}
              const prior=commandViews.get(s);
              try{if(prior?.view?.commandId!=='revit_family_inspect_job'||prior.view.status!=='completed'||!sameCommandBinding(prior.binding)||!prior.privateLifecycleInspection)throw new Error();reviewedLifecycle=approvedLifecycleFacts(prior.privateLifecycleInspection,permissionGrant.scope.document,chosen.job_handle,definition.tool);}catch{json(res,403,{error:'请先读取并核对该族作业与当前模型，再确认操作。'});return;}
            }
            if(chosen.mode!==undefined&&!['rollback','commit'].includes(chosen.mode)){json(res,400,{error:'执行方式无效。'});return;}
            if(permissionGrant.level==='rollback'&&chosen.mode==='commit'){json(res,403,{error:'当前为回滚预览，请改为预览或切换模型权限。'});return;}
            if(source&&!sameWorkbenchDocumentIdentity(source,permissionGrant.scope.document)){json(res,409,{error:'来源模型与已授权模型不同，请重新选择。'});return;}
            if(modelOperationEffect(definition.tool).kind==='model_transaction'&&(permissionGrant.level==='automatic'||chosen.mode!=='commit'))confirmed=true;
            if(permissionGrant.scope.accessPolicy?.mode==='full-access'&&['revit_execute_csharp','revit_save_command','revit_run_command'].includes(definition.tool)&&(permissionGrant.level==='automatic'||chosen.mode!=='commit'))confirmed=true;
            source=permissionGrant.scope.document;
          }
          const run=startCommand(input.client,s,input.commandId,chosen,confirmed,source,permissionGrant,reviewedCommand,reviewedFamily,reviewedLifecycle,lifecycleInspectionGrant,Object.hasOwn(input,'sourceDocument'));
          if(!await run.acceptance){json(res,409,{error:'旧回执清理或连接核对尚未确认，未发送新查询。'});return;}
          json(res,202,{ok:true,executionId:run.executionId});return;
        }
        if(typeof input.message!=='string'||!input.message.trim()||input.message.length>16000){json(res,400,{error:'请输入1到16000个字符'});return;}
        if(s.steerReceipts.some(receipt=>['pending','unknown'].includes(receipt.status)&&receipt.message===input.message.trim())){json(res,409,{status:'not_sent',error:'相同的补充指令接收状态尚未确认；请先核对原回执，本次未发送。'});return;}
        if(input.effort!==undefined&&input.model===undefined){json(res,400,{error:'选择推理强度前请先选择模型。'});return;}
        const skillIds=input.skillIds===undefined?[]:input.skillIds;
        if(!Array.isArray(skillIds)||skillIds.length>4||new Set(skillIds).size!==skillIds.length||skillIds.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))){json(res,400,{error:'技能选择无效，本次未发送。'});return;}
        if(skillIds.length){
          const selectedSkills=skillSelections.get(input.client);
          if(!skillsAvailable||input.conversationId!==s.conversationId||selectedSkills?.session!==s||selectedSkills.conversationId!==s.conversationId||selectedSkills.revision!==skillsRevision||skillIds.some(id=>!selectedSkills.ids.has(id))){json(res,409,{error:'技能列表或对话已变化，请重新读取；本次未发送。'});return;}
          if(codex.skillCatalogMode==='customer'&&!skillLibraryCurrent(selectedSkills,req,input.client,s)){json(res,409,{error:'资料库或连接已变化，请重新读取技能；本次未发送。'});return;}
          try{codex.assertSkillSelection(skillIds);}catch{json(res,409,{error:'技能列表已变化，请重新读取；本次未发送。'});return;}
        }
        if(input.model!==undefined){
          if(workspace.kind!=='model'||typeof codex.assertModelSelection!=='function'){json(res,403,{error:'此工作区未开放模型选择。'});return;}
          try{codex.assertModelSelection(input.model,{effort:input.effort});}catch(error){json(res,409,{error:safeChatText(error.message)});return;}
        }
        if(input.attachments!==undefined&&!turnAttachmentsAvailable){json(res,403,{error:'当前连接不支持文件输入。'});return;}
        if(input.attachments!==undefined&&input.conversationId!==s.conversationId){json(res,409,{error:'对话已切换，附件未发送。'});return;}
        const parsedAttachments=turnAttachmentsAvailable?turnInput.parse(input.attachments):{ok:true,files:[]};if(!parsedAttachments.ok){json(res,400,{error:parsedAttachments.error.message});return;}
        const files=parsedAttachments.files,references=files.length?turnInput.references(files):[];
        if(files.some(file=>file.kind==='image')&&typeof codex.assertModelSelection==='function'){
          if(input.model===undefined){json(res,409,{error:'发送图片前请选择支持图片的模型。'});return;}
          try{codex.assertModelSelection(input.model,{requiresImages:true,effort:input.effort});}catch(error){json(res,409,{error:safeChatText(error.message)});return;}
        }
        // Validate text expansion before committing a message or creating a
        // native thread. The final context is checked again immediately below.
        if(files.length)turnInput.prepare('x'.repeat(200),turnInput.withText(input.message.trim(),references));
        const options=contextOptions(input.context);
        if(!workspace.supportsModelContext&&(options.includeDocument||options.includeSelection)){json(res,403,{error:'此工作区不读取Revit模型或选择上下文'});return;}
        if(history&&input.draft!==undefined)setDraft(s,input.draft);
        if(history)s.setContext(); // A new saved request must not inherit the preceding turn's context snapshot.
        const owner=s.begin(input.message.trim(),{attachments:files.map(file=>turnInput.descriptor(file)),references});
        const run={kind:'chat',client:input.client,owner,historyScope:historyFacts?.scope,nativeModel:input.model,nativeEffort:input.effort,accountIdentity:interruptionIdentity(accounts.bindingIdentity(req)),connectionEpoch,codexGeneration:codex.state.connectionGeneration,codexRevision:codex.state.codexAccount?.accountRevision,conversationId:s.conversationId,contextEpoch:s.contextEpoch,threadId:s.threadId,turnId:null,pending:[],cancelRequested:false,contextPending:true};active=run;allConversations();
        run.phaseTiming={start:phaseClock(),native:null,firstNative:false,firstText:false,tools:new Map()};phaseTiming(run,'turn_accepted');
        const current=()=>!closing&&active===run&&sessions.get(run.client)===s&&s.conversationId===run.conversationId&&s.run===owner&&s.contextEpoch===run.contextEpoch;
        const stoppedBeforeStart=()=>{if(!run.cancelRequested)return false;run.contextPending=false;finish(run,'interrupted');json(res,202,{ok:true});return true;};
        try{
          let localImages=[];
          if(files.length){
            const saved=await history.saveTurnAttachments(run.historyScope,files);
            if(!saved.ok)throw new Error(saved.error?.message||'附件保存未确认，本轮未启动。');
            localImages=saved.localImages;
            phaseTiming(run,'attachments_saved');
            if(!current()){json(res,503,{error:'会话已变化，附件未发送。'});return;}
            if(stoppedBeforeStart())return;
          }
          if(history){const saved=await persist(s,run.historyScope);if(!saved.ok)throw new Error(saved.error?.message||'本地保存未确认。');if(!current()){json(res,503,{error:'会话已变化，本轮未启动。'});return;}}
          if(history)phaseTiming(run,'history_saved');
          if(stoppedBeforeStart())return;
          let captured;try{captured=await captureContext(run.client,s,options,current,owner.userMessageId);}finally{run.contextPending=false;}
          if(!captured){json(res,503,{error:'连接已中断，请重试'});return;}
          phaseTiming(run,'context_ready');
          if(run.cancelRequested){finish(run,'interrupted');json(res,202,{ok:true});return;}
          const policyState=accessServices?.view(run.historyScope??historyIdentity(req).scope);
          const accessNote=policyState?'\n\n[BuildX 本轮访问设置快照，只作状态数据，工具会重新核验]\n'+JSON.stringify({mode:policyState.mode,roots:policyState.roots.slice(0,4).map(item=>item.path.slice(0,512)),rootCount:policyState.roots.length,execution:s.executionLevel??'rollback'})+'\n[访问设置结束]':'';
          const receiptScope=historyFacts?.scope??historyIdentity(req).scope,recentReceipts=modelReceiptResolutions.get(receiptScope)??[],pendingReceipts=[...modelReceipts.values()].filter(receipt=>receipt.facts.scope===receiptScope&&modelReceiptAccountCurrent(receipt));
          const receiptNote=recentReceipts.length||pendingReceipts.length?'\n\n[BuildX 原模型操作回执状态数据；不得重跑原请求]\n'+JSON.stringify({pending:pendingReceipts.slice(0,8).map(receipt=>({tool:receipt.tool,status:receipt.checked?.status??'checking',recovery:receipt.checked?.recovery??null})),resolved:recentReceipts})+'\n[回执状态结束]':'';
          const contextText=withChatContext(input.message.trim(),s.context)+accessNote+receiptNote,nativeText=references.length?turnInput.withText(contextText,references):contextText;
          if(turnAttachmentsAvailable)turnInput.prepare(run.threadId||'x'.repeat(200),nativeText,localImages,true);
          if(history){const saved=await persist(s,run.historyScope);if(!saved.ok)throw new Error(saved.error?.message||'本轮上下文保存未确认。');if(!current()){json(res,503,{error:'会话已变化，本轮未启动。'});return;}}
          if(stoppedBeforeStart())return;
          if(!run.threadId){
            const threadId=await codex.newThread();
            if(!current()){json(res,503,{error:'连接或会话已变化，旧轮次未启动'});return;}
            if(!s.bindThread(owner,threadId)){json(res,503,{error:'会话已变化，旧线程不会绑定到当前对话。'});return;}
            run.threadId=owner.threadId;
          }
          phaseTiming(run,'thread_ready');
          if(!current()){json(res,503,{error:'连接已中断，请重试'});return;}
          if(run.cancelRequested){finish(run,'interrupted');json(res,202,{ok:true});return;}
          for(const file of files){
            const checked=await history.readTurnAttachment(run.historyScope,file.id);
            if(!current()){json(res,503,{error:'会话已变化，附件未发送。'});return;}
            if(stoppedBeforeStart())return;
            if(!checked.ok||checked.sha256!==file.sha256||checked.size!==file.bytes)throw new Error('附件快照已变化或无法核对，本轮未发送。');
          }
          if(skillIds.length){
            if(codex.skillCatalogMode==='customer'){
              const selectedSkills=skillSelections.get(input.client),library=selectedSkills?.library;
              const isCurrent=()=>current()&&!run.cancelRequested&&selectedSkills===skillSelections.get(input.client)&&selectedSkills.revision===skillsRevision&&skillLibraryCurrent(selectedSkills,req,input.client,s);
              const roots=library&&await libraryOperation(library,'listRoots',{},isCurrent);
              const ready=roots?.ok===true&&roots.value?.roots?.some(item=>item.status==='available')&&isCurrent();
              if(stoppedBeforeStart())return;
              if(!ready)throw Object.assign(new Error('技能所需项目资料未能重新核实，请刷新技能列表；本次未发送。'),{notSent:true});
            }
            codex.assertSkillSelection(skillIds);
          }
          run.startRequested=true;run.phaseTiming.native=phaseClock();phaseTiming(run,'native_requested',run.phaseTiming.native);const started=await codex.turn(run.threadId,nativeText,localImages,input.model,input.effort,...(skillIds.length?[skillIds]:[]));
          if(!current()){json(res,503,{error:'连接或会话已变化，旧轮次结果须另行核对'});return;}
          if(typeof started?.turn?.id!=='string'||!started.turn.id)throw new Error('Codex 未返回可核对的轮次 ID');
          if(active===run){
            run.turnId=started.turn.id;owner.turnId=run.turnId;
            for(const entry of [...(run.userInputs??[])])if(entry.params.turnId!==run.turnId){entry.request.reject();run.userInputs.splice(run.userInputs.indexOf(entry),1);}
            for(const entry of [...(run.dynamicRequests??[])]){if(entry.params.turnId!==run.turnId)discardDynamic(run,entry,{reject:true});else prepareDynamic(run,entry);}
            phaseTiming(run,'native_acknowledged');
            if(history)void persist(s,run.historyScope);
            if(clearInterruption(run.accountIdentity))allConversations();
            for(const [method,params,observed,toolTiming] of run.pending){if(active!==run)break;applyNotification(run,method,params,observed,toolTiming);}run.pending=[];
            if(active===run&&run.pendingOverflow){
              const terminal=run.pendingTerminals?.get(run.turnId);
              if(terminal)applyNotification(run,...terminal);
              else void reset('启动回执前的事件超过面板保留上限，本轮状态未知；请核对原工具回执。');
              run.pendingTerminals?.clear();
            }
            if(active===run){if(run.userInputs?.length||run.dynamicRequests?.length)conversation(run.client);if(turnTimeout!==null)run.deadline=setTimeout(()=>{if(active===run)void cancel(run,'timeout');},turnTimeout);if(run.cancelRequested)void cancel(run,run.cancelReason);}
          }
          json(res,202,{ok:true,messageId:owner.messageId});
        }catch(error){if(!current()){json(res,503,{error:'连接或会话已变化，旧轮次未提交'});return;}const msg=s.context.error||(error.rpcCode?'Codex协议请求未完成（'+error.rpcCode+'）。':safeChatText(error.message));finish(run,run.startRequested&&error.notSent!==true?'unknown':'failed',msg);json(res,502,{error:msg,context:s.view().context});}
        return;
      }
      const modelAssets=workspace.kind==='model'?{'/register.html':'register.html','/register.css':'register.css','/model-workspace.mjs':'model-workspace.mjs','/command-form-source.mjs':'command-form-source.mjs','/personal-command-fields.mjs':'personal-command-fields.mjs','/command-fields.mjs':'command-fields.mjs','/command-choice-field.mjs':'command-choice-field.mjs','/parameter-change-field.mjs':'parameter-change-field.mjs','/model-workspace.css':'model-workspace.css','/model-picker.mjs':'model-picker.mjs','/model-picker.css':'model-picker.css','/account-license.mjs':'account-license.mjs','/project-knowledge-ui.mjs':'project-knowledge-ui.mjs','/project-files.css':'project-files.css','/model-viewer.mjs':'model-viewer.mjs','/model-viewer.css':'model-viewer.css','/model-viewer-ui.mjs':'model-viewer-ui.mjs'}:{};
      if(workspace.kind==='model'){modelAssets['/clipboard-attachments.mjs']='clipboard-attachments.mjs';modelAssets['/command-parameter-options.mjs']='command-parameter-options.mjs';}
      const file={'/':'index.html','/app.js':'app.js','/account.js':'account.js','/codex-account.js':'codex-account.js','/chat-view.mjs':'chat-view.mjs','/style.css':'style.css',...modelAssets}[url.pathname];
      if(req.method!=='GET'||!file){json(res,404,{error:'未找到页面'});return;}
      let data=await fs.readFile(path.join(root,'public',file));
      // The shared customer/source component retains its original six assets.
      // Only the model composition adds the new layout; no model dependency is
      // imported into the standalone customer chat package.
      if(file==='index.html'&&workspace.kind==='model'){
        const html=data.toString('utf8'),appScript='<script src="/app.js" type="module"></script>';
        // Model must never expose its shared underlying layout if a module is
        // unavailable. Reject unexpected templates instead of dropping the gate.
        for(const marker of ['<body>',appScript,'</head>','</body>'])if(html.split(marker).length!==2)throw new Error('模型工作区页面模板不完整，未提供旧界面。');
        data=html.replace('<body>','<body data-model-shell="true"><section id="model-shell-fallback" role="status"><strong>新版工作区尚未加载</strong><p>请刷新面板；如果仍未出现，请检查本地 BuildX 服务。</p><a href="/">重新加载</a></section><div id="model-shell-content" hidden>')
          .replace(appScript,'</div>'+appScript)
          .replace('</head>','<link rel="stylesheet" href="/model-workspace.css"><link rel="stylesheet" href="/model-picker.css"></head>')
          .replace('</body>','<script src="/model-workspace.mjs" type="module"></script><script src="/model-picker.mjs" type="module"></script><script src="/account-license.mjs" type="module"></script><script src="/project-knowledge-ui.mjs" type="module"></script></body>');
      }
      res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'});res.end(data);
    }catch(error){if(!res.headersSent)json(res,400,{error:safeChatText(error.message||'请求格式不正确')});else res.end();}
    finally{if(ownsAttachmentIntake&&attachmentIntake===req)attachmentIntake=null;if(requestWork){requestWorks.delete(requestWork);settleRequest();}}
  });
  async function listen(){
    if(closing||closed)throw new Error('本地服务正在关闭，不能重新监听。');
    if(ownedAudit&&(await ownedAudit.ready())?.ok!==true)throw new Error('本地日志目录未能核实，服务未监听。');
    if(history){const ready=await history.ready();if(ready?.ok!==true){const error=new Error('本地对话目录未能核实，服务未监听。');error.code=ready?.error?.code??'CHAT_STORE_UNAVAILABLE';throw error;}}
    if(closing||closed)throw new Error('本地服务正在关闭，迟到的日志准备回执不会重新监听。');
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
    if(projectKnowledgeFactory&&!projectRefreshTimer){projectRefreshTimer=setInterval(()=>{
      const owner=projectKnowledge;
      if(!owner||closing||active||contextBusy||projectBind||projectRefreshWork||!sameLiveProjectIdentity(owner.facts))return;
      const work=Promise.resolve().then(()=>owner.service.refresh({isCancelled:()=>closing||projectKnowledge!==owner||Boolean(active||contextBusy||projectBind)||!sameLiveProjectIdentity(owner.facts)})).catch(()=>null).finally(()=>{if(projectRefreshWork===work)projectRefreshWork=null;});projectRefreshWork=work;
    },projectPollMs);projectRefreshTimer.unref?.();}
    return {port:server.address().port,origin:'http://127.0.0.1:'+server.address().port};
  }
  async function close(){
    if(closed)return {closed:true};if(closePromise)return closePromise;cancelAutoReconnect();
    const pendingCommand=active?.kind==='command'?active:null;
    if(!closing){interruptContextRefresh('本地服务已停止，上下文读取已中断。');closing=true;for(const receipt of modelReceipts.values()){clearTimeout(receipt.timer);receipt.timer=null;}revokeModelGrant();clearInterval(projectRefreshTimer);projectRefreshTimer=null;interruptionOwner=null;connectionEpoch++;connecting=false;codexOperation=null;commandViews=new WeakMap();commandReviews=new WeakMap();confirmation.close();if(active)finish(active,'unknown',selected.stopUnknown);
      for(const id of [...streams.keys()])closeStreams(id);
    }
    for(const id of [...streams.keys()])closeStreams(id);
    closePromise=(async()=>{
      if(materialPicker){const stopped=await materialPicker.close();if(stopped?.closed!==true)throw new Error('文件选择窗口清理尚未确认。');}
      if(materialOpener){const stopped=await materialOpener.close();if(stopped?.closed!==true)throw new Error('打开文件请求清理尚未确认。');}
      while(requestWorks.size)await Promise.all([...requestWorks]);
      while(modelReceiptWorks.size)await Promise.all([...modelReceiptWorks]);
      while(projectAgentWorks.size)await Promise.all([...projectAgentWorks]);
      if(accessServices){const stopped=await accessServices.close();if(stopped?.closed!==true)throw new Error('访问策略或文件操作清理尚未确认。');}
      if(visualArtifacts){const stopped=await visualArtifacts.close();if(stopped?.closed!==true)throw new Error('截图读取句柄清理尚未确认。');}
      for(const entry of materialStores.values()){await entry.ready;const stopped=await entry.store.close();if(stopped?.closed!==true)throw new Error('资料库地址存储清理尚未确认。');}
      if(projectRefreshWork)await projectRefreshWork;
      for(const owner of projectHistoryOwners.values()){const result=await owner.cleanup();if(!result?.ok)throw new Error('项目历史资源清理尚未确认。');}
      if(pendingCommand)await pendingCommand.work;
      for(const owner of [...receiptOwners])if(!await releaseReceiptOwner(owner))throw new Error('原回执读取句柄清理尚未确认。');
      if(dynamicApproval){const stopped=await dynamicApproval.close();if(stopped?.closed!==true)throw new Error('动态操作句柄清理尚未确认。');}
      if(modelPermission){const stopped=await modelPermission.close();if(stopped?.closed!==true)throw new Error('模型操作原回执尚未确认，请核对后重试清理。');}
      const codexResult=await codex.close();if(codexResult?.closed!==true)throw new Error('Codex 连接清理尚未确认。');
      await drainHistory();
      if(history){
        if(historyCleanupId!==null){const cleanup=await history.cleanup(historyCleanupId);if(cleanup?.ok!==true)throw new Error('对话存储句柄清理尚未确认。');historyCleanupId=null;}
        const stopped=await history.close();if(stopped?.ok!==true||stopped.value?.closed!==true){if(typeof stopped?.error?.cleanupId==='string')historyCleanupId=stopped.error.cleanupId;throw new Error('对话存储关闭尚未确认。');}
      }
      const result=await accounts.close();if(result?.closed!==true)throw new Error('账号连接清理尚未确认。');
      if(ownedAudit){
        // This branch is entered again only by a subsequent explicit close / the
        // existing authenticated stop-cleanup retry, never a background replay.
        if(auditCleanupId!==null){
          const cleanup=await ownedAudit.cleanup(auditCleanupId);
          if(cleanup?.ok!==true)throw new Error('日志句柄清理尚未确认。');
          auditCleanupId=null;
        }
        const auditResult=await ownedAudit.close();
        if(auditResult?.value?.closed!==true){
          if(typeof auditResult?.error?.cleanupId==='string')auditCleanupId=auditResult.error.cleanupId;
          throw new Error('日志句柄清理尚未确认。');
        }
      }
      await new Promise(resolve=>server.listening?server.close(resolve):resolve());
      for(const [event,listener] of Object.entries(listeners))codex.off(event,listener);
      closed=true;return {closed:true};
    })().finally(()=>{closePromise=null;});
    return closePromise;
  }
  return {server,listen,connect,close,snapshot};
}
