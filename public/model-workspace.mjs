import {createCommandField,COMMAND_PARAMETER_LABELS,isExactIdRule,parseExactIdValue} from './command-fields.mjs';
import {createCommandChoiceField} from './command-choice-field.mjs';
import {createParameterChangeField} from './parameter-change-field.mjs';
import {createPersonalCommandFields} from './personal-command-fields.mjs';
import {clipboardImageFiles,hasTransferredFiles} from './clipboard-attachments.mjs';

// Display adapter for the fixed model workspace. The original app owns every
// request, account, draft and conversation; this module only presents intents.
export const MODEL_COMMANDS = Object.freeze([
  Object.freeze({id:'document', icon:'▤', name:'模型概况', description:'查看当前文档与视图'}),
  Object.freeze({id:'selection', icon:'⌖', name:'当前选择', description:'查看选中构件的信息'}),
  Object.freeze({id:'levels', icon:'≋', name:'标高列表', description:'查看模型中的标高'}),
  Object.freeze({id:'search', icon:'⌕', name:'构件查询', description:'按名称和类别查找构件', parameters:true}),
]);
export const MODEL_CATEGORIES = Object.freeze([
  Object.freeze({value:'all', label:'全部类别', builtIn:null}),
  Object.freeze({value:'walls', label:'墙', builtIn:'OST_Walls'}),
  Object.freeze({value:'pipes', label:'管道', builtIn:'OST_PipeCurves'}),
  Object.freeze({value:'equipment', label:'机械设备', builtIn:'OST_MechanicalEquipment'}),
]);

// The transport owner sends only a named command and structured parameters.
export function modelCommandParameters(id, parameters = {}) {
  if (MODEL_COMMANDS.some(command => command.id === id && !command.parameters)) return {ok:true, parameters:{}};
  if (id !== 'search') return {ok:false, error:'请选择可用命令。'};
  if (typeof parameters.keyword !== 'string' || parameters.keyword.length > 200) return {ok:false, error:'关键词最多 200 个字符。'};
  const category = MODEL_CATEGORIES.find(item => item.value === parameters.category);
  if (!category) return {ok:false, error:'请选择有效的构件类别。'};
  const query = {keyword:parameters.keyword.trim(), category:category.value, limit:20, offset:0};
  if (!query.keyword && query.category === 'all') return {ok:false, error:'请输入关键词或选择类别。'};
  return {ok:true, parameters:query};
}

// The server owns the available operations and their schemas. This projection
// adds no execution authority and keeps old four-command servers compatible.
export function modelCommandCatalog(value) {
  if (!Array.isArray(value) || value.length > 128) return [];
  const ids = new Set();
  return value.filter(item => {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,159}$/.test(item.id) || ids.has(item.id) ||
        typeof item.tool !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,159}$/.test(item.tool)) return false;
    ids.add(item.id); return true;
  }).map(item => ({id:item.id,tool:item.tool,name:typeof item.label === 'string' ? item.label.slice(0,160) : item.tool,
    description:typeof item.description === 'string' ? item.description.slice(0,500) : '',
    group:typeof item.group === 'string' ? item.group.slice(0,80) : '其他',readOnly:item.readOnly === true,
    effectKind:item.effectKind==='model_transaction'?'model_transaction':null,
    enabled:item.enabled === true,unavailableReason:typeof item.unavailableReason === 'string' ? item.unavailableReason.slice(0,500) : '',
    manualExecution:item.manualExecution!==false,manualUnavailableReason:typeof item.manualUnavailableReason==='string'?item.manualUnavailableReason.slice(0,500):'',
    inputSchema:item.inputSchema && typeof item.inputSchema === 'object' && item.inputSchema.type === 'object' ? item.inputSchema : null,
    icon:item.readOnly === true ? '⌕' : '◇'}));
}

function exclusiveSelectorKeys(schema) {
  if(!Array.isArray(schema?.oneOf)||schema.oneOf.length<2)return [];
  const keys=[];
  for(const branch of schema.oneOf){
    if(!branch||Object.keys(branch).some(key=>!['required','properties'].includes(key))||!Array.isArray(branch.required)||branch.required.length!==1||!Object.hasOwn(schema.properties||{},branch.required[0]))return [];
    keys.push(branch.required[0]);
  }
  return new Set(keys).size===keys.length?keys:[];
}

export function modelSchemaParameters(command, values) {
  if (!command?.inputSchema || !values || typeof values !== 'object' || Array.isArray(values)) return {ok:false,error:'此命令的参数定义尚未就绪。'};
  const parameters = {}, properties = command.inputSchema.properties || {}, required = new Set(command.inputSchema.required || []);
  for (const [key, rule] of Object.entries(properties)) {
    if (key === 'expected_document') continue;
    const label=COMMAND_PARAMETER_LABELS[key] || key;
    let value = values[key];
    if (value === '' || value === undefined) {
      if (Object.hasOwn(rule,'default')) value = rule.default;
      else if (required.has(key)) return {ok:false,error:'请填写' + label + '。'};
      else continue;
    }
    try {
      if (isExactIdRule(rule)) {
        value=parseExactIdValue(rule,value);
      } else if (rule.type === 'number' || rule.type === 'integer') {
        value = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(value) || rule.type === 'integer' && !Number.isSafeInteger(value)) throw new Error();
        if (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum || rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum) throw new Error();
      } else if (rule.type === 'boolean') {
        if (![true,false,'true','false'].includes(value)) throw new Error();
        value = value === true || value === 'true';
      } else if (rule.type === 'array' || rule.type === 'object' || rule.anyOf || rule.oneOf) {
        if (typeof value === 'string') value = JSON.parse(value);
        if (rule.type === 'array' && !Array.isArray(value) || rule.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error();
      } else {
        if (typeof value !== 'string') throw new Error();
        if (rule.maxLength !== undefined && value.length > rule.maxLength || rule.minLength !== undefined && value.length < rule.minLength) throw new Error();
      }
      if (rule.enum && !rule.enum.includes(value)) throw new Error();
    } catch { return {ok:false,error:label + '的值或格式不正确。'}; }
    parameters[key] = value;
  }
  const selectors=exclusiveSelectorKeys(command.inputSchema);
  if(selectors.length&&selectors.filter(key=>Object.hasOwn(parameters,key)).length!==1)return {ok:false,error:selectors.map(key=>COMMAND_PARAMETER_LABELS[key]||key).join('或')+'，二选一。'};
  if (command.tool === 'revit_save_command') {
    if (Object.hasOwn(parameters,'code') === Object.hasOwn(parameters,'steps')) return {ok:false,error:'请填写 C# 方法体或只读步骤，二选一。'};
    if (Object.hasOwn(parameters,'code') && new TextEncoder().encode(parameters.code).length > 64000) return {ok:false,error:'C# 方法体最多 64000 UTF-8 字节。'};
    if (Object.hasOwn(parameters,'source_request_id') && (Object.hasOwn(parameters,'parameters') || Object.hasOwn(parameters,'steps'))) return {ok:false,error:'参数化命令或步骤组合暂不支持关联执行证据。'};
  }
  if (['revit_get_command','revit_run_command'].includes(command.tool) && !/^[a-f0-9]{64}$/.test(parameters.revision || '')) return {ok:false,error:'请填写保存或列表返回的完整 64 位小写版本。'};
  return {ok:true,parameters};
}

export function modelCommandPresentation(command) {
  if (!command) return null;
  const labels = {pending:'正在提交…',running:'正在读取…',stopping:'正在停止…',completed:'已完成',interrupted:'已停止',failed:'未完成',unknown:'结果待核对'};
  if (!Object.hasOwn(labels,command.status)) return null;
  const diagnostic = typeof command.error?.message === 'string' ? command.error.message : '';
  const requestIds = Array.isArray(command.requestIds) ? command.requestIds.filter(value => typeof value === 'string') : Array.isArray(command.result?.requestIds) ? command.result.requestIds.filter(value => typeof value === 'string') : [];
  const view = {status:labels[command.status],error:command.status === 'unknown' ? '查询结果尚未确认，请核对后再运行。' : diagnostic,diagnostic,requestIds,summary:'',columns:[],rows:[],document:''};
  const cabinetOperation = ['revit_family_create_cabinet','revit_family_save_cabinet','revit_family_close_cabinet'].includes(command.commandId);
  if (cabinetOperation || ['revit_save_command','revit_run_command'].includes(command.commandId)) {
    if (command.status === 'running') view.status = ['revit_save_command','revit_family_save_cabinet'].includes(command.commandId) ? '正在保存…' : '正在执行…';
    if (command.status === 'unknown') view.error = '结果尚未确认，请先核对回执，不要重复提交。';
  }
  // Transport progress describes observed delivery stages, never proof that a
  // model operation has started or completed. Terminal and stop state win.
  if(command.status==='running'&&command.cancelRequested!==true){
    const phases={preparing:['正在准备…','命令已接单，正在准备本次请求。'],waiting_revit:['等待 Revit 返回…','请求已提交，正在等待 Revit 返回结果。'],checking_result:['正在核对结果…','已收到 Revit 返回，正在核对本次结果。']};
    const key=command.progress?.phase,phase=typeof key==='string'&&Object.hasOwn(phases,key)?phases[key]:null;
    if(phase){view.status=phase[0];view.summary=phase[1];}
  }else if(command.status==='running'&&command.cancelRequested===true)view.status='正在停止…';
  if(command.status === 'failed') {
    if(command.error?.code === 'COMMAND_NOT_STARTED' && command.error.outcome === 'not_started'){view.status='未执行';view.error=cabinetOperation?'本次操作未执行。':'本次查询未执行。';}
    else if(command.error?.code === 'COMMAND_REQUEST_EXPIRED' && command.error.outcome === 'expired'){view.status='请求已过期';view.error=cabinetOperation?'本次操作未执行。':'本次查询未执行。';}
    else if(command.error?.code === 'COMMAND_QUERY_FAILED' && command.error.outcome === 'failed')view.error='Revit 未能完成本次查询。';
  }
  if (command.status !== 'completed' || !command.result?.data) return view;
  const data = command.result.data;
  view.document = typeof command.result.document?.title === 'string' ? command.result.document.title : '';
  const text = value => value === null || value === undefined ? '—' : String(value);
  if (command.commandId === 'document') {
    view.columns = ['项目','内容'];
    view.rows = [['模型',view.document || '—'],['当前视图',data.activeView ? [data.activeView.type,data.activeView.id ? '#' + data.activeView.id : ''].filter(Boolean).join(' ') || '—' : '—']];
  } else if (command.commandId === 'levels') {
    view.columns = ['名称','高程（mm）'];
    view.rows = (Array.isArray(data.items) ? data.items : []).slice(0,200).map(item => [text(item.name),text(item.elevation_mm)]);
    view.summary = Number.isSafeInteger(data.total) ? (view.rows.length < data.total ? '显示 ' + view.rows.length + ' / ' + data.total + ' 个标高' : '共 ' + data.total + ' 个标高') : '';
  } else if (['selection','search'].includes(command.commandId)) {
    view.columns = ['名称','类别','ID'];
    view.rows = (Array.isArray(data.items) ? data.items : []).slice(0,200).map(item => [text(item.name),text(item.category),text(item.element_id)]);
    if (Number.isSafeInteger(data.returned) && Number.isSafeInteger(data.total)) view.summary = '显示 ' + data.returned + ' / ' + data.total + ' 项' + (data.has_more || data.truncated ? ' · 仅展示本次返回' : '');
  } else if (command.commandId === 'revit_get_type_parameter_impact') {
    const payload=Object.hasOwn(data,'value')?data.value:data,parameter=payload?.parameter,coverage=payload?.coverage;
    if(payload?.schema_version!==1||!parameter||typeof parameter.has_value!=='boolean'||!Object.hasOwn(parameter,'value_internal')||
      !Array.isArray(payload.instance_ids)||payload.instance_ids.length>500||payload.instance_ids.some(id=>typeof id!=='string')||
      !Number.isSafeInteger(payload.instance_count)||payload.instance_count<0||payload.instance_count!==payload.instance_ids.length||
      coverage?.complete!==true||coverage.scope!=='current_document_direct_type_references'||coverage.indirect_effects!=='not_assessed'||
      !Number.isSafeInteger(coverage.scanned_elements)||coverage.scanned_elements<payload.instance_count||coverage.scanned_elements>20000||payload.write_authorization!=='not_granted'){
      view.status='结果待核对';view.error='类型影响核查结果不完整，请核对原回执。';return view;
    }
    const raw=value=>value===null?'null':value===undefined?'未知（未提供）':value===''?'空字符串（""）':String(value);
    const shown=payload.instance_ids.slice(0,50),count=payload.instance_count;
    view.columns=['项目','内容'];
    view.rows=[['类型名称',payload.type_name===null?'未知（null）':raw(payload.type_name)],['类型 ID',raw(payload.type_id)],
      ['参数名称',raw(parameter.name)],['参数 ID',raw(parameter.parameter_id)],['存储类型',raw(parameter.storage_type)],
      ['是否有值（HasValue）',parameter.has_value?'是（true）':'否（false）'],['原始内部值',raw(parameter.value_internal)],
      ['显示值',raw(parameter.value_display)],['数据类型',parameter.data_type===null?'未知（null）':raw(parameter.data_type)],
      ['单位标识',parameter.unit_type===null?'未知或不适用（null）':raw(parameter.unit_type)],['直接实例数',String(count)],
      ['核查范围','当前文档中直接引用该类型的实例'],['扫描元素数',String(coverage.scanned_elements)],
      ['间接影响','未评估'],['写入授权','本次核查不额外授予类型写入权限'],
      ['实例 ID','显示 '+shown.length+' / '+count+' 个'+(shown.length?'：'+shown.join(', '):'（无直接实例）')]];
    view.summary='当前文档直接实例 '+count+' 个；实例 ID 显示 '+shown.length+' / '+count+'。间接影响未评估；本次核查不额外授予类型写入权限。';
  } else {
    view.columns = ['结果','内容'];
    const payload = Object.hasOwn(data,'value') ? data.value : data;
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      view.rows = Object.entries(payload).slice(0,40).map(([key,value]) => [key,typeof value === 'object' && value !== null ? JSON.stringify(value) : text(value)]);
    } else view.rows = [['返回值',typeof payload === 'object' ? JSON.stringify(payload) : text(payload)]];
  }
  if (!view.rows.length) view.summary = command.commandId === 'selection' ? '当前没有选择构件' : command.commandId === 'levels' ? '没有标高' : '没有匹配的构件';
  return view;
}

// A displayed identity must be the complete immutable ID/revision returned by
// the command store. Never infer an identity from a shortened label.
function storedCommandIdentity(value) {
  return value && typeof value === 'object' && typeof value.command_id==='string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.command_id) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value.command_id) && typeof value.revision==='string' &&
    /^[a-f0-9]{64}$/.test(value.revision) ? {command_id:value.command_id,revision:value.revision} : null;
}

export function modelToolCatalog(catalog) {
  if (!Array.isArray(catalog)) return [];
  const names = new Set();
  return catalog.slice(0,128).filter(tool => {
    if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:/-]{0,159}$/.test(tool.name) || names.has(tool.name)) return false;
    names.add(tool.name); return true;
  }).map(tool => ({name:tool.name, label:typeof tool.label === 'string' ? tool.label.slice(0,160) : tool.name,
    description:typeof tool.description === 'string' ? tool.description.slice(0,240) : '', readOnly:tool.readOnly === true}));
}

export function modelMentionQuery(text, caret) {
  if (typeof text !== 'string' || !Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(text.slice(0,caret));
  return match ? {start:caret - match[1].length - 1, end:caret, query:match[1]} : null;
}

export function modelMentionParts(text, catalog) {
  const names = new Set(modelToolCatalog(catalog).map(tool => tool.name));
  const parts = []; let offset = 0;
  for (const match of text.matchAll(/@[A-Za-z][A-Za-z0-9_.:/-]{0,159}/g)) {
    if (match.index > 0 && !/\s/.test(text[match.index-1]) || /[A-Za-z0-9_.:/-]/.test(text[match.index+match[0].length] || '') || !names.has(match[0].slice(1))) continue;
    if (match.index > offset) parts.push({text:text.slice(offset,match.index), tool:false});
    parts.push({text:match[0], tool:true}); offset = match.index + match[0].length;
  }
  if (offset < text.length || !parts.length) parts.push({text:text.slice(offset), tool:false});
  return parts;
}

export function mountModelWorkspace({document, window, CustomEvent, Event}) {
  const get = id => document.getElementById(id);
  const prompt = get('prompt'), messages = get('messages'), topbar = document.querySelector('.topbar');
  if (!prompt || !messages || !topbar) return null;
  let mounted = false, active = false, shellBroken = false, currentView = 'chat', snapshot = null, catalog = [], commandCatalog = MODEL_COMMANDS;
  let nav, chatTab, commandTab, knowledgeTab, skillsTab, knowledgePanel, skillsPage, commandList, accountButton, drawer, tools, overlay, picker, hint, controls;
  let permissionBar,permissionSelect,permissionPlaceholder,permissionScope,permissionDetails,permissionSafety;
  let accessSelect,accessScope,accessStatus,accessConfirm,accessConfirmText,accessConfirmApply,accessReview=null;
  let modelReceiptPanel,modelReceiptDetails,modelReceiptTitle,modelReceiptState,modelReceiptDescription,modelReceiptStatus,modelReceiptNext,modelReceiptFailure,modelReceiptRaw,modelReceiptEvidence,modelReceiptCheck,modelReceiptAcknowledge,modelReceiptRecover,modelReceiptNotice,modelReceiptOpen,modelReceiptBinding=null;
  let historyButton, historyPanel, historyList, historyNotice, historyText, historyContinue, historySignature = '';
  let mention = null, matches = [], selected = 0, composing = false, drawerOpen = false, drawerBody, drawerClose, drawerReturnFocus, drawerTitle;
  let accountMenu, accountMenuOpen = false, menuEmail, menuState, menuLogin, menuRegister, menuManage, menuSignOut;
  let commandCatalogSignature = '', commandSearch, commandItems,createCommand,createCommandKind,createCommandHelp;
  let commandButtons = [], parameterInputs = [], rows = [], resultRows = [];
  let draftOrigin = null, draftOriginStatus, draftOriginClear, chatDraftNotice;
  let attachmentButton, attachmentInput, attachmentList;
  let mcpPanel, mcpRead, mcpStatus, mcpList;
  const placements = [], originalPromptAttributes = new Map(); let originalHint = '';
  const el = (tag, className, text) => {
    const value = document.createElement(tag); if (className) value.className = className;
    if (text !== undefined) value.textContent = text; return value;
  };
  const button = (className, text) => { const value = el('button',className,text); value.type = 'button'; return value; };
  const accessBinding=()=>JSON.stringify([snapshot?.accountEpoch,snapshot?.contextEpoch,snapshot?.commandIdentityKey,snapshot?.commandConversationId,snapshot?.accessPolicy?.id,snapshot?.accessPolicy?.revision]);
  const canChangeAccess=()=>active&&snapshot?.accessPolicy?.available===true&&snapshot.ready===true&&!snapshot.busy&&!snapshot.blocked&&!snapshot.readOnly&&!snapshot.accessPolicyPending;
  function reviewAccess(detail){
    if(!canChangeAccess()||!['read-only','project-write','full-access'].includes(detail?.mode))return;
    if(detail.mode==='read-only'){window.dispatchEvent(new CustomEvent('buildx-access-policy-select',{detail:{mode:'read-only',confirmed:true}}));return;}
    if(detail.mode==='project-write'&&(typeof detail.rootId!=='string'||!detail.rootId)){switchView('knowledge');return;}
    if(detail.mode==='project-write'&&(typeof detail.path!=='string'||!detail.path||detail.path.length>32768||/[\u0000-\u001f\u007f]/.test(detail.path)))return;
    accessReview={mode:detail.mode,...detail.mode==='project-write'?{rootId:detail.rootId}:{},binding:accessBinding()};
    accessConfirmText.textContent=(detail.mode==='full-access'?'允许 BuildX 读取和编辑当前 Windows 账号可访问的本机文件，并编辑当前 Revit 模型。此范围不限于资料库，资料库仍用于选择参考内容。':'允许 BuildX 读取和编辑以下目录及子目录中的文件，并编辑其中当前打开的 Revit 模型：'+detail.path)+' 此选择会记住，可随时切换为只读。';
    accessConfirmApply.textContent=detail.mode==='full-access'?'启用完全访问':'授权此工作区';
    switchView('chat');accessConfirm.hidden=false;accessConfirmApply.focus();
  }
  function remember(element) {
    const anchor = document.createComment('model-layout:' + (element.id || element.className));
    element.before(anchor); placements.push({element,anchor});
  }
  function hideModelShell() {
    delete document.body.dataset.modelReady;
    const shell=get('model-shell-content'),fallback=get('model-shell-fallback');
    if(shell)shell.hidden=true;if(fallback)fallback.hidden=false;
  }
  function clearReceiptDisplay(){
    modelReceiptBinding=null;
    if(!modelReceiptPanel)return;
    modelReceiptPanel.hidden=true;modelReceiptNotice.hidden=true;modelReceiptDetails.open=false;modelReceiptRaw.open=false;modelReceiptRaw.hidden=true;modelReceiptOpen.setAttribute('aria-expanded','false');
    delete modelReceiptPanel.dataset.conversationId;delete modelReceiptPanel.dataset.ticket;
    for(const field of [modelReceiptDescription,modelReceiptStatus,modelReceiptFailure,modelReceiptNext,modelReceiptEvidence])field.textContent='';
    modelReceiptCheck.disabled=true;modelReceiptAcknowledge.hidden=true;modelReceiptAcknowledge.disabled=true;modelReceiptRecover.hidden=true;modelReceiptRecover.disabled=true;
  }
  function restoreLayout() {
    hideModelShell();
    if(currentView==='knowledge')window.dispatchEvent(new CustomEvent('buildx-project-files-closed'));
    currentView = 'chat'; active = false; closePicker(); drawerOpen = false; showAccountMenu(false,false);
    document.body.classList.remove('model-workspace'); delete document.body.dataset.modelView;
    nav.hidden = true; if(permissionBar)permissionBar.hidden=true;if(accessConfirm)accessConfirm.hidden=true;if(accessStatus)accessStatus.hidden=true;accessReview=null;clearReceiptDisplay();showDrawer(false); controls.hidden = true; commandList.hidden = true; knowledgePanel.hidden=true; skillsPage.hidden=true;if(chatDraftNotice)chatDraftNotice.hidden=true;
    historyPanel.hidden = true; historyNotice.hidden = true;
    attachmentButton.hidden=true; attachmentInput.hidden=true; attachmentList.hidden=true;
    for (const {element,anchor} of placements) anchor.after(element);
    for (const [name,value] of originalPromptAttributes) {
      if (value === null) prompt.removeAttribute(name); else prompt.setAttribute(name,value);
    }
    if (hint) hint.textContent = originalHint;
  }
  function showAccountMenu(open, returnFocus = true) {
    renderAccountMenu();
    accountMenuOpen = open; accountMenu.hidden = !active || !open;
    accountButton.setAttribute('aria-expanded',String(open));
    if (open && active) (menuLogin.hidden ? menuManage : menuLogin).focus();
    else if (returnFocus && active) accountButton.focus();
  }
  function renderAccountMenu() {
    if(!accountMenu)return;
    const focusedAction=accountMenuOpen?[menuLogin,menuRegister,menuManage,menuSignOut].find(item=>item===document.activeElement):null;
    const display=get('account-panel').buildxDisplay, signedIn=display?.signedIn===true, retained=display?.retained===true;
    accountButton.textContent=display?.email?.slice(0,1).toLocaleUpperCase()||'B';
    menuEmail.textContent=display?.email||'BuildX 账号';
    menuState.textContent=display?.summary||'正在检查账号';
    menuLogin.hidden=signedIn||retained;menuRegister.hidden=signedIn||retained;menuManage.hidden=!signedIn&&!retained;menuSignOut.hidden=!signedIn&&!retained;
    menuSignOut.textContent=retained?'清除本机登录':'退出登录';menuSignOut.disabled=!display?.canSignOut||snapshot?.busy===true;
    if(focusedAction?.hidden)(menuLogin.hidden?menuManage:menuLogin).focus();
  }
  function showDrawer(open, view = 'connection') {
    if (open && !drawerOpen) drawerReturnFocus = accountMenuOpen ? accountButton : document.activeElement || accountButton;
    if (open) {
      showAccountMenu(false,false);
      drawer.dataset.view = view;
      drawerTitle.textContent = view === 'account' ? 'BuildX 账号' : view === 'guide' ? '连接说明' : '连接与工具';
      get('account-panel').open = view === 'account';
      get('codex-account-panel').open = true;
    }
    drawerOpen = open; drawer.hidden = !active || !open;
    if (open && active) (view === 'account' && !get('account-email').disabled ? get('account-email') : drawerClose)?.focus();
    else if (!open && active) { (drawerReturnFocus?.isConnected !== false ? drawerReturnFocus : accountButton)?.focus(); drawerReturnFocus = null; }
  }
  function switchView(view) {
    if (!active) return;
    const previousView=currentView;
    if(previousView==='knowledge'&&view!=='knowledge')window.dispatchEvent(new CustomEvent('buildx-project-files-closed'));
    currentView = view; document.body.dataset.modelView = view;
    for(const [tab,name] of [[chatTab,'chat'],[commandTab,'commands'],[skillsTab,'skills'],[knowledgeTab,'knowledge']]){tab.setAttribute('aria-selected',String(view===name));tab.tabIndex=view===name?0:-1;}
    commandList.hidden = view !== 'commands'; knowledgePanel.hidden=view!=='knowledge'; skillsPage.hidden=view!=='skills'; get('welcome').hidden = view !== 'chat' || snapshot?.hasMessages === true;
    if(view==='knowledge'&&previousView!=='knowledge')window.dispatchEvent(new CustomEvent('buildx-project-files-opened'));
    if(chatDraftNotice)chatDraftNotice.hidden=view!=='chat' || !chatDraftNotice.textContent;
    closePicker();
    historyPanel.hidden = true; historyButton.setAttribute('aria-expanded','false');
    if (view === 'chat') prompt.focus();
  }
  function closePicker() {
    mention = null; matches = []; selected = 0;
    if (picker) picker.hidden = true;
    prompt.setAttribute('aria-expanded','false'); prompt.removeAttribute('aria-activedescendant');
  }
  function renderHighlight() {
    if (!overlay) return;
    overlay.replaceChildren(...modelMentionParts(prompt.value,catalog).map(part => {
      if (!part.tool) return document.createTextNode(part.text);
      return el('mark','model-mention',part.text);
    }),document.createTextNode('\n'));
    overlay.style.width = prompt.clientWidth + 'px'; overlay.scrollTop = prompt.scrollTop; overlay.scrollLeft = prompt.scrollLeft;
  }
  function chooseMention(index) {
    const tool = matches[index];
    if (!mention || !tool || !active) return;
    const start = mention.start, tail = prompt.value.slice(mention.end);
    const insert = '@' + tool.name + (tail.startsWith(' ') ? '' : ' ');
    prompt.value = prompt.value.slice(0,start) + insert + tail;
    const caret = start + insert.length; prompt.setSelectionRange(caret,caret);
    closePicker(); prompt.dispatchEvent(new Event('input',{bubbles:true})); prompt.focus();
  }
  function renderPicker() {
    if (!picker || !active || composing || currentView !== 'chat' || snapshot?.readOnly) return closePicker();
    mention = modelMentionQuery(prompt.value,prompt.selectionStart);
    if (!mention) return closePicker();
    const query = mention.query.toLocaleLowerCase();
    matches = catalog.filter(tool => (tool.name + ' ' + tool.label).toLocaleLowerCase().includes(query)).slice(0,8);
    selected = Math.min(selected,Math.max(0,matches.length-1));
    picker.replaceChildren(); picker.hidden = false; prompt.setAttribute('aria-expanded','true');
    if (!matches.length) {
      picker.append(el('p','model-tool-empty',catalog.length ? '没有匹配的工具' : '暂无可用工具'));
      prompt.removeAttribute('aria-activedescendant'); return;
    }
    matches.forEach((tool,index) => {
      const option = button('model-tool-option' + (index === selected ? ' selected' : ''),'');
      option.id = 'model-tool-option-' + index; option.setAttribute('role','option'); option.setAttribute('aria-selected',String(index === selected));
      const text = el('span','model-tool-option-text'); text.append(el('strong','',tool.label),el('small','',tool.name));
      option.append(el('span','model-tool-symbol','↗'),text);
      option.addEventListener('pointerdown',event => event.preventDefault());
      option.addEventListener('click',() => chooseMention(index)); picker.append(option);
    });
    prompt.setAttribute('aria-activedescendant','model-tool-option-' + selected);
  }
  function commandNeedsConfirmation(command,inputs){
    if(command.readOnly!==false)return false;
    const grant=snapshot?.modelPermission,mode=inputs?.mode?.value||command.inputSchema?.properties?.mode?.default||'rollback';
    const currentGrant=snapshot?.ready===true&&grant?.available===true&&['rollback','confirm','automatic'].includes(grant.level)&&grant.conversationId===snapshot.commandConversationId&&(grant.expiresAt===null||Number.isSafeInteger(grant.expiresAt)&&grant.expiresAt>Date.now());
    const coveredFull=snapshot?.accessPolicy?.available===true&&snapshot.accessPolicy.mode==='full-access'&&['revit_execute_csharp','revit_save_command','revit_run_command'].includes(command.tool);
    return !(currentGrant&&(command.effectKind==='model_transaction'||coveredFull)&&(grant.level==='automatic'||mode!=='commit'));
  }
  function renderCommandConfirmation(row){if(row.confirmLabel)row.confirmLabel.hidden=!commandNeedsConfirmation(row.command,row.inputs);}
  function applyCommand(command, inputs, error) {
    if (!active || !snapshot?.directCommandsAvailable || !(snapshot.commandsReady ?? snapshot.ready) || command.enabled === false || command.manualExecution===false || snapshot.blocked || snapshot.busy || snapshot.modelPermissionPending || snapshot.readOnly || snapshot.persistence?.status === 'failed') return;
    const form=rows.find(row=>row.id===command.id),sources=[];
    for(const field of form?.fields || []){
      const check=field.validate?.();
      if(check?.ok===false){error.textContent=check.error;error.hidden=false;field.input.focus();return;}
      const source=field.sourceDocument?.();if(source)sources.push(source);
    }
    if(sources.some(source=>JSON.stringify(source)!==JSON.stringify(sources[0]))){error.textContent='所选内容来自不同模型，请重新读取后选择。';error.hidden=false;return;}
    const values = command.inputSchema ? Object.fromEntries(Object.entries(inputs || {}).filter(([key]) => key !== '$confirmation').map(([key,input]) => [key,input.type === 'checkbox' ? input.checked : input.value])) : inputs ? {keyword:inputs.keyword.value, category:inputs.category.value} : {};
    const result = command.inputSchema ? modelSchemaParameters(command,values) : modelCommandParameters(command.id,values);
    error.textContent = result.ok ? '' : result.error; error.hidden = result.ok;
    if (!result.ok) { (inputs?.keyword || Object.values(inputs || {})[0])?.focus(); return; }
    if(command.tool==='revit_save_command' && draftOrigin) {
      if(draftOrigin.invalid || draftOrigin.accountEpoch!==snapshot.accountEpoch || draftOrigin.contextEpoch!==snapshot.contextEpoch || draftOrigin.identityKey!==snapshot.commandIdentityKey || draftOrigin.conversationId!==snapshot.commandConversationId) {error.textContent='草稿来源所属的身份或对话已变化；请清除导入内容并重新选择。';error.hidden=false;return;}
      const source='来源（从对话导入，内容可能已编辑）：'+JSON.stringify({conversationId:draftOrigin.conversationId,messageId:draftOrigin.messageId,blockIndex:draftOrigin.blockIndex});
      const description=result.parameters.description+'\n'+source;
      if(description.length>2000){error.textContent='说明和来源合计不能超过 2000 个字符，请缩短说明。';error.hidden=false;return;}
      result.parameters.description=description;
    }
    if(command.effectKind==='model_transaction'&&snapshot?.modelPermission?.level==='rollback'&&result.parameters.mode==='commit'){error.textContent='当前权限为回滚预览，请选择预览或切换模型权限。';error.hidden=false;return;}
    if (commandNeedsConfirmation(command,inputs) && inputs?.$confirmation?.checked !== true) { error.textContent = '请先核对参数并确认本次操作。'; error.hidden = false; inputs?.$confirmation?.focus(); return; }
    const confirmed=inputs?.$confirmation?.checked===true;
    if (inputs?.$confirmation) inputs.$confirmation.checked = false;
    window.dispatchEvent(new CustomEvent('buildx-model-command',{detail:{commandId:command.id,parameters:result.parameters,...(sources.length?{sourceDocument:sources[0]}:{}),...(confirmed?{confirmed:true}:{})}}));
  }

  const commandBadge=kind=>el('span','command-origin-badge command-origin-'+kind,kind==='personal'?'个人':'系统');
  function commandName(text,kind,className='') {
    const heading=el('span','command-name');heading.append(el('strong',className,text),commandBadge(kind));return heading;
  }
  function buildCommandRows(commands) {
    const drafts = new Map(rows.map(row => [row.id,{open:!row.parameters.hidden,values:Object.fromEntries(Object.entries(row.inputs || {}).map(([key,input]) => [key,row.fields?.some(field=>field.input===input&&field.sourceDocument?.())?'':input.type === 'checkbox' ? input.checked : input.value]))}]));
    commandButtons = []; parameterInputs = []; rows = []; resultRows = [];
    commandItems.replaceChildren();
    const groups = new Map();
    for (const command of commands) {
      const group = command.group || '常用命令';
      if (!groups.has(group)) { const section=el('section','model-command-group'); section.append(el('h3','model-command-group-title',group)); groups.set(group,section); commandItems.append(section); }
      const item = el('section','model-command-item'), row = el('div','model-command-row');
      item.dataset.commandId = command.id;item.dataset.baseSearch=[command.name,command.tool,command.description,group,'系统'].filter(Boolean).join(' ').toLocaleLowerCase();item.dataset.search=item.dataset.baseSearch;
      const copy = el('span','model-command-copy'); copy.append(commandName(command.name,'system'),el('small','',command.description));
      if (command.readOnly === false) copy.append(el('small','model-command-effect','涉及模型或文件操作'));
      if (command.enabled === false) copy.append(el('small','model-command-unavailable',command.unavailableReason || '当前环境尚未就绪'));
      if(command.manualExecution===false){
        copy.append(el('small','model-command-unavailable',command.manualUnavailableReason||'请在对话中发起，逐项审阅类型影响并确认本次操作。'));
        row.append(el('span','model-command-icon',command.icon||'◇'),copy);item.append(row);groups.get(group).append(item);
        continue;
      }
      const fields = command.inputSchema ? Object.entries(command.inputSchema.properties || {}).filter(([key]) => key !== 'expected_document').sort(([a],[b])=>Number(a==='mode')-Number(b==='mode')) : command.parameters ? [['keyword',{type:'string',maxLength:200}],['category',{type:'string',enum:MODEL_CATEGORIES.map(item => item.value),default:'all'}]] : [];
      const hasParameters = fields.length > 0 || command.readOnly === false;
      const apply = button('model-command-apply',command.enabled === false ? '不可用' : hasParameters ? '展开' : '应用');
      apply.setAttribute('aria-label',command.name + (hasParameters ? '，填写参数' : '，应用')); apply.dataset.commandEnabled = String(command.enabled !== false);
      const stop = button('model-command-stop','停止'); stop.hidden = true; stop.setAttribute('aria-label','停止' + command.name);
      const inspect=button('model-command-inspect','核对结果'); inspect.hidden=true; inspect.setAttribute('aria-label','核对'+command.name+'结果');
      inspect.addEventListener('click',()=>{const execution=snapshot?.commands?.find(value=>value.commandId===command.id);if(active && execution?.status==='unknown' && execution.canInspectReceipt===true && !inspect.disabled)window.dispatchEvent(new CustomEvent('buildx-model-command-check',{detail:{commandId:command.id,executionId:execution.executionId,conversationId:execution.conversationId}}));});
      const acknowledge=button('model-command-acknowledge','已核对结果');acknowledge.hidden=true;acknowledge.setAttribute('aria-label','确认已核对'+command.name+'结果');
      acknowledge.addEventListener('click',()=>{const execution=snapshot?.commands?.find(value=>value.commandId===command.id);if(active&&execution?.canAcknowledgeReceipt===true&&!acknowledge.disabled)window.dispatchEvent(new CustomEvent('buildx-model-command-acknowledge',{detail:{commandId:command.id,executionId:execution.executionId,conversationId:execution.conversationId,revision:execution.receiptCheck?.revision}}));});
      const recover=button('model-command-recover','只读查看原作业');recover.hidden=true;recover.setAttribute('aria-label','只读查看原柜族作业');
      recover.addEventListener('click',()=>{const execution=snapshot?.commands?.find(value=>value.commandId===command.id);if(active&&execution?.canInspectCabinetJob===true&&!recover.disabled)window.dispatchEvent(new CustomEvent('buildx-model-command-recover',{detail:{commandId:command.id,executionId:execution.executionId,conversationId:execution.conversationId}}));});
      stop.addEventListener('click',() => { const execution=snapshot?.commands?.find(value => value.commandId === command.id); if(execution && execution.status === 'running' && !execution.cancelRequested)window.dispatchEvent(new CustomEvent('buildx-model-command-stop',{detail:{executionId:execution.executionId,conversationId:execution.conversationId}})); });
      row.append(el('span','model-command-icon',command.icon || '⌕'),copy,inspect,recover,acknowledge,stop,apply); item.append(row);
      const error=el('p','model-command-error'); error.hidden=true; error.setAttribute('role','alert');
      const parameters=el('div','model-command-parameters'); parameters.id=command.id === 'search' ? 'model-search-parameters' : 'model-parameters-'+command.id; parameters.hidden=true;
      if(command.tool === 'revit_save_command') {
        parameters.append(el('p','model-command-draft-help','可将对话中生成的草稿粘贴到这里：C# 方法体和只读步骤二选一。保存只生成不可变版本，不执行或验证；修改内容会生成新版本。'));
        draftOriginStatus=el('p','model-command-draft-origin');draftOriginStatus.setAttribute('role','status');draftOriginClear=button('model-command-draft-clear','清除导入内容');draftOriginClear.addEventListener('click',()=>{
          const target=rows.find(value=>value.id===command.id);if(!target?.inputs.code)return;
          target.inputs.code.value='';if(target.inputs.$confirmation)target.inputs.$confirmation.checked=false;draftOrigin=null;renderDraftOrigin();
        });parameters.append(draftOriginStatus,draftOriginClear);renderDraftOrigin();
      }
      if(command.tool === 'revit_run_command') parameters.append(el('p','model-command-draft-help','请先读取准确版本，核对完整源码及当前模型。C# 使用 Revit 当前用户权限，回滚不能撤销文件、网络等事务外副作用。结果未知时请先核对回执，勿重复执行。'));
      if(command.tool === 'revit_family_load_job') parameters.append(el('p','model-command-draft-help','请先读取作业并核对 RFA 文件及 SHA；加载的模型改动按选择回滚或应用，RFA 文件不会因回滚而删除。'));
      const inputs={}, draft=drafts.get(command.id),formFields=[],required=new Set(command.inputSchema?.required || []),selectors=new Set(exclusiveSelectorKeys(command.inputSchema));
      if(selectors.size)parameters.append(el('small','command-field-help',[...selectors].map(key=>COMMAND_PARAMETER_LABELS[key]||key).join('或')+'，二选一。'));
      const advanced=el('details','model-command-advanced');advanced.append(el('summary','','更多选项'));
      const invalidate=()=>{if(inputs.$confirmation)inputs.$confirmation.checked=false;};
      const onCommand=detail=>{if(!commandActionAvailable(detail.commandId))return false;window.dispatchEvent(new CustomEvent('buildx-model-command',{detail}));return true;};
      for (const [key,rule] of fields) {
        const id=command.id === 'search' && ['keyword','category'].includes(key) ? 'model-command-'+key : 'model-command-'+command.id+'-'+key;
        const label=key==='parameters' && command.tool==='revit_run_command'?'参数值':COMMAND_PARAMETER_LABELS[key] || key;
        const options={document,Event,id,key,rule,label,required:required.has(key),value:draft?.values[key],onChange:invalidate,onCommand};
        const field=command.tool==='revit_set_parameters' && key==='changes'?createParameterChangeField(options):command.tool==='revit_set_parameter_value' && key==='changes'?createParameterChangeField({...options,maxChanges:1,exactIds:true}):command.tool==='revit_run_command' && key==='parameters'?createPersonalCommandFields(options):
          (rule.type==='integer'||rule.type==='array'&&rule.items?.type==='integer')&&createCommandChoiceField(options)||createCommandField(options);
        const input=field.input;inputs[key]=input;formFields.push(field);
        for(const control of field.controls){control.dataset.commandEnabled=String(command.enabled !== false);parameterInputs.push(control);}
        const personalIdentity=['revit_get_command','revit_run_command'].includes(command.tool)&&['command_id','revision'].includes(key);
        const optional=personalIdentity||!selectors.has(key)&&!required.has(key)&&key!=='mode'&&key!=='keyword'&&key!=='category'&&key!=='name_contains'&&!(command.tool==='revit_run_command'&&key==='parameters')&&
          (['limit','offset','structural','source_request_id','parameters'].includes(key)||!Object.hasOwn(rule,'default'));
        (optional?advanced:parameters).append(field.element);
      }
      if(advanced.children.length>1)parameters.append(advanced);
      if(command.tool==='revit_run_command')for(const key of ['command_id','revision'])for(const event of ['input','change'])inputs[key]?.addEventListener(event,()=>{formFields.find(field=>typeof field.setDefinition==='function')?.setDefinition(null);invalidate();});
      let confirmLabel=null;
      if(command.readOnly === false){confirmLabel=el('label','model-command-confirm');const confirm=el('input');confirm.type='checkbox';confirm.dataset.commandEnabled=String(command.enabled !== false);confirm.checked=false;for(const input of Object.values(inputs))for(const event of ['input','change'])input.addEventListener(event,()=>{confirm.checked=false;renderCommandConfirmation({command,inputs,confirmLabel});});inputs.$confirmation=confirm;parameterInputs.push(confirm);const confirmationText=command.tool==='revit_save_command'?'我已核对草稿内容，确认保存本地版本':command.tool==='revit_family_create_cabinet'?'我已核对尺寸，确认创建独立临时柜体族；不保存或加载项目':command.tool==='revit_family_save_cabinet'?'我已核对作业，确认保存为新 RFA、关闭原临时族并重新打开复核':command.tool==='revit_family_close_cabinet'?'我已核对作业，确认关闭临时柜体族并丢弃未保存内容':'我已核对本次参数和执行方式';confirmLabel.append(confirm,el('span','',confirmationText));parameters.append(confirmLabel);}
      if(hasParameters){
        apply.setAttribute('aria-expanded',String(Boolean(draft?.open)));apply.setAttribute('aria-controls',parameters.id);parameters.hidden=!draft?.open;
        const run=button('model-command-run',command.tool === 'revit_save_command' ? '保存版本' : command.readOnly === false ? '执行' : '查询');run.dataset.commandEnabled=String(command.enabled !== false);run.addEventListener('click',()=>applyCommand(command,inputs,error));
        if(inputs.mode){const renderRun=()=>{run.textContent=inputs.mode.value==='commit'?'应用修改':'预览结果';};inputs.mode.addEventListener('change',renderRun);renderRun();}
        parameters.append(run,error);item.append(parameters);rows.push({id:command.id,item,parameters,apply,inputs,fields:formFields,command,confirmLabel});commandButtons.push(run);
        if(command.tool==='revit_list_commands'){apply.textContent='刷新列表';apply.addEventListener('click',()=>applyCommand(command,inputs,error));}
        else apply.addEventListener('click',()=>{parameters.hidden=!parameters.hidden;apply.textContent=parameters.hidden?'展开':'收起';apply.setAttribute('aria-expanded',String(!parameters.hidden));if(!parameters.hidden)Object.values(inputs)[0]?.focus();});
        if(inputs.keyword)inputs.keyword.addEventListener('keydown',event=>{if(event.key === 'Enter' && !event.isComposing){event.preventDefault();applyCommand(command,inputs,error);}});
      }else{item.append(error);apply.addEventListener('click',()=>applyCommand(command,null,error));}
      const result=el('div','model-command-result');result.hidden=true;result.setAttribute('role','status');result.setAttribute('aria-live','polite');item.append(result);
      resultRows.push({id:command.id,result,stop,inspect,recover,acknowledge,signature:''});commandButtons.push(apply);groups.get(group).append(item);
    }
    filterCommands();
  }
  function filterCommands() {
    const query=(commandSearch?.value || '').trim().toLocaleLowerCase();
    for(const item of commandItems?.querySelectorAll('.model-command-item') || []) {
      const detail=['revit_save_command','revit_get_command','revit_run_command'].includes(item.dataset.commandId);
      const selected=rows.find(row=>row.id===item.dataset.commandId);
      const relevant=!detail||!selected?.parameters.hidden||snapshot?.commands?.some(command=>command.commandId===item.dataset.commandId);
      item.hidden=!query&&!relevant || query !== '' && !item.dataset.search.includes(query);
    }
    for(const item of commandItems?.querySelectorAll('.model-command-stored-version') || [])item.hidden=query!==''&&!item.dataset.search.includes(query);
    for(const group of commandItems?.querySelectorAll('.model-command-group') || []) group.hidden=[...group.querySelectorAll('.model-command-item')].every(item=>item.hidden);
  }
  function renderCommandCreation(value=snapshot){
    const kind=createCommandKind.value,disabled=!value||value.blocked||value.busy||value.persistence?.status==='failed'||get('new-chat').disabled;
    createCommandKind.disabled=Boolean(disabled);createCommand.disabled=Boolean(disabled||!['csharp','sequence'].includes(kind));
    createCommandHelp.textContent=kind==='sequence'?'串联现有只读查询，生成可复用的步骤命令。':kind==='csharp'?'用日常语言描述需求，生成可复用的 C# 命令。':'该类型暂未接入，请选择 C# 命令或只读步骤命令。';
  }
  function commandActionAvailable(id) {
    return active && snapshot?.directCommandsAvailable && (snapshot.commandsReady ?? snapshot.ready) && !snapshot.blocked && !snapshot.busy && !snapshot.readOnly && snapshot.persistence?.status !== 'failed' && commandCatalog.some(item=>item.id===id && item.enabled!==false&&item.manualExecution!==false);
  }
  function renderDraftOrigin() {
    if(!draftOriginStatus || !draftOriginClear)return;
    draftOriginStatus.hidden=!draftOrigin;draftOriginClear.hidden=!draftOrigin;
    draftOriginStatus.textContent=!draftOrigin?'':draftOrigin.invalid?'来源所属身份或对话已变化；请清除导入内容并重新选择。':'来源：对话 '+draftOrigin.conversationId+' · 消息 '+draftOrigin.messageId+' · 代码块 '+draftOrigin.blockIndex+'。保存时来源会加入命令说明；请先审阅代码。';
  }
  function importChatDraft(value) {
    const target=rows.find(row=>row.id==='revit_save_command');
    const validId=entry=>typeof entry==='string' && entry.length>0 && entry.length<=256 && !/[\u0000-\u001f\u007f]/.test(entry);
    const report=message=>{chatDraftNotice.textContent=message;chatDraftNotice.hidden=false;};
    if(!value || !commandActionAvailable('revit_save_command') || value.accountEpoch!==snapshot.accountEpoch || value.contextEpoch!==snapshot.contextEpoch || value.identityKey!==snapshot.commandIdentityKey || value.conversationId!==snapshot.commandConversationId || !validId(value.conversationId) || !validId(value.messageId) || !Number.isSafeInteger(value.blockIndex) || value.blockIndex<1 || typeof value.code!=='string' || !value.code.trim() || new TextEncoder().encode(value.code).length>64000 || !target?.inputs.code) {report('当前草稿无法导入，请核对当前身份、对话及 C# 代码内容。');return;}
    if(target.inputs.code.value || target.inputs.steps?.value || draftOrigin) {report('命令表单已有草稿，请先处理现有源码或步骤，避免覆盖。');return;}
    draftOrigin={accountEpoch:value.accountEpoch,contextEpoch:value.contextEpoch,identityKey:value.identityKey,conversationId:value.conversationId,messageId:value.messageId,blockIndex:value.blockIndex,invalid:false};
    target.inputs.code.value=value.code;if(target.inputs.$confirmation)target.inputs.$confirmation.checked=false;
    renderDraftOrigin();chatDraftNotice.textContent='';chatDraftNotice.hidden=true;commandSearch.value='';target.parameters.hidden=false;filterCommands();switchView('commands');
    target.apply.textContent='收起';target.apply.setAttribute('aria-expanded','true');target.item.scrollIntoView({block:'nearest'});target.inputs.code.focus();
  }
  function renderStoredVersions(row,command) {
    if(command.status!=='completed' || !['revit_list_commands','revit_get_command'].includes(row.id)) return false;
    const payload=command.result?.data?.value ?? command.result?.data;
    if(row.id==='revit_list_commands') {
      if(!payload || !Array.isArray(payload.commands) || !Number.isSafeInteger(payload.total) || !Number.isSafeInteger(payload.offset) || !Number.isSafeInteger(payload.limit) || typeof payload.has_more!=='boolean') return false;
      const commandItem=rows.find(item=>item.id===row.id)?.item;
      if(commandItem)commandItem.dataset.search=[commandItem.dataset.baseSearch,...payload.commands.map(record=>[record?.name,record?.description,record?.command_id,'个人'].filter(value=>typeof value==='string').join(' '))].join(' ').toLocaleLowerCase();
      row.result.append(el('p','model-command-result-summary','已保存版本：本页 '+payload.commands.length+' 项，共 '+payload.total+' 项'+(payload.has_more?'；还有后续页，可在列表参数中调整起始位置。':'。')));
      for(const record of payload.commands) {
        const identity=storedCommandIdentity(record); if(!identity) {row.result.append(el('p','model-command-result-error','某项版本身份无效，无法选择。'));continue;}
        const item=el('div','model-command-stored-version');
        item.dataset.search=[record.name,record.description,identity.command_id,'个人'].filter(value=>typeof value==='string').join(' ').toLocaleLowerCase();
        item.append(commandName(typeof record.name==='string'?record.name:identity.command_id,'personal'));
        if(typeof record.description==='string')item.append(el('p','',record.description));
        const version=el('details','model-command-version-detail');version.append(el('summary','','版本信息'),el('p','',identity.command_id+' · '+identity.revision));item.append(version);
        const evidence=record.verification?.status==='source_execution_succeeded'?'有历史执行记录（不代表当前模型已验证）':record.verification?.status==='unverified'?'未记录成功执行证据':'执行证据状态未知';
        item.append(el('p','',evidence));
        const inspect=button('model-command-version-view','查看命令');
        inspect.addEventListener('click',()=>{
          if(!commandActionAvailable('revit_get_command') || snapshot?.commands?.find(value=>value.commandId===row.id)!==command)return;
          commandSearch.value='';filterCommands();rows.find(value=>value.id==='revit_get_command')?.item.scrollIntoView({block:'nearest'});
          window.dispatchEvent(new CustomEvent('buildx-model-command',{detail:{commandId:'revit_get_command',parameters:identity}}));
        });
        item.append(inspect);row.result.append(item);
      }
      return true;
    }
    const identity=storedCommandIdentity(payload);if(!identity)return false;
    row.result.append(commandName(typeof payload.name==='string'?payload.name:identity.command_id,'personal','model-personal-name'));
    if(typeof payload.description==='string')row.result.append(el('p','model-personal-description',payload.description));
    const details=el('details','model-command-diagnostics');details.append(el('summary','','查看脚本与版本'),el('pre','model-command-diagnostic-text',typeof payload.code==='string'?payload.code:JSON.stringify(payload.steps,null,2)),el('p','model-command-version-detail',identity.command_id+' · '+identity.revision));row.result.append(details);
    return true;
  }
  function renderCommandResults() {
    for (const row of resultRows) {
      const command = snapshot?.commands?.find(item => item.commandId === row.id), presentation = modelCommandPresentation(command);
      const signature = JSON.stringify(command || null);
      row.stop.hidden = !command || typeof command.executionId !== 'string' || !['running','stopping'].includes(command.status);
      row.stop.disabled = command?.status === 'stopping' || command?.cancelRequested === true || snapshot?.commandStopPending === true;
      row.stop.textContent = command?.status === 'stopping' || command?.cancelRequested ? '停止中…' : '停止';
      const checking=command?.receiptCheck?.checking===true;
      row.inspect.hidden=!command || command.status!=='unknown' || typeof command.executionId!=='string' || command.canInspectReceipt!==true && !checking;
      row.inspect.disabled=!snapshot?.directCommandsAvailable || !(snapshot.commandsReady ?? snapshot.ready) && command?.receiptCheck?.cleanupPending!==true || snapshot.blocked || snapshot.busy || snapshot.readOnly || snapshot.persistence?.status==='failed' || snapshot.commandCheckPending || checking;
      row.inspect.textContent=checking || snapshot?.commandCheckPending && command?.canInspectReceipt ? '核对中…' : '核对结果';
      row.acknowledge.hidden=command?.canAcknowledgeReceipt!==true;
      row.acknowledge.disabled=!snapshot?.directCommandsAvailable || !(snapshot.commandsReady ?? snapshot.ready) && command?.receiptCheck?.cleanupPending!==true || snapshot.blocked || snapshot.busy || snapshot.readOnly || snapshot.persistence?.status==='failed' || snapshot.commandCheckPending || checking;
      row.recover.hidden=command?.canInspectCabinetJob!==true;
      row.recover.disabled=!snapshot?.directCommandsAvailable || !(snapshot.commandsReady ?? snapshot.ready) && command?.receiptCheck?.cleanupPending!==true || snapshot.blocked || snapshot.busy || snapshot.readOnly || snapshot.persistence?.status==='failed' || snapshot.commandCheckPending || command?.cabinetRecoveryInspection?.checking===true;
      if (signature === row.signature) continue;
      row.signature = signature; row.result.replaceChildren(); row.result.hidden = !presentation;
      if(row.id==='revit_list_commands'){const item=rows.find(value=>value.id===row.id)?.item;if(item)item.dataset.search=item.dataset.baseSearch;}
      if (!presentation) continue;
      row.result.dataset.status = command.status;
      const heading = el('div','model-command-result-heading'); heading.append(el('span','',presentation.status));
      if (presentation.document && row.id !== 'document') heading.append(el('small','',presentation.document));
      row.result.append(heading);
      if (presentation.error) row.result.append(el('p','model-command-result-error',presentation.error));
      if(command.sequence?.steps){
        const labels={succeeded:'已完成',failed:'失败',unknown:'结果待核对',not_started:'未执行'};
        const list=el('ol','model-command-sequence');
        for(const step of command.sequence.steps)list.append(el('li','',step.id+' · '+step.tool+' · '+(labels[step.status]||'未知')));
        row.result.append(list);
      }
      if(command.receiptCheck){
        const check=command.receiptCheck,labels={pending:'尚未收到回执',received:'已收到回执',unconfirmed:'回执仍待核对',host_changed:'宿主已变化',failed:'执行器返回失败',expired:'请求已过期，未执行',not_started:'查询未执行'};
        const message=check.checking?'正在核对回执…':typeof check.message==='string'&&check.message?check.message.slice(0,240):labels[check.status];
        if(message){const line=el('p','model-command-receipt-check',message);line.title=message;line.setAttribute('role','status');row.result.append(line);}
        if(check.evidence){const facts=check.evidence;for(const [label,value] of [['作业',facts.jobHandle],['文件',facts.savePath],['状态',facts.outcome],['文件复核',facts.savedVerified?'已验证':null]])if(typeof value==='string'&&value)row.result.append(el('p','model-command-receipt-check',label+'：'+value));}
      }
      if(command.cabinetRecoveryInspection){const result=command.cabinetRecoveryInspection;if(result.checking)row.result.append(el('p','model-command-receipt-check','正在只读查看原作业…'));else if(result.job)row.result.append(el('pre','model-command-diagnostic-text',JSON.stringify(result.job,null,2)));else if(result.message)row.result.append(el('p','model-command-receipt-check',result.message));}
      const renderedVersions=renderStoredVersions(row,command);
      if (!renderedVersions && presentation.rows.length) {
        const table = el('table','model-command-table'), head = el('thead'), body = el('tbody'), titles = el('tr');
        for (const title of presentation.columns) titles.append(el('th','',title)); head.append(titles);
        for (const values of presentation.rows) {
          const tr=el('tr');
          for(const [index,value] of values.entries()) {
            const cell=el('td');
            // C# method bodies must retain line breaks: collapsing them can
            // make a line comment appear to cover the following statement.
            if(row.id==='revit_get_command' && values[0]==='code' && index===1)cell.append(el('pre','model-command-diagnostic-text',value));
            else cell.textContent=value;
            tr.append(cell);
          }
          body.append(tr);
        }
        table.append(head,body); const scroll = el('div','model-command-table-scroll'); scroll.append(table); row.result.append(scroll);
      }
      if (!renderedVersions && presentation.summary) row.result.append(el('p','model-command-result-summary',presentation.summary));
      if(row.id==='revit_get_command' && command.status==='completed') {
        const record=command.result?.data?.value ?? command.result?.data, identity=storedCommandIdentity(record);
        if(identity) {
          row.result.append(el('p','model-command-result-summary','已读取上述准确版本。请核对源码、参数和当前模型；历史执行记录不代表当前适用。填入运行表单会清空原参数、恢复默认回滚并取消原确认。'));
          const choose=button('model-command-version-choose','使用这个命令');
          choose.addEventListener('click',()=>{
            if(!commandActionAvailable('revit_run_command') || snapshot?.commands?.find(value=>value.commandId===row.id)!==command)return;
            const target=rows.find(value=>value.id==='revit_run_command');
            if(!target?.inputs.command_id || !target.inputs.revision)return;
            target.inputs.command_id.value=identity.command_id;target.inputs.revision.value=identity.revision;
            if(target.inputs.parameters)target.inputs.parameters.value='';
            const personalFields=target.fields.find(field=>typeof field.setDefinition==='function');personalFields?.setDefinition(record);
            personalFields?.element.querySelectorAll('.personal-command-selected')[0]?.append(commandBadge('personal'));
            if(target.inputs.mode)target.inputs.mode.value=target.inputs.mode.dataset.defaultValue || 'rollback';
            if(target.inputs.$confirmation)target.inputs.$confirmation.checked=false;
            commandSearch.value='';target.parameters.hidden=false;filterCommands();target.apply.textContent='收起';target.apply.setAttribute('aria-expanded','true');target.item.scrollIntoView({block:'nearest'});target.inputs.parameters?.focus();
          });
          row.result.append(choose);
        }
      }
      if (presentation.diagnostic || presentation.requestIds.length) {
        const details = el('details','model-command-diagnostics');
        details.append(el('summary','','查看详情'),el('pre','model-command-diagnostic-text',[presentation.diagnostic,presentation.requestIds.length ? '请求 ID：\n' + presentation.requestIds.join('\n') : ''].filter(Boolean).join('\n\n')));
        row.result.append(details);
      }
    }
  }
  function renderHistory() {
    if (!historyButton) return;
    const history = snapshot?.history, available = active && history?.available === true;
    historyButton.hidden = !available; historyButton.disabled = Boolean(snapshot?.blocked || snapshot?.busy);
    if (!available) { historyPanel.hidden = true; historyButton.setAttribute('aria-expanded','false'); }
    const signature = JSON.stringify([history?.sessions,history?.activeId,history?.loading,history?.error,history?.nextCursor,history?.issueCount,snapshot?.blocked,snapshot?.busy]);
    if (signature !== historySignature) {
      historySignature = signature; historyList.replaceChildren();
      if (history?.error) {
        historyList.append(el('p','model-history-empty',history.error));
        const retry = button('model-history-retry','重试'); retry.addEventListener('click',() => window.dispatchEvent(new CustomEvent('buildx-history-refresh'))); historyList.append(retry);
      }
      if (!history?.sessions?.length && !history?.error) historyList.append(el('p','model-history-empty',history?.loading ? '正在读取…' : '暂无历史对话'));
      else for (const item of history?.sessions || []) {
        const entry = button('model-history-item',''); entry.dataset.conversationId = item.id;
        if (item.id === history.activeId) entry.setAttribute('aria-current','true');
        entry.disabled = Boolean(snapshot?.blocked || snapshot?.busy);
        const title = el('strong','',item.title || '新对话');
        const detail = [item.updatedAt ? item.updatedAt.slice(0,10) : '',item.messageCount ? item.messageCount + ' 条消息' : ''].filter(Boolean).join(' · ');
        entry.append(title,el('small','',detail));
        entry.addEventListener('click',() => {
          if (snapshot?.blocked || snapshot?.busy) return;
          switchView('chat'); window.dispatchEvent(new CustomEvent('buildx-history-select',{detail:{conversationId:item.id}}));
        }); historyList.append(entry);
      }
      if (history?.nextCursor && !history.error) {
        const more = button('model-history-more',history.loading ? '正在读取…' : '加载更多'); more.disabled = Boolean(history.loading);
        more.addEventListener('click',() => window.dispatchEvent(new CustomEvent('buildx-history-refresh',{detail:{cursor:history.nextCursor}}))); historyList.append(more);
      }
      if (history?.issueCount) historyList.append(el('p','model-history-empty',history.issueCount + ' 条记录暂时无法读取'));
    }
    const failed = snapshot?.persistence?.status === 'failed';
    historyNotice.hidden = !available || !(snapshot?.readOnly || failed);
    historyText.textContent = snapshot?.readOnly ? '历史对话' : failed ? (snapshot.persistence.message || '本地记录保存未确认') : '';
    historyContinue.hidden = !snapshot?.readOnly;
  }
  function renderAttachments() {
    const available=active && snapshot?.turnAttachmentsAvailable === true;
    attachmentButton.hidden=!available;
    const blocked=Boolean(snapshot?.readOnly || snapshot?.attachmentReading || snapshot?.attachmentEditBlocked || snapshot?.persistence?.status === 'failed');
    attachmentButton.disabled=blocked;
    attachmentButton.setAttribute('aria-label',snapshot?.attachmentReading ? '正在读取附件' : '添加图片或文本文件');
    attachmentList.replaceChildren();
    for(const item of available && Array.isArray(snapshot?.attachments) ? snapshot.attachments.slice(0,4) : []) {
      const card=el('div','model-pending-file'), copy=el('span','model-pending-file-copy');
      const extracted=item.sourceFormat==='extracted'&&typeof item.sourceName==='string';
      copy.append(el('span','model-pending-file-name',extracted?item.sourceName:item.name),el('small','',(extracted?'提取文本':item.kind === 'image' ? '图片' : '文本')+' · '+(item.bytes < 1024 ? item.bytes+' B' : Math.ceil(item.bytes/1024)+' KiB')));
      if(extracted&&typeof item.extractionNotice==='string'){
        const warning=el('small','model-extraction-notice',item.extractionNotice);warning.style.fontSize='10px';warning.style.lineHeight='1.4';copy.append(warning);
      }
      const remove=button('model-remove-file','×'); remove.setAttribute('aria-label','移除附件 '+item.name); remove.disabled=blocked;
      remove.addEventListener('click',() => window.dispatchEvent(new CustomEvent('buildx-attachments-remove',{detail:{id:item.id}})));
      let icon=el('span','model-file-icon',item.kind === 'image' ? '▧' : '▤');
      if(item.kind==='image' && typeof item.previewUrl==='string' && item.previewUrl.startsWith('blob:')){
        icon=button('model-image-thumbnail','');icon.setAttribute('aria-label','查看图片 '+item.name);
        const image=el('img');image.src=item.previewUrl;image.alt=item.name;icon.append(image);
        icon.addEventListener('click',()=>window.dispatchEvent(new CustomEvent('buildx-image-preview-open',{detail:{attachmentId:item.id}})));
      }
      card.append(icon,copy,remove); attachmentList.append(card);
    }
    attachmentList.hidden=!attachmentList.childElementCount;
  }
  function mount() {
    mounted = true;
    controls = el('div','model-header-actions');
    remember(get('new-chat'));
    topbar.append(controls); controls.append(get('new-chat'));
    accountButton = button('model-avatar','B'); accountButton.id = 'model-account-toggle';
    accountButton.title = 'BuildX 账号'; accountButton.setAttribute('aria-label','BuildX 账号'); accountButton.setAttribute('aria-expanded','false');
    accountButton.setAttribute('aria-haspopup','dialog'); accountButton.setAttribute('aria-controls','model-account-menu');
    accountButton.addEventListener('click',() => { if(drawerOpen)showDrawer(false); showAccountMenu(!accountMenuOpen); });
    accountButton.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();showAccountMenu(true);}});
    controls.append(accountButton);
    accountMenu = el('section','model-account-popover'); accountMenu.id='model-account-menu'; accountMenu.hidden=true;
    accountMenu.setAttribute('role','dialog'); accountMenu.setAttribute('aria-labelledby','model-account-menu-title');
    const menuIdentity=el('div','model-account-identity');
    menuEmail=el('strong','','BuildX 账号');menuEmail.id='model-account-menu-title';menuState=el('span','','尚未登录');menuState.setAttribute('role','status');
    menuIdentity.append(menuEmail,menuState);
    const menuActions=el('div','model-account-menu-actions');
    menuLogin=button('model-account-menu-primary','登录 BuildX');menuLogin.id='model-account-login';menuLogin.addEventListener('click',()=>showDrawer(true,'account'));
    menuRegister=el('a','model-account-menu-secondary','邀请码注册');menuRegister.id='model-account-register';menuRegister.setAttribute('href','/register.html');menuRegister.setAttribute('target','_blank');menuRegister.setAttribute('rel','noopener noreferrer');
    menuManage=button('model-account-menu-secondary','账号详情');menuManage.hidden=true;menuManage.addEventListener('click',()=>showDrawer(true,'account'));
    menuSignOut=button('model-account-menu-signout','退出登录');menuSignOut.id='model-account-signout';menuSignOut.hidden=true;
    menuSignOut.addEventListener('click',()=>{if(!get('account-sign-out').disabled){showAccountMenu(false);get('account-sign-out').click();}});
    menuActions.append(menuLogin,menuRegister,menuManage,menuSignOut);
    const guideButton=button('model-account-menu-link','连接说明 ↗');guideButton.id='model-connection-guide';guideButton.addEventListener('click',()=>showDrawer(true,'guide'));
    accountMenu.append(menuIdentity,menuActions,guideButton);controls.append(accountMenu);
    get('account-panel').addEventListener('buildx-account-display',renderAccountMenu);
    document.addEventListener('click',event=>{if(accountMenuOpen&&!accountMenu.contains(event.target)&&!accountButton.contains(event.target))showAccountMenu(false,false);});
    document.addEventListener('focusin',event=>{if(accountMenuOpen&&!accountMenu.contains(event.target)&&event.target!==accountButton)showAccountMenu(false,false);});
    nav = el('nav','model-nav'); nav.id = 'model-navigation'; nav.setAttribute('aria-label','工作区');
    const tabs = el('div','model-tabs'); tabs.setAttribute('role','tablist'); tabs.setAttribute('aria-label','工作区页面');
    chatTab = button('model-tab','对话'); commandTab = button('model-tab','命令'); skillsTab=button('model-tab','技能'); knowledgeTab=button('model-tab','资料库');
    const views=[[chatTab,'chat'],[commandTab,'commands'],[skillsTab,'skills'],[knowledgeTab,'knowledge']];
    for (const [tab,view] of views) {
      tab.setAttribute('role','tab'); tab.addEventListener('click',() => switchView(view));
      tab.addEventListener('keydown',event => { if (['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); const index=views.findIndex(([,name])=>name===currentView), next=views[(index+(event.key==='ArrowRight'?1:views.length-1))%views.length]; switchView(next[1]); next[0].focus(); } });
    }
    tabs.append(...views.map(([tab])=>tab)); nav.append(tabs);
    const navigationActions = el('div','model-navigation-actions'); nav.append(navigationActions);
    historyButton = button('model-history-toggle','历史对话'); historyButton.id = 'model-history-toggle'; historyButton.hidden = true;
    historyButton.setAttribute('aria-expanded','false'); historyButton.setAttribute('aria-controls','model-history-panel'); navigationActions.append(historyButton);
    historyPanel = el('section','model-history-panel'); historyPanel.id = 'model-history-panel'; historyPanel.hidden = true; historyPanel.setAttribute('aria-label','历史对话');
    const historyHeading = el('div','model-history-heading'); historyHeading.append(el('strong','','历史对话'));
    const refresh = button('model-history-retry','刷新'); refresh.addEventListener('click',() => window.dispatchEvent(new CustomEvent('buildx-history-refresh'))); historyHeading.append(refresh);
    historyList = el('div','model-history-list'); historyPanel.append(historyHeading,historyList); navigationActions.append(historyPanel);
    historyButton.addEventListener('click',() => {
      historyPanel.hidden = !historyPanel.hidden; historyButton.setAttribute('aria-expanded',String(!historyPanel.hidden));
      if (!historyPanel.hidden) window.dispatchEvent(new CustomEvent('buildx-history-refresh'));
    });
    tools = button('model-tools-count','工具'); tools.title = '查看工具'; tools.id = 'model-tools-toggle';
    tools.addEventListener('click',() => { showDrawer(true); const panel = document.querySelector('.tools-panel'); panel.open = true; panel.scrollIntoView({block:'nearest'}); }); navigationActions.append(tools);
    document.querySelector('.connection').after(nav);
    permissionBar=el('div','model-permission-bar');permissionBar.id='model-permission-bar';
    const accessLabel=el('label','sr-only','访问权限');accessLabel.setAttribute('for','model-access-select');
    accessSelect=el('select','model-permission-select model-access-select');accessSelect.id='model-access-select';accessSelect.setAttribute('aria-label','访问权限');accessSelect.disabled=true;
    for(const [value,label] of [['','范围未核实'],['__pending','更新中…'],['read-only','只读'],['project-write','项目读写'],['full-access','完全访问']]){const option=el('option','',label);option.value=value;if(value==='__pending')option.disabled=true;accessSelect.append(option);}
    accessSelect.value='';accessSelect.addEventListener('change',()=>{const mode=accessSelect.value;accessSelect.value=snapshot?.accessPolicy?.mode||'';if(!accessSelect.disabled)reviewAccess({mode});});
    accessScope=el('span','sr-only');accessScope.setAttribute('role','status');
    const permissionLabel=el('label','sr-only','执行方式');permissionLabel.setAttribute('for','model-permission-select');
    permissionSelect=el('select','model-permission-select');permissionSelect.id='model-permission-select';permissionSelect.setAttribute('aria-label','执行方式');
    permissionSelect.title='选择回滚预览或应用方式；可访问文件和模型的范围由访问权限决定。';
    for(const [value,label] of [['','请选择执行方式'],['__pending','更新中…'],['rollback','回滚预览'],['confirm','确认后应用'],['automatic','自动应用']]){const option=el('option','',label);option.value=value;if(value==='__pending')option.disabled=true;if(value==='')permissionPlaceholder=option;permissionSelect.append(option);}
    permissionSelect.value='';permissionSelect.disabled=true;
    permissionSelect.addEventListener('change',()=>{const level=permissionSelect.value;permissionSelect.value=snapshot?.modelPermission?.level||'';if(active&&!permissionSelect.disabled&&['rollback','confirm','automatic'].includes(level))window.dispatchEvent(new CustomEvent('buildx-model-permission-select',{detail:{level}}));});
    permissionScope=el('span','sr-only','权限尚未核实。');permissionScope.setAttribute('role','status');
    permissionBar.append(accessLabel,accessSelect,accessScope,permissionLabel,permissionSelect,permissionScope);
    accessConfirm=el('section','model-access-confirm');accessConfirm.id='model-access-confirm';accessConfirm.hidden=true;accessConfirm.setAttribute('aria-label','确认访问范围');
    accessConfirmText=el('p','model-access-confirm-text');accessConfirmApply=button('model-access-confirm-apply','授权此范围');accessConfirmApply.id='model-access-confirm-apply';
    const accessCancel=button('model-access-confirm-cancel','取消');accessCancel.id='model-access-confirm-cancel';accessCancel.addEventListener('click',()=>{accessReview=null;accessConfirm.hidden=true;accessSelect.focus();});
    accessConfirmApply.addEventListener('click',()=>{if(!accessReview||!canChangeAccess()||accessReview.binding!==accessBinding()){accessReview=null;accessConfirm.hidden=true;return;}const detail={mode:accessReview.mode,...accessReview.rootId?{rootId:accessReview.rootId}:{},confirmed:true};accessReview=null;accessConfirm.hidden=true;window.dispatchEvent(new CustomEvent('buildx-access-policy-select',{detail}));});
    const accessActions=el('div','model-access-confirm-actions');accessActions.append(accessCancel,accessConfirmApply);accessConfirm.append(accessConfirmText,accessActions);get('composer').before(accessConfirm);
    accessStatus=el('p','model-access-status');accessStatus.id='model-access-status';accessStatus.setAttribute('role','status');accessStatus.hidden=true;get('composer').after(accessStatus);
    drawer = el('div','model-account-overlay'); drawer.id = 'model-account-drawer'; drawer.hidden = true;
    const dialog = el('section','model-account-dialog'); dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true'); dialog.setAttribute('aria-labelledby','model-account-title'); dialog.tabIndex = -1;
    const dialogHeading=el('header','model-account-heading'); drawerTitle=el('h2','','连接与工具'); drawerTitle.id='model-account-title';
    drawerClose=button('model-account-close','×'); drawerClose.setAttribute('aria-label','关闭账号窗口'); drawerClose.addEventListener('click',()=>showDrawer(false));
    dialogHeading.append(drawerTitle,drawerClose); drawerBody=el('div','model-account-drawer'); dialog.append(dialogHeading,drawerBody); drawer.append(dialog); document.body.append(drawer);
    drawer.addEventListener('click',event=>{if(event.target === drawer)showDrawer(false);});
    historyNotice = el('div','model-conversation-note'); historyNotice.id = 'model-conversation-note'; historyNotice.hidden = true; historyNotice.setAttribute('role','status');
    historyText = el('span'); historyContinue = button('model-history-continue','新建对话继续'); historyContinue.addEventListener('click',() => get('new-chat').click());
    historyNotice.append(historyText,historyContinue); get('context-panel').before(historyNotice);
    const accountPanels = [document.querySelector('.connection'),get('account-panel'),get('codex-account-panel'),document.querySelector('.tools-panel')];
    for (const panel of accountPanels) { remember(panel); drawerBody.append(panel); }
    const permissionInfo=el('details','account-panel'); permissionInfo.id='model-permission-info';
    const permissionSummary=el('summary'); permissionSummary.append(el('span','','访问权限与执行方式'),el('span','','查看范围')); permissionInfo.append(permissionSummary);
    const permissionBody=el('div','account-content');
    permissionDetails=el('p','account-boundary','权限尚未核实。');permissionDetails.setAttribute('role','status');
    permissionSafety=el('p','account-boundary','权限尚未核实，请勿据此推断脚本或文件操作的审批状态。');
    permissionBody.append(permissionDetails,el('p','account-boundary','访问权限决定文件和模型的范围：只读、选定项目目录读写，或当前 Windows 账号可访问的本机文件。添加参考资料不会自动授予编辑权限。回滚预览不保留模型事务修改；确认后应用会逐次确认；自动应用按当前授权范围执行。'),
      permissionSafety,
      el('p','account-boundary','文件编辑和 Revit 模型编辑分别核实状态；权限不提升 Windows 权限，也不改变 Revit 自身只读状态。模型编辑不直接改写 RVT 二进制，模型操作不会自动保存 Revit 文件。'));
    permissionInfo.append(permissionBody); drawerBody.append(permissionInfo);
    modelReceiptPanel=el('section','model-receipt-panel');modelReceiptPanel.id='model-receipt-panel';modelReceiptPanel.hidden=true;modelReceiptPanel.setAttribute('aria-label','待核查的模型操作');
    modelReceiptDetails=el('details','model-receipt-details');modelReceiptDetails.id='model-receipt-details';modelReceiptDetails.open=false;
    const receiptSummary=el('summary','model-receipt-heading');modelReceiptOpen=receiptSummary;modelReceiptOpen.id='model-receipt-open';modelReceiptOpen.setAttribute('aria-controls',modelReceiptDetails.id);modelReceiptOpen.setAttribute('aria-expanded','false');
    modelReceiptNotice=el('span','model-receipt-notice');modelReceiptNotice.id='model-receipt-notice';modelReceiptNotice.setAttribute('role','status');modelReceiptTitle=el('strong','','模型写入已暂停');modelReceiptState=el('span','model-receipt-state');modelReceiptNotice.append(modelReceiptTitle,modelReceiptState);receiptSummary.append(modelReceiptNotice);
    modelReceiptDescription=el('p','model-receipt-description');modelReceiptStatus=el('p','model-receipt-status');modelReceiptStatus.setAttribute('role','status');modelReceiptFailure=el('p','model-receipt-failure');modelReceiptFailure.hidden=true;modelReceiptNext=el('p','model-receipt-next');
    modelReceiptRaw=el('details','model-receipt-raw');modelReceiptRaw.open=false;modelReceiptRaw.hidden=true;modelReceiptEvidence=el('pre','model-receipt-evidence');modelReceiptRaw.append(el('summary','','技术回执'),modelReceiptEvidence);
    const receiptActions=el('div','model-receipt-actions');modelReceiptCheck=button('model-receipt-check','立即核查');modelReceiptCheck.title='只读取原请求的回执，不会重新执行操作。';modelReceiptAcknowledge=button('model-receipt-acknowledge','确认已核对');modelReceiptRecover=button('model-receipt-recover','已核查，继续');modelReceiptRecover.hidden=true;
    modelReceiptCheck.addEventListener('click',()=>{const receipt=snapshot?.modelReceipt;if(active&&receipt&&!modelReceiptCheck.disabled)window.dispatchEvent(new CustomEvent('buildx-model-receipt-check',{detail:{ticket:receipt.ticket,conversationId:receipt.conversationId}}));});
    modelReceiptAcknowledge.addEventListener('click',()=>{const receipt=snapshot?.modelReceipt;if(active&&receipt?.check?.terminal===true&&!modelReceiptAcknowledge.disabled)window.dispatchEvent(new CustomEvent('buildx-model-receipt-acknowledge',{detail:{ticket:receipt.ticket,conversationId:receipt.conversationId,checkRevision:receipt.checkRevision}}));});
    modelReceiptRecover.addEventListener('click',()=>{const receipt=snapshot?.modelReceipt;if(active&&receipt?.canRecover===true&&!modelReceiptRecover.disabled)window.dispatchEvent(new CustomEvent('buildx-model-receipt-recover',{detail:{ticket:receipt.ticket,conversationId:receipt.conversationId,checkRevision:receipt.checkRevision}}));});
    receiptActions.append(modelReceiptCheck,modelReceiptAcknowledge,modelReceiptRecover);const receiptBody=el('div','model-receipt-body');receiptBody.append(modelReceiptDescription,modelReceiptStatus,modelReceiptFailure,modelReceiptNext,receiptActions,modelReceiptRaw);modelReceiptDetails.append(receiptSummary,receiptBody);modelReceiptPanel.append(modelReceiptDetails);
    // One compact control follows the pending operation across conversations.
    // Its source identity comes from the server, never from the latest message.
    get('composer').before(modelReceiptPanel);
    modelReceiptOpen.addEventListener('click',event=>{event.preventDefault();const receipt=snapshot?.modelReceipt;if(!active||!receipt||receipt.conversationId!==snapshot.commandConversationId||modelReceiptBinding!==JSON.stringify([snapshot.accountEpoch,receipt.conversationId,receipt.ticket]))return;modelReceiptDetails.open=!modelReceiptDetails.open;modelReceiptOpen.setAttribute('aria-expanded',String(modelReceiptDetails.open));});
    modelReceiptDetails.addEventListener('toggle',()=>modelReceiptOpen.setAttribute('aria-expanded',String(modelReceiptDetails.open)));
    mcpPanel=el('details','account-panel');mcpPanel.id='model-mcp-candidates';mcpPanel.hidden=true;
    const mcpSummary=el('summary');mcpSummary.append(el('span','','MCP 候选配置'),el('span','','仅查看'));mcpPanel.append(mcpSummary);
    const mcpBody=el('div','account-content');
    mcpBody.append(el('p','account-boundary','仅显示本次连接启动时读取的本机配置名称。此处不会连接、启动或授权第三方 MCP；配置变更后需重新连接才会更新。'));
    mcpRead=button('model-mcp-read','读取配置名称');mcpRead.addEventListener('click',()=>{if(active&&!mcpRead.disabled)window.dispatchEvent(new CustomEvent('buildx-mcp-candidates-read'));});
    mcpStatus=el('p','account-boundary','尚未读取。');mcpStatus.setAttribute('role','status');mcpList=el('ul','model-mcp-list');mcpBody.append(mcpRead,mcpStatus,mcpList);mcpPanel.append(mcpBody);drawerBody.append(mcpPanel);
    get('account-panel').open = true; get('codex-account-panel').open = true;
    const guideContent=el('div','model-connection-guide-content');guideContent.setAttribute('role','status');
    guideContent.append(el('p','model-connection-guide-title','连接说明待接入'),el('p','','网关网站接入后，可在这里查看连接步骤。'));
    const localConnection=button('model-account-menu-secondary','查看本机连接');localConnection.addEventListener('click',()=>showDrawer(true,'connection'));guideContent.append(localConnection);drawerBody.append(guideContent);
    commandList = el('section','model-command-list'); commandList.id = 'model-command-list'; commandList.setAttribute('aria-label','常用命令');
    commandList.hidden = true; messages.prepend(commandList);
    chatDraftNotice=el('p','model-command-draft-help');chatDraftNotice.hidden=true;chatDraftNotice.setAttribute('role','status');messages.prepend(chatDraftNotice);
    knowledgePanel=el('section','model-extra-panel'); knowledgePanel.id='project-knowledge-panel'; knowledgePanel.setAttribute('aria-label','资料库'); knowledgePanel.hidden=true; messages.prepend(knowledgePanel);
    skillsPage=el('section','model-extra-panel model-skills-page'); skillsPage.id='model-skills-page'; skillsPage.setAttribute('aria-label','技能'); skillsPage.hidden=true; messages.prepend(skillsPage);
    remember(get('skills-panel')); skillsPage.append(get('skills-panel'));
    window.dispatchEvent(new CustomEvent('buildx-extra-panels-ready'));
    commandSearch=el('input','model-command-filter'); commandSearch.type='search'; commandSearch.placeholder='搜索命令或工具'; commandSearch.setAttribute('aria-label','搜索命令');
    const createArea=el('div','command-create-area'),createControls=el('div','command-create-controls'),createType=el('label','command-create-type');createType.append(el('span','','命令类型'));
    createCommandKind=el('select');createCommandKind.id='model-create-command-kind';createCommandKind.setAttribute('aria-label','新命令类型');
    for(const [kind,label,disabled] of [['csharp','C# 命令',false],['sequence','只读步骤命令',false],['dll','原生 DLL（暂未接入）',true],['dynamo','Dynamo（暂未接入）',true]]){const option=el('option','',label);option.value=kind;option.disabled=disabled;createCommandKind.append(option);}createCommandKind.value='csharp';createType.append(createCommandKind);
    createCommand=button('command-create','');createCommand.id='model-create-command';createCommand.append(el('span','command-create-symbol','＋'),el('strong','','创建命令'));
    createCommandHelp=el('small','command-create-help');createCommandHelp.id='model-create-command-help';createCommandHelp.setAttribute('role','status');createCommandKind.setAttribute('aria-describedby',createCommandHelp.id);
    createCommandKind.addEventListener('change',()=>renderCommandCreation());
    createCommand.addEventListener('click',()=>{if(active&&!createCommand.disabled&&['csharp','sequence'].includes(createCommandKind.value))window.dispatchEvent(new CustomEvent('buildx-create-command',{detail:{kind:createCommandKind.value}}));});
    createControls.append(createType,createCommand);createArea.append(createControls,createCommandHelp);renderCommandCreation();
    commandSearch.addEventListener('input',filterCommands); commandItems=el('div','model-command-items'); commandList.append(commandSearch,createArea,commandItems); buildCommandRows(commandCatalog);
    const frame = el('div','model-input-frame'); prompt.before(frame); frame.append(prompt);
    attachmentList=el('div','model-pending-attachments'); attachmentList.hidden=true; attachmentList.setAttribute('aria-label','待发送附件'); frame.before(attachmentList);
    attachmentButton=button('model-add-file','＋'); attachmentButton.hidden=true; attachmentButton.title='添加图片或文本文件';
    attachmentInput=el('input'); attachmentInput.type='file'; attachmentInput.multiple=true; attachmentInput.accept='.txt,.md,.markdown,.png,.jpg,.jpeg'; attachmentInput.hidden=true; attachmentInput.setAttribute('aria-label','选择图片或文本文件');
    document.querySelector('.composer-bottom').prepend(attachmentButton); attachmentButton.after(permissionBar);get('composer').append(attachmentInput);
    attachmentButton.addEventListener('click',() => { if(active && snapshot?.turnAttachmentsAvailable && !attachmentButton.disabled) attachmentInput.click(); });
    attachmentInput.addEventListener('change',() => {
      const chosen=attachmentInput.files, files=chosen?.length>4 ? {length:chosen.length} : Array.from(chosen || []); attachmentInput.value='';
      if(active && snapshot?.turnAttachmentsAvailable && !attachmentButton.disabled) window.dispatchEvent(new CustomEvent('buildx-attachments-add',{detail:{files}}));
    });
    const canAttach=()=>active && snapshot?.turnAttachmentsAvailable && !attachmentButton.disabled;
    prompt.addEventListener('paste',event=>{
      if(!canAttach())return;
      const files=clipboardImageFiles(event.clipboardData);
      if(!files.length)return; // Keep ordinary text paste and text/HTML selection intact.
      event.preventDefault();window.dispatchEvent(new CustomEvent('buildx-attachments-add',{detail:{files}}));
    });
    const composer=get('composer');
    composer.addEventListener('dragover',event=>{
      if(!active || !hasTransferredFiles(event.dataTransfer))return;
      event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect=canAttach()?'copy':'none';
      if(canAttach())composer.classList.add('model-file-dragover');
    });
    composer.addEventListener('dragleave',event=>{if(!composer.contains(event.relatedTarget))composer.classList.remove('model-file-dragover');});
    composer.addEventListener('drop',event=>{
      composer.classList.remove('model-file-dragover');
      if(!active || !hasTransferredFiles(event.dataTransfer))return;
      event.preventDefault();
      if(canAttach())window.dispatchEvent(new CustomEvent('buildx-attachments-add',{detail:{files:Array.from(event.dataTransfer.files || [])}}));
    });
    // Dropping elsewhere must not replace the Revit WebView with a local file.
    for(const type of ['dragover','drop'])document.addEventListener(type,event=>{
      if(active && hasTransferredFiles(event.dataTransfer))event.preventDefault();
    });
    overlay = el('div','model-input-highlight'); overlay.setAttribute('aria-hidden','true'); frame.prepend(overlay);
    picker = el('div','model-tool-picker'); picker.id = 'model-tool-picker'; picker.hidden = true; picker.setAttribute('role','listbox'); picker.setAttribute('aria-label','可用工具'); frame.append(picker);
    for (const name of ['aria-controls','aria-autocomplete','aria-expanded','aria-activedescendant']) originalPromptAttributes.set(name,prompt.getAttribute(name));
    prompt.setAttribute('aria-controls',picker.id); prompt.setAttribute('aria-autocomplete','list'); prompt.setAttribute('aria-expanded','false');
    prompt.placeholder = '输入问题，或用 @ 选择工具';
    hint = document.querySelector('.composer-bottom > span'); if (hint) { originalHint = hint.textContent; hint.textContent = 'Enter 发送 · Shift + Enter 换行 · Ctrl+V 粘贴截图'; }
    remember(get('stop')); get('activity').append(get('stop'));
    get('welcome-title').textContent = '今天想完成什么？';
    get('welcome-description').textContent = '从一个问题开始。';
    get('welcome-hint').textContent = '';
    prompt.addEventListener('input',() => { renderHighlight(); selected = 0; renderPicker(); });
    prompt.addEventListener('click',renderPicker); prompt.addEventListener('keyup',event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) renderPicker(); });
    prompt.addEventListener('scroll',renderHighlight);
    prompt.addEventListener('compositionstart',() => { composing = true; closePicker(); });
    prompt.addEventListener('compositionend',() => { composing = false; renderHighlight(); renderPicker(); });
    prompt.addEventListener('keydown',event => {
      if (!active || composing || event.isComposing || event.keyCode === 229 || picker.hidden) return;
      if (event.key === 'Enter' && event.shiftKey) { closePicker(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closePicker(); return; }
      if (matches.length && ['ArrowDown','ArrowUp','Enter','Tab'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { selected = (selected + (event.key === 'ArrowDown' ? 1 : matches.length-1)) % matches.length; renderPicker(); }
        else chooseMention(selected);
      }
    },true);
    document.addEventListener('pointerdown',event => { if (!frame.contains(event.target)) closePicker(); });
    document.addEventListener('pointerdown',event => { if (!navigationActions.contains(event.target)) { historyPanel.hidden = true; historyButton.setAttribute('aria-expanded','false'); } });
    document.addEventListener('keydown',event => {
      if(active && drawerOpen && event.key === 'Tab') {
        const focusable=[...drawer.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex="0"]')].filter(item=>!item.disabled && !item.hidden && item.getClientRects?.().length !== 0);
        const first=focusable[0] || drawerClose,last=focusable.at(-1) || drawerClose;
        if(event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))){event.preventDefault();last.focus();}
        else if(!event.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))){event.preventDefault();first.focus();}
      }
      if (active && event.key === 'Escape' && drawerOpen) { event.preventDefault(); showDrawer(false); }
      else if (active && event.key === 'Escape' && accountMenuOpen) { event.preventDefault(); showAccountMenu(false); }
      if (active && event.key === 'Escape' && !historyPanel.hidden) { historyPanel.hidden = true; historyButton.setAttribute('aria-expanded','false'); historyButton.focus(); }
    });
    window.addEventListener('resize',renderHighlight);
    window.addEventListener('buildx-mcp-candidates-result',event=>{
      if(!active||!mcpPanel)return;
      const detail=event.detail;
      if(!detail||!['cleared','loading','loaded','error'].includes(detail.status))return;
      mcpList.replaceChildren();
      if(detail.status==='cleared'){mcpStatus.textContent='连接或账号已变化，请重新读取。';return;}
      if(detail.status==='loading'){mcpStatus.textContent='正在读取连接时的配置快照…';return;}
      if(detail.status==='error'){mcpStatus.textContent='配置快照未能核实，请检查本机连接后重试。';return;}
      if(!Array.isArray(detail.servers)||detail.servers.length>100){mcpStatus.textContent='配置快照格式无效。';return;}
      mcpStatus.textContent=detail.servers.length?'以下是本次连接时的配置名称：':'本次连接时未发现配置的 MCP 服务。';
      const labels={disabled:'本连接已禁用',reserved:'BuildX 内建服务名称',unknown:'状态尚未核实'};
      for(const item of detail.servers){
        if(!item||typeof item.name!=='string'||!/^[A-Za-z0-9_-]{1,1024}$/.test(item.name)||!Object.hasOwn(labels,item.status)){mcpList.replaceChildren();mcpStatus.textContent='配置快照格式无效。';return;}
        mcpList.append(el('li','',item.name+' · '+labels[item.status]));
      }
    });
  }
  function update(value) {
    if(shellBroken)return;
    try { updateModel(value); }
    catch(error){shellBroken=true;hideModelShell();throw error;}
  }
  function updateModel(value) {
    const previous = snapshot;
    snapshot = value;
    if (!value?.enabled) {
      if (mounted && active) restoreLayout();
      return;
    }
    // A failed stylesheet request can still expose an empty CSSStyleSheet;
    // only the marker defined by the actual model stylesheet proves it loaded.
    if(typeof window.getComputedStyle==='function' && window.getComputedStyle(document.documentElement).getPropertyValue('--buildx-model-shell-style').trim()!=='ready'){hideModelShell();return;}
    if (!mounted) mount();
    if (!active) {
      controls.hidden = false; controls.prepend(get('new-chat'));
      for (const {element} of placements) if (element.id === 'account-panel' || element.id === 'codex-account-panel' || element.id !== 'skills-panel' && element.classList.contains('tools-panel') || element.classList.contains('connection')) drawerBody.append(element);
      skillsPage.append(get('skills-panel'));
      get('activity').append(get('stop'));
      prompt.setAttribute('aria-controls',picker.id); prompt.setAttribute('aria-autocomplete','list'); prompt.setAttribute('aria-expanded','false');
      if (hint) hint.textContent = 'Enter 发送 · Shift + Enter 换行';
    }
    active = true; document.body.classList.add('model-workspace'); nav.hidden = false;permissionBar.hidden=false;
    const policy=value.accessPolicy,validAccess=policy?.available===true&&['read-only','project-write','full-access'].includes(policy.mode)&&Number.isSafeInteger(policy.revision)&&Array.isArray(policy.roots);
    accessSelect.value=value.accessPolicyPending?'__pending':validAccess?policy.mode:'';
    accessSelect.disabled=!validAccess||value.accessPolicyPending===true||value.modelPermissionPending===true||value.blocked||value.busy||value.readOnly||value.ready!==true;
    const accessText=validAccess?(policy.mode==='full-access'?'本机文件可读写':policy.mode==='project-write'?'项目目录可读写：'+policy.roots.join('；'):'文件与模型只读'):(value.accessPolicyMessage||'访问范围尚未核实。');
    accessScope.textContent=accessText;accessSelect.title=accessText;
    accessStatus.hidden=!validAccess&&!value.accessPolicyMessage;
    accessStatus.textContent=value.accessPolicyPending?'正在更新访问范围…':value.accessPolicyMessage||accessText+(policy?.modelWritable===false?'；Revit：'+(policy.modelMessage||'当前模型编辑尚未启用。'):policy?.modelWritable===true?'；Revit：当前模型可编辑。':'');
    if(accessReview&&(accessReview.binding!==accessBinding()||!canChangeAccess())){accessReview=null;accessConfirm.hidden=true;}
    accessConfirmApply.disabled=!canChangeAccess();
    const permission=value.modelPermission, validPermission=value.ready===true&&permission?.available===true&&(permission.level===null||['rollback','confirm','automatic'].includes(permission.level))&&permission.conversationId===value.commandConversationId&&(permission.expiresAt===null||Number.isSafeInteger(permission.expiresAt)&&permission.expiresAt>Date.now());
    permissionPlaceholder.textContent=validPermission?'请选择执行方式':'执行未核实';
    permissionSelect.value=value.modelPermissionPending?'__pending':validPermission?permission.level||'':'';
    permissionSelect.disabled=!validPermission||value.modelPermissionPending===true||value.accessPolicyPending===true||value.blocked||value.busy||value.readOnly||value.ready!==true;
    const permissionText=value.modelPermissionPending?(value.modelPermissionMessage||'正在等待 Revit 核实当前模型与执行权限…'):validPermission?(permission.level===null?'尚未授权；选择后会核实当前模型。':'当前模型：'+permission.documentLabel+'；执行方式绑定当前对话，切换模型后重新核实适用范围。'):value.modelPermissionMessage||'执行方式尚未核实。';
    permissionScope.textContent=permissionText;permissionDetails.textContent=permissionText;
    permissionSafety.textContent=(validAccess?'访问范围：'+accessText+'。':'访问范围尚未核实。')+' 脚本、文件和族操作按实际授权及执行方式核验。C# 脚本不是安全沙盒，回滚不能撤销事务外副作用。';
    permissionSelect.title=permissionText;
    const receipt=value.modelReceipt,hasReceipt=Boolean(receipt&&receipt.conversationId===value.commandConversationId);
    modelReceiptPanel.hidden=!hasReceipt;modelReceiptNotice.hidden=!hasReceipt;
    if(hasReceipt){
      const binding=JSON.stringify([value.accountEpoch,receipt.conversationId,receipt.ticket]);
      if(modelReceiptBinding!==binding){modelReceiptBinding=binding;modelReceiptDetails.open=false;modelReceiptRaw.open=false;modelReceiptOpen.setAttribute('aria-expanded','false');}
      modelReceiptPanel.dataset.conversationId=receipt.conversationId;modelReceiptPanel.dataset.ticket=receipt.ticket;
      const check=receipt.check,failure=check?.evidence?.nativeFailure,knownFailure=failure&&typeof failure==='object'&&!Array.isArray(failure)&&typeof failure.code==='string'&&failure.code.length<=160&&typeof failure.message==='string'&&failure.message.length<=4096;
      const failedDispatch=knownFailure&&failure.outcome==='failed'&&failure.started===true&&failure.phase==='dispatch';
      const checking=receipt.checking||value.modelReceiptPendingAction==='check';
      const recovering=receipt.canRecover===true,autoActive=receipt.autoCheck?.active===true,autoMessage=receipt.autoCheck?.message;
      const labels={received:'已核实执行结果，正在恢复后续操作。',version_present:'准确版本存在；无法判断是否由本次请求新建。',not_started:'已确认：本次操作未开始。',failed:'已确认：操作执行失败。',failed_rolled_back:'脚本报错，模型事务已回滚。文件、网络等事务外影响尚未核实。',expired:'请求已过期，操作未执行。',pending:'正在等待原操作回执，收到后会自动核查。',host_changed:'Revit 已重新连接，原操作结果仍需核查。',unconfirmed:'原回执仍未核实，实际结果尚不确定。'};
      const description=recovering?'脚本已报错结束，是否回滚仍未核实。':failedDispatch&&check?.status!=='failed_rolled_back'?(receipt.tool==='revit_execute_csharp'?'脚本执行报错；是否回滚仍未核实。':'操作执行报错；实际影响仍需核实。'):check?labels[check.status]||'已取得检查状态，结果仍需核实。':autoActive?'正在自动核查原操作回执。':'等待原操作回执。';
      modelReceiptTitle.textContent='模型写入已暂停';modelReceiptState.textContent=autoMessage?'等待处理':recovering?'需要核查':checking||autoActive?'正在自动核查':check?.terminal===true?'正在恢复':failedDispatch?'执行报错':'等待回执';
      modelReceiptDescription.textContent=(receipt.sourceConversationId!==receipt.conversationId?'来自另一段对话 · ':'')+'操作：'+(commandCatalog.find(command=>command.tool===receipt.tool)?.label||receipt.tool)+'。请勿重复执行。';
      modelReceiptStatus.textContent=value.modelReceiptMessage||autoMessage||(checking?'正在读取原回执…':description);
      modelReceiptFailure.hidden=!knownFailure;modelReceiptFailure.textContent=knownFailure?'执行器返回：'+failure.code+' · '+failure.message:'';
      modelReceiptNext.textContent=recovering?'请先只读核查模型，再点击“已核查，继续”。回滚与事务外影响尚未确认；不会重跑原脚本。':check?.terminal===true?'系统会自动处理确定结果；也可手动确认。不会重复执行操作。':'可以继续聊天或新建对话，也可只读核查模型。原操作确定前，后续模型写入保持暂停。';
      modelReceiptRaw.hidden=!check;modelReceiptEvidence.textContent=check?JSON.stringify(check,null,2):'';
      const disabled=value.account?.required===true&&value.account.signedIn!==true||value.readOnly||value.modelReceiptPending||receipt.checking;
      modelReceiptCheck.textContent=checking?'核查中…':check?'再次核查':'立即核查';modelReceiptCheck.disabled=Boolean(disabled);modelReceiptAcknowledge.hidden=check?.terminal!==true;
      modelReceiptAcknowledge.textContent=value.modelReceiptPendingAction==='acknowledge'?'确认中…':value.modelReceiptAckSubmitted?'等待服务确认…':'确认已核对';
      modelReceiptAcknowledge.disabled=Boolean(disabled||value.busy||value.blocked||value.modelReceiptAckSubmitted||check?.terminal!==true);
      modelReceiptRecover.hidden=!recovering;modelReceiptRecover.textContent=value.modelReceiptPendingAction==='recover'?'正在恢复…':value.modelReceiptAckSubmitted?'等待服务确认…':'已核查，继续';
      modelReceiptRecover.disabled=Boolean(disabled||value.busy||value.blocked||value.modelReceiptAckSubmitted||!recovering);
    }else clearReceiptDisplay();
    mcpPanel.hidden=value.mcpCandidatesAvailable!==true;
    mcpRead.disabled=value.mcpCandidatesAvailable!==true||value.ready!==true;
    if(previous&&(previous.accountEpoch!==value.accountEpoch||previous.commandIdentityKey!==value.commandIdentityKey||value.mcpCandidatesAvailable!==true||value.ready!==true)){
      mcpList.replaceChildren();mcpStatus.textContent='连接或账号已变化，请重新读取。';
    }
    catalog = modelToolCatalog(value.toolCatalog);
    if(Array.isArray(value.commandCatalog)) {
      const incoming=modelCommandCatalog(value.commandCatalog),signature=JSON.stringify(incoming);
      if(signature !== commandCatalogSignature){commandCatalogSignature=signature;commandCatalog=incoming;buildCommandRows(commandCatalog);}
    }
    if (previous && (previous.accountEpoch !== value.accountEpoch || previous.contextEpoch !== value.contextEpoch)) {
      closePicker();
      if (previous.accountEpoch !== value.accountEpoch) {
        draftOrigin=null;renderDraftOrigin();
        historyPanel.hidden = true; historyButton.setAttribute('aria-expanded','false');
        for (const input of parameterInputs) {input.value=input.dataset.defaultValue || '';if(input.type === 'checkbox')input.checked=false;}
        for (const row of rows) { row.parameters.hidden = true; row.apply.textContent = '展开'; row.apply.setAttribute('aria-expanded','false'); }
        for (const error of commandList.querySelectorAll('.model-command-error')) { error.textContent = ''; error.hidden = true; }
      }
    }
    if(draftOrigin && (draftOrigin.accountEpoch!==value.accountEpoch || draftOrigin.contextEpoch!==value.contextEpoch || draftOrigin.identityKey!==value.commandIdentityKey || draftOrigin.conversationId!==value.commandConversationId)){draftOrigin.invalid=true;renderDraftOrigin();}
    if(previous&&(previous.accountEpoch!==value.accountEpoch||previous.contextEpoch!==value.contextEpoch||previous.commandIdentityKey!==value.commandIdentityKey||previous.commandConversationId!==value.commandConversationId))for(const row of rows)for(const field of row.fields||[])field.setDefinition?.(null);
    if(previous&&(previous.modelPermission?.revision!==value.modelPermission?.revision||previous.modelPermission?.level!==value.modelPermission?.level||previous.modelPermissionPending!==value.modelPermissionPending))for(const row of rows)if(row.inputs?.$confirmation)row.inputs.$confirmation.checked=false;
    for(const row of rows)renderCommandConfirmation(row);
    if (previous?.activeId !== value.activeId) { historyPanel.hidden = true; historyButton.setAttribute('aria-expanded','false'); closePicker(); }
    const count = Number.isInteger(value.toolCount) && value.toolCount >= 0 ? value.toolCount : null;
    tools.textContent = count === null ? '工具' : '工具 ' + count; tools.title = '查看工具目录';
    renderAccountMenu();
    for(const row of rows)for(const field of row.fields || [])field.update?.(value);
    const fieldControls=rows.flatMap(row=>(row.fields || []).flatMap(field=>field.controls));
    for (const control of new Set([...commandButtons,...parameterInputs,...fieldControls])) control.disabled = control.dataset.commandEnabled === 'false' || control.dataset.fieldUnavailable === 'true' || !value.directCommandsAvailable || !(value.commandsReady ?? value.ready) || value.blocked || value.busy || value.modelPermissionPending || value.readOnly || value.persistence?.status === 'failed';
    renderCommandCreation(value);
    prompt.placeholder = value.readOnly ? '新建对话继续' : '输入问题，或用 @ 选择工具';
    drawer.hidden = !drawerOpen;
    commandList.hidden = currentView !== 'commands';
    for(const [tab,name] of [[chatTab,'chat'],[commandTab,'commands'],[skillsTab,'skills'],[knowledgeTab,'knowledge']]){tab.setAttribute('aria-selected',String(currentView===name));tab.tabIndex=currentView===name?0:-1;}
    document.body.dataset.modelView = currentView;
    get('welcome').hidden = currentView !== 'chat' || value.hasMessages === true;
    renderHighlight();
    if (!picker.hidden) renderPicker();
    renderHistory();
    renderAttachments();
    renderCommandResults();
    filterCommands();
    // The shared base is deliberately hidden until the complete model update
    // succeeds; partial mount failures must not reveal the superseded layout.
    const shell=get('model-shell-content'),fallback=get('model-shell-fallback');
    if(shell)shell.hidden=false;if(fallback)fallback.hidden=true;
    document.body.dataset.modelReady='true';
  }
  window.addEventListener('buildx-model-view',event => update(event.detail));
  window.addEventListener('buildx-command-draft-from-chat',event => {if(active)importChatDraft(event.detail);});
  window.addEventListener('buildx-open-chat',()=>switchView('chat'));
  window.addEventListener('buildx-access-project-request',event=>reviewAccess({...event.detail,mode:'project-write'}));
  window.addEventListener('buildx-command-authoring-started',()=>{switchView('chat');prompt.focus();});
  window.dispatchEvent(new CustomEvent('buildx-model-mounted'));
  return {update};
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') mountModelWorkspace({document,window,CustomEvent,Event});
