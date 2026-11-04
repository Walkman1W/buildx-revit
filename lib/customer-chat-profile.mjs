import {readFileSync} from 'node:fs';

const disabledFeatures=Object.freeze(['shell_tool','apps','plugins','computer_use','browser_use',
  'in_app_browser','image_generation','multi_agent','hooks','memories']);
function buildLaunchArgs(configuredNames){
  let names;
  try{
    if(!Array.isArray(configuredNames))throw new Error();names=Array.from(configuredNames);
    if(names.some(name=>typeof name!=='string'||!/^[A-Za-z0-9_-]+$/.test(name))||new Set(names).size!==names.length)throw new Error();
  }catch{throw new Error('客户对话的 MCP 服务名称未通过检查，已停止启动。');}
  const args=['app-server','--listen','stdio://','--strict-config'];
  for(const name of names)args.push('-c','mcp_servers.'+name+'.enabled=false');
  for(const feature of disabledFeatures)args.push('-c','features.'+feature+'=false');
  args.push('-c','features.code_mode_host=false','-c','web_search="disabled"');return args;
}
function buildInstructions(){
  const bytes=readFileSync(new URL('../prompts/buildx-customer-chat.zh-CN.md',import.meta.url));
  if(bytes.length>64*1024)throw new Error('BuildX 客户对话应用指令超过64KiB。');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(!text.trim()||/\{\{[A-Z_]+\}\}/.test(text))throw new Error('BuildX 客户对话应用指令无效。');return text;
}
const codex=Object.freeze({id:'customer-chat',mode:'customer-chat',service:'buildx-customer-chat',
  groups:Object.freeze([]),toolNames:Object.freeze([]),buildLaunchArgs,buildInstructions,
  clientInfo:Object.freeze({name:'buildx_customer_chat',title:'BuildX Customer Chat',version:'0.1.0'}),
  connectingTools:'正在核对客户对话的零工具范围…',catalogFailed:'零工具范围未能核实，请重新连接。',
  catalogNotReady:'零工具范围未知；不会开放对话，请重新连接后核对。',verifiedDiagnostic:'customer_chat_tools_verified',
  denialMessage:'This customer chat grants no tools, filesystem, shell, browser, model, or authentication permissions.'});
const panel=Object.freeze({workspace:Object.freeze({kind:'customer-chat',supportsModelContext:false}),catalog:Object.freeze([]),
  cancelMessage:'正在停止当前对话…',interruptUnconfirmed:'停止回执未确认，连接需要重建；不会自动重发消息。',
  interruptTimeout:'未及时收到停止回执，连接已重置；本轮回复状态未知。',stopUnknown:'本地对话服务已停止；未完成回复的状态未知。',
  sessionNotices:Object.freeze({toolUnconfirmed:'当前客户对话不提供工具，任何工具回执都不能视为已执行。',
    interrupted:'对话已停止；不会自动重发本轮消息。',reset:'连接已重建，旧 AI 上下文已清除，后续对话使用新会话。'})});
const composition=Object.freeze({codex,panel});

// Server-side composition only. No browser configuration, model profile, or
// development entry is imported by this independent zero-tool component.
export function createCustomerChatProfile(...args){if(args.length)throw new Error('客户对话只使用固定内部profile。');return composition;}
