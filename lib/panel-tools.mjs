import {WORKBENCH_TOOLS} from './workbench-client.mjs';
import {COMMAND_TOOLS} from './command-store.mjs';
import {NATIVE_MODEL_QUERY_NAMES} from './native-model-queries.mjs';
import {NATIVE_PARAMETER_QUERY_NAMES} from './native-parameter-queries.mjs';
import {isNativeParameterWrite} from './native-parameter-writes.mjs';
import {FAMILY_PANEL_CONFIRMATION_ONLY} from './family-tools.mjs';
import {modelOperationEffect} from './model-operation-effects.mjs';

export const READ_TOOLS=Object.freeze([...NATIVE_MODEL_QUERY_NAMES,...NATIVE_PARAMETER_QUERY_NAMES]);
const confirmedOnly=new Set(FAMILY_PANEL_CONFIRMATION_ONLY);
export const PANEL_WORKBENCH_TOOLS=[...WORKBENCH_TOOLS.filter(tool=>!confirmedOnly.has(tool.name)),...COMMAND_TOOLS];
export const PANEL_CONFIRMED_ONLY_TOOLS=WORKBENCH_TOOLS.filter(tool=>confirmedOnly.has(tool.name));
export const MODEL_WORKSPACE_TOOLS=Object.freeze([...PANEL_WORKBENCH_TOOLS]);
// The Codex-owned MCP process has no trusted conversation/approval owner.
// Only classified reads may cross that boundary. Model effects are dispatched
// by the panel's bound dynamic-tool owner after a user decision instead.
export const MODEL_AI_READ_TOOLS=Object.freeze(MODEL_WORKSPACE_TOOLS.filter(tool=>modelOperationEffect(tool.name).kind==='read'));
export const MODEL_AI_EFFECT_TOOLS=Object.freeze(MODEL_WORKSPACE_TOOLS.filter(tool=>modelOperationEffect(tool.name).known&&modelOperationEffect(tool.name).kind!=='read'));
export const ALL_PANEL_TOOLS=PANEL_WORKBENCH_TOOLS.map(tool=>tool.name);
// Legacy MCP has no bound panel approval owner for the new native write.
export const LEGACY_PANEL_WORKBENCH_TOOLS=Object.freeze(PANEL_WORKBENCH_TOOLS.filter(tool=>!isNativeParameterWrite(tool.name)));
export const LEGACY_PANEL_TOOL_NAMES=Object.freeze(LEGACY_PANEL_WORKBENCH_TOOLS.map(tool=>tool.name));
