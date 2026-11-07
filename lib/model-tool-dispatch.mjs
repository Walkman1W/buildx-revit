import {invokeWorkbench,invokeReadonlyPanelCommand,invokeAtomicWorkbenchRead,workbenchFailureEvidence,nativeRequestId,validateToolArguments} from './workbench-client.mjs';
import {isCommandTool,invokeCommand} from './command-store.mjs';
import {PANEL_WORKBENCH_TOOLS,PANEL_CONFIRMED_ONLY_TOOLS} from './panel-tools.mjs';
import {workbenchDocumentIdentity,sameWorkbenchDocumentIdentity} from './workbench-contracts.mjs';
import {modelCommandById,modelCommandByTool} from './model-command-catalog.mjs';
import {isFamilyTool} from './family-tools.mjs';
import {ALL_NATIVE_MODEL_QUERY_NAMES} from './native-model-queries.mjs';
import {NATIVE_PARAMETER_QUERY_NAMES} from './native-parameter-queries.mjs';
import {isVisualInspectionTool} from './visual-inspection-tools.mjs';
import {createCreatedElementLedger} from './created-elements.mjs';
import {isNativeTypeParameterWrite} from './native-type-parameter-writes.mjs';

const atomicQueries=new Set(['revit_workbench_status','revit_get_selection','revit_list_levels','revit_search_elements','revit_list_family_types','revit_describe_parameters','revit_capture_model_snapshot',...ALL_NATIVE_MODEL_QUERY_NAMES,...NATIVE_PARAMETER_QUERY_NAMES]);
const fixedCommands=new Set(['document','selection','levels','search']);
const contracts=new Map([...PANEL_WORKBENCH_TOOLS,...PANEL_CONFIRMED_ONLY_TOOLS].map(tool=>[tool.name,tool]));
const confirmedOnly=new Set(PANEL_CONFIRMED_ONLY_TOOLS.map(tool=>tool.name));
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function input(value){
  if(!plain(value)||Reflect.ownKeys(value).some(key=>typeof key!=='string'||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')))throw new Error('工具参数必须是普通数据对象。');
  return structuredClone(value);
}
function check(options){if(typeof options.shouldContinue==='function'&&options.shouldContinue()!==true){const error=new Error('命令已停止，未发送新的操作。');error.interruptedBeforeEnqueue=true;throw error;}}
function unavailable(message,code='COMMAND_INPUT_INVALID'){const error=new Error(message);error.commandCode=code;throw error;}
function sourceDocument(value){
  if(value===undefined)return null;
  if(!plain(value)||Reflect.ownKeys(value).length!==3||['session','title','path'].some(key=>{
    const entry=Object.getOwnPropertyDescriptor(value,key);
    return !entry||!Object.hasOwn(entry,'value')||typeof entry.value!=='string'||key==='session'&&!entry.value;
  }))unavailable('参数来源文档无效，请重新读取当前选择。');
  return {session:value.session,title:value.title,path:value.path};
}
function assertSourceDocument(source,current){
  if(source&&!sameWorkbenchDocumentIdentity(source,current))unavailable('当前 Revit 文档或宿主已变化，请重新读取选择和参数。');
}
function verifyReadSourceDocument(source,result){
  try{if(sameWorkbenchDocumentIdentity(source,workbenchDocumentIdentity(result)))return;}catch{/* A returned read cannot be reclassified as unstarted. */}
  const error=new Error('已收到查询回执，但来源文档或宿主不一致；结果待核对，请保留原回执。');
  error.producerResult=result;
  if(result?.receiptOwner)Object.defineProperty(error,'receiptOwner',{value:result.receiptOwner});
  throw error;
}
function expectedIdentity(status){
  if(status?.document===null)unavailable('请先在 Revit 中打开模型。','COMMAND_NO_DOCUMENT');
  return workbenchDocumentIdentity(status);
}
class ModelToolOutcomeFailure extends Error{
  constructor(result){
    const producer=result.value;
    const outcome=result.receiptOwner||producer.cleanup_pending===true||!['failed','failed_rolled_back'].includes(producer.outcome)?'unconfirmed':'failed';
    super(outcome==='unconfirmed'?'族操作结果待核对；请保留当前作业并核对原回执，不要重新提交。':'族操作返回明确未完成结果；请核对原回执中的独立文件与模型效果。');
    this.modelOutcome=outcome;
    this.producerResult=structuredClone(result);
    this.requestId=result.request_id;
    if(result.receiptOwner)Object.defineProperty(this,'receiptOwner',{value:result.receiptOwner,enumerable:false});
    this.nativeFailure={code:producer.code??'FAMILY_OPERATION_NOT_COMPLETED',message:this.message,outcome,
      producerOutcome:producer.outcome??null,requestId:result.request_id,hostSession:result.hostSession,
      cleanupPending:producer.cleanup_pending===true,jobHandle:producer.job_handle??null};
  }
}

/** The same application workflow is used by buttons and MCP. Native model,
 * family-document and immutable-command owners retain their existing effects. */
export function createModelToolDispatcher(dependencies={}){
  const workbench=dependencies.invokeWorkbench??invokeWorkbench;
  const atomic=dependencies.invokeAtomicRead??invokeAtomicWorkbenchRead;
  const stored=dependencies.invokeCommand??invokeCommand;
  const readonlyCommand=dependencies.invokeReadonlyCommand??invokeReadonlyPanelCommand;
  const createdElements=dependencies.createdElementLedger??createCreatedElementLedger();

  async function tool(name,args={},options={}){
    const definition=modelCommandByTool(name),contract=contracts.get(name);
    if(!definition||!definition.enabled)unavailable(definition?.unavailableReason??'未登记的模型工具。');
    let parameters=input(args);const source=sourceDocument(options.sourceDocument);check(options);
    if(confirmedOnly.has(name)&&options.confirmed!==true)unavailable('请通过面板核对本次族作业和参数并明确确认。','COMMAND_CONFIRMATION_REQUIRED');
    if(!contract)unavailable('未登记的本地模型工具。');
    if(atomicQueries.has(name)){
      if(!source)return atomic(name,parameters,options);
      if(Object.hasOwn(parameters,'expected_document'))assertSourceDocument(source,{...source,path:parameters.expected_document});
      const value=await atomic(name,name==='revit_workbench_status'?parameters:{...parameters,expected_document:source.path},{...options,expectedHostSession:source.session});
      verifyReadSourceDocument(source,value);
      return value;
    }
    // Reject malformed operation data before publishing even a preflight read.
    // The same contract owner validates again at native publication; no aliases
    // or fabricated operation fields are introduced here.
    if(!isCommandTool(name))try{parameters=validateToolArguments(name,parameters,{allowDocumentBinding:true});}
    catch(cause){const error=new Error('模型操作参数未通过契约校验：'+String(cause.message));error.commandCode='COMMAND_INPUT_INVALID';error.modelOutcome='not_started';error.modelStage='arguments';throw error;}
    const needsDocument=Object.hasOwn(contract.inputSchema.properties,'expected_document');
    let before=null,status=null;
    if(needsDocument){
      try{status=await atomic('revit_workbench_status',{},options);before=expectedIdentity(status);}
      catch(cause){
        // A published read is not a published wall/pipe/script. Retain that
        // read's exact receipt owner while preserving the business-stage fact.
        const facts=workbenchFailureEvidence(cause),error=new Error('模型操作尚未开始：前置文档核实失败。'+String(cause.message||''));
        Object.assign(error,{commandCode:'COMMAND_DOCUMENT_PREFLIGHT_FAILED',modelOutcome:'not_started',modelStage:'document_preflight'});
        if(facts.requestIds[0])error.requestId=facts.requestIds[0];if(facts.nativeFailure)error.nativeFailure=facts.nativeFailure;if(facts.unpublishedRequest)error.unpublishedRequest=facts.unpublishedRequest;
        if(facts.receiptOwner||cause?.receiptOwner)Object.defineProperty(error,'receiptOwner',{value:facts.receiptOwner??cause.receiptOwner});
        throw error;
      }
      assertSourceDocument(source,before);
      if(Object.hasOwn(parameters,'expected_document')){
        if(typeof parameters.expected_document!=='string'||!sameWorkbenchDocumentIdentity(before,{...before,path:parameters.expected_document}))unavailable('所选文档与当前 Revit 文档不一致，未执行操作。');
      }else parameters.expected_document=before.path;
      check(options);
    }
    const control={...options,...before?{expectedHostSession:before.session}:{}};
    let creationSource=null;
    if(name==='revit_inspect_elements'&&Object.hasOwn(parameters,'source_request_id')){
      try{creationSource=createdElements.resolve(parameters.source_request_id,before,options.creationScope);}
      catch(cause){unavailable(String(cause.message),'COMMAND_VISUAL_SOURCE_INVALID');}
      if(parameters.element_ids&&JSON.stringify(parameters.element_ids)!==JSON.stringify(creationSource.element_ids))unavailable('指定元素与已核实的新建元素回执不一致，未执行检查。','COMMAND_VISUAL_SOURCE_INVALID');
      parameters.element_ids=[...creationSource.element_ids];delete parameters.source_request_id;
    }
    const parametersSupported=status?.capabilities?.structuredScriptParameters===true;
    if(name==='revit_execute_csharp'&&Object.hasOwn(parameters,'parameters')&&!parametersSupported)unavailable('当前宿主未确认支持结构化脚本参数，未发送操作。','COMMAND_HOST_CAPABILITY_UNAVAILABLE');
    const sequenceControl=before?{
      bindSequence:async()=>{check(options);return before;},
      verifySequence:async identity=>{check(options);const current=expectedIdentity(await atomic('revit_workbench_status',{},control));return sameWorkbenchDocumentIdentity(identity,current);},
      executeStep:async(toolName,chosen,identity)=>{check(options);const value=await atomic(toolName,{...chosen,expected_document:identity.path},{...control,expectedHostSession:identity.session,retainReceiptOwner:options.retainReceiptOwner===true});return {ok:true,value};}
    }:{};
    let value=isCommandTool(name)?await stored(name,parameters,{...control,...sequenceControl,parameterizedScriptsSupported:parametersSupported,execute:(operation,chosen)=>workbench(operation,chosen,control)}):await workbench(name,parameters,control);
    // This producer reports independent family/file/project outcomes inside a
    // transport-success receipt. Delivery is not business success or cleanup.
    if(isFamilyTool(name)&&value?.value?.success===false)throw new ModelToolOutcomeFailure(value);
    if(isVisualInspectionTool(name)&&value?.value?.success===false){
      const error=new Error(value.value.cleanup_pending?'视觉检查未完成且检查视图仍待恢复，请核对原回执并恢复原会话。':'视觉检查未完成；请查看原回执中的截图及恢复结果。');
      error.modelOutcome=value.value.cleanup_pending?'unconfirmed':'failed';error.producerResult=value;error.requestId=value.request_id;
      if(value.receiptOwner)Object.defineProperty(error,'receiptOwner',{value:value.receiptOwner});throw error;
    }
    if(name==='revit_run_command'&&value?.execution?.status&&value.execution.status!=='succeeded'){
      const error=new Error('命令组合未全部完成，请检查步骤与原回执。');
      error.modelOutcome=value.execution.status==='unknown'?'unconfirmed':value.execution.status==='not_started'?'not_started':'failed';
      error.producerResult=value;
      if(value.receiptOwner)Object.defineProperty(error,'receiptOwner',{value:value.receiptOwner,enumerable:false});
      throw error;
    }
    // A producer may return a document (project queries/writes) or a family job
    // instead. Validate the supplied identity without inventing absent facts.
    if(before&&value?.document&&value?.hostSession&&!sameWorkbenchDocumentIdentity(before,workbenchDocumentIdentity(value)))throw new Error('工具回执的宿主或文档已变化；结果待核对，不会自动重试。');
    const creation=before?createdElements.record(name,value,before,options.creationScope):null;
    if(creation||creationSource){
      const owner=value.receiptOwner;value={...value,...creation?{created_elements:creation}:{creation_source:creationSource}};
      if(owner)Object.defineProperty(value,'receiptOwner',{value:owner,enumerable:false});
    }
    return value;
  }

  async function command(id,parameters={},options={}){
    const requestIds=[];
    try{
      const definition=modelCommandById(id);
      if(!definition?.enabled)unavailable(definition?.unavailableReason??'请选择已登记的命令。');
      if(isNativeTypeParameterWrite(definition.tool))unavailable('类型参数写入需要面板持有的逐次审批票据，不能直接执行命令。','COMMAND_TYPE_APPROVAL_REQUIRED');
      if(definition.manualExecution===false)unavailable(definition.manualUnavailableReason??'此操作仅支持对话内逐次确认。','COMMAND_CHAT_APPROVAL_REQUIRED');
      const chosen=input(parameters);sourceDocument(options.sourceDocument);
      if(Object.hasOwn(chosen,'expected_document'))unavailable('当前文档由执行器绑定，不接受页面提供的文档路径。');
      if(Object.hasOwn(chosen,'sourceDocument'))unavailable('参数来源文档必须单独提供，不能作为工具参数。');
      if(!definition.readOnly&&options.confirmed!==true)unavailable('请先确认此命令的模型或文件操作。','COMMAND_CONFIRMATION_REQUIRED');
      if(fixedCommands.has(id))return await readonlyCommand(id,chosen,options);
      const result=await tool(definition.tool,chosen,{...options,retainReceiptOwner:true});
      if(Array.isArray(result?.request_ids))requestIds.push(...result.request_ids);
      else if(typeof result?.request_id==='string')requestIds.push(result.request_id);
      return {ok:true,value:{command:id,tool:definition.tool,operation:result?.operation??definition.tool,
        hostSession:result?.hostSession??null,document:result?.document??null,requestIds,data:result},...(result.receiptOwner?{receiptOwner:result.receiptOwner}:{})};
    }catch(error){
      const facts=workbenchFailureEvidence(error);
      const producerIds=Array.isArray(error.producerResult?.request_ids)?error.producerResult.request_ids:[error.producerResult?.request_id];
      for(const id of producerIds)if(nativeRequestId(id))requestIds.push(id);
      for(const step of error.producerResult?.execution?.steps??[]){
        const candidates=[step.receipt?.request_id,...(Array.isArray(step.error?.request_ids)?step.error.request_ids:[]),step.error?.request_id];
        for(const id of candidates)if(typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id))requestIds.push(id);
      }
      const outcome=error.commandCode||error.interruptedBeforeEnqueue?'not_started':error.modelOutcome??facts.outcome;
      const codes={not_started:'COMMAND_NOT_STARTED',expired:'COMMAND_REQUEST_EXPIRED',failed:'COMMAND_QUERY_FAILED',unconfirmed:'COMMAND_READ_UNCONFIRMED'};
      return {ok:false,error:{code:error.commandCode??(error.interruptedBeforeEnqueue?'COMMAND_INTERRUPTED':codes[outcome]),message:error.message,stage:'dispatch',outcome,
        ...(facts.nativeFailure?{nativeFailure:facts.nativeFailure}:{})},
        evidence:{requestIds:[...new Set([...requestIds,...facts.requestIds])],...(facts.unpublishedRequest?{unpublishedRequest:facts.unpublishedRequest}:{}),
          ...(error.producerResult?{producerResult:error.producerResult}:{})},
        ...(facts.receiptOwner||error.receiptOwner?{receiptOwner:facts.receiptOwner??error.receiptOwner}:{})};
    }
  }
  return Object.freeze({invokeTool:tool,invokeCommand:command});
}
const dispatcher=createModelToolDispatcher();
export const invokeModelTool=dispatcher.invokeTool;
export const invokeModelCommand=dispatcher.invokeCommand;
