import {validateProjectBindingPreview,validateProjectBindingPreviewArguments} from './project-instance-binding-preview.mjs';
// BuildX owns these named read contracts. No provider discovery or process launch.
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const text=(maxLength=1024)=>({type:'string',maxLength});
const integer=(minimum=0,maximum=Number.MAX_SAFE_INTEGER)=>({type:'integer',minimum,maximum});
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const nullable=rule=>({anyOf:[rule,{type:'null'}]});
const bool={type:'boolean'},nil={type:'null'};
const exactId={anyOf:[integer(1),{type:'string',pattern:'^[1-9]\\d{0,18}$',maxLength:19}]};
const signedId={anyOf:[integer(-Number.MAX_SAFE_INTEGER),{type:'string',pattern:'^-?(?:0|[1-9]\\d{0,18})$',maxLength:20}]};
const expectedDocument={type:'string',maxLength:32768,description:'Exact current document path; empty means the current unsaved document. The atomic queue can bind an omitted path.'};
const pagination={offset:{...integer(0,2147483647),default:0},limit:{...integer(1,500),default:200}};
const pilotPagination={offset:pagination.offset,limit:{...integer(1,200),default:100}};
const fields=['name','category','type_id','level','length','area','volume'];
export const NATIVE_MODEL_QUERY_DEFAULT_FIELDS=freeze(['name','category','type_id','level']);
export const NATIVE_MODEL_QUERY_CATEGORY_ALIASES=freeze({Walls:'OST_Walls',Doors:'OST_Doors',Windows:'OST_Windows',Floors:'OST_Floors',Roofs:'OST_Roofs',Ceilings:'OST_Ceilings',Columns:'OST_Columns',StructuralColumns:'OST_StructuralColumns',StructuralFraming:'OST_StructuralFraming',Pipes:'OST_PipeCurves',PipeFittings:'OST_PipeFitting',PipeAccessories:'OST_PipeAccessory',Ducts:'OST_DuctCurves',DuctFittings:'OST_DuctFitting',DuctAccessories:'OST_DuctAccessory',MechanicalEquipment:'OST_MechanicalEquipment',PlumbingFixtures:'OST_PlumbingFixtures',Furniture:'OST_Furniture',GenericModels:'OST_GenericModel'});
const categoryAliases=new Map(Object.entries(NATIVE_MODEL_QUERY_CATEGORY_ALIASES));
export function nativeModelQueryCategoryIdentity(value){
  if(value==='')return null;
  if(typeof value!=='string')failure('category must be a string');
  if(/^OST_[A-Za-z][A-Za-z0-9_]*$/.test(value))return value;
  const identity=categoryAliases.get(value);
  if(!identity)failure('category must be an OST identity or explicit supported alias');
  return identity;
}
export const NATIVE_MODEL_QUERIES_VERSION=1;
export const NATIVE_MODEL_QUERIES_MIN_HOST_VERSION='0.8.1';
export const NATIVE_MODEL_QUERY_OPERATION_BY_TOOL=freeze({revit_health:'health',revit_get_document_info:'get_document_info',revit_list_views:'list_views',revit_get_element_parameters:'get_element_parameters',revit_get_elements_by_type:'get_elements_by_type',revit_get_element_geometry:'get_element_geometry'});
export const NATIVE_MODEL_QUERY_NAMES=freeze(Object.keys(NATIVE_MODEL_QUERY_OPERATION_BY_TOOL));

const pilotOperations=freeze({
  revit_list_sheets:'list_sheets', revit_get_sheet_info:'get_sheet_info', revit_list_titleblocks:'list_titleblocks',
  revit_get_categories:'get_categories', revit_get_worksets:'get_worksets', revit_get_phases:'get_phases',
  revit_get_phase_filters:'get_phase_filters', revit_get_design_options:'get_design_options',
  revit_list_shared_parameters:'list_shared_parameters', revit_list_project_parameters:'list_project_parameters',
  revit_get_warnings:'get_warnings', revit_get_rvt_links:'get_rvt_links', revit_get_link_instances:'get_link_instances',
  revit_get_group_members:'get_group_members', revit_calculate_material_quantities:'calculate_material_quantities', revit_check_clashes:'check_clashes'
});
export const AEC_PILOT_QUERY_NAMES=freeze(Object.keys(pilotOperations));
export const isAecPilotQuery=name=>Object.hasOwn(pilotOperations,name);
const drawingOperations=freeze({revit_get_revision_sequences:'get_revision_sequences',revit_get_schedule_data:'get_schedule_data'});
export const AEC_DRAWING_QUERY_NAMES=freeze(Object.keys(drawingOperations));
export const isAecDrawingQuery=name=>Object.hasOwn(drawingOperations,name);
export const MODEL_PREPARATION_QUERY_NAME='revit_get_model_preparation';
export const MODEL_PREPARATION_OPERATION='get_model_preparation';
export const PROJECT_BINDING_PREVIEW_NAME='revit_preview_project_parameter_binding';
export const PROJECT_BINDING_PREVIEW_OPERATION='preview_project_parameter_binding';
export const PIPE_NETWORK_QUERY_NAME='revit_get_pipe_network';
export const PIPE_NETWORK_OPERATION='get_pipe_network';
const maximumPreparationItems=200;
export const ALL_NATIVE_MODEL_QUERY_OPERATION_BY_TOOL=freeze({...NATIVE_MODEL_QUERY_OPERATION_BY_TOOL,...pilotOperations,...drawingOperations,
  [MODEL_PREPARATION_QUERY_NAME]:MODEL_PREPARATION_OPERATION,[PIPE_NETWORK_QUERY_NAME]:PIPE_NETWORK_OPERATION,[PROJECT_BINDING_PREVIEW_NAME]:PROJECT_BINDING_PREVIEW_OPERATION});
export const ALL_NATIVE_MODEL_QUERY_NAMES=freeze(Object.keys(ALL_NATIVE_MODEL_QUERY_OPERATION_BY_TOOL));
export const isNativeModelQuery=name=>Object.hasOwn(ALL_NATIVE_MODEL_QUERY_OPERATION_BY_TOOL,name);

const view=object({id:exactId,name:text(),view_type:text(160),is_template:bool});
const documentFacts=object({schema_version:{type:'integer',enum:[1]},title:text(),path:text(32768),is_family_document:bool,is_read_only:bool,is_modified:bool,active_view:nullable(view)});
const level=object({id:exactId,name:text()});
const preparationLevel=object({element_id:exactId,name:text(),elevation_mm:{type:'number'},project_elevation_mm:{type:'number'}});
const category=object({id:signedId,name:text(),built_in_category:nullable(text(160))});
const measurement=unit=>object({value:{type:'number',minimum:0},unit:{type:'string',enum:[unit]}});
const point=object({x:{type:'number'},y:{type:'number'},z:{type:'number'}});
const coverage=object({scanned:integer(),complete:{type:'boolean',enum:[true]},stop_reason:nil});
const page=(item,maximum=500,extra={})=>object({schema_version:{type:'integer',enum:[1]},items:{type:'array',items:item,maxItems:maximum},offset:integer(0,2147483647),limit:integer(1,maximum),total:integer(),has_more:bool,coverage,...extra});
const row=object({id:exactId,name:nullable(text()),category:nullable(category),type_id:nullable(exactId),level:nullable(level),length:nullable(measurement('mm')),area:nullable(measurement('m2')),volume:nullable(measurement('m3'))},['id']);
const parameter=object({parameter_id:signedId,name:text(),storage_type:{type:'string',enum:['None','Integer','Double','String','ElementId']},is_read_only:bool,has_value:bool,data_type:nullable(text()),unit_type:nullable(text()),value_internal:{anyOf:[{type:'number'},{type:'string',maxLength:64000},bool,nil]},value_display:nullable(text(64000))});
const unavailable=object(Object.fromEntries(['location','bounding_box','level','length','area','volume'].map(key=>[key,nullable({...text(160),minLength:1})])));
const sheetFields={sheet_number:text(),sheet_name:text(),is_placeholder:bool,viewport_count:integer()};
const viewport=object({viewport_id:exactId,view_id:exactId,view_name:nullable(text())});
const worksetId={anyOf:[integer(0,2147483647),{type:'string',pattern:'^(?:0|[1-9]\\d{0,9})$',maxLength:10}]};
const phaseId={anyOf:[integer(),{type:'string',pattern:'^(?:0|[1-9]\\d{0,18})$',maxLength:19}]};
const guid={type:'string',pattern:'^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$',maxLength:36};
const pilotPage=(item,extra)=>page(item,200,extra);
const idString=exactId.anyOf[1];
const groupMemberFields=['name','category','type_id'];
const scheduleIndex=integer(0,2147483647);
const scheduleRows={...integer(1,100),default:50},scheduleColumns={...integer(1,100),default:20};
const scheduleCell=object({column_index:scheduleIndex,text:text(64000)});
const warningIds={type:'array',items:idString,maxItems:200,uniqueItems:true};
const vector={type:'array',items:{type:'number'},minItems:3,maxItems:3};
const linkTransform=object({origin_feet:vector,basis_x:vector,basis_y:vector,basis_z:vector});
const maxHops={...integer(1,12),default:6};
const connectorId=integer(0,2147483647);
const pipeNetworkNode=object({id:idString,unique_id:{...text(512),minLength:1},name:text(),
  kind:{type:'string',enum:['root','pipe','fitting','valve','pipe_accessory','equipment_boundary']},hop:integer(0,12)});
const pipeNetworkEdge=object({from_element_id:idString,from_connector_id:connectorId,to_element_id:idString,to_connector_id:connectorId});
export const NATIVE_MODEL_QUERY_RESULT_SCHEMAS=freeze({
  revit_health:object({schema_version:{type:'integer',enum:[1]},status:{type:'string',enum:['ready','no_document']},document_open:bool}),
  revit_get_document_info:documentFacts,
  revit_list_views:page(view),
  revit_get_element_parameters:object({schema_version:{type:'integer',enum:[1]},element_id:exactId,element_name:nullable(text()),parameters:{type:'array',items:parameter,maxItems:2000}}),
  revit_get_elements_by_type:page(row),
  revit_get_element_geometry:object({schema_version:{type:'integer',enum:[1]},element_id:exactId,representation:{type:'string',enum:['summary_no_mesh']},coordinate_system:{type:'string',enum:['revit_internal']},location:nullable({anyOf:[object({kind:{type:'string',enum:['point']},point_mm:point}),object({kind:{type:'string',enum:['curve']},start_mm:point,end_mm:point})]}),bounding_box:nullable(object({min_mm:point,max_mm:point})),level:nullable(level),length:nullable(measurement('mm')),area:nullable(measurement('m2')),volume:nullable(measurement('m3')),unavailable}),
  revit_list_sheets:pilotPage(object({id:exactId,...sheetFields})),
  revit_get_sheet_info:object({schema_version:{type:'integer',enum:[1]},sheet_id:exactId,...sheetFields,
    viewports:{type:'array',items:viewport,maxItems:2000},parameters:{type:'array',items:parameter,maxItems:2000}}),
  revit_list_titleblocks:pilotPage(object({id:exactId,family_name:text(),type_name:text(),full_name:text(2050)})),
  revit_get_categories:pilotPage(category),
  revit_get_worksets:pilotPage(object({id:worksetId,name:text(),is_open:bool}),{is_workshared:bool}),
  revit_get_phases:pilotPage(object({id:phaseId,name:text()})),
  revit_get_phase_filters:pilotPage(level),
  revit_get_design_options:pilotPage(object({id:exactId,name:text(),set_id:nullable(exactId)})),
  revit_list_shared_parameters:pilotPage(object({id:exactId,name:text(),guid,definition_group:nullable(text())})),
  revit_list_project_parameters:pilotPage(object({id:exactId,name:text(),parameter_type:nullable(text())})),
  revit_get_warnings:pilotPage(object({failure_definition_id:guid,severity:{...text(64),minLength:1},description:text(8192),
    failing_element_ids:warningIds,additional_element_ids:warningIds})),
  revit_get_rvt_links:pilotPage(object({id:idString,name:text(),is_loaded:bool,is_nested:bool})),
  revit_get_link_instances:pilotPage(object({id:idString,type_id:idString,name:text(),is_loaded:bool,transform:nullable(linkTransform)})),
  revit_check_clashes:pilotPage(object({element1_id:idString,element2_id:idString}),{category1:text(160),category2:text(160),tolerance_feet:{type:'number',minimum:0,maximum:10},method:{type:'string',enum:['expanded_axis_aligned_bounding_box']},solid_intersection_tested:{type:'boolean',enum:[false]},element_count1:integer(),element_count2:integer(),missing_box_count1:integer(),missing_box_count2:integer(),pairs_checked:integer(0,50000)}),
  revit_calculate_material_quantities:pilotPage(object({material_id:idString,name:text(),volume_cubic_feet:{type:'number',minimum:0},element_count:integer(1)},['material_id','volume_cubic_feet']),{category:text(160),element_count:integer(),includes_paint:{type:'boolean',enum:[false]}}),
  revit_get_group_members:pilotPage(object({id:idString,name:nullable(text()),category:nullable(object({...category.properties,id:signedId.anyOf[1]})),type_id:nullable(idString)},['id']),{group_id:idString}),
  revit_get_revision_sequences:pilotPage(object({id:idString,name:text(),date:nullable(text()),description:nullable(text(8192)),sequence:integer(1),issued:bool})),
  revit_get_schedule_data:object({schema_version:{type:'integer',enum:[1]},schedule_id:idString,schedule_name:text(),
    section:{type:'string',enum:['body']},first_row:scheduleIndex,first_column:scheduleIndex,row_count:scheduleIndex,column_count:scheduleIndex,
    row_offset:scheduleIndex,row_limit:integer(1,100),column_offset:scheduleIndex,column_limit:integer(1,100),has_more:bool,has_more_columns:bool,
    rows:{type:'array',maxItems:100,items:object({row_index:scheduleIndex,cells:{type:'array',maxItems:100,items:scheduleCell}})},coverage}),
  [MODEL_PREPARATION_QUERY_NAME]:object({
    schema_version:{type:'integer',enum:[1]},document:documentFacts,
    selection_ids:{type:'array',items:exactId,maxItems:maximumPreparationItems,uniqueItems:true},
    levels:{type:'array',items:preparationLevel,maxItems:maximumPreparationItems}
  }),
  [PROJECT_BINDING_PREVIEW_NAME]:object({schema_version:{type:'integer',enum:[1]},definition_guid:guid,definition_id:idString,data_type:{...text(1024),minLength:1},definition_name:{...text(1024),minLength:1},document_title:{...text(1024),minLength:1},document_path:{...text(32768),minLength:1},binding_before:{type:'string',enum:['unbound']},proposed_binding:{type:'string',enum:['instance']},category_ids:{type:'array',items:{type:'string',maxLength:20},minItems:1,maxItems:30},instance_count:integer(0,500),instances:{type:'array',maxItems:500,items:object({element_id:idString,category_id:{type:'string',maxLength:20},unique_id:{...text(512),minLength:1}})},coverage:{type:'string',enum:['complete_current_document_instances']},future_instances_affected:{type:'boolean',enum:[true]},authorization:{type:'string',enum:['not_granted']},host_session_bound:{type:'boolean',enum:[false]},human_decision:{type:'boolean',enum:[false]},binding_attempted:{type:'boolean',enum:[false]},external_file_accessed:{type:'boolean',enum:[false]}}),
  [PIPE_NETWORK_QUERY_NAME]:object({schema_version:{type:'integer',enum:[1]},root_element_id:idString,
    max_hops:integer(1,12),nodes:{type:'array',minItems:1,maxItems:300,items:pipeNetworkNode},
    edges:{type:'array',maxItems:800,items:pipeNetworkEdge},boundary_reached:bool})
});
// The transport owns these facts; publishing its full envelope retains document
// and request evidence beside the independently named business result schema.
const documentIdentity={type:'object',properties:{title:text(),path:text(32768)},required:['title','path'],additionalProperties:true};
export const NATIVE_MODEL_QUERY_OUTPUT_SCHEMAS=freeze(Object.fromEntries(ALL_NATIVE_MODEL_QUERY_NAMES.map(name=>[name,{
  type:'object',properties:{
    operation:{type:'string',enum:[ALL_NATIVE_MODEL_QUERY_OPERATION_BY_TOOL[name]]},
    hostSession:{type:'string',minLength:1,maxLength:160},
    document:name==='revit_health'?nullable(documentIdentity):documentIdentity,
    modifiedByOperation:{type:'boolean',enum:[false]},
    value:NATIVE_MODEL_QUERY_RESULT_SCHEMAS[name],snapshot:{type:'object'},
    request_id:{type:'string',minLength:1,maxLength:160}
  },required:['operation','hostSession','document','modifiedByOperation','value','snapshot','request_id'],additionalProperties:true
}])));
function tool(name,description,properties={},required=[]){return {name,description,inputSchema:object({expected_document:expectedDocument,...properties},required),outputSchema:NATIVE_MODEL_QUERY_OUTPUT_SCHEMAS[name],annotations:{readOnlyHint:true}};}
export const NATIVE_MODEL_QUERY_TOOLS=freeze([
  tool('revit_health','Read native BuildX Revit host responsiveness and whether an active document exists. Requires host 0.8.1 and nativeModelQueriesVersion 1; a timeout is an unknown result, never proof that Revit stopped.'),
  tool('revit_get_document_info','Read current project/family document facts and active view in one native atomic callback.'),
  tool('revit_list_views','List native views by ascending exact ID with bounded pagination. Coverage is complete only when the entire bounded collector was scanned; over-budget scans fail explicitly.',pagination),
  tool('revit_get_element_parameters','Read parameter identity, storage type, raw internal value, display value, units and writeability. Element IDs above the JSON safe-integer range must be decimal strings.',{element_id:exactId},['element_id']),
  tool('revit_get_elements_by_type','Read current-document instances by exact type ID, category and level. category accepts OST enum names or explicit English aliases (Walls, Doors, Pipes, Ducts); level is an exact unambiguous name, level_id an exact ID. id is always returned; requested fields alone select additional facts. length/area/volume carry mm/m2/m3 units. Scans over budget fail rather than claiming full coverage.',{type_id:exactId,category:{...text(160),description:'Exact OST enum name or supported English alias; empty means all categories.'},level:{...text(),minLength:1,description:'Exact level name; duplicates fail. Use level_id to disambiguate.'},level_id:exactId,fields:{type:'array',items:{type:'string',enum:fields},uniqueItems:true,maxItems:7,default:NATIVE_MODEL_QUERY_DEFAULT_FIELDS},...pagination}),
  tool('revit_get_element_geometry','Read bounded geometry summary, not a mesh: point/curve location and transformed bounding box in Revit internal model axes (mm), level, length (mm), area (m2), volume (m3). Unavailable facts are null with an explicit reason.',{element_id:exactId},['element_id'])
]);
export const AEC_PILOT_QUERY_TOOLS=freeze([
  tool('revit_list_sheets','List current-document sheets by sheet number and ID, including placeholders and viewport counts. Bounded pagination.',pilotPagination),
  tool('revit_get_sheet_info','Read one sheet by exact ElementId, with viewport and parameter facts. Does not activate a view.',{sheet_id:exactId},['sheet_id']),
  tool('revit_list_titleblocks','List loaded title block types and family names. Bounded pagination.',pilotPagination),
  tool('revit_get_categories','List top-level model categories that allow subcategories, with signed category IDs and available built-in identities. Bounded pagination.',pilotPagination),
  tool('revit_get_worksets','List user worksets in the current document, with an explicit worksharing flag. Bounded pagination.',pilotPagination),
  tool('revit_get_phases','List current-document phases by ID. Bounded pagination.',pilotPagination),
  tool('revit_get_phase_filters','List current-document phase filters by ID. Bounded pagination.',pilotPagination),
  tool('revit_get_design_options','List current-document design options and available option-set IDs. Bounded pagination.',pilotPagination),
  tool('revit_list_shared_parameters','List shared parameter definitions present in the current document, without reading a shared-parameter file. Bounded pagination.',pilotPagination),
  tool('revit_list_project_parameters','List current-document parameter elements, including shared definitions, with available data type IDs. Bounded pagination.',pilotPagination),
  tool('revit_get_warnings','Read current Revit warnings with failure definition, severity and affected element IDs. Warnings of the same kind may repeat. Bounded pagination; no automatic fixes.',pilotPagination),
  tool('revit_get_rvt_links','List Revit link types, including unloaded and nested links. Does not return link file paths or contents. Bounded pagination.',pilotPagination),
  tool('revit_get_link_instances','List Revit link placements and their type IDs and load state. A known transform maps linked model coordinates to host internal coordinates: origin in feet, unitless bases. Bounded pagination.',pilotPagination),
  tool('revit_check_clashes','Find approximate expanded bounding-box intersection candidates within the current document. Not a solid intersection test. Missing boxes are counted; scans and 50000 pairs are bounded. Same category returns each unordered pair once.',{category1:{...text(160),minLength:1},category2:{...text(160),minLength:1},tolerance_feet:{type:'number',minimum:0,maximum:10,default:0.01},...pilotPagination},['category1','category2']),
  tool('revit_calculate_material_quantities','Sum non-paint material volumes in cubic feet by exact material ID for all instances of one category. Full bounded scan; pagination applies to material totals. Fails without partial results on budget or invalid values. No linked models.',{category:{...text(160),minLength:1},fields:{type:'array',items:{type:'string',enum:['name','element_count']},uniqueItems:true,maxItems:2,default:[]},...pilotPagination},['category']),
  tool('revit_get_group_members','Read direct members of a current-document model group instance by exact ElementId, in Revit member order. Page IDs and request name, category or type_id only as needed. Nested groups are returned as member IDs.',
    {group_id:exactId,...pilotPagination,fields:{type:'array',items:{type:'string',enum:groupMemberFields},uniqueItems:true,maxItems:groupMemberFields.length,default:[]}},['group_id'])
]);
export const AEC_DRAWING_QUERY_TOOLS=freeze([
  tool('revit_get_revision_sequences','List current-document revision instances in revision sequence order. Paginated; returns revision identity, name, date, description and issued state.',pilotPagination),
  tool('revit_get_schedule_data','Read formatted cells from a schedule body by exact schedule ID. Page rows and columns independently; defaults to 50 rows and 20 columns. Headers and raw parameter values are outside this query.',
    {schedule_id:exactId,row_offset:pagination.offset,row_limit:scheduleRows,column_offset:pagination.offset,column_limit:scheduleColumns},['schedule_id'])
]);
export const MODEL_PREPARATION_QUERY_TOOL=freeze(tool(MODEL_PREPARATION_QUERY_NAME,'Read the current document, view, selection IDs and level elevations in one Revit callback. Use when both selection and levels are needed. More than 200 selected elements or 200 levels fails without partial results.'));
export const PIPE_NETWORK_QUERY_TOOL=freeze(tool(PIPE_NETWORK_QUERY_NAME,'Trace physical Revit piping connectors from a selected pump or other family instance. Returns pipes, fittings, identified valves, other pipe accessories and equipment boundaries. Edges express connectivity, without flow direction. Scope is the current document and the requested hop limit.',
  {start_element_id:exactId,max_hops:maxHops},['start_element_id']));
export const PROJECT_BINDING_PREVIEW_TOOL=freeze(tool(PROJECT_BINDING_PREVIEW_NAME,'Read-only bounded preview of a currently loaded, unbound shared parameter definition and complete current instance impact. Does not create or bind parameters or approve any change.',{definition_guid:guid,definition_id:exactId,data_type:{...text(1024),minLength:1},category_ids:{type:'array',minItems:1,maxItems:30,uniqueItems:true,items:{type:'string',maxLength:20}}},['expected_document','definition_guid','definition_id','data_type','category_ids']));
const contracts=new Map([...NATIVE_MODEL_QUERY_TOOLS,...AEC_PILOT_QUERY_TOOLS,...AEC_DRAWING_QUERY_TOOLS,MODEL_PREPARATION_QUERY_TOOL,PIPE_NETWORK_QUERY_TOOL,PROJECT_BINDING_PREVIEW_TOOL].map(value=>[value.name,value]));
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const failure=message=>{throw new Error('Native model query contract: '+message);};
function validate(rule,value,at){
  if(rule.anyOf){for(const candidate of rule.anyOf){try{return validate(candidate,value,at);}catch{}}failure(at+' does not match its named schema');}
  if(rule.enum&&!rule.enum.includes(value))failure(at+' has an unsupported value');
  if(rule.type==='null'){if(value!==null)failure(at+' must be null');return null;}
  if(rule.type==='boolean'){if(typeof value!=='boolean')failure(at+' must be boolean');}
  if(rule.type==='number'||rule.type==='integer'){
    if(typeof value!=='number'||!Number.isFinite(value)||rule.type==='integer'&&!Number.isSafeInteger(value)||rule.minimum!==undefined&&value<rule.minimum||rule.maximum!==undefined&&value>rule.maximum)failure(at+' is not a bounded exact number');
  }
  if(rule.type==='string'){
    if(typeof value!=='string'||rule.minLength!==undefined&&value.length<rule.minLength||rule.maxLength!==undefined&&value.length>rule.maxLength||rule.pattern&&!new RegExp(rule.pattern).test(value))failure(at+' is not a bounded string');
  }
  if(rule.type==='array'){
    if(!Array.isArray(value)||rule.minItems!==undefined&&value.length<rule.minItems||rule.maxItems!==undefined&&value.length>rule.maxItems)failure(at+' is not a bounded array');
    const result=value.map((entry,index)=>validate(rule.items,entry,at+'['+index+']'));
    if(rule.uniqueItems&&new Set(result.map(entry=>JSON.stringify(entry))).size!==result.length)failure(at+' has duplicates');
    return result;
  }
  if(rule.type==='object'){
    if(!plain(value))failure(at+' must be a plain object');
    for(const key of Object.keys(value))if(!Object.hasOwn(rule.properties,key))failure(at+'.'+key+' is unknown');
    for(const key of rule.required)if(!Object.hasOwn(value,key))failure(at+'.'+key+' is missing');
    const result={};
    for(const [key,property] of Object.entries(rule.properties)){
      if(Object.hasOwn(value,key))result[key]=validate(property,value[key],at+'.'+key);
      else if(Object.hasOwn(property,'default'))result[key]=structuredClone(property.default);
    }
    return result;
  }
  return value;
}
function assertId(value,{signed=false,at='ID'}={}){
  if(typeof value==='number'){if(!Number.isSafeInteger(value)||!signed&&value<1)failure(at+' is not an exact ID');return BigInt(value);}
  if(typeof value!=='string'||!(signed?/^-?(?:0|[1-9]\d{0,18})$/:/^[1-9]\d{0,18}$/).test(value))failure(at+' is not a canonical decimal ID');
  const number=BigInt(value);
  if(number>9223372036854775807n||number<(signed?-9223372036854775808n:1n)||value==='-0')failure(at+' is outside Int64');
  return number;
}
export {assertId as nativeModelQueryExactId};
function sameId(actual,expected,at){if(assertId(actual,{at})!==assertId(expected,{at}))failure(at+' differs from requested identity');}
function assertPageCoverage(value,args,defaultLimit){
  const offset=args.offset??0,limit=args.limit??defaultLimit;
  if(value.offset!==offset||value.limit!==limit||value.items.length!==Math.min(limit,Math.max(0,value.total-offset))||value.has_more!==(offset+limit<value.total)||value.coverage.scanned<value.total)failure('pagination or scan coverage is inconsistent');
}
function assertParameterFacts(parameters){
  const seen=new Set();
  for(const item of parameters){
    const id=assertId(item.parameter_id,{signed:true}).toString();if(seen.has(id))failure('duplicate parameter identity');seen.add(id);
    if(!item.has_value&&item.value_internal!==null)failure('missing parameter value must be explicit null');
    if(item.storage_type==='ElementId'&&item.value_internal!==null)assertId(item.value_internal,{signed:true,at:'parameter reference'});
    if(item.storage_type==='Double'&&item.value_internal!==null&&typeof item.value_internal!=='number')failure('Double parameter requires raw number');
    if(item.storage_type==='Integer'&&item.value_internal!==null&&!Number.isSafeInteger(item.value_internal))failure('Integer parameter requires exact integer');
    if(item.storage_type==='String'&&item.value_internal!==null&&typeof item.value_internal!=='string')failure('String parameter requires raw string');
  }
}
const compare=(a,b)=>a<b?-1:a>b?1:0;
function orderedWarningIds(ids){
  const exact=ids.map(id=>assertId(id));
  if(exact.some((id,index)=>index>0&&id<=exact[index-1]))failure('warning element IDs must be unique and ordered');
  return exact;
}
function compareIdLists(a,b){
  for(let index=0;index<Math.min(a.length,b.length);index++){
    const order=compare(a[index],b[index]);
    if(order)return order;
  }
  return compare(a.length,b.length);
}
function assertWarningOrder(items){
  let previous=null;
  for(const item of items){
    const key=[item.failure_definition_id,item.severity,item.description,
      orderedWarningIds(item.failing_element_ids),orderedWarningIds(item.additional_element_ids)];
    if(previous&&(compare(previous[0],key[0])||compare(previous[1],key[1])||compare(previous[2],key[2])||
      compareIdLists(previous[3],key[3])||compareIdLists(previous[4],key[4]))>0)failure('warnings must be ordered');
    previous=key;
  }
}
function assertPilotResult(name,value,args){
  if(name==='revit_get_sheet_info'){
    assertId(value.sheet_id);
    if(args.sheet_id!==undefined)sameId(value.sheet_id,args.sheet_id,'sheet_id');
    if(value.viewport_count!==value.viewports.length)failure('viewport count differs from the returned detail');
    const seen=new Set();
    for(const viewport of value.viewports){
      const id=assertId(viewport.viewport_id);
      assertId(viewport.view_id);
      if(seen.has(id))failure('duplicate viewport identity');
      seen.add(id);
    }
    assertParameterFacts(value.parameters);
    return;
  }
  assertPageCoverage(value,args,100);
  if(name==='revit_get_warnings'){assertWarningOrder(value.items);return;}
  if(name==='revit_check_clashes'){
    const c1=nativeModelQueryCategoryIdentity(args.category1),c2=nativeModelQueryCategoryIdentity(args.category2),same=c1===c2;
    if(value.category1!==c1||value.category2!==c2||value.tolerance_feet!==(args.tolerance_feet??0.01))failure('clash request differs from response');
    if(value.missing_box_count1>value.element_count1||value.missing_box_count2>value.element_count2)failure('invalid missing-box count');
    if(same&&(value.element_count1!==value.element_count2||value.missing_box_count1!==value.missing_box_count2))failure('same-category coverage differs');
    const n=value.element_count1-value.missing_box_count1,m=value.element_count2-value.missing_box_count2;
    if(value.pairs_checked!==(same?n*(n-1)/2:n*m)||value.total>value.pairs_checked)failure('clash pair coverage differs');
    let previous1=0n,previous2=0n;
    for(const item of value.items){const a=assertId(item.element1_id),b=assertId(item.element2_id);if(a===b||same&&a>=b||a<previous1||a===previous1&&b<=previous2)failure('invalid clash candidate ordering');previous1=a;previous2=b;}
    return;
  }
  if(name==='revit_calculate_material_quantities'){
    if(args.category&&value.category!==nativeModelQueryCategoryIdentity(args.category))failure('category identity differs from filter');
    let previous=0n;
    for(const item of value.items){const id=assertId(item.material_id);if(id<=previous)failure('material IDs not strictly ordered');previous=id;if(item.element_count>value.element_count)failure('material count exceeds category count');const fields=args.fields??[];if(Object.keys(item).length!==2+fields.length||fields.some(field=>!Object.hasOwn(item,field)))failure('material fields differ from request');}
    return;
  }
  if(name==='revit_get_group_members'){
    const groupId=assertId(value.group_id),requested=args.fields??[],seen=new Set();
    if(args.group_id!==undefined)sameId(value.group_id,args.group_id,'group_id');
    if(value.coverage.scanned!==value.total)failure('group member coverage is inconsistent');
    for(const item of value.items){
      const id=assertId(item.id);
      if(id===groupId||seen.has(id))failure('duplicate or invalid group member identity');
      seen.add(id);
      if(Object.keys(item).length!==1+requested.length||requested.some(key=>!Object.hasOwn(item,key)))failure('group member fields differ from requested fields');
      if(item.category)assertId(item.category.id,{signed:true});
      if(item.type_id!==undefined&&item.type_id!==null)assertId(item.type_id);
    }
    return;
  }
  if(name==='revit_get_worksets'&&!value.is_workshared&&value.total!==0)failure('a non-workshared document cannot return user worksets');
  // The result schemas constrain workset and phase IDs to non-negative values.
  const signed=name==='revit_get_categories'||name==='revit_get_worksets'||name==='revit_get_phases';
  const sheets=name==='revit_list_sheets';
  const seen=new Set();
  let previous=null,previousNumber=null;
  for(const item of value.items){
    const id=assertId(item.id,{signed});
    if(name==='revit_get_worksets'&&(id<0n||id>2147483647n))failure('workset ID is outside the supported range');
    if(name==='revit_get_design_options'&&item.set_id!==null)assertId(item.set_id);
    if(name==='revit_get_link_instances')assertId(item.type_id);
    if(seen.has(id))failure('duplicate page identity');
    if(previous!==null&&(!sheets&&id<=previous||sheets&&(item.sheet_number<previousNumber||item.sheet_number===previousNumber&&id<=previous)))failure('page identities must be ordered');
    seen.add(id);
    previous=id;
    if(sheets)previousNumber=item.sheet_number;
  }
}
function assertDrawingResult(name,value,args){
  if(name==='revit_get_revision_sequences'){
    assertPageCoverage(value,args,100);
    const seen=new Set();let previousSequence=0,previousId=0n;
    for(const revision of value.items){
      const id=assertId(revision.id);
      if(seen.has(id)||revision.sequence<previousSequence||revision.sequence===previousSequence&&id<=previousId)failure('revision page order or identity is invalid');
      seen.add(id);previousSequence=revision.sequence;previousId=id;
    }
    return;
  }
  if(args.schedule_id!==undefined)sameId(value.schedule_id,args.schedule_id,'schedule_id');
  else assertId(value.schedule_id);
  const {row_offset:rowOffset,row_limit:rowLimit,column_offset:columnOffset,column_limit:columnLimit}=value;
  const rowCount=Math.min(rowLimit,Math.max(0,value.row_count-rowOffset));
  const columnCount=Math.min(columnLimit,Math.max(0,value.column_count-columnOffset));
  if(rowOffset!==(args.row_offset??0)||rowLimit!==(args.row_limit??50)||columnOffset!==(args.column_offset??0)||columnLimit!==(args.column_limit??20)||
     value.rows.length!==rowCount||value.has_more!==(rowOffset+rowLimit<value.row_count)||
     value.has_more_columns!==(columnOffset+columnLimit<value.column_count)||rowCount*columnCount>2000||value.coverage.scanned!==rowCount*columnCount)
    failure('schedule pagination or coverage is inconsistent');
  for(const [i,row] of value.rows.entries()){
    if(row.row_index!==value.first_row+rowOffset+i||row.cells.length!==columnCount||
       row.cells.some((cell,j)=>cell.column_index!==value.first_column+columnOffset+j))failure('schedule cell range is inconsistent');
  }
}
function assertPipeNetwork(value,args){
  const root=value.root_element_id;
  assertId(root);
  if(args.start_element_id!==undefined)sameId(root,args.start_element_id,'root_element_id');
  if(value.max_hops!==(args.max_hops??6))failure('network hop limit differs from the request');
  const nodes=new Map(),uniqueIds=new Set(),neighbours=new Map();
  for(const node of value.nodes){
    assertId(node.id);
    if(nodes.has(node.id)||uniqueIds.has(node.unique_id))failure('duplicate network element identity');
    if((node.id===root)!==(node.kind==='root')||(node.id===root)!==(node.hop===0)||node.hop>value.max_hops)failure('invalid network node scope');
    nodes.set(node.id,node);
    uniqueIds.add(node.unique_id);
    neighbours.set(node.id,new Set());
  }
  if(!nodes.has(root))failure('network root is missing');
  const edgeKeys=new Set();
  for(const edge of value.edges){
    const from=edge.from_element_id,to=edge.to_element_id;
    if(from===to||!nodes.has(from)||!nodes.has(to))failure('network edge refers to an invalid endpoint');
    const key=[from+':'+edge.from_connector_id,to+':'+edge.to_connector_id].sort().join('/');
    if(edgeKeys.has(key))failure('duplicate network connector edge');
    edgeKeys.add(key);
    neighbours.get(from).add(to);
    neighbours.get(to).add(from);
  }
  const queue=[root],distance=new Map([[root,0]]);
  for(const id of queue){
    const node=nodes.get(id),hop=distance.get(id);
    if(node.hop!==hop)failure('network hop differs from the reachable distance');
    if(node.kind==='equipment_boundary'||hop===value.max_hops)continue;
    for(const next of neighbours.get(id)){
      if(distance.has(next))continue;
      distance.set(next,hop+1);
      queue.push(next);
    }
  }
  if(distance.size!==nodes.size)failure('network contains unreachable elements');
  if(!value.boundary_reached&&value.nodes.some(node=>node.kind==='equipment_boundary'))failure('network equipment boundary was not reported');
}
export function supportsNativeModelQueries(host,operation){
  const version=/^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(host?.version??'');
  const supported=version&&(Number(version[1])>0||Number(version[2])>8||Number(version[2])===8&&Number(version[3])>=1);
  const operations=host?.nativeModelQueryOperations;
  if(operation===PROJECT_BINDING_PREVIEW_OPERATION && host?.projectBindingPreviewVersion!==1)return false;
  return Boolean(supported&&host.atomicReadSnapshot===true&&host.nativeModelQueriesVersion===NATIVE_MODEL_QUERIES_VERSION&&Array.isArray(operations)&&new Set(operations).size===operations.length&&(operation?operations.includes(operation):Object.values(NATIVE_MODEL_QUERY_OPERATION_BY_TOOL).every(value=>operations.includes(value))));
}
export function assertNativeModelQueryArguments(name,args){
  const contract=contracts.get(name);if(!contract)failure('unknown named query');
  const schema=name===PROJECT_BINDING_PREVIEW_NAME&&!Object.hasOwn(args,'expected_document')?{...contract.inputSchema,required:contract.inputSchema.required.filter(k=>k!=='expected_document')}:contract.inputSchema;
  const result=validate(schema,args,'arguments');
  if(name===PROJECT_BINDING_PREVIEW_NAME)validateProjectBindingPreviewArguments(result,{allowDocumentBinding:true});
  for(const key of ['element_id','type_id','level_id','sheet_id','schedule_id','group_id','start_element_id'])if(Object.hasOwn(result,key))assertId(result[key],{at:key});
  if(result.category)nativeModelQueryCategoryIdentity(result.category);
  if(result.category1)nativeModelQueryCategoryIdentity(result.category1);
  if(result.category2)nativeModelQueryCategoryIdentity(result.category2);
  return result;
}
export function assertNativeModelQueryResult(name,value,args={}){
  const contract=contracts.get(name);if(!contract)failure('unknown named query');
  validate(NATIVE_MODEL_QUERY_RESULT_SCHEMAS[name],value,'result');
  if(name===PROJECT_BINDING_PREVIEW_NAME){validateProjectBindingPreview(value,args);return value;}
  if(name===PIPE_NETWORK_QUERY_NAME){assertPipeNetwork(value,args);return value;}
  if(isAecPilotQuery(name)){assertPilotResult(name,value,args);return value;}
  if(Object.hasOwn(drawingOperations,name)){assertDrawingResult(name,value,args);return value;}
  if(name==='revit_health'&&value.document_open!==(value.status==='ready'))failure('health document status is inconsistent');
  if(name==='revit_get_document_info'||name===MODEL_PREPARATION_QUERY_NAME){
    const document=name===MODEL_PREPARATION_QUERY_NAME?value.document:value;
    if(Object.hasOwn(args,'expected_document')&&document.path!==args.expected_document)failure('document path changed');
    if(document.active_view)assertId(document.active_view.id);
  }
  if(name===MODEL_PREPARATION_QUERY_NAME){
    for(const ids of [value.selection_ids,value.levels.map(level=>level.element_id)]){
      let previous=0n;
      for(const id of ids){
        const exact=assertId(id);
        if(exact<=previous)failure('preparation IDs must be unique and ordered');
        previous=exact;
      }
    }
  }
  if(name==='revit_list_views'||name==='revit_get_elements_by_type'){
    assertPageCoverage(value,args,200);
    let previous=0n;
    const requested=args.fields??NATIVE_MODEL_QUERY_DEFAULT_FIELDS;
    for(const item of value.items){
      const id=assertId(item.id);if(id<=previous)failure('page identities must be unique and ordered');previous=id;
      if(name==='revit_get_elements_by_type'){
        const keys=Object.keys(item).filter(key=>key!=='id');
        if(keys.length!==requested.length||requested.some(key=>!Object.hasOwn(item,key)))failure('returned fields differ from requested fields');
        if(requested.includes('type_id')&&args.type_id!==undefined&&item.type_id===null)failure('filtered type identity is missing');
        if(requested.includes('level')&&(args.level_id!==undefined||args.level!==undefined)&&item.level===null)failure('filtered level identity is missing');
        if(requested.includes('category')&&args.category&&item.category===null)failure('filtered category identity is missing');
        if(item.type_id!==undefined&&item.type_id!==null){assertId(item.type_id);if(args.type_id!==undefined)sameId(item.type_id,args.type_id,'type_id');}
        if(item.level){assertId(item.level.id);if(args.level_id!==undefined)sameId(item.level.id,args.level_id,'level_id');if(args.level!==undefined&&item.level.name!==args.level)failure('level name differs from filter');}
        if(item.category){assertId(item.category.id,{signed:true});const categoryName=args.category?nativeModelQueryCategoryIdentity(args.category):null;if(categoryName&&item.category.built_in_category!==categoryName)failure('category identity differs from filter');}
      }
    }
  }
  if(name==='revit_get_element_parameters'||name==='revit_get_element_geometry'){
    assertId(value.element_id);if(args.element_id!==undefined)sameId(value.element_id,args.element_id,'element_id');
  }
  if(name==='revit_get_element_parameters')assertParameterFacts(value.parameters);
  if(name==='revit_get_element_geometry'){
    if(value.level)assertId(value.level.id);
    for(const key of Object.keys(value.unavailable))if((value[key]===null)!==(typeof value.unavailable[key]==='string'))failure(key+' missing fact must retain its reason');
    if(value.bounding_box)for(const axis of ['x','y','z'])if(value.bounding_box.min_mm[axis]>value.bounding_box.max_mm[axis])failure('bounding box min exceeds max');
  }
  return value;
}
