import { markdownBlocks, toolStatus, messageStatus, previewText, sessionMessages, legacyDelta, modelToolEntries, modelToolCountLabel, receiptNoticeState, receiptDismissalStore, skillReadFailureMessage } from './chat-view.mjs';

const $ = id => document.getElementById(id);
let client;
try { client = sessionStorage.getItem('revit-codex-client') || crypto.randomUUID(); sessionStorage.setItem('revit-codex-client', client); }
catch { client = crypto.randomUUID(); }
let csrf = '', ready = false, busy = false, stream, canonical = false, toolCatalog = [], contextEpoch = null, accountEpoch = 0;
let messages = [], context = null, lastSession = null;
let interruptionNotice = '', transientNotice = '', statusRead = null, stateRevision = 0, customerRecovery = false;
// A successful HTTP probe alone does not restore the event stream. Keep the
// disconnected view until the current stream opens and a fresh state arrives.
let streamConnected = false, streamRecoveryPending = false, recoveryWorkspace = null, connectionNotice = false;
// Workspace is a display/capability ceiling supplied by this fixed-profile
// endpoint. It never grants tool or write authority. A restricted page cannot
// regain model context from a late status/snapshot or a reconnect response.
let fixedWorkspace = null, modelContextAllowed = true, sourceToolCount = 0, confirmedWrite = false;
let modelUiEnabled = false, modelAccount = null, modelConfirmation = null;
let modelSelectionAvailable=false, modelChoices=[], selectedModel='', selectedEffort='', modelPickerError='', modelPickerLoading=false, modelPickerAttempted=false, modelPickerRevision=0;
const modelPreferenceKey='buildx-model-preference-v1';
let modelPreference=readModelPreference();
let steerAvailable=false, steerReceiptsAvailable=false, visibleInputId=null, steerFeedbackBinding=null, steerFeedbackKind=null;
const uncertainSteers=new Map();
const uncertainTurns=new Map();
const projectedSteerReceipts=new Map();
let modelPickerIdentity={connectionGeneration:null,accountRevision:null};
let directCommandsAvailable = false, activeCommand = null, commandRevision = 0;
let commandsReady = false, independentCommands = false, commandCatalog = null;
const knownCommand = id => commandCatalog === null ? ['document','selection','levels','search'].includes(id) : commandCatalog.some(command => command.id === id);
let commandIdentityVisible = true, commandStopUnavailable = false;
let commandIdentityFacts = {connectionGeneration:null,accountRevision:null,userId:null};
const commandResults = new Map();
let historyAvailable = false, activeConversationId = null, conversationReadOnly = false;
let dynamicApproval = null;
const settledDynamicApprovals = new Set();
let generatedFilesView = null;
// This is a server-owned projection, never an authorization decision. A
// missing or stale projection must not appear as an enabled permission.
let modelPermission=null, modelPermissionPending=null, modelPermissionTimer=null, modelPermissionMessage='',serverBusyOperation=null;
let accessPolicy=null,accessPolicyPending=null,accessPolicyMessage='';
let modelReceipt=null,modelReceiptPending=null,modelReceiptMessage='',modelReceiptAckSubmitted=false;
let terminal=null,terminalPending=null,terminalMessage='',terminalRevision=0,terminalStale=false;
let turnAttachmentsAvailable = false, attachmentRead = null;
let skillsSupported=false,skillChoices=[],skillSelection=new Set(),skillRevision=null,skillRead=null,observedSkillsRevision=null;
let staleSkillSelection=false;
let mcpCandidatesAvailable=false,mcpCandidateRead=null;
// Unsent files belong to this browser/account and conversation, never to the
// persisted text draft. Sent snapshots are owned by the server transcript.
const conversationAttachments = new Map();
let imagePreview=null;
const releaseAttachmentPreview=item=>{if(item?.previewUrl)URL.revokeObjectURL(item.previewUrl);};
function clearAttachmentDrafts(){for(const items of conversationAttachments.values())for(const item of items)releaseAttachmentPreview(item);conversationAttachments.clear();}
function closeImagePreview(returnFocus=true){
  const owner=imagePreview;if(!owner)return;imagePreview=null;
  owner.controller?.abort();if(owner.timer)clearTimeout(owner.timer);
  owner.image.removeAttribute('src');owner.overlay.remove();if(owner.ownedUrl)URL.revokeObjectURL(owner.ownedUrl);
  if(returnFocus&&owner.focus?.isConnected)owner.focus.focus();
}
function imagePreviewCurrent(owner){return imagePreview===owner&&modelUiEnabled&&modelContextAllowed&&owner.accountEpoch===accountEpoch&&owner.contextEpoch===contextEpoch&&owner.conversationId===activeConversationId;}
async function openImagePreview(detail){
  if(!modelUiEnabled||!modelContextAllowed||!historyEnabled()||!activeConversationId||pendingRequests.has('session'))return;
  const message=typeof detail?.messageId==='string'?messages.find(value=>value.id===detail.messageId&&['user','assistant'].includes(value.role)):null;
  const item=message?message.attachments?.find(value=>value.id===detail.attachmentId):pendingAttachments().find(value=>value.id===detail?.attachmentId);
  if(!item||item.kind!=='image'||!['image/png','image/jpeg'].includes(item.mediaType))return;
  if(message&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id))return;
  if(!message&&!item.previewUrl)return;
  closeImagePreview(false);
  const overlay=node('div','model-image-preview'),dialog=node('section','model-image-dialog'),heading=node('div','model-image-heading'),title=node('strong','',item.name),close=node('button','model-image-close','×'),status=node('p','model-image-status',message?'正在读取图片…':''),image=node('img','model-image-full');
  close.type='button';close.setAttribute('aria-label','关闭图片');image.alt=item.name;image.hidden=true;
  dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','图片预览 '+item.name);
  heading.append(title,close);dialog.append(heading,status,image);overlay.append(dialog);document.body.append(overlay);
  const owner={accountEpoch,contextEpoch,conversationId:activeConversationId,overlay,image,focus:document.activeElement,controller:typeof AbortController==='function'?new AbortController():null};imagePreview=owner;
  close.addEventListener('click',()=>closeImagePreview());overlay.addEventListener('click',event=>{if(event.target===overlay)closeImagePreview();});
  dialog.addEventListener('keydown',event=>{if(event.key==='Tab'){event.preventDefault();close.focus();}});close.focus();
  if(!message){image.src=item.previewUrl;image.hidden=false;status.hidden=true;return;}
  try{
    if(!csrf&&!await refreshStatus())throw new Error('本地服务状态尚未核对，请重试。');
    if(!imagePreviewCurrent(owner))return;
    owner.timer=setTimeout(()=>owner.controller?.abort(),15000);owner.timer?.unref?.();
    const response=await fetch('/api/chat/attachment',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':csrf},body:JSON.stringify({client,conversationId:owner.conversationId,messageId:message.id,attachmentId:item.id}),...(owner.controller?{signal:owner.controller.signal}:{})});
    if(!imagePreviewCurrent(owner))return;
    if(!response.ok){let result;try{result=await response.json();}catch{}throw new Error(typeof result?.error==='string'?result.error:'图片暂时无法读取，请重试。');}
    const mediaType=response.headers.get('Content-Type'),length=Number(response.headers.get('Content-Length'));
    if(mediaType!==item.mediaType||!Number.isSafeInteger(length)||length<1||length>2*1024*1024||length!==item.bytes)throw new Error('图片回执不一致，请重新读取。');
    const blob=await response.blob();if(!imagePreviewCurrent(owner))return;
    if(blob.size!==length||blob.type!==mediaType)throw new Error('图片内容不一致，请重新读取。');
    owner.ownedUrl=URL.createObjectURL(blob);image.src=owner.ownedUrl;image.hidden=false;status.hidden=true;
  }catch(error){if(imagePreviewCurrent(owner))status.textContent=error.name==='AbortError'?'图片读取超时，请关闭后重试。':error.message||'图片暂时无法读取，请重试。';}
  finally{if(owner.timer)clearTimeout(owner.timer);owner.timer=null;}
}
let historyState = { available:false, sessions:[], activeId:null, loading:false, error:'', nextCursor:null, complete:true }, historyRead = null;
let draftTimer = null, draftSaveWork = null, draftSaveController = null;
const conversationDrafts = new Map();
const sourceWorkspace = () => fixedWorkspace === 'source-development';
const customerWorkspace = () => fixedWorkspace === 'customer-chat';
const messageNodes = new Map();
let dismissedReceiptNotices;
try { dismissedReceiptNotices = receiptDismissalStore(sessionStorage); } catch { dismissedReceiptNotices = receiptDismissalStore(null); }
const openedTools = new Set();
// A transport response may arrive after SSE has advanced the session or the
// user has begun another action. Only its current owner may change this view.
const pendingRequests = new Map();
let draftRevision = 0, busyRevision = 0;
function beginRequest(kind, extra = {}) { const owner = { kind, busyRevision, commandRevision, ...extra }; pendingRequests.set(kind, owner); return owner; }
function ownsRequest(owner) { return pendingRequests.get(owner.kind) === owner; }
function finishRequest(owner) { if (owner?.receiptTimer) clearTimeout(owner.receiptTimer); if (ownsRequest(owner)) pendingRequests.delete(owner.kind); }
function invalidateRequests() { const pending=pendingRequests.get('steer');if(pending&&pending.accountEpoch===accountEpoch&&lastSession?.conversation?.id===pending.conversationId)markSteerUnknown(pending);rememberUncertainTurn(pendingRequests.get('turn'));for (const owner of pendingRequests.values()) if (owner.receiptTimer) clearTimeout(owner.receiptTimer); pendingRequests.clear(); }

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function skillsConversation(){return activeConversationId||lastSession?.conversation?.id||null;}
function clearSkills(message='列表尚未核实。',{preserveIntent=false}={}){
  staleSkillSelection=preserveIntent&&(staleSkillSelection||skillSelection.size>0);
  skillChoices=[];skillSelection.clear();skillRevision=null;skillRead=null;
  $('skills-list').replaceChildren();$('skills-summary').textContent='尚未读取';$('skills-message').textContent=message;
}
function renderSkills(){
  const list=$('skills-list');list.replaceChildren();
  for(const item of skillChoices){
    const li=node('li','skills-item'),label=node('label','skills-choice'),check=document.createElement('input'),content=node('span','skills-description');
    const selectable=item.selectable!==false;
    check.type='checkbox';check.checked=selectable&&skillSelection.has(item.id);check.dataset.skillSelectable=String(selectable);check.disabled=!selectable||!ready||busy||Boolean(skillRead);
    const title=node('strong','',item.title||item.name),description=node('small','',item.description);content.append(title,description);
    if(Array.isArray(item.dependencies)){const labels={available:'可用',unavailable:'不可用',unknown:'尚未核实'};content.append(node('small','', '依赖：'+item.dependencies.map(dep=>dep.label+'（'+(labels[dep.status]||'尚未核实')+'）').join('、')));}
    if(item.reason)content.append(node('small','',item.reason));
    label.append(check,content);li.append(label);list.append(li);
    check.addEventListener('change',()=>{if(check.checked){if(skillSelection.size>=4){check.checked=false;$('skills-message').textContent='每次最多选择 4 个 Skills。';return;}skillSelection.add(item.id);staleSkillSelection=false;}else skillSelection.delete(item.id);$('skills-summary').textContent=skillSelection.size?'本轮已选 '+skillSelection.size:skillChoices.filter(choice=>choice.selectable!==false).length+' 个可选';updateButtons();});
  }
  $('skills-summary').textContent=skillSelection.size?'本轮已选 '+skillSelection.size:skillChoices.filter(item=>item.selectable!==false).length+' 个可选';
}
async function loadSkills(){
  const conversationId=skillsConversation();
  if(!skillsSupported||!modelUiEnabled||!ready||busy||skillRead||pendingRequests.has('session')||!conversationId)return;
  clearSkills('正在读取当前 Codex 技能…',{preserveIntent:true});
  const owner={accountEpoch,conversationId,connectionGeneration:modelPickerIdentity.connectionGeneration,accountRevision:modelPickerIdentity.accountRevision};skillRead=owner;updateButtons();
  try{
    const result=await post('skills',{conversationId});
    if(skillRead!==owner)return;
    if(accountEpoch!==owner.accountEpoch||skillsConversation()!==conversationId||modelPickerIdentity.connectionGeneration!==owner.connectionGeneration||modelPickerIdentity.accountRevision!==owner.accountRevision){clearSkills('连接或对话已变化，请重新读取。');return;}
    if(!Array.isArray(result.skills)||!Number.isSafeInteger(result.revision)||result.conversationId!==conversationId)throw new Error('技能列表未能核实。');
    if(observedSkillsRevision!==null&&observedSkillsRevision>result.revision){clearSkills('技能列表已变化，请重新读取。',{preserveIntent:true});return;}
    skillRevision=result.revision;skillChoices=result.skills;renderSkills();
    $('skills-message').textContent=staleSkillSelection?'请重新选择技能，或取消失效的技能选择后再发送。':skillChoices.length?'选择后仅作用于下一条消息；工具依赖状态以当前核实结果为准。':'当前没有发现可用的 Skills。';
  }catch(error){if(skillRead===owner){clearSkills(skillReadFailureMessage(error),{preserveIntent:true});updateButtons();}}
  finally{if(skillRead===owner){skillRead=null;renderSkills();}updateButtons();}
}
function nearBottom() { const view = $('messages'); return view.scrollHeight - view.scrollTop - view.clientHeight < 88; }
function scrollBottom() { $('messages').scrollTop = $('messages').scrollHeight; }
function notice(text = '') {
  if (text !== transientNotice) connectionNotice = false;
  transientNotice = text;
  const shown = [transientNotice, interruptionNotice].filter((value,index,items) => value && items.indexOf(value) === index).join('\n');
  $('error-notice').textContent = shown; $('error-notice').hidden = !shown;
}
function interruption(state) {
  if (!customerWorkspace() || !Object.hasOwn(state, 'interruptionNotice')) return;
  if (state.interruptionNotice === null) interruptionNotice = '';
  else if (state.interruptionNotice?.code === 'turn_result_unknown' &&
      state.interruptionNotice.message === '上一轮对话的结果未知；请核对后再明确发起新消息。') interruptionNotice = state.interruptionNotice.message;
  notice(transientNotice);
}
function invalidateStatusRead() { const old = statusRead; statusRead = null; old?.controller?.abort(); }
function clearAccessPolicy(message='访问范围尚未核实。'){accessPolicy=null;accessPolicyPending=null;accessPolicyMessage=message;}
function applyAccessPolicy(value){
  if(!value||value.available!==true){clearAccessPolicy(typeof value?.reason==='string'?value.reason:'访问范围尚未核实。');return false;}
  if(value.loading===true){clearAccessPolicy('正在读取访问范围…');return false;}
  const modes=['read-only','project-write','full-access'];
  const roots=Array.isArray(value.roots)?value.roots.map(root=>typeof root==='string'?root:root?.path):null;
  if(!modes.includes(value.mode)||typeof value.id!=='string'||!value.id||value.id.length>200||!Number.isSafeInteger(value.revision)||value.revision<0||!roots||roots.length>64||roots.some(path=>typeof path!=='string'||!path||path.length>32768||/[\u0000-\u001f\u007f]/.test(path))||value.mode==='project-write'&&!roots.length){clearAccessPolicy('访问范围信息未能核实。');return false;}
  if(accessPolicy?.id===value.id&&value.revision<accessPolicy.revision)return false;
  if(accessPolicy?.id===value.id&&value.revision===accessPolicy.revision&&(accessPolicy.mode!==value.mode||JSON.stringify(accessPolicy.roots)!==JSON.stringify(roots))){clearAccessPolicy('访问范围状态不一致，请重新读取。');return false;}
  accessPolicy=Object.freeze({available:true,id:value.id,revision:value.revision,mode:value.mode,roots:Object.freeze(roots.slice()),...(typeof value.modelWritable==='boolean'?{modelWritable:value.modelWritable}:{}),...(typeof value.modelMessage==='string'&&value.modelMessage.length<=512?{modelMessage:value.modelMessage}:{})});accessPolicyMessage='';return true;
}
function clearModelPermission(message='权限尚未核实。'){
  if(modelPermissionTimer)clearTimeout(modelPermissionTimer);modelPermissionTimer=null;
  modelPermission=null;modelPermissionPending=null;modelPermissionMessage=message;
}
const modelPermissionChecking=()=>Boolean(modelPermissionPending)||serverBusyOperation==='model-permission-check';
const modelPermissionRequestCurrent=owner=>modelPermissionPending===owner&&owner.accountEpoch===accountEpoch&&owner.contextEpoch===contextEpoch&&owner.conversationId===lastSession?.conversation?.id&&owner.identityKey===commandIdentityKey();
function clearModelReceipt(){modelReceipt=null;modelReceiptPending=null;modelReceiptMessage='';modelReceiptAckSubmitted=false;}
function clearTerminal({keepJob=false}={}){
  terminal=keepJob?terminal:null;
  terminalPending=null;terminalMessage='';terminalStale=keepJob;terminalRevision++;
}
function applyTerminal(value){
  if(!modelUiEnabled||!modelContextAllowed||!commandConversationId())return false;
  if(value===null){clearTerminal();return true;}
  if(!value||['available','enabled','eligible'].some(key=>typeof value[key]!=='boolean'))return false;
  const job=value.job;
  if(job!=null&&(!job||typeof job.requestId!=='string'||!job.requestId||
    !['powershell','python'].includes(job.interpreter)||
    !['starting','running','stop_requested','exited','not_started','unconfirmed'].includes(job.status)||
    ['cwd','script','stdout','stderr'].some(key=>typeof job[key]!=='string')||
    ['stdoutTruncated','stderrTruncated','exitConfirmed'].some(key=>typeof job[key]!=='boolean')||
    !(job.exitCode===null||Number.isInteger(job.exitCode))))return false;
  const changedJob=terminal?.job?.requestId!==job?.requestId;
  if(changedJob&&terminalPending?.action!=='enable')terminalPending=null;
  terminal=value;terminalRevision++;terminalStale=false;
  if(!terminalPending)terminalMessage='';
  return true;
}
function canRecoverModelReceipt(receipt){
  const check=receipt?.check,recovery=check?.recovery,failure=check?.evidence?.nativeFailure;
  return ['revit_execute_csharp','revit_run_command'].includes(receipt?.tool)&&check?.terminal===false&&recovery?.kind==='script_failure'&&recovery.requiresReview===true&&
    recovery.modelRollback==='unknown'&&recovery.externalEffects==='unknown'&&failure?.outcome==='failed'&&failure.started===true&&failure.phase==='dispatch';
}
const canRestoreVisualReceipt=receipt=>receipt?.tool==='revit_inspect_elements'&&receipt.check?.canRestoreVisual===true;
function applyModelReceipt(value){
  if(value===null){clearModelReceipt();return;}
  const str=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
  if(!value||typeof value!=='object'||Array.isArray(value)||!str(value.ticket,200)||!str(value.tool,200)||value.conversationId!==lastSession?.conversation?.id||
    typeof value.checking!=='boolean'||!Number.isSafeInteger(value.checkRevision)||value.checkRevision<0||
    !(value.check===null||value.check&&typeof value.check==='object'&&!Array.isArray(value.check)&&str(value.check.status,100)&&typeof value.check.terminal==='boolean')){clearModelReceipt();return;}
  let check=null;
  try{
    if(value.check){const serialized=JSON.stringify(value.check);if(serialized.length>65536)throw new Error();check=JSON.parse(serialized);}
  }catch{clearModelReceipt();return;}
  if(modelReceipt?.ticket===value.ticket&&value.checkRevision<modelReceipt.checkRevision)return;
  if(modelReceipt?.ticket!==value.ticket||modelReceipt?.conversationId!==value.conversationId){modelReceiptPending=null;modelReceiptMessage='';modelReceiptAckSubmitted=false;}
  else if(value.checkRevision>modelReceipt.checkRevision){modelReceiptMessage='';modelReceiptAckSubmitted=false;}
  const auto=value.autoCheck,autoCheck=auto&&Number.isSafeInteger(auto.attempts)&&auto.attempts>=0&&typeof auto.active==='boolean'?Object.freeze({attempts:auto.attempts,active:auto.active,...str(auto.message,1000)?{message:auto.message}:{}}):null;
  modelReceipt=Object.freeze({ticket:value.ticket,conversationId:value.conversationId,sourceConversationId:str(value.sourceConversationId,200)?value.sourceConversationId:value.conversationId,tool:value.tool,checking:value.checking,checkRevision:value.checkRevision,check,autoCheck,canRecover:canRecoverModelReceipt({...value,check})});
}
function applyModelPermission(value){
  const conversationId=lastSession?.conversation?.id;
  if(!value||value.available!==true){clearModelPermission(typeof value?.reason==='string'&&value.reason.length<=300?value.reason:'权限尚未核实。');return false;}
  if(!(value.level===null||['rollback','confirm','automatic'].includes(value.level))||!Number.isSafeInteger(value.revision)||value.revision<0||
    typeof value.conversationId!=='string'||value.conversationId!==conversationId||
    typeof value.documentLabel!=='string'||!value.documentLabel||value.documentLabel.length>512||/[\u0000-\u001f\u007f]/.test(value.documentLabel)||
    !(value.expiresAt===null||Number.isSafeInteger(value.expiresAt)&&value.expiresAt>Date.now())){clearModelPermission('权限信息未能核实，请重新连接。');return false;}
  if(modelPermission&&modelPermission.conversationId===conversationId&&value.revision<modelPermission.revision)return false;
  if(modelPermission&&value.revision===modelPermission.revision&&(value.level!==modelPermission.level||value.documentLabel!==modelPermission.documentLabel||value.expiresAt!==modelPermission.expiresAt)){clearModelPermission('权限状态不一致，请重新连接。');return false;}
  if(modelPermissionTimer)clearTimeout(modelPermissionTimer);
  modelPermission=Object.freeze({available:true,level:value.level,revision:value.revision,conversationId,documentLabel:value.documentLabel,expiresAt:value.expiresAt});
  if(!modelPermissionPending)modelPermissionMessage='';
  if(value.expiresAt!==null){const bound=modelPermission;modelPermissionTimer=setTimeout(()=>{if(modelPermission===bound){clearModelPermission('本次授权已过期，请重新选择。');updateButtons();}},Math.min(value.expiresAt-Date.now(),2147483647));}
  return true;
}
function connectionIssue(message) {
  clearAccessPolicy('连接已中断，访问范围尚未核实。');
  clearModelPermission('连接已中断，权限尚未核实。');
  clearTerminal({keepJob:true});
  ready = false; commandsReady = false; $('status-dot').className = 'dot error'; $('status-text').textContent = message;
  clearSkills('连接尚未核实，请重新读取技能。');
  renderCodexSetup(null);
  notice(message); connectionNotice = true; updateButtons();
}
// The backend supplies only categories established by its own runtime and
// account/read boundaries. Unknown or stale failures are not guessed here.
function renderCodexSetup(issue) {
  const guides = {
    codex_missing: ['尚未找到本机 Codex', '请安装 Codex，并使用自己的 ChatGPT 账号登录；完成后点击上方“重新连接”。如果仍未找到，请重新运行安装检测。'],
    codex_path_invalid: ['无法使用指定的 Codex 程序', '请重新运行安装检测并提供已有 Codex 的完整路径；完成后点击上方“重新连接”。'],
    codex_path_ambiguous: ['发现多个 Codex 版本', '请重新运行安装检测并提供所用 Codex 的完整路径；BuildX 不会自行猜选。'],
    codex_wrapper_only: ['发现 Codex 命令包装', '检测到 Codex 命令包装，但未能核实可直接调用的程序；请在安装向导中选择已有 codex.exe。'],
    python_missing: ['缺少本机运行组件', '请重新运行安装检测，提供已有的 Python；BuildX 不会自动安装其他软件。'],
    python_path_invalid: ['无法使用指定的 Python', '请重新运行安装检测并提供已有 Python 的完整路径，完成后点击上方“重新连接”。'],
    python_path_unverified: ['Python 程序无法核实', '请在安装向导中选择已安装的 Python 程序；BuildX 不会启动未经核实的系统别名。'],
    sign_in_required: ['请登录自己的 Codex 账号', '在本机终端运行 codex login，用自己的 ChatGPT 账号完成登录，再点击上方“重新连接”。BuildX 不会读取或复制你的登录凭据。'],
    unsupported_account: ['当前账号类型不受支持', '请在本机 Codex 中登录受支持的 ChatGPT 账号，完成后点击上方“重新连接”。BuildX 不会替你切换账号。']
  };
  const guide=typeof issue==='string'&&Object.hasOwn(guides,issue)?guides[issue]:null;
  $('codex-setup-guide').hidden=!guide;
  $('codex-setup-title').textContent=guide?.[0]??'';
  $('codex-setup-detail').textContent=guide?.[1]??'';
  const source=Boolean(guide&&['codex_missing','sign_in_required'].includes(issue));
  $('codex-setup-source').hidden=!source;
  $('codex-setup-source').textContent=source?'官方账号与登录说明：learn.chatgpt.com/docs/auth':'';
}
function contextFlags() { return modelContextAllowed
  ? { includeDocument: $('include-document').checked, includeSelection: $('include-selection').checked }
  : { includeDocument: false, includeSelection: false }; }
const historyEnabled = () => modelUiEnabled && modelContextAllowed && historyAvailable;
const attachmentsEnabled = () => historyEnabled() && turnAttachmentsAvailable && Boolean(activeConversationId);
const pendingAttachments = () => attachmentsEnabled() ? conversationAttachments.get(activeConversationId) || [] : [];
const attachmentSummary = item => ({id:item.id,name:item.name,kind:item.kind,mediaType:item.mediaType,bytes:item.bytes,...item.previewUrl?{previewUrl:item.previewUrl}:{},...item.sourceFormat==='extracted'?{sourceFormat:'extracted',sourceName:item.sourceName,extractionNotice:item.extractionNotice}:{}});
const extractionNotices=Object.freeze({
  pdf:'仅提取文字，图片或扫描页中的文字可能遗漏。',
  docx:'仅提取正文段落，页眉、页脚等内容可能遗漏。',
  xlsx:'提取的公式结果使用文件中缓存的值，可能已过期。',
});
// Library reads start before attachment staging; bind that entire interval to
// the original account, conversation, context and connection observation.
let libraryAttachmentEpoch=0;
const libraryAttachmentBindings=new Map();
function beginLibraryAttachment(){
  if(!attachmentsEnabled())return {ok:false,error:'当前对话暂不支持添加文件，请先启用对话记录和附件功能。'};
  if(conversationReadOnly)return {ok:false,error:'历史对话为只读，请先新建对话。'};
  if(pendingRequests.has('session')||attachmentRead)return {ok:false,error:'请等待当前对话或附件读取完成。'};
  const now=Date.now();for(const [id,item] of libraryAttachmentBindings)if(item.expires<=now)libraryAttachmentBindings.delete(id);
  while(libraryAttachmentBindings.size>=16)libraryAttachmentBindings.delete(libraryAttachmentBindings.keys().next().value);
  const binding=crypto.randomUUID();libraryAttachmentBindings.set(binding,{accountEpoch,contextEpoch,conversationId:activeConversationId,identityKey:commandIdentityKey(),revision:libraryAttachmentEpoch,expires:now+120000});
  return {ok:true,binding};
}
function libraryBindingCurrent(owner){return owner&&owner.expires>Date.now()&&owner.accountEpoch===accountEpoch&&owner.contextEpoch===contextEpoch&&owner.conversationId===activeConversationId&&owner.identityKey===commandIdentityKey()&&owner.revision===libraryAttachmentEpoch&&attachmentsEnabled()&&!conversationReadOnly&&!pendingRequests.has('session');}
function librarySnapshotFile(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.name!=='string'||!value.name||/[\\/\u0000-\u001f\u007f]/.test(value.name)||typeof value.attachmentName!=='string'||!value.attachmentName||value.attachmentName.length>160||/[\\/\u0000-\u001f\u007f]/.test(value.attachmentName)||!['original','extracted'].includes(value.sourceFormat))throw new Error('资料文件信息无效，请重新选择。');
  if(value.sourceFormat==='original'&&value.attachmentName!==value.name||value.sourceFormat==='extracted'&&(value.attachmentName!==value.name+'.txt'||value.mediaType!=='text/plain'))throw new Error('资料文件来源不一致，请重新选择。');
  const kind=attachmentKind({name:value.attachmentName});
  if(value.mediaType!==kind.mediaType||!Number.isSafeInteger(value.byteLength)||value.byteLength<1||value.byteLength>(kind.kind==='image'?2*1024*1024:64*1024)||typeof value.data!=='string'||value.data.length!==4*Math.ceil(value.byteLength/3)||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))throw new Error('资料文件内容或大小无效，请重新选择。');
  let raw;try{raw=atob(value.data);}catch{throw new Error('资料文件内容无效，请重新选择。');}
  if(raw.length!==value.byteLength||btoa(raw)!==value.data)throw new Error('资料文件内容长度不一致，请重新选择。');
  const original=new Uint8Array(raw.length);for(let index=0;index<raw.length;index++)original[index]=raw.charCodeAt(index);
  let bytes=original,extractionNotice;
  if(value.sourceFormat==='extracted'){
    extractionNotice=extractionNotices[value.name.toLowerCase().split('.').at(-1)];
    if(!extractionNotice)throw new Error('无法识别资料文件的提取方式，请重新选择。');
    const prefix=new TextEncoder().encode('【资料提取说明】'+extractionNotice+'以下内容不是完整原文件。\n\n');
    bytes=new Uint8Array(prefix.length+original.length);bytes.set(prefix);bytes.set(original,prefix.length);
  }
  return {name:value.attachmentName,size:bytes.length,...value.sourceFormat==='extracted'?{sourceFormat:'extracted',sourceName:value.name,extractionNotice}:{},arrayBuffer:async()=>bytes.slice().buffer};
}
async function addLibraryAttachment(value,binding){
  const owner=typeof binding==='string'?libraryAttachmentBindings.get(binding):null;
  if(typeof binding==='string')libraryAttachmentBindings.delete(binding);
  if(!libraryBindingCurrent(owner))return {ok:false,error:'账号、对话或上下文已变化，请重新选择文件。'};
  try {const chosen=librarySnapshotFile(value);if(!libraryBindingCurrent(owner))return {ok:false,error:'账号、对话或上下文已变化，请重新选择文件。'};return await addAttachments([chosen]);}
  catch(error){return {ok:false,error:error?.message||'无法添加资料文件。'};}
}
function attachmentKind(file) {
  if (/\.png$/iu.test(file.name)) return {kind:'image',mediaType:'image/png'};
  if (/\.jpe?g$/iu.test(file.name)) return {kind:'image',mediaType:'image/jpeg'};
  if (/\.txt$/iu.test(file.name)) return {kind:'text',mediaType:'text/plain'};
  if (/\.(?:md|markdown)$/iu.test(file.name)) return {kind:'text',mediaType:'text/markdown'};
  throw new Error('请选择 TXT、Markdown、PNG 或 JPEG 文件。');
}
function attachmentBudget(items) {
  if (items.length > 4) throw new Error('每次最多添加 4 个文件。');
  if (items.filter(item => item.kind === 'image').length > 2) throw new Error('每次最多添加 2 张图片。');
  if (items.some(item => item.kind === 'image' && item.bytes > 2*1024*1024)) throw new Error('每张图片不能超过 2 MiB。');
  if (items.reduce((sum,item) => sum+item.bytes,0) > 4*1024*1024) throw new Error('附件总大小不能超过 4 MiB。');
  const texts=items.filter(item => item.kind === 'text');
  if (texts.reduce((sum,item) => sum+item.bytes,0) > 64*1024 || texts.reduce((sum,item) => sum+(item.characters||0),0) > 32000) throw new Error('文本附件合计不能超过 64 KiB 或 32000 字符。');
}
async function addAttachments(files) {
  if (!attachmentsEnabled() || conversationReadOnly || pendingRequests.has('session') || attachmentRead) return {ok:false,error:'当前对话暂不能添加文件，请检查对话状态后重试。'};
  const id=activeConversationId, epoch=accountEpoch, contextAtStart=contextEpoch, libraryEpoch=libraryAttachmentEpoch, owner={}; attachmentRead=owner; updateButtons();
  const current=() => attachmentRead===owner && epoch===accountEpoch && contextAtStart===contextEpoch && libraryEpoch===libraryAttachmentEpoch && id===activeConversationId && attachmentsEnabled() && !conversationReadOnly;
  const added=[];let retained=false;
  try {
    if(!Number.isSafeInteger(files?.length) || files.length<0) throw new Error('无法读取所选文件。');
    if(files.length>4) throw new Error('每次最多添加 4 个文件。');
    const chosen=Array.from(files), existing=conversationAttachments.get(id) || [];
    if (!chosen.length) return {ok:false,error:'没有选择文件。'};
    const proposed=chosen.map(file => {
      if (typeof file?.name !== 'string' || !file.name || file.name.length > 240 || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.arrayBuffer !== 'function') throw new Error('无法读取所选文件。');
      return {file,name:file.name,bytes:file.size,...attachmentKind(file),...(file.sourceFormat==='extracted'&&typeof file.sourceName==='string'?{sourceFormat:'extracted',sourceName:file.sourceName,extractionNotice:file.extractionNotice}:{})};
    });
    attachmentBudget([...existing,...proposed]);
    const all=[...conversationAttachments.values()].flat();
    if (all.length+proposed.length > 64 || [...all,...proposed].reduce((sum,item) => sum+item.bytes,0) > 16*1024*1024) throw new Error('待发送附件过多，请先发送或移除。');
    for (const item of proposed) {
      const bytes=new Uint8Array(await item.file.arrayBuffer());
      if (!current()) return {ok:false,error:'账号、对话或上下文已变化，请重新选择文件。'};
      if (bytes.byteLength !== item.bytes) throw new Error('文件大小已变化，请重新选择。');
      let characters=0;
      if(item.kind === 'text') { try { characters=new TextDecoder('utf-8',{fatal:true}).decode(bytes).length; } catch { throw new Error('文本附件必须使用 UTF-8 编码。'); } }
      const parts=[];
      for(let offset=0;offset<bytes.length;offset+=32768) parts.push(String.fromCharCode(...bytes.subarray(offset,offset+32768)));
      const previewUrl=item.kind==='image'&&typeof URL!=='undefined'&&typeof URL.createObjectURL==='function'?URL.createObjectURL(new Blob([bytes],{type:item.mediaType})):null;
      added.push(Object.freeze({id:crypto.randomUUID(),name:item.name,kind:item.kind,mediaType:item.mediaType,bytes:item.bytes,characters,data:btoa(parts.join('')),...previewUrl?{previewUrl}:{},...item.sourceFormat==='extracted'?{sourceFormat:item.sourceFormat,sourceName:item.sourceName,extractionNotice:item.extractionNotice}:{}}));
      attachmentBudget([...existing,...added]);
    }
    if(current()) { conversationAttachments.set(id,[...existing,...added]);retained=true; notice(); return {ok:true}; }
    return {ok:false,error:'账号、对话或上下文已变化，请重新选择文件。'};
  } catch(error) { const message=error.message || '无法读取所选文件。';if(current()) notice(message);return {ok:false,error:message}; }
  finally { if(!retained)for(const item of added)releaseAttachmentPreview(item);if(attachmentRead===owner) { attachmentRead=null; updateButtons(); } }
}
function removeAttachment(id) {
  if (!attachmentsEnabled() || conversationReadOnly || pendingRequests.has('session') || attachmentRead) return;
  for(const item of pendingAttachments())if(item.id===id)releaseAttachmentPreview(item);
  closeImagePreview(false);conversationAttachments.set(activeConversationId,pendingAttachments().filter(item => item.id !== id)); updateButtons();
}
const canReadHistory = () => historyEnabled() && modelAccount !== null && (!modelAccount?.required || modelAccount.signedIn === true);
const persistenceFailed = () => (lastSession?.conversation?.persistence || lastSession?.persistence)?.status === 'failed';
const currentDraft = () => ({ text:$('prompt').value, includeSelection:Boolean($('include-selection').checked) });
const commandConversationId = () => typeof lastSession?.conversation?.id === 'string' ? lastSession.conversation.id : null;
const commandIdentityKey = () => JSON.stringify(commandIdentityFacts);
const commandRunning = () => Boolean(activeCommand && ['running','stopping'].includes(activeCommand.status));
const commandChecking = () => Boolean(activeCommand?.receiptCheck?.checking);
const commandPending = () => pendingRequests.has('command') || pendingRequests.has('command-check') || commandChecking();
const receiptRevision = value => Number.isSafeInteger(value?.receiptCheck?.revision) && value.receiptCheck.revision >= 0 ? value.receiptCheck.revision : -1;
function clearCommands(invalidate = true) {
  if (commandRunning() || commandPending()) commandStopUnavailable = true;
  if (activeCommand || commandResults.size || invalidate && commandPending()) commandRevision++;
  activeCommand = null; commandResults.clear(); if (invalidate) { for (const kind of ['command','command-check']) { const owner=pendingRequests.get(kind); if(owner)finishRequest(owner); } }
}
function commandIdentity(state) {
  if (!modelUiEnabled || !directCommandsAvailable) return;
  if(independentCommands){
    const account=Object.hasOwn(state,'account')?state.account:modelAccount;
    const userId=account?.signedIn===true?account.user?.id:null;
    if(commandIdentityFacts.userId!==null&&userId!==commandIdentityFacts.userId)clearCommands();
    commandIdentityFacts.userId=userId??null;
    commandIdentityVisible=!account?.required||account.signedIn===true&&account.retainedSession!==true;
    return;
  }
  let changed = false;
  for (const [key,value] of [['connectionGeneration',state.connectionGeneration],['accountRevision',state.codexAccount?.accountRevision]]) {
    if (!Number.isSafeInteger(value) || value < 0) continue;
    if (commandIdentityFacts[key] !== null && commandIdentityFacts[key] !== value) changed = true;
    commandIdentityFacts[key] = value;
  }
  const account = Object.hasOwn(state,'account') ? state.account : modelAccount;
  if (account?.signedIn === true && typeof account.user?.id === 'string') {
    if (commandIdentityFacts.userId !== null && commandIdentityFacts.userId !== account.user.id) changed = true;
    commandIdentityFacts.userId = account.user.id;
  } else if (account?.required && account.signedIn === false && account.retainedSession !== true && commandIdentityFacts.userId !== null) {
    changed = true; commandIdentityFacts.userId = null;
  }
  const proof = Object.hasOwn(state,'codexConfirmation') ? state.codexConfirmation : modelConfirmation;
  const checking = state.codexAccount?.status === 'checking' || proof?.phase === 'checking' || account?.retainedSession === true;
  const invalid = state.error === true || ['failed','closing','closed'].includes(state.connectionStatus) || state.codexAccount?.status === 'invalidated' ||
    proof?.required === true && proof.localConnectionConfirmed !== true && !checking && ['confirmation_required','unavailable','closed'].includes(proof.phase);
  if (changed || invalid) clearCommands();
  commandIdentityVisible = !checking && !invalid && (!account?.required || account.signedIn === true) && (!proof?.required || proof.localConnectionConfirmed === true);
}
function applyCommandProjection(value) {
  if (!modelUiEnabled || !modelContextAllowed) return clearCommands();
  if (value === null) { if (!pendingRequests.has('command') && !pendingRequests.has('command-check') && commandIdentityVisible) clearCommands(false); return; }
  if (!value || typeof value.executionId !== 'string' || value.conversationId !== commandConversationId() ||
      !knownCommand(value.commandId) ||
      !['running','stopping','completed','interrupted','failed','unknown'].includes(value.status)) return;
  const pending = pendingRequests.get('command');
  const previous = commandResults.get(value.commandId), check = pendingRequests.get('command-check');
  if (previous?.executionId === value.executionId && receiptRevision(value) < receiptRevision(previous)) return;
  // A draft checkpoint can repeat the previous execution while this explicit
  // re-run is still waiting for acceptance. That receipt owns only the old run.
  if (pending?.conversationId === value.conversationId && pending.commandId === value.commandId && pending.previousExecutionId === value.executionId &&
      !(value.status === 'unknown' && value.canInspectReceipt === true && value.receiptCheck?.cleanupPending === true)) return;
  if (check && (check.executionId !== value.executionId || check.conversationId !== value.conversationId || check.commandId !== value.commandId || receiptRevision(value) > check.receiptRevision)) finishRequest(check);
  // The server retains only its latest recovery owner. Older command rows stay
  // visible, but cannot continue advertising a receipt lookup capability.
  for (const [id,prior] of commandResults) if (prior.executionId !== value.executionId && (prior.canInspectReceipt || prior.receiptCheck?.checking)) commandResults.set(id,{...prior,canInspectReceipt:false,...prior.receiptCheck?{receiptCheck:{...prior.receiptCheck,checking:false}}:{}});
  commandRevision++; activeCommand = value; commandStopUnavailable = false; commandResults.set(value.commandId,value);
  // An owned SSE observation, including a terminal receipt, supersedes the
  // pending acceptance response. It does not touch any chat or draft owner.
  if (pending?.conversationId === value.conversationId && pending.commandId === value.commandId) finishRequest(pending);
}
function rememberDraft() {
  if (!historyEnabled() || !activeConversationId) return;
  conversationDrafts.set(activeConversationId,{ ...currentDraft(), revision:draftRevision, dirty:true });
  // Client-only drafts share the bounded history window.
  if (conversationDrafts.size > 2000) conversationDrafts.delete(conversationDrafts.keys().next().value);
}
function cancelDraftTimer() { clearTimeout(draftTimer); draftTimer = null; }
function invalidateHistoryRead() { const owner = historyRead; historyRead = null; owner?.controller?.abort(); }
function historyView(data, append = false) {
  if (!historyEnabled() || !data || data.available !== true || !Array.isArray(data.sessions)) return;
  const incoming = data.sessions.slice(0,2000).filter(item => item && typeof item.id === 'string' && item.id.length <= 200).map(item => ({
    id:item.id,title:typeof item.title === 'string' ? item.title : '新对话',updatedAt:typeof item.updatedAt === 'string' ? item.updatedAt : '',
    messageCount:Number.isSafeInteger(item.messageCount) ? item.messageCount : 0,preview:typeof item.preview === 'string' ? item.preview : '',readOnly:item.readOnly === true,
  }));
  const merged = new Map((append ? historyState.sessions : []).map(item => [item.id,item])); for (const item of incoming) merged.set(item.id,item);
  const nextCursor = typeof data.nextCursor === 'string' && data.nextCursor.length <= 4096 ? data.nextCursor : null;
  historyState = { available:true, sessions:[...merged.values()].slice(0,2000), activeId:activeConversationId || (typeof data.activeId === 'string' ? data.activeId : null), loading:false, error:'', nextCursor, complete:data.complete === true || !nextCursor,
    issueCount:(append ? historyState.issueCount || 0 : 0) + (Array.isArray(data.issues) ? data.issues.length : 0) };
}
async function refreshHistory(cursor = null) {
  if (!canReadHistory() || historyRead) return;
  if (cursor !== null && (typeof cursor !== 'string' || cursor !== historyState.nextCursor)) return;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const owner = { accountEpoch, stream, conversationId:activeConversationId, cursor, controller };
  historyRead = owner; historyState = { ...historyState, available:true, loading:true, error:'' }; publishModelView();
  const current = () => historyRead === owner && owner.accountEpoch === accountEpoch && owner.stream === stream && owner.conversationId === activeConversationId && canReadHistory();
  let timer;
  try {
    const deadline = new Promise((_,reject) => { timer = setTimeout(() => { controller?.abort(); reject(new Error('历史对话读取未完成，请重试。')); },12000); timer?.unref?.(); });
    const response = await Promise.race([fetch('/api/chats?client=' + encodeURIComponent(client) + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor)), { cache:'no-store', ...(controller ? {signal:controller.signal} : {}) }),deadline]);
    if (!current()) return;
    const data = await Promise.race([response.json(),deadline]); if (!current()) return;
    if (!response.ok || data.ok === false) throw new Error(typeof data.error === 'string' ? data.error : '历史对话读取未完成，请重试。');
    if (data.available !== true || !Array.isArray(data.sessions)) throw new Error('历史对话读取未完成，请重试。');
    historyView(data,cursor !== null);
  } catch (error) { if (current()) historyState = { ...historyState, loading:false, error:error.message }; }
  finally { clearTimeout(timer); if (historyRead === owner) { historyRead = null; historyState.loading = false; publishModelView(); } }
}
function scheduleDraftSave() {
  cancelDraftTimer(); rememberDraft();
  if (!canReadHistory() || !activeConversationId || conversationReadOnly || pendingRequests.has('session')) return;
  draftTimer = setTimeout(() => { draftTimer = null; void saveDraft(); },700); draftTimer?.unref?.();
}
async function saveDraft() {
  if (!canReadHistory() || !activeConversationId || conversationReadOnly || pendingRequests.has('session') || draftSaveWork) return;
  const id = activeConversationId, cached = conversationDrafts.get(id); if (!cached?.dirty) return;
  const owner = beginRequest('draft',{ conversationId:id, revision:cached.revision, accountEpoch });
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  draftSaveController = controller;
  let timer, saved = false;
  const work = (async () => {
    try {
      const deadline = new Promise((_,reject) => { timer = setTimeout(() => { controller?.abort(); reject(new Error('草稿保存未确认。')); },12000); timer?.unref?.(); });
      await Promise.race([post('chat/draft',{ conversationId:id, draft:{text:cached.text,includeSelection:cached.includeSelection} },controller ? {signal:controller.signal} : {}),deadline]);
      saved = true;
      if (owner.accountEpoch !== accountEpoch) return;
      const latest = conversationDrafts.get(id);
      // A turn may have superseded the request map while waiting for this
      // exact write. Its ACK can clear only this revision's dirty marker;
      // it never writes text or selection back into the composer.
      if (latest?.revision === owner.revision) latest.dirty = false;
    } catch (error) {
      if (ownsRequest(owner) && owner.accountEpoch === accountEpoch && activeConversationId === id) { historyState.error = error.message; publishModelView(); }
    } finally { clearTimeout(timer); finishRequest(owner); }
  })();
  draftSaveWork = work;
  try { await work; } finally {
    if (draftSaveController === controller) draftSaveController = null;
    if (draftSaveWork === work) {
      draftSaveWork = null;
      if (saved && activeConversationId === id && conversationDrafts.get(id)?.dirty && !pendingRequests.has('session')) scheduleDraftSave();
    }
  }
}
function restoreConversationDraft(id, data, preserveInitial = false) {
  let draft = conversationDrafts.get(id);
  if (!draft && preserveInitial && $('prompt').value) draft = currentDraft();
  if (!draft) draft = data && typeof data.text === 'string' ? {text:data.text.slice(0,16000),includeSelection:data.includeSelection === true} : {text:'',includeSelection:false};
  $('prompt').value = draft.text; $('prompt').style.height = '';
  $('include-document').checked = false; $('include-selection').checked = modelContextAllowed && draft.includeSelection === true;
  draftRevision++; conversationDrafts.set(id,{ ...draft, revision:draftRevision, dirty:false });
}
// This is a display projection of the existing request/session owner. The
// model-only layout never opens its own transport or owns another conversation.
function publishModelView() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('buildx-model-view', { detail: {
    enabled: modelUiEnabled && modelContextAllowed, ready, commandsReady, busy, confirmedWrite,
    blocked: busy || modelPermissionChecking() || pendingRequests.has('session') || commandPending(), account: modelAccount, confirmation: modelConfirmation,
    toolCatalog, ...(commandCatalog!==null?{commandCatalog}:{}), hasMessages: messages.length > 0, accountEpoch, contextEpoch, mcpCandidatesAvailable,
    history:{ ...historyState, available:historyEnabled(), activeId:activeConversationId || historyState.activeId },
    activeId:activeConversationId, commandConversationId:commandConversationId(), commandIdentityKey:commandIdentityKey(), readOnly:historyEnabled() && conversationReadOnly,
    modelPermission, modelPermissionPending:modelPermissionChecking(), modelPermissionMessage,
    modelPermissionStatusRefreshAvailable:modelPermissionPending?.delayed===true||serverBusyOperation==='model-permission-check',
    modelPermissionStatusRefreshing:Boolean(statusRead),
    accessPolicy,accessPolicyPending:Boolean(accessPolicyPending),accessPolicyMessage,
    modelReceipt,modelReceiptPending:Boolean(modelReceiptPending),modelReceiptPendingAction:modelReceiptPending?.action??null,modelReceiptMessage,modelReceiptAckSubmitted,
    terminal,terminalPendingAction:terminalPending?.action??null,terminalMessage,terminalStale,
    persistence:lastSession?.conversation?.persistence || lastSession?.persistence || null,
    directCommandsAvailable:directCommandsAvailable && Boolean(commandConversationId()), commands:commandIdentityVisible ? [...commandResults.values()] : [],
    commandStopPending:pendingRequests.has('interrupt'),
    commandCheckPending:pendingRequests.has('command-check') || commandChecking(),
    turnAttachmentsAvailable:attachmentsEnabled(), attachments:pendingAttachments().map(attachmentSummary), attachmentReading:Boolean(attachmentRead), attachmentEditBlocked:pendingRequests.has('session'),
  } }));
}
function publishModelPicker(){
  if(typeof window==='undefined'||typeof CustomEvent!=='function')return;
  const model=modelChoices.find(item=>item.model===selectedModel),choices=selectedModelEfforts(),efforts=choices??[];
  window.dispatchEvent(new CustomEvent('buildx-model-picker-view',{detail:{enabled:modelUiEnabled&&modelSelectionAvailable,ready,blocked:busy||pendingRequests.has('session'),models:modelChoices,selected:selectedModel,efforts,selectedEffort,effortInvalid:choices===null,effortUnknown:Boolean(model&&choices!==null&&Object.hasOwn(model,'supportedReasoningEfforts')&&!efforts.length),loading:modelPickerLoading,error:modelPickerError}}));
}
function selectedModelEfforts(){
  const model=modelChoices.find(item=>item.model===selectedModel),raw=model?.supportedReasoningEfforts;
  if(raw===undefined)return [];
  if(!Array.isArray(raw)||raw.length>32)return null;
  const values=new Set();
  for(const option of raw){if(!option||typeof option.reasoningEffort!=='string'||!option.reasoningEffort||option.reasoningEffort.length>80||typeof option.description!=='string'||option.description.length>2000||values.has(option.reasoningEffort))return null;values.add(option.reasoningEffort);}
  return raw;
}
// A saved selection is a display preference. The current connection's catalog
// must still advertise both the model and effort before they can be sent.
function readModelPreference(){
  try{
    const text=localStorage.getItem(modelPreferenceKey);if(typeof text!=='string'||text.length>2048)return null;
    const value=JSON.parse(text),valid=(s,max,empty=false)=>typeof s==='string'&&(empty||s.length>0)&&s.length<=max&&!/[\u0000-\u001f\u007f]/.test(s);
    return value&&Object.keys(value).sort().join(',')==='effort,model,version'&&value.version===1&&valid(value.model,200)&&valid(value.effort,80,true)?{version:1,model:value.model,effort:value.effort}:null;
  }catch{return null;}
}
function rememberModelPreference(){
  if(!selectedModel||selectedModel.length>200||!effortSelectionReady())return;
  modelPreference={version:1,model:selectedModel,effort:selectedEffort};
  try{localStorage.setItem(modelPreferenceKey,JSON.stringify(modelPreference));}catch{/* The current page can still retain the user's choice. */}
}
function selectModel(value,preferredEffort){
  const previous=value===selectedModel?selectedEffort:undefined;
  selectedModel=value;const choices=selectedModelEfforts(),model=modelChoices.find(item=>item.model===value),effort=preferredEffort??previous;
  selectedEffort=choices?.some(item=>item.reasoningEffort===effort)?effort:choices?.some(item=>item.reasoningEffort===model?.defaultReasoningEffort)?model.defaultReasoningEffort:'';
}
function effortSelectionReady(){const choices=selectedModelEfforts();return choices!==null&&(!choices.length||choices.some(item=>item.reasoningEffort===selectedEffort));}
function clearModelPicker(){modelPickerRevision++;modelChoices=[];selectedModel='';selectedEffort='';modelPickerError='';modelPickerLoading=false;modelPickerAttempted=false;}
async function loadModels(){
  if(!modelUiEnabled||!modelSelectionAvailable||!ready||busy||modelPickerLoading)return;
  const preference=modelPreference??(selectedModel?{model:selectedModel,effort:selectedEffort}:null);
  const revision=++modelPickerRevision,epoch=accountEpoch,identity={...modelPickerIdentity};modelPickerLoading=true;modelPickerAttempted=true;modelPickerError='';modelChoices=[];selectedModel='';selectedEffort='';updateButtons();
  try{
    const result=await post('models');
    if(revision!==modelPickerRevision||epoch!==accountEpoch||identity.connectionGeneration!==modelPickerIdentity.connectionGeneration||identity.accountRevision!==modelPickerIdentity.accountRevision)return;
    if(!Array.isArray(result.models)||result.models.length>2000)throw new Error('模型目录格式无效。');
    modelChoices=result.models.filter(item=>item&&typeof item.model==='string'&&typeof item.displayName==='string'&&typeof item.isDefault==='boolean');
    if(preference&&modelChoices.some(item=>item.model===preference.model)){
      selectModel(preference.model,preference.effort);
      if(preference.effort&&selectedModelEfforts()?.length&&selectedEffort!==preference.effort)modelPickerError=selectedEffort?'上次的思考强度当前不可用，已使用此模型的默认强度。':'上次的思考强度当前不可用，请重新选择。';
    }else{
      const defaults=modelChoices.filter(item=>item.isDefault);selectModel(defaults.length===1?defaults[0].model:'');
      if(preference)modelPickerError=selectedModel?'上次的模型当前不可用，已使用当前连接的默认模型。':'上次的模型当前不可用，请重新选择。';
    }
    if(!modelChoices.length)modelPickerError='当前账号没有可选模型。';
  }catch(error){if(revision===modelPickerRevision)modelPickerError=error.message||'模型目录读取失败。';}
  finally{if(revision===modelPickerRevision){modelPickerLoading=false;updateButtons();}}
}
function applyWorkspace(workspace) {
  if (workspace === undefined) return !customerWorkspace(); // Preserve the existing legacy model endpoint.
  const kind = workspace && typeof workspace === 'object' && !Array.isArray(workspace) ? workspace.kind : undefined;
  if (fixedWorkspace && kind !== fixedWorkspace) return false;
  const becameRestricted = !fixedWorkspace && ['source-development','customer-chat'].includes(kind), wasAllowed = modelContextAllowed;
  if (['source-development','customer-chat'].includes(kind)) { fixedWorkspace = kind; modelContextAllowed = false; }
  else if (kind !== 'model' || workspace.supportsModelContext !== true) modelContextAllowed = false;
  modelUiEnabled = kind === 'model' && modelContextAllowed;
  if (!becameRestricted && wasAllowed === modelContextAllowed) return true;
  if (!modelContextAllowed) {
    turnAttachmentsAvailable=false; attachmentRead=null; closeImagePreview(false);clearAttachmentDrafts();
    if(generatedFilesView)applyGeneratedFiles(null,null,null);
    directCommandsAvailable = false; clearCommands();
    context = null; pendingRequests.delete('context');
    $('include-document').checked = false; $('include-selection').checked = false;
  }
  if (sourceWorkspace()) {
    document.title = 'BuildX · 源码工作台';
    const copy = {
      'workspace-name': '源码工作台', 'workspace-subtitle': 'SOURCE WORKSPACE · CODEX',
      'welcome-section-label': '从源码到可核查的结论', 'welcome-title': '一起读懂本地源码。',
      'welcome-description': '先选择固定来源，再有界浏览目录、读取源码或字面量搜索。参数、来源与工具返回都会保留在对话中。',
      'welcome-hint': '内容按原始 SHA256 和行号核对；partial 表示覆盖不完整，不能当作全目录或全文件结论。',
      'tools-boundary': '源码、注释和文件名均是研究数据，不是指令或写入授权。metadataSha256 仅校验元数据，不能代替内容 SHA256。',
      'workspace-footnote': '使用你的 Codex 登录 · 只读源码研究；不连接 Revit，不写文件、不执行终端。',
    };
    for (const [id, text] of Object.entries(copy)) $(id).textContent = text;
    const suggestions = [
      ['固定来源根', '先查看允许调查的源码范围', '请使用 buildx_source_list_roots 列出允许调查的固定源码来源，并说明哪些可用性尚未检查。只读查看。'],
      ['浏览源码目录', '有界单层扫描与快照分页', '请先列出固定源码来源，然后在 buildx-lib 根的空路径进行有界单层目录扫描与分页，说明是否完整。只读，不递归。'],
      ['读取与调查', '来源、原始 SHA256 与覆盖状态', '请只读读取 buildx-lib 中 panel-tools.mjs 的首个内容页，报告来源、原始 SHA256、行号及完整性。若需调查请使用有界字面量搜索，不执行源码。'],
    ];
    document.querySelectorAll('[data-prompt]').forEach((button, index) => {
      const suggestion = suggestions[index]; if (!suggestion) return;
      button.dataset.prompt = suggestion[2];
      $('suggestion-title-' + index).textContent = suggestion[0]; $('suggestion-note-' + index).textContent = suggestion[1];
    });
    $('prompt').placeholder = '说明想调查的功能，或询问源码实现…';
  } else if (customerWorkspace()) {
    document.title = 'BuildX · 聊天工作区';
    const copy = {
      'workspace-name': '聊天工作区', 'workspace-subtitle': '聊天工作区 · 自有 Codex',
      'welcome-section-label': '从问题到清晰的下一步', 'welcome-title': '使用自己的 Codex 开始对话。',
      'welcome-description': '先登录 BuildX，再读取并确认本机 Codex 连接。这里提供独立聊天，不附加模型或选择上下文。',
      'welcome-hint': '本机连接确认不代表取得稳定账号 ID 或工作区 ID；请核对账号与连接状态。',
      'tools-boundary': '本聊天工作区没有模型或源码工具。对话回复不代表已执行建模或文件操作。',
      'workspace-footnote': '聊天工作区 · 自有 Codex；BuildX 登录与本机 Codex 连接分别核验。',
    };
    for (const [id, text] of Object.entries(copy)) $(id).textContent = text;
    const suggestions = [
      ['梳理需求', '把想法整理成可执行的步骤', '请帮我梳理这个需求，先明确目标、已有条件和需要我决定的问题。'],
      ['学习与解释', '逐步解释概念和实现思路', '请结合一个简单例子解释我的问题，并给出可核查的依据和不确定项。'],
      ['检查方案', '核对假设、边界与下一步', '请检查我的方案，指出主要假设、缺失信息与最关键的下一步。'],
    ];
    document.querySelectorAll('[data-prompt]').forEach((button,index) => {
      const suggestion = suggestions[index]; if (!suggestion) return;
      button.dataset.prompt = suggestion[2];
      $('suggestion-title-' + index).textContent = suggestion[0]; $('suggestion-note-' + index).textContent = suggestion[1];
    });
    $('prompt').placeholder = '输入问题，与自己的 Codex 对话…';
  } else if (!modelContextAllowed) {
    $('welcome-hint').textContent = '当前工作区未开放模型上下文。';
    $('workspace-footnote').textContent = '工作区能力尚未确认；模型上下文已停用，请核对本地服务配置。';
  }
  if (becameRestricted) {
    // A count-only SSE state does not transfer the previous workspace's
    // catalog. Clear it through its owner and wait for source-owned metadata.
    sourceToolCount = 0;
    renderTools({ workspace, toolCount: 0, toolCatalog: [] });
    for (const entry of messageNodes.values()) { entry.signature = null; entry.toolSignature = null; }
    if (messages.length) renderConversation();
  }
  renderContext(); updateButtons();
  return true;
}
function updateButtons() {
  if (dynamicApproval && (['pending','submitting'].includes(dynamicApproval.state) && !dynamicApprovalCurrent(dynamicApproval) || dynamicApprovalAwaitingResult(dynamicApproval) && !dynamicApprovalScopeCurrent(dynamicApproval))) invalidateDynamicApproval();
  if (!busy && !commandPending()) commandStopUnavailable = false;
  const permissionChecking=modelPermissionChecking();
  const blocked = busy || permissionChecking || pendingRequests.has('session') || commandPending();
  const readOnly = historyEnabled() && conversationReadOnly;
  const switchingConversation = historyEnabled() && pendingRequests.has('session');
  const binding=steerBinding(), text=$('prompt').value.trim();
  const conversationId=lastSession?.conversation?.id,pendingSteer=pendingRequests.get('steer');
  if(pendingSteer&&pendingSteer.accountEpoch===accountEpoch&&conversationId===pendingSteer.conversationId&&(!binding||binding.turnId!==pendingSteer.turnId||pendingSteer.connectionGeneration!==modelPickerIdentity.connectionGeneration||pendingSteer.accountRevision!==modelPickerIdentity.accountRevision))markSteerUnknown(pendingSteer);
  if(steerFeedbackBinding&&conversationId!==steerFeedbackBinding.conversationId){steerFeedbackBinding=null;steerFeedbackKind=null;$('steer-feedback').hidden=true;$('steer-feedback').textContent='';}
  const receiptBlocked=steerReceiptsBlocked(conversationId),hasUncertain=hasUncertainSteers(conversationId),receiptProjection=projectedSteerReceipts.get(conversationId);
  if(receiptBlocked){steerFeedbackBinding={conversationId};steerFeedbackKind='invalid';$('steer-feedback').hidden=false;$('steer-feedback').textContent='补充指令回执尚未核对，暂不能发送；请刷新状态后核对。';}
  else if(hasUncertain&&(!steerFeedbackBinding||!['pending','unknown'].includes(steerFeedbackKind))){steerFeedbackBinding={conversationId};steerFeedbackKind='unknown';$('steer-feedback').hidden=false;$('steer-feedback').textContent='补充指令等待回执或结果尚未确认，请核对记录；不要重复提交相同内容。';}
  else if(!hasUncertain&&['unknown','invalid'].includes(steerFeedbackKind)){steerFeedbackBinding=null;steerFeedbackKind=null;$('steer-feedback').hidden=true;$('steer-feedback').textContent='';}
  if(receiptProjection&&!receiptBlocked&&!hasUncertain&&!['pending','error'].includes(steerFeedbackKind)){
    const last=receiptProjection?.records.at(-1);steerFeedbackBinding=last?{conversationId}:null;steerFeedbackKind=last?.status??null;
    $('steer-feedback').hidden=!last;$('steer-feedback').textContent=last?.status==='accepted'?'最近的补充指令已由 Codex 接收，是否执行尚待确认。':last?.status==='not_sent'?'最近的补充指令未发送。':'';
  }
  $('send').disabled = !ready || blocked || selectionPreviewInFlight > 0 || (selectionReadUnconfirmed && $('include-selection').checked) || readOnly || Boolean(attachmentRead) || Boolean(skillRead) || staleSkillSelection || modelUiEnabled&&modelSelectionAvailable&&(!selectedModel||!effortSelectionReady()) || historyEnabled() && persistenceFailed() || !text || receiptBlocked || isUncertainSteer(conversationId,text) || turnSendBlocked(conversationId);
  $('steer').hidden = !(modelUiEnabled && steerAvailable && busy) || permissionChecking;
  $('steer').disabled = !binding || !text || text.length>16000 || pendingRequests.has('steer') || pendingRequests.has('interrupt') || visibleInputId!==null || ['pending','submitting'].includes(dynamicApproval?.state) || Boolean(attachmentRead) || pendingAttachments().length>0 || historyEnabled() && persistenceFailed() || receiptBlocked || isUncertainSteer(conversationId,text);
  const waitHint=$('composer-wait');
  waitHint.hidden=!(modelUiEnabled&&busy&&text&&!readOnly);
  if(!waitHint.hidden){
    const guidance=!$('steer').hidden&&!$('steer').disabled?'可补充当前任务，或等本轮结束后发送这条草稿。':'当前任务处理中。可继续编辑，结束后手动发送。';
    if(waitHint.textContent!==guidance)waitHint.textContent=guidance;
  }
  $('prompt').readOnly = readOnly || switchingConversation;
  $('new-chat').disabled = blocked;
  $('stop').hidden = !busy || permissionChecking || commandRunning() || commandPending() || commandStopUnavailable;
  $('stop').disabled=pendingRequests.has('interrupt');
  $('activity').hidden = !busy&&!permissionChecking;
  if(permissionChecking)$('activity-text').textContent=modelPermissionPending&&modelPermissionMessage||'正在等待 Revit 核实当前模型与执行权限…';
  // A lost stream may retain an old busy view. The reachable recovery action
  // only reads status first; it cannot POST until that fresh proof is nonbusy.
  $('reconnect').disabled = pendingRequests.has('session') || commandPending() || Boolean(statusRead) || (busy && !(customerWorkspace() && customerRecovery));
  $('context-panel').hidden = !modelContextAllowed;
  for (const id of ['include-document', 'include-selection']) {
    $(id).disabled = !modelContextAllowed || readOnly || switchingConversation; if (!modelContextAllowed) $(id).checked = false;
  }
  $('refresh-context').disabled = !modelContextAllowed || blocked || readOnly || pendingRequests.has('context') || !ready || !Object.values(contextFlags()).some(Boolean) || Boolean(selectionReadUnconfirmed);
  $('refresh-context').textContent = pendingRequests.has('context') ? '读取中…' : '刷新';
  $('skills-panel').hidden=!modelUiEnabled;
  $('skills-refresh').disabled=!skillsSupported||!ready||blocked||Boolean(skillRead)||!skillsConversation();
  $('skills-clear-stale').hidden=!staleSkillSelection;
  $('skills-clear-stale').disabled=blocked||Boolean(skillRead);
  document.querySelectorAll('#skills-list input').forEach(input=>{input.disabled=input.dataset.skillSelectable==='false'||!ready||blocked||Boolean(skillRead);});
  document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = !ready || blocked || readOnly; });
  publishModelView();
  publishModelPicker();
}
function renderTools(state) {
  if (customerWorkspace()) {
    toolCatalog = []; $('tool-list').replaceChildren(); $('tool-count').textContent = '工具范围：0项';
    $('tool-note').textContent = '本工作区未开放模型或源码工具；对话使用客户自有 Codex。';
    return;
  }
  const ownsCatalog = !sourceWorkspace() || state.workspace?.kind === 'source-development';
  if (Array.isArray(state.toolCatalog) && ownsCatalog) {
    toolCatalog = modelUiEnabled ? modelToolEntries(state.toolCatalog) : state.toolCatalog;
    $('tool-list').replaceChildren(...toolCatalog.map(tool => {
      const item = node('li'), heading = node('div', 'tool-heading');
      heading.append(node('span', '', tool.label || tool.name), node('span', 'tool-badge' + (tool.readOnly ? '' : ' writes'), tool.readOnly ? '只读' : '操作'));
      item.append(heading, node('p', '', tool.description || ''), node('code', '', tool.name)); return item;
    }));
  }
  if (sourceWorkspace() && ownsCatalog) {
    if (!toolCatalog.length) sourceToolCount = 0;
    else if (Number.isInteger(state.toolCount)) sourceToolCount = state.toolCount;
  }
  const count = sourceWorkspace() ? sourceToolCount : Number.isInteger(state.toolCount) ? state.toolCount : 0;
  $('tool-count').textContent = toolCatalog.length ? (modelUiEnabled ? modelToolCountLabel(toolCatalog) : `已加载 ${count} / ${toolCatalog.length} 项`) : '正在读取目录';
  $('tool-note').textContent = sourceWorkspace() && !toolCatalog.length
    ? '正在读取源码工具目录；尚未取得本工作区的工具说明。'
    : count > 0
    ? sourceWorkspace() ? '只读源码目录已加载；工具返回仍需核对来源、原始 SHA256 和覆盖状态，目录可见不等于每项已运行。'
      : '只读查询通过 MCP 连接；目录中的操作经统一入口调用，并核对权限、Revit 连接、宿主版本及当前文档。目录可见不等于操作已就绪或已执行。'
    : '当前尚未确认工具加载。目录中的功能不代表已连接或已运行。';
}
function status(state = {}) {
  if (state.confirmedWrite === true) confirmedWrite = true;
  if (!applyWorkspace(state.workspace)) { if (customerWorkspace()) { ready = false; updateButtons(); } return false; }
  if(Object.hasOwn(state,'busyOperation'))serverBusyOperation=state.busyOperation==='model-permission-check'?'model-permission-check':null;
  else if(state.busy===false)serverBusyOperation=null;
  if(modelPermissionPending&&serverBusyOperation==='model-permission-check')modelPermissionPending.sawServerCheck=true;
  if(Object.hasOwn(state,'steerAvailable'))steerAvailable=modelUiEnabled&&state.steerAvailable===true;
  if(Object.hasOwn(state,'steerReceiptsAvailable')){
    const wasAvailable=steerReceiptsAvailable;steerReceiptsAvailable=modelUiEnabled&&state.steerReceiptsAvailable===true;
    if(steerReceiptsAvailable&&!wasAvailable&&lastSession)reconcileSteerReceipts(lastSession);
  }
  if(!modelUiEnabled){steerAvailable=false;steerReceiptsAvailable=false;}
  if(Object.hasOwn(state,'modelSelectionAvailable'))modelSelectionAvailable=modelUiEnabled&&state.modelSelectionAvailable===true;
  if(!modelUiEnabled){modelSelectionAvailable=false;clearModelPicker();}
  let modelIdentityChanged=false;
  for(const [key,value] of [['connectionGeneration',state.connectionGeneration],['accountRevision',state.codexAccount?.accountRevision]]){
    if(Number.isSafeInteger(value)&&value>=0){if(modelPickerIdentity[key]!==null&&modelPickerIdentity[key]!==value)modelIdentityChanged=true;modelPickerIdentity[key]=value;}
  }
  if(modelIdentityChanged||state.error===true||state.codexAccount?.status==='invalidated')clearModelPicker();
  if(modelIdentityChanged||state.error===true||state.codexAccount?.status==='invalidated'||!modelUiEnabled){clearModelPermission('连接或账号已变化，权限尚未核实。');clearAccessPolicy('连接或账号已变化，访问范围尚未核实。');}
  // Receipt ownership belongs to the local account and original operation.
  // A Codex disconnect or new AI connection cannot discard that recovery path.
  const receiptAccountChanged=Object.hasOwn(state,'account')&&modelAccount!==null&&(state.account?.signedIn!==modelAccount.signedIn||state.account?.user?.id!==modelAccount.user?.id||state.account?.required!==modelAccount.required);
  if(!modelUiEnabled||receiptAccountChanged)clearModelReceipt();
  if(!modelUiEnabled||receiptAccountChanged)clearTerminal();
  else if(modelIdentityChanged||state.error===true||state.codexAccount?.status==='invalidated')clearTerminal({keepJob:true});
  if(Object.hasOwn(state,'skillsAvailable'))skillsSupported=modelUiEnabled&&state.skillsAvailable===true;
  if(!modelUiEnabled)skillsSupported=false;
  if(Object.hasOwn(state,'mcpCandidatesAvailable'))mcpCandidatesAvailable=modelUiEnabled&&state.mcpCandidatesAvailable===true;
  if(!modelUiEnabled)mcpCandidatesAvailable=false;
  if(modelIdentityChanged||state.error===true||state.codexAccount?.status==='invalidated'||!mcpCandidatesAvailable){
    mcpCandidateRead=null;
    if(typeof window!=='undefined'&&typeof CustomEvent==='function')window.dispatchEvent(new CustomEvent('buildx-mcp-candidates-result',{detail:{status:'cleared'}}));
  }
  if(modelIdentityChanged||state.error===true||state.codexAccount?.status==='invalidated')observedSkillsRevision=null;
  if(Number.isSafeInteger(state.skillsRevision))observedSkillsRevision=observedSkillsRevision===null?state.skillsRevision:Math.max(observedSkillsRevision,state.skillsRevision);
  if(modelIdentityChanged||state.error===true||state.codexAccount?.status==='invalidated'||!skillsSupported){
    if(skillChoices.length||skillSelection.size||skillRead||skillRevision!==null||staleSkillSelection)clearSkills('连接或技能列表已变化，请重新读取。');
  }else if(Number.isSafeInteger(state.skillsRevision)&&skillRevision!==null&&state.skillsRevision>skillRevision){
    clearSkills('技能列表已变化，请重新读取并选择，或取消失效的选择。',{preserveIntent:true});
  }
  if (Object.hasOwn(state,'directCommandsAvailable')) directCommandsAvailable = modelUiEnabled && state.directCommandsAvailable === true;
  if(Object.hasOwn(state,'commandReadiness'))independentCommands=modelUiEnabled&&state.commandReadiness==='local';
  if(modelUiEnabled&&Array.isArray(state.commandCatalog)&&state.commandCatalog.length<=128)commandCatalog=state.commandCatalog.filter(item=>item&&typeof item.id==='string'&&typeof item.tool==='string'&&typeof item.enabled==='boolean');
  if(!modelUiEnabled){commandCatalog=null;independentCommands=false;}
  const previousCommandIdentity=commandIdentityKey();
  commandIdentity(state);
  if(previousCommandIdentity!==commandIdentityKey() && (messages.length||generatedFilesView))renderConversation();
  if (Object.hasOwn(state, 'account')) modelAccount = state.account;
  if (Object.hasOwn(state, 'codexConfirmation')) modelConfirmation = state.codexConfirmation;
  if (!modelUiEnabled) { directCommandsAvailable = false; clearCommands(); }
  const wasHistoryAvailable = historyAvailable;
  if (Object.hasOwn(state,'historyAvailable')) historyAvailable = modelUiEnabled && state.historyAvailable === true;
  if (!modelUiEnabled) historyAvailable = false;
  if (Object.hasOwn(state,'turnAttachmentsAvailable')) turnAttachmentsAvailable = modelUiEnabled && state.turnAttachmentsAvailable === true;
  if (!modelUiEnabled) turnAttachmentsAvailable = false;
  if ((customerWorkspace() || modelUiEnabled && directCommandsAvailable) && typeof state.busy === 'boolean' && state.busy !== busy) { busy = state.busy; busyRevision++; }
  if (state.busy === false) commandStopUnavailable = false;
  interruption(state);
  const recoveryConnectionReady=!streamRecoveryPending||streamConnected&&state.error!==true&&(recoveryWorkspace===null||state.workspace?.kind===recoveryWorkspace);
  ready = Boolean(state.ready && recoveryConnectionReady && (customerWorkspace()
    ? state.account?.configured === true && state.account.required === true && state.account.signedIn === true && state.codexConfirmation?.localConnectionConfirmed === true
    : !state.account?.required || state.account.signedIn && state.codexConfirmation?.localConnectionConfirmed === true));
  commandsReady=directCommandsAvailable&&recoveryConnectionReady&&(typeof state.commandsReady==='boolean'?state.commandsReady:ready);
  $('status-dot').className = 'dot ' + (ready ? 'ready' : state.error ? 'error' : '');
  $('status-text').textContent = streamRecoveryPending&&!streamConnected&&state.ready ? '后台已就绪，正在恢复面板连接…' : state.message || '正在连接 Codex…';
  renderCodexSetup(state.setupIssue);
  renderTools(state); updateButtons();
  if(ready&&modelSelectionAvailable&&!modelPickerAttempted&&!modelPickerLoading)queueMicrotask(()=>void loadModels());
  if (!wasHistoryAvailable && historyAvailable) void refreshHistory();
  if(typeof window!=='undefined'&&typeof window.dispatchEvent==='function'&&typeof CustomEvent==='function')window.dispatchEvent(new CustomEvent('buildx-status',{detail:state}));
  return true;
}
function appendInline(parent, tokens) {
  for (const token of tokens) {
    if (token.type === 'text') { parent.append(document.createTextNode(token.text)); continue; }
    const element = node(({ strong: 'strong', code: 'code', link: 'a' })[token.type] || 'span');
    if (token.type === 'code') element.textContent = token.text;
    else appendInline(element, token.children || []);
    if (token.type === 'link') { element.href = token.href; element.target = '_blank'; element.rel = 'noopener noreferrer'; }
    parent.append(element);
  }
}
function renderMarkdown(parent, text, message) {
  const fragment = document.createDocumentFragment();
  let codeBlockIndex = 0;
  for (const block of markdownBlocks(text)) {
    if (block.type === 'code') {
      codeBlockIndex++;
      const wrap = node('div', 'code-block'), heading = node('div', 'code-heading'), copy = node('button', 'copy-code', '复制');
      copy.type = 'button'; copy.setAttribute('aria-label', '复制代码');
      copy.addEventListener('click', async () => {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板，请选择代码手动复制。');
          await navigator.clipboard.writeText(block.text); copy.textContent = '已复制';
          setTimeout(() => { copy.textContent = '复制'; }, 1800);
        } catch (error) { notice(error.message || '复制失败，请选择代码手动复制。'); }
      });
      heading.append(node('span', '', block.language || 'code'), copy);
      if (modelUiEnabled && modelContextAllowed && message?.status === 'completed' && /^(?:csharp|cs|c#)$/i.test(block.language)) {
        const owner={accountEpoch,contextEpoch,identityKey:commandIdentityKey(),conversationId:commandConversationId(),messageId:message.id,blockIndex:codeBlockIndex,text:message.text,code:block.text};
        const draft=node('button','copy-code','作为命令草稿');draft.type='button';
        draft.addEventListener('click',()=>{
          const current=messages.find(value=>value.id===owner.messageId);
          if(!modelUiEnabled || !modelContextAllowed || owner.accountEpoch!==accountEpoch || owner.contextEpoch!==contextEpoch || owner.identityKey!==commandIdentityKey() || !owner.conversationId || owner.conversationId!==commandConversationId() || current?.status!=='completed' || current.role!=='assistant' || current.text!==owner.text || historyEnabled() && conversationReadOnly)return;
          window.dispatchEvent(new CustomEvent('buildx-command-draft-from-chat',{detail:{accountEpoch:owner.accountEpoch,contextEpoch:owner.contextEpoch,identityKey:owner.identityKey,conversationId:owner.conversationId,messageId:owner.messageId,blockIndex:owner.blockIndex,code:owner.code}}));
        });
        heading.append(draft);
      }
      const pre = node('pre'); pre.append(node('code', '', block.text)); wrap.append(heading, pre); fragment.append(wrap); continue;
    }
    if (block.type === 'table') {
      const wrap = node('div', 'table-wrap'), table = node('table'), head = node('thead'), header = node('tr'), body = node('tbody');
      block.header.forEach(tokens => { const cell = node('th'); cell.scope = 'col'; appendInline(cell, tokens); header.append(cell); }); head.append(header);
      block.rows.forEach(cells => { const row = node('tr'); cells.forEach(tokens => { const cell = node('td'); appendInline(cell, tokens); row.append(cell); }); body.append(row); });
      table.append(head, body); wrap.append(table); fragment.append(wrap); continue;
    }
    if (block.type === 'list') {
      const list = node(block.ordered ? 'ol' : 'ul'); if (block.ordered && block.start > 1) list.start = block.start;
      block.items.forEach(tokens => { const item = node('li'); appendInline(item, tokens); list.append(item); }); fragment.append(list); continue;
    }
    const element = node(block.type === 'heading' ? 'h' + block.level : block.type === 'quote' ? 'blockquote' : 'p');
    appendInline(element, block.children || []); fragment.append(element);
  }
  parent.replaceChildren(fragment);
}
const originalReadReceiptLabels={received:'原回执确认查询成功',expired:'原请求已过期，未执行',not_started:'原回执确认未执行',failed:'原回执确认失败'};
function toolCard(messageId, tool, receipt) {
  const id = messageId + ':' + tool.id;
  const currentStatus = ['running', 'returned', 'failed', 'unknown'].includes(tool.status) ? tool.status : 'unknown';
  const receiptLabel=currentStatus==='unknown'&&receipt&&Object.hasOwn(originalReadReceiptLabels,receipt.status)?originalReadReceiptLabels[receipt.status]:null;
  const displayedStatus=receiptLabel?(receipt.status==='received'?'returned':'failed'):currentStatus;
  const details = node('details', 'tool-call ' + displayedStatus), summary = node('summary');
  details.open = openedTools.has(id);
  details.addEventListener('toggle', () => { if (!details.isConnected) return; if (details.open) openedTools.add(id); else openedTools.delete(id); });
  summary.append(node('span', 'tool-indicator'), node('span', 'tool-name', tool.label || tool.name || '工具调用'), node('span', 'tool-status', receiptLabel||toolStatus(currentStatus)));
  const content = node('div', 'tool-details');
  content.append(node('h4', '', tool.name || '工具'), node('h4', '', '调用参数'), node('pre', '', previewText(tool.argumentsPreview)));
  if (tool.resultPreview !== undefined && tool.resultPreview !== null) content.append(node('h4', '', '返回内容'), node('pre', '', previewText(tool.resultPreview)));
  if (tool.error) content.append(node('h4', '', '错误'), node('pre', 'tool-error', previewText(tool.error)));
  if(receiptLabel)content.append(node('h4','','原回执核对'),node('p','',receiptLabel+'。原请求 '+receipt.requestId+'。本轮 Codex 回复保留提交时的结果。'));
  if (currentStatus === 'unknown'&&!receiptLabel) content.append(node('h4', '', sourceWorkspace()
    ? '尚未取得确定结果；请按来源、哈希和覆盖状态回查。' : customerWorkspace()
      ? '尚未取得确定结果；请先核对本轮回执。' : '尚未取得确定结果；模型写入结果未知时请先回查。'));
  details.append(summary, content); return details;
}
const generatedFileName = value => typeof value === 'string' && value.length <= 255 && /^[^\\/:*?"<>|\u0000-\u001f]+\.[a-z0-9]+$/iu.test(value);
const generatedFileId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

function applyGeneratedFiles(value, pendingValue, conversationId) {
  const list = $('generated-files');
  const visibleConversation = lastSession?.conversation?.id;
  if (!modelUiEnabled || !modelContextAllowed || !conversationId || conversationId !== visibleConversation) {
    generatedFilesView = null;
    list.replaceChildren();
    list.hidden = true;
    return;
  }
  const files = Array.isArray(value) ? value.filter(file => file?.kind === 'file' && generatedFileId(file.artifactId) && generatedFileName(file.fileName) && Number.isSafeInteger(file.bytes) && file.bytes > 0).slice(0, 32) : [];
  const pending = Array.isArray(pendingValue) ? pendingValue.filter(file => generatedFileId(file?.artifactId) && generatedFileName(file.fileName)).slice(0, 32) : [];
  const entries = new Map(pending.map(({artifactId,fileName}) => [artifactId,{artifactId,fileName,check:true}]));
  for (const {artifactId,fileName,bytes} of files) entries.set(artifactId,{artifactId,fileName,bytes,check:false});
  const signature = JSON.stringify([conversationId, accountEpoch, commandIdentityKey(), [...entries.values()]]);
  if (generatedFilesView?.signature === signature) return;
  const shouldScroll = nearBottom();
  const owner = {signature,conversationId,accountEpoch,identityKey:commandIdentityKey()};
  generatedFilesView = owner;
  const feedback = node('p','generated-file-feedback');
  feedback.setAttribute('role','status');
  const cards = [...entries.values()].map(({artifactId,fileName,bytes,check}) => {
    const action = check ? '核对原回执' : '打开文件';
    const label = check ? action+' · '+fileName : fileName+' · '+(bytes < 1024 ? bytes+' B' : Math.ceil(bytes/1024)+' KiB');
    const card = node('button','model-sent-file generated-file',label);
    card.type = 'button';
    card.title = action;
    card.setAttribute('aria-label',action+' '+fileName);
    const isCurrent = () => generatedFilesView === owner && modelUiEnabled && modelContextAllowed && owner.accountEpoch === accountEpoch && owner.identityKey === commandIdentityKey() && owner.conversationId === lastSession?.conversation?.id;
    card.addEventListener('click',async () => {
      if (card.disabled || !isCurrent() || pendingRequests.has('session')) return;
      card.disabled = true;
      feedback.textContent = check ? '正在核对原回执…' : '正在打开文件…';
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(),15000) : null;
      try {
        if (!csrf && !await refreshStatus()) throw new Error('本地服务状态尚未核对，请刷新后重试。');
        if (!isCurrent() || pendingRequests.has('session')) return;
        const result = await post(check ? 'chat-artifact/check' : 'chat-artifact/open',{conversationId,artifactId},controller ? {signal:controller.signal} : {});
        if (result?.ok !== true) throw new Error(check ? '原回执仍待核对。' : '文件打开未确认。');
        if (isCurrent()) feedback.textContent = check ? (['pending','unknown'].includes(result.status) ? '原回执仍待核对。' : '核对请求已提交。') : '打开请求已提交。';
      } catch (error) {
        if (isCurrent()) feedback.textContent = check ? '原回执仍待核对。' : error.name === 'AbortError' ? '打开请求超时，请查看本地文件。' : error.message || '文件打开未确认。';
      } finally {
        if (timer) clearTimeout(timer);
        card.disabled = false;
      }
    });
    return card;
  });
  list.replaceChildren(...cards,feedback);
  list.hidden = !cards.length;
  if (shouldScroll) scrollBottom();
}

function renderConversation() {
  if (generatedFilesView && (!modelUiEnabled || !modelContextAllowed || generatedFilesView.accountEpoch !== accountEpoch || generatedFilesView.identityKey !== commandIdentityKey() || generatedFilesView.conversationId !== lastSession?.conversation?.id)) applyGeneratedFiles(null,null,null);
  const shouldScroll = nearBottom();
  $('welcome').hidden = messages.length > 0;
  $('history-note').hidden = !lastSession?.historyTruncated;
  const liveIds = new Set();
  for (const message of messages) {
    liveIds.add(message.id);
    let entry = messageNodes.get(message.id);
    if (!entry) {
      const article = node('article', 'message ' + message.role), head = node('div', 'message-head'), label = node('span', 'label'), state = node('span', 'message-state'), body = node('div', 'body'), tools = node('div', 'tool-calls'), attachments = node('div','model-sent-attachments');
      attachments.hidden=true;
      const dismiss = node('button', 'dismiss-receipt-notice', '关闭'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', '关闭已核实回执提示');
      head.append(label, state, dismiss); article.append(head, tools, attachments, body); entry = { article, label, state, body, tools, attachments, dismiss, signature: null, toolSignature: null }; messageNodes.set(message.id, entry);
      dismiss.addEventListener('click', () => { if (entry.dismissKey) { dismissedReceiptNotices.add(entry.dismissKey); entry.article.hidden = true; } });
    }
    const signature = JSON.stringify([message,accountEpoch,contextEpoch,commandIdentityKey(),commandConversationId(),modelUiEnabled,modelContextAllowed]);
    if (entry.signature !== signature) {
      const receiptNotice = receiptNoticeState(message);
      const dismissKey = receiptNotice?.dismissible ? JSON.stringify([commandIdentityFacts.userId, activeConversationId, message.id]) : null;
      entry.article.className = 'message ' + (receiptNotice ? 'receipt-notice' : message.role);
      entry.article.hidden = dismissKey !== null && dismissedReceiptNotices.has(dismissKey);
      entry.dismiss.hidden = dismissKey === null;
      entry.dismissKey = dismissKey;
      entry.label.textContent = receiptNotice ? '操作回执' : message.role === 'user' ? '你' : message.role === 'error' ? '连接提示' : 'BUILDX · CODEX';
      entry.state.className = 'message-state ' + (receiptNotice?.state ?? (message.status || ''));
      entry.state.textContent = receiptNotice?.label ?? messageStatus(message.status);
      if (message.role === 'assistant') renderMarkdown(entry.body, message.text || '', message); else entry.body.textContent = message.text || '';
      entry.body.hidden = !message.text;
      const attachments=modelUiEnabled && ['user','assistant'].includes(message.role) && Array.isArray(message.attachments) ? message.attachments.filter(item => item && typeof item.name === 'string' && ['text','image'].includes(item.kind) && Number.isSafeInteger(item.bytes) && item.bytes >= 0).slice(0,message.role==='assistant'?12:4) : [];
      entry.attachments.replaceChildren(...attachments.map(item => {
        const readable=item.kind==='image'&&['image/png','image/jpeg'].includes(item.mediaType)&&typeof item.id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id);
        const label=item.name+' · '+(item.kind === 'image' ? '图片' : '文本')+' · '+(item.bytes < 1024 ? item.bytes+' B' : Math.ceil(item.bytes/1024)+' KiB');
        const card=node(readable?'button':'span','model-sent-file'+(readable?' model-sent-image':''),label);
        if(readable){card.type='button';card.setAttribute('aria-label','查看图片 '+item.name);card.title='查看图片';card.addEventListener('click',()=>void openImagePreview({messageId:message.id,attachmentId:item.id}));}
        return card;
      }));
      entry.attachments.hidden=!attachments.length;
      entry.signature = signature;
    }
    const toolReceipts=Array.isArray(lastSession?.toolReceipts)?lastSession.toolReceipts.filter(item=>item.messageId===message.id):[];
    const tools=Array.isArray(message.tools)?message.tools:[];
    const toolSignature=JSON.stringify([tools,toolReceipts,message.toolHistoryTruncated]);
    if(entry.toolSignature!==toolSignature){
      const previous=entry.toolCards || new Map(), next=new Map();
      const cards=tools.map(tool=>{
        const receipt=toolReceipts.find(item=>item.itemId===tool.id);
        const cardSignature=JSON.stringify([tool,receipt]);
        let card=previous.get(tool.id);
        if(!card || card.signature!==cardSignature) card={signature:cardSignature,element:toolCard(message.id,tool,receipt)};
        next.set(tool.id,card);
        return card.element;
      });
      if(message.role==='assistant' && message.toolHistoryTruncated===true) cards.push(node('p','history-note tool-history-notice','本轮部分工具记录超出显示上限。请核对原始执行回执，避免重复提交。'));
      entry.tools.replaceChildren(...cards);
      entry.tools.hidden=!cards.length;
      entry.toolCards=next;
      entry.toolSignature=toolSignature;
    }
  }
  for (const [id, entry] of messageNodes) if (!liveIds.has(id)) {
    entry.article.remove(); messageNodes.delete(id);
    for (const key of openedTools) if (key.startsWith(id + ':')) openedTools.delete(key);
  }
  messages.forEach((message, index) => {
    const article = messageNodes.get(message.id).article, atIndex = $('transcript').children[index];
    if (article !== atIndex) $('transcript').insertBefore(article, atIndex || null);
  });
  if (shouldScroll) scrollBottom();
}
// Selection preview is independent of the snapshot collected again on send.
let selectionPreview = null, selectionPreviewRevision = 0, selectionPreviewInFlight = 0;
// An abandoned read may still be executing in Revit. Keep this guard separate
// from the checkbox and conversation, and only clear it on its own receipt.
let selectionReadUnconfirmed = null;
try { selectionReadUnconfirmed = JSON.parse(sessionStorage.getItem('buildx-selection-read-unconfirmed') || 'null'); } catch {}
function saveSelectionReadUnconfirmed(value) {
  selectionReadUnconfirmed = value;
  try { if (value) sessionStorage.setItem('buildx-selection-read-unconfirmed', JSON.stringify(value)); else sessionStorage.removeItem('buildx-selection-read-unconfirmed'); } catch {}
}
function markSelectionReadUnconfirmed(owner) {
  saveSelectionReadUnconfirmed({requestId:null, conversationId:owner.conversationId, contextEpoch:owner.contextEpoch, accountEpoch:owner.accountEpoch, identityKey:owner.identityKey, baselineError:owner.baselineError});
}
function observeSelectionReceipt(message) {
  if (!selectionReadUnconfirmed || typeof message !== 'string') return;
  if (message === selectionReadUnconfirmed.baselineError) return;
  if (selectionReadUnconfirmed.conversationId !== activeConversationId || selectionReadUnconfirmed.contextEpoch !== contextEpoch || selectionReadUnconfirmed.accountEpoch !== accountEpoch || selectionReadUnconfirmed.identityKey !== commandIdentityKey()) return;
  const id = message.match(/请求 ([0-9a-f-]{36})/i)?.[1];
  if (!id) return;
  if (/上下文读取未取得可核对的回执/.test(message) && !selectionReadUnconfirmed.requestId) saveSelectionReadUnconfirmed({...selectionReadUnconfirmed,requestId:id});
  else if (selectionReadUnconfirmed.requestId === id && /原回执确认/.test(message)) saveSelectionReadUnconfirmed(null);
}
function selectionPreviewCurrent(owner) {
  return owner && owner.revision === selectionPreviewRevision && owner.accountEpoch === accountEpoch &&
    owner.contextEpoch === contextEpoch && owner.conversationId === activeConversationId &&
    owner.identityKey === commandIdentityKey() && modelContextAllowed && $('include-selection').checked;
}
function releaseSelectionPreview(owner) {
  if (!owner || owner.released) return;
  owner.released=true; clearTimeout(owner.timer); owner.controller?.abort(); finishRequest(owner.request);
  selectionPreviewInFlight=Math.max(0,selectionPreviewInFlight-1); updateButtons();
}
function clearSelectionPreview() { selectionPreviewRevision++; if (selectionPreview?.requestOwner && !selectionPreview.requestOwner.released) markSelectionReadUnconfirmed(selectionPreview.requestOwner); releaseSelectionPreview(selectionPreview?.requestOwner); selectionPreview = null; }
async function readSelectionPreview() {
  clearSelectionPreview();
  if (!modelContextAllowed || !$('include-selection').checked) return;
  if (selectionReadUnconfirmed) { renderContext(); updateButtons(); return; }
  if (pendingRequests.has('context') || busy) { selectionPreview={revision:selectionPreviewRevision,accountEpoch,contextEpoch,conversationId:activeConversationId,identityKey:commandIdentityKey(),status:'error',error:'上下文读取正在进行，请稍候刷新。'}; renderContext(); return; }
  const owner = {revision:selectionPreviewRevision, accountEpoch, contextEpoch, conversationId:activeConversationId, identityKey:commandIdentityKey(), baselineError:context?.error ?? null, contextBaseline:JSON.stringify(context), controller:new AbortController(), released:false};
  owner.request=beginRequest('context');
  selectionPreview = {...owner, requestOwner:owner, status:'loading'}; selectionPreviewInFlight++; renderContext(); updateButtons();
  owner.timer=setTimeout(()=>{
    if(selectionPreviewCurrent(owner)){markSelectionReadUnconfirmed(owner);selectionPreview={...owner,status:'unknown',error:'读取等待超时，原请求可能仍在执行；请查看上下文及原回执状态，不要重复读取。'};renderContext();}
    releaseSelectionPreview(owner);
  },15000);
  try {
    const result = await post('context', {includeDocument:false,includeSelection:true}, {signal:owner.controller.signal});
    if (!selectionPreviewCurrent(owner) || owner.released || !ownsRequest(owner.request)) return;
    context=result.context ?? null; selectionPreview = {...owner, status:'success', context};
  } catch (error) {
    if (!selectionPreviewCurrent(owner) || owner.released || !ownsRequest(owner.request)) return;
    const unknown = !error.rejected || /回执尚未核实|原请求|未取得可核对的回执/.test(error.message||'');
    if (unknown) markSelectionReadUnconfirmed(owner);
    selectionPreview = {...owner, status:unknown?'unknown':'error', error:error.message || '读取失败'};
  } finally { releaseSelectionPreview(owner); }
  renderContext();
}
function renderContext() {
  observeSelectionReceipt(context?.error);
  const inline = $('selection-inline');
  inline.hidden = !modelContextAllowed || !$('include-selection').checked;
  if (inline.hidden) inline.open = false;
  if (!modelContextAllowed) {
    context = null;
    $('context-summary').textContent = sourceWorkspace() ? '源码工作台不读取模型上下文' : customerWorkspace() ? '聊天工作区不读取模型上下文' : '当前工作区未开放模型上下文';
    $('context-content').textContent = sourceWorkspace() ? '源码来源与工具返回保留在对话中。' : customerWorkspace() ? '对话仅包含本聊天工作区的消息。' : '请核对工作区配置。';
    return;
  }
  const flags = contextFlags(), documentInfo = context?.document;
  const preview = selectionPreviewCurrent(selectionPreview) ? selectionPreview : null;
  const selection = preview?.status === 'success' ? preview.context?.selection : null;
  const ids = Array.isArray(selection?.elementIds) ? selection.elementIds : null;
  const count = Number.isInteger(selection?.count) && selection.count >= 0 ? selection.count : (!selection?.truncated && ids ? ids.length : null);
  let inlineText = selectionReadUnconfirmed ? '结果待核实' : preview?.status === 'loading' ? '读取中…' : preview?.status === 'unknown' ? '结果待核实' : preview?.status === 'error' ? '读取失败' : '尚未读取';
  if (selection && !selectionReadUnconfirmed) {
    const quantity = count === null ? '数量未知' : `${count} 项`;
    inlineText = quantity + (ids?.length ? '：' + ids.join('、') : ids ? '：无 ID' : '：ID 未提供') + (selection.truncated ? '（部分）' : '');
  }
  $('selection-inline-summary').textContent = inlineText;
  const summaries = [], lines = [], selectionLines = [inlineText];
  const selectionDetail = text => { lines.push(text); selectionLines.push(text); };
  if (flags.includeSelection && selectionReadUnconfirmed) selectionDetail('上一次选择读取的原回执尚未核实，暂不能再次读取；切换对话或取消勾选不会解除等待。');
  if (flags.includeDocument && documentInfo) {
    summaries.push(documentInfo.title || '当前文档');
    lines.push('模型：' + (documentInfo.title || '未提供标题'));
    if (documentInfo.path) lines.push('路径：' + documentInfo.path);
    if (documentInfo.activeView) {
      const view = documentInfo.activeView;
      lines.push('视图：' + (typeof view === 'string' ? view : view.name || view.title || [view.type, view.id ? '#' + view.id : ''].filter(Boolean).join(' ') || '已提供'));
    }
  } else if (flags.includeDocument) summaries.push('模型信息未取得');
  if (flags.includeSelection && selection) {
    summaries.push(count === null ? '选择数量未知' : `选择 ${count} 项`);
    if (Array.isArray(selection.elementIds)) {
      lines.push('选中 ID：' + (selection.elementIds.join('、') || '无'));
      if (selection.truncated) selectionDetail('选择回读已截断：当前仅展示 ' + selection.elementIds.length + (count === null ? ' 项，总数未知' : ' / ' + count + ' 项') + '，不代表全部对象。');
    }
  } else if (flags.includeSelection) summaries.push(selectionReadUnconfirmed ? '选择结果待核实' : preview?.status === 'loading' ? '正在读取选择…' : preview?.status === 'unknown' ? '选择结果待核实' : preview?.status === 'error' ? '选择读取失败' : '选择信息未取得');
  if (flags.includeSelection && !preview) selectionDetail('当前选择尚未读取；点击刷新可查看，发送时将重新读取。');
  if (flags.includeSelection && ['error','unknown'].includes(preview?.status)) selectionDetail('选择读取提示：' + previewText(preview.error));
  if (flags.includeSelection && preview?.status === 'unknown' && context?.selection && JSON.stringify(context)!==preview.contextBaseline) {
    const later=context.selection, ids=Array.isArray(later.elementIds)?later.elementIds:[];
    selectionDetail('服务当前上下文已刷新，无法确认是否来自原请求：选择 '+(Number.isInteger(later.count)?later.count:'数量未知')+' 项；ID：'+(ids.join('、')||'无'));
    if(later.truncated)selectionDetail('服务当前上下文选择已截断，仅显示 '+ids.length+' 项。');
    if(context.capturedAt)selectionDetail('服务当前上下文读取时间：'+context.capturedAt);
  }
  if (flags.includeSelection && preview?.status === 'success' && preview.context?.capturedAt) selectionDetail('选择读取时间：' + preview.context.capturedAt + '；发送时将重新读取当前选择。');
  if (flags.includeDocument && context?.capturedAt) lines.push('读取时间：' + context.capturedAt + '\n这是当时的上下文快照；模型变化后请刷新。');
  if (context?.error) { const text = '读取提示：' + previewText(context.error); lines.push(text); if (flags.includeSelection) selectionLines.push(text); }
  $('selection-inline-content').textContent = selectionLines.join('\n');
  $('context-summary').textContent = summaries.join(' · ') || '未附加模型信息';
  $('context-content').textContent = lines.join('\n') || (flags.includeDocument || flags.includeSelection ? '尚未取得上下文。点击刷新，或随下一条消息读取。' : '勾选后可读取上下文，也可随下一条消息附加。');
}
function showUserInput(value){
  const box=$('user-input');
  if(!modelUiEnabled||!value||typeof value.id!=='string'||!Array.isArray(value.questions)||!busy){visibleInputId=null;box.hidden=true;box.replaceChildren();return;}
  if(visibleInputId===value.id)return;
  visibleInputId=value.id;box.hidden=false;box.replaceChildren();
  const title=node('strong','','需要你的回答'),form=node('form','user-input-form'),controls=[];
  box.append(title,form);
  value.questions.forEach((question,index)=>{
    const group=node('fieldset'),legend=node('legend','',question.question);group.append(legend);
    const choices=[];
    for(const option of question.options){const label=node('label','user-input-option'),radio=node('input');radio.type='radio';radio.name='input-'+index;radio.value=option.label;const description=node('span','',option.label+(option.description?' — '+option.description:''));label.append(radio,description);group.append(label);choices.push(radio);}
    let other=null;if(!choices.length||question.isOther){const label=node('label','user-input-option');other=node('input');other.type='text';other.maxLength=4000;other.placeholder=choices.length?'其他答案':'输入你的回答';label.append(other);group.append(label);other.addEventListener('input',()=>{if(other.value)for(const choice of choices)choice.checked=false;});for(const choice of choices)choice.addEventListener('change',()=>{if(choice.checked)other.value='';});}
    controls.push({question,choices,other});form.append(group);
  });
  const submit=node('button','','提交回答'),feedback=node('p','user-input-feedback');submit.type='submit';feedback.setAttribute('role','status');form.append(submit,feedback);
  form.addEventListener('submit',async event=>{
    event.preventDefault();const answers=Object.create(null);
    for(const {question,choices,other} of controls){const selected=choices.find(choice=>choice.checked),custom=other?.value.trim();if(!selected&&!custom){feedback.textContent='请回答每个问题。';return;}answers[question.id]=custom||selected.value;}
    submit.disabled=true;feedback.textContent='正在提交…';
    try{await post('user-input',{conversationId:value.conversationId,requestId:value.id,answers});if(visibleInputId===value.id)feedback.textContent='回答已提交。';}
    catch(error){if(visibleInputId===value.id){submit.disabled=false;feedback.textContent=error.message||'回答未能提交。';}}
  });
}
// The server owns the operation and its one-use decision. This UI only
// displays its full immutable preview and sends the corresponding decision.
const typeApprovalPermissionIdentity=()=>JSON.stringify([modelPermission?.available,modelPermission?.revision,modelPermission?.level,modelPermission?.documentLabel,
  modelPermission?.expiresAt,accessPolicy?.id,accessPolicy?.revision,accessPolicy?.mode]);
function dynamicApprovalScopeCurrent(owner){
  return Boolean(owner&&dynamicApproval===owner&&modelUiEnabled&&ready&&
    owner.accountEpoch===accountEpoch&&owner.contextEpoch===contextEpoch&&
    owner.connectionGeneration===modelPickerIdentity.connectionGeneration&&owner.accountRevision===modelPickerIdentity.accountRevision&&
    owner.request.conversationId===lastSession?.conversation?.id&&
    (owner.request.action!=='revit_set_type_parameter'||owner.permissionIdentity===typeApprovalPermissionIdentity()));
}
function dynamicApprovalCurrent(owner){return dynamicApprovalScopeCurrent(owner)&&busy;}
function dynamicApprovalAwaitingResult(owner){return owner?.request.kind==='model'&&owner.state==='accepted';}
function dynamicApprovalPaint(owner){
  if(dynamicApproval!==owner)return;
  const box=$('dynamic-approval'), feedback=owner.feedback;
  // A type review has no usable controls until its literal module and complete
  // immutable facts have been checked. Late loads cannot revive this owner.
  if(!owner.accept||!owner.decline||!feedback){box.hidden=true;return;}
  box.hidden=owner.request.conversationId!==lastSession?.conversation?.id;
  owner.accept.disabled=owner.state!=='pending';owner.decline.disabled=owner.state!=='pending';
  const accepted = {model:'确认已提交，正在等待模型操作结果…',file:'已授权，生成结果会显示在对话里。'};
  feedback.textContent=owner.resultMessage??{pending:'请核对完整操作后决定。',submitting:'正在提交确认…',accepted:accepted[owner.request.kind]??'确认已提交，执行结果需另行核对。',declined:'拒绝已提交。',expired:'确认已超时；此操作不能再从这里批准。',disconnected:'连接或对话已变化；此操作不能再从这里批准。',unknown:'确认是否送达尚未核对，请勿重复提交。'}[owner.state];
}
function applyDynamicApprovalResult(value){
  const owner=dynamicApproval;
  if(!value||owner?.request.kind!=='model'||!dynamicApprovalScopeCurrent(owner)||owner.state==='disconnected'||
     value.requestId!==owner.request.id||value.digest!==owner.request.digest||value.conversationId!==owner.request.conversationId||
     !['completed','not_started','unconfirmed','declined'].includes(value.status)||
     value.code!==undefined&&(typeof value.code!=='string'||!/^MODEL_[A-Z0-9_]{1,100}$/.test(value.code))||
     value.operationOutcome!==undefined&&value.operationOutcome!=='not_started')return;
  const message={completed:'模型操作已完成，请查看执行结果。',not_started:value.code==='MODEL_DOCUMENT_REVALIDATION_FAILED'?'当前模型或执行权限未能重新核实，本次操作未开始；请结束未完成的 Revit 命令后重新核实。':'本次模型操作未开始，请查看对话中的原因。',unconfirmed:value.operationOutcome==='not_started'?'模型操作未开始；前置查询的原回执仍需核对。':'模型操作结果尚未确认，请核对原回执；不要重复执行。',declined:'已拒绝，本次模型操作未执行。'}[value.status];
  owner.resultMessage=message+(value.code?'（'+value.code+'）':'');settleDynamicApproval(owner,value.status);
}
function settleDynamicApproval(owner,state){
  if(dynamicApproval!==owner)return;
  if(owner.timer)clearTimeout(owner.timer);
  owner.state=state;settledDynamicApprovals.add(owner.request.id);dynamicApprovalPaint(owner);
}
function invalidateDynamicApproval(){
  const owner=dynamicApproval;
  if(dynamicApprovalAwaitingResult(owner)){
    owner.resultMessage='连接、账号或模型上下文已变化；已提交操作的结果尚未核对，请查看原对话和回执。';
    settleDynamicApproval(owner,'disconnected');return;
  }
  if(!owner||!['pending','submitting'].includes(owner.state))return;
  settleDynamicApproval(owner,owner.state==='submitting'?'unknown':'disconnected');
}
async function showDynamicApproval(value){
  const box=$('dynamic-approval');
  if(!value){
    // The server removes a claimed proposal from SSE before the HTTP receipt
    // arrives. Keep waiting only for this already-submitted transport; actual
    // disconnect, scope changes and timeout still settle as unknown.
    if(dynamicApproval?.state!=='submitting'&&!(dynamicApprovalAwaitingResult(dynamicApproval)&&dynamicApprovalScopeCurrent(dynamicApproval)))invalidateDynamicApproval();
    if(!dynamicApproval||dynamicApproval.request.conversationId!==lastSession?.conversation?.id)box.hidden=true;
    return;
  }
  const str=(v,max,empty=false)=>typeof v==='string'&&v.length<=max&&(empty||v.length>0)&&!v.includes('\0');
  const typeWrite=value?.action==='revit_set_type_parameter';
  const fileWrite=value?.kind==='file';
  if(!modelUiEnabled||!ready||!busy||!value||typeof value!=='object'||Array.isArray(value)||
    !str(value.id,200)||!/^\w[\w-]*$/.test(value.id)||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest)||
    !['terminal','browser','plugin','model','file'].includes(value.kind)||!str(value.action,16384)||!str(value.target,4096)||
    !str(value.source,512)||!str(value.cwd,4096,true)||!str(value.parameters,65536,true)||
    !Number.isSafeInteger(value.deadline)||value.deadline<=0||!str(value.conversationId,200)||value.conversationId!==lastSession?.conversation?.id||
    typeWrite&&(value.kind!=='model'||!str(value.typeParameterReview,60000))||!typeWrite&&Object.hasOwn(value,'typeParameterReview')||
    (fileWrite||value.action==='buildx_generate_file')&&(!fileWrite||value.action!=='buildx_generate_file'||!generatedFileName(value.target)||!value.cwd||!value.parameters)){
    invalidateDynamicApproval();box.hidden=true;return;
  }
  const fields=['id','digest','kind','action','target','cwd','source','parameters','deadline','conversationId','typeParameterReview'];
  if(dynamicApproval?.request.id===value.id){
    if(fields.some(key=>dynamicApproval.request[key]!==value[key])){invalidateDynamicApproval();box.hidden=true;}
    return;
  }
  invalidateDynamicApproval();
  if(settledDynamicApprovals.has(value.id)||settledDynamicApprovals.size>=4096){box.hidden=true;return;}
  const request=Object.freeze(Object.fromEntries(fields.map(key=>[key,value[key]])));
  const owner={request,accountEpoch,contextEpoch,permissionIdentity:typeApprovalPermissionIdentity(),connectionGeneration:modelPickerIdentity.connectionGeneration,
    accountRevision:modelPickerIdentity.accountRevision,state:'pending',timer:null};
  dynamicApproval=owner;box.replaceChildren();box.hidden=typeWrite;
  const expire=()=>{if(dynamicApproval===owner&&['pending','submitting'].includes(owner.state)){settleDynamicApproval(owner,owner.state==='submitting'?'unknown':'expired');updateButtons();}};
  if(request.deadline<=Date.now())expire();else owner.timer=setTimeout(expire,Math.min(request.deadline-Date.now(),2147483647));
  let typeReviewCard=null;
  if(typeWrite){
    updateButtons();
    try{
      const review=await import('./type-parameter-write-review.mjs');
      const facts=review.parseTypeParameterWriteReview(request.typeParameterReview);
      if(dynamicApproval!==owner||owner.state!=='pending')return;
      if(!dynamicApprovalCurrent(owner)){invalidateDynamicApproval();return;}
      if(request.deadline<=Date.now()){expire();return;}
      typeReviewCard=review.renderTypeParameterWriteReview(document,facts);
    }catch{
      if(dynamicApproval===owner&&owner.state==='pending'){settleDynamicApproval(owner,'disconnected');box.hidden=true;updateButtons();}
      return;
    }
  }
  box.hidden=false;
  const names={terminal:'终端',browser:'浏览器',plugin:'插件',model:'模型'},title=node('strong','',fileWrite?'生成文件':'需要确认 '+names[request.kind]+' 操作'),detail=node('dl');
  const reviewRows=fileWrite?[['文件名',request.target],['保存目录',request.cwd],['生成规格',request.parameters]]:typeWrite?[['操作','修改类型参数'],['目标',request.target],['来源',request.source]]:[['操作',request.action],['目标',request.target],['参数',request.parameters],['工作目录',request.cwd],['来源',request.source]];
  for(const [label,text] of reviewRows){
    const value=node('dd','',text||'（空）');value.tabIndex=0;detail.append(node('dt','',label),value);
  }
  const actions=node('div','dynamic-approval-actions'),accept=node('button','',fileWrite?'允许本次生成':'同意本次操作'),decline=node('button','secondary-button','拒绝'),feedback=node('p','dynamic-approval-feedback');
  accept.type='button';decline.type='button';feedback.setAttribute('role','status');actions.append(accept,decline);box.append(title,detail,...(typeReviewCard?[typeReviewCard]:[]),actions,feedback);
  if(request.kind==='model'&&!typeWrite)box.insertBefore(node('p','dynamic-approval-feedback','请核对完整参数。C# 脚本不是安全沙盒，回滚不能撤销文件、网络等事务外副作用。'),actions);
  owner.accept=accept;owner.decline=decline;owner.feedback=feedback;
  async function decide(decision){
    if(owner.state!=='pending'||!dynamicApprovalCurrent(owner))return;
    if(request.deadline<=Date.now()){expire();return;}
    owner.state='submitting';dynamicApprovalPaint(owner);updateButtons();
    const controller=typeof AbortController==='function'?new AbortController():null;let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller?.abort();reject(new Error('timeout'));},15000);});
    try{
      const result=await Promise.race([post('dynamic-approval',{conversationId:request.conversationId,requestId:request.id,digest:request.digest,decision},controller?{signal:controller.signal}:{}),timeout]);
      if(!dynamicApprovalCurrent(owner)||owner.state!=='submitting')return;
      if(result?.ok!==true||result.requestId!==request.id||result.decision!==decision||result.status!=='submitted')throw new Error('receipt mismatch');
      settleDynamicApproval(owner,decision==='accept'?'accepted':'declined');
    }catch{if(dynamicApproval===owner&&owner.state==='submitting')settleDynamicApproval(owner,'unknown');}
    finally{clearTimeout(timer);updateButtons();}
  }
  accept.addEventListener('click',()=>{void decide('accept');});decline.addEventListener('click',()=>{void decide('decline');});
  dynamicApprovalPaint(owner);updateButtons();
}
function applyConversation(data = {}, commandEvidence = false) {
  if (!applyWorkspace(data.workspace)) return;
  const sessionRequest=pendingRequests.get('session');
  // A combined conversation snapshot owns its busy projection. state.busy may
  // also include background history writes; merge the canonical conversation
  // value before status() publishes any intermediate view to permission UI.
  const conversationBusy=typeof data.busy==='boolean'?(data.busy||pendingRequests.get('turn')?.waitingForDraft===true):null;
  const state = data.state ? { ...data.state,
    ...(data.state.workspace===undefined&&data.workspace!==undefined?{workspace:data.workspace}:{}),
    ...(conversationBusy===null?{}:{busy:conversationBusy}),
  } : data.state;
  if (state && !status(state)) return;
  if (modelUiEnabled && data.history?.available === true) historyAvailable = true;
  const wasBusy = busy;
  if (typeof data.busy === 'boolean') {
    const waitingForDraft = pendingRequests.get('turn')?.waitingForDraft === true;
    // A draft checkpoint is not evidence that a native turn has started.
    if (!data.busy && waitingForDraft) busy = true;
    else { busy = data.busy; busyRevision++; if (!busy) pendingRequests.delete('interrupt'); }
    if (!busy) commandStopUnavailable = false;
  }
  if (data.session && Array.isArray(data.session.messages)) {
    const previousSkillsConversation=skillsConversation();
    const priorCommandConversation = commandConversationId();
    const incomingId = typeof data.session.conversation?.id === 'string' ? data.session.conversation.id : null;
    const changedConversation = historyEnabled() && incomingId !== null && incomingId !== activeConversationId;
    if(changedConversation || contextEpoch!==null && data.session.contextEpoch!==undefined && contextEpoch!==data.session.contextEpoch) { clearSelectionPreview(); closeImagePreview(false); }
    if(changedConversation || contextEpoch!==null && data.session.contextEpoch!==undefined && contextEpoch!==data.session.contextEpoch)clearModelReceipt();
    if(changedConversation || contextEpoch!==null && data.session.contextEpoch!==undefined && contextEpoch!==data.session.contextEpoch){clearModelPermission('对话或模型上下文已变化，权限尚未核实。');clearAccessPolicy('对话或模型上下文已变化，请重新读取访问范围。');}
    if(changedConversation || contextEpoch!==null && data.session.contextEpoch!==undefined && contextEpoch!==data.session.contextEpoch)libraryAttachmentEpoch++;
    const priorId = activeConversationId, route = pendingRequests.get('session')?.route;
    if (changedConversation) {
      clearSkills('对话已切换，请重新读取技能。');
      attachmentRead=null;
      rememberDraft(); cancelDraftTimer(); invalidateHistoryRead(); invalidateRequests();
      activeConversationId = incomingId; conversationReadOnly = data.session.conversation?.readOnly === true;
      restoreConversationDraft(incomingId,data.draft,!priorId && route !== 'new-chat' && route !== 'chat/select');
      messageNodes.clear(); openedTools.clear(); $('transcript').replaceChildren(); $('context-reset').hidden = true;
    } else if (historyEnabled() && incomingId !== null) {
      activeConversationId = incomingId; conversationReadOnly = data.session.conversation?.readOnly === true;
    }
    reconcileSteerReceipts(data.session);
    canonical = true; lastSession = data.session; messages = sessionMessages(data.session);
    reconcileTurnReceipt(data.session.conversation);
    if(previousSkillsConversation&&skillsConversation()!==previousSkillsConversation)clearSkills('对话已切换，请重新读取技能。');
    if (priorCommandConversation !== commandConversationId()) { clearCommands(); clearTerminal(); }
    if (!changedConversation && contextEpoch !== null && data.session.contextEpoch !== undefined && contextEpoch !== data.session.contextEpoch) {
      const newChat = pendingRequests.get('session')?.route === 'new-chat';
      invalidateRequests();
      clearCommands();
      clearTerminal({keepJob:true});
      $('context-reset').hidden = newChat;
      if (newChat) { $('include-document').checked = false; $('include-selection').checked = false; $('prompt').focus(); }
    }
    if (data.session.contextEpoch !== undefined) contextEpoch = data.session.contextEpoch;
    if (data.session.context !== undefined) context = modelContextAllowed ? data.session.context : null;
    historyView(data.history);
    if (Object.hasOwn(data,'generatedFiles') || Object.hasOwn(data,'generatedFilePending')) applyGeneratedFiles(data.generatedFiles,data.generatedFilePending,incomingId);
    renderConversation(); renderContext();
    if (changedConversation) { if (!Array.isArray(data.history?.sessions)) void refreshHistory(); }
  } else if (!canonical && typeof data.text === 'string' && data.text) {
    const existing = messages.find(message => message.id === 'legacy-assistant');
    if (existing) existing.text = data.text; else messages.push({ id: 'legacy-assistant', role: 'assistant', text: data.text, tools: [] });
    renderConversation();
  }
  if (commandEvidence && Object.hasOwn(data,'command')) applyCommandProjection(data.command);
  if (data.activity) $('activity-text').textContent = data.activity;
  if (data.error) notice(typeof data.error === 'string' ? data.error : previewText(data.error));
  if(Object.hasOwn(data,'modelPermission')){
    const applied=applyModelPermission(data.modelPermission),owner=modelPermissionPending;
    if(applied&&owner&&modelPermissionRequestCurrent(owner)&&data.busy===false&&serverBusyOperation===null){
      const confirmed=modelPermission.revision>owner.revision&&modelPermission.level===owner.level;
      if(confirmed||owner.sawServerCheck&&data.state?.busyOperation===null){
        modelPermissionPending=null;
        modelPermissionMessage=confirmed?'已更新本次对话的执行方式。':'服务核实已结束。当前执行方式以服务返回为准。';
      }
    }
  }
  if(Object.hasOwn(data,'accessPolicy'))applyAccessPolicy(data.accessPolicy);
  else if(data.session&&Object.hasOwn(data.session,'accessPolicy'))applyAccessPolicy(data.session.accessPolicy);
  if(Object.hasOwn(data,'userInput'))showUserInput(data.userInput);
  if(Object.hasOwn(data,'dynamicApproval'))showDynamicApproval(data.dynamicApproval);
  if(Object.hasOwn(data,'dynamicApprovalResult'))applyDynamicApprovalResult(data.dynamicApprovalResult);
  if(Object.hasOwn(data,'modelReceipt'))applyModelReceipt(data.modelReceipt);
  if(Object.hasOwn(data,'terminal'))applyTerminal(data.terminal);
  initializeCommandAuthoring(sessionRequest);
  updateButtons();
  if (wasBusy && !busy && historyEnabled()) { scheduleDraftSave(); if (!Array.isArray(data.history?.sessions)) void refreshHistory(); }
  return state || true;
}
async function refreshStatus(expectedStream = stream) {
  invalidateStatusRead();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const owner = { accountEpoch, stream: expectedStream, revision: stateRevision, commandRevision, controller };
  statusRead = owner; updateButtons();
  const current = () => statusRead === owner && owner.accountEpoch === accountEpoch && stream === owner.stream && owner.revision === stateRevision && owner.commandRevision === commandRevision;
  let timer;
  const deadline = new Promise((_,reject) => { timer = setTimeout(() => { controller?.abort(); reject(new Error('状态核对超时；当前结果尚未核对，请明确刷新状态。')); },12000); });
  try {
    const response = await Promise.race([fetch('/api/status', { cache:'no-store', ...(controller ? {signal:controller.signal} : {}) }),deadline]);
    if (!current()) return null;
    if (!response.ok) throw new Error('本地服务状态未能核对，请明确刷新状态。');
    const data = await Promise.race([response.json(),deadline]); if (!current()) return null;
    // Native host identity probes have an 8 KiB bound. Parameter schemas have
    // their own authenticated endpoint and are loaded once by this UI owner.
    if(data.commandCatalogAvailable===true&&commandCatalog===null&&(!data.account?.required||data.account.signedIn===true)){
      const catalogResponse=await Promise.race([fetch('/api/command-catalog',{cache:'no-store',...(controller?{signal:controller.signal}:{})}),deadline]);
      if(!current())return null;
      if(!catalogResponse.ok)throw new Error('命令目录未能读取，请刷新状态。');
      const catalog=await Promise.race([catalogResponse.json(),deadline]);if(!current())return null;
      if(!Array.isArray(catalog.commands)||catalog.commands.length>128)throw new Error('命令目录格式未能核对。');
      data.commandCatalog=catalog.commands;
    }
    if (!status(data)) throw new Error('本地工作区状态未能核对，请明确刷新状态。');
    csrf = data.csrf; return data;
  } catch (error) { if (!current()) return null; throw error; }
  finally { clearTimeout(timer); if (statusRead === owner) statusRead = null; updateButtons(); }
}
function eventData(event, action) {
  try { action(JSON.parse(event.data)); }
  catch { notice('收到无法识别的服务消息。请检查本地服务状态后重新连接。'); }
}
function connectEvents() {
  clearAccessPolicy('连接正在刷新，访问范围尚未核实。');
  clearModelPermission('连接正在刷新，权限尚未核实。');
  clearTerminal({keepJob:true});
  invalidateStatusRead();
  invalidateHistoryRead();
  stream?.close(); stream = new EventSource('/api/events?client=' + encodeURIComponent(client));
  const owner = stream;
  streamConnected = false;
  const recovered = state => {
    if(stream!==owner||!streamConnected||!streamRecoveryPending||!ready||state?.ready!==true||state?.error===true||
       (recoveryWorkspace!==null&&state?.workspace?.kind!==recoveryWorkspace))return;
    streamRecoveryPending=false;recoveryWorkspace=null;
    if(connectionNotice)notice('连接已恢复；断线前的操作结果仍需核对，请勿自动重发。');
  };
  // Every current-stream observation supersedes an earlier HTTP observation,
  // including terminal events and rejected payloads. Old streams own nothing.
  const listen = (name, action) => owner.addEventListener(name, event => { if (stream === owner) { stateRevision++; invalidateStatusRead(); action(event); } });
  owner.onopen = () => { if(stream === owner){streamConnected=true;refreshStatus(owner).then(data=>{if(data)recovered(data);}).catch(() => {if(stream === owner)connectionIssue('本地服务状态尚未核对，请明确刷新状态。');});} };
  listen('snapshot', event => eventData(event, data => {
    const applied=applyConversation(data,true);
    if(applied&&data.state)recovered(applied);
    if (historyEnabled() && !Array.isArray(data.history?.sessions)) void refreshHistory();
  }));
  listen('conversation', event => eventData(event, data => {
    const applied=applyConversation(data,true);
    if(applied&&data.state)recovered(applied);
  }));
  listen('state', event => eventData(event, data => {if(status(data))recovered(data);}));
  listen('delta', event => eventData(event, data => {
    if (canonical) return;
    messages = legacyDelta(messages, data.text, data.messageId); renderConversation();
  }));
  listen('activity', event => eventData(event, data => { $('activity-text').textContent = data.text || 'Codex 正在处理…'; }));
  listen('done', () => { busy = false; busyRevision++; pendingRequests.delete('interrupt'); updateButtons(); if (historyEnabled()) { scheduleDraftSave(); void refreshHistory(); } });
  listen('failure', event => eventData(event, data => { notice(data.message || '对话请求失败'); busy = false; busyRevision++; pendingRequests.delete('interrupt'); updateButtons(); if (historyEnabled()) { scheduleDraftSave(); void refreshHistory(); } }));
  owner.onerror = () => {
    if (stream !== owner) return;
    streamConnected=false;streamRecoveryPending=true;recoveryWorkspace=fixedWorkspace||(modelUiEnabled?'model':null);
    stateRevision++; customerRecovery = customerWorkspace();
    connectionIssue('本地连接已中断；当前结果尚未核对，正在读取服务状态。');
    void refreshStatus(owner).then(data => {
      if (!data || stream !== owner) return;
      if (customerWorkspace() && data.busy !== false) notice('服务仍在处理或任务状态尚未结束；请核对后再明确重新连接。');
    }).catch(() => { if(stream === owner)connectionIssue('本地服务状态尚未核对，请明确刷新状态；不会自动重发消息。'); });
  };
}
async function post(route, extra = {}, options = {}) {
  if (!csrf && !await refreshStatus()) throw new Error('本地服务状态尚未核对，请刷新后重试。');
  const response = await fetch('/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Chat': csrf }, body: JSON.stringify({ client, ...extra }), ...options });
  let result; try { result = await response.json(); } catch { throw new Error('本地服务返回了无法识别的响应。'); }
  if (!response.ok) { const error = new Error(typeof result.error === 'string' ? result.error : result.error?.message || '请求未成功'); error.rejected = true; error.httpStatus = response.status; error.outcome = result.status; throw error; } return result;
}
async function changeAccessPolicy(detail){
  const current=accessPolicy,conversationId=commandConversationId(),mode=detail?.mode;
  if(!modelUiEnabled||!modelContextAllowed||!ready||busy||pendingRequests.has('session')||accessPolicyPending||conversationReadOnly||!current||!conversationId||!['read-only','project-write','full-access'].includes(mode)||detail.confirmed!==true||mode==='project-write'&&(typeof detail.rootId!=='string'||!detail.rootId||detail.rootId.length>200))return;
  if(mode===current.mode&&mode!=='project-write')return;
  const owner={accountEpoch,contextEpoch,conversationId,identityKey:commandIdentityKey(),id:current.id,revision:current.revision};
  accessPolicyPending=owner;accessPolicyMessage='正在更新访问范围…';updateButtons();
  const matches=()=>accessPolicyPending===owner&&owner.accountEpoch===accountEpoch&&owner.contextEpoch===contextEpoch&&owner.conversationId===commandConversationId()&&owner.identityKey===commandIdentityKey();
  const controller=typeof AbortController==='function'?new AbortController():null;let timer;
  try{
    const result=await Promise.race([post('access-policy',{mode,confirmed:true,expectedRevision:owner.revision,...mode==='project-write'?{rootId:detail.rootId}:{}},controller?{signal:controller.signal}:{}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller?.abort();reject(new Error('timeout'));},15000);timer?.unref?.();})]);
    if(!matches())return;
    const policy=result?.accessPolicy??result?.session?.accessPolicy;
    if(result?.ok!==true||policy?.mode!==mode||!Number.isSafeInteger(policy.revision)||policy.revision<=owner.revision)throw new Error('访问范围回执未能核实。');
    if(result.session)applyConversation(result);
    else if(result.modelPermission)applyModelPermission(result.modelPermission);
    if(!applyAccessPolicy(policy))throw new Error('访问范围回执未能核实。');
    accessPolicyPending=null;accessPolicyMessage=policy.modelWritable===false&&mode!=='read-only'?(policy.modelMessage||'文件访问范围已更新；当前 Revit 模型编辑尚未启用。'):'';
  }catch(error){if(matches())clearAccessPolicy(error?.rejected?'访问范围更新未成功，请重新读取当前状态。':'访问范围更新结果尚未确认，请重新读取后再操作。');}
  finally{clearTimeout(timer);if(accessPolicyPending===owner)accessPolicyPending=null;updateButtons();}
}
async function changeModelPermission(level){
  const current=modelPermission, conversationId=lastSession?.conversation?.id;
  if(!modelUiEnabled||!modelContextAllowed||!ready||busy||pendingRequests.has('session')||modelPermissionChecking()||conversationReadOnly||
    !current||current.conversationId!==conversationId||!['rollback','confirm','automatic'].includes(level)||level===current.level||
    current.expiresAt!==null&&current.expiresAt<=Date.now())return;
  const owner={accountEpoch,contextEpoch,conversationId,identityKey:commandIdentityKey(),revision:current.revision,level};
  modelPermissionPending=owner;modelPermissionMessage='正在等待 Revit 核实当前模型与执行权限…';updateButtons();
  const matches=()=>modelPermissionRequestCurrent(owner);
  let timer,deadline;
  try{
    timer=setTimeout(()=>{if(matches()){owner.delayed=true;modelPermissionMessage='仍在等待 Revit 核实当前模型。可刷新服务状态，请勿重复提交。';updateButtons();}},15000);timer?.unref?.();
    const timeout=new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('执行方式回执超时')),75000);deadline?.unref?.();});
    const result=await Promise.race([post('model-permission',{conversationId,level,expectedRevision:owner.revision}),timeout]);
    if(!matches())return;
    if(result?.ok!==true||result.modelPermission?.level!==level||result.modelPermission?.conversationId!==conversationId||!Number.isSafeInteger(result.modelPermission?.revision)||result.modelPermission.revision<=owner.revision)throw new Error('权限结果未能核实。');
    if(modelPermission&&modelPermission.revision>result.modelPermission.revision){modelPermissionPending=null;return;}
    if(!applyModelPermission(result.modelPermission))throw new Error('权限结果未能核实。');
    modelPermissionPending=null;modelPermissionMessage='已更新本次对话的模型权限。';
  }catch(error){
    if(matches()){
      clearModelPermission(error?.rejected?'执行方式更新未成功，请重新核实当前状态。':'执行方式回执未确认，请刷新服务状态。');
      if(!error?.rejected&&!statusRead)void refreshModelPermissionStatus();
    }
  }
  finally{clearTimeout(timer);clearTimeout(deadline);if(modelPermissionPending===owner)modelPermissionPending=null;updateButtons();}
}
async function refreshModelPermissionStatus(){
  if(!modelUiEnabled||!modelContextAllowed||statusRead||pendingRequests.has('session'))return;
  const owner=modelPermissionPending;
  try{
    const data=await refreshStatus();
    if(owner&&modelPermissionRequestCurrent(owner)&&data?.ready===true&&data.busy===false&&data.busyOperation===null)
      clearModelPermission('服务已空闲，执行方式回执仍未确认。可以继续聊天或新建对话。');
  }catch(error){notice(error.message||'服务状态未核实，请稍后刷新。');}
  finally{updateButtons();}
}
async function modelReceiptAction(action,detail){
  const receipt=modelReceipt,conversationId=commandConversationId();
  if(!modelUiEnabled||!modelContextAllowed||modelAccount?.required===true&&modelAccount.signedIn!==true||action!=='check'&&(busy||modelPermissionChecking())||pendingRequests.has('session')||commandPending()||modelReceiptPending||conversationReadOnly||
    !receipt||receipt.checking||receipt.conversationId!==conversationId||detail?.ticket!==receipt.ticket||detail?.conversationId!==conversationId||
    !['check','acknowledge','recover','restore-visual'].includes(action))return;
  if(action==='acknowledge'&&(modelReceiptAckSubmitted||receipt.check?.terminal!==true||detail?.checkRevision!==receipt.checkRevision))return;
  if(action==='recover'&&(modelReceiptAckSubmitted||!canRecoverModelReceipt(receipt)||detail?.checkRevision!==receipt.checkRevision))return;
  if(action==='restore-visual'&&(modelReceiptAckSubmitted||!canRestoreVisualReceipt(receipt)||detail?.checkRevision!==receipt.checkRevision))return;
  const confirming=action!=='check';
  const owner={accountEpoch,contextEpoch,conversationId,ticket:receipt.ticket,identityKey:commandIdentityKey(),checkRevision:receipt.checkRevision,action};
  modelReceiptPending=owner;modelReceiptMessage=action==='check'?'正在检查原回执…':action==='restore-visual'?'正在恢复临时检查视图…':'正在提交确认…';updateButtons();
  const current=()=>modelReceiptPending===owner&&owner.accountEpoch===accountEpoch&&owner.contextEpoch===contextEpoch&&owner.conversationId===commandConversationId()&&owner.identityKey===commandIdentityKey()&&modelReceipt?.ticket===owner.ticket;
  const controller=typeof AbortController==='function'?new AbortController():null;let timer;
  try{
    const extra={conversationId,ticket:receipt.ticket,...confirming?{checkRevision:receipt.checkRevision,confirmed:true}:{}};
    const result=await Promise.race([post('model-receipt/'+action,extra,controller?{signal:controller.signal}:{}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller?.abort();reject(new Error('timeout'));},15000);timer?.unref?.();})]);
    if(!current())return;
    if(result?.ok!==true)throw new Error('回执请求未能确认。');
    if(confirming){modelReceiptAckSubmitted=true;modelReceiptMessage='确认已提交，等待服务更新；不要重复提交。';}
    else modelReceiptMessage=modelReceipt.checkRevision>owner.checkRevision?'':'核对请求已提交，等待服务回传原回执。';
  }catch(error){if(current()){
    if(confirming&&!error?.rejected)modelReceiptAckSubmitted=true;
    modelReceiptMessage=confirming&&!error?.rejected?'确认结果尚未核实，请勿重复提交；请重新连接核对。':error?.message||'原回执仍未核实，请勿重复执行。';
  }}
  finally{clearTimeout(timer);if(modelReceiptPending===owner)modelReceiptPending=null;updateButtons();}
}
async function terminalAction(detail){
  const {action,requestId,enabled}=detail??{},conversationId=commandConversationId(),job=terminal?.job;
  if(!modelUiEnabled||!modelContextAllowed||!conversationId||detail?.conversationId!==conversationId||terminalPending||
    modelAccount?.required===true&&modelAccount.signedIn!==true||!['enable','cancel','status'].includes(action))return;
  if(action==='enable'){
    if(!ready||!terminal?.available||terminalStale||busy||conversationReadOnly||pendingRequests.has('session')||
      modelPermissionChecking()||accessPolicyPending||typeof enabled!=='boolean'||enabled===terminal.enabled||
      enabled&&!terminal.eligible)return;
  }else if(!job||job.requestId!==requestId||action==='cancel'&&!['starting','running'].includes(job.status))return;
  const owner={action,accountEpoch,contextEpoch,conversationId,revision:terminalRevision};
  terminalPending=owner;terminalMessage='';updateButtons();
  const current=()=>terminalPending===owner&&owner.accountEpoch===accountEpoch&&owner.contextEpoch===contextEpoch&&owner.conversationId===commandConversationId();
  const controller=new AbortController();let timer;
  try{
    const extra={conversationId,...(action==='enable'?{enabled}:{requestId})};
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Error('timeout'));controller.abort();},15000);timer?.unref?.();});
    const result=await Promise.race([post('terminal/'+action,extra,{signal:controller.signal}),timeout]);
    if(!current())return;
    if(result?.ok!==true||!Object.hasOwn(result,'terminal'))throw new Error('unconfirmed');
    if(owner.revision===terminalRevision&&!applyTerminal(result.terminal))throw new Error('unconfirmed');
  }catch(error){
    if(current())terminalMessage=error?.rejected?error.message:action==='enable'?'开关结果尚未核实，请刷新对话状态。':'原请求状态尚未核实，请再次核查原请求。';
  }finally{
    clearTimeout(timer);if(terminalPending===owner)terminalPending=null;updateButtons();
  }
}
async function loadMcpCandidates(){
  if(!modelUiEnabled||!modelContextAllowed||!mcpCandidatesAvailable||!ready||mcpCandidateRead)return;
  const owner={accountEpoch,connectionGeneration:modelPickerIdentity.connectionGeneration,accountRevision:modelPickerIdentity.accountRevision};mcpCandidateRead=owner;
  const publish=detail=>window.dispatchEvent(new CustomEvent('buildx-mcp-candidates-result',{detail}));
  const current=()=>mcpCandidateRead===owner&&owner.accountEpoch===accountEpoch&&owner.connectionGeneration===modelPickerIdentity.connectionGeneration&&owner.accountRevision===modelPickerIdentity.accountRevision&&modelUiEnabled&&modelContextAllowed&&mcpCandidatesAvailable&&ready;
  publish({status:'loading'});
  try{
    const result=await post('mcp-candidates');
    if(!current())return;
    if(!result||result.source!=='launch_snapshot'||result.generation!==owner.connectionGeneration||!Array.isArray(result.servers)||result.servers.length>100)throw new Error();
    const names=new Set(),servers=[];
    for(const item of result.servers){
      if(!item||typeof item.name!=='string'||!/^[A-Za-z0-9_-]{1,1024}$/.test(item.name)||names.has(item.name)||!['disabled','reserved','unknown'].includes(item.status))throw new Error();
      names.add(item.name);servers.push({name:item.name,status:item.status});
    }
    publish({status:'loaded',servers});
  }catch{if(current())publish({status:'error'});}
  finally{if(mcpCandidateRead===owner)mcpCandidateRead=null;}
}
async function runCommand(detail) {
  if (!modelUiEnabled || !modelContextAllowed || !directCommandsAvailable || !commandsReady || busy || commandPending() || modelPermissionPending || pendingRequests.has('session') ||
      historyEnabled() && (conversationReadOnly || persistenceFailed())) return;
  const conversationId = commandConversationId(), commandId = detail?.commandId, parameters = detail?.parameters;
  if (!conversationId || !knownCommand(commandId) || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return;
  const definition=commandCatalog?.find(command=>command.id===commandId);
  if(definition?.enabled===false||definition?.manualExecution===false||definition?.tool==='revit_set_type_parameter'&&definition.requiresTypeParameterReview!==true)return;
  if(definition?.readOnly===false&&detail?.confirmed!==true){
    const grant=modelPermission,exempt=!confirmedWrite&&definition.effectKind==='model_transaction'&&grant?.available===true&&['rollback','confirm','automatic'].includes(grant.level)&&grant.conversationId===conversationId&&(grant.expiresAt===null||Number.isSafeInteger(grant.expiresAt)&&grant.expiresAt>Date.now())&&(grant.level==='automatic'||parameters.mode!=='commit')&&!(grant.level==='rollback'&&parameters.mode==='commit');
    if(!exempt)return;
  }
  commandRevision++;
  const previousCommand=commandResults.get(commandId);
  const request = beginRequest('command',{commandId,conversationId,accountEpoch,contextEpoch,previousExecutionId:previousCommand?.executionId,previousCommand});
  const current = () => ownsRequest(request) && request.accountEpoch === accountEpoch && request.contextEpoch === contextEpoch && request.conversationId === commandConversationId();
  // This is a pending transport view, never a claimed local-executor result.
  commandResults.set(commandId,{commandId,conversationId,status:'pending'}); updateButtons();
  let timer;
  try {
    const deadline = new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('请求回执尚未取得，请核对执行结果。')),12000); timer?.unref?.(); });
    const result = await Promise.race([post('command',{commandId,parameters,conversationId,...detail?.sourceDocument?{sourceDocument:detail.sourceDocument}:{},...detail?.confirmed===true?{confirmed:true}:{}}),deadline]);
    if (!current()) return;
    if (result.ok !== true || typeof result.executionId !== 'string' || !result.executionId) throw new Error('请求回执尚未取得，请核对执行结果。');
    // Acceptance cannot release the single task or manufacture its result.
    activeCommand = {commandId,conversationId,executionId:result.executionId,status:'running',cancelRequested:false};
    commandResults.set(commandId,activeCommand);
    busy = true; busyRevision++;
  } catch (error) {
    if (!current()) return;
    if(error.rejected && request.previousCommand){commandResults.set(commandId,request.previousCommand);notice(error.message);}
    else commandResults.set(commandId,{commandId,conversationId,status:error.rejected ? 'failed' : 'unknown',error:{message:error.message}});
    if (!error.rejected) connectionIssue('执行回执尚未核对，请重新连接核对状态。');
  } finally { clearTimeout(timer); if (current()) finishRequest(request); updateButtons(); }
}
async function checkCommandReceipt(detail) {
  if (!modelUiEnabled || !modelContextAllowed || !directCommandsAvailable || busy || commandPending() || pendingRequests.has('session') ||
      historyEnabled() && (conversationReadOnly || persistenceFailed())) return;
  const commandId=detail?.commandId, conversationId=commandConversationId(), command=commandResults.get(commandId);
  if(!commandsReady && command?.receiptCheck?.cleanupPending!==true)return;
  if (!conversationId || detail?.conversationId !== conversationId || !command || command.status !== 'unknown' || command.canInspectReceipt !== true ||
      typeof command.executionId !== 'string' || detail.executionId !== command.executionId || command.receiptCheck?.checking) return;
  const request=beginRequest('command-check',{commandId,conversationId,executionId:command.executionId,accountEpoch,contextEpoch,receiptRevision:receiptRevision(command)});
  const current=()=>ownsRequest(request) && request.accountEpoch===accountEpoch && request.contextEpoch===contextEpoch && request.conversationId===commandConversationId() && commandResults.get(commandId)?.executionId===request.executionId;
  const controller=typeof AbortController==='function' ? new AbortController() : null;
  // A 202 is admission only. Keep this small request owner until a newer
  // authoritative projection arrives, never manufacture a result from the ACK.
  request.receiptTimer=setTimeout(()=>{
    if (!current()) return;
    finishRequest(request); controller?.abort();
    if (busy) commandStopUnavailable=true;
    notice('核对回执尚未取得，原结果仍待核对。'); updateButtons();
  },12000); request.receiptTimer?.unref?.();
  notice(); updateButtons();
  try {
    const result=await post('command/check',{conversationId,commandId,executionId:request.executionId},controller?{signal:controller.signal}:{});
    if (!current()) return;
    if (result.ok!==true || result.executionId!==undefined && result.executionId!==request.executionId) throw new Error('核对请求未被确认，原结果仍待核对。');
  } catch (error) {
    if (!current()) return;
    finishRequest(request); if(busy)commandStopUnavailable=true;
    notice(error.message || '核对未完成，原结果仍待核对。'); updateButtons();
  }
}
async function acknowledgeCabinetReceipt(detail) {
  if (!modelUiEnabled || !modelContextAllowed || !directCommandsAvailable || busy || commandPending() || pendingRequests.has('session') || historyEnabled() && (conversationReadOnly || persistenceFailed())) return;
  const commandId=detail?.commandId,conversationId=commandConversationId(),command=commandResults.get(commandId);
  if(!conversationId||detail?.conversationId!==conversationId||!command||command.canAcknowledgeReceipt!==true||command.executionId!==detail.executionId||command.receiptCheck?.revision!==detail.revision)return;
  const request=beginRequest('command-check',{commandId,conversationId,executionId:command.executionId,accountEpoch,contextEpoch,receiptRevision:receiptRevision(command)});
  const current=()=>ownsRequest(request)&&request.accountEpoch===accountEpoch&&request.contextEpoch===contextEpoch&&request.conversationId===commandConversationId()&&commandResults.get(commandId)?.executionId===request.executionId;
  notice();updateButtons();
  try{const result=await post('command/acknowledge',{conversationId,commandId,executionId:request.executionId,revision:detail.revision,confirmed:true});if(current()&&result.ok!==true)notice('原回执确认尚未完成。');}
  catch(error){if(current())notice(error.message||'原回执确认尚未完成。');}
  finally{if(current())finishRequest(request);updateButtons();}
}
async function inspectOriginalCabinetJob(detail) {
  if (!modelUiEnabled || !modelContextAllowed || !directCommandsAvailable || busy || commandPending() || pendingRequests.has('session') || historyEnabled() && (conversationReadOnly || persistenceFailed())) return;
  const commandId=detail?.commandId,conversationId=commandConversationId(),command=commandResults.get(commandId);
  if(!conversationId||detail?.conversationId!==conversationId||!command||command.canInspectCabinetJob!==true||command.executionId!==detail.executionId)return;
  const request=beginRequest('command-check',{commandId,conversationId,executionId:command.executionId,accountEpoch,contextEpoch,receiptRevision:receiptRevision(command)});
  const current=()=>ownsRequest(request)&&request.accountEpoch===accountEpoch&&request.contextEpoch===contextEpoch&&request.conversationId===commandConversationId()&&commandResults.get(commandId)?.executionId===request.executionId;
  notice();updateButtons();
  try{const result=await post('command/recover',{conversationId,commandId,executionId:request.executionId});if(current()&&result.ok!==true)notice('原作业读取尚未完成。');}
  catch(error){if(current())notice(error.message||'原作业读取尚未完成。');}
  finally{if(current())finishRequest(request);updateButtons();}
}
function turnReceipt(conversation, request){
  if(!request?.requestId)return null;
  const receipt=conversation?.id===request?.conversationId?conversation?.turnBinding:null;
  if(!receipt||receipt.requestId!==request?.requestId)return null;
  if(typeof receipt.turnId==='string'&&receipt.turnId)return 'started';
  if(['interrupted','failed'].includes(receipt.status))return 'not_sent';
  return null;
}
function turnSendBlocked(conversationId){
  const request=pendingRequests.get('turn');
  return uncertainTurns.has(conversationId)||Boolean(request?.posted&&request.requestId&&request.conversationId===conversationId);
}
function rememberUncertainTurn(request){
  if(!request?.posted||request.accountEpoch!==accountEpoch||!request.conversationId||turnReceipt(lastSession?.conversation,request))return;
  uncertainTurns.set(request.conversationId,request);
}
function reconcileTurnReceipt(conversation){
  const pending=pendingRequests.get('turn'),uncertain=uncertainTurns.get(conversation?.id);
  const request=uncertain||(pending?.posted?pending:null),receipt=turnReceipt(conversation,request);
  if(!receipt)return;
  uncertainTurns.delete(conversation.id);
  if(request===pending)finishRequest(request);
  if(receipt==='started')consumeSubmittedInputs(request);
  if(transientNotice==='本轮发送结果尚未核实，请等待原对话回执。')notice(receipt==='not_sent'?'本轮未发送，已保留输入。':'已核实 Codex 收到本轮请求。');
}
function consumeSubmittedInputs(request){
  if(request.accountEpoch!==accountEpoch||request.conversationId!==skillsConversation())return;
  if(request.skillIds.length){
    for(const skill of request.skillIds)skillSelection.delete(skill);
    renderSkills();$('skills-message').textContent='已提交本轮技能选择；执行结果以对话回执为准。';
  }
  if(request.attachments.length){
    const submitted=new Set(request.attachments.map(item=>item.id));
    closeImagePreview(false);for(const item of conversationAttachments.get(activeConversationId)||[])if(submitted.has(item.id))releaseAttachmentPreview(item);
    conversationAttachments.set(activeConversationId,(conversationAttachments.get(activeConversationId)||[]).filter(item=>!submitted.has(item.id)));
  }
  if(request.clearDraft&&draftRevision===request.draftRevision&&$('prompt').value===request.draft){
    $('prompt').value='';$('prompt').style.height='';draftRevision++;rememberDraft();
  }
}
async function send(text, { clearDraft = true } = {}) {
  const trimmed=text.trim(),conversationId=skillsConversation();
  if (!ready || busy || (selectionReadUnconfirmed && $('include-selection').checked) || modelPermissionChecking() || commandPending() || pendingRequests.has('session') || attachmentRead || skillRead || staleSkillSelection || modelUiEnabled&&modelSelectionAvailable&&(!selectedModel||!effortSelectionReady()) || historyEnabled() && (conversationReadOnly || persistenceFailed()) || !trimmed || steerReceiptsBlocked(conversationId) || isUncertainSteer(conversationId,trimmed) || turnSendBlocked(conversationId)) return;
  cancelDraftTimer();
  invalidateRequests();
  const request = beginRequest('turn', { requestId:conversationId?crypto.randomUUID():null, clearDraft, draftRevision, draft: $('prompt').value, submittedContext:contextFlags(), waitingForDraft:Boolean(draftSaveWork), accountEpoch, conversationId, skillIds:Object.freeze([...skillSelection]), model:modelUiEnabled&&modelSelectionAvailable?selectedModel:undefined, effort:modelUiEnabled&&modelSelectionAvailable&&selectedEffort?selectedEffort:undefined, attachments:Object.freeze(pendingAttachments().slice()) });
  notice(); busy = true; $('activity-text').textContent = '正在提交请求…'; updateButtons();
  if (!canonical) { messages.push({ id: crypto.randomUUID(), role: 'user', text: trimmed, tools: [] }); renderConversation(); }
  try {
    if (draftSaveWork) { await draftSaveWork; if (!ownsRequest(request)) return; request.waitingForDraft=false;busy=true;updateButtons(); }
    const draft = currentDraft();
    const clearSubmittedDraft = clearDraft && draftRevision === request.draftRevision && $('prompt').value === request.draft;
    request.posted=true;
    const result = await post('turn', { message: trimmed, context: request.submittedContext,...(request.requestId?{requestId:request.requestId,conversationId}:{}),...(request.model!==undefined?{model:request.model}:{}),...(request.effort!==undefined?{effort:request.effort}:{}),
      ...(request.attachments.length ? {conversationId:request.conversationId,attachments:request.attachments.map(({name,mediaType,data}) => ({name,mediaType,data}))} : {}),
      ...(request.skillIds.length ? {conversationId:request.conversationId,skillIds:request.skillIds} : {}),
      ...(historyEnabled() ? {draft, ...(clearSubmittedDraft ? {clearDraftOnStart:true} : {})} : {}) });
    if (!ownsRequest(request)) return;
    if(result.status==='not_sent'){
      if(request.busyRevision===busyRevision)busy=false;
      notice('已停止，本轮未发送。');
      return;
    }
    consumeSubmittedInputs(request);
    if (result.session && request.busyRevision === busyRevision && request.commandRevision === commandRevision) applyConversation(result);
    if (request.busyRevision === busyRevision && busy) $('activity-text').textContent = 'Codex 正在处理…';
  } catch (error) {
    if (!ownsRequest(request)) return;
    const observed = request.busyRevision !== busyRevision;
    const receipt=turnReceipt(lastSession?.conversation,request);
    if(receipt==='started'){consumeSubmittedInputs(request);notice('已核实 Codex 收到本轮请求。');}
    else if(!request.requestId||receipt==='not_sent'||error.outcome==='not_sent'||error.rejected&&error.httpStatus<500&&error.outcome!=='unknown')notice(error.message+(observed&&busy?'；服务仍在处理，请以执行回执为准。':''));
    else{rememberUncertainTurn(request);notice('本轮发送结果尚未核实，请等待原对话回执。');}
    if (!observed) busy = false;
  } finally { finishRequest(request); updateButtons(); if (historyEnabled() && !busy) scheduleDraftSave(); }
}
// A deliberate, separate action: never reinterpret a normal send as a steer.
function isUncertainSteer(conversationId,message){
  const local=uncertainSteers.get(conversationId),projection=projectedSteerReceipts.get(conversationId);
  return Boolean(local&&[...local.values()].includes(message)||projection?.records.some(item=>['pending','unknown'].includes(item.status)&&item.message===message));
}
function hasUncertainSteers(conversationId){
  return Boolean(uncertainSteers.get(conversationId)?.size||projectedSteerReceipts.get(conversationId)?.records.some(item=>['pending','unknown'].includes(item.status)));
}
function steerReceiptsBlocked(conversationId){
  if(!modelUiEnabled||!steerReceiptsAvailable)return false;
  const projection=projectedSteerReceipts.get(conversationId);return typeof conversationId!=='string'||!projection||projection.invalid===true;
}
// Only the server's structured, revisioned facts may resolve a local unknown.
// A late snapshot cannot erase a newer receipt or cross the account scope.
function reconcileSteerReceipts(value){
  if(!modelUiEnabled||!steerReceiptsAvailable)return;
  const conversation=value?.conversation,id=conversation?.id,revision=conversation?.steerReceiptsRevision,old=projectedSteerReceipts.get(id);
  if(typeof id!=='string'||!id)return;
  if(Number.isSafeInteger(revision)&&revision>=0&&old&&revision<old.revision)return;
  const invalid=()=>projectedSteerReceipts.set(id,{revision:old?.revision??-1,signature:old?.signature??'',records:old?.records??[],invalid:true});
  if(!Number.isSafeInteger(revision)||revision<0||!Array.isArray(conversation.steerReceipts)||conversation.steerReceipts.length>32){invalid();return;}
  const seen=new Set(),records=[];
  for(const item of conversation.steerReceipts){
    if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.requestId)||seen.has(item.requestId)||typeof item.turnId!=='string'||!item.turnId||item.turnId.length>200||typeof item.message!=='string'||!item.message.trim()||item.message.length>16000||!['pending','unknown','accepted','not_sent'].includes(item.status)){invalid();return;}
    seen.add(item.requestId);records.push({requestId:item.requestId,turnId:item.turnId,message:item.message,status:item.status});
  }
  const signature=JSON.stringify(records);
  if(old&&revision===old.revision&&signature!==old.signature){invalid();return;}
  const local=uncertainSteers.get(id);
  if(local){for(const item of records){if(local.has(item.requestId)&&local.get(item.requestId)!==item.message){invalid();return;}}}
  projectedSteerReceipts.set(id,{revision,signature,records,invalid:false});
  if(local){for(const item of records)if(['accepted','not_sent'].includes(item.status))local.delete(item.requestId);if(!local.size)uncertainSteers.delete(id);}
  const pending=pendingRequests.get('steer'),definitive=records.find(item=>item.requestId===pending?.requestId&&item.message===pending.message&&['accepted','not_sent'].includes(item.status));
  if(definitive&&pending.accountEpoch===accountEpoch&&pending.conversationId===id){
    steerFeedbackBinding={conversationId:id};steerFeedbackKind=definitive.status;
    $('steer-feedback').hidden=false;$('steer-feedback').textContent=definitive.status==='accepted'?'最近的补充指令已由 Codex 接收，是否执行尚待确认。':'最近的补充指令未发送。';
    if(definitive.status==='accepted'&&pending.draftRevision===draftRevision&&$('prompt').value===pending.draft){$('prompt').value='';$('prompt').style.height='';draftRevision++;rememberDraft();if(historyEnabled())scheduleDraftSave();}
  }
}
function markSteerUnknown(request){
  const known=projectedSteerReceipts.get(request.conversationId)?.records.find(item=>item.requestId===request.requestId);
  if(known&&known.message===request.message&&['accepted','not_sent'].includes(known.status))return;
  let items=uncertainSteers.get(request.conversationId);if(!items){items=new Map();uncertainSteers.set(request.conversationId,items);}items.set(request.requestId,request.message);
  if(lastSession?.conversation?.id===request.conversationId&&request.accountEpoch===accountEpoch){steerFeedbackBinding={conversationId:request.conversationId};steerFeedbackKind='unknown';const feedback=$('steer-feedback');feedback.hidden=false;feedback.textContent='补充指令是否送达尚未确认，请核对记录；不要重复提交相同内容。';}
}
function steerBinding(){
  const conversation=lastSession?.conversation,turn=conversation?.turnBinding;
  if(!modelUiEnabled||!steerAvailable||!ready||!busy||commandRunning()||commandPending()||conversationReadOnly||pendingRequests.has('session')||turn?.status!=='streaming'||typeof turn.turnId!=='string'||!turn.turnId||typeof conversation?.id!=='string'||!conversation.id)return null;
  return {conversationId:conversation.id,turnId:turn.turnId};
}
async function steer(){
  const binding=steerBinding(),message=$('prompt').value.trim();
  if(!binding||!message||message.length>16000||pendingRequests.has('steer')||pendingRequests.has('interrupt')||visibleInputId!==null||['pending','submitting'].includes(dynamicApproval?.state)||attachmentRead||pendingAttachments().length||historyEnabled()&&persistenceFailed()||steerReceiptsBlocked(binding.conversationId)||isUncertainSteer(binding.conversationId,message))return;
  const request=beginRequest('steer',{...binding,message,requestId:crypto.randomUUID(),draft:$('prompt').value,draftRevision,accountEpoch,contextEpoch,connectionGeneration:modelPickerIdentity.connectionGeneration,accountRevision:modelPickerIdentity.accountRevision});
  const current=()=>ownsRequest(request)&&request.accountEpoch===accountEpoch&&request.contextEpoch===contextEpoch&&request.connectionGeneration===modelPickerIdentity.connectionGeneration&&request.accountRevision===modelPickerIdentity.accountRevision&&steerBinding()?.conversationId===request.conversationId&&steerBinding()?.turnId===request.turnId;
  const feedback=$('steer-feedback');steerFeedbackBinding=binding;steerFeedbackKind='pending';feedback.hidden=false;feedback.textContent='正在提交补充指令…';updateButtons();
  const controller=typeof AbortController==='function'?new AbortController():null;let deadline;
  try{
    const timeout=new Promise((_,reject)=>{deadline=setTimeout(()=>{controller?.abort();reject(new Error('补充指令的回执超时'));},30000);});
    const result=await Promise.race([post('steer',{conversationId:request.conversationId,turnId:request.turnId,requestId:request.requestId,message},controller?{signal:controller.signal}:{}),timeout]);
    if(!current()){if(ownsRequest(request)&&request.accountEpoch===accountEpoch&&lastSession?.conversation?.id===request.conversationId)markSteerUnknown(request);return;}
    if(result?.ok!==true||result.status!=='accepted')throw new Error('接收状态未知');
    steerFeedbackKind='accepted';feedback.textContent='Codex 已接收补充指令；是否已应用请查看后续进展。';
    if(draftRevision===request.draftRevision&&$('prompt').value===request.draft){$('prompt').value='';$('prompt').style.height='';draftRevision++;rememberDraft();if(historyEnabled())scheduleDraftSave();}
  }catch(error){
    if(!current()){if(ownsRequest(request)&&request.accountEpoch===accountEpoch&&lastSession?.conversation?.id===request.conversationId)markSteerUnknown(request);return;}
    if(!error.rejected||!Number.isInteger(error.httpStatus)||error.httpStatus<400||error.httpStatus>=500||error.outcome==='unknown')markSteerUnknown(request);
    else {steerFeedbackKind='error';feedback.textContent=error.message||'补充指令未被接收，请检查当前任务。';}
  }finally{clearTimeout(deadline);finishRequest(request);updateButtons();}
}
$('steer').addEventListener('click',()=>{void steer();});
$('composer').addEventListener('submit', event => { event.preventDefault(); send($('prompt').value); });
$('skills-refresh').addEventListener('click',()=>{void loadSkills();});
$('skills-clear-stale').addEventListener('click',()=>{
  if(!staleSkillSelection||busy||skillRead)return;
  staleSkillSelection=false;$('skills-message').textContent='已取消失效的技能选择。';updateButtons();
});
$('prompt').addEventListener('input', () => { draftRevision++; $('prompt').style.height = 'auto'; $('prompt').style.height = Math.min(180, $('prompt').scrollHeight) + 'px'; updateButtons(); if (historyEnabled()) scheduleDraftSave(); });
$('prompt').addEventListener('blur', () => { if (historyEnabled()) { cancelDraftTimer(); rememberDraft(); void saveDraft(); } });
$('prompt').addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key !== 'Enter') return;
  if (event.ctrlKey || event.metaKey || modelUiEnabled && !event.shiftKey && !event.altKey) { event.preventDefault(); send($('prompt').value); }
});
// Suggestions fill the input first; the user can inspect or change the request before sending.
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { $('prompt').value = button.dataset.prompt; $('prompt').dispatchEvent(new Event('input')); $('prompt').focus(); }));
function initializeCommandAuthoring(request){
  const conversationId=commandConversationId();
  if(!request?.commandAuthoring||request.authoringStarted||request.accountEpoch!==accountEpoch||!modelUiEnabled||!modelContextAllowed||!conversationId||conversationId===request.conversationId||messages.length||lastSession?.conversation?.readOnly===true)return;
  request.authoringStarted=true;
  if(!historyEnabled()){activeConversationId=conversationId;conversationReadOnly=false;}
  $('include-document').checked=false;$('include-selection').checked=false;
  const untouchedLocalDraft=!historyEnabled()&&draftRevision===request.draftRevision&&$('prompt').value===request.draft.text;
  if(!$('prompt').value||untouchedLocalDraft){
    $('prompt').value=request.commandKind==='sequence'
      ?'我想创建一个个人命令（只读步骤）：\n请先帮我明确要串联的查询、输入参数和适用范围，再生成只读步骤命令草稿。等我确认后保存，不要自动执行。\n我的需求是：'
      :'我想创建一个个人命令（C#）：\n请先帮我明确目标、需要填写的参数和适用范围，再生成 C# 命令草稿。固定选项、标高和构件类型等参数尽量使用下拉选择，并标明中文名称和单位。等我确认后保存，不要自动执行。\n我的需求是：';
    $('prompt').dispatchEvent(new Event('input'));
  }
  if(!historyEnabled()&&request.draft.text)notice('已新建命令对话；原草稿保留在当前页面，当前服务未开启历史记录。');
  $('prompt').focus();
  window.dispatchEvent(new CustomEvent('buildx-command-authoring-started',{detail:{conversationId,kind:request.commandKind}}));
}
async function createConversation({commandAuthoring=false,commandKind='csharp'}={}){
  if (busy || modelPermissionChecking() || commandPending() || pendingRequests.has('session')) return;
  if(commandAuthoring&&(!modelUiEnabled||!modelContextAllowed||!['csharp','sequence'].includes(commandKind)))return;
  const draft = currentDraft(); rememberDraft(); cancelDraftTimer(); invalidateHistoryRead();
  const conversationId=activeConversationId||commandConversationId();
  if(commandAuthoring&&!historyEnabled()&&conversationId){
    conversationDrafts.set(conversationId,{...draft,revision:draftRevision,dirty:true});
    if(conversationDrafts.size>2000)conversationDrafts.delete(conversationDrafts.keys().next().value);
  }
  invalidateRequests(); const request = beginRequest('session', { route:'new-chat',commandAuthoring,commandKind,accountEpoch,conversationId,draft,draftRevision }); notice(); updateButtons();
  try {
    if (draftSaveWork) { await draftSaveWork; if (!ownsRequest(request)) return; }
    const result = await post('new-chat',historyEnabled() ? {draft} : {}); if (!ownsRequest(request)) return;
    if(commandAuthoring&&(typeof result.session?.conversation?.id!=='string'||result.session.conversation.id===request.conversationId||!Array.isArray(result.session.messages)||result.session.messages.length))throw new Error('新对话尚未确认，原草稿已保留，请重新创建命令。');
    if (historyEnabled() && result.session?.conversation?.id) { applyConversation(result); if (!Array.isArray(result.history?.sessions)) void refreshHistory(); $('prompt').focus(); return; }
    messages = []; lastSession = null; context = null; messageNodes.clear(); openedTools.clear(); $('transcript').replaceChildren(); $('context-reset').hidden = true;
    $('include-document').checked = false; $('include-selection').checked = false;
    if (result.session) { contextEpoch = result.session.contextEpoch ?? null; applyConversation(result); } else { renderConversation(); renderContext(); }
    $('prompt').focus(); updateButtons();
  } catch (error) { if (ownsRequest(request)) notice(error.message); }
  finally { finishRequest(request); updateButtons(); }
}
$('new-chat').addEventListener('click',()=>{void createConversation();});
window.addEventListener('buildx-create-command',event=>{void createConversation({commandAuthoring:true,commandKind:event.detail&&Object.hasOwn(event.detail,'kind')?event.detail.kind:'csharp'});});
async function selectConversation(id) {
  if (!canReadHistory() || typeof id !== 'string' || !id || id.length > 200 || id === activeConversationId || busy || commandPending() || pendingRequests.has('session')) return;
  const draft = currentDraft(); rememberDraft(); cancelDraftTimer(); invalidateHistoryRead();
  invalidateRequests(); const request = beginRequest('session',{route:'chat/select',targetId:id}); notice(); updateButtons();
  try {
    if (draftSaveWork) { await draftSaveWork; if (!ownsRequest(request)) return; }
    const result = await post('chat/select',{conversationId:id,draft}); if (!ownsRequest(request)) return;
    applyConversation(result); if (!Array.isArray(result.history?.sessions)) void refreshHistory();
  } catch (error) { if (ownsRequest(request)) notice(error.message); }
  finally { finishRequest(request); updateButtons(); }
}
async function interruptTask(expectedCommand = null) {
  if (!busy || commandPending() || commandStopUnavailable || pendingRequests.has('interrupt')) return;
  const pendingTurn=pendingRequests.get('turn');
  if(!expectedCommand&&pendingTurn?.waitingForDraft){
    finishRequest(pendingTurn);busy=false;notice('已停止，本轮未发送。');updateButtons();return;
  }
  const command = commandRunning() ? activeCommand : null;
  if (expectedCommand && (!command || expectedCommand.executionId !== command.executionId || expectedCommand.conversationId !== command.conversationId || command.status === 'stopping' || command.cancelRequested)) return;
  const request = beginRequest('interrupt'); updateButtons();
  try { await post('interrupt',command ? {executionId:command.executionId,conversationId:command.conversationId} : {}); if (ownsRequest(request) && request.busyRevision === busyRevision && busy) $('activity-text').textContent = sourceWorkspace()
    ? '正在请求停止；尚未返回的源码工具结果仍需核对…' : customerWorkspace()
      ? '正在请求停止本轮对话；请等待服务回执…' : '正在请求停止；已开始的模型操作仍需回查…'; }
  catch (error) { if (ownsRequest(request) && request.commandRevision === commandRevision) notice(error.message); }
  finally { finishRequest(request); updateButtons(); }
}
$('stop').addEventListener('click',() => { void interruptTask(); });
$('reconnect').addEventListener('click', async () => {
  if ((busy && !(customerWorkspace() && customerRecovery)) || commandPending() || pendingRequests.has('session') || statusRead) return;
  invalidateRequests(); const request = beginRequest('session', { route: 'reconnect' }); notice(); updateButtons();
  try {
    const data = await refreshStatus(); if (!data || !ownsRequest(request)) return;
    if ((customerWorkspace() || modelUiEnabled && directCommandsAvailable) && data.busy !== false) { notice('服务仍在处理或任务状态尚未结束；此次仅核对状态，没有请求重连。'); return; }
    await post('reconnect'); if (ownsRequest(request)) { clearCommands(); connectEvents(); }
  }
  catch (error) { if (ownsRequest(request) && request.commandRevision === commandRevision) notice(error.message); }
  finally { finishRequest(request); updateButtons(); }
});
for (const id of ['include-document', 'include-selection']) $(id).addEventListener('change', () => { if (!modelContextAllowed) $(id).checked = false; if (id === 'include-selection') { if ($(id).checked) { void readSelectionPreview(); } else clearSelectionPreview(); } renderContext(); updateButtons(); if (historyEnabled()) { draftRevision++; scheduleDraftSave(); } });
$('refresh-context').addEventListener('click', async () => {
  if (selectionReadUnconfirmed) return;
  if (!modelContextAllowed || busy || commandPending() || pendingRequests.has('session') || pendingRequests.has('context')) return;
  if ($('include-selection').checked) { void readSelectionPreview(); return; }
  invalidateRequests(); clearSelectionPreview(); const request = beginRequest('context', {accountEpoch, contextEpoch, conversationId:activeConversationId, identityKey:commandIdentityKey(), previewRevision:selectionPreviewRevision}); notice(); updateButtons();
  try { const flags = contextFlags(); const result = await post('context', flags); if (ownsRequest(request) && request.commandRevision === commandRevision) { context = result.context ?? null; if (flags.includeSelection && $('include-selection').checked && request.previewRevision === selectionPreviewRevision && request.accountEpoch === accountEpoch && request.contextEpoch === contextEpoch && request.conversationId === activeConversationId && request.identityKey === commandIdentityKey()) { clearSelectionPreview(); selectionPreview = {revision:selectionPreviewRevision, accountEpoch, contextEpoch, conversationId:activeConversationId, identityKey:commandIdentityKey(), status:'success', context}; } renderContext(); } }
  catch (error) { if (ownsRequest(request) && request.commandRevision === commandRevision) notice(error.message); }
  finally { finishRequest(request); updateButtons(); }
});
updateButtons();
refreshStatus().then(data => {if(data&&(!data.account?.required||data.account.signedIn))connectEvents();}).catch(error => connectionIssue(error.message + '，请点击重新连接。'));
function clearAccountDisplay(isBusy=false){
  clearAccessPolicy('账号已变化，访问范围尚未核实。');
  clearModelPermission('账号已变化，权限尚未核实。');
  clearModelReceipt();
  clearTerminal();
  clearSkills('账号已变化，请重新读取技能。');skillsSupported=false;
  mcpCandidateRead=null;mcpCandidatesAvailable=false;
  if(typeof window!=='undefined'&&typeof CustomEvent==='function')window.dispatchEvent(new CustomEvent('buildx-mcp-candidates-result',{detail:{status:'cleared'}}));
  showUserInput(null);
  uncertainSteers.clear();projectedSteerReceipts.clear();steerAvailable=false;steerReceiptsAvailable=false;steerFeedbackBinding=null;steerFeedbackKind=null;$('steer-feedback').textContent='';$('steer-feedback').hidden=true;
  clearModelPicker();modelPickerIdentity={connectionGeneration:null,accountRevision:null};
  attachmentRead=null;closeImagePreview(false);clearAttachmentDrafts();turnAttachmentsAvailable=false;
  libraryAttachmentEpoch++;libraryAttachmentBindings.clear();
  ready=false;
  modelAccount=null;modelConfirmation=null;directCommandsAvailable=false;clearCommands();commandIdentityVisible=true;commandStopUnavailable=false;commandIdentityFacts={connectionGeneration:null,accountRevision:null,userId:null};
  cancelDraftTimer();invalidateHistoryRead();conversationDrafts.clear();activeConversationId=null;conversationReadOnly=false;
  draftSaveController?.abort();draftSaveController=null;draftSaveWork=null;
  historyState={available:historyEnabled(),sessions:[],activeId:null,loading:false,error:'',nextCursor:null,complete:true};
  if (historyAvailable) { $('prompt').value='';$('prompt').style.height='';draftRevision++; }
  accountEpoch++;invalidateRequests();invalidateStatusRead();stream?.close();stream=null;messages=[];lastSession=null;context=null;contextEpoch=null;messageNodes.clear();openedTools.clear();
  uncertainTurns.clear();
  interruptionNotice='';transientNotice='';customerRecovery=false;notice();
  busy=isBusy;busyRevision++;
  $('transcript').replaceChildren();$('include-document').checked=false;$('include-selection').checked=false;
  renderConversation();renderContext();
}
if(typeof window!=='undefined')window.addEventListener('buildx-account-changed',()=>{
  clearAccountDisplay();
  refreshStatus().then(data=>{if(data&&(!data.account?.required||data.account.signedIn))connectEvents();}).catch(()=>connectionIssue('账号状态读取未完成，请刷新。'));
});
if(typeof window!=='undefined')window.addEventListener('buildx-account-refreshed',()=>{
  const revision=accountEpoch;
  refreshStatus().then(data=>{if(!data||revision!==accountEpoch)return;if(!data.account?.required||data.account.signedIn)connectEvents();else if(!data.account.retainedSession)clearAccountDisplay(Boolean(data.busy));else{invalidateStatusRead();stream?.close();stream=null;}}).catch(()=>connectionIssue('账号核验未完成；对话记录仍保留。'));
});
if (typeof window !== 'undefined') {
  window.addEventListener('buildx-image-preview-open',event=>{void openImagePreview(event.detail);});
  window.addEventListener('pagehide',()=>{clearAccessPolicy();attachmentRead=null;libraryAttachmentEpoch++;closeImagePreview(false);clearAttachmentDrafts();updateButtons();});
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&imagePreview){event.preventDefault();closeImagePreview();}});
  window.addEventListener('buildx-model-permission-select',event=>{void changeModelPermission(event.detail?.level);});
  window.addEventListener('buildx-model-permission-refresh',()=>{void refreshModelPermissionStatus();});
  window.addEventListener('buildx-access-policy-select',event=>{void changeAccessPolicy(event.detail);});
  window.addEventListener('buildx-model-receipt-check',event=>{void modelReceiptAction('check',event.detail);});
  window.addEventListener('buildx-model-receipt-acknowledge',event=>{void modelReceiptAction('acknowledge',event.detail);});
  window.addEventListener('buildx-model-receipt-recover',event=>{void modelReceiptAction('recover',event.detail);});
  window.addEventListener('buildx-model-receipt-restore-visual',event=>{void modelReceiptAction('restore-visual',event.detail);});
  window.addEventListener('buildx-terminal-action',event=>{void terminalAction(event.detail);});
  window.addEventListener('buildx-model-picker-mounted',publishModelPicker);
  window.addEventListener('buildx-model-picker-refresh',()=>{void loadModels();});
  window.addEventListener('buildx-model-picker-select',event=>{if(modelUiEnabled&&modelSelectionAvailable&&ready&&!busy&&!modelPickerLoading&&!pendingRequests.has('session')&&modelChoices.some(item=>item.model===event.detail?.model)){selectModel(event.detail.model);modelPickerError='';rememberModelPreference();updateButtons();}});
  window.addEventListener('buildx-model-effort-select',event=>{if(modelUiEnabled&&modelSelectionAvailable&&ready&&!busy&&!modelPickerLoading&&!pendingRequests.has('session')&&selectedModelEfforts()?.some(item=>item.reasoningEffort===event.detail?.effort)){selectedEffort=event.detail.effort;modelPickerError='';rememberModelPreference();updateButtons();}});
  window.addEventListener('buildx-model-mounted', publishModelView);
  window.addEventListener('buildx-mcp-candidates-read',()=>{void loadMcpCandidates();});
  window.addEventListener('buildx-model-command',event => { void runCommand(event.detail); });
  window.addEventListener('buildx-model-command-stop',event => { void interruptTask(event.detail); });
  window.addEventListener('buildx-model-command-check',event => { void checkCommandReceipt(event.detail); });
  window.addEventListener('buildx-model-command-acknowledge',event => { void acknowledgeCabinetReceipt(event.detail); });
  window.addEventListener('buildx-model-command-recover',event => { void inspectOriginalCabinetJob(event.detail); });
  window.addEventListener('buildx-history-select',event => { void selectConversation(event.detail?.conversationId); });
  window.addEventListener('buildx-history-refresh',event => { void refreshHistory(event.detail?.cursor ?? null); });
  window.addEventListener('buildx-attachments-add',event => { void addAttachments(event.detail?.files); });
  window.addEventListener('buildx-project-attach-begin',event=>{if(typeof event.detail?.resolve==='function')event.detail.resolve(beginLibraryAttachment());});
  window.addEventListener('buildx-project-attach',event=>{if(typeof event.detail?.resolve==='function')void addLibraryAttachment(event.detail.value,event.detail.binding).then(event.detail.resolve);});
  window.addEventListener('buildx-attachments-remove',event => { removeAttachment(event.detail?.id); });
}
