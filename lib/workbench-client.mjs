import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {expectedDocument,commonWrite as common,elementId,elementIds,pointMm,workbenchDocumentIdentity,sameWorkbenchDocumentIdentity,workbenchElementIdString} from './workbench-contracts.mjs';
import {MODELLING_TOOLS,MODELLING_TEMPLATE_VERSION,isModellingTool,compileModellingTool} from './modelling-tools.mjs';
import {NATIVE_SCHEMATIC_TOOLS,NATIVE_SCHEMATIC_OPERATION_BY_TOOL,isNativeSchematicTool,assertNativeSchematicDocument,assertNativeSchematicResult} from './native-schematic-tools.mjs';
import {CAD_TOOLS,CAD_OPERATION_BY_TOOL,isCadTool,assertCadArguments,cadHostArguments,projectCadResult,CAD_RESPONSE_MAX_BYTES} from './cad-tools.mjs';
import {FAMILY_TOOLS,FAMILY_OPERATION_BY_TOOL,FAMILY_PANEL_CONFIRMATION_ONLY,isFamilyTool,assertFamilyArguments,assertFamilyResult} from './family-tools.mjs';
import {captureReadonlyReceiptOwner} from './workbench-receipt.mjs';
import {modelOperationEffect} from './model-operation-effects.mjs';
import {VISUAL_INSPECTION_TOOLS,VISUAL_OPERATION_BY_TOOL,isVisualInspectionTool,assertVisualArguments,assertVisualResult} from './visual-inspection-tools.mjs';
import {createVisualRecoveryOwner} from './visual-inspection-recovery.mjs';
import {NATIVE_MODEL_QUERY_TOOLS,NATIVE_MODEL_QUERY_NAMES,NATIVE_MODEL_QUERY_OPERATION_BY_TOOL,isNativeModelQuery,supportsNativeModelQueries,assertNativeModelQueryArguments,assertNativeModelQueryResult} from './native-model-queries.mjs';
import {NATIVE_PARAMETER_QUERY_TOOLS,NATIVE_PARAMETER_QUERY_NAMES,NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL,isNativeParameterQuery,supportsNativeParameterQueries,assertNativeParameterQueryArguments,assertNativeParameterQueryResult} from './native-parameter-queries.mjs';
import {resolveBuildxPaths} from './buildx-paths.mjs';
import {assertParameterWriteResult} from './parameter-write-result.mjs';

const ROOT = resolveBuildxPaths(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).workbenchRoot;
const isNamedNativeQuery=name=>isNativeModelQuery(name)||isNativeParameterQuery(name);
function requireNativeQueryCapability(name,host,operation){
  if(isNativeModelQuery(name)&&!supportsNativeModelQueries(host,operation))throw notQueued('原生查询需要宿主 0.8.1、nativeModelQueriesVersion:1 和具名操作声明；请求未入队。');
  if(isNativeParameterQuery(name)&&!supportsNativeParameterQueries(host,operation))throw notQueued('类型参数查询需要宿主 0.8.2、nativeParameterQueriesVersion:1 和具名操作声明；请求未入队。');
}
const queryFilters={category:{type:'string',description:'Exact BuiltInCategory enum name, for example OST_PipeCurves. Empty or omitted means all categories.'},name_contains:{type:'string'},limit:{type:'integer',minimum:1,maximum:200,default:50},offset:{type:'integer',minimum:0,maximum:2147483647,default:0}};
function contract(name,description,properties,required,readOnly){
  return {name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:readOnly,...(!readOnly?{destructiveHint:false,idempotentHint:false}:{})}};
}
const NEW_WORKBENCH_TOOLS=[
  contract('revit_capture_model_snapshot','Capture at most 300 element bounding boxes in one read-only Revit callback. Coordinates are millimetres in Revit internal coordinates; boxes are approximate, coverage may be incomplete, and freshness is unknown after capture.',{expected_document:expectedDocument,limit:{type:'integer',minimum:1,maximum:300,default:200}},['expected_document'],true),
  contract('revit_get_selection','Read the current Revit selection. Verify workbench status first; queries may use an unsaved document with expected_document="".',{expected_document:expectedDocument},['expected_document'],true),
  contract('revit_search_elements','Search current-document elements by category and name, with bounded pagination. category is a BuiltInCategory enum name. Read-only; an unsaved current document is allowed.',{expected_document:expectedDocument,...queryFilters},['expected_document'],true),
  contract('revit_list_levels','List current-document levels with elevation_mm and project_elevation_mm. Use project_elevation_mm for absolute creation coordinates. Read-only; an unsaved current document is allowed.',{expected_document:expectedDocument},['expected_document'],true),
  contract('revit_list_family_types','List current-document element/family types by category and name, with bounded pagination. Use actual returned type IDs for modelling. Read-only; an unsaved current document is allowed.',{expected_document:expectedDocument,...queryFilters},['expected_document'],true),
  contract('revit_describe_parameters','Describe one element\'s parameters, IDs, storage types, values, units and writeability. Required before setting parameters. Read-only; an unsaved current document is allowed.',{expected_document:expectedDocument,element_id:elementId},['expected_document','element_id'],true),
  contract('revit_set_parameters','Set 1–50 identified parameters in the allowed document. Call revit_describe_parameters first. Built-in parameter IDs may be negative; 0 and -1 are invalid. Double values require value_unit="internal" and Revit internal units, not display units. String/Integer values may omit value_unit. Host 0.8.3 verifies readback after setting, regeneration and inner commit; changed compares observed before/after, while updated_count includes unchanged rows. Values are observed before the outer group rollback/commit decision. Default rollback; commit keeps changes without saving.',{...common,changes:{type:'array',minItems:1,maxItems:50,items:{type:'object',properties:{element_id:elementId,parameter_id:{anyOf:[{type:'integer',maximum:-2},{type:'integer',minimum:1}]},value:{anyOf:[{type:'string'},{type:'number'}]},value_unit:{type:'string',enum:['internal']}},required:['element_id','parameter_id','value'],additionalProperties:false}}},['expected_document','changes'],false),
  contract('revit_move_elements','Move 1–50 elements in the allowed document by delta_mm in the Revit internal coordinate axes. The tool converts millimetres to internal units. Default rollback; commit keeps changes without saving.',{...common,element_ids:elementIds,delta_mm:pointMm},['expected_document','element_ids','delta_mm'],false),
  contract('revit_copy_elements','Copy 1–50 elements within the allowed document by delta_mm in the Revit internal coordinate axes. The tool converts millimetres to internal units. Default rollback; commit keeps new elements without saving.',{...common,element_ids:elementIds,delta_mm:pointMm},['expected_document','element_ids','delta_mm'],false),
  contract('revit_create_wall','Create a straight wall in the allowed document using actual wall type and level IDs. start_mm/end_mm are absolute millimetre coordinates in the Revit internal coordinate system. The baseline must be horizontal, with both Z values equal to the selected level\'s project_elevation_mm plus offset_mm. height_mm must be positive. The tool converts millimetres to internal units. Default rollback; commit does not save.',{...common,wall_type_id:elementId,level_id:elementId,start_mm:pointMm,end_mm:pointMm,height_mm:{type:'number',exclusiveMinimum:0},offset_mm:{type:'number',default:0},structural:{type:'boolean',default:false}},['expected_document','wall_type_id','level_id','start_mm','end_mm','height_mm'],false),
  contract('revit_create_pipe','Create a straight pipe in the allowed document using actual pipe type, piping system type and level IDs. start_mm/end_mm are absolute millimetre coordinates in the Revit internal coordinate system; diameter_mm must be positive. The tool converts millimetres to internal units. Default rollback; commit does not save.',{...common,pipe_type_id:elementId,system_type_id:elementId,level_id:elementId,start_mm:pointMm,end_mm:pointMm,diameter_mm:{type:'number',exclusiveMinimum:0}},['expected_document','pipe_type_id','system_type_id','level_id','start_mm','end_mm','diameter_mm'],false)
];
const OPERATION_BY_TOOL={revit_workbench_status:'status',revit_execute_csharp:'execute_csharp',revit_smart_annotate:'smart_annotate',revit_build_schematic:'build_schematic',revit_get_selection:'get_selection',revit_search_elements:'search_elements',revit_list_levels:'list_levels',revit_list_family_types:'list_family_types',revit_describe_parameters:'describe_parameters',revit_capture_model_snapshot:'capture_model_snapshot',revit_set_parameters:'set_parameters',revit_move_elements:'move_elements',revit_copy_elements:'copy_elements',revit_create_wall:'create_wall',revit_create_pipe:'create_pipe',...NATIVE_SCHEMATIC_OPERATION_BY_TOOL,...CAD_OPERATION_BY_TOOL,...VISUAL_OPERATION_BY_TOOL};
export const WORKBENCH_TOOLS = [
  {name:'revit_workbench_status',description:'Read the independent Revit workbench host and current model identity. Required before every model operation. Reports actual document and staged dependencies, not proof all capabilities run successfully.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'revit_execute_csharp',description:'Execute a C# method body in Revit with uiapp, uidoc, doc, app variables. Return compact JSON-compatible data. Host owns one Transaction and outer rollback/commit group; do not start another Transaction. Explain the script before execution. Only documents in the host allowlist are allowed. C# has Revit user privileges, NOT a security sandbox; do not access files/network, other documents, save/close models, or start processes/threads. No hard execution timeout: unknown outcome must never be retried automatically.',inputSchema:{type:'object',properties:{...common,code:{type:'string',minLength:1,maxLength:64000},parameters:{type:'object',additionalProperties:{anyOf:[{type:'string',maxLength:16000},{type:'number'},{type:'boolean'}]}}},required:['expected_document','code'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false}},
  {name:'revit_smart_annotate',description:'Run recovered Argus LiteTaggingService and local Sano inference on 1–50 same-category elements in the CURRENT plan/section/elevation view. Requires a loaded compatible tag family type. Returns actual created tag ids. Only an allowed document. Default rollback; commit only when user requested applying annotations. Does not alter original Argus.',inputSchema:{type:'object',properties:{...common,element_ids:{type:'array',items:{type:'integer',minimum:1},minItems:1,maxItems:50},view_id:{type:'integer',minimum:1},tag_type_id:{type:'integer',minimum:1}},required:['expected_document','element_ids','view_id','tag_type_id'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},
  {name:'revit_build_schematic',description:'Run recovered Argus connector graph, layout and drafting renderer from a selected pipe/duct element. Creates a new drafting view in the allowed document. Default rollback; commit only on user request. Does not save the model. Returns graph counts and created view id.',inputSchema:{type:'object',properties:{...common,start_element_id:{type:'integer',minimum:1},schematic_type:{type:'string',enum:['pipe','duct']}},required:['expected_document','start_element_id','schematic_type'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},
  ...NEW_WORKBENCH_TOOLS,
  ...NATIVE_MODEL_QUERY_TOOLS,
  ...NATIVE_PARAMETER_QUERY_TOOLS,
  ...MODELLING_TOOLS,
  ...NATIVE_SCHEMATIC_TOOLS,
  ...CAD_TOOLS,
  ...VISUAL_INSPECTION_TOOLS,
  ...FAMILY_TOOLS
];
function validateValue(rule,value,location){
  const invalid=()=>Object.assign(new Error('Invalid '+location),{code:'TOOL_ARGUMENT_INVALID',field:location});
  if(rule.anyOf){
    let matched=false;
    for(const candidate of rule.anyOf){try{value=validateValue(candidate,value,location);matched=true;break;}catch{}}
    if(!matched)throw invalid();
  }
  if(rule.enum&&!rule.enum.includes(value))throw invalid();
  if(rule.type==='string'){
    if(typeof value!=='string'||(rule.minLength!==undefined&&value.length<rule.minLength)||(rule.maxLength!==undefined&&value.length>rule.maxLength))throw invalid();
  }else if(rule.type==='number'||rule.type==='integer'){
    if(typeof value!=='number'||!Number.isFinite(value)||(rule.type==='integer'&&!Number.isSafeInteger(value))||(rule.minimum!==undefined&&value<rule.minimum)||(rule.maximum!==undefined&&value>rule.maximum)||(rule.exclusiveMinimum!==undefined&&value<=rule.exclusiveMinimum))throw invalid();
  }else if(rule.type==='boolean'){
    if(typeof value!=='boolean')throw invalid();
  }else if(rule.type==='array'){
    if(!Array.isArray(value)||(rule.minItems!==undefined&&value.length<rule.minItems)||(rule.maxItems!==undefined&&value.length>rule.maxItems))throw invalid();
    const entries=Array.from(value,(entry,index)=>validateValue(rule.items,entry,location+'['+index+']'));
    if(rule.uniqueItems&&new Set(entries.map(entry=>JSON.stringify(entry))).size!==entries.length)throw invalid();
    return entries;
  }else if(rule.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))throw invalid();
    const properties=rule.properties||{};
    for(const key of Object.keys(value))if(!Object.hasOwn(properties,key)&&rule.additionalProperties===false)throw Object.assign(new Error('Unknown argument: '+location+'.'+key),{code:'TOOL_ARGUMENT_UNKNOWN',field:location+'.'+key});
    for(const key of rule.required||[])if(!Object.hasOwn(value,key))throw Object.assign(new Error('Missing argument: '+location+'.'+key),{code:'TOOL_ARGUMENT_REQUIRED',field:location+'.'+key});
    const normalized={};
    for(const [key,property] of Object.entries(properties)){
      if(Object.hasOwn(value,key))normalized[key]=validateValue(property,value[key],location+'.'+key);
      else if(Object.hasOwn(property,'default'))normalized[key]=validateValue(property,property.default,location+'.'+key);
    }
    for(const key of Object.keys(value))if(!Object.hasOwn(properties,key)&&rule.additionalProperties!==false){normalized[key]=rule.additionalProperties===true||rule.additionalProperties===undefined?structuredClone(value[key]):validateValue(rule.additionalProperties,value[key],location+'.'+key);}
    return normalized;
  }
  return value;
}
// Composition may bind an omitted expected_document from its own verified
// document. All other required fields and the caller's supplied document are
// validated here before any preflight read. Publication always validates again
// without this omission allowance.
export function validateToolArguments(name,args,{allowDocumentBinding=false}={}){
  const tool=WORKBENCH_TOOLS.find(t=>t.name===name);
  if(!tool)throw new Error('Unknown workbench tool');
  const schema=allowDocumentBinding&&Object.hasOwn(tool.inputSchema.properties??{},'expected_document')?{...tool.inputSchema,required:(tool.inputSchema.required??[]).filter(key=>key!=='expected_document')}:tool.inputSchema;
  const normalized=validateValue(schema,args,'arguments');
  if(isNativeModelQuery(name))assertNativeModelQueryArguments(name,normalized);
  if(isNativeParameterQuery(name))assertNativeParameterQueryArguments(name,normalized);
  if(args.code&&Buffer.byteLength(args.code,'utf8')>64000)throw new Error('Code exceeds 64000 UTF-8 bytes');
  return normalized;
}
export function validateTool(name,args){
  const normalized=validateToolArguments(name,args);
  if(isNativeSchematicTool(name))assertNativeSchematicDocument(name,normalized);
  if(isCadTool(name))assertCadArguments(name,normalized);
  if(isFamilyTool(name))assertFamilyArguments(name,normalized);
  if(isVisualInspectionTool(name))assertVisualArguments(name,normalized);
  if(isModellingTool(name)){
    const code=compileModellingTool(name,normalized);
    if(!code||Buffer.byteLength(code,'utf8')>64000)throw new Error('Generated code exceeds the executor contract');
    return {operation:'execute_csharp',logical_tool:name,template_version:MODELLING_TEMPLATE_VERSION,args:{expected_document:normalized.expected_document,mode:normalized.mode,code}};
  }
  return {operation:NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL[name]??NATIVE_MODEL_QUERY_OPERATION_BY_TOOL[name]??FAMILY_OPERATION_BY_TOOL[name]??OPERATION_BY_TOOL[name],args:normalized};
}
const PANEL_COMMANDS=Object.freeze({
  document:Object.freeze({tool:'revit_workbench_status',operation:'status'}),
  selection:Object.freeze({tool:'revit_get_selection',operation:'get_selection'}),
  levels:Object.freeze({tool:'revit_list_levels',operation:'list_levels'}),
  search:Object.freeze({tool:'revit_search_elements',operation:'search_elements'})
});
export const READONLY_WORKBENCH_TOOL_NAMES=Object.freeze(Object.values(PANEL_COMMANDS).map(command=>command.tool));
export const ATOMIC_WORKBENCH_TOOL_NAMES=Object.freeze([...READONLY_WORKBENCH_TOOL_NAMES,'revit_list_family_types','revit_describe_parameters','revit_capture_model_snapshot',...NATIVE_MODEL_QUERY_NAMES,...NATIVE_PARAMETER_QUERY_NAMES]);
const READONLY_PANEL_TOOLS=new Set(ATOMIC_WORKBENCH_TOOL_NAMES);
// WorkbenchHost's JavaScriptSerializer allows 1 Mi UTF-16 code units. A valid
// UTF-8 encoding needs at most three bytes per code unit; reject before parse.
const READONLY_RESPONSE_MAX_CHARS=1024*1024,READONLY_RESPONSE_MAX_BYTES=3*READONLY_RESPONSE_MAX_CHARS;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
export const nativeRequestId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const RECEIPT_OWNER=Symbol('original-readonly-receipt-owner');
// Adapters consume the producing transport's facts; they must not reclassify a
// timeout from prose or drop the original receipt cleanup capability.
export function workbenchFailureEvidence(error){
  const requestId=nativeRequestId(error?.requestId)?error.requestId:null;
  return {outcome:error?.interruptedBeforeEnqueue===true?'not_started':error instanceof WorkbenchRequestFailure?error.outcome:'unconfirmed',
    ...(requestId?{requestIds:[requestId]}:{requestIds:[]}),
    ...(error?.nativeFailure?{nativeFailure:{...error.nativeFailure}}:{}),
    ...(error?.[RECEIPT_OWNER]?{receiptOwner:error[RECEIPT_OWNER]}:{}),
    ...(error?.unpublishedRequest?{unpublishedRequest:{...error.unpublishedRequest}}:{})};
}
function checkReadonlyControl(options){
  if(typeof options.shouldContinue==='function'&&options.shouldContinue()!==true){const error=new Error('命令已停止，尚未发送操作。');error.interruptedBeforeEnqueue=true;throw error;}
}
// The trusted panel owns selection of this policy. It is a transport binding,
// never a model/tool argument or a path-based grant supplied by the model.
export function nativeAccessPolicyBinding(value){
  if(value===undefined)return undefined;
  if(!plain(value)||Reflect.ownKeys(value).some(key=>typeof key!=='string'||!['id','revision','accountScope','mode','schemaVersion','roots'].includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'))||
    typeof value.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id)||!Number.isSafeInteger(value.revision)||value.revision<0||value.revision>2147483647||typeof value.accountScope!=='string'||value.accountScope.length<1||value.accountScope.length>512||/[\x00-\x1f\x7f]/.test(value.accountScope)||
    value.mode!==undefined&&!['read-only','project-write','full-access'].includes(value.mode)||value.schemaVersion!==undefined&&value.schemaVersion!==1)throw notQueued('访问策略身份无效，操作未入队。');
  return Object.freeze({id:value.id,revision:value.revision,accountScope:value.accountScope});
}
function missingWorkbench(message){const error=notQueued(message);error.code='COMMAND_HOST_UNAVAILABLE';return error;}
// Expected outcomes are established by the transport owner, never inferred by
// consumers from exception text. These types apply only to fixed read tools.
class WorkbenchRequestFailure extends Error{
  constructor(message,outcome,facts={}){super(message);this.code='WORKBENCH_REQUEST_FAILED';this.outcome=outcome;Object.assign(this,facts);}
}
const notQueued=(message,facts={})=>new WorkbenchRequestFailure('Revit request not queued: '+message,'not_started',{published:false,...facts});
const validCompletedUtc=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,19)===value.slice(0,19);
function nativeReadFailure(response,host,proof){
  const error=response.error;
  if(!plain(error)||typeof error.code!=='string'||!error.code||error.code.length>160||typeof error.message!=='string'||error.message.length>READONLY_RESPONSE_MAX_CHARS||!validCompletedUtc(response.completedUtc)||
    Object.hasOwn(error,'messageTruncated')&&typeof error.messageTruncated!=='boolean'||Object.hasOwn(error,'messageCharacters')&&(!Number.isSafeInteger(error.messageCharacters)||error.messageCharacters<error.message.length||error.messageCharacters>2147483647||error.messageTruncated!==true&&error.messageCharacters!==error.message.length))throw new Error('Invalid read-only failure receipt');
  let outcome='failed',phase='unknown',execution={};
  if(response.hostSession!==undefined&&response.hostSession!==host.sessionId)throw new Error('Failure receipt belongs to a different host');
  if(response.execution!==undefined){
    const value=response.execution;
    if(response.hostSession!==host.sessionId||!plain(value)||Object.keys(value).length!==3||typeof value.started!=='boolean'||!['validation','dispatch'].includes(value.phase)||value.started!==(value.phase==='dispatch')||![null,'expired'].includes(value.reason)||value.reason==='expired'&&(value.started||error.code!=='WORKBENCH_REQUEST_EXPIRED')||error.code==='WORKBENCH_REQUEST_EXPIRED'&&value.reason!=='expired')throw new Error('Invalid read-only execution facts');
    phase=value.phase;execution={started:value.started,reason:value.reason};outcome=value.started?'failed':value.reason==='expired'?'expired':'not_started';
  }else if(error.code==='WORKBENCH_REQUEST_EXPIRED')throw new Error('Expiry requires explicit execution facts');
  // Old hosts may return the complete compiler diagnostic. Bound the display
  // at this owning boundary without discarding independently valid completion
  // and execution facts; the original receipt/compile.log remain on disk.
  const message=error.message.slice(0,4096),truncated=error.messageTruncated===true||message.length!==error.message.length;
  const summary=truncated?{messageTruncated:true,...error.messageCharacters!==undefined||message.length!==error.message.length?{messageCharacters:error.messageCharacters??error.message.length}:{}}:{};
  const nativeFailure={code:error.code,message,...summary,outcome,phase,...execution,completedUtc:response.completedUtc,requestId:proof.requestId,...(response.hostSession!==undefined?{hostSession:response.hostSession}:{})};
  return new WorkbenchRequestFailure(error.code+': '+message,outcome,{...proof,published:true,nativeFailure});
}
function hostTimingFacts(response,host,id){
  if(response.timing===undefined)return {hostTimingState:'unavailable'};
  const t=response.timing,invalid={hostTimingState:'invalid'};
  if(!plain(t)||t.schemaVersion!==1||t.requestId!==id||t.hostSession!==host.sessionId||!['matched','unmatched'].includes(t.schedulerCorrelation))return invalid;
  for(const key of ['executeEnteredUtc','claimedUtc','responsePreparedUtc'])if(!validCompletedUtc(t[key]))return invalid;
  for(const key of ['observedUtc','raiseReturnedUtc','dispatchStartedUtc','dispatchFinishedUtc'])if(t[key]!==null&&!validCompletedUtc(t[key]))return invalid;
  for(const key of ['validationMs','hostWorkMs'])if(!Number.isFinite(t[key])||t[key]<0)return invalid;
  for(const key of ['observedToExecuteMs','dispatchMs'])if(t[key]!==null&&(!Number.isFinite(t[key])||t[key]<0))return invalid;
  if(t.hostWorkMs+0.000001<t.validationMs+(t.dispatchMs??0))return invalid;
  if(t.schedulerCorrelation==='matched'?(t.observedUtc===null||t.raiseReturnedUtc===null||t.observedToExecuteMs===null||!['Accepted','Pending'].includes(t.raiseResult)):(t.observedUtc!==null||t.raiseReturnedUtc!==null||t.observedToExecuteMs!==null||t.raiseResult!==null))return invalid;
  if(t.dispatchMs===null?(t.dispatchStartedUtc!==null||t.dispatchFinishedUtc!==null):(t.dispatchStartedUtc===null||t.dispatchFinishedUtc===null))return invalid;
  return {hostTimingState:'valid',hostSchedulerCorrelation:t.schedulerCorrelation,hostObservedUtc:t.observedUtc,hostExecuteEnteredUtc:t.executeEnteredUtc,hostClaimedUtc:t.claimedUtc,hostResponsePreparedUtc:t.responsePreparedUtc,hostObservedToExecuteMs:t.observedToExecuteMs,hostValidationMs:t.validationMs,hostDispatchMs:t.dispatchMs,hostWorkMs:t.hostWorkMs};
}
function readonlyEnvelope(text,host,id,operation,proof,observe){
  if(text.length>READONLY_RESPONSE_MAX_CHARS)throw new Error('Read-only response exceeds the host serializer budget');
  const response=JSON.parse(text);
  if(!plain(response)||response.id!==id||typeof response.ok!=='boolean'||response.ok&&(!plain(response.result)||response.result.hostSession!==host.sessionId))throw new Error('Invalid read-only response identity, completion flag or result');
  if(!response.ok){const failure=nativeReadFailure(response,host,proof);observe?.(response);throw failure;}
  if(operation==='status'?response.result.operation!==undefined&&response.result.operation!=='status':response.result.operation!==operation)throw new Error('Read-only response operation mismatch');
  observe?.(response);return response;
}
function interpretCabinetReceipt(text,host,id,name,operation,args){
  if(text.length>READONLY_RESPONSE_MAX_CHARS)throw new Error('Cabinet receipt exceeds serializer budget');
  const envelope=JSON.parse(text);
  if(!plain(envelope)||envelope.id!==id||typeof envelope.ok!=='boolean'||!validCompletedUtc(envelope.completedUtc))throw new Error('Invalid cabinet receipt envelope');
  if(!envelope.ok){
    if(envelope.hostSession!==host.sessionId)throw new Error('Cabinet failure receipt belongs to a different host');
    const failure=nativeReadFailure(envelope,host,{requestId:id,requestPhase:'response'});
    if(failure.nativeFailure?.started===false)return {status:failure.outcome,nativeFailure:failure.nativeFailure,message:'已核对原回执：该操作未进入执行。',terminal:true};
    return {status:'unconfirmed',message:'执行器异常，柜族或文件效果仍待核对。',terminal:false};
  }
  assertFamilyResult(name,envelope.result,host.sessionId);
  const value=envelope.result.value;
  if(value.operation!==operation||value.host_session!==host.sessionId||value.revit_pid!==host.pid||typeof value.success!=='boolean'||typeof value.code!=='string'||typeof value.outcome!=='string'||typeof value.cleanup_pending!=='boolean')throw new Error('Invalid cabinet business receipt identity');
  if(args.job_handle!==undefined&&value.job_handle!==null&&value.job_handle!==args.job_handle)throw new Error('Cabinet job identity mismatch');
  const bounded=(v,n)=>typeof v==='string'&&v.length<=n?v:null;
  const evidence={operation,success:value.success,code:bounded(value.code,160),outcome:bounded(value.outcome,160),jobHandle:bounded(value.job_handle,180),savePath:bounded(value.save?.path,2048),saveState:bounded(value.save?.state,160),savedVerified:value.save?.independently_reopened_verified===true,cleanupPending:value.cleanup_pending};
  const expectedSuccess={family_create_cabinet:'created_in_owned_family_document',family_save_cabinet:'file_persists_independently',family_close_cabinet:'closed'}[operation];
  const success=value.success&&value.outcome===expectedSuccess&&value.cleanup_pending===false&&typeof value.job_handle==='string'&&value.job_handle.length>0&&(operation!=='family_save_cabinet'||evidence.savedVerified&&evidence.savePath);
  const negative=!value.success&&!value.cleanup_pending&&['failed','failed_rolled_back','not_started'].includes(value.outcome);
  if(!success&&!negative)return {status:'unconfirmed',message:'收到原回执，但柜族或文件效果仍待核对。',evidence,terminal:false};
  return {status:success?'received':value.outcome==='not_started'?'not_started':'failed',message:success?'已核对原回执，请查看作业和文件结果后确认。':'已核对原回执，请查看作业及可能的文件效果后确认。',evidence,terminal:true};
}
const THIRD_PARTY_NOTICE='仅模型事务状态已核实；第三方组件可能产生的文件、网络或进程等事务外影响尚未核实，回滚不保证撤销这些影响。';
function thirdPartyResultValid(operation,value,args){
  if(!plain(value)||typeof value.engine!=='string'||!value.engine.trim()||value.engine.length>1024)return false;
  const nonnegative=v=>Number.isSafeInteger(v)&&v>=0;
  if(operation==='smart_annotate')return value.view_id===args.view_id&&Array.isArray(value.created_tag_ids)&&value.created_tag_ids.length<=50&&value.created_tag_ids.every(id=>Number.isSafeInteger(id)&&id>0)&&new Set(value.created_tag_ids).size===value.created_tag_ids.length&&value.count===value.created_tag_ids.length;
  if(operation==='build_schematic')return Number.isSafeInteger(value.view_id)&&value.view_id>0&&value.source_element_id===args.start_element_id&&['graph_nodes','graph_edges','drawn_elements','detail_lines','text_notes','detail_component_instances'].every(key=>nonnegative(value[key]));
  return false;
}
function interpretModelWriteReceipt(text,host,id,operation,args,source){
  if(text.length>READONLY_RESPONSE_MAX_CHARS)throw new Error('Model receipt exceeds serializer budget');
  const envelope=JSON.parse(text);
  if(!plain(envelope)||envelope.id!==id||typeof envelope.ok!=='boolean'||!validCompletedUtc(envelope.completedUtc))throw new Error('Invalid model receipt envelope');
  if(!envelope.ok){
    if(envelope.hostSession!==host.sessionId)throw new Error('Model failure receipt belongs to a different host');
    const failure=nativeReadFailure(envelope,host,{requestId:id,requestPhase:'response'});
    // The retained owner proves the exact published request; the native error
    // proves only these bounded host/request facts. A dispatch error alone
    // does not prove transaction rollback or absence of script side effects.
    const evidence={nativeFailure:failure.nativeFailure};
    if(failure.nativeFailure?.started===false)return {status:failure.outcome,evidence,message:'已核对原回执：操作未进入执行。',terminal:true};
    if(operation==='execute_csharp'&&failure.nativeFailure?.started===true){
      const transaction=envelope.transaction;
      // Only the native transaction-group owner publishes this receipt. Bind
      // every fact to the retained request rather than trusting an exception's
      // message, arbitrary Data, or the mere presence of a rollback marker.
      const rolledBack=plain(transaction)&&Object.keys(transaction).length===7&&transaction.schemaVersion===1&&transaction.operation===operation&&transaction.mode===args.mode&&
        plain(transaction.document)&&Object.keys(transaction.document).length===2&&transaction.document.path===source.path&&transaction.document.title===source.title&&
        transaction.scope==='transaction_group'&&transaction.status==='rolled_back'&&transaction.externalEffects==='unknown';
      const recovery={kind:'script_failure',requiresReview:!rolledBack,modelRollback:rolledBack?'rolled_back':'unknown',externalEffects:'unknown'};
      if(rolledBack)return {status:'failed_rolled_back',terminal:true,recovery,evidence:{...evidence,transaction:structuredClone(transaction)},message:'脚本执行报错，模型事务组已回滚；文件、网络等事务外影响仍未核实。'};
      return {status:'unconfirmed',terminal:false,recovery,evidence,message:'脚本已结束并报错，模型回滚仍未核实；请核查实际模型后确认继续。'};
    }
    return {status:'unconfirmed',evidence,message:'已收到执行器错误回执；操作效果和事务回滚仍需核对。',terminal:false};
  }
  const result=envelope.result,expectedCommit=args.mode==='commit';
  const thirdParty=operation==='smart_annotate'||operation==='build_schematic';
  if(hostTimingFacts(envelope,host,id).hostTimingState!=='valid'||!plain(result)||result.operation!==operation||result.mode!==args.mode||result.committed!==expectedCommit||result.document!==source.title||!Object.hasOwn(result,'value')||thirdParty&&!thirdPartyResultValid(operation,result.value,args))
    return {status:'unconfirmed',message:'收到回执，但宿主、操作、事务或文档身份不完整；请核对原回执。',terminal:false};
  if(operation==='set_parameters'){
    try{assertParameterWriteResult(result.value,args);}
    catch{return {status:'unconfirmed',message:'参数写入回执与原请求的身份、存储类型或回读值不一致；请核对原回执和实际模型。',terminal:false};}
  }
  // WorkbenchHost proves the expected path before executing, but the success
  // receipt returns only a document title. Do not present that path as an
  // independently observed response field.
  return {status:'received',terminal:true,message:thirdParty?THIRD_PARTY_NOTICE:'已核对原执行回执。',evidence:{operation,mode:result.mode,committed:result.committed,documentTitle:result.document,documentPathStatus:'requested_not_returned',...thirdParty?{externalEffects:'unknown'}:{}}};
}
function interpretVisualReceipt(text,host,id,name,args,root,source){
  const envelope=JSON.parse(text);
  if(!plain(envelope)||envelope.id!==id||typeof envelope.ok!=='boolean'||!validCompletedUtc(envelope.completedUtc))throw new Error('Invalid visual receipt envelope');
  if(!envelope.ok){
    const failure=nativeReadFailure(envelope,host,{requestId:id,requestPhase:'response'});
    return {status:failure.nativeFailure?.started===false?failure.outcome:'unconfirmed',terminal:failure.nativeFailure?.started===false,message:'视觉操作返回失败，请核对原回执及视图恢复状态。',nativeFailure:failure.nativeFailure};
  }
  if(hostTimingFacts(envelope,host,id).hostTimingState!=='valid')throw new Error('Visual receipt timing/host identity is incomplete');
  assertVisualResult(name,envelope.result,args,{hostSession:host.sessionId,requestId:id,root,sourceDocument:source});
  const body=envelope.result.value,restoration=body.restoration;
  return {status:body.success?'received':body.cleanup_pending?'unconfirmed':'failed',terminal:!body.cleanup_pending,message:body.cleanup_pending?'检查视图仍待恢复；请使用原会话句柄重试恢复，不要重复截图。':body.success?'已核对图片与源视图保留/检查视图清理回执。':'视觉检查未完成，但检查视图清理已核对。',evidence:{operation:body.operation,restorationStatus:restoration.status,sessionHandle:restoration.session_handle,sourceViewUnchanged:true,images:body.images.map(image=>({artifactId:image.artifact_id,sha256:image.sha256,bytes:image.bytes})),code:body.code,outcome:body.outcome}};
}
function familyLoadApproval(value,args){
  const validText=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\0\r\n]/.test(v);
  if(!plain(value)||Object.keys(value).some(key=>!['job_handle','project_handle','project_fingerprint','save'].includes(key))||
     !validText(value.job_handle,180)||value.job_handle!==args.job_handle||!validText(value.project_handle,256)||!validText(value.project_fingerprint,1024)||
     !plain(value.save)||Object.keys(value.save).some(key=>!['path','sha256'].includes(key))||!validText(value.save.path,2048)||!path.win32.isAbsolute(value.save.path)||path.win32.extname(value.save.path).toLowerCase()!=='.rfa'||
     typeof value.save.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.save.sha256))throw notQueued('族加载的已审批作业、项目或 RFA 身份无效；请求未入队。');
  return Object.freeze({job_handle:value.job_handle,project_handle:value.project_handle,project_fingerprint:value.project_fingerprint,save:Object.freeze({path:value.save.path,sha256:value.save.sha256})});
}
// New host protocol is explicitly negotiated and the token is supplied only
// by the trusted approval owner. The model's tool schema cannot carry it.
function familyLifecycleApproval(value,identity,args,operation){
  const str=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\0\r\n]/.test(v);
  const keys=(v,names)=>plain(v)&&Object.keys(v).length===names.length&&names.every(key=>Object.hasOwn(v,key));
  const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  if(!keys(value,['schema_version','operation','approval_token'])||value.schema_version!==1||value.operation!==operation||typeof value.approval_token!=='string'||!/^[a-f0-9]{32}$/.test(value.approval_token)||
     !keys(identity,['job_handle','project_handle','project_fingerprint','template','save'])||identity.job_handle!==args.job_handle||!str(identity.job_handle,180)||!str(identity.project_handle,256)||!str(identity.project_fingerprint,1024)||
     !keys(identity.template,['template_id','sha256'])||!str(identity.template.template_id,180)||!(identity.template.sha256===null||hex(identity.template.sha256))||
     !keys(identity.save,['attempted','state','path','sha256','independently_reopened_verified'])||typeof identity.save.attempted!=='boolean'||!str(identity.save.state,180)||!(identity.save.path===null||str(identity.save.path,2048)&&path.win32.isAbsolute(identity.save.path)&&path.win32.extname(identity.save.path).toLowerCase()==='.rfa')||!(identity.save.sha256===null||hex(identity.save.sha256))||typeof identity.save.independently_reopened_verified!=='boolean')
    throw notQueued('族作业审批快照无效；请求未入队。');
  if(operation==='family_save_job'&&(identity.save.attempted!==false||identity.save.state!=='not_started'||identity.save.path!==null||identity.save.sha256!==null||identity.save.independently_reopened_verified!==false))throw notQueued('族作业已保存或其保存状态未知；请求未入队。');
  return {wire:Object.freeze({schema_version:1,operation,approval_token:value.approval_token}),identity:Object.freeze({job_handle:identity.job_handle,project_handle:identity.project_handle,project_fingerprint:identity.project_fingerprint,template:Object.freeze({...identity.template}),save:Object.freeze({...identity.save})})};
}
function interpretFamilyLifecycleReceipt(text,host,id,operation,approved){
  if(text.length>READONLY_RESPONSE_MAX_CHARS)throw new Error('Family lifecycle receipt exceeds serializer budget');
  const envelope=JSON.parse(text);
  if(!plain(envelope)||envelope.id!==id||typeof envelope.ok!=='boolean'||!validCompletedUtc(envelope.completedUtc))throw new Error('Invalid family lifecycle receipt envelope');
  if(!envelope.ok){
    if(envelope.hostSession!==host.sessionId)throw new Error('Family failure receipt belongs to a different host');
    const failure=nativeReadFailure(envelope,host,{requestId:id,requestPhase:'response'});
    if(failure.nativeFailure?.started===false)return {status:failure.outcome,nativeFailure:failure.nativeFailure,message:'已核对原回执：族操作未进入执行。',terminal:true};
    return {status:'unconfirmed',message:'族操作执行失败后的文件或资源效果仍需核对。',terminal:false};
  }
  const result=envelope.result,body=result?.value,check=body?.approval_validation,expected=approved.identity,wire=approved.wire;
  const identity=hostTimingFacts(envelope,host,id).hostTimingState==='valid'&&plain(result)&&result.operation===operation&&result.hostSession===host.sessionId&&plain(body)&&body.operation===operation&&body.host_session===host.sessionId&&body.revit_pid===host.pid&&body.job_handle===expected.job_handle&&body.project_handle===expected.project_handle&&body.project_fingerprint===expected.project_fingerprint&&body.job_scope==='bound_project';
  const unknown=()=>({status:'unconfirmed',terminal:false,message:'族操作回执尚未完整核实；文件或临时族可能已变化，请勿自动重试。',...(identity?{evidence:{jobHandle:expected.job_handle}}:{})});
  if(!identity||!plain(check)||check.schema_version!==1||check.operation!==operation||check.approval_token!==wire.approval_token||typeof check.verified!=='boolean')return unknown();
  if(!check.verified){
    if(body.success===false&&body.code==='FAMILY_APPROVAL_STALE'&&body.outcome==='not_started')return {status:'not_started',terminal:true,message:'宿主确认审批已过期或作业已变化，本次未执行。',evidence:{jobHandle:expected.job_handle}};
    return unknown();
  }
  if(body.success!==true||body.core_registry_current!==true||body.cleanup_pending!==false||!plain(body.save)||!plain(body.effects)||body.effects.project_saved!==false)return unknown();
  if(operation==='family_save_job'){
    // Save requires the historical template binding; the host also verifies
    // current template bytes before saving. Close has no such dependency.
    if(!plain(body.template)||body.template.template_id!==expected.template.template_id||body.template.sha256!==expected.template.sha256)return unknown();
    if(body.code!=='FAMILY_RFA_VERIFIED'||body.outcome!=='file_persists_independently'||body.stage!=='Closed'||body.build_state!=='committed'||body.native_status?.family_transaction!=='Committed'||body.save.attempted!==true||body.save.state!=='saved_reopened_verified_closed'||typeof body.save.path!=='string'||!path.win32.isAbsolute(body.save.path)||path.win32.extname(body.save.path).toLowerCase()!=='.rfa'||typeof body.save.sha256!=='string'||!/^[a-f0-9]{64}$/.test(body.save.sha256)||!Number.isSafeInteger(body.save.bytes)||body.save.bytes<1||body.save.independently_reopened_verified!==true||body.effects.saved_file_may_persist!==true||!plain(body.value))return unknown();
    return {status:'received',terminal:true,message:'已核对原回执：族文件已保存并独立重开验证；项目未保存。',evidence:{operation,jobHandle:expected.job_handle,projectHandle:expected.project_handle,artifactPath:body.save.path,artifactSha256:body.save.sha256,artifactBytes:body.save.bytes,projectSaved:false}};
  }
  if(operation==='family_close_job'){
    if(!['FAMILY_CLOSED','FAMILY_CLOSED_NO_RESOURCE'].includes(body.code)||body.outcome!=='closed'||body.stage!=='Closed'||Object.keys(expected.save).some(key=>body.save[key]!==expected.save[key]))return unknown();
    return {status:'received',terminal:true,message:'已核对原回执：临时族已关闭；已有 RFA 保留。',evidence:{operation,jobHandle:expected.job_handle,projectHandle:expected.project_handle,artifactPath:body.save.path,artifactSha256:body.save.sha256,projectSaved:false}};
  }
  return unknown();
}
function interpretFamilyCreateReceipt(text,host,id,operation,args){
  if(text.length>READONLY_RESPONSE_MAX_CHARS)throw new Error('Family create receipt exceeds serializer budget');
  const envelope=JSON.parse(text);
  if(!plain(envelope)||envelope.id!==id||typeof envelope.ok!=='boolean'||!validCompletedUtc(envelope.completedUtc))throw new Error('Invalid family create receipt envelope');
  if(!envelope.ok){
    if(envelope.hostSession!==host.sessionId)throw new Error('Family failure receipt belongs to a different host');
    const failure=nativeReadFailure(envelope,host,{requestId:id,requestPhase:'response'});
    if(failure.nativeFailure?.started===false)return {status:failure.outcome,nativeFailure:failure.nativeFailure,message:'已核对原回执：族创建未进入执行。',terminal:true};
    return {status:'unconfirmed',message:'族创建执行失败，可能仍持有临时文档；请核对原作业。',terminal:false};
  }
  const result=envelope.result,body=result?.value;
  const validText=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\0\r\n]/.test(value);
  const identity=hostTimingFacts(envelope,host,id).hostTimingState==='valid'&&plain(result)&&result.operation===operation&&result.hostSession===host.sessionId&&plain(body)&&body.operation===operation&&body.host_session===host.sessionId&&body.revit_pid===host.pid;
  const jobHandle=identity&&validText(body.job_handle,180)?body.job_handle:null;
  const unknown=()=>({status:'unconfirmed',terminal:false,message:'族创建回执尚未完整核实；可能保留临时族，勿重复创建。',...(jobHandle?{evidence:{jobHandle}}:{})});
  if(!identity||body.success!==true||body.code!=='FAMILY_VALVE_CREATED'||body.outcome!=='created_in_owned_family_document'||!jobHandle||
     !validText(body.job_id,180)||!validText(body.project_handle,256)||!validText(body.project_fingerprint,1024)||body.job_scope!=='bound_project'||body.stage!=='Ready'||body.core_registry_current!==true||body.cleanup_pending!==false||body.build_state!=='committed'||
     !plain(body.template)||body.template.template_id!==args.template_id||body.template.state!=='BytesVerified'||body.template.issue!=='None'||typeof body.template.sha256!=='string'||!/^[a-f0-9]{64}$/.test(body.template.sha256)||
     !plain(body.native_status)||body.native_status.family_transaction!=='Committed'||!plain(body.save)||body.save.attempted!==false||body.save.state!=='not_started'||body.save.path!==null||
     !plain(body.effects)||body.effects.family_creation_attempted!==true||body.effects.owned_family_created!==true||body.effects.family_geometry_committed!==true||body.effects.saved_file_may_persist!==false||body.effects.project_saved!==false||body.effects.project_load!==null||
     !plain(body.value)||body.value.builder!=='BuildX.ParametricValve.v1'||body.value.family_document!==true||body.value.connector_count!==2||
     !plain(body.build_validation)||body.build_validation.parameterization_validated!==true||!Array.isArray(body.build_validation.type_validation)||body.build_validation.type_validation.length!==2)return unknown();
  const values=body.build_validation.type_validation,expected=[['BuildX_Valve_A',args.length_mm,args.diameter_mm],['BuildX_Valve_B',args.length_mm*1.25,args.diameter_mm*1.5]];
  if(!expected.every(([name,length,diameter],index)=>{const item=values[index];return plain(item)&&item.type_name===name&&item.passed===true&&item.regenerated_and_read_back===true&&typeof item.expected_length_mm==='number'&&Math.abs(item.expected_length_mm-length)<1e-7&&typeof item.expected_diameter_mm==='number'&&Math.abs(item.expected_diameter_mm-diameter)<1e-7;}))return unknown();
  return {status:'received',terminal:true,message:'已核对临时族创建回执；模板摘要是执行时核验值，族尚未保存或加载。',evidence:{operation,jobHandle,projectHandle:body.project_handle,projectFingerprint:body.project_fingerprint,templateId:body.template.template_id,templateSha256:body.template.sha256,templateApproval:'id_only',fileSaved:false,projectLoaded:false}};
}
function interpretFamilyLoadReceipt(text,host,id,operation,args,approved){
  if(text.length>READONLY_RESPONSE_MAX_CHARS)throw new Error('Family load receipt exceeds serializer budget');
  const envelope=JSON.parse(text);
  if(!plain(envelope)||envelope.id!==id||typeof envelope.ok!=='boolean'||!validCompletedUtc(envelope.completedUtc))throw new Error('Invalid family load receipt envelope');
  if(!envelope.ok){
    if(envelope.hostSession!==host.sessionId)throw new Error('Family failure receipt belongs to a different host');
    const failure=nativeReadFailure(envelope,host,{requestId:id,requestPhase:'response'});
    if(failure.nativeFailure?.started===false)return {status:failure.outcome,nativeFailure:failure.nativeFailure,message:'已核对原回执：族加载未进入执行。',terminal:true};
    return {status:'unconfirmed',message:'族加载执行失败后的项目和资源效果仍需核对。',terminal:false};
  }
  const result=envelope.result,body=result?.value,detail=body?.value,rollback=args.mode==='rollback',expectedGroup=rollback?'RolledBack':'Committed';
  const presence=detail?.independent_id_readback;
  const ids=Array.isArray(presence)?presence.map(item=>item?.id):[];
  const types=detail?.type_validation;
  const typesValid=Array.isArray(types)&&types.length===2&&types.every(item=>plain(item)&&['BuildX_Valve_A','BuildX_Valve_B'].includes(item.type_name)&&Number.isSafeInteger(item.type_id)&&item.type_id>0&&item.connector_count===2&&Array.isArray(item.connectors)&&item.connectors.length===2)&&new Set(types.map(item=>item.type_name)).size===2&&new Set(types.map(item=>item.type_id)).size===2;
  const isPresent=id=>presence?.some(item=>item.id===id&&item.exists===true);
  const presenceValid=Array.isArray(presence)&&presence.length>=5&&presence.every(item=>plain(item)&&Number.isSafeInteger(item.id)&&item.id>0&&typeof item.exists==='boolean')&&new Set(ids).size===ids.length&&Number.isSafeInteger(detail?.loaded_family_id)&&ids.includes(detail.loaded_family_id)&&typesValid&&
    (rollback?presence.every(item=>!item.exists):isPresent(detail.loaded_family_id)&&types.every(item=>isPresent(item.type_id))&&presence.filter(item=>!item.exists).length>=2);
  const countsValid=Number.isSafeInteger(detail?.family_count_before)&&detail.family_count_before>=0&&Number.isSafeInteger(detail?.family_count_after)&&detail.family_count_after>=0&&
    (rollback?detail.family_count_before===detail.family_count_after:detail.family_count_after>detail.family_count_before);
  if(hostTimingFacts(envelope,host,id).hostTimingState!=='valid'||!plain(result)||result.operation!==operation||result.hostSession!==host.sessionId||!plain(body)||
     body.operation!==operation||body.host_session!==host.sessionId||body.revit_pid!==host.pid||body.job_handle!==approved.job_handle||body.project_handle!==approved.project_handle||body.project_fingerprint!==approved.project_fingerprint||body.job_scope!=='bound_project'||
     body.success!==true||body.code!=='FAMILY_LOADED_AND_READ_BACK'||body.outcome!==(rollback?'rolled_back_verified':'family_committed_in_memory_not_saved')||body.cleanup_pending!==false||
     !plain(body.save)||body.save.path!==approved.save.path||body.save.sha256!==approved.save.sha256||body.save.independently_reopened_verified!==true||
     !plain(body.native_status)||body.native_status.project_transaction!=='Committed'||body.native_status.validation_subtransaction!=='RolledBack'||body.native_status.project_group!==expectedGroup||!plain(body.effects)||body.effects.project_saved!==false||!plain(detail)||detail.mode!==args.mode||detail.outcome!==(rollback?'rolled_back':'committed')||detail.project_saved!==false||detail.temporary_instances_rolled_back!==true||
     (rollback?detail.rollback_independently_verified!==true:detail.rollback_independently_verified!==null)||!presenceValid||!countsValid)
    return {status:'unconfirmed',terminal:false,message:'族加载原回执缺少匹配的作业、文件、项目或事务事实，请继续核对。'};
  return {status:'received',terminal:true,message:rollback?'已核对族加载预览及回滚回执。':'已核对族加载回执；项目文件未保存。',evidence:{operation,jobHandle:approved.job_handle,projectHandle:approved.project_handle,projectFingerprint:approved.project_fingerprint,artifactPath:approved.save.path,artifactSha256:approved.save.sha256,mode:args.mode,committed:!rollback,projectSaved:false}};
}
function supportsAtomicRead(host){
  const version=/^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(host?.version||'');
  return host?.atomicReadSnapshot===true&&version&&
    (Number(version[1])>0||Number(version[2])>6||Number(version[2])===6&&Number(version[3])>=4);
}
function supportsModelSnapshot(host){
  const version=/^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(host?.version||'');
  return Boolean(supportsAtomicRead(host)&&version&&(Number(version[1])>0||Number(version[2])>6||Number(version[2])===6&&Number(version[3])>=5));
}
function atomicReadResult(result,host,operation,args){
  if(!plain(result)||result.atomicReadSnapshot!==true||result.hostSession!==host.sessionId||result.operation!==operation||!plain(result.snapshot)||!plain(result.value))throw new Error('Invalid atomic read snapshot');
  const snapshot=result.snapshot,value=result.value;
  if(snapshot.hostSession!==host.sessionId||snapshot.capabilities?.atomicReadSnapshot!==true)throw new Error('Atomic read snapshot belongs to a different host');
  if(value.hostSession!==host.sessionId)throw new Error('Atomic query result belongs to a different host');
  if(operation==='status'){
    if(value.hostSession!==host.sessionId||JSON.stringify(value.document)!==JSON.stringify(snapshot.document))throw new Error('Atomic status snapshot does not match its result');
  }else{
    const nativeName=NATIVE_MODEL_QUERY_NAMES.find(name=>NATIVE_MODEL_QUERY_OPERATION_BY_TOOL[name]===operation)??NATIVE_PARAMETER_QUERY_NAMES.find(name=>NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL[name]===operation);
    if(nativeName){
      const supports=isNativeParameterQuery(nativeName)?supportsNativeParameterQueries:supportsNativeModelQueries;
      if(!supports(host,operation)||snapshot.hostVersion!==host.version||!supports({version:snapshot.hostVersion,...snapshot.capabilities},operation))throw new Error('Native query capability mismatch');
      (isNativeParameterQuery(nativeName)?assertNativeParameterQueryResult:assertNativeModelQueryResult)(nativeName,value.value,args);
      if(operation==='health'&&value.value.document_open!==(snapshot.document!==null))throw new Error('Native health and document snapshot disagree');
      if(operation==='get_document_info'&&(value.value.title!==value.document?.title||value.value.path!==value.document?.path))throw new Error('Native document facts and identity disagree');
    }
    if(value.operation!==operation)throw new Error('Atomic query operation mismatch');
    if(value.modifiedByOperation!==false){
      const fact=!Object.hasOwn(value,'modifiedByOperation')?'missing':value.modifiedByOperation===true?'true':value.modifiedByOperation===null?'null':'invalid';
      throw new Error(fact==='missing'?'Atomic query receipt missing modifiedByOperation:false':'Atomic query receipt modifiedByOperation:'+fact+'; expected false');
    }
    if(operation==='health'&&snapshot.document===null){
      if(value.document!==null)throw new Error('Atomic health document mismatch');
      if(Object.hasOwn(args,'expected_document'))throw new Error('Atomic health cannot preserve a caller-selected document when no document is open');
    }else{
      const observed=nativeName?{identity:workbenchDocumentIdentity(snapshot)}:statusView(snapshot);
      if(!sameWorkbenchDocumentIdentity(observed.identity,workbenchDocumentIdentity(value)))throw new Error('Atomic query and document snapshot do not match');
      if(Object.hasOwn(args,'expected_document')&&args.expected_document!==observed.identity.path)throw new Error('Atomic query did not preserve the caller-selected document');
    }
  }
  return {...value,snapshot};
}
async function readBoundedResponse(filename,maxBytes,message){
  const handle=await fs.open(filename,'r');
  try{
    // Bounded allocation/read even if a malformed response file grows after stat.
    const buffer=Buffer.alloc(maxBytes+1);let length=0;
    while(length<buffer.length){
      const {bytesRead}=await handle.read(buffer,length,buffer.length-length,null);
      if(bytesRead===0)break;length+=bytesRead;
    }
    if(length>maxBytes)throw new Error(message);
    return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length));
  }finally{await handle.close();}
}
export async function invokeWorkbench(name,args={},options={}){
  if(typeof options.onTiming!=='function'||!WORKBENCH_TOOLS.some(tool=>tool.name===name))return invokeWorkbenchRequest(name,args,options);
  const start=performance.now();let facts={},outcome='unconfirmed';
  const observe=data=>{facts={...facts,...data};try{options.onTiming({code:'phase_timing',source:'workbench',...facts,observedUtc:new Date().toISOString(),elapsedMs:performance.now()-start});}catch{/* Diagnostics do not change the business outcome. */}};
  try{const value=await invokeWorkbenchRequest(name,args,{...options,onTiming:observe});outcome='received';return value;}
  catch(error){if(error instanceof WorkbenchRequestFailure)outcome=error.outcome;throw error;}
  finally{observe({phase:'transport_finished',outcome});}
}
// Each observer owns an independent diagnostic sink. A failed journal cannot
// hide request progress, and a display observer cannot replace audit evidence.
export function combineWorkbenchTiming(...observers){
  const sinks=observers.filter(observer=>typeof observer==='function');
  return data=>{for(const observe of sinks)try{observe(data);}catch{/* Diagnostics never change execution. */}};
}
async function invokeWorkbenchRequest(name,args={},options={}){
  const accessPolicy=nativeAccessPolicyBinding(options.accessPolicy);
  const visual=isVisualInspectionTool(name),fixedRead=READONLY_PANEL_TOOLS.has(name),cabinetWrite=FAMILY_PANEL_CONFIRMATION_ONLY.includes(name),tracked=fixedRead||cabinetWrite||visual,atomic=options.atomicRead===true||isNamedNativeQuery(name);
  // Authorization may be revoked while the queue file is being prepared.
  // Guard writes too whenever the trusted caller provides a continuation check;
  // this is separate from receipt-owner support for fixed reads/cabinet jobs.
  const guarded=tracked||typeof options.shouldContinue==='function';
  const thirdParty=name==='revit_smart_annotate'||name==='revit_build_schematic';
  const modelWrite=!fixedRead&&!cabinetWrite&&(modelOperationEffect(name).kind==='model_transaction'||name==='revit_execute_csharp'||thirdParty);
  const keepWriteReceipt=modelWrite&&options.retainReceiptOwner===true&&plain(options.sourceDocument);
  const keepVisualReceipt=visual&&options.retainReceiptOwner===true&&plain(options.sourceDocument);
  if(visual&&options.retainReceiptOwner===true&&!keepVisualReceipt)throw notQueued('视觉操作缺少已绑定模型身份，未入队。');
  if(thirdParty&&options.retainReceiptOwner===true&&!keepWriteReceipt)throw notQueued('第三方模型操作缺少已审批模型身份；请求未入队。');
  const keepFamilyLoadReceipt=name==='revit_family_load_job'&&options.retainReceiptOwner===true&&plain(options.sourceDocument);
  const keepFamilyCreateReceipt=name==='revit_family_create_valve'&&options.retainReceiptOwner===true&&plain(options.sourceDocument);
  const lifecycleTool=name==='revit_family_save_job'||name==='revit_family_close_job';
  const lifecycleRequested=lifecycleTool&&options.approvedLifecycle!==undefined;
  const keepFamilyLifecycleReceipt=lifecycleRequested&&options.retainReceiptOwner===true&&plain(options.sourceDocument)&&typeof options.shouldContinue==='function';
  const requestLifecycleApproval=options.requestLifecycleApproval===true;
  if(requestLifecycleApproval&&(name!=='revit_family_inspect_job'||!plain(options.sourceDocument)||typeof options.shouldContinue!=='function'))throw notQueued('族作业审批读取缺少可信模型身份；请求未入队。');
  if(lifecycleRequested&&!keepFamilyLifecycleReceipt)throw notQueued('族作业缺少已审批的文档或原回执所有者；请求未入队。');
  if(name==='revit_family_load_job'&&options.retainReceiptOwner===true&&!keepFamilyLoadReceipt)throw notQueued('族加载缺少已审批模型身份；请求未入队。');
  if(name==='revit_family_create_valve'&&options.retainReceiptOwner===true&&!keepFamilyCreateReceipt)throw notQueued('族创建缺少已审批模型身份；请求未入队。');
  if(atomic&&!fixedRead)throw notQueued('Atomic snapshots are only available for the named read-only queries');
  const autoBind=atomic&&name!=='revit_workbench_status'&&name!=='revit_health'&&plain(args)&&!Object.hasOwn(args,'expected_document');
  let validated;
  try{validated=validateTool(name,autoBind?{...args,expected_document:''}:args);}
  catch(error){if(isNamedNativeQuery(name))throw notQueued(error.message);throw error;}
  const root=options.root||ROOT;
  if(visual)assertVisualArguments(name,validated.args,{allowCreationSource:false});
  const queue=path.join(root,'queue');
  let host;
  try {host=JSON.parse(await fs.readFile(path.join(queue,'host.json'),'utf8'));}
  catch{const message='Independent Revit workbench not loaded. Start Revit with the updated panel addin.';throw tracked?missingWorkbench(message):new Error(message);}
  if(!plain(host)||!/^[a-f0-9]{32}$/.test(host.sessionId)||!Number.isSafeInteger(host.pid)||host.pid<1)throw tracked?notQueued('Invalid workbench host identity'):new Error('Invalid workbench host identity');
  const accessVersion=/^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(host.version||'');
  const accessSupported=host.accessPolicyVersion===1&&accessVersion&&(Number(accessVersion[1])>0||Number(accessVersion[2])>=8);
  if(accessPolicy&&!accessSupported&&!fixedRead)throw notQueued('当前 Revit 宿主不支持统一访问权限，请加载 0.8.0 或更新插件；操作未入队。');
  if(visual&&host.visualInspectionVersion!==1)throw notQueued('当前 Revit 宿主未声明原生视觉检查能力；请加载 0.7.0 或更新独立插件，未发送操作。');
  if(requestLifecycleApproval&&(host.familyLifecycleApprovalVersion!==1||options.sourceDocument.session!==host.sessionId||typeof options.sourceDocument.path!=='string'||!options.sourceDocument.path))throw notQueued('族作业审批能力或模型身份未核实；请求未入队。');
  // Old hosts can support the original family workflow without supporting a
  // cabinet. Require an explicit host-owned capability before enqueueing;
  // a version string by itself cannot establish that this operation exists.
  if(FAMILY_PANEL_CONFIRMATION_ONLY.includes(name)&&host.familyCabinetContractVersion!==1)
    throw notQueued('当前 Revit 工作台未声明柜族能力；请求未入队。');
  if(keepFamilyLifecycleReceipt&&host.familyLifecycleApprovalVersion!==1)throw notQueued('当前 Revit 宿主尚未声明族作业逐次审批能力；请求未入队。');
  if(atomic&&!supportsAtomicRead(host))throw notQueued('This host does not advertise atomic read snapshots; no query was queued');
  requireNativeQueryCapability(name,host,validated.operation);
  // A multi-read command binds every later request to its initial status owner.
  // Checking only the returned DTO would allow a read in a replacement host.
  if(options.expectedHostSession!==undefined&&(!/^[a-f0-9]{32}$/.test(options.expectedHostSession)||host.sessionId!==options.expectedHostSession))throw notQueued('Revit host changed before enqueue; this operation was not queued.');
  if((keepWriteReceipt||keepVisualReceipt||keepFamilyLoadReceipt||keepFamilyCreateReceipt)&&(options.sourceDocument.session!==host.sessionId||typeof options.sourceDocument.title!=='string'||!options.sourceDocument.title||typeof options.sourceDocument.path!=='string'||!options.sourceDocument.path||validated.args.expected_document!==options.sourceDocument.path))throw notQueued('模型回执来源身份无法核实；请求未入队。');
  const approvedFamily=keepFamilyLoadReceipt?familyLoadApproval(options.approvedFamily,validated.args):null;
  if(keepFamilyLifecycleReceipt&&(options.sourceDocument.session!==host.sessionId||typeof options.sourceDocument.title!=='string'||!options.sourceDocument.title||typeof options.sourceDocument.path!=='string'||!options.sourceDocument.path||name==='revit_family_save_job'&&validated.args.expected_document!==options.sourceDocument.path))throw notQueued('族作业回执来源身份无法核实；请求未入队。');
  const approvedLifecycle=keepFamilyLifecycleReceipt?familyLifecycleApproval(options.approvedLifecycle,options.approvedFamilyIdentity,validated.args,validated.operation):null;
  if(options.expectedHostIdentity!==undefined){const expected=options.expectedHostIdentity;if(!plain(expected)||expected.sessionId!==host.sessionId||expected.pid!==host.pid||expected.version!==host.version||expected.startedUtc!==host.startedUtc)throw notQueued('Revit host identity changed before enqueue; this operation was not queued.');}
  try{process.kill(host.pid,0);}catch{const message='The recorded Revit host has exited. Start Revit and retry status.';throw tracked?missingWorkbench(message):new Error(message);}
  if(NEW_WORKBENCH_TOOLS.some(tool=>tool.name===name)||visual||isModellingTool(name)||isNativeSchematicTool(name)||isCadTool(name)||isFamilyTool(name)){
    const minimumMinor=visual?7:isFamilyTool(name)?6:isCadTool(name)?5:isNativeSchematicTool(name)?4:3;
    const version=/^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(host.version||'');
    if(!version||(Number(version[1])===0&&Number(version[2])<minimumMinor)){const message='此工具需要 Revit 工作台宿主 0.'+minimumMinor+'.0 或更新版本；请更新独立面板 DLL 并重启 Revit 后再试。当前请求未入队。';throw tracked?notQueued(message):new Error(message);}
  }
  // Revit can defer the first ExternalEvent for about 30 seconds while idle or
  // finishing a UI operation. Keep status within the MCP 180-second deadline.
  const id=randomUUID(), timeout=options.timeout??(name==='revit_workbench_status'?60000:150000);
  const observe=data=>{try{options.onTiming?.({requestId:id,hostSession:host.sessionId,operation:validated.operation,...data});}catch{}};
  observe({phase:'request_prepared'});
  const temp=path.join(queue,'inbox',id+'.tmp'), destination=path.join(queue,'inbox',id+'.json'),responsePath=path.join(queue,'outbox',id+'.json');
  let receiptOwner=null,cancellationPublished=false,cancellationDiagnostic=null;
  const cancelVisual=async force=>{
    if(!visual||cancellationPublished)return;
    let cancelled=force===true;
    if(!cancelled&&typeof options.shouldContinue==='function')try{cancelled=options.shouldContinue()!==true;}catch{cancelled=true;}
    if(!cancelled)return;
    const marker=path.join(queue,'cancel',id+'.json'),content=JSON.stringify({schema_version:1,request_id:id,target_session:host.sessionId});
    try{await fs.mkdir(path.dirname(marker),{recursive:true});await fs.writeFile(marker,content,{flag:'wx'});cancellationPublished=true;observe({phase:'cancellation_requested'});}
    catch(error){if(error.code==='EEXIST'){try{if(await fs.readFile(marker,'utf8')===content){cancellationPublished=true;return;}}catch{}}cancellationDiagnostic='Unable to publish cancellation for the original visual request.';}
  };
  const unconfirmed=(error,phase='response')=>{
    // Facts come from this exact request owner, including publication failures
    // where the temporary file or final queue delivery may remain unconfirmed.
    const result=new Error('Revit response outcome unknown (request '+id+'): '+(error?.message||'Invalid response')+'. Do not retry the operation automatically. Inspect '+responsePath+'.');
    result.requestId=id;result.responsePath=responsePath;result.requestPath=destination;result.temporaryRequestPath=temp;result.requestPhase=phase;if(receiptOwner)result[RECEIPT_OWNER]=receiptOwner;return result;
  };
  const requestArgs=isCadTool(name)?cadHostArguments(name,validated.args):{...validated.args};
  if(autoBind)delete requestArgs.expected_document;
  if(approvedLifecycle)requestArgs.approved_lifecycle=approvedLifecycle.wire;
  if(requestLifecycleApproval)requestArgs.request_lifecycle_approval=true;
  const request={id,targetSession:host.sessionId,...validated,args:requestArgs,...atomic?{atomicRead:true}:{},...accessPolicy&&accessSupported?{accessPolicy}:{},createdUtc:new Date().toISOString(),expiresUtc:new Date(Date.now()+timeout).toISOString()};
  const payload=JSON.stringify(request);
  if(Buffer.byteLength(payload,'utf8')>128*1024)throw tracked?notQueued('Workbench request exceeds the host 128 KiB contract; request was not queued'):new Error('Workbench request exceeds the host 128 KiB contract; request was not queued');
  if(guarded)checkReadonlyControl(options);
  let publicationAttempted=false;
  try{
    await fs.mkdir(path.join(queue,'inbox'),{recursive:true});
    if(guarded)checkReadonlyControl(options);
    await fs.writeFile(temp,payload,{flag:'wx'});
    observe({phase:'temp_ready'});
    if((tracked||keepWriteReceipt||keepFamilyLoadReceipt||keepFamilyCreateReceipt||keepFamilyLifecycleReceipt)&&options.retainReceiptOwner===true)receiptOwner=captureReadonlyReceiptOwner({queue,preparedPath:temp,request,payload,host,requireConfirmation:cabinetWrite||keepWriteReceipt||keepVisualReceipt||keepFamilyLoadReceipt||keepFamilyCreateReceipt||keepFamilyLifecycleReceipt,interpret:text=>{
      if(cabinetWrite)return interpretCabinetReceipt(text,host,id,name,validated.operation,requestArgs);
      if(keepVisualReceipt)return interpretVisualReceipt(text,host,id,name,requestArgs,root,options.sourceDocument);
      if(keepWriteReceipt)return interpretModelWriteReceipt(text,host,id,validated.operation,requestArgs,options.sourceDocument);
      if(keepFamilyLoadReceipt)return interpretFamilyLoadReceipt(text,host,id,validated.operation,requestArgs,approvedFamily);
      if(keepFamilyCreateReceipt)return interpretFamilyCreateReceipt(text,host,id,validated.operation,requestArgs);
      if(keepFamilyLifecycleReceipt)return interpretFamilyLifecycleReceipt(text,host,id,validated.operation,approvedLifecycle);
      try{const response=readonlyEnvelope(text,host,id,validated.operation,{requestId:id,requestPhase:'response'},response=>observe({phase:'late_receipt_received',...hostTimingFacts(response,host,id)}));if(atomic)atomicReadResult(response.result,host,validated.operation,requestArgs);return {status:'received',terminal:true,message:'已收到成功回执；整条命令仍缺完整核对，未继续执行查询。'};}
      catch(error){if(!(error instanceof WorkbenchRequestFailure))throw error;return {status:error.outcome,terminal:['expired','not_started','failed'].includes(error.outcome),nativeFailure:{...error.nativeFailure},message:error.outcome==='expired'?'已核对：请求过期，本次查询未执行。':error.outcome==='not_started'?'已核对：本次查询未执行。':'已核对：Revit 返回明确失败回执。'};}
    }});
    if((cabinetWrite||keepWriteReceipt||keepVisualReceipt||keepFamilyLoadReceipt||keepFamilyCreateReceipt||keepFamilyLifecycleReceipt)&&!receiptOwner)throw notQueued('无法保留原回执，未发布操作。',{unpublishedRequest:{requestId:id,tempPath:temp,requestPath:destination,responsePath}});
    if(keepVisualReceipt&&name!=='revit_restore_visual_session')receiptOwner=createVisualRecoveryOwner({receiptOwner,failureEvidence:workbenchFailureEvidence,restore:session_handle=>invokeWorkbench('revit_restore_visual_session',{expected_document:requestArgs.expected_document,session_handle},{root,expectedHostSession:host.sessionId,expectedHostIdentity:{sessionId:host.sessionId,pid:host.pid,version:host.version,startedUtc:host.startedUtc},sourceDocument:options.sourceDocument,retainReceiptOwner:true,shouldContinue:()=>true,timeout:options.timeout??150000,onTiming:options.onTiming})});
    if(guarded){
      try{checkReadonlyControl(options);}catch(error){
        // The host consumes only .json. Keep this completed .tmp as evidence;
        // a pathname alone is not authority to delete or adopt its current file.
        error.unpublishedRequest={requestId:id,tempPath:temp,requestPath:destination,responsePath};throw error;
      }
    }
    publicationAttempted=true;await fs.rename(temp,destination);
    observe({phase:'published'});
  }catch(error){
    if(!guarded||error.interruptedBeforeEnqueue)throw error;
    if(error instanceof WorkbenchRequestFailure)throw error;
    if(publicationAttempted)throw unconfirmed(error,'publication');
    throw notQueued(error?.message||'Request preparation failed',{requestPhase:'prepublication',unpublishedRequest:{requestId:id,tempPath:temp,requestPath:destination,responsePath}});
  }
  const end=Date.now()+timeout;
  while(Date.now()<end){
    await cancelVisual(false);
    if(isNamedNativeQuery(name)&&typeof options.shouldContinue==='function'){
      let continued=false;try{continued=options.shouldContinue()===true;}catch{}
      if(!continued)throw unconfirmed(new Error('查询已发布后取消，请核对原请求回执。'));
    }
    try{
      const text=isCadTool(name)?await readBoundedResponse(responsePath,CAD_RESPONSE_MAX_BYTES,'CAD response exceeds the 128 KiB transport budget'):(tracked||keepWriteReceipt||keepFamilyLoadReceipt||keepFamilyCreateReceipt||keepFamilyLifecycleReceipt)?await readBoundedResponse(responsePath,READONLY_RESPONSE_MAX_BYTES,'Response exceeds the host transport budget'):await fs.readFile(responsePath,'utf8');
      const response=fixedRead?readonlyEnvelope(text,host,id,validated.operation,{requestId:id,responsePath,requestPath:destination,temporaryRequestPath:temp,requestPhase:'response'},typeof options.onTiming==='function'?response=>observe({phase:'receipt_received',...hostTimingFacts(response,host,id)}):undefined):JSON.parse(text);
      if(isNamedNativeQuery(name)&&typeof options.shouldContinue==='function'){
        let continued=false;try{continued=options.shouldContinue()===true;}catch{}
        if(!continued)throw unconfirmed(new Error('查询回执到达时已取消，请核对原请求回执。'));
      }
      if((visual||isNativeSchematicTool(name)||isCadTool(name)||isFamilyTool(name))&&(response.id!==id||typeof response.ok!=='boolean'))
        throw new Error('Revit response outcome unknown (request '+id+'): invalid response identity or completion flag. Do not retry the operation automatically.');
      if(response.id!==id)throw new Error('Response identity mismatch');
      if(!fixedRead&&typeof response.ok==='boolean'&&typeof options.onTiming==='function')observe({phase:'receipt_received',...hostTimingFacts(response,host,id)});
      if(!response.ok){if(cabinetWrite)throw unconfirmed(new Error('Revit host returned a failure envelope; inspect original receipt'));if(visual){const failure=nativeReadFailure(response,host,{requestId:id,responsePath,requestPath:destination,temporaryRequestPath:temp,requestPhase:'response'});if(receiptOwner)failure[RECEIPT_OWNER]=receiptOwner;throw failure;}throw fixedRead?nativeReadFailure(response,host,{requestId:id,responsePath,requestPath:destination,temporaryRequestPath:temp,requestPhase:'response'}):new Error((response.error?.code||'RevitError')+': '+(response.error?.message||'Operation failed'));}
      if(visual){
        assertVisualResult(name,response.result,requestArgs,{hostSession:host.sessionId,requestId:id,root,sourceDocument:options.sourceDocument});
        if(keepVisualReceipt)interpretVisualReceipt(text,host,id,name,requestArgs,root,options.sourceDocument);
      }
      if(keepWriteReceipt){const checked=interpretModelWriteReceipt(text,host,id,validated.operation,requestArgs,options.sourceDocument);if(checked.status!=='received'||checked.terminal!==true)throw unconfirmed(new Error('Model outcome identity is not fully established'));}
      if(name==='revit_set_parameters'&&!keepWriteReceipt){
        try{assertParameterWriteResult(response.result?.value,requestArgs);}
        catch(error){throw unconfirmed(error);}
      }
      if(keepFamilyLoadReceipt){const checked=interpretFamilyLoadReceipt(text,host,id,validated.operation,requestArgs,approvedFamily);if(checked.status!=='received'||checked.terminal!==true)throw unconfirmed(new Error('Family load outcome identity is not fully established'));}
      if(keepFamilyCreateReceipt){const checked=interpretFamilyCreateReceipt(text,host,id,validated.operation,requestArgs);if(checked.status!=='received'||checked.terminal!==true)throw unconfirmed(new Error('Family creation outcome identity is not fully established'));}
      if(keepFamilyLifecycleReceipt){const checked=interpretFamilyLifecycleReceipt(text,host,id,validated.operation,approvedLifecycle);if(checked.status!=='received'||checked.terminal!==true)throw unconfirmed(new Error('Family lifecycle outcome identity is not fully established'));}
      // Keep the host's real operation/mode/committed evidence; logical_tool is
      // client-side provenance, not a claim that the host implements a new API.
      if(isNativeSchematicTool(name)){
        try{assertNativeSchematicResult(name,response.result,validated.args,validateValue);}
        catch(error){throw new Error('Revit response outcome unknown (request '+id+'): '+error.message+'. Do not retry the operation automatically. Inspect workbench/queue/outbox/'+id+'.json.');}
      }
      if(isCadTool(name)){
        try{return {...projectCadResult(name,response.result,validated.args,{sessionId:host.sessionId,responsePath}),request_id:id};}
        catch(error){throw new Error('CAD read response rejected (request '+id+'): '+error.message+'. Inspect '+responsePath);}
      }
      if(isFamilyTool(name))assertFamilyResult(name,response.result,host.sessionId);
      if(cabinetWrite){const checked=interpretCabinetReceipt(text,host,id,name,validated.operation,requestArgs);if(response.result.value.success===true&&checked.status!=='received')throw new Error('Cabinet business outcome remains unconfirmed');}
      let value=atomic?atomicReadResult(response.result,host,validated.operation,requestArgs):response.result;
      if(keepFamilyLifecycleReceipt){
        // The raw receipt owner retains the exact host response. A consumed
        // capability must not flow onward into the model-visible result.
        const {approval_token: _consumedToken,...validation}=value.value.approval_validation;
        value={...value,value:{...value.value,approval_validation:validation}};
      }
      const output={...value,...(validated.logical_tool?{logical_tool:validated.logical_tool,template_version:validated.template_version}:{}),request_id:id};
      if(thirdParty&&keepWriteReceipt)output.effectEvidence={modelTransaction:validated.args.mode,externalEffects:'unknown',notice:THIRD_PARTY_NOTICE};
      if((fixedRead||cabinetWrite||keepWriteReceipt||keepVisualReceipt||keepFamilyLoadReceipt||keepFamilyCreateReceipt||keepFamilyLifecycleReceipt)&&receiptOwner)Object.defineProperty(output,'receiptOwner',{value:receiptOwner,enumerable:false});
      return output;
    }catch(error){if(error instanceof WorkbenchRequestFailure||error?.[RECEIPT_OWNER])throw error;if(error.code!=='ENOENT')throw guarded?unconfirmed(error):error;}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  await cancelVisual(true);
  const error=new Error(`Revit response timeout; outcome unknown (request ${id}). Do not retry the operation automatically. Inspect workbench/queue/outbox/${id}.json. An expired unstarted request will not execute.`);
  if(guarded){error.requestId=id;error.responsePath=responsePath;error.requestPath=destination;error.temporaryRequestPath=temp;error.requestPhase='response';if(cancellationDiagnostic)error.cancellationDiagnostic=cancellationDiagnostic;if(receiptOwner)error[RECEIPT_OWNER]=receiptOwner;}throw error;
}

const PANEL_CATEGORIES=Object.freeze({all:'',walls:'OST_Walls',pipes:'OST_PipeCurves',equipment:'OST_MechanicalEquipment'});
const PANEL_SEARCH_SCHEMA={type:'object',additionalProperties:false,properties:{
  keyword:{type:'string',maxLength:200,default:''},
  category:{type:'string',enum:Object.keys(PANEL_CATEGORIES),default:'all'},
  limit:{type:'integer',minimum:1,maximum:200,default:20},
  offset:{type:'integer',minimum:0,maximum:2147483647,default:0}
}};
export function readonlyPanelCommandSchema(id){
  if(!Object.hasOwn(PANEL_COMMANDS,id))throw new Error('Unknown fixed panel command');
  return structuredClone(id==='search'?PANEL_SEARCH_SCHEMA:{type:'object',properties:{},additionalProperties:false});
}
function panelParameters(command,parameters){
  if(typeof command!=='string'||!Object.hasOwn(PANEL_COMMANDS,command))throw new Error('请选择固定的只读命令。');
  if(!plain(parameters)||Reflect.ownKeys(parameters).some(key=>typeof key!=='string'||!Object.hasOwn(Object.getOwnPropertyDescriptor(parameters,key),'value')))throw new Error('命令参数必须是普通数据对象。');
  if(command!=='search'){
    if(Reflect.ownKeys(parameters).length)throw new Error('此命令不接收参数。');
    return {};
  }
  if(Reflect.ownKeys(parameters).some(key=>!Object.hasOwn(PANEL_SEARCH_SCHEMA.properties,key)))throw new Error('命令包含未知参数。');
  const normalized=validateValue(PANEL_SEARCH_SCHEMA,parameters,'command parameters');
  normalized.keyword=normalized.keyword.trim();return normalized;
}
function signedNativeId(value){
  if(typeof value==='number'&&Number.isSafeInteger(value))return String(value);
  if(typeof value==='string'&&/^(?:0|-?[1-9]\d{0,18})$/.test(value)){const number=BigInt(value);if(number>=-9223372036854775808n&&number<=9223372036854775807n)return value;}
  throw new Error('查询结果包含无法精确保留的原生 ID。');
}
function nullableText(value){if(value===null||typeof value==='string')return value;throw new Error('查询结果的文本字段无效。');}
function elementDescription(value){
  if(!plain(value)||typeof value.name!=='string'||typeof value.class_name!=='string'||typeof value.is_type!=='boolean')throw new Error('构件信息格式无效。');
  return {element_id:workbenchElementIdString(value.element_id),name:value.name,class_name:value.class_name,
    category:nullableText(value.category),category_id:value.category_id===null?null:signedNativeId(value.category_id),
    type_id:signedNativeId(value.type_id),level_id:signedNativeId(value.level_id),family_name:nullableText(value.family_name),is_type:value.is_type};
}
function uniqueItems(items,project){
  const result=items.map(project);
  if(new Set(result.map(item=>item.element_id)).size!==result.length)throw new Error('查询结果包含重复元素 ID。');
  return result;
}
function statusView(value){
  if(value.operation!==undefined&&value.operation!=='status')throw new Error('工作台状态回执的操作不匹配。');
  const identity=workbenchDocumentIdentity(value),document=value.document;
  if(typeof document.activeViewType!=='string'||!document.activeViewType)throw new Error('工作台未返回可核对的当前视图。');
  const activeView={id:workbenchElementIdString(document.activeViewId),type:document.activeViewType};
  for(const key of ['allowedSample','modified'])if(document[key]!==undefined&&typeof document[key]!=='boolean')throw new Error('工作台文档状态格式无效。');
  return {identity,document:{title:identity.title,path:identity.path},activeView,
    ...(document.allowedSample!==undefined?{allowedSample:document.allowedSample}:{}),...(document.modified!==undefined?{modified:document.modified}:{})};
}
// Both manual commands and MCP consume this application-level read owner. A
// capable host binds identity and reads once on its UI thread. Older hosts keep
// the existing before/read/after checks, rather than silently weakening them.
export async function invokeAtomicWorkbenchRead(name,args={},options={}){
  if(!READONLY_PANEL_TOOLS.has(name))throw notQueued('Unknown named read-only query');
  if(!plain(args))throw notQueued('Read parameters must be a plain data object');
  const host=await fs.readFile(path.join(options.root||ROOT,'queue','host.json'),'utf8').then(JSON.parse).catch(()=>null);
  requireNativeQueryCapability(name,host,NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL[name]??NATIVE_MODEL_QUERY_OPERATION_BY_TOOL[name]);
  if(name==='revit_capture_model_snapshot'&&!supportsModelSnapshot(host))throw notQueued('Model snapshots require an updated atomic-capable host; no capture was queued.');
  if(supportsAtomicRead(host))return invokeWorkbench(name,args,{...options,atomicRead:true});
  checkReadonlyControl(options);
  const first=await invokeWorkbench('revit_workbench_status',{},options);
  if(name==='revit_workbench_status')return {...first,snapshot:{...first},request_ids:[first.request_id]};
  if(first.document===null)throw notQueued('No active Revit document');
  const before=statusView(first);
  if(Object.hasOwn(args,'expected_document')&&args.expected_document!==before.identity.path)throw notQueued('The caller-selected document is no longer active');
  checkReadonlyControl(options);
  const value=await invokeWorkbench(name,{...args,expected_document:before.identity.path},{...options,expectedHostSession:before.identity.session});
  if(!sameWorkbenchDocumentIdentity(before.identity,workbenchDocumentIdentity(value)))throw new Error('Read result belongs to another document or host');
  checkReadonlyControl(options);
  const last=await invokeWorkbench('revit_workbench_status',{},{...options,expectedHostSession:before.identity.session});
  const after=statusView(last);
  if(!sameWorkbenchDocumentIdentity(before.identity,after.identity)||before.activeView.id!==after.activeView.id||before.activeView.type!==after.activeView.type)throw new Error('Document or view changed during the read; result is unconfirmed');
  return {...value,snapshot:last,request_ids:[first.request_id,value.request_id,last.request_id]};
}
function panelReadData(command,result,parameters){
  const value=result.value;
  if(!plain(value)||!Array.isArray(value.items))throw new Error('只读查询未返回有效的结果列表。');
  // WorkbenchHost.FreezeResult enforces this producer budget before returning
  // any of these three values. Do not slice an oversized list into fake coverage.
  if(JSON.stringify(value).length>250000)throw new Error('只读查询超过宿主结果预算，未发布不完整结果。');
  if(command==='selection'){
    if(!Number.isSafeInteger(value.total)||value.total<0||!Number.isSafeInteger(value.returned)||value.returned<0||value.returned>200||value.total<value.returned||value.items.length!==value.returned||typeof value.truncated!=='boolean'||value.truncated!==(value.total>value.returned))throw new Error('选择结果覆盖范围无效。');
    return {total:value.total,returned:value.returned,truncated:value.truncated,items:uniqueItems(value.items,elementDescription)};
  }
  if(command==='search'){
    if(!Number.isSafeInteger(value.total)||value.total<0||value.offset!==parameters.offset||value.limit!==parameters.limit||typeof value.has_more!=='boolean'||value.items.length!==Math.min(parameters.limit,Math.max(0,value.total-parameters.offset))||value.has_more!==(parameters.offset+parameters.limit<value.total))throw new Error('构件查询的分页或覆盖范围无效。');
    return {query:{keyword:parameters.keyword,category:parameters.category,builtInCategory:PANEL_CATEGORIES[parameters.category]},
      total:value.total,offset:value.offset,limit:value.limit,returned:value.items.length,has_more:value.has_more,items:uniqueItems(value.items,elementDescription)};
  }
  const items=uniqueItems(value.items,item=>{
    if(!plain(item)||typeof item.name!=='string'||!Number.isFinite(item.elevation_mm)||!Number.isFinite(item.project_elevation_mm))throw new Error('标高结果的名称或高程无效。');
    return {element_id:workbenchElementIdString(item.element_id),name:item.name,elevation_mm:item.elevation_mm,project_elevation_mm:item.project_elevation_mm};
  });
  return {units:'mm',total:items.length,returned:items.length,truncated:false,items};
}

// Fixed, local read intents only. The caller's trusted options select the
// existing transport root; browser parameters can never select tools or paths.
export async function invokeReadonlyPanelCommand(command,parameters={},options={}){
  let chosen,definition,source=null;const requestIds=[];
  const failure=(code,message,stage,outcome)=>({ok:false,error:{code,message,stage,outcome},evidence:{requestIds:[...requestIds],tool:definition?.tool??null}});
  try{
    chosen=panelParameters(command,parameters);definition=PANEL_COMMANDS[command];
    if(options.sourceDocument!==undefined){
      const value=options.sourceDocument;
      if(!plain(value)||Reflect.ownKeys(value).length!==3||['session','title','path'].some(key=>{
        const entry=Object.getOwnPropertyDescriptor(value,key);
        return !entry||!Object.hasOwn(entry,'value')||typeof entry.value!=='string'||key==='session'&&!entry.value;
      }))throw new Error('参数来源文档无效，请重新读取。');
      source={session:value.session,title:value.title,path:value.path};
      if(options.expectedHostSession!==undefined&&options.expectedHostSession!==source.session)throw new Error('参数来源宿主与调用者选择的宿主不一致。');
    }
    validateTool('revit_workbench_status',{});
    if(command!=='document')validateTool(definition.tool,{expected_document:'',...(command==='search'?{name_contains:chosen.keyword,category:PANEL_CATEGORIES[chosen.category],limit:chosen.limit,offset:chosen.offset}:{})});
  }catch(error){return failure('COMMAND_INPUT_INVALID',error?.message||'命令参数无效。','input','not_started');}
  let stage='preflight',boundHostSession=null,businessReadConfirmed=false;
  const invoke=async(tool,args)=>{
    checkReadonlyControl(options);
    const result=await invokeWorkbench(tool,args,{...options,retainReceiptOwner:true,...(boundHostSession||source?.session?{expectedHostSession:boundHostSession||source.session}:{})});
    if(!plain(result)||!nativeRequestId(result.request_id)||requestIds.includes(result.request_id))throw new Error('只读调用未返回可核对的原生请求回执。');
    requestIds.push(result.request_id);return result;
  };
  try{
    const host=await fs.readFile(path.join(options.root||ROOT,'queue','host.json'),'utf8').then(JSON.parse).catch(()=>null);
    if(supportsAtomicRead(host)){
      stage='read';
      const result=await invokeAtomicWorkbenchRead(definition.tool,{...(source&&command!=='document'?{expected_document:source.path}:{}),...(command==='search'?{name_contains:chosen.keyword,category:PANEL_CATEGORIES[chosen.category],limit:chosen.limit,offset:chosen.offset}:{})},{...options,retainReceiptOwner:true,...source?{expectedHostSession:source.session}:{}});
      requestIds.push(result.request_id);
      if(result.snapshot.document===null)return failure('COMMAND_NO_DOCUMENT','请先在 Revit 中打开模型。',stage,'not_started');
      const observed=statusView(result.snapshot);
      if(source&&!sameWorkbenchDocumentIdentity(source,observed.identity))throw new Error('已收到查询回执，但来源文档或宿主已变化；结果尚未确认。');
      if(typeof options.shouldContinue==='function'&&options.shouldContinue()!==true)return failure('COMMAND_READ_UNCONFIRMED','查询已经返回，但本次命令已停止；请核对原回执。',stage,'unconfirmed');
      const data=command==='document'?{activeView:observed.activeView,...(observed.allowedSample!==undefined?{allowedSample:observed.allowedSample}:{}),...(observed.modified!==undefined?{modified:observed.modified}:{}),coverage:{kind:'current-document-and-view',complete:true}}:panelReadData(command,result,chosen);
      return {ok:true,value:{command,tool:definition.tool,operation:definition.operation,hostSession:observed.identity.session,document:observed.document,requestIds:[...requestIds],data}};
    }
    const first=await invoke('revit_workbench_status',{});
    if(first.document===null)return failure('COMMAND_NO_DOCUMENT','请先在 Revit 中打开模型。',stage,'not_started');
    const before=statusView(first);boundHostSession=before.identity.session;
    if(source&&!sameWorkbenchDocumentIdentity(source,before.identity)){
      if(command==='document')throw new Error('已读取当前模型概况，但来源文档已变化；结果尚未确认。');
      return failure('COMMAND_INPUT_INVALID','当前模型与参数来源文档不一致，未发送业务查询，请重新读取。',stage,'not_started');
    }
    let data;
    if(command!=='document'){
      stage='read';
      const result=await invoke(definition.tool,{expected_document:before.identity.path,...(command==='search'?{name_contains:chosen.keyword,category:PANEL_CATEGORIES[chosen.category],limit:chosen.limit,offset:chosen.offset}:{})});
      if(result.operation!==definition.operation||!sameWorkbenchDocumentIdentity(before.identity,workbenchDocumentIdentity(result)))throw new Error('读取结果的操作、文档或 Revit 会话已变化，结果未发布。');
      data=panelReadData(command,result,chosen);
      businessReadConfirmed=true;
    }
    stage='postflight';
    const last=await invoke('revit_workbench_status',{}),after=statusView(last);
    if(!sameWorkbenchDocumentIdentity(before.identity,after.identity)||before.activeView.id!==after.activeView.id||before.activeView.type!==after.activeView.type)throw new Error('读取前后当前文档、视图或 Revit 会话已变化，结果未发布。');
    if(command==='document')data={activeView:after.activeView,...(after.allowedSample!==undefined?{allowedSample:after.allowedSample}:{}),...(after.modified!==undefined?{modified:after.modified}:{}),coverage:{kind:'current-document-and-view',complete:true}};
    return {ok:true,value:{command,tool:definition.tool,operation:definition.operation,hostSession:after.identity.session,document:after.document,requestIds:[...requestIds],data}};
  }catch(error){
    if(error?.interruptedBeforeEnqueue===true){
      const result=stage!=='postflight'&&!businessReadConfirmed?failure('COMMAND_INTERRUPTED','命令已停止，未发送下一项查询。',stage,'not_started'):failure('COMMAND_READ_UNCONFIRMED','已收到查询回执；停止后未继续核对文档，结果尚未确认。',stage,'unconfirmed');
      if(error.unpublishedRequest)result.evidence.unpublishedRequest={...error.unpublishedRequest};
      return result;
    }
    if(stage==='preflight'&&requestIds.length===0&&error?.code==='COMMAND_HOST_UNAVAILABLE'){
      const result=failure('COMMAND_HOST_UNAVAILABLE','本地 Revit 执行器不可用，请确认已在 Revit 中打开 BuildX。',stage,'not_started');result.evidence.diagnostic=error.message;return result;
    }
    if(error instanceof WorkbenchRequestFailure){
      if(error.published!==false&&nativeRequestId(error.requestId)&&!requestIds.includes(error.requestId))requestIds.push(error.requestId);
      const outcome=stage==='postflight'?'unconfirmed':error.outcome;
      const codes={not_started:'COMMAND_NOT_STARTED',expired:'COMMAND_REQUEST_EXPIRED',failed:'COMMAND_QUERY_FAILED',unconfirmed:'COMMAND_READ_UNCONFIRMED'};
      const result=failure(codes[outcome],error.message,stage,outcome);
      if(error.nativeFailure)result.error.nativeFailure={...error.nativeFailure};
      if(error.unpublishedRequest)result.evidence.unpublishedRequest={...error.unpublishedRequest};
      return result;
    }
    if(nativeRequestId(error?.requestId)&&!requestIds.includes(error.requestId))requestIds.push(error.requestId);
    const result=failure('COMMAND_READ_UNCONFIRMED',error?.message||'只读命令的执行回执尚未确认。',stage,'unconfirmed');
    if(nativeRequestId(error?.requestId))result.evidence.unconfirmedRequest={requestId:error.requestId,requestPath:error.requestPath,temporaryRequestPath:error.temporaryRequestPath,responsePath:error.responsePath,phase:error.requestPhase};
    if(error?.[RECEIPT_OWNER])result.receiptOwner=error[RECEIPT_OWNER];
    return result;
  }
}
