import {PANEL_TOOL_CATALOG} from './panel-catalog.mjs';
import {SOURCE_TOOLS} from './source-tools.mjs';
import {MODEL_READONLY_SESSION_PROFILE,MODEL_WORKSPACE_SESSION_PROFILE} from './codex-profile.mjs';
import {READONLY_WORKBENCH_TOOL_NAMES} from './workbench-client.mjs';
import {MODEL_COMMAND_CATALOG,MODEL_WORKSPACE_TOOL_NAMES} from './model-command-catalog.mjs';

// Active model-server selection, shared by server startup and its operator plan.
// Session identities below still retain legacy/source profiles independently.
export const MODEL_SERVER_PROFILE=MODEL_WORKSPACE_SESSION_PROFILE;

const sourceLabels=new Map([
  ['buildx_source_list_roots','源码来源'],
  ['buildx_source_scan_directory','采集目录快照'],
  ['buildx_source_directory_page','查看目录页'],
  ['buildx_source_release_directory','释放目录快照'],
  ['buildx_source_read_file','读取源码页'],
  ['buildx_source_search','搜索源码'],
]);
const sourceCatalog=Object.freeze(SOURCE_TOOLS.map(tool=>Object.freeze({name:tool.name,
  label:sourceLabels.get(tool.name)||tool.name,description:tool.description,
  readOnly:tool.annotations?.readOnlyHint===true})));
const modelCatalog=Object.freeze(PANEL_TOOL_CATALOG.map(tool=>Object.freeze({...tool})));
const readonlyModelCatalog=Object.freeze(READONLY_WORKBENCH_TOOL_NAMES.map(name=>{
  const matches=modelCatalog.filter(tool=>tool.name===name);
  if(matches.length!==1||matches[0].readOnly!==true)throw new Error('Read-only model catalog requires its four named read contracts');
  return matches[0];
}));
const profiles=new Map([
  ['model',Object.freeze({workspace:Object.freeze({kind:'model',supportsModelContext:true}),
    catalog:modelCatalog,cancelMessage:'正在停止对话；模型操作可能仍在执行…',
    interruptUnconfirmed:'停止请求未确认，连接已重置；已发出的模型操作结果未知。',
    interruptTimeout:'未及时收到停止回执，连接已重置；模型操作结果未知。',
    stopUnknown:'本地服务已停止；已发出的模型操作结果须另行核对。'})],
  ['source-development',Object.freeze({workspace:Object.freeze({kind:'source-development',supportsModelContext:false}),
    catalog:sourceCatalog,cancelMessage:'正在停止源码对话；已开始的读取仍须等待清理回执…',
    interruptUnconfirmed:'源码对话停止请求未确认，独立连接已重置；读取结果尚待核对。',
    interruptTimeout:'未及时收到源码对话停止回执，独立连接已重置；读取结果尚待核对。',
    sessionNotices:Object.freeze({toolUnconfirmed:'尚未收到源码工具回执；停止对话不保证已结束读取或清理。',
      interrupted:'源码对话已停止。尚未完成的读取和清理须核对回执；不会操作Revit模型。',
      reset:'源码连接已重建，AI 上下文已重置；历史保留供查看，后续源码结论须重新核对来源。'}),
    stopUnknown:'源码服务已停止；尚未完成的源码读取结果须另行核对。'})],
]);

profiles.set(MODEL_READONLY_SESSION_PROFILE,Object.freeze({...profiles.get('model'),catalog:readonlyModelCatalog}));
profiles.set(MODEL_WORKSPACE_SESSION_PROFILE,Object.freeze({...profiles.get('model'),
  catalog:Object.freeze(modelCatalog.filter(tool=>MODEL_WORKSPACE_TOOL_NAMES.includes(tool.name))),
  commands:MODEL_COMMAND_CATALOG,commandReadiness:'local'}));

// These are presentation/context capabilities of named server-selected sessions,
// never client-supplied permissions or an arbitrary MCP configuration.
export function panelProfile(name='model',{nativeReadonlyTest=false}={}){
  const profile=profiles.get(name);
  if(!profile)throw new Error('Unknown panel profile');
  if(nativeReadonlyTest){
    if(name!==MODEL_READONLY_SESSION_PROFILE)throw new Error('Internal test requires the fixed read-only profile');
    return Object.freeze({...profile,workspace:Object.freeze({...profile.workspace,nativeReadonlyTest:true}),
      commands:Object.freeze(MODEL_COMMAND_CATALOG.filter(command=>READONLY_WORKBENCH_TOOL_NAMES.includes(command.tool))),commandReadiness:'local'});
  }
  return profile;
}
