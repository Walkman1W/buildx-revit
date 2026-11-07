import {WORKBENCH_TOOLS} from './workbench-client.mjs';
import {COMMAND_TOOLS} from './command-store.mjs';
import {NATIVE_MODEL_QUERY_NAMES,MODEL_PREPARATION_QUERY_NAME,PIPE_NETWORK_QUERY_NAME,isAecPilotQuery,isAecDrawingQuery} from './native-model-queries.mjs';
import {NATIVE_PARAMETER_QUERY_NAMES} from './native-parameter-queries.mjs';
import {isNativeParameterWrite} from './native-parameter-writes.mjs';
import {isNativeTypeParameterWrite} from './native-type-parameter-writes.mjs';
import {FAMILY_PANEL_CONFIRMATION_ONLY} from './family-tools.mjs';
import {modelOperationEffect} from './model-operation-effects.mjs';

export const READ_TOOLS=Object.freeze([...NATIVE_MODEL_QUERY_NAMES,...NATIVE_PARAMETER_QUERY_NAMES]);
const confirmedOnly=new Set(FAMILY_PANEL_CONFIRMATION_ONLY);
const basicWrites=new Set(['revit_create_material','revit_create_level','revit_create_grid','revit_pin_element','revit_unpin_element','revit_create_floor_plan_view','revit_create_3d_view','revit_create_section_view','revit_create_room','revit_create_schedule','revit_create_group','revit_change_element_type','revit_create_conduit','revit_create_duct','revit_create_sheet','revit_place_viewport_on_sheet','revit_apply_view_template','revit_place_window','revit_create_text_note']);
export const PANEL_WORKBENCH_TOOLS=[...WORKBENCH_TOOLS.filter(tool=>!confirmedOnly.has(tool.name)),...COMMAND_TOOLS];
export const PANEL_CONFIRMED_ONLY_TOOLS=WORKBENCH_TOOLS.filter(tool=>confirmedOnly.has(tool.name));
export const MODEL_WORKSPACE_TOOLS=Object.freeze([...PANEL_WORKBENCH_TOOLS]);
// The Codex-owned MCP process has no trusted conversation/approval owner.
// Only classified reads may cross that boundary. Model effects are dispatched
// by the panel's bound dynamic-tool owner after a user decision instead.
export const MODEL_AI_READ_TOOLS=Object.freeze(MODEL_WORKSPACE_TOOLS.filter(tool=>modelOperationEffect(tool.name).kind==='read'));
export const MODEL_AI_EFFECT_TOOLS=Object.freeze(MODEL_WORKSPACE_TOOLS.filter(tool=>modelOperationEffect(tool.name).known&&modelOperationEffect(tool.name).kind!=='read'));
export const ALL_PANEL_TOOLS=PANEL_WORKBENCH_TOOLS.map(tool=>tool.name);
// Legacy MCP preserves its original catalog. Pilot reads run in the named model workspace.
export const LEGACY_PANEL_WORKBENCH_TOOLS=Object.freeze(PANEL_WORKBENCH_TOOLS.filter(tool=>tool.name!==MODEL_PREPARATION_QUERY_NAME&&tool.name!==PIPE_NETWORK_QUERY_NAME&&!isAecPilotQuery(tool.name)&&!isAecDrawingQuery(tool.name)&&!isNativeParameterWrite(tool.name)&&!isNativeTypeParameterWrite(tool.name)&&!basicWrites.has(tool.name)));
export const LEGACY_PANEL_TOOL_NAMES=Object.freeze(LEGACY_PANEL_WORKBENCH_TOOLS.map(tool=>tool.name));
