// The production transcript format owns projection and immutable-message rules.
// Browser drafts are data; native results enter through the server session owner.
import {randomUUID} from 'node:crypto';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const keys=(value,names)=>plain(value)&&Object.keys(value).every(key=>names.includes(key));
export const panelConversationId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const panelJson=value=>JSON.parse(JSON.stringify(value));
export function panelCanonical(value){if(Array.isArray(value))return '['+value.map(panelCanonical).join(',')+']';if(plain(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+panelCanonical(value[key])).join(',')+'}';return JSON.stringify(value);}
const fail=(code,message)=>({ok:false,error:{code,message}});
const validDate=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
function safe(value){const stack=[{value,depth:0}];let count=0;while(stack.length){const {value:entry,depth}=stack.pop();if(++count>40000||depth>32)return false;if(entry===null||typeof entry==='string'||typeof entry==='boolean')continue;if(typeof entry==='number'){if(!Number.isFinite(entry))return false;continue;}if(!Array.isArray(entry)&&!plain(entry))return false;for(const item of Object.values(entry))stack.push({value:item,depth:depth+1});}return true;}
const nativeId=value=>value===null||typeof value==='string'&&value.length>0&&value.length<=200;
const statuses=new Set(['streaming','completed','interrupted','failed','unknown']);
const roles=new Set(['user','assistant','error']);
const readReceiptStatuses=new Set(['received','expired','not_started','failed']);
const toolReceiptKey=value=>value.messageId+'\0'+value.itemId;
const toolReceipt=value=>keys(value,['messageId','itemId','requestId','status','checkedAt'])&&
  panelConversationId(value.messageId)&&typeof value.itemId==='string'&&value.itemId.length>0&&value.itemId.length<=200&&
  panelConversationId(value.requestId)&&readReceiptStatuses.has(value.status)&&validDate(value.checkedAt);
const modelOperationStatuses=Object.freeze({completed:'returned',not_started:'failed',failed:'failed',unconfirmed:'unknown',declined:'failed'});
export function modelOperationToolStatus(outcome){return Object.hasOwn(modelOperationStatuses,outcome)?modelOperationStatuses[outcome]:null;}
function modelOperationReceipt(value){
  return keys(value,['outcome','tool','code','requestId'])&&typeof value.outcome==='string'&&modelOperationToolStatus(value.outcome)!==null&&
    (value.tool===undefined||typeof value.tool==='string'&&/^revit_[a-z0-9_]{1,75}$/.test(value.tool))&&
    (value.code===undefined||typeof value.code==='string'&&/^MODEL_[A-Z0-9_]{1,100}$/.test(value.code))&&
    (value.requestId===undefined||panelConversationId(value.requestId));
}
function unknownTool(message,itemId){
  if(message?.role!=='assistant')return false;
  const matches=message.tools.filter(tool=>tool.id===itemId);
  return matches.length===1&&matches[0].status==='unknown';
}
function message(value){
  if(!keys(value,['id','role','text','status','tools','toolHistoryTruncated','references','attachments','turnId','includeSelection','timestamp'])||!panelConversationId(value.id)||!roles.has(value.role)||typeof value.text!=='string'||value.text.length>64024||!statuses.has(value.status)||value.role!=='assistant'&&value.status==='streaming'||!Array.isArray(value.tools)||value.tools.length>40||!safe(value))return false;
  if(value.toolHistoryTruncated!==undefined&&typeof value.toolHistoryTruncated!=='boolean'||value.references!==undefined&&(!Array.isArray(value.references)||value.references.length>100||!value.references.every(reference=>plain(reference)&&typeof reference.path==='string'&&typeof reference.text==='string'))||value.attachments!==undefined&&(!Array.isArray(value.attachments)||value.attachments.length>100)||value.turnId!==undefined&&!nativeId(value.turnId)||value.includeSelection!==undefined&&typeof value.includeSelection!=='boolean'||value.timestamp!==undefined&&!validDate(value.timestamp))return false;
  return value.tools.every(tool=>keys(tool,['id','name','label','status','argumentsPreview','resultPreview','error','operationReceipt'])&&typeof tool.id==='string'&&tool.id.length>0&&tool.id.length<=200&&typeof tool.name==='string'&&typeof tool.label==='string'&&['running','returned','failed','unknown'].includes(tool.status)&&['argumentsPreview','resultPreview','error'].every(key=>typeof tool[key]==='string'&&tool[key].length<=1824)&&
    (tool.operationReceipt===undefined||value.role==='assistant'&&tool.name==='buildx_model_operation'&&panelConversationId(tool.id)&&modelOperationReceipt(tool.operationReceipt)&&tool.status===modelOperationToolStatus(tool.operationReceipt.outcome)));
}
function turnBinding(value){return keys(value,['requestId','threadId','turnId','messageId','contextEpoch','status'])&&panelConversationId(value.requestId)&&nativeId(value.threadId)&&nativeId(value.turnId)&&panelConversationId(value.messageId)&&integer(value.contextEpoch)&&statuses.has(value.status);}
function receipts(value){return Array.isArray(value)&&value.length<=32&&value.every(item=>keys(item,['requestId','turnId','message','status'])&&panelConversationId(item.requestId)&&typeof item.turnId==='string'&&item.turnId.length>0&&item.turnId.length<=200&&typeof item.message==='string'&&item.message.trim()===item.message&&item.message.length>0&&item.message.length<=16000&&['pending','accepted','not_sent','unknown'].includes(item.status))&&new Set(value.map(item=>item.requestId)).size===value.length;}
function receiptTransition(before,after){
  const old=before.steerReceipts??[],next=after.steerReceipts??[],oldRevision=before.steerReceiptsRevision??0,nextRevision=after.steerReceiptsRevision??0;
  if(nextRevision<oldRevision)return false;
  if(nextRevision===oldRevision)return panelCanonical(old)===panelCanonical(next);
  if(old.some(item=>['pending','unknown'].includes(item.status)&&!next.some(updated=>updated.requestId===item.requestId)))return false;
  let previous=-1,added=false;
  return next.every(updated=>{
    const index=old.findIndex(item=>item.requestId===updated.requestId);
    if(index<0){added=true;return updated.status==='pending';}
    if(added||index<=previous)return false;previous=index;const item=old[index];
    return item.turnId===updated.turnId&&item.message===updated.message&&(item.status===updated.status||item.status==='pending'&&['accepted','not_sent','unknown'].includes(updated.status));
  });
}
function state(value,id){return keys(value,['conversation','context','contextEpoch','historyTruncated','contextMessageId'])&&keys(value.conversation,['id','source','threadBinding','turnBinding','steerReceipts','steerReceiptsRevision'])&&value.conversation.id===id&&value.conversation.source==='local-codex-panel'&&keys(value.conversation.threadBinding,['threadId','contextEpoch','scope','persistedResumeVerified'])&&nativeId(value.conversation.threadBinding.threadId)&&integer(value.contextEpoch)&&value.conversation.threadBinding.contextEpoch===value.contextEpoch&&value.conversation.threadBinding.scope==='current-runtime'&&value.conversation.threadBinding.persistedResumeVerified===false&&(value.conversation.turnBinding===undefined||value.conversation.turnBinding===null||turnBinding(value.conversation.turnBinding)&&value.conversation.turnBinding.contextEpoch<=value.contextEpoch)&&((value.conversation.steerReceipts===undefined&&value.conversation.steerReceiptsRevision===undefined)||(receipts(value.conversation.steerReceipts)&&integer(value.conversation.steerReceiptsRevision)))&&typeof value.historyTruncated==='boolean'&&plain(value.context)&&safe(value.context)&&(value.contextMessageId===null||panelConversationId(value.contextMessageId));}
function draft(value){return keys(value,['text','includeSelection'])&&typeof value.text==='string'&&value.text.length<=16000&&typeof value.includeSelection==='boolean';}
export function panelSnapshot(value){
  try{
    if(!plain(value)||!Array.isArray(value.messages)||value.messages.length>48||(value.conversation?.steerReceipts===undefined)!==(value.conversation?.steerReceiptsRevision===undefined))return fail('CHAT_SNAPSHOT_INVALID','对话快照格式无效。');
    const conversation={id:value.conversation?.id,source:value.conversation?.source,threadBinding:panelJson(value.conversation?.threadBinding),...(value.conversation?.turnBinding!==undefined?{turnBinding:panelJson(value.conversation.turnBinding)}:{}),...(value.conversation?.steerReceipts!==undefined?{steerReceipts:panelJson(value.conversation.steerReceipts),steerReceiptsRevision:value.conversation.steerReceiptsRevision}:{})};
    const copy={conversation,context:panelJson(value.context),contextEpoch:value.contextEpoch,historyTruncated:value.historyTruncated,contextMessageId:value.contextMessageId??null};
    const id=copy.conversation?.id;
    if(!panelConversationId(id)||!state(copy,id)||!value.messages.every(message)||new Set(value.messages.map(item=>item.id)).size!==value.messages.length)return fail('CHAT_SNAPSHOT_INVALID','对话快照格式无效。');
    const contextMessage=copy.contextMessageId===null?null:value.messages.find(item=>item.id===copy.contextMessageId);
    if(copy.contextMessageId!==null&&(contextMessage?contextMessage.role!=='user':!copy.historyTruncated))return fail('CHAT_SNAPSHOT_INVALID','对话上下文关联无效。');
    const toolReceipts=value.toolReceipts??[];
    if(!Array.isArray(toolReceipts)||toolReceipts.length>64||!toolReceipts.every(toolReceipt)||
      new Set(toolReceipts.map(toolReceiptKey)).size!==toolReceipts.length||new Set(toolReceipts.map(item=>item.requestId)).size!==toolReceipts.length)
      return fail('CHAT_SNAPSHOT_INVALID','工具原回执关联无效。');
    return {ok:true,state:copy,messages:panelJson(value.messages),toolReceipts:panelJson(toolReceipts),id};
  }catch{return fail('CHAT_SNAPSHOT_INVALID','对话快照格式无效。');}
}
export function panelDraft(value){return draft(value)?{ok:true,value:panelJson(value)}:fail('CHAT_DRAFT_INVALID','草稿格式无效。');}
const initialDraft=()=>({text:'',includeSelection:false});
export function projectPanelConversation(id,events){
  let current=null,savedDraft=initialDraft(),createdAt=null,updatedAt=null;const messages=new Map(),ids=new Set(),contextMessageIds=new Set(),steerIds=new Set(),toolReceipts=new Map(),toolRequestIds=new Set();
  for(let index=0;index<events.length;index++){
    const event=events[index];
    if(!keys(event,['schemaVersion','source','sessionId','id','type','timestamp','payload'])||event.schemaVersion!==2||event.source!=='local-codex-panel'||event.sessionId!==id||!panelConversationId(event.id)||!validDate(event.timestamp)||ids.has(event.id))return fail('CHAT_LOG_INVALID','对话记录格式无效，原文件已保留。');
    ids.add(event.id);
    if(index===0){if(event.type!=='conversation.created'||!state(event.payload,id))return fail('CHAT_LOG_INVALID','对话记录缺少创建信息。');current=panelJson(event.payload);for(const entry of current.conversation.steerReceipts??[])steerIds.add(entry.requestId);createdAt=event.timestamp;if(current.contextMessageId!==null)contextMessageIds.add(current.contextMessageId);}
    else if(event.type==='message.recorded'){
      if(!keys(event.payload,['message'])||!message(event.payload.message))return fail('CHAT_LOG_INVALID','对话消息格式无效。');
      const next=event.payload.message,prior=messages.get(next.id);
      if(prior&&(prior.status!=='streaming'&&panelCanonical(prior)!==panelCanonical(next)||prior.role!==next.role))return fail('CHAT_HISTORY_CONFLICT','已发送内容不可改写。');
      if(!prior&&messages.size>=4000)return fail('CHAT_LOG_LIMIT','对话消息数量超过投影预算。');
      messages.set(next.id,panelJson(next));
    }else if(event.type==='state.recorded'){
      if(!state(event.payload,id)||event.payload.contextEpoch<current.contextEpoch||!receiptTransition(current.conversation,event.payload.conversation))return fail('CHAT_LOG_INVALID','对话上下文或补充指令回执代次无效。');
      const existing=new Set((current.conversation.steerReceipts??[]).map(item=>item.requestId));
      for(const entry of event.payload.conversation.steerReceipts??[]){if(!existing.has(entry.requestId)&&steerIds.has(entry.requestId))return fail('CHAT_LOG_INVALID','补充指令请求身份被重复使用。');steerIds.add(entry.requestId);}
      current=panelJson(event.payload);if(current.contextMessageId!==null)contextMessageIds.add(current.contextMessageId);
    }else if(event.type==='draft.saved'){
      if(!draft(event.payload))return fail('CHAT_LOG_INVALID','对话草稿格式无效。');savedDraft=panelJson(event.payload);
    }else if(event.type==='tool.receipt.checked'){
      const receipt=event.payload;
      if(!toolReceipt(receipt)||toolReceipts.has(toolReceiptKey(receipt))||toolRequestIds.has(receipt.requestId)||
        !unknownTool(messages.get(receipt.messageId),receipt.itemId))return fail('CHAT_LOG_INVALID','工具原回执关联无效。');
      toolReceipts.set(toolReceiptKey(receipt),panelJson(receipt));toolRequestIds.add(receipt.requestId);
    }else return fail('CHAT_LOG_INVALID','未知对话事件。');
    updatedAt=event.timestamp;
  }
  if(!current)return fail('CHAT_LOG_INVALID','对话记录缺少创建信息。');
  // A creation/checkpoint event may precede its message event in the same save.
  // Validate every recorded association only after projecting the complete log.
  for(const messageId of contextMessageIds)if(messages.get(messageId)?.role!=='user')return fail('CHAT_LOG_INVALID','对话上下文关联缺少对应的用户消息。');
  const all=[...messages.values()],first=all.find(item=>item.role==='user'),last=all.at(-1);
  const summary={id,title:[...(first?.text.replace(/\s+/gu,' ').trim()||'新对话')].slice(0,28).join(''),createdAt,updatedAt,messageCount:all.length,preview:[...(last?.text.replace(/\s+/gu,' ')||'')].slice(0,100).join('')};
  const checked=[...toolReceipts.values()].slice(-64);
  return {ok:true,session:{...panelJson(current),messages:all.slice(-48),...checked.length?{toolReceipts:checked}:{},historyTruncated:current.historyTruncated||all.length>48},draft:savedDraft,summary,allMessages:messages,allToolReceipts:toolReceipts};
}
export function panelConversationEvents(id,events,snapshot,proposedDraft,timestamp){
  if(!validDate(timestamp))return fail('CHAT_TIME_INVALID','无法确认保存时间。');
  const parsed=panelSnapshot(snapshot);if(!parsed.ok)return parsed;if(parsed.id!==id)return fail('CHAT_SESSION_INVALID','对话编号不匹配。');
  const prior=events.length?projectPanelConversation(id,events):null;if(prior&&!prior.ok)return prior;
  if(proposedDraft!==undefined&&!draft(proposedDraft))return fail('CHAT_DRAFT_INVALID','草稿格式无效。');
  const additions=[],append=(type,payload)=>additions.push({schemaVersion:2,source:'local-codex-panel',sessionId:id,id:randomUUID(),type,timestamp,payload});
  if(!events.length)append('conversation.created',parsed.state);
  for(const next of parsed.messages){const previous=prior?.allMessages.get(next.id);if(previous&&previous.status!=='streaming'&&panelCanonical(previous)!==panelCanonical(next))return fail('CHAT_HISTORY_CONFLICT','已发送消息或引用不可改写，原文件已保留。');if(!previous||panelCanonical(previous)!==panelCanonical(next))append('message.recorded',{message:next});}
  for(const receipt of parsed.toolReceipts){
    const priorReceipt=prior?.allToolReceipts.get(toolReceiptKey(receipt));
    if(priorReceipt&&panelCanonical(priorReceipt)!==panelCanonical(receipt))return fail('CHAT_HISTORY_CONFLICT','已核对工具回执不可改写。');
    if(!priorReceipt)append('tool.receipt.checked',receipt);
  }
  const priorState=prior?panelSnapshot(prior.session).state:null;
  if(prior&&panelCanonical(priorState)!==panelCanonical(parsed.state)){
    if(parsed.state.contextEpoch<prior.session.contextEpoch)return fail('CHAT_HISTORY_CONFLICT','不能恢复旧的上下文代次。');
    append('state.recorded',parsed.state);
  }
  if(proposedDraft!==undefined&&panelCanonical(proposedDraft)!==panelCanonical(prior?.draft??initialDraft()))append('draft.saved',panelJson(proposedDraft));
  const projected=projectPanelConversation(id,[...events,...additions]);return projected.ok?{ok:true,events:additions,projected}:projected;
}
