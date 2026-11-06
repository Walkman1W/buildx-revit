import {createHash,randomUUID} from 'node:crypto';
import {supportsModelPermissionTool} from './model-operation-effects.mjs';
import {validateSaveCommandArguments} from './command-store.mjs';
import {FAMILY_TOOLS} from './family-tools.mjs';
import {isVisualInspectionTool} from './visual-inspection-tools.mjs';
import {WORKBENCH_TOOLS,validateToolArguments} from './workbench-client.mjs';
import {isNativeTypeParameterWrite} from './native-type-parameter-writes.mjs';
import {preparedTypeWriteReview,consumeTypeWriteUserDecision,approvePreparedTypeWrite} from './type-parameter-write-approval.mjs';

// The trusted panel host owns grants and recovery decisions. These methods do
// not themselves prove Revit confinement; tool arguments cannot grant a level.
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const text=v=>typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\x00-\x1f\x7f]/.test(v);
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const workbenchContracts=new Map(WORKBENCH_TOOLS.map(tool=>[tool.name,tool]));
const failureMessages=Object.freeze({
  MODEL_PERMISSION_UNAVAILABLE:'尚未启用当前模型的执行权限，请在面板选择执行方式并核实模型。',
  MODEL_PERMISSION_CHANGED:'当前模型、会话或执行权限已变化，请重新核实后发起新操作。',
  MODEL_PERMISSION_SCOPE_INVALID:'模型授权范围的数据结构无效，请重新核实当前模型。',
  MODEL_PERMISSION_SCOPE_MISMATCH:'本次操作与已核实的模型授权范围不一致；未发送到 Revit。',
  MODEL_ACCESS_POLICY_INVALID:'当前访问策略的数据结构无效，请重新选择访问范围。',
  MODEL_OPERATION_UNSUPPORTED:'该工具尚未接入 BuildX 模型执行入口；增加访问权限不能启用它。',
  MODEL_OPERATION_PARAMETERS_INVALID:'模型操作参数结构无效，请按该工具的参数契约重新填写。',
  MODEL_SCRIPT_PARAMETERS_INVALID:'C# 操作参数结构无效，请提供明确的 code 和合法 parameters。',
  MODEL_FAMILY_PARAMETERS_INVALID:'族创建参数无效，请核对模板和尺寸。',
  MODEL_TRANSACTION_MODE_INVALID:'模型事务模式无效，只接受 rollback 或 commit。',
  MODEL_DOCUMENT_MISMATCH:'操作指定的文档与已授权文档不同；未发送到 Revit。',
  MODEL_OPERATION_CALL_INVALID:'模型操作调用身份无效；未发送到 Revit。',
  MODEL_OPERATION_CAPACITY:'待处理模型操作已达上限，请先完成或核对已有操作。',
  MODEL_OPERATION_SIZE_LIMIT:'模型操作数据超过预算，请缩小本次操作。',
  MODEL_OPERATION_DUPLICATE:'该模型操作调用已处理，不会重复执行。',
  MODEL_COMMAND_REVIEW_UNAVAILABLE:'尚未核实个人命令的准确版本，请先读取并确认该版本。',
  MODEL_FAMILY_REVIEW_UNAVAILABLE:'尚未核实族作业及文件，请先读取并确认原作业。',
  MODEL_FAMILY_LIFECYCLE_REVIEW_UNAVAILABLE:'族作业的确认事实不可用或已过期，请重新核实。',
  MODEL_TYPE_PARAMETER_REVIEW_UNAVAILABLE:'类型参数的原态和完整影响核查不可用、已变化或已过期，请重新读取并逐次确认。',
  MODEL_APPROVAL_UNAVAILABLE:'该确认已过期、已处理或权限已变化；未执行。',
});
export class ModelPermissionError extends Error {
  constructor(code,message){super(message);this.name='ModelPermissionError';this.code=code;}
}
// Admission may check the selected workbench contract before observing a model.
// Only its document owner may fill an omitted expected_document afterwards.
// Personal command and domain-specific semantics remain with their own owners.
export function validateModelOperationParameters(tool,parameters,{allowDocumentBinding=false}={}){
  if(!workbenchContracts.has(tool))return parameters;
  try{return validateToolArguments(tool,parameters,{allowDocumentBinding});}catch(cause){
    const code=cause?.field==='arguments.mode'?'MODEL_TRANSACTION_MODE_INVALID':tool==='revit_execute_csharp'&&cause?.field!=='arguments.expected_document'?'MODEL_SCRIPT_PARAMETERS_INVALID':'MODEL_OPERATION_PARAMETERS_INVALID';
    const failure=new ModelPermissionError(code,'Invalid model operation parameters');failure.tool=tool;failure.field=cause?.field;throw failure;
  }
}
export function modelPermissionErrorView(cause){
  const code=cause instanceof ModelPermissionError&&Object.hasOwn(failureMessages,cause.code)?cause.code:'MODEL_OPERATION_PROPOSAL_FAILED';
  const contract=cause instanceof ModelPermissionError?workbenchContracts.get(cause.tool):null;
  return Object.freeze({code,message:failureMessages[code]??'模型操作提议校验失败；未发送到 Revit，请检查执行诊断。',outcome:'not_started',...(contract?{details:{tool:contract.name,...typeof cause.field==='string'?{field:cause.field}:{},inputSchema:structuredClone(contract.inputSchema)}}:{})});
}
const error=(code,message)=>{throw new ModelPermissionError(code,message);};
function receiptFingerprint(value){const stable=snapshot(value);delete stable.checkedAt;return hash(stable);}
export function isRecoverableModelScriptReceipt(tool,value){
  const recovery=value?.recovery,failure=value?.evidence?.nativeFailure,completed=failure?.completedUtc;
  return ['revit_execute_csharp','revit_run_command'].includes(tool)&&plain(value)&&value.status==='unconfirmed'&&value.terminal===false&&
    plain(recovery)&&recovery.kind==='script_failure'&&recovery.requiresReview===true&&recovery.modelRollback==='unknown'&&recovery.externalEffects==='unknown'&&
    plain(failure)&&failure.started===true&&failure.outcome==='failed'&&failure.phase==='dispatch'&&text(value.requestId)&&failure.requestId===value.requestId&&text(failure.hostSession)&&
    typeof completed==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(completed)&&Number.isFinite(Date.parse(completed))&&new Date(completed).toISOString().slice(0,19)===completed.slice(0,19);
}
function snapshot(value,depth=0,budget={nodes:0,bytes:0}){
  if(depth>20||++budget.nodes>20000)error('MODEL_OPERATION_PARAMETERS_INVALID','Invalid model operation data');
  if(typeof value==='string'){
    budget.bytes+=Buffer.byteLength(value);
    if(budget.bytes>140000)error('MODEL_OPERATION_SIZE_LIMIT','Model operation too large');
    return value;
  }
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value)){
    if(value.length>10000||Reflect.ownKeys(value).length!==value.length+1)error('MODEL_OPERATION_PARAMETERS_INVALID','Invalid model operation data');
    return value.map((v,i)=>{if(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,String(i))??{},'value'))error('MODEL_OPERATION_PARAMETERS_INVALID','Invalid model operation data');return snapshot(v,depth+1,budget);});
  }
  if(!plain(value))error('MODEL_OPERATION_PARAMETERS_INVALID','Invalid model operation data');
  const result=Object.create(null),keys=Reflect.ownKeys(value);
  if(keys.length>1000||keys.some(k=>typeof k!=='string'||k==='__proto__'||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)??{},'value')))error('MODEL_OPERATION_PARAMETERS_INVALID','Invalid model operation data');
  for(const key of keys.sort()){
    budget.bytes+=Buffer.byteLength(key);
    if(budget.bytes>140000)error('MODEL_OPERATION_SIZE_LIMIT','Model operation too large');
    result[key]=snapshot(value[key],depth+1,budget);
  }
  return result;
}
function scopeCopy(scope){
  const access=scope?.accessPolicy;
  if(!exact(scope,['client','conversationId','generation','revision','account','document',...(access!==undefined?['accessPolicy']:[])])||!text(scope.client)||!text(scope.conversationId)||!Number.isSafeInteger(scope.generation)||scope.generation<1||!Number.isSafeInteger(scope.revision)||scope.revision<0||!text(scope.account)||!exact(scope.document,['session','path','title'])||!text(scope.document.session)||!text(scope.document.path)||!text(scope.document.title))error('MODEL_PERMISSION_SCOPE_INVALID','Invalid model permission scope');
  if(access!==undefined&&(!exact(access,['id','revision','accountScope','mode'])||!text(access.id)||!Number.isSafeInteger(access.revision)||access.revision<0||!text(access.accountScope)||!['project-write','full-access'].includes(access.mode)))error('MODEL_ACCESS_POLICY_INVALID','Invalid model access policy');
  return freeze({client:scope.client,conversationId:scope.conversationId,generation:scope.generation,revision:scope.revision,account:scope.account,document:{session:scope.document.session,path:scope.document.path,title:scope.document.title},...(access?{accessPolicy:{...access}}:{})});
}
const SCRIPT_NOTICE='C# 脚本具有 Revit 当前用户的权限，可访问文件、网络和其他进程。模型事务回滚不能撤销这些操作；本次确认不构成沙盒。';
const FAMILY_CREATE_SCHEMA=FAMILY_TOOLS.find(tool=>tool.name==='revit_family_create_valve').inputSchema;
function validScriptParameters(value){
  if(Object.keys(value).some(key=>!['expected_document','mode','code','parameters'].includes(key))||typeof value.code!=='string'||value.code.length<1||value.code.length>64000)return false;
  if(Object.hasOwn(value,'parameters')){
    if(!plain(value.parameters))return false;
    for(const item of Object.values(value.parameters))if(!((typeof item==='string'&&item.length<=16000)||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item)))return false;
  }
  return true;
}

/** Trusted host owns the grant, identity checks and human decision channel.
 * verifyDocument must observe live host+document identity; invoke must enforce
 * the passed sourceDocument and shouldContinue again at its publishing boundary.
 * Unknown results stay owned, and cannot be replayed by this owner. */
export function createModelPermissionOwner({invoke,verifyDocument,verifyFamily=async()=>false,verifyLifecycle=async()=>false,familyLifecycleEnabled=false,approvalTimeoutMs=60000,maxEntries=128}={}){
  if(typeof invoke!=='function'||typeof verifyDocument!=='function'||typeof verifyFamily!=='function'||typeof verifyLifecycle!=='function'||typeof familyLifecycleEnabled!=='boolean'||!Number.isSafeInteger(approvalTimeoutMs)||approvalTimeoutMs<1||approvalTimeoutMs>120000||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>4096)throw new TypeError('Invalid model permission owner configuration');
  const entries=new Map(),seen=new Set();let grant=null,revision=0,closing=false;
  const current=e=>{try{return !closing&&grant===e.grant&&revision===e.revision&&!e.cancelled&&e.grant.isCurrent()===true&&e.isCurrent()===true;}catch{return false;}};
  function sweep(){for(const [id,e] of entries)if(e.state==='proposed'&&Date.now()>=e.deadline){e.state='expired';entries.delete(id);}}
  function setLevel({level,scope,isCurrent}={}){
    if(closing||!['rollback','confirm','automatic'].includes(level)||typeof isCurrent!=='function'||isCurrent()!==true)error('MODEL_PERMISSION_UNAVAILABLE','Model permission unavailable');
    const binding=scopeCopy(scope);revision++;grant=Object.freeze({level,binding,isCurrent});
    for(const [id,e] of entries)if(e.state==='proposed'){e.state='revoked';entries.delete(id);}
    return Object.freeze({level,scope:binding});
  }
  function revoke(){revision++;grant=null;for(const [id,e] of entries)if(e.state==='proposed'){e.state='revoked';entries.delete(id);}return true;}
  function propose({scope,callId,tool,parameters,reviewedCommand,reviewedFamily,reviewedLifecycle,reviewedTypeWrite,isCurrent,onStage}={}){
    sweep();
    if(closing||!grant)error('MODEL_PERMISSION_UNAVAILABLE','Model operation unavailable');
    if(entries.size>=maxEntries||seen.size>=4096)error('MODEL_OPERATION_CAPACITY','Model operation unavailable');
    if(typeof isCurrent!=='function'||isCurrent()!==true||grant.isCurrent()!==true)error('MODEL_PERMISSION_CHANGED','Model operation unavailable');
    if(!text(callId)||onStage!==undefined&&typeof onStage!=='function')error('MODEL_OPERATION_CALL_INVALID','Model operation unavailable');
    const visual=isVisualInspectionTool(tool),script=tool==='revit_execute_csharp',save=tool==='revit_save_command',run=tool==='revit_run_command',family=tool==='revit_family_load_job',familyCreate=tool==='revit_family_create_valve',lifecycle=['revit_family_save_job','revit_family_close_job'].includes(tool),external=['revit_smart_annotate','revit_build_schematic'].includes(tool),typeWrite=isNativeTypeParameterWrite(tool);
    if(hash(scopeCopy(scope))!==hash(grant.binding))error('MODEL_PERMISSION_SCOPE_MISMATCH','Model operation requires separate authorization');
    if(!(supportsModelPermissionTool(tool)||familyLifecycleEnabled&&lifecycle))error('MODEL_OPERATION_UNSUPPORTED','Model operation requires separate authorization');
    if(!plain(parameters))error('MODEL_OPERATION_PARAMETERS_INVALID','Invalid model operation data');
    let chosen=snapshot(parameters);if(save)chosen=snapshot(validateSaveCommandArguments(chosen));
    if(Object.hasOwn(chosen,'expected_document')&&chosen.expected_document!==grant.binding.document.path)error('MODEL_DOCUMENT_MISMATCH','Model document mismatch');
    if(script&&!validScriptParameters(chosen))error('MODEL_SCRIPT_PARAMETERS_INVALID','Invalid C# operation data');
    if(familyCreate){
      if(Object.keys(chosen).some(key=>!Object.hasOwn(FAMILY_CREATE_SCHEMA.properties,key))||!FAMILY_CREATE_SCHEMA.properties.template_id.enum.includes(chosen.template_id))error('MODEL_FAMILY_PARAMETERS_INVALID','Invalid family creation data');
      for(const key of ['length_mm','diameter_mm']){const rule=FAMILY_CREATE_SCHEMA.properties[key];if(!Object.hasOwn(chosen,key))chosen[key]=rule.default;if(typeof chosen[key]!=='number'||!Number.isFinite(chosen[key])||chosen[key]<rule.minimum||chosen[key]>rule.maximum)error('MODEL_FAMILY_PARAMETERS_INVALID','Invalid family creation data');}
    }
    let reviewed=null;
    if(run){
      if(Object.keys(chosen).some(key=>!['command_id','revision','expected_document','mode','parameters'].includes(key))||typeof chosen.command_id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(chosen.command_id)||typeof chosen.revision!=='string'||!/^[a-f0-9]{64}$/.test(chosen.revision)||!plain(reviewedCommand)||reviewedCommand.command_id!==chosen.command_id||reviewedCommand.revision!==chosen.revision||typeof reviewedCommand.name!=='string'||typeof reviewedCommand.description!=='string'||(typeof reviewedCommand.code==='string')===Array.isArray(reviewedCommand.steps))error('MODEL_COMMAND_REVIEW_UNAVAILABLE','Personal command revision unavailable');
      const selected={};for(const key of ['schema_version','command_id','revision','name','description','code','steps','parameters','parameter_labels','parameter_options'])if(Object.hasOwn(reviewedCommand,key))selected[key]=reviewedCommand[key];
      reviewed=snapshot(selected);
    }
    let familyFacts=null;
    if(family){
      if(Object.keys(chosen).some(key=>!['job_handle','expected_document','mode'].includes(key))||!text(chosen.job_handle)||chosen.job_handle.length>180||!exact(reviewedFamily,['job_handle','project_handle','project_fingerprint','save'])||reviewedFamily.job_handle!==chosen.job_handle||!text(reviewedFamily.project_handle)||!text(reviewedFamily.project_fingerprint)||!exact(reviewedFamily.save,['path','sha256'])||!text(reviewedFamily.save.path)||typeof reviewedFamily.save.sha256!=='string'||!/^[a-f0-9]{64}$/.test(reviewedFamily.save.sha256))error('MODEL_FAMILY_REVIEW_UNAVAILABLE','Family job facts unavailable');
      familyFacts=snapshot(reviewedFamily);
    }
    let lifecycleFacts=null;
    if(lifecycle){
      const operation=tool.slice('revit_'.length);
      if(Object.keys(chosen).some(key=>!['job_handle','expected_document'].includes(key))||!text(chosen.job_handle)||!exact(reviewedLifecycle,['review','approvedLifecycle','approvedFamilyIdentity','expiresAt'])||!plain(reviewedLifecycle.review)||!exact(reviewedLifecycle.approvedLifecycle,['schema_version','operation','approval_token'])||reviewedLifecycle.approvedLifecycle.schema_version!==1||reviewedLifecycle.approvedLifecycle.operation!==operation||!/^[a-f0-9]{32}$/.test(reviewedLifecycle.approvedLifecycle.approval_token)||!plain(reviewedLifecycle.approvedFamilyIdentity)||reviewedLifecycle.review.job_handle!==chosen.job_handle||reviewedLifecycle.approvedFamilyIdentity.job_handle!==chosen.job_handle||!Number.isSafeInteger(reviewedLifecycle.expiresAt)||reviewedLifecycle.expiresAt<=Date.now()||reviewedLifecycle.expiresAt>Date.now()+120000)error('MODEL_FAMILY_LIFECYCLE_REVIEW_UNAVAILABLE','Family lifecycle review unavailable');
      lifecycleFacts=snapshot(reviewedLifecycle);
    }
    if(!save&&!familyCreate&&!lifecycle&&!visual){
      const requested=Object.hasOwn(chosen,'mode')?chosen.mode:'rollback';
      if(!['rollback','commit'].includes(requested))error('MODEL_TRANSACTION_MODE_INVALID','Invalid model transaction mode');
      chosen.mode=grant.level==='rollback'?'rollback':requested;
    }
    const contract=workbenchContracts.get(tool);
    if(contract){
      // The permission owner already owns this exact document binding. Preserve
      // an explicit caller path; bind an omitted path once from that owner.
      if(Object.hasOwn(contract.inputSchema.properties??{},'expected_document')&&!Object.hasOwn(chosen,'expected_document'))chosen.expected_document=grant.binding.document.path;
      chosen=validateModelOperationParameters(tool,chosen);
    }
    let typeWriteFacts=null,typeParameterReview=null;
    if(typeWrite){
      try{const observed=preparedTypeWriteReview(reviewedTypeWrite,{args:chosen,sourceDocument:grant.binding.document});typeWriteFacts={prepared:reviewedTypeWrite,...observed};typeParameterReview=JSON.stringify(observed.review);}
      catch{error('MODEL_TYPE_PARAMETER_REVIEW_UNAVAILABLE','Type parameter review unavailable');}
      if(typeParameterReview.length>60000||Buffer.byteLength(typeParameterReview)>100000)error('MODEL_OPERATION_SIZE_LIMIT','Type parameter review too large');
    }
    if(Buffer.byteLength(JSON.stringify({chosen,reviewed,familyFacts,lifecycleFacts,typeParameterReview:typeWriteFacts?.review}))>140000)error('MODEL_OPERATION_SIZE_LIMIT','Model operation too large');
    freeze(chosen);if(reviewed)freeze(reviewed);if(familyFacts)freeze(familyFacts);if(lifecycleFacts)freeze(lifecycleFacts);
    const key=hash([grant.binding,callId]);if(seen.has(key))error('MODEL_OPERATION_DUPLICATE','Duplicate model operation');
    const ticket=randomUUID(),deadline=Math.min(Date.now()+approvalTimeoutMs,lifecycleFacts?.expiresAt??Infinity,typeWriteFacts?.expiresAt??Infinity);
    const digest=hash({version:1,ticket,scope:grant.binding,level:grant.level,callId,tool,parameters:chosen,reviewedCommand:reviewed,reviewedFamily:familyFacts,reviewedLifecycle:lifecycleFacts,...typeWriteFacts?{typeParameterReview:typeWriteFacts.review}:{},deadline});
    const entry={ticket,digest,grant,revision,isCurrent,onStage,tool,chosen,familyFacts,lifecycleFacts,typeWriteFacts,deadline,state:'proposed',cancelled:false,result:null};
    seen.add(key);entries.set(ticket,entry);
    return freeze({ticket,digest,level:grant.level,tool,parameters:chosen,document:grant.binding.document,deadline,
      effect:visual?'view_capture':script?'csharp':save?'save_command':run?'run_command':family?'family_load':familyCreate?'family_create':lifecycle?'family_lifecycle':external?'external_model_operation':'model_transaction',requiresApproval:typeWrite||(script||save||run)&&grant.binding.accessPolicy?.mode!=='full-access'||family||familyCreate||lifecycle||external||grant.level==='confirm'&&chosen.mode==='commit',...(typeParameterReview?{typeParameterReview}:{}),...(reviewed?{reviewedCommand:reviewed}:{}),...(familyFacts?{reviewedFamily:familyFacts}:{}),...(lifecycleFacts?{reviewedLifecycle:lifecycleFacts.review}:{}),...(typeWrite?{notice:'本次操作修改一个类型参数，可能影响所有直接使用该类型的实例；间接影响未评估。预览与应用均需本次逐项确认，模型不会自动保存。'}:visual?{notice:'原生视图导图写入自有图片目录；检查使用专属临时视图并始终尝试回滚清理，原活动视图和选择保留，模型不保存。'}:script||run?{notice:SCRIPT_NOTICE}:save?{notice:'将以上完整内容保存为本地个人命令版本；保存不会运行脚本或验证其效果。'}:family?{notice:'将核实后的 RFA 加载到当前模型。回滚只撤销模型事务，不删除原 RFA；应用后模型不会自动保存。'}:familyCreate?{notice:'创建独立临时族文档，不随项目事务回滚；模板由宿主执行时选择并核验，不保存或加载。'}:lifecycle?{notice:tool==='revit_family_save_job'?'将保存独立 RFA 文件；路径由宿主生成，并关闭临时族后重新打开核验。文件不会随项目回滚删除。':'将关闭该临时族，丢弃未保存内容；已保存的 RFA 保留。'}:external?{notice:'该操作调用外部标注或系统图服务；回滚只撤销模型事务，不能保证撤销扩展服务的事务外副作用。'}:{})});
  }
  function stage(entry,phase,outcome){try{entry.onStage?.({phase,ticket:entry.ticket,tool:entry.tool,...outcome?{outcome}:{}});}catch{/* Diagnostics never change authorization or execution. */}}
  async function decide({ticket,digest,decision,userDecisionProof}={}){
    const e=entries.get(ticket);
    if(!e||e.state!=='proposed'||e.digest!==digest||!current(e)||Date.now()>=e.deadline||!['accept','decline'].includes(decision))error('MODEL_APPROVAL_UNAVAILABLE','Model operation approval unavailable');
    if(decision==='decline'){entries.delete(ticket);e.state='declined';stage(e,'completed','declined');return {status:'declined'};}
    if(e.typeWriteFacts&&!consumeTypeWriteUserDecision(userDecisionProof,{ticket,digest,sourceDocument:e.grant.binding.document}))error('MODEL_APPROVAL_UNAVAILABLE','A one-use panel user decision is required');
    e.state='verifying';
    stage(e,'verifying');
    try{if(await verifyDocument(e.grant.binding.document,{accessPolicy:e.grant.binding.accessPolicy})!==true||!current(e)||Date.now()>=e.deadline)throw new Error();if(e.familyFacts&&await verifyFamily(e.familyFacts,e.grant.binding.document,{shouldContinue:()=>current(e),accessPolicy:e.grant.binding.accessPolicy})!==true)throw new Error();if(e.lifecycleFacts&&await verifyLifecycle(e.grant.binding.document)!==true)throw new Error();if(!current(e)||Date.now()>=e.deadline)throw new Error();}
    catch{e.state='not_started';entries.delete(ticket);stage(e,'completed','not_started');return {status:'not_started',code:'MODEL_DOCUMENT_REVALIDATION_FAILED'};}
    let approvedTypeWrite;
    if(e.typeWriteFacts)try{approvedTypeWrite=approvePreparedTypeWrite(e.typeWriteFacts.prepared,{args:e.chosen,sourceDocument:e.grant.binding.document,deadline:e.deadline});}
    catch{e.state='not_started';entries.delete(ticket);stage(e,'completed','not_started');return {status:'not_started',code:'MODEL_TYPE_PARAMETER_REVIEW_UNAVAILABLE'};}
    // Mark in flight before invoking: a thrown exception cannot prove nothing
    // was published, and revocation cannot pretend to cancel a sent request.
    e.state='dispatching';stage(e,'dispatching');let result;
    try{result=await invoke(e.tool,e.chosen,{sourceDocument:e.grant.binding.document,creationScope:{account:e.grant.binding.account,conversationId:e.grant.binding.conversationId},expectedHostSession:e.grant.binding.document.session,...e.grant.binding.accessPolicy?{accessPolicy:e.grant.binding.accessPolicy}:{},shouldContinue:()=>current(e),retainReceiptOwner:true,...approvedTypeWrite?{approvedTypeWrite}:{},...e.familyFacts?{approvedFamily:e.familyFacts}:{},...e.lifecycleFacts?{approvedLifecycle:e.lifecycleFacts.approvedLifecycle,approvedFamilyIdentity:e.lifecycleFacts.approvedFamilyIdentity}:{}});}
    catch(cause){
      // A transport may throw after publishing while retaining a handle to the
      // only original receipt. Losing that owner would make recovery impossible.
      result=cause?.receiptOwner?{ok:false,receiptOwner:cause.receiptOwner}:null;
    }
    e.result=result;e.receiptOwner=result?.receiptOwner??null;
    // A successful transport may retain the original receipt to protect a
    // late revocation race. Release it only after the successful result is
    // received while this grant is current; failed cleanup stays owned.
    if(result?.ok===true&&e.receiptOwner&&current(e)){
      try{const stopped=await e.receiptOwner.close();if(stopped?.ok===true&&stopped.value?.closed===true)e.receiptOwner=null;}catch{}
    }
    if(e.receiptOwner||result?.error?.outcome!=='not_started'&&(!current(e)||result?.ok!==true)){
      e.state='unconfirmed';stage(e,'completed','unconfirmed');return {status:'unconfirmed',ticket:e.ticket,...result?.error?.outcome==='not_started'?{operationOutcome:'not_started',...result.error.stage?{stage:result.error.stage}:{}}:{}};
    }
    entries.delete(ticket);e.state='completed';stage(e,'completed',result.ok===true?'completed':'not_started');
    if(result.ok===true)return {status:'completed',result};
    if(result.error?.code==='MODEL_VISUAL_SOURCE_INVALID')return {status:'not_started',code:result.error.code,message:'找不到本轮可用的创建回执。请在当前模型中选中要检查的构件，再发起新的视觉检查。'};
    return {status:'not_started'};
  }
  async function cancel({ticket}={}){
    const e=entries.get(ticket);if(!e)return false;e.cancelled=true;
    if(e.state==='proposed'){entries.delete(ticket);e.state='cancelled';return true;}
    return false;
  }
  function receiptEntry(ticket,scope){
    const e=entries.get(ticket);if(!e||e.state!=='unconfirmed'||hash(scopeCopy(scope))!==hash(e.grant.binding))error('MODEL_RECEIPT_UNAVAILABLE','Original model receipt unavailable');
    return e;
  }
  async function inspect({ticket,scope}={}){
    const e=receiptEntry(ticket,scope);
    if(typeof e.receiptOwner?.inspect==='function')return e.receiptOwner.inspect();
    if(e.result?.ok===true){const {receiptOwner,...result}=e.result;return {ok:true,value:{terminal:true,status:'received',result:structuredClone(result)}};}
    return {ok:true,value:{status:'unconfirmed',terminal:false,originalReceiptUnavailable:true}};
  }
  async function restoreVisual({ticket,scope,expected,shouldContinue}={}){
    const e=receiptEntry(ticket,scope);
    if(e.tool!=='revit_inspect_elements'||e.resolving||expected?.canRestoreVisual!==true||typeof e.receiptOwner?.restoreVisual!=='function'||typeof shouldContinue!=='function')
      error('MODEL_RECEIPT_UNAVAILABLE','当前没有可恢复的原检查视图。');
    e.resolving=true;
    try{
      const actual=await inspect({ticket,scope});
      if(actual?.ok!==true||actual.value?.canRestoreVisual!==true||receiptFingerprint(actual.value)!==receiptFingerprint(expected))
        error('MODEL_RECEIPT_UNCONFIRMED','原检查视图状态已变化，请再次核对。');
      if(!shouldContinue())error('MODEL_RECEIPT_UNAVAILABLE','原回执账号或对话已变化。');
      return await e.receiptOwner.restoreVisual(shouldContinue);
    }finally{e.resolving=false;}
  }
  async function settleReceipt({ticket,scope,expected}={},review=false){
    const e=receiptEntry(ticket,scope);if(e.resolving||!plain(expected))error('MODEL_RECEIPT_UNAVAILABLE','Original model receipt unavailable');
    e.resolving=true;
    try{
      const acceptable=value=>review?isRecoverableModelScriptReceipt(e.tool,value)&&value.evidence.nativeFailure.hostSession===e.grant.binding.document.session:value?.terminal===true;
      const readStable=async()=>{const actual=await inspect({ticket,scope});if(actual?.ok!==true||!acceptable(actual.value)||receiptFingerprint(actual.value)!==receiptFingerprint(expected))error('MODEL_RECEIPT_UNCONFIRMED','Original model receipt changed or unconfirmed');};
      await readStable();
      if(review){
        // A human may retire an ended script failure after inspecting the live
        // original model. The former execution grant may already be revoked.
        let verified=false;try{verified=await verifyDocument(e.grant.binding.document,{accessPolicy:e.grant.binding.accessPolicy,recovery:true,receiptScope:e.grant.binding})===true;}catch{}
        if(!verified)error('MODEL_RECEIPT_DOCUMENT_CHANGED','Original model document could not be revalidated');
        await readStable();
      }
      if(e.receiptOwner){if(typeof e.receiptOwner.close!=='function')error('MODEL_RECEIPT_CLEANUP_UNAVAILABLE','Receipt cleanup unavailable');const closed=await e.receiptOwner.close();if(closed?.ok!==true||closed.value?.closed!==true)error('MODEL_RECEIPT_CLEANUP_UNCONFIRMED','Receipt cleanup unconfirmed');}
      entries.delete(ticket);return review?{closed:true,outcome:'failed',modelRollback:'unknown',externalEffects:'unknown'}:{closed:true};
    }finally{e.resolving=false;}
  }
  const acknowledge=input=>settleReceipt(input);
  const recover=input=>settleReceipt(input,true);
  async function close(){closing=true;revoke();return {closed:entries.size===0};}
  return Object.freeze({setLevel,revoke,propose,decide,cancel,inspect,acknowledge,recover,restoreVisual,close});
}
