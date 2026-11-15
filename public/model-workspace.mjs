import {createCommandField,createSheetRenumberField,createSheetBatchField,COMMAND_PARAMETER_LABELS,isExactIdRule,parseExactIdValue} from './command-fields.mjs';
import {createCommandChoiceField} from './command-choice-field.mjs';
import {createParameterChangeField} from './parameter-change-field.mjs';
import {createPersonalCommandFields} from './personal-command-fields.mjs';
import {commandFormOwner} from './command-form-source.mjs';
import {createManualTypeParameterWriteField} from './manual-type-parameter-write-field.mjs';
import {clipboardImageFiles,hasTransferredFiles} from './clipboard-attachments.mjs';
import {modelToolEntries} from './chat-view.mjs';

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
  if (!Array.isArray(value) || value.length > 1024) return [];
  const ids = new Set();
  return value.filter(item => {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,159}$/.test(item.id) || ids.has(item.id) ||
        typeof item.tool !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,159}$/.test(item.tool)) return false;
    ids.add(item.id); return true;
  }).map(item => ({id:item.id,tool:item.tool,name:typeof item.label === 'string' ? item.label.slice(0,160) : item.tool,
    description:typeof item.description === 'string' ? item.description.slice(0,500) : '',
    group:typeof item.group === 'string' ? item.group.slice(0,80) : '其他',readOnly:item.readOnly === true,
    effectKind:['model_transaction','ui_selection'].includes(item.effectKind)?item.effectKind:null,
    enabled:item.enabled === true,unavailableReason:typeof item.unavailableReason === 'string' ? item.unavailableReason.slice(0,500) : '',
    manualExecution:item.manualExecution!==false,manualUnavailableReason:typeof item.manualUnavailableReason==='string'?item.manualUnavailableReason.slice(0,500):'',
    requiresTypeParameterReview:item.requiresTypeParameterReview===true,
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
        if (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum ||
          rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum || rule.exclusiveMaximum !== undefined && value >= rule.exclusiveMaximum) throw new Error();
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

// Display only: retain raw millimetre values in the response and model.
export function formatLevelElevation(value){
  if(typeof value!=='number'||!Number.isFinite(value))return '—';
  const formatted=value.toFixed(2);
  return formatted==='-0.00'?'0.00':formatted;
}

export function formatDisplayValue(value,key=''){
  if(value===null||value===undefined)return '—';
  if(typeof value==='number'&&!/(?:^|_)(?:id|ids|count|total|offset|limit|revision|version|index|schema)(?:_|$)|value_internal|(?:Id|ID|Ids|UUID|Guid|Count|Index|Revision|Version)$/ .test(key))return formatLevelElevation(value);
  return String(value);
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
  const failure=command.error?.nativeFailure;
  if(failure?.phase==='queue'&&failure.started===false){
    if(command.status==='failed'&&command.error.outcome==='expired'&&failure.reason==='expired')view.error='请求在排队期间过期，未执行。';
    if(command.status==='interrupted'&&command.error.outcome==='not_started'&&failure.reason==='cancelled')view.error='已取消，未执行。';
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
    view.rows = (Array.isArray(data.items) ? data.items : []).slice(0,200).map(item => [text(item.name),formatLevelElevation(item.elevation_mm)]);
    view.summary = Number.isSafeInteger(data.total) ? (view.rows.length < data.total ? '显示 ' + view.rows.length + ' / ' + data.total + ' 个标高' : '共 ' + data.total + ' 个标高') : '';
  } else if (['selection','search'].includes(command.commandId)) {
    view.columns = ['名称','类别','ID'];
    view.rows = (Array.isArray(data.items) ? data.items : []).slice(0,200).map(item => [text(item.name),text(item.category),text(item.element_id)]);
    if (Number.isSafeInteger(data.returned) && Number.isSafeInteger(data.total)) view.summary = '显示 ' + data.returned + ' / ' + data.total + ' 项' + (data.has_more || data.truncated ? ' · 仅展示本次返回' : '');
  } else if (command.commandId === 'revit_preview_project_parameter_binding') {
    const payload=Object.hasOwn(data,'value')?data.value:data;
    if(payload?.schema_version!==1||payload.coverage!=='complete_current_document_instances'||payload.authorization!=='not_granted'||payload.binding_attempted!==false||
      !Number.isSafeInteger(payload.instance_count)||payload.instance_count<0||payload.instance_count>500||!Number.isSafeInteger(payload.offset)||payload.offset<0||
      !Number.isSafeInteger(payload.limit)||payload.limit<1||payload.limit>50||typeof payload.snapshot_id!=='string'||!/^[a-f0-9]{64}$/.test(payload.snapshot_id)||
      !Array.isArray(payload.instances)||payload.instances.length!==Math.min(payload.limit,payload.instance_count-payload.offset)||payload.offset>payload.instance_count||
      payload.has_more!==(payload.offset+payload.instances.length<payload.instance_count)||payload.instances.some(item=>!item||typeof item.element_id!=='string'||typeof item.category_id!=='string'||typeof item.unique_id!=='string')){
      view.status='结果待核对';view.error='项目参数影响预览不完整，请核对原回执。';return view;
    }
    view.columns=['构件 ID','类别 ID','UniqueId'];view.rows=payload.instances.map(item=>[item.element_id,item.category_id,item.unique_id]);
    const range=payload.instances.length?'第 '+(payload.offset+1)+'–'+(payload.offset+payload.instances.length)+' 项 / 共 '+payload.instance_count+' 项':'共 '+payload.instance_count+' 项';
    view.summary='当前实例：'+range+'；未来实例也可能受影响。本次只读，不授予写入权限。'+
      (payload.has_more?' 下一页须使用相同快照指纹：'+payload.snapshot_id:'');
  } else if (command.commandId === 'revit_preview_batch_parameter_filter') {
    const payload=Object.hasOwn(data,'value')?data.value:data;
    if(payload?.schema_version!==1||payload.scope!=='exact_category_type_level_instances'||payload.complete!==true||payload.write_authorization!=='not_granted'||
      !Array.isArray(payload.items)||payload.items.length>50||!Number.isSafeInteger(payload.total)||payload.total!==payload.items.length||
      payload.items.some(item=>!item||typeof item.element_id!=='string'||typeof item.unique_id!=='string'||typeof item.parameter_id!=='string'||typeof item.has_value!=='boolean'||!Object.hasOwn(item,'value_internal'))){
      view.status='结果待核对';view.error='参数筛选预览不完整，请核对原回执。';return view;
    }
    const raw=value=>value===null?'null':value===undefined?'未知':value===''?'空字符串（""）':String(value);
    view.columns=['构件 ID','UniqueId','参数 ID','原始内部值','存储类型','数据类型'];
    view.rows=payload.items.map(item=>[item.element_id,item.unique_id,item.parameter_id,item.has_value?raw(item.value_internal):'无值',raw(item.storage_type),raw(item.data_type)]);
    view.summary='完整匹配 '+payload.total+' 个实例；本次只读，不授予写入权限。';
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
      view.rows = Object.entries(payload).slice(0,40).map(([key,value]) => [key,typeof value === 'object' && value !== null ? JSON.stringify(value) : formatDisplayValue(value,key)]);
    } else view.rows = [['返回值',typeof payload === 'object' ? JSON.stringify(payload) : text(payload)]];
  }
  if (!view.rows.length && !['revit_preview_batch_parameter_filter','revit_preview_project_parameter_binding'].includes(command.commandId)) view.summary = command.commandId === 'selection' ? '当前没有选择构件' : command.commandId === 'levels' ? '没有标高' : '没有匹配的构件';
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
  return modelToolEntries(catalog).map(tool => ({name:tool.name, label:typeof tool.label === 'string' ? tool.label.slice(0,160) : tool.name,
    description:typeof tool.description === 'string' ? tool.description.slice(0,240) : '', readOnly:tool.readOnly === true}));
}

// One matcher for the registered tool name, operation initials and label.
export function modelToolMatchScore(tool, query) {
    const needle = String(query ?? '').toLocaleLowerCase();
    const name = String(tool.name ?? '').toLocaleLowerCase(), label = String(tool.label ?? '').toLocaleLowerCase();
    const operation = name.replace(/^revit_/, '');
    const tokens = operation.split(/[^a-z0-9]+/).filter(Boolean);
    const initials = tokens.map(token => token[0]).join('');
    let score = Infinity;
    if (!needle) score = 0;
    else if (name === needle || operation === needle || label === needle) score = 0;
    else if (operation.startsWith(needle) || name.startsWith(needle) || label.startsWith(needle)) score = 1;
    else if (initials.startsWith(needle)) score = 2;
    else if (tokens.some(token => token.startsWith(needle))) score = 3;
    else if (name.includes(needle) || label.includes(needle)) score = 4;
    return score;
}
// Rank the current registered catalog; names are never hard-coded here.
export function modelMentionMatches(catalog, query) {
  return catalog.map((tool,index) => {
    const score = modelToolMatchScore(tool, query);
    return {tool,index,score};
  }).filter(item => Number.isFinite(item.score)).sort((a,b) => a.score-b.score || a.index-b.index).map(item => item.tool);
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
  let nav, chatTab, commandTab, knowledgeTab, skillsTab, knowledgePanel, skillsPage, commandList, accountButton, drawer, overlay, picker, hint, controls;
  let permissionBar,permissionSelect,permissionPlaceholder,permissionAutomatic,permissionScope,permissionDetails,permissionSafety,permissionRefresh;
  let accessOptions,accessScope,accessStatus,accessConfirm,accessConfirmText,accessConfirmApply,accessMenu,accessMenuLabel,accessReview=null,accessReviewNotice='';
  const accessButtons=new Map();
  let modelReceiptPanel,modelReceiptDetails,modelReceiptTitle,modelReceiptState,modelReceiptDescription,modelReceiptStatus,modelReceiptNext,modelReceiptFailure,modelReceiptRaw,modelReceiptEvidence,modelReceiptCheck,modelReceiptAcknowledge,modelReceiptRecover,modelReceiptNotice,modelReceiptOpen,modelReceiptBinding=null;
  let terminalToggle,terminalHint,terminalPanel,terminalState,terminalMeta,terminalNotice,terminalStop,terminalCheck,terminalContent,terminalRequestId=null;
  let historyButton, historyPanel, historyList, historyNotice, historyText, historyContinue, historySignature = '';
  let mention = null, matches = [], selected = 0, composing = false, drawerOpen = false, drawerBody, drawerClose, drawerReturnFocus, drawerTitle;
  let accountMenu, accountMenuOpen = false, menuEmail, menuState, menuLogin, menuRegister, menuManage, menuSignOut;
  let commandCatalogSignature = '', commandSearch, commandItems,createArea,createCommand,createCommandKind,createCommandHelp;
  const commandFavorites = new Set();
  const personalVersions = new Map();
  let commandScope = 'all', personalPage = null, personalPageSignature = '';
  let personalWorkflow = null, nextPersonalPage;
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
  const validAccessPolicy=policy=>policy?.available===true&&['read-only','project-write','full-access'].includes(policy.mode)&&Number.isSafeInteger(policy.revision)&&Array.isArray(policy.roots);
  const accessText=()=>{
    const policy=snapshot?.accessPolicy;
    return validAccessPolicy(policy)?(policy.mode==='full-access'?'本机文件可读写':policy.mode==='project-write'?(snapshot?.confirmedWrite?'项目模型可申请写入：':'项目目录可读写：')+policy.roots.map(root=>root?.path??root).join('；'):'文件与模型只读'):(snapshot?.accessPolicyMessage||'访问范围尚未核实。');
  };
  function renderAccessStatus(){
    if(!active||!accessStatus)return;
    const value=snapshot,policy=value.accessPolicy,currentText=accessText();
    const modes={'read-only':'只读','project-write':'项目读写','full-access':'完全访问'};
    const reviewText=accessReview&&validAccessPolicy(policy)?'当前仍为'+modes[policy.mode]+'，待确认'+modes[accessReview.mode]+'；请在确认卡点击“'+(accessReview.mode==='full-access'?'启用完全访问':'授权此工作区')+'”。':null;
    const currentStatus=value.accessPolicyMessage||currentText+(policy?.modelWritable===false?'；Revit：'+(policy.modelMessage||'当前模型编辑尚未启用。'):policy?.modelWritable===true?'；Revit：当前模型可编辑。':'');
    const scopeText=reviewText||accessReviewNotice&&accessReviewNotice+'；'+currentText||currentText;
    accessScope.textContent=scopeText;accessOptions.title=scopeText;
    accessStatus.hidden=!validAccessPolicy(policy)&&!value.accessPolicyMessage&&!accessReviewNotice;
    accessStatus.textContent=value.accessPolicyPending?'正在更新访问范围…':reviewText||accessReviewNotice&&accessReviewNotice+'；'+currentStatus||currentStatus;
  }
  function clearAccessReview({invalidated=false}={}){accessReview=null;accessReviewNotice=invalidated?'状态已变化，权限未修改，请重新选择':'';if(accessConfirm)accessConfirm.hidden=true;renderAccessStatus();}
  function reviewAccess(detail){
    if(!canChangeAccess()||!['read-only','project-write','full-access'].includes(detail?.mode)||snapshot.confirmedWrite===true&&detail.mode==='full-access')return;
    clearAccessReview();
    if(detail.mode==='read-only'){window.dispatchEvent(new CustomEvent('buildx-access-policy-select',{detail:{mode:'read-only',confirmed:true}}));return;}
    if(detail.mode==='project-write'&&(typeof detail.rootId!=='string'||!detail.rootId)){switchView('knowledge');return;}
    if(detail.mode==='project-write'&&(typeof detail.path!=='string'||!detail.path||detail.path.length>32768||/[\u0000-\u001f\u007f]/.test(detail.path)))return;
    accessReview={mode:detail.mode,...detail.mode==='project-write'?{rootId:detail.rootId}:{},binding:accessBinding()};
    accessConfirmText.textContent=(detail.mode==='full-access'?'允许 BuildX 读取和编辑当前 Windows 账号可访问的本机文件，并编辑当前 Revit 模型。此范围不限于资料库，资料库仍用于选择参考内容。':(snapshot.confirmedWrite?'允许 BuildX 读取以下目录，并对其中打开的 Revit 模型申请逐次确认写入：':'允许 BuildX 读取和编辑以下目录及子目录中的文件，并编辑其中当前打开的 Revit 模型：')+detail.path)+' 此选择会记住，可随时切换为只读。';
    accessConfirmApply.textContent=detail.mode==='full-access'?'启用完全访问':'授权此工作区';
    switchView('chat');accessConfirm.hidden=false;renderAccessStatus();accessConfirm.scrollIntoView({block:'nearest'});accessConfirm.focus();
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
    const composerActions=document.querySelector('.composer-actions');
    if(composerActions)composerActions.insertBefore(get('stop'),get('send'));
    currentView = 'chat'; active = false; closePicker(); drawerOpen = false; showAccountMenu(false,false);
    document.body.classList.remove('model-workspace'); delete document.body.dataset.modelView;
    nav.hidden = true; if(permissionBar)permissionBar.hidden=true;if(accessConfirm)accessConfirm.hidden=true;if(accessStatus)accessStatus.hidden=true;if(accessReview)accessReviewNotice='状态已变化，权限未修改，请重新选择';accessReview=null;clearReceiptDisplay();renderTerminal(null);showDrawer(false); controls.hidden = true; commandList.hidden = true; knowledgePanel.hidden=true; skillsPage.hidden=true;if(chatDraftNotice)chatDraftNotice.hidden=true;
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
    const composerActions=document.querySelector('.composer-actions');
    if(composerActions){
      if(view==='chat')composerActions.insertBefore(get('stop'),get('send'));
      else get('activity').append(get('stop'));
    }
    for(const [tab,name] of [[chatTab,'chat'],[commandTab,'commands'],[skillsTab,'skills'],[knowledgeTab,'knowledge']]){tab.setAttribute('aria-selected',String(view===name));tab.tabIndex=view===name?0:-1;}
    commandList.hidden = view !== 'commands'; knowledgePanel.hidden=view!=='knowledge'; skillsPage.hidden=view!=='skills'; get('welcome').hidden = view !== 'chat' || snapshot?.hasMessages === true;
    renderTerminal(snapshot);
    if(view==='knowledge'&&previousView!=='knowledge')window.dispatchEvent(new CustomEvent('buildx-project-files-opened'));
    if(chatDraftNotice)chatDraftNotice.hidden=view!=='chat' || !chatDraftNotice.textContent;
    closePicker();
    historyPanel.hidden = true; historyButton.setAttribute('aria-expanded','false');
    if (view === 'chat') prompt.focus();
  }
  function dispatchTerminal(action,extra){
    if(active&&snapshot?.commandConversationId)window.dispatchEvent(new CustomEvent('buildx-terminal-action',{detail:{action,conversationId:snapshot.commandConversationId,...extra}}));
  }
  function mountTerminal(){
    terminalToggle=button('model-access-choice model-terminal-toggle','本机终端');
    terminalToggle.id='model-terminal-toggle';terminalToggle.hidden=true;
    terminalToggle.setAttribute('aria-label','本机终端');
    terminalToggle.setAttribute('aria-describedby','model-terminal-hint');
    terminalToggle.setAttribute('aria-pressed','false');
    terminalToggle.addEventListener('click',()=>{if(!terminalToggle.hidden&&!terminalToggle.disabled)dispatchTerminal('enable',{enabled:!snapshot.terminal.enabled});});
    terminalHint=el('span','model-terminal-hint');terminalHint.id='model-terminal-hint';terminalHint.hidden=true;terminalHint.setAttribute('role','status');
    permissionBar.append(terminalToggle,terminalHint);
    terminalPanel=el('details','model-terminal-panel');terminalPanel.id='model-terminal-panel';terminalPanel.hidden=true;terminalPanel.setAttribute('aria-label','本机终端执行回执');
    const heading=el('summary','model-terminal-heading','本机终端');
    terminalState=el('span','model-terminal-state');terminalState.id='model-terminal-state';terminalState.setAttribute('role','status');heading.append(terminalState);
    terminalMeta=el('p','model-terminal-meta');terminalMeta.id='model-terminal-meta';
    terminalContent=new Map();
    const body=el('div','model-terminal-body');body.append(terminalMeta);
    for(const [field,title] of [['script','执行内容'],['stdout','标准输出'],['stderr','错误输出']]){
      const label=el('h3','model-terminal-label',title),content=el('pre','model-terminal-content');
      label.id='model-terminal-'+field+'-label';content.id='model-terminal-'+field;
      content.setAttribute('aria-labelledby',label.id);content.tabIndex=0;
      terminalContent.set(field,{label,content,title});body.append(label,content);
    }
    terminalNotice=el('p','model-terminal-notice');terminalNotice.id='model-terminal-notice';terminalNotice.setAttribute('role','status');
    terminalStop=button('model-terminal-stop','请求停止');terminalStop.id='model-terminal-stop';
    terminalCheck=button('model-terminal-check','核查原请求');terminalCheck.id='model-terminal-check';
    terminalStop.addEventListener('click',()=>{if(!terminalPanel.hidden&&!terminalStop.disabled)dispatchTerminal('cancel',{requestId:terminalRequestId});});
    terminalCheck.addEventListener('click',()=>{if(!terminalPanel.hidden&&!terminalCheck.disabled)dispatchTerminal('status',{requestId:terminalRequestId});});
    const actions=el('div','model-terminal-actions');actions.append(terminalStop,terminalCheck);
    body.append(terminalNotice,actions);terminalPanel.append(heading,body);
    get('transcript').after(terminalPanel);
  }
  function renderTerminal(value){
    if(!terminalPanel)return;
    const terminal=value?.terminal,job=terminal?.job,action=value?.terminalPendingAction;
    const canContact=Boolean(value?.commandConversationId)&&(value.account?.required!==true||value.account.signedIn===true);
    const safety='脚本在独立工作目录运行，文件改动不参加 Revit 回滚。';
    terminalToggle.hidden=!terminal;
    terminalToggle.disabled=!canContact||terminal?.available!==true||value.ready!==true||value.terminalStale||value.busy||value.blocked||value.accessPolicyPending||value.readOnly||Boolean(action)||!terminal.enabled&&!terminal.eligible;
    terminalToggle.setAttribute('aria-pressed',String(terminal?.enabled===true));
    terminalToggle.textContent=terminal?.available!==true?'终端不可用':terminal.enabled?'终端已启用':'启用终端';
    terminalHint.textContent=value?.terminalStale?'终端状态待核查。':action==='enable'?'正在更新终端开关…':!job&&value?.terminalMessage?value.terminalMessage:terminal?.reason||(terminal?.eligible?safety:'完全访问和自动应用下可启用终端。');
    terminalHint.hidden=terminalToggle.hidden;
    terminalPanel.hidden=!job||currentView!=='chat';
    if(!job){
      terminalPanel.open=false;terminalRequestId=null;
      for(const field of [terminalState,terminalMeta,terminalNotice,...[...terminalContent.values()].map(item=>item.content)])field.textContent='';
      return;
    }
    if(terminalRequestId!==job.requestId){
      const follow=!terminalPanel.hidden&&messages.scrollHeight-messages.scrollTop-messages.clientHeight<88;
      terminalRequestId=job.requestId;terminalPanel.open=true;
      if(follow)messages.scrollTop=messages.scrollHeight;
    }
    const interpreter=job.interpreter==='powershell'?'PowerShell':'Python';
    const outcomes={completed:'执行完成',failed:'执行失败',cancelled:'已取消',timed_out:'已超时'};
    const states={starting:'正在启动',running:'正在运行',stop_requested:(job.stopReason==='timed_out'?'已超时，':'')+'已请求停止，退出待核实',not_started:'进程未启动',unconfirmed:'结果待核查'};
    const state=job.status==='exited'?(job.exitConfirmed?'已确认退出'+(outcomes[job.outcome]?' · '+outcomes[job.outcome]:''):'退出待核实'):states[job.status];
    const meta=interpreter+' · 退出码 '+(job.exitCode??'未核实')+'\n工作目录 '+job.cwd+'\n请求 ID '+job.requestId;
    const stateText=value.terminalStale?state+'（上次状态）':state;
    if(terminalState.textContent!==stateText)terminalState.textContent=stateText;
    if(terminalMeta.textContent!==meta)terminalMeta.textContent=meta;
    for(const [field,{label,content,title}] of terminalContent){
      const heading=title+(job[field+'Truncated']?' · 已截断':'');
      if(label.textContent!==heading)label.textContent=heading;
      if(content.textContent!==job[field])content.textContent=job[field];
    }
    terminalNotice.textContent=value.terminalMessage||(action==='cancel'?'正在提交停止请求…':action==='status'?'正在核查原请求…':value.terminalStale?'上次收到的状态。请核查原请求。':job.message||safety);
    terminalStop.disabled=!canContact||Boolean(action)||!['starting','running'].includes(job.status);
    terminalCheck.disabled=!canContact||Boolean(action);
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
  function renderPicker(scrollSelected = false) {
    if (!picker || !active || composing || currentView !== 'chat' || snapshot?.readOnly) return closePicker();
    mention = modelMentionQuery(prompt.value,prompt.selectionStart);
    if (!mention) return closePicker();
    const query = mention.query.toLocaleLowerCase();
    matches = modelMentionMatches(catalog, query);
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
    if (scrollSelected) picker.querySelectorAll('.model-tool-option')[selected]?.scrollIntoView?.({block:'nearest'});
  }
  function commandNeedsConfirmation(command,inputs){
    if(command.tool==='revit_set_type_parameter'&&command.requiresTypeParameterReview===true)return false;
    if(command.readOnly!==false)return false;
    if(snapshot?.confirmedWrite===true)return true;
    const grant=snapshot?.modelPermission,mode=inputs?.mode?.value||command.inputSchema?.properties?.mode?.default||'rollback';
    const currentGrant=snapshot?.ready===true&&grant?.available===true&&['rollback','confirm','automatic'].includes(grant.level)&&grant.conversationId===snapshot.commandConversationId&&(grant.expiresAt===null||Number.isSafeInteger(grant.expiresAt)&&grant.expiresAt>Date.now());
    const coveredFull=snapshot?.accessPolicy?.available===true&&snapshot.accessPolicy.mode==='full-access'&&['revit_execute_csharp','revit_save_command','revit_run_command'].includes(command.tool);
    return !(currentGrant&&(command.effectKind==='model_transaction'||coveredFull)&&(grant.level==='automatic'||mode!=='commit'));
  }
  function renderCommandConfirmation(row){if(row.confirmLabel)row.confirmLabel.hidden=!commandNeedsConfirmation(row.command,row.inputs);}
  function applyCommand(command, inputs, error) {
    if (!active || !snapshot?.directCommandsAvailable || !(snapshot.commandsReady ?? snapshot.ready) || command.enabled === false || command.manualExecution===false || snapshot.blocked || snapshot.busy || snapshot.modelPermissionPending || snapshot.readOnly || snapshot.persistence?.status === 'failed') return;
    const form=rows.find(row=>row.id===command.id),sources=[],typeWriteField=form?.fields?.find(field=>typeof field.parameters==='function');
    for(const field of form?.fields || []){
      const check=field.validate?.();
      if(check?.ok===false){error.textContent=check.error;error.hidden=false;field.input.focus();return;}
      const source=field.sourceDocument?.();if(source)sources.push(source);
    }
    if(sources.some(source=>JSON.stringify(source)!==JSON.stringify(sources[0]))){error.textContent='所选内容来自不同模型，请重新读取后选择。';error.hidden=false;return;}
    const values = command.inputSchema ? Object.fromEntries(Object.entries(inputs || {}).filter(([key]) => key !== '$confirmation').map(([key,input]) => [key,input.type === 'checkbox' ? input.checked : input.value])) : inputs ? {keyword:inputs.keyword.value, category:inputs.category.value} : {};
    const result = typeWriteField?{ok:true,parameters:typeWriteField.parameters()}:command.inputSchema ? modelSchemaParameters(command,values) : modelCommandParameters(command.id,values);
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
    const confirmed=Boolean(typeWriteField)||inputs?.$confirmation?.checked===true;
    if (inputs?.$confirmation) inputs.$confirmation.checked = false;
    typeWriteField?.lock();
    if (command.id === 'revit_get_command') {
      const identity = storedCommandIdentity(result.parameters);
      if (identity) viewPersonalVersion(identity);
      return;
    }
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
    for (const command of [...commands].sort((a,b)=>Number(b.group==='命令库')-Number(a.group==='命令库'))) {
      const group = command.group || '常用命令';
      if (!groups.has(group)) { const section=el('section','model-command-group'); section.append(el('h3','model-command-group-title',group==='命令库'?'我的命令':group)); groups.set(group,section); commandItems.append(section); }
      const item = el('section','model-command-item'), row = el('div','model-command-row');
      item.dataset.commandId = command.id;item.dataset.personalGroup=String(group==='命令库');item.dataset.toolName=command.tool || '';item.dataset.toolLabel=command.name || '';item.dataset.search=[command.name,command.tool,command.description,group,'系统'].filter(Boolean).join(' ').toLocaleLowerCase();
      const copy = el('span','model-command-copy'); copy.append(commandName(command.name,'system'),el('small','',command.description));
      if (command.readOnly === true) copy.append(el('small','model-command-effect','只读查询，不修改模型'));
      if (command.readOnly === false) copy.append(el('small','model-command-effect',['revit_set_selection','revit_select_by_unique_ids'].includes(command.tool)?'更改 Revit 界面选择，不修改模型':'涉及模型或文件操作'));
      if (command.enabled === false) copy.append(el('small','model-command-unavailable',command.unavailableReason || '当前环境尚未就绪'));
      if(command.manualExecution===false||command.tool==='revit_set_type_parameter'&&command.requiresTypeParameterReview!==true){
        copy.append(el('small','model-command-unavailable',command.manualUnavailableReason||'请在对话中发起，逐项审阅类型影响并确认本次操作。'));
        row.append(el('span','model-command-icon',command.icon||'◇'),copy);item.append(row);groups.get(group).append(item);
        continue;
      }
      const favorite=button('model-command-favorite',commandFavorites.has(command.id)?'取消会话收藏':'会话收藏');favorite.dataset.favoriteKey=command.id;favorite.setAttribute('aria-pressed',String(commandFavorites.has(command.id)));
      favorite.addEventListener('click',()=>{
        if (!active || !commandItems.contains(item)) return;
        if (commandFavorites.has(command.id)) commandFavorites.delete(command.id);
        else commandFavorites.add(command.id);
        favorite.textContent = commandFavorites.has(command.id) ? '取消会话收藏' : '会话收藏';
        favorite.setAttribute('aria-pressed',String(commandFavorites.has(command.id)));
        filterCommands();
      });
      copy.append(favorite);
      const manualTypeWrite=command.tool==='revit_set_type_parameter'&&command.requiresTypeParameterReview===true;
      const isPersonalList = command.tool === 'revit_list_commands';
      const fields = manualTypeWrite||isPersonalList?[]:command.inputSchema ? Object.entries(command.inputSchema.properties || {}).filter(([key]) => key !== 'expected_document').sort(([a],[b])=>Number(a==='mode')-Number(b==='mode')) : command.parameters ? [['keyword',{type:'string',maxLength:200}],['category',{type:'string',enum:MODEL_CATEGORIES.map(item => item.value),default:'all'}]] : [];
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
      if(manualTypeWrite){
        const field=createManualTypeParameterWriteField({document,Event,id:'model-command-'+command.id+'-type-write',schema:command.inputSchema,onCommand,onChange:invalidate,
          onSubmit:()=>applyCommand(command,inputs,error)});
        inputs.$typeWrite=field.input;formFields.push(field);parameters.append(field.element);
        for(const control of field.controls){control.dataset.commandEnabled=String(command.enabled!==false);parameterInputs.push(control);}
      }
      for (const [key,rule] of fields) {
        const id=command.id === 'search' && ['keyword','category'].includes(key) ? 'model-command-'+key : 'model-command-'+command.id+'-'+key;
        let label=COMMAND_PARAMETER_LABELS[key] || key;
        if(key==='parameters'&&command.tool==='revit_run_command')label='参数值';
        if(key==='titleblock_id'&&command.tool==='revit_create_sheet')label='图框类型 ID';
        if(key==='template_id'&&command.tool==='revit_apply_view_template')label='视图样板 ID';
        if(command.tool==='revit_create_section_view'){
          if(key==='origin_mm')label='切面底边中心（mm）';
          if(key==='angle_degrees')label='剖切朝向（°）';
          if(key==='depth_mm')label='远裁剪距离（mm）';
        }
        const options={document,Event,id,key,rule,label,required:required.has(key),value:draft?.values[key],multiline:command.tool==='revit_create_text_note'&&key==='text',onChange:invalidate,onCommand};
        const field=command.tool==='revit_batch_create_sheets_from_csv' && key==='sheets'?createSheetBatchField(options):command.tool==='revit_populate_titleblock' && key==='changes'?createParameterChangeField({...options,maxChanges:5,exactIds:true}):command.tool==='revit_renumber_sheets' && key==='sheets'?createSheetRenumberField(options):command.tool==='revit_set_parameters' && key==='changes'?createParameterChangeField(options):command.tool==='revit_set_parameter_value' && key==='changes'?createParameterChangeField({...options,maxChanges:1,exactIds:true}):command.tool==='revit_run_command' && key==='parameters'?createPersonalCommandFields(options):
          command.tool!=='revit_set_selection'&&(rule.type==='integer'||rule.type==='array'&&rule.items?.type==='integer')&&createCommandChoiceField(options)||createCommandField(options);
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
      if(command.readOnly === false&&!manualTypeWrite){confirmLabel=el('label','model-command-confirm');const confirm=el('input');confirm.type='checkbox';confirm.dataset.commandEnabled=String(command.enabled !== false);confirm.checked=false;for(const input of Object.values(inputs))for(const event of ['input','change'])input.addEventListener(event,()=>{confirm.checked=false;renderCommandConfirmation({command,inputs,confirmLabel});});inputs.$confirmation=confirm;parameterInputs.push(confirm);const confirmationText=['revit_set_selection','revit_select_by_unique_ids'].includes(command.tool)?'我已核对本次选择；界面选择不可通过模型回滚':command.tool==='revit_ungroup'?'我已核对模型组 ID，确认解散该组并保留可核验成员':command.tool==='revit_save_command'?'我已核对草稿内容，确认保存本地版本':command.tool==='revit_family_create_cabinet'?'我已核对尺寸，确认创建独立临时柜体族；不保存或加载项目':command.tool==='revit_family_save_cabinet'?'我已核对作业，确认保存为新 RFA、关闭原临时族并重新打开复核':command.tool==='revit_family_close_cabinet'?'我已核对作业，确认关闭临时柜体族并丢弃未保存内容':'我已核对本次参数和执行方式';confirmLabel.append(confirm,el('span','',confirmationText));parameters.append(confirmLabel);}
      if(hasParameters){
        apply.setAttribute('aria-expanded',String(Boolean(draft?.open)));apply.setAttribute('aria-controls',parameters.id);parameters.hidden=!draft?.open;
        const run=manualTypeWrite?null:button('model-command-run',command.tool === 'revit_save_command' ? '保存版本' : command.readOnly === false ? '执行' : '查询');
        if(run){run.dataset.commandEnabled=String(command.enabled !== false);run.addEventListener('click',()=>applyCommand(command,inputs,error));
          if(inputs.mode){const renderRun=()=>{run.textContent=inputs.mode.value==='commit'?'应用修改':'预览结果';};inputs.mode.addEventListener('change',renderRun);renderRun();}
          parameters.append(run);commandButtons.push(run);}
        parameters.append(error);item.append(parameters);rows.push({id:command.id,item,parameters,apply,inputs,fields:formFields,command,confirmLabel});
        apply.addEventListener('click',()=>{parameters.hidden=!parameters.hidden;apply.textContent=parameters.hidden?'展开':'收起';apply.setAttribute('aria-expanded',String(!parameters.hidden));if(!parameters.hidden)Object.values(inputs)[0]?.focus();});
        if(inputs.keyword)inputs.keyword.addEventListener('keydown',event=>{if(event.key === 'Enter' && !event.isComposing){event.preventDefault();applyCommand(command,inputs,error);}});
      }else{
        item.append(error);
        if (isPersonalList) {
          apply.textContent = '读取列表';
          apply.setAttribute('aria-label','读取个人命令列表');
          apply.addEventListener('click',()=>requestPersonalPage());
        } else apply.addEventListener('click',()=>applyCommand(command,null,error));
      }
      const result=el('div','model-command-result');result.hidden=true;result.setAttribute('role','status');result.setAttribute('aria-live','polite');item.append(result);
      const list = isPersonalList ? el('div','model-command-result model-command-personal-list') : null;
      if (list) item.append(list);
      let back = null;
      if (['revit_get_command','revit_run_command'].includes(command.id)) {
        item.tabIndex = -1;
        back = button('model-command-back','返回命令列表');
        back.hidden = true;
        back.addEventListener('click',()=>{
          if (personalWorkflow?.rowId !== command.id) return;
          personalWorkflow = null;
          filterCommands();
          commandSearch.focus();
        });
        item.append(back);
      }
      resultRows.push({id:command.id,result,stop,inspect,recover,acknowledge,signature:'',list,listPage:null,apply,back});commandButtons.push(apply);groups.get(group).append(item);
    }
    groups.get('命令库')?.after(nextPersonalPage);
    filterCommands();
  }
  function filterCommands() {
    const query=(commandSearch?.value || '').trim().toLocaleLowerCase();
    for (const row of resultRows) if (row.back) row.back.hidden = personalWorkflow?.rowId !== row.id;
    let matches = 0;
    for (const item of commandItems.querySelectorAll('.model-command-item')) {
      const id = item.dataset.commandId;
      const form = rows.find(row=>row.id===id);
      const command = snapshot?.commands?.find(value=>value.commandId===id);
      const detail = ['revit_save_command','revit_get_command','revit_run_command'].includes(id);
      const relevant = !detail || Boolean(form && !form.parameters.hidden) || Boolean(command);
      const inScope = commandScope === 'all' || (commandScope === 'personal'
        ? item.dataset.personalGroup === 'true' : commandFavorites.has(id));
      const systemMatch = inScope && (query
        ? item.dataset.search.includes(query) || Number.isFinite(modelToolMatchScore({name:item.dataset.toolName,label:item.dataset.toolLabel},query))
        : relevant);
      let cardMatch = false;
      for (const card of item.querySelectorAll('.model-command-stored-version')) {
        card.hidden = (commandScope === 'favorites' && !commandFavorites.has(card.dataset.favoriteKey)) || !card.dataset.search.includes(query);
        if (!card.hidden) cardMatch = true;
      }
      const inWorkflow = personalWorkflow?.rowId === id;
      const hasOriginalReceipt = id === 'revit_run_command' && command?.canInspectReceipt === true;
      const hasListStatus = id === 'revit_list_commands' && command && command.status !== 'completed';
      const matched = systemMatch || cardMatch;
      if (matched) matches++;
      item.hidden = !matched && !inWorkflow && !hasOriginalReceipt && !hasListStatus;
    }
    for(const group of commandItems.querySelectorAll('.model-command-group')) group.hidden=[...group.querySelectorAll('.model-command-item')].every(item=>item.hidden);
    const canReadList = commandSupported('revit_list_commands');
    nextPersonalPage.hidden = !canReadList || !personalPage?.hasMore;
    nextPersonalPage.disabled = !commandActionAvailable('revit_list_commands');
    const empty=get('model-command-empty');
    empty.hidden = !(query || commandScope !== 'all') || matches > 0 || Boolean(personalWorkflow);
    get('model-command-empty-text').textContent = commandScope === 'favorites' ? '当前没有匹配的会话收藏。'
      : !canReadList ? '没有匹配的命令。'
      : !personalPage ? '没有匹配项，个人命令尚未读取。'
      : personalPage.hasMore ? '已读取的命令没有匹配项。可加载下一页继续查找。'
      : '已读取的命令没有匹配项。';
    const load = get('model-command-load-personal');
    load.hidden = !canReadList || Boolean(personalPage);
    load.disabled = !commandActionAvailable('revit_list_commands');
  }
  function renderCommandCreation(value=snapshot){
    createArea.hidden=value?.confirmedWrite===true;
    const kind=createCommandKind.value,disabled=!value||createArea.hidden||value.blocked||value.busy||value.persistence?.status==='failed'||get('new-chat').disabled;
    createCommandKind.disabled=Boolean(disabled);createCommand.disabled=Boolean(disabled||!['csharp','sequence'].includes(kind));
    createCommandHelp.textContent=kind==='sequence'?'串联现有只读查询，生成可复用的步骤命令。':kind==='csharp'?'用日常语言描述需求，生成可复用的 C# 命令。':'该类型暂未接入，请选择 C# 命令或只读步骤命令。';
  }
  function commandSupported(id) {
    return commandCatalog.some(item=>item.id===id && item.enabled!==false && item.manualExecution!==false);
  }
  function commandActionAvailable(id) {
    return active && snapshot?.directCommandsAvailable && (snapshot.commandsReady ?? snapshot.ready) && !snapshot.blocked && !snapshot.busy && !snapshot.modelPermissionPending && !snapshot.readOnly && snapshot.persistence?.status !== 'failed' && commandSupported(id);
  }
  function requestPersonalPage(next = false) {
    if (!commandActionAvailable('revit_list_commands') || (next && !personalPage?.hasMore)) return;
    const parameters = next ? {offset:personalPage.nextOffset,limit:personalPage.limit} : {offset:0,limit:100};
    window.dispatchEvent(new CustomEvent('buildx-model-command',{detail:{commandId:'revit_list_commands',parameters}}));
  }
  function resetPersonalRunForm() {
    const target = rows.find(row=>row.id==='revit_run_command');
    if (!target) return;
    for (const key of ['command_id','revision','parameters']) {
      if (target.inputs[key]) target.inputs[key].value = '';
    }
    target.fields.find(field=>typeof field.setDefinition==='function')?.setDefinition(null);
    if (target.inputs.mode) {
      target.inputs.mode.value = target.inputs.mode.dataset.defaultValue || 'rollback';
      target.inputs.mode.dispatchEvent(new Event('change'));
    }
    if (target.inputs.$confirmation) target.inputs.$confirmation.checked = false;
    target.parameters.hidden = true;
    target.apply.textContent = '展开';
    target.apply.setAttribute('aria-expanded','false');
    const error = target.parameters.querySelectorAll('.model-command-error')[0];
    error.hidden = true;
    error.textContent = '';
  }
  function viewPersonalVersion(identity) {
    if (!commandActionAvailable('revit_get_command')) return;
    resetPersonalRunForm();
    const detail = snapshot.commands?.find(command=>command.commandId==='revit_get_command');
    personalWorkflow = {rowId:'revit_get_command',identity,previousExecutionId:detail?.executionId};
    window.dispatchEvent(new CustomEvent('buildx-model-command',{detail:{commandId:'revit_get_command',parameters:identity}}));
    filterCommands();
    const row = rows.find(value=>value.id==='revit_get_command');
    row?.item.scrollIntoView({block:'nearest'});
    row?.item.focus();
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
  function acceptPersonalPage(command) {
    if (command?.status !== 'completed' || command.conversationId !== snapshot.commandConversationId) return false;
    const payload = command.result?.data?.value ?? command.result?.data;
    if (!payload || !Array.isArray(payload.commands) || !Number.isSafeInteger(payload.total) || payload.total < 0 ||
        !Number.isSafeInteger(payload.offset) || payload.offset < 0 || !Number.isSafeInteger(payload.limit) ||
        payload.limit < 1 || payload.limit > 100 || payload.commands.length > payload.limit ||
        !Number.isSafeInteger(payload.offset + payload.limit) || typeof payload.has_more !== 'boolean') return false;
    const signature = JSON.stringify([command.executionId,payload]);
    if (signature === personalPageSignature) return true;
    personalPageSignature = signature;
    if (payload.offset === 0) personalVersions.clear();
    let invalid = payload.offset === 0 ? 0 : personalPage?.invalid ?? 0;
    for (const record of payload.commands) {
      const identity = storedCommandIdentity(record);
      if (!identity) {
        invalid++;
        continue;
      }
      const key = 'personal:'+identity.command_id+':'+identity.revision;
      personalVersions.set(key,{record,identity});
    }
    personalPage = {total:payload.total,limit:payload.limit,nextOffset:payload.offset+payload.limit,hasMore:payload.has_more,invalid};
    return true;
  }
  function renderPersonalList(row) {
    const page = personalPage;
    row.apply.textContent = page ? '刷新列表' : '读取列表';
    row.apply.setAttribute('aria-label',page ? '刷新个人命令列表' : '读取个人命令列表');
    if (row.listPage !== page) {
      row.listPage = page;
      row.list.replaceChildren();
      if (page) {
        row.list.append(el('p','model-command-result-summary','已保存版本：已读取 '+personalVersions.size+' 项，共 '+page.total+' 项'+
          (page.hasMore?'。还有后续页，搜索仅覆盖已读取的版本。':'。')));
        if (page.invalid) row.list.append(el('p','model-command-result-error','某项版本身份无效，无法选择。'));
        // The repository returns each page newest first. Map preserves that
        // order across pages and keeps each exact revision only once.
        for (const [key,{record,identity}] of personalVersions) {
          const item = el('div','model-command-stored-version');
          item.dataset.favoriteKey = key;
          item.dataset.search = [record.name,record.description,identity.command_id,'个人'].filter(value=>typeof value==='string').join(' ').toLocaleLowerCase();
          item.append(commandName(typeof record.name==='string'?record.name:identity.command_id,'personal'));
          item.append(el('p','model-command-effect',record.schema_version===3?'只读步骤命令（执行前仍核对当前模型）':'可能修改模型或文件，请在执行前核对准确版本。'));
          if (typeof record.description==='string') item.append(el('p','',record.description));
          const version = el('details','model-command-version-detail');
          version.append(el('summary','','版本信息'),el('p','',identity.command_id+' · '+identity.revision));
          item.append(version);
          const evidence = record.verification?.status==='source_execution_succeeded'?'有历史执行记录（不代表当前模型已验证）':record.verification?.status==='unverified'?'未记录成功执行证据':'执行证据状态未知';
          item.append(el('p','',evidence));
          const actions = el('div','model-command-version-actions');
          const inspect = button('model-command-version-view','查看命令');
          inspect.addEventListener('click',()=>{
            if (resultRows.includes(row) && row.list.contains(item)) viewPersonalVersion(identity);
          });
          const favorite = button('model-personal-favorite',commandFavorites.has(key)?'取消会话收藏':'会话收藏');
          favorite.setAttribute('aria-pressed',String(commandFavorites.has(key)));
          favorite.addEventListener('click',()=>{
            if (!active || !resultRows.includes(row) || !row.list.contains(item)) return;
            if (commandFavorites.has(key)) commandFavorites.delete(key);
            else commandFavorites.add(key);
            favorite.textContent = commandFavorites.has(key) ? '取消会话收藏' : '会话收藏';
            favorite.setAttribute('aria-pressed',String(commandFavorites.has(key)));
            filterCommands();
          });
          actions.append(inspect,favorite);
          item.append(actions);
          row.list.append(item);
        }
      }
    }
    for (const inspect of row.list.querySelectorAll('.model-command-version-view')) inspect.disabled = !commandActionAvailable('revit_get_command');
  }
  function renderStoredDetail(row,command) {
    if (row.id !== 'revit_get_command' || command.status !== 'completed') return false;
    const payload = command.result?.data?.value ?? command.result?.data;
    const identity=storedCommandIdentity(payload);if(!identity)return false;
    row.result.append(commandName(typeof payload.name==='string'?payload.name:identity.command_id,'personal','model-personal-name'));
    if(typeof payload.description==='string')row.result.append(el('p','model-personal-description',payload.description));
    const details=el('details','model-command-diagnostics');details.append(el('summary','','查看脚本与版本'),el('pre','model-command-diagnostic-text',typeof payload.code==='string'?payload.code:JSON.stringify(payload.steps,null,2)),el('p','model-command-version-detail',identity.command_id+' · '+identity.revision));row.result.append(details);
    return true;
  }
  function renderCommandResults() {
    for (const row of resultRows) {
      const command = snapshot?.commands?.find(item => item.commandId === row.id), presentation = modelCommandPresentation(command);
      const personalDetail = row.id === 'revit_get_command' && personalWorkflow?.rowId === row.id ? personalWorkflow : null;
      const previousDetail = personalDetail && command?.status === 'completed' &&
        command.executionId === personalDetail.previousExecutionId;
      const signature = JSON.stringify([command ?? null, Boolean(previousDetail), row.id === 'revit_get_command' && commandSupported('revit_run_command')]);
      if (row.list) {
        row.validPage = acceptPersonalPage(command);
        renderPersonalList(row);
      }
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
      if (row.choose) row.choose.disabled = !commandActionAvailable('revit_run_command');
      if (signature === row.signature) continue;
      row.signature = signature; row.choose = null; row.result.replaceChildren(); row.result.hidden = !presentation;
      if (!presentation) continue;
      if (previousDetail) {
        row.result.append(el('p','model-command-result-error','未取得本次查看结果。'));
        continue;
      }
      row.result.dataset.status = command.status;
      const heading = el('div','model-command-result-heading'); heading.append(el('span','',presentation.status));
      if (presentation.document && row.id !== 'document') heading.append(el('small','',presentation.document));
      row.result.append(heading);
      if(command.status==='completed'&&typeof command.executionId==='string')row.result.append(el('p','model-command-completion-stamp','本次已完成 · 请求 '+command.executionId));
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
      const renderedVersions=(row.list && row.validPage) || renderStoredDetail(row,command);
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
        const matchesReview = identity && (!personalDetail ||
          personalDetail.identity.command_id === identity.command_id && personalDetail.identity.revision === identity.revision);
        if(matchesReview) {
          row.result.append(el('p','model-command-result-summary','已读取准确版本。历史执行记录不代表当前适用。'));
        }
        if(matchesReview && commandSupported('revit_run_command')) {
          const choose=button('model-command-version-choose','使用这个命令');
          row.choose = choose;
          choose.disabled = !commandActionAvailable('revit_run_command');
          choose.addEventListener('click',()=>{
            if(!commandActionAvailable('revit_run_command') || row.choose !== choose || !resultRows.includes(row) ||
                snapshot?.commands?.find(value=>value.commandId===row.id)!==command)return;
            const target=rows.find(value=>value.id==='revit_run_command');
            if(!target?.inputs.command_id || !target.inputs.revision)return;
            resetPersonalRunForm();
            target.inputs.command_id.value=identity.command_id;target.inputs.revision.value=identity.revision;
            const personalFields=target.fields.find(field=>typeof field.setDefinition==='function');personalFields?.setDefinition(record);
            personalFields?.element.querySelectorAll('.personal-command-selected')[0]?.append(commandBadge('personal'));
            personalWorkflow = {rowId:'revit_run_command'};
            target.parameters.hidden = false;
            target.apply.textContent = '收起';
            target.apply.setAttribute('aria-expanded','true');
            filterCommands();
            target.item.scrollIntoView({block:'nearest'});
            target.item.focus();
            target.inputs.parameters?.focus();
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
    document.querySelector('.connection').after(nav);
    permissionBar=el('div','model-permission-bar');permissionBar.id='model-permission-bar';
    accessMenu=el('details','model-access-menu');accessMenuLabel=el('summary','model-access-menu-label','访问权限');accessMenuLabel.id='model-access-menu-label';accessMenuLabel.setAttribute('aria-label','选择访问权限');accessMenu.append(accessMenuLabel);
    document.addEventListener('click',event=>{if(accessMenu.open&&!accessMenu.contains(event.target))accessMenu.open=false;});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&accessMenu.open){accessMenu.open=false;accessMenuLabel.focus();}});
    accessOptions=el('fieldset','model-access-options');accessOptions.id='model-access-options';accessOptions.setAttribute('aria-label','访问权限');accessOptions.setAttribute('aria-describedby','model-access-status');accessOptions.disabled=true;accessOptions.tabIndex=-1;
    accessOptions.append(el('legend','sr-only','访问权限'));
    const accessChoices=[
      ['read-only','只读','读取授权范围内的模型和文件'],
      ['project-write','项目范围','在选定项目内申请修改'],
      ['full-access','完全访问','访问当前 Windows 账号可访问的本机文件'],
    ];
    for(const [mode,label,description] of accessChoices){
      const choice=button('model-access-choice');
      choice.append(el('span','model-access-choice-title',label),el('small','model-access-choice-detail',description));
      choice.id='model-access-'+mode;choice.dataset.accessMode=mode;choice.disabled=true;
      choice.setAttribute('aria-pressed','false');
      choice.addEventListener('click',()=>{if(!choice.disabled){accessMenu.open=false;reviewAccess({mode});}});accessButtons.set(mode,choice);accessOptions.append(choice);
    }
    const accessPopover=el('div','model-access-popover');
    accessPopover.append(el('p','model-access-heading','访问权限'),accessOptions);
    accessMenu.append(accessPopover);
    accessScope=el('span','sr-only');accessScope.setAttribute('role','status');
    const permissionLabel=el('label','model-execution-label','执行方式');permissionLabel.setAttribute('for','model-permission-select');
    permissionSelect=el('select','model-permission-select');permissionSelect.id='model-permission-select';permissionSelect.setAttribute('aria-label','执行方式');
    permissionSelect.title='选择回滚预览或应用方式；可访问文件和模型的范围由访问权限决定。';
    for(const [value,label] of [['','请选择执行方式'],['__pending','更新中…'],['rollback','回滚预览'],['confirm','确认后应用'],['automatic','自动应用']]){const option=el('option','',label);option.value=value;if(value==='__pending')option.disabled=true;if(value==='')permissionPlaceholder=option;if(value==='automatic')permissionAutomatic=option;permissionSelect.append(option);}
    permissionSelect.value='';permissionSelect.disabled=true;
    permissionSelect.addEventListener('change',()=>{const level=permissionSelect.value;permissionSelect.value=snapshot?.modelPermission?.level||'';if(active&&!permissionSelect.disabled&&['rollback','confirm','automatic'].includes(level))window.dispatchEvent(new CustomEvent('buildx-model-permission-select',{detail:{level}}));});
    permissionScope=el('span','sr-only','权限尚未核实。');permissionScope.setAttribute('role','status');
    permissionRefresh=button('model-access-choice','刷新服务状态');permissionRefresh.id='model-permission-refresh';permissionRefresh.hidden=true;
    permissionRefresh.title='只读取服务状态，保留待核查的原回执。';
    permissionRefresh.addEventListener('click',()=>{if(active&&!permissionRefresh.hidden&&!permissionRefresh.disabled)window.dispatchEvent(new CustomEvent('buildx-model-permission-refresh'));});
    const execution=el('div','model-execution-row');execution.append(permissionLabel,permissionSelect);
    accessPopover.append(execution,permissionScope);
    permissionBar.append(accessMenu,accessScope,permissionRefresh);
    mountTerminal();
    accessConfirm=el('section','model-access-confirm');accessConfirm.id='model-access-confirm';accessConfirm.hidden=true;accessConfirm.tabIndex=-1;accessConfirm.setAttribute('aria-label','确认访问范围');
    accessConfirmText=el('p','model-access-confirm-text');accessConfirmApply=button('model-access-confirm-apply','授权此范围');accessConfirmApply.id='model-access-confirm-apply';
    const accessCancel=button('model-access-confirm-cancel','取消');accessCancel.id='model-access-confirm-cancel';accessCancel.addEventListener('click',()=>{clearAccessReview();accessMenuLabel.focus();});
    accessConfirmApply.addEventListener('click',()=>{if(!accessReview)return;if(!canChangeAccess()||accessReview.binding!==accessBinding()){clearAccessReview({invalidated:true});return;}const detail={mode:accessReview.mode,...accessReview.rootId?{rootId:accessReview.rootId}:{},confirmed:true};clearAccessReview();window.dispatchEvent(new CustomEvent('buildx-access-policy-select',{detail}));});
    const accessActions=el('div','model-access-confirm-actions');accessActions.append(accessCancel,accessConfirmApply);accessConfirm.append(accessConfirmText,accessActions);get('composer').before(accessConfirm);
    accessStatus=el('p','model-access-status');accessStatus.id='model-access-status';accessStatus.setAttribute('role','status');accessStatus.hidden=true;get('composer').after(accessStatus);
    drawer = el('div','model-account-overlay'); drawer.id = 'model-account-drawer'; drawer.hidden = true;
    const dialog = el('section','model-account-dialog'); dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true'); dialog.setAttribute('aria-labelledby','model-account-title'); dialog.tabIndex = -1;
    const dialogHeading=el('header','model-account-heading'); drawerTitle=el('h2','','本机连接'); drawerTitle.id='model-account-title';
    drawerClose=button('model-account-close','×'); drawerClose.setAttribute('aria-label','关闭账号窗口'); drawerClose.addEventListener('click',()=>showDrawer(false));
    dialogHeading.append(drawerTitle,drawerClose); drawerBody=el('div','model-account-drawer'); dialog.append(dialogHeading,drawerBody); drawer.append(dialog); document.body.append(drawer);
    drawer.addEventListener('click',event=>{if(event.target === drawer)showDrawer(false);});
    historyNotice = el('div','model-conversation-note'); historyNotice.id = 'model-conversation-note'; historyNotice.hidden = true; historyNotice.setAttribute('role','status');
    historyText = el('span'); historyContinue = button('model-history-continue','新建对话继续'); historyContinue.addEventListener('click',() => get('new-chat').click());
    historyNotice.append(historyText,historyContinue); get('context-panel').before(historyNotice);
    const accountPanels = [document.querySelector('.connection'),get('account-panel'),get('codex-account-panel')];
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
    modelReceiptRecover.addEventListener('click',()=>{
      const receipt=snapshot?.modelReceipt;
      if(!active||!receipt||modelReceiptRecover.disabled)return;
      const visual=receipt.tool==='revit_inspect_elements'&&receipt.check?.canRestoreVisual===true;
      if(visual||receipt.canRecover===true)window.dispatchEvent(new CustomEvent(visual?'buildx-model-receipt-restore-visual':'buildx-model-receipt-recover',{detail:{ticket:receipt.ticket,conversationId:receipt.conversationId,checkRevision:receipt.checkRevision}}));
    });
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
    createArea=el('div','command-create-area');
    const createControls=el('div','command-create-controls'),createType=el('label','command-create-type');createType.append(el('span','','命令类型'));
    createCommandKind=el('select');createCommandKind.id='model-create-command-kind';createCommandKind.setAttribute('aria-label','新命令类型');
    for(const [kind,label,disabled] of [['csharp','C# 命令',false],['sequence','只读步骤命令',false],['dll','原生 DLL（暂未接入）',true],['dynamo','Dynamo（暂未接入）',true]]){const option=el('option','',label);option.value=kind;option.disabled=disabled;createCommandKind.append(option);}createCommandKind.value='csharp';createType.append(createCommandKind);
    createCommand=button('command-create','');createCommand.id='model-create-command';createCommand.append(el('span','command-create-symbol','＋'),el('strong','','创建命令'));
    createCommandHelp=el('small','command-create-help');createCommandHelp.id='model-create-command-help';createCommandHelp.setAttribute('role','status');createCommandKind.setAttribute('aria-describedby',createCommandHelp.id);
    createCommandKind.addEventListener('change',()=>renderCommandCreation());
    createCommand.addEventListener('click',()=>{if(active&&!createCommand.disabled&&['csharp','sequence'].includes(createCommandKind.value))window.dispatchEvent(new CustomEvent('buildx-create-command',{detail:{kind:createCommandKind.value}}));});
    createControls.append(createType,createCommand);createArea.append(createControls,createCommandHelp);renderCommandCreation();
    const filters=el('div','model-command-scopes');filters.setAttribute('aria-label','命令快捷筛选');
    for(const [scope,label] of [['all','全部'],['personal','我的命令'],['favorites','本次会话收藏']]){const toggle=button('model-command-scope',label);toggle.dataset.scope=scope;toggle.setAttribute('aria-pressed',String(commandScope===scope));toggle.addEventListener('click',()=>{commandScope=scope;for(const other of filters.children)other.setAttribute('aria-pressed',String(other.dataset.scope===scope));filterCommands();});filters.append(toggle);}
    commandSearch.addEventListener('input',filterCommands); commandItems=el('div','model-command-items'); commandList.append(commandSearch,filters,createArea,commandItems);
    const empty=el('section','model-command-empty');empty.id='model-command-empty';empty.hidden=true;empty.setAttribute('role','status');
    const emptyText=el('p');emptyText.id='model-command-empty-text';
    const loadPersonal=button('model-command-load-personal','读取个人命令列表');loadPersonal.id='model-command-load-personal';
    loadPersonal.addEventListener('click',()=>requestPersonalPage());
    nextPersonalPage = button('model-command-next-page','加载下一页个人命令');
    nextPersonalPage.addEventListener('click',()=>requestPersonalPage(true));
    empty.append(emptyText,loadPersonal);commandList.append(empty);buildCommandRows(commandCatalog);
    const frame = el('div','model-input-frame'); prompt.before(frame); frame.append(prompt);
    attachmentList=el('div','model-pending-attachments'); attachmentList.hidden=true; attachmentList.setAttribute('aria-label','待发送附件'); frame.before(attachmentList);
    attachmentButton=button('model-add-file'); attachmentButton.hidden=true; attachmentButton.title='添加图片或文本文件';
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
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { selected = (selected + (event.key === 'ArrowDown' ? 1 : matches.length-1)) % matches.length; renderPicker(true); }
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
    const accountChanged = previous && (previous.accountEpoch !== value?.accountEpoch || previous.commandIdentityKey !== value?.commandIdentityKey);
    const personalOwnerChanged = commandFormOwner(previous) !== commandFormOwner(value);
    const unverifiedAccount = value?.account?.required === true && (value.account.signedIn !== true || value.account.retainedSession === true);
    if (accountChanged) commandFavorites.clear();
    if (personalOwnerChanged || unverifiedAccount || !value?.enabled) {
      personalVersions.clear();
      personalPage = null;
      personalPageSignature = '';
      personalWorkflow = null;
      if (previous) resetPersonalRunForm();
    }
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
      for (const {element} of placements) if (element.id === 'account-panel' || element.id === 'codex-account-panel' || element.classList.contains('connection')) drawerBody.append(element);
      skillsPage.append(get('skills-panel'));
      prompt.setAttribute('aria-controls',picker.id); prompt.setAttribute('aria-autocomplete','list'); prompt.setAttribute('aria-expanded','false');
      if (hint) hint.textContent = 'Enter 发送 · Shift + Enter 换行';
    }
    active = true; document.body.classList.add('model-workspace'); nav.hidden = false;permissionBar.hidden=false;
    renderTerminal(value);
    const policy=value.accessPolicy,validAccess=validAccessPolicy(policy);
    const accessDisabled=!validAccess||value.accessPolicyPending===true||value.modelPermissionPending===true||value.blocked||value.busy||value.readOnly||value.ready!==true;
    accessOptions.disabled=Boolean(accessDisabled);accessOptions.setAttribute('aria-busy',String(value.accessPolicyPending===true));
    accessMenuLabel.textContent=value.accessPolicyPending?'更新中…':validAccess?({'read-only':'只读','project-write':'项目范围','full-access':'完全访问'}[policy.mode]||'访问权限'):'访问未核实';
    accessMenu.dataset.accessMode=validAccess?policy.mode:'';
    accessMenuLabel.setAttribute('aria-disabled',String(Boolean(accessDisabled)));
    if(accessDisabled)accessMenu.open=false;
    for(const [mode,choice] of accessButtons){choice.hidden=value.confirmedWrite===true&&mode==='full-access';choice.disabled=Boolean(accessDisabled)||choice.hidden;choice.setAttribute('aria-pressed',String(validAccess&&policy.mode===mode));}
    if(accessReview&&(accessReview.binding!==accessBinding()||!canChangeAccess()))clearAccessReview({invalidated:true});
    renderAccessStatus();
    accessConfirmApply.disabled=!canChangeAccess();
    const permission=value.modelPermission, validPermission=value.ready===true&&permission?.available===true&&(permission.level===null||['rollback','confirm','automatic'].includes(permission.level))&&permission.conversationId===value.commandConversationId&&(permission.expiresAt===null||Number.isSafeInteger(permission.expiresAt)&&permission.expiresAt>Date.now());
    permissionAutomatic.hidden=value.confirmedWrite===true;permissionAutomatic.disabled=permissionAutomatic.hidden;
    permissionPlaceholder.textContent=validPermission?'请选择执行方式':'执行未核实';
    permissionSelect.value=value.modelPermissionPending?'__pending':validPermission?permission.level||'':'';
    permissionSelect.disabled=!validPermission||value.modelPermissionPending===true||value.accessPolicyPending===true||value.blocked||value.busy||value.readOnly||value.ready!==true;
    const permissionText=value.modelPermissionPending?(value.modelPermissionMessage||'正在等待 Revit 核实当前模型与执行权限…'):validPermission?(permission.level===null?'尚未授权；选择后会核实当前模型。':'当前模型：'+permission.documentLabel+'；执行方式绑定当前对话，切换模型后重新核实适用范围。'):value.modelPermissionMessage||'执行方式尚未核实。';
    permissionScope.textContent=permissionText;permissionDetails.textContent=permissionText;
    permissionRefresh.hidden=value.modelPermissionStatusRefreshAvailable!==true;
    permissionRefresh.disabled=value.modelPermissionStatusRefreshing===true;
    permissionRefresh.textContent=permissionRefresh.disabled?'正在刷新…':'刷新服务状态';
    permissionSafety.textContent=(validAccess?'访问范围：'+accessText()+'。':'访问范围尚未核实。')+(value.confirmedWrite===true?' 每次模型写入和回滚预览均需确认。':' 脚本、文件和族操作按实际授权及执行方式核验。C# 脚本不是安全沙盒，回滚不能撤销事务外副作用。');
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
      const viewInspection=receipt.tool==='revit_inspect_elements';
      const canRestoreView=viewInspection&&check?.canRestoreVisual===true;
      const labels={received:'已核实执行结果，正在恢复后续操作。',version_present:'准确版本存在；无法判断是否由本次请求新建。',not_started:'已确认：本次操作未开始。',failed:'已确认：操作执行失败。',failed_rolled_back:'脚本报错，模型事务已回滚。文件、网络等事务外影响尚未核实。',expired:'请求已过期，操作未执行。',pending:'正在等待原操作回执，收到后会自动核查。',host_changed:'Revit 已重新连接，原操作结果仍需核查。',unconfirmed:'原回执仍未核实，实际结果尚不确定。'};
      const description=recovering?'脚本已报错结束，是否回滚仍未核实。':failedDispatch&&check?.status!=='failed_rolled_back'?(receipt.tool==='revit_execute_csharp'?'脚本执行报错；是否回滚仍未核实。':'操作执行报错；实际影响仍需核实。'):viewInspection&&check?.status==='unconfirmed'?'尚未读到这次视图检查的原回执，截图和视图状态仍待核查。':check?labels[check.status]||'已取得检查状态，结果仍需核实。':autoActive?'正在自动核查原操作回执。':'等待原操作回执。';
      modelReceiptTitle.textContent=viewInspection?'视图检查结果待核查':'模型写入已暂停';modelReceiptState.textContent=canRestoreView?'可恢复临时视图':autoMessage?'等待处理':recovering?'需要核查':checking||autoActive?'正在自动核查':check?.terminal===true?'正在恢复':check?.status==='unconfirmed'?'原回执未取得':failedDispatch?'执行报错':'等待回执';
      modelReceiptDescription.textContent=(receipt.sourceConversationId!==receipt.conversationId?'来自另一段对话 · ':'')+'操作：'+(commandCatalog.find(command=>command.tool===receipt.tool)?.label||(viewInspection?'检查构件视图':receipt.tool))+'。请勿重复执行。';
      modelReceiptStatus.textContent=value.modelReceiptMessage||autoMessage||(checking?'正在读取原回执…':description);
      modelReceiptFailure.hidden=!knownFailure;modelReceiptFailure.textContent=knownFailure?'执行器返回：'+failure.code+' · '+failure.message:'';
      modelReceiptNext.textContent=canRestoreView?'已核实可恢复这次检查使用的临时视图。恢复只处理视图状态。':recovering?'请先只读核查模型，再点击“已核查，继续”。回滚与事务外影响尚未确认；不会重跑原脚本。':check?.terminal===true?'系统会自动处理确定结果；也可手动确认。不会重复执行操作。':viewInspection?'可以继续聊天、新建对话或用只读命令核查构件。用“核查原回执”查看这次结果。':'可以继续聊天或新建对话，也可只读核查模型。原操作确定前，后续模型写入保持暂停。';
      modelReceiptRaw.hidden=!check;modelReceiptEvidence.textContent=check?JSON.stringify(check,null,2):'';
      const disabled=value.account?.required===true&&value.account.signedIn!==true||value.readOnly||value.modelReceiptPending||receipt.checking;
      modelReceiptCheck.textContent=checking?'核查中…':viewInspection?'核查原回执':check?'再次核查':'立即核查';modelReceiptCheck.disabled=Boolean(disabled);modelReceiptAcknowledge.hidden=check?.terminal!==true;
      modelReceiptAcknowledge.textContent=value.modelReceiptPendingAction==='acknowledge'?'确认中…':value.modelReceiptAckSubmitted?'等待服务确认…':'确认已核对';
      modelReceiptAcknowledge.disabled=Boolean(disabled||value.busy||value.blocked||value.modelReceiptAckSubmitted||check?.terminal!==true);
      modelReceiptRecover.hidden=!recovering&&!canRestoreView;modelReceiptRecover.textContent=['recover','restore-visual'].includes(value.modelReceiptPendingAction)?'正在恢复…':value.modelReceiptAckSubmitted?'等待服务确认…':canRestoreView?'恢复临时检查视图':'已核查，继续';
      modelReceiptRecover.disabled=Boolean(disabled||value.busy||value.blocked||value.modelReceiptAckSubmitted||!recovering&&!canRestoreView);
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
    if(accountChanged)for(const favorite of commandList.querySelectorAll('.model-command-favorite')){favorite.textContent='会话收藏';favorite.setAttribute('aria-pressed','false');}
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
