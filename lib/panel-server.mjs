import {BATCH_PREVIEW_NAME} from './batch-filter-preview.mjs';
import {panelProfile} from './panel-profile.mjs';
import {createPanelServerCore} from './panel-server-core.mjs';
import {MODEL_READONLY_SESSION_PROFILE,MODEL_WORKSPACE_SESSION_PROFILE} from './codex-profile.mjs';
import {READONLY_WORKBENCH_TOOL_NAMES,nativeRequestId,workbenchFailureEvidence} from './workbench-client.mjs';
import {confirmedWriteProfile} from './confirmed-write-profile.mjs';
import {modelReadTools} from './model-operation-contracts.mjs';
import {SNAPSHOT_DELTA_NAME} from './native-snapshot-delta.mjs';
import {isNativeModelQuery} from './native-model-queries.mjs';
import {isNativeParameterQuery} from './native-parameter-queries.mjs';
import {createChatReadReceiptInbox} from './chat-read-receipts.mjs';
import {MODEL_TURN_INPUT} from './turn-attachments.mjs';
import {sanitizePanelAudit} from './panel-audit.mjs';
import {createProjectKnowledge} from './project-knowledge.mjs';
import {createProjectFilesPicker} from './project-files-picker.mjs';
import {createProjectFilesComposition} from './project-files-composition.mjs';
import {PROJECT_AGENT_TOOLS,invokeProjectAgentTool,observeProjectToolReadiness} from './project-agent-bridge.mjs';
const workbenchTimingPhases=new Set(['request_prepared','temp_ready','published','receipt_received','transport_finished']);

function readToolTiming(item){
  const meta=item?.result?._meta?.['buildx/phaseTiming'];
  if(item?.type!=='mcpToolCall'||!READONLY_WORKBENCH_TOOL_NAMES.includes(item.tool||item.name)||meta?.schemaVersion!==1||!Array.isArray(meta.events)||meta.events.length>8)return [];
  const events=meta.events.map(event=>sanitizePanelAudit('phase-timing.jsonl',event));
  if(events.some(event=>!event||event.source!=='workbench'||!workbenchTimingPhases.has(event.phase)||!nativeRequestId(event.requestId)||!/^[a-f0-9]{32}$/.test(event.hostSession||'')||!Number.isFinite(event.elapsedMs)))return [];
  if(events.some((event,i)=>event.requestId!==events[0].requestId||event.hostSession!==events[0].hostSession||i>0&&event.elapsedMs<events[i-1].elapsedMs))return [];
  return events;
}

function matchesNamedCodexProfile(codex,profileId,expectedNames){
  const profile=codex.profile;
  if(!profile||!Object.isFrozen(profile))return false;
  const id=Object.getOwnPropertyDescriptor(profile,'id'),tools=Object.getOwnPropertyDescriptor(profile,'toolNames');
  if(id?.value!==profileId||!Array.isArray(tools?.value)||!Object.isFrozen(tools.value))return false;
  const names=tools.value;
  return names.length===expectedNames.length&&new Set(names).size===names.length&&
    names.every(name=>expectedNames.includes(name));
}

// Research/model composition stays at this existing application entry. The
// reusable HTTP/SSE/account lifecycle core has no tool/profile discovery imports.
export function createPanelServer(options){
  const {root,codex,invokeWorkbench,invokeReadonlyCommand=null,profile='model',accountAuth=null,requireAccount=false}=options;
  const selection=panelProfile(profile),workspace=selection.workspace;
  if(!root||!codex||(workspace.supportsModelContext&&typeof invokeWorkbench!=='function'))throw new Error('Panel dependencies are required');
  const mode=codex.state?.mode;
  const workspaceReads=profile===MODEL_WORKSPACE_SESSION_PROFILE?modelReadTools(confirmedWriteProfile(root)):[];
  if(profile===MODEL_READONLY_SESSION_PROFILE&&(mode!=='document-workbench'||!matchesNamedCodexProfile(codex,MODEL_READONLY_SESSION_PROFILE,READONLY_WORKBENCH_TOOL_NAMES)))throw new Error('Read-only model panel requires the exact named four-tool Codex profile');
  if(profile===MODEL_WORKSPACE_SESSION_PROFILE&&(mode!=='document-workbench'||!matchesNamedCodexProfile(codex,MODEL_WORKSPACE_SESSION_PROFILE,workspaceReads.map(tool=>tool.name))))throw new Error('Model workspace requires its exact named read-only MCP profile');
  if(!workspace.supportsModelContext&&mode!=='source-development')throw new Error('Source panel requires the source-only Codex profile');
  // Preserve compatibility with older trusted model test adapters only when
  // mode is absent; explicit unknown/opposite modes still fail closed.
  if(workspace.supportsModelContext&&mode!==undefined&&mode!=='document-workbench')throw new Error('Model panel requires the model-only Codex profile');
  if(!workspace.supportsModelContext&&(accountAuth||requireAccount))throw new Error('Source workspace does not accept customer identity configuration');
  if(invokeReadonlyCommand!==null&&(workspace.kind!=='model'||typeof invokeReadonlyCommand!=='function'))throw new Error('Direct commands require an explicitly injected model-only owner');
  const projectAgent=profile===MODEL_WORKSPACE_SESSION_PROFILE&&Array.isArray(codex.profile?.dynamicTools)&&PROJECT_AGENT_TOOLS.every(tool=>codex.profile.dynamicTools.some(item=>item.name===tool.name))?Object.freeze({tools:PROJECT_AGENT_TOOLS,invoke:invokeProjectAgentTool,observeKnowledge:observeProjectToolReadiness}):null;
  const material=workspace.kind==='model'?createProjectFilesComposition({...options.materialOpener?{opener:options.materialOpener}:{}}):null;
  const chatReadReceiptInbox=profile===MODEL_WORKSPACE_SESSION_PROFILE?createChatReadReceiptInbox(options.chatReadReceiptKey,
    new Set(workspaceReads.map(tool=>tool.name).filter(name=>name===BATCH_PREVIEW_NAME||name===SNAPSHOT_DELTA_NAME||isNativeModelQuery(name)||isNativeParameterQuery(name)))):null;
  return createPanelServerCore({...options,selection,projectAgent,chatReadReceiptInbox,readContextFailure:workspace.supportsModelContext?(options.readContextFailure??workbenchFailureEvidence):null,materialOpener:material?.materialOpener??null,materialIndexFactory:workspace.kind==='model'?(options.materialIndexFactory??material.materialIndexFactory):null,materialStoreFactory:workspace.kind==='model'?(options.materialStoreFactory??null):null,materialPicker:workspace.kind==='model'?(options.materialPicker??createProjectFilesPicker()):null,projectKnowledgeFactory:workspace.kind==='model'?(options.projectKnowledgeFactory??createProjectKnowledge):null,readToolTiming:workspace.kind==='model'?readToolTiming:null,turnInput:workspace.kind==='model'&&codex.profile?.supportsTurnAttachments===true?MODEL_TURN_INPUT:null});
}
