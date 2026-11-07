import {AEC_PILOT_QUERY_NAMES,AEC_DRAWING_QUERY_NAMES,MODEL_PREPARATION_QUERY_NAME,PIPE_NETWORK_QUERY_NAME} from './native-model-queries.mjs';

// A conservative classification of the named public operations, independent of
// tool descriptions, UI hints, transaction mode and the caller's claimed role.
// This describes effects only: it neither grants permission nor proves that an
// invocation is confined to a document. Callers must separately bind and check
// account, conversation, host/document and the exact operation and arguments.
const groups = Object.freeze({
  read: Object.freeze([
    'revit_workbench_status', 'revit_capture_model_snapshot', 'revit_get_selection',
    'revit_search_elements', 'revit_list_levels', 'revit_list_family_types',
    'revit_describe_parameters', 'revit_preview_schematic', 'revit_list_cad_imports',
    'revit_preview_cad_candidates', 'revit_family_templates', 'revit_family_inspect_job',
    'revit_list_commands', 'revit_get_command', 'revit_health', 'revit_get_document_info',
    'revit_list_views', 'revit_get_element_parameters', 'revit_get_elements_by_type',
    'revit_get_element_geometry', 'revit_get_type_parameters', 'revit_get_parameter_value', 'revit_get_type_parameter_impact',
    ...AEC_PILOT_QUERY_NAMES,...AEC_DRAWING_QUERY_NAMES,MODEL_PREPARATION_QUERY_NAME,PIPE_NETWORK_QUERY_NAME,
  ]),
  // These named operations do not accept caller-supplied source. Some compile a
  // fixed template into C#, but accepting arbitrary C# is a different effect.
  model_transaction: Object.freeze([
    'revit_set_parameters', 'revit_set_parameter_value', 'revit_set_type_parameter', 'revit_move_elements', 'revit_copy_elements',
    'revit_create_wall', 'revit_create_pipe', 'revit_create_level', 'revit_create_grid', 'revit_pin_element', 'revit_unpin_element', 'revit_rotate_elements',
    'revit_place_family_instance', 'revit_place_door', 'revit_place_window','revit_create_column','revit_create_foundation', 'revit_create_floor', 'revit_export_schematic',
    'revit_set_element_material','revit_create_material', 'revit_create_floor_plan_view', 'revit_create_3d_view', 'revit_create_conduit', 'revit_create_duct', 'revit_create_sheet','revit_renumber_sheets','revit_duplicate_sheet',
    'revit_place_viewport_on_sheet', 'revit_apply_view_template', 'revit_create_text_note', 'revit_create_section_view','revit_create_room','revit_create_schedule','revit_create_beam','revit_create_roof','revit_create_group','revit_populate_titleblock','revit_mirror_element','revit_ungroup','revit_change_element_type','revit_replace_family_type',
  ]),
  // A saved command can contain arbitrary C# or a composition: classify the
  // unresolved entry point conservatively, without trusting its name or mode.
  script_or_command: Object.freeze(['revit_execute_csharp', 'revit_run_command']),
  local_file: Object.freeze(['revit_save_command']),
  ui_selection: Object.freeze(['revit_set_selection','revit_select_by_unique_ids']),
  // Owned temporary views and PNG files have their own recovery lifecycle;
  // these are neither pure reads nor permanent model transactions.
  view_capture: Object.freeze(['revit_capture_view','revit_inspect_elements','revit_restore_visual_session']),
  family: Object.freeze([
    'revit_family_create_valve', 'revit_family_save_job', 'revit_family_load_job',
    'revit_family_close_job', 'revit_family_create_cabinet', 'revit_family_save_cabinet',
    'revit_family_close_cabinet',
  ]),
  // These use recovered third-party services; their complete effects are not
  // established by a transaction or a readOnlyHint alone.
  other_effects: Object.freeze(['revit_smart_annotate', 'revit_build_schematic']),
});

const unknown = Object.freeze({kind:'unknown', known:false});
const table = new Map();
for (const [kind,names] of Object.entries(groups)) {
  const effect = Object.freeze({kind, known:true});
  for (const name of names) {
    if (table.has(name)) throw new Error('Duplicate model operation effect');
    table.set(name,effect);
  }
}

/** Unknown names always produce an explicit unknown classification, never an
 * inferred read or model write. This function is not an authorization check. */
export function modelOperationEffect(name) {
  return typeof name === 'string' ? table.get(name) ?? unknown : unknown;
}

// This is the single capability boundary for the panel permission owner and
// its advertised dynamic tool. Effect classification alone does not grant
// support: legacy family/third-party effects remain unavailable until their
// own approval and receipt lifecycles are implemented.
const independentlyApproved=new Set(['revit_execute_csharp','revit_save_command','revit_run_command','revit_family_load_job','revit_family_create_valve','revit_smart_annotate','revit_build_schematic']);
export function supportsModelPermissionTool(name){
  const effect=modelOperationEffect(name);
  return effect.kind==='model_transaction'||effect.kind==='ui_selection'||effect.kind==='view_capture'||effect.known&&independentlyApproved.has(name);
}
