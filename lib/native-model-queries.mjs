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
export const isNativeModelQuery=name=>Object.hasOwn(NATIVE_MODEL_QUERY_OPERATION_BY_TOOL,name);

const view=object({id:exactId,name:text(),view_type:text(160),is_template:bool});
const level=object({id:exactId,name:text()});
const category=object({id:signedId,name:text(),built_in_category:nullable(text(160))});
const measurement=unit=>object({value:{type:'number',minimum:0},unit:{type:'string',enum:[unit]}});
const point=object({x:{type:'number'},y:{type:'number'},z:{type:'number'}});
const coverage=object({scanned:integer(),complete:{type:'boolean',enum:[true]},stop_reason:nil});
const page=item=>object({schema_version:{type:'integer',enum:[1]},items:{type:'array',items:item,maxItems:500},offset:integer(0,2147483647),limit:integer(1,500),total:integer(),has_more:bool,coverage});
const row=object({id:exactId,name:nullable(text()),category:nullable(category),type_id:nullable(exactId),level:nullable(level),length:nullable(measurement('mm')),area:nullable(measurement('m2')),volume:nullable(measurement('m3'))},['id']);
const parameter=object({parameter_id:signedId,name:text(),storage_type:{type:'string',enum:['None','Integer','Double','String','ElementId']},is_read_only:bool,has_value:bool,data_type:nullable(text()),unit_type:nullable(text()),value_internal:{anyOf:[{type:'number'},{type:'string',maxLength:64000},bool,nil]},value_display:nullable(text(64000))});
const unavailable=object(Object.fromEntries(['location','bounding_box','level','length','area','volume'].map(key=>[key,nullable({...text(160),minLength:1})])));
export const NATIVE_MODEL_QUERY_RESULT_SCHEMAS=freeze({
  revit_health:object({schema_version:{type:'integer',enum:[1]},status:{type:'string',enum:['ready','no_document']},document_open:bool}),
  revit_get_document_info:object({schema_version:{type:'integer',enum:[1]},title:text(),path:text(32768),is_family_document:bool,is_read_only:bool,is_modified:bool,active_view:nullable(view)}),
  revit_list_views:page(view),
  revit_get_element_parameters:object({schema_version:{type:'integer',enum:[1]},element_id:exactId,element_name:nullable(text()),parameters:{type:'array',items:parameter,maxItems:2000}}),
  revit_get_elements_by_type:page(row),
  revit_get_element_geometry:object({schema_version:{type:'integer',enum:[1]},element_id:exactId,representation:{type:'string',enum:['summary_no_mesh']},coordinate_system:{type:'string',enum:['revit_internal']},location:nullable({anyOf:[object({kind:{type:'string',enum:['point']},point_mm:point}),object({kind:{type:'string',enum:['curve']},start_mm:point,end_mm:point})]}),bounding_box:nullable(object({min_mm:point,max_mm:point})),level:nullable(level),length:nullable(measurement('mm')),area:nullable(measurement('m2')),volume:nullable(measurement('m3')),unavailable})
});
// The transport owns these facts; publishing its full envelope retains document
// and request evidence beside the independently named business result schema.
const documentIdentity={type:'object',properties:{title:text(),path:text(32768)},required:['title','path'],additionalProperties:true};
export const NATIVE_MODEL_QUERY_OUTPUT_SCHEMAS=freeze(Object.fromEntries(NATIVE_MODEL_QUERY_NAMES.map(name=>[name,{
  type:'object',properties:{
    operation:{type:'string',enum:[NATIVE_MODEL_QUERY_OPERATION_BY_TOOL[name]]},
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
const contracts=new Map(NATIVE_MODEL_QUERY_TOOLS.map(value=>[value.name,value]));
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
    if(!Array.isArray(value)||rule.maxItems!==undefined&&value.length>rule.maxItems)failure(at+' is not a bounded array');
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
function sameId(actual,expected,at){if(assertId(actual,{at})!==assertId(expected,{at}))failure(at+' differs from requested identity');}
export function supportsNativeModelQueries(host,operation){
  const version=/^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(host?.version??'');
  const supported=version&&(Number(version[1])>0||Number(version[2])>8||Number(version[2])===8&&Number(version[3])>=1);
  const operations=host?.nativeModelQueryOperations;
  return Boolean(supported&&host.atomicReadSnapshot===true&&host.nativeModelQueriesVersion===NATIVE_MODEL_QUERIES_VERSION&&Array.isArray(operations)&&new Set(operations).size===operations.length&&(operation?operations.includes(operation):Object.values(NATIVE_MODEL_QUERY_OPERATION_BY_TOOL).every(value=>operations.includes(value))));
}
export function assertNativeModelQueryArguments(name,args){
  const contract=contracts.get(name);if(!contract)failure('unknown named query');
  const result=validate(contract.inputSchema,args,'arguments');
  for(const key of ['element_id','type_id','level_id'])if(Object.hasOwn(result,key))assertId(result[key],{at:key});
  if(result.category)nativeModelQueryCategoryIdentity(result.category);
  return result;
}
export function assertNativeModelQueryResult(name,value,args={}){
  const contract=contracts.get(name);if(!contract)failure('unknown named query');
  validate(NATIVE_MODEL_QUERY_RESULT_SCHEMAS[name],value,'result');
  if(name==='revit_health'&&value.document_open!==(value.status==='ready'))failure('health document status is inconsistent');
  if(name==='revit_get_document_info'){
    if(Object.hasOwn(args,'expected_document')&&value.path!==args.expected_document)failure('document path changed');
    if(value.active_view)assertId(value.active_view.id);
  }
  if(name==='revit_list_views'||name==='revit_get_elements_by_type'){
    const offset=args.offset??0,limit=args.limit??200;
    if(value.offset!==offset||value.limit!==limit||value.items.length!==Math.min(limit,Math.max(0,value.total-offset))||value.has_more!==(offset+limit<value.total)||value.coverage.scanned<value.total)failure('pagination or scan coverage is inconsistent');
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
  if(name==='revit_get_element_parameters'){
    const seen=new Set();
    for(const item of value.parameters){
      const id=assertId(item.parameter_id,{signed:true}).toString();if(seen.has(id))failure('duplicate parameter identity');seen.add(id);
      if(!item.has_value&&item.value_internal!==null)failure('missing parameter value must be explicit null');
      if(item.storage_type==='ElementId'&&item.value_internal!==null)assertId(item.value_internal,{signed:true,at:'parameter reference'});
      if(item.storage_type==='Double'&&item.value_internal!==null&&typeof item.value_internal!=='number')failure('Double parameter requires raw number');
      if(item.storage_type==='Integer'&&item.value_internal!==null&&!Number.isSafeInteger(item.value_internal))failure('Integer parameter requires exact integer');
      if(item.storage_type==='String'&&item.value_internal!==null&&typeof item.value_internal!=='string')failure('String parameter requires raw string');
    }
  }
  if(name==='revit_get_element_geometry'){
    if(value.level)assertId(value.level.id);
    for(const key of Object.keys(value.unavailable))if((value[key]===null)!==(typeof value.unavailable[key]==='string'))failure(key+' missing fact must retain its reason');
    if(value.bounding_box)for(const axis of ['x','y','z'])if(value.bounding_box.min_mm[axis]>value.bounding_box.max_mm[axis])failure('bounding box min exceeds max');
  }
  return value;
}
