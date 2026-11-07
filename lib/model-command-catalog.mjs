import {PANEL_WORKBENCH_TOOLS,PANEL_CONFIRMED_ONLY_TOOLS,READ_TOOLS,MODEL_WORKSPACE_TOOLS} from './panel-tools.mjs';
import {PANEL_TOOL_CATALOG,PANEL_CONFIRMED_ONLY_CATALOG} from './panel-catalog.mjs';
import {readonlyPanelCommandSchema} from './workbench-client.mjs';
import {isNativeTypeParameterWrite} from './native-type-parameter-writes.mjs';
import {MODEL_PREPARATION_QUERY_NAME,PIPE_NETWORK_QUERY_NAME,PROJECT_BINDING_PREVIEW_NAME,isAecPilotQuery,isAecDrawingQuery} from './native-model-queries.mjs';

const aliases=Object.freeze({revit_workbench_status:'document',revit_get_selection:'selection',revit_list_levels:'levels',revit_search_elements:'search'});
const labels=new Map([...PANEL_TOOL_CATALOG,...PANEL_CONFIRMED_ONLY_CATALOG].map(tool=>[tool.name,tool]));
const visualLabels=Object.freeze({revit_capture_view:'截取原生视图',revit_inspect_elements:'隔离取景并视觉复核',revit_restore_visual_session:'恢复检查视图状态'});
const visualDescriptions=Object.freeze({revit_capture_view:'需要宿主 0.7.0：截取指定或当前 Revit 视图，不改变源视图和选择，图片保存到自有目录。',revit_inspect_elements:'需要宿主 0.7.0：在临时检查视图中隔离目标与参照、自动取景和多视角截图，结束后回滚清理，不保存模型。',revit_restore_visual_session:'需要宿主 0.7.0：按原会话句柄重试清理未恢复的临时检查视图，不重复创建或截图。'});
const groupFor=name=>READ_TOOLS.includes(name)||name===MODEL_PREPARATION_QUERY_NAME||name===PIPE_NETWORK_QUERY_NAME||name===PROJECT_BINDING_PREVIEW_NAME||isAecPilotQuery(name)||isAecDrawingQuery(name)?'模型查询':
  Object.hasOwn(visualLabels,name)?'视觉复核':
  ['revit_list_cad_imports','revit_preview_cad_candidates'].includes(name)?'CAD':
  name.startsWith('revit_family_')?'族工作流':name.includes('schematic')?'系统图':
  ['revit_save_command','revit_list_commands','revit_get_command','revit_run_command'].includes(name)?'命令库':
  ['revit_workbench_status','revit_get_selection','revit_search_elements','revit_list_levels','revit_list_family_types','revit_describe_parameters','revit_capture_model_snapshot'].includes(name)?'模型查询':'模型操作';
function freeze(value){
  if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
}
function publicSchema(schema){
  const copy=structuredClone(schema);
  delete copy.properties.expected_document;
  if(Array.isArray(copy.required))copy.required=copy.required.filter(name=>name!=='expected_document');
  return copy;
}

// Shared native tool contracts own parameters and effects; this is only their
// display/HTTP projection.
export const MODEL_COMMAND_CATALOG=freeze([
  ...[...PANEL_WORKBENCH_TOOLS,...PANEL_CONFIRMED_ONLY_TOOLS].map(tool=>({
    id:aliases[tool.name]??tool.name,tool:tool.name,
    label:tool.name==='revit_workbench_status'?'模型概况':visualLabels[tool.name]??labels.get(tool.name)?.label??tool.name,
    description:visualDescriptions[tool.name]??labels.get(tool.name)?.description??tool.description,group:groupFor(tool.name),
    readOnly:tool.annotations?.readOnlyHint===true,inputSchema:aliases[tool.name]?readonlyPanelCommandSchema(aliases[tool.name]):publicSchema(tool.inputSchema),
    enabled:true,unavailableReason:null,...isNativeTypeParameterWrite(tool.name)?{manualExecution:true,requiresTypeParameterReview:true}:{},
  })),
]);
const byId=new Map(MODEL_COMMAND_CATALOG.map(command=>[command.id,command]));
const byTool=new Map(MODEL_COMMAND_CATALOG.map(command=>[command.tool,command]));
if(byId.size!==MODEL_COMMAND_CATALOG.length||byTool.size!==MODEL_COMMAND_CATALOG.length)throw new Error('Model commands require unique named tool contracts');
export const modelCommandById=id=>byId.get(id)??null;
export const modelCommandByTool=name=>byTool.get(name)??null;
export const MODEL_WORKSPACE_TOOL_NAMES=Object.freeze(MODEL_WORKSPACE_TOOLS.map(tool=>tool.name));
