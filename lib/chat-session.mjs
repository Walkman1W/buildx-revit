import {randomUUID} from 'node:crypto';

export const CHAT_LIMITS=Object.freeze({messages:48,text:64000,totalText:240000,tools:40,preview:1800});
const messageSize=item=>item.text.length+(item.references||[]).reduce((sum,reference)=>sum+(reference.text?.length||0),0)+item.tools.reduce((n,t)=>n+t.argumentsPreview.length+t.resultPreview.length+t.error.length,0);
export function safeChatText(value,limit=CHAT_LIMITS.preview){
  const text=String(value??'');return text.length>limit?text.slice(0,limit)+'\n[预览已截断]':text;
}
export function previewChatValue(value){
  const seen=new WeakSet();
  function visit(entry,depth){
    if(entry===null||typeof entry==='boolean'||typeof entry==='number')return entry;
    if(typeof entry==='string')return safeChatText(entry,600);
    if(typeof entry!=='object')return safeChatText(entry,80);
    if(seen.has(entry))return '[重复或循环引用，预览已截断]';
    if(depth>=3)return '[深层内容预览已截断]';
    seen.add(entry);
    if(Array.isArray(entry)){const result=entry.slice(0,12).map(item=>visit(item,depth+1));if(entry.length>12)result.push('[后续数组预览已截断]');return result;}
    const output=Object.create(null);
    const keys=Object.keys(entry);for(const key of keys.slice(0,16))output[key]=visit(entry[key],depth+1);
    if(keys.length>16)output['[预览说明]']='后续字段预览已截断';
    return output;
  }
  const text=typeof value==='string'?safeChatText(value):JSON.stringify(visit(value,0),null,2);
  return safeChatText(text);
}
export function previewMcpResult(result){
  if(!result||!Array.isArray(result.content))return previewChatValue(result);
  const blocks=result.content.slice(0,12).map(block=>{
    if(block?.type==='text')return '[text]\n'+(typeof block.text==='string'?safeChatText(block.text):'[无有效文本]');
    return '['+safeChatText(block?.type||'unknown',60)+'：非文本内容未载入预览]';
  });
  if(result.content.length>12)blocks.push('[后续内容块预览已截断]');
  if(result.structuredContent!==undefined)blocks.push('[structuredContent]\n'+previewChatValue(result.structuredContent));
  return safeChatText(blocks.join('\n\n'));
}

// Keep only supported public event fields before awaiting turn/start ownership.
// Reasoning, account payloads and full tool objects never enter the pending queue.
export function boundedChatNotification(method,params){
  if(!['item/started','item/completed','item/agentMessage/delta','turn/completed','error'].includes(method))return null;
  if(!params||typeof params!=='object')return null;
  const validId=value=>typeof value==='string'&&value.length>0&&value.length<=200;
  const turnId=params.turnId||params.turn?.id;
  if(!validId(params.threadId)||!validId(turnId))return null;
  const output={threadId:params.threadId,turnId};
  if(typeof params.eventId==='string'){if(!validId(params.eventId))return null;output.eventId=params.eventId;}
  if(method==='item/agentMessage/delta'){if(!validId(params.itemId)||typeof params.delta!=='string')return null;output.itemId=params.itemId;output.delta=safeChatText(params.delta,CHAT_LIMITS.text);output.overflow=params.delta.length>CHAT_LIMITS.text;}
  const protocolStatus=value=>['completed','interrupted','failed','inProgress','in_progress'].includes(value)?value:null;
  if(method==='turn/completed')output.turn={id:turnId,status:protocolStatus(params.turn?.status)};
  if(method==='error')output.willRetry=params.willRetry;
  const item=params.item;
  if(item&&!validId(item.id))return null;
  if(item?.type==='mcpToolCall'){
    const name=item.tool||item.name;if(!validId(name))return null;
    const workbench=item.server==='revit_workbench'||item.server===undefined&&name.startsWith('revit_'),tag=item.result?.structuredContent?.buildxToolOutcome;
    // Missing server attribution is treated conservatively, never as proof
    // that a producer-supplied outcome belongs to this workbench.
    const tagged=item.server==='revit_workbench'&&tag&&typeof tag==='object'&&!Array.isArray(tag)&&Object.keys(tag).length===2&&tag.schemaVersion===1&&['not_started','expired','failed','unconfirmed'].includes(tag.outcome)?tag.outcome:null;
    output.item={id:item.id,type:item.type,tool:name,status:protocolStatus(item.status),...(workbench?{workbenchCall:true}:{}),...(tagged?{workbenchOutcome:tagged}:{}),...(item.arguments!==undefined?{arguments:previewChatValue(item.arguments)}:{}),...(item.result!==undefined?{resultPreview:previewMcpResult(item.result),resultIsError:item.result?.isError===true}:{}),...(item.error?{error:previewChatValue(item.error)}:{})};
  }
  else if(item?.type==='agentMessage')output.item={id:item.id,type:item.type,...(typeof item.text==='string'?{text:safeChatText(item.text,CHAT_LIMITS.text),overflow:item.text.length>CHAT_LIMITS.text}:{})};
  else if(item)return null;
  return output;
}

export class ChatSession{
  constructor({notices={}}={}){
    const defaults={toolUnconfirmed:'尚未收到执行回执；停止对话不代表模型操作已取消。',interrupted:'对话已停止。已发出的模型操作是否完成，需要核对执行回执；请勿自动重试。',reset:'连接已重建，AI 上下文已重置；界面历史保留，后续操作会重新核对模型。'};
    this.notices=Object.freeze(Object.fromEntries(Object.entries(defaults).map(([key,text])=>[key,safeChatText(notices[key]??text)])));
    this.conversationId=randomUUID();this.threadId=null;this.streams=new Set();this.messages=[];this.toolReceipts=[];this.steerReceipts=[];this.steerReceiptsRevision=0;this.steerRequestIds=new Set();this.setContext();this.contextEpoch=0;this.historyTruncated=false;this.activity='';this.error=null;this.run=null;this.lastTurn=null;this.historyReadOnly=false;
  }
  setContext(context=null,error=null,messageId=null){this.context=error!==null?{document:null,selection:null,capturedAt:null,error:safeChatText(error)}:context??{document:null,selection:null,capturedAt:null};this.contextMessageId=messageId;}
  reviseContextFailure(text,turnMessageId){
    const previous=this.context.error;
    this.setContext(null,text,this.contextMessageId);
    if(this.lastTurn?.messageId!==turnMessageId||!turnMessageId)return;
    const message=this.messages.at(-1);
    if(message?.role==='error'&&message.text===previous)message.text=this.context.error;
    if(this.error===previous)this.error=this.context.error;
  }
  // Native IDs describe this owner's live binding, not verified persistence or
  // permission to resume an arbitrary thread after a process restart.
  view(){
    const turn=this.run?{requestId:this.run.id,threadId:this.run.threadId,turnId:this.run.turnId,messageId:this.run.messageId,contextEpoch:this.run.contextEpoch,status:'streaming'}:this.lastTurn;
    return {conversation:{id:this.conversationId,source:'local-codex-panel',threadBinding:{threadId:this.threadId,contextEpoch:this.contextEpoch,scope:this.historyReadOnly?'historical':'current-runtime',persistedResumeVerified:false},steerReceipts:structuredClone(this.steerReceipts),steerReceiptsRevision:this.steerReceiptsRevision,...(turn?{turnBinding:{...turn}}:{}),...(this.historyReadOnly?{readOnly:true}:{})},messages:structuredClone(this.messages),...this.toolReceipts.length?{toolReceipts:structuredClone(this.toolReceipts)}:{},context:structuredClone(this.context),contextMessageId:this.contextMessageId,contextEpoch:this.contextEpoch,historyTruncated:this.historyTruncated};
  }
  // Called only with the history store's parsed production view. A recorded
  // native ID is retained as evidence, never attached to a new Codex process.
  restoreHistory(value){
    if(this.run)throw new Error('请先结束当前对话');
    const view=structuredClone(value);
    if(view?.conversation?.source!=='local-codex-panel'||typeof view.conversation.id!=='string'||!Array.isArray(view.messages))throw new Error('历史对话来源无效');
    this.conversationId=view.conversation.id;this.threadId=null;this.contextEpoch=view.contextEpoch??0;
    this.steerReceipts=structuredClone(view.conversation.steerReceipts??[]);this.steerReceiptsRevision=view.conversation.steerReceiptsRevision??0;this.steerRequestIds=new Set(this.steerReceipts.map(item=>item.requestId));
    this.messages=view.messages.map(message=>({...message,status:message.status==='streaming'?'unknown':message.status,tools:(message.tools||[]).map(tool=>({...tool,status:tool.status==='running'?'unknown':tool.status}))}));
    this.toolReceipts=structuredClone(view.toolReceipts??[]);
    this.setContext(view.context??null,null,view.contextMessageId??null);this.historyTruncated=view.historyTruncated===true;this.lastTurn=view.conversation.turnBinding??null;
    this.activity='';this.error=null;this.historyReadOnly=true;this.trim();
  }
  trim(){
    let size=this.messages.reduce((total,item)=>total+messageSize(item),0);
    while(this.messages.length>CHAT_LIMITS.messages||(size>CHAT_LIMITS.totalText&&this.messages.length>2)){
      const removed=this.messages.shift();size-=messageSize(removed);this.historyTruncated=true;
    }
  }
  add(role,text,status='completed'){const message={id:randomUUID(),role,text:safeChatText(text,CHAT_LIMITS.text),status,tools:[]};this.messages.push(message);this.trim();return message;}
  recordToolReceipt(messageId,itemId,receipt){
    const message=this.messages.find(item=>item.id===messageId&&item.role==='assistant');
    if(this.historyReadOnly||!message?.tools.some(tool=>tool.id===itemId&&tool.status==='unknown')||
      this.toolReceipts.some(item=>item.requestId===receipt.requestId||item.messageId===messageId&&item.itemId===itemId))return false;
    this.toolReceipts.push({messageId,itemId,requestId:receipt.requestId,status:receipt.status,checkedAt:receipt.checkedAt});
    if(this.toolReceipts.length>64)this.toolReceipts.shift();
    return true;
  }
  addSteerReceipt(requestId,turnId,message){
    if(this.steerRequestIds.size>=4096||this.steerRequestIds.has(requestId)||this.steerReceipts.some(item=>['pending','unknown'].includes(item.status)&&item.message===message))return false;
    if(this.steerReceipts.length>=32){const removable=this.steerReceipts.findIndex(item=>['accepted','not_sent'].includes(item.status));if(removable<0)return false;this.steerReceipts.splice(removable,1);}
    this.steerRequestIds.add(requestId);this.steerReceipts.push({requestId,turnId,message,status:'pending'});this.steerReceiptsRevision++;return true;
  }
  settleSteerReceipt(requestId,status){
    const receipt=this.steerReceipts.find(item=>item.requestId===requestId);
    if(!receipt||receipt.status!=='pending'||!['accepted','not_sent','unknown'].includes(status))return false;
    receipt.status=status;this.steerReceiptsRevision++;return true;
  }
  begin(text,inputs={}){
    if(this.run)throw new Error('上一轮对话尚未结束');
    if(this.historyReadOnly)throw new Error('请新建对话继续。');
    this.error=null;this.activity='Codex 正在处理…';const user=this.add('user',text);
    if(inputs.attachments?.length)user.attachments=structuredClone(inputs.attachments);
    if(inputs.references?.length)user.references=structuredClone(inputs.references);
    const message=this.add('assistant','','streaming');
    this.trim();
    this.run={id:randomUUID(),conversationId:this.conversationId,contextEpoch:this.contextEpoch,threadId:this.threadId,turnId:null,userMessageId:user.id,messageId:message.id,agentItems:new Map(),seen:new Set()};
    return this.run;
  }
  ownsRun(run){return Boolean(run&&this.run===run&&run.conversationId===this.conversationId&&run.contextEpoch===this.contextEpoch);}
  // Only application-owned image snapshots may be attached to the assistant
  // while this exact turn is live. Native/model notifications cannot add them.
  attachAssistantImages(run,attachments){
    if(!this.ownsRun(run)||!Array.isArray(attachments)||attachments.length<1||attachments.length>3)return false;
    const message=this.messages.find(item=>item.id===run.messageId&&item.role==='assistant'&&item.status==='streaming');
    if(!message||(message.attachments?.length??0)+attachments.length>12)return false;
    const ids=new Set((message.attachments??[]).map(item=>item.id));
    for(const item of attachments){
      if(!item||Object.keys(item).sort().join(',')!=='bytes,id,kind,mediaType,name,sha256'||typeof item.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.id)||ids.has(item.id)||item.kind!=='image'||item.mediaType!=='image/png'||typeof item.name!=='string'||item.name.length<1||item.name.length>255||!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>2*1024*1024||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))return false;
      ids.add(item.id);
    }
    message.attachments=[...(message.attachments??[]),...structuredClone(attachments)];return true;
  }
  bindThread(run,threadId){
    if(typeof threadId!=='string'||threadId.length===0||threadId.length>200)throw new Error('Codex 线程 ID 必须是1到200个字符的非空字符串。');
    if(!this.ownsRun(run)||(this.threadId!==null&&this.threadId!==threadId)||(run.threadId!==null&&run.threadId!==threadId))return false;
    this.threadId=threadId;run.threadId=threadId;return true;
  }
  owns(run,params){return this.ownsRun(run)&&typeof params?.threadId==='string'&&params.threadId===run.threadId&&typeof(params.turnId||params.turn?.id)==='string'&&(params.turnId||params.turn?.id)===run.turnId;}
  notification(run,method,params,labelFor=name=>name){
    if(!this.owns(run,params))return {changed:false};
    if(params.eventId){
      if(run.seen.has(params.eventId))return {changed:false};
      if(run.seen.size>=1024){
        // The authoritative terminal must still retire this exact run. Once
        // any normal event is lost, however, the visible output is incomplete.
        if(method!=='turn/completed'){run.eventBudgetExceeded=true;return {changed:false};}
      }else run.seen.add(params.eventId);
    }
    const message=this.messages.find(item=>item.id===run.messageId);if(!message)return {changed:false};
    const item=params.item;
    const exceededAgentItems=()=>{if(run.outputTruncated)return {changed:false};run.outputTruncated=true;this.activity='回复段落超过面板上限，后续内容未显示；正在等待本轮结束。';return {changed:true};};
    if(method==='item/agentMessage/delta'){
      if(typeof params.itemId!=='string'||!params.itemId||typeof params.delta!=='string')return {changed:false};
      let segment=run.agentItems.get(params.itemId);
      if(!segment){if(run.agentItems.size>=40)return exceededAgentItems();segment={text:'',completed:false};run.agentItems.set(params.itemId,segment);}
      if(segment.completed)return {changed:false};
      const text=params.delta;
      if(params.overflow||message.text.length+text.length>CHAT_LIMITS.text){run.outputTruncated=true;message.text=safeChatText(message.text+text,CHAT_LIMITS.text);return {changed:true,overflow:true};}
      segment.text+=text;message.text=[...run.agentItems.values()].map(value=>value.text).join('\n\n');this.trim();return {changed:true};
    }
    if((method==='item/started'||method==='item/completed')&&item?.type==='agentMessage'){
      if(typeof item.id!=='string'||!item.id)return {changed:false};
      let segment=run.agentItems.get(item.id);
      if(!segment){if(run.agentItems.size>=40)return exceededAgentItems();segment={text:'',completed:false};run.agentItems.set(item.id,segment);}
      if(segment.completed)return {changed:false};
      if(method==='item/completed'&&typeof item.text==='string'){
        segment.text=item.text;segment.completed=true;
        const text=[...run.agentItems.values()].map(value=>value.text).join('\n\n');
        if(item.overflow||text.length>CHAT_LIMITS.text){run.outputTruncated=true;message.text=safeChatText(text,CHAT_LIMITS.text);return {changed:true,overflow:true};}
        message.text=text;this.trim();return {changed:true};
      }
      return {changed:false};
    }
    if((method==='item/started'||method==='item/completed')&&item?.type==='mcpToolCall'){
      if(typeof item.id!=='string'||!item.id)return {changed:false};
      const name=item.tool||item.name;if(typeof name!=='string'||!labelFor(name))return {changed:false};
      let tool=message.tools.find(candidate=>candidate.id===item.id);
      const previous=tool?JSON.stringify(tool):null;
      if(tool&&tool.name!==name)return {changed:false};
      if(!tool){if(message.tools.length>=CHAT_LIMITS.tools){if(message.toolHistoryTruncated)return {changed:false};message.toolHistoryTruncated=true;this.activity='工具记录超过面板上限，后续记录未显示。正在等待本轮结束。';return {changed:true};}tool={id:item.id,name,label:labelFor(name),status:'running',argumentsPreview:'',resultPreview:'',error:''};message.tools.push(tool);}
      if(tool.status!=='running')return {changed:false};
      if(item.arguments!==undefined)tool.argumentsPreview=previewChatValue(item.arguments);
      if(method==='item/completed'){
        const toolError=Boolean(item.error||item.result?.isError===true||item.resultIsError===true||item.status==='failed');
        // A failed MCP transport is not proof that the Revit operation failed.
        // Only the named workbench's producer facts can establish that outcome.
        if(item.workbenchCall&&(toolError||item.workbenchOutcome))tool.status=['not_started','expired','failed'].includes(item.workbenchOutcome)?'failed':'unknown';
        else tool.status=toolError?'failed':item.status==='completed'?'returned':'unknown';
        if(item.resultPreview!==undefined)tool.resultPreview=safeChatText(item.resultPreview);
        else if(item.result!==undefined)tool.resultPreview=previewMcpResult(item.result);
        if(item.error)tool.error=previewChatValue(item.error);
      }
      this.activity=tool.status==='running'?'正在调用：'+tool.label:'工具已返回：'+tool.label;this.trim();return {changed:previous!==JSON.stringify(tool)};
    }
    if(method==='turn/completed')return run.eventBudgetExceeded?{changed:false,terminal:'unknown',error:'本轮事件超过面板保留上限；显示内容及结果不完整，请核对原工具回执。'}:{changed:false,terminal:params.turn?.status==='completed'?'completed':params.turn?.status==='interrupted'?'interrupted':params.turn?.status==='failed'?'failed':'unknown'};
    // An error notice is not the authoritative end of the turn. Keep the
    // original owner until turn/completed or a transport loss resolves it.
    if(method==='error'&&typeof params.willRetry==='boolean'){
      this.activity=params.willRetry?'Codex 遇到问题，正在重试…':'Codex 报告错误，正在等待本轮结束回执…';
      return {changed:true};
    }
    return {changed:false};
  }
  finish(run,status,error=null){
    if(!this.ownsRun(run))return false;
    if(run.outputTruncated){status='unknown';error='回复超过面板上限，显示内容已截断；本轮完成状态未知，请核对工具回执。';}
    const message=this.messages.find(item=>item.id===run.messageId);
    if(message){message.status=status;for(const tool of message.tools)if(tool.status==='running'){tool.status='unknown';tool.error=this.notices.toolUnconfirmed;}}
    this.lastTurn={requestId:run.id,threadId:run.threadId,turnId:run.turnId,messageId:run.messageId,contextEpoch:run.contextEpoch,status};
    this.error=error?safeChatText(error):null;this.activity='';this.run=null;
    if(error)this.add('error',error,status==='failed'?'failed':'unknown');
    if(status==='interrupted')this.add('error',this.notices.interrupted,'interrupted');
    else if(status==='unknown'&&!error)this.add('error','本轮执行结果未知，请核对回执后再操作。','unknown');
    this.trim();return true;
  }
  resetContext(reason=this.notices.reset){
    if(this.run)throw new Error('请先结束当前对话，再重置上下文');
    if(this.historyReadOnly)return;
    this.threadId=null;this.contextEpoch++;this.setContext();this.add('error',reason);this.activity='';this.error=null;
  }
  newChat(){if(this.run)throw new Error('请先停止当前对话');this.conversationId=randomUUID();this.threadId=null;this.messages=[];this.steerReceipts=[];this.steerReceiptsRevision=0;this.steerRequestIds.clear();this.setContext();this.contextEpoch++;this.historyTruncated=false;this.activity='';this.error=null;this.lastTurn=null;this.historyReadOnly=false;}
}
