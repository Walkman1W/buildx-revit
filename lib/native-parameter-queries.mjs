import {NATIVE_MODEL_QUERY_TOOLS,NATIVE_MODEL_QUERY_RESULT_SCHEMAS,NATIVE_MODEL_QUERY_OUTPUT_SCHEMAS,assertNativeModelQueryArguments,assertNativeModelQueryResult,nativeModelQueryExactId} from './native-model-queries.mjs';

const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const sourceResult=NATIVE_MODEL_QUERY_RESULT_SCHEMAS.revit_get_element_parameters;
const sourceTool=NATIVE_MODEL_QUERY_TOOLS.find(tool=>tool.name==='revit_get_element_parameters');
const sourceEnvelope=NATIVE_MODEL_QUERY_OUTPUT_SCHEMAS.revit_get_element_parameters;
export const NATIVE_PARAMETER_QUERY_VERSION=1;
export const NATIVE_PARAMETER_QUERY_MIN_HOST_VERSION='0.8.2';
export const NATIVE_PARAMETER_QUERY_MIN_HOST_VERSION_BY_OPERATION=freeze({get_type_parameters:'0.8.2',get_parameter_value:'0.8.4',get_type_parameter_impact:'0.8.6'});
export const NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL=freeze({revit_get_type_parameters:'get_type_parameters',revit_get_parameter_value:'get_parameter_value',revit_get_type_parameter_impact:'get_type_parameter_impact'});
export const NATIVE_PARAMETER_QUERY_NAMES=freeze(Object.keys(NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL));
export const isNativeParameterQuery=name=>Object.hasOwn(NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL,name);
export const NATIVE_PARAMETER_QUERY_RESULT_SCHEMAS=freeze({revit_get_type_parameters:{
  type:'object',properties:{schema_version:sourceResult.properties.schema_version,element_id:sourceResult.properties.element_id,
    element_name:sourceResult.properties.element_name,source_is_type:{type:'boolean'},type_id:sourceResult.properties.element_id,
    type_name:sourceResult.properties.element_name,parameters:sourceResult.properties.parameters},
  required:['schema_version','element_id','element_name','source_is_type','type_id','type_name','parameters'],additionalProperties:false
},revit_get_parameter_value:{type:'object',properties:{schema_version:sourceResult.properties.schema_version,element_id:sourceResult.properties.element_id,
  element_name:sourceResult.properties.element_name,parameter:sourceResult.properties.parameters.items},
  required:['schema_version','element_id','element_name','parameter'],additionalProperties:false},revit_get_type_parameter_impact:{type:'object',properties:{
    schema_version:sourceResult.properties.schema_version,type_id:sourceResult.properties.element_id,type_name:sourceResult.properties.element_name,
    parameter:sourceResult.properties.parameters.items,instance_ids:{type:'array',maxItems:500,items:sourceResult.properties.element_id.anyOf.find(rule=>rule.type==='string')},
    instance_count:{type:'integer',minimum:0,maximum:500},coverage:{type:'object',properties:{complete:{type:'boolean',enum:[true]},
      scope:{type:'string',enum:['current_document_direct_type_references']},scanned_elements:{type:'integer',minimum:0,maximum:20000},
      indirect_effects:{type:'string',enum:['not_assessed']}},required:['complete','scope','scanned_elements','indirect_effects'],additionalProperties:false},
    write_authorization:{type:'string',enum:['not_granted']},
  },required:['schema_version','type_id','type_name','parameter','instance_ids','instance_count','coverage','write_authorization'],additionalProperties:false}});
export const NATIVE_PARAMETER_QUERY_OUTPUT_SCHEMAS=freeze(Object.fromEntries(NATIVE_PARAMETER_QUERY_NAMES.map(name=>[name,{...sourceEnvelope,properties:{...sourceEnvelope.properties,
  operation:{type:'string',enum:[NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL[name]]},value:NATIVE_PARAMETER_QUERY_RESULT_SCHEMAS[name]
}}])));
export const NATIVE_PARAMETER_QUERY_TOOLS=freeze([{
  name:'revit_get_type_parameters',
  description:'Read native type parameters for one exact current-document element. Instances resolve their actual ElementType; an ElementType input returns itself. Source and type identities are separate; no instance-parameter fallback or name guessing. Parameter storage, raw internal/display values, units and writeability share the native parameter owner. Missing/invalid type or over-budget data fails explicitly. Requires host 0.8.2 and nativeParameterQueriesVersion 1. Read-only; omitted expected_document binds atomically to the current document, including an unsaved document.',
  inputSchema:sourceTool.inputSchema,outputSchema:NATIVE_PARAMETER_QUERY_OUTPUT_SCHEMAS.revit_get_type_parameters,annotations:{readOnlyHint:true}
},{name:'revit_get_parameter_value',
  description:'Read exactly one parameter of the explicitly selected current-document element. Supply exactly one selector: precise signed parameter_id (not 0/-1) or exact parameter_name. Names preserve spaces, case and Unicode; duplicate names/IDs, absent parameters and over-budget scans fail explicitly. Scans at most 2000 parameters to prove uniqueness; does not silently fall back to instance/type or name/ID alternatives and does not read unrelated values. Select an ElementType explicitly to read its own parameter. Preserves the shared raw/internal/display/unit facts. Requires host 0.8.4, nativeParameterQueriesVersion 1 and get_parameter_value. Omitted expected_document binds in the same atomic callback.',
  inputSchema:{type:'object',properties:{...sourceTool.inputSchema.properties,
    parameter_id:{...sourceResult.properties.parameters.items.properties.parameter_id,not:{enum:[0,-1,'0','-1']}},
    parameter_name:{type:'string',minLength:1,maxLength:1024}},required:['element_id'],
    oneOf:[{properties:{parameter_id:{}},required:['parameter_id']},{properties:{parameter_name:{}},required:['parameter_name']}],additionalProperties:false},
  outputSchema:NATIVE_PARAMETER_QUERY_OUTPUT_SCHEMAS.revit_get_parameter_value,annotations:{readOnlyHint:true}
},{name:'revit_get_type_parameter_impact',
  description:'Read one parameter of an explicitly selected ElementType and the current-document elements directly referencing that exact type. Supply precise type_id and signed parameter_id (not 0/-1); an instance ID is not resolved into its type. Shares native parameter storage, raw/internal/display values, units and writeability. A complete bounded scan returns at most 500 unique instance IDs in numeric Int64 order; scans above 20000 elements or other budgets fail without partial coverage. Indirect effects are not assessed. This read-only preview grants no write authority and does not close legacy batch/script write entry points. Requires host 0.8.6, nativeParameterQueriesVersion 1, atomic snapshots and get_type_parameter_impact. Omitted expected_document binds atomically, including an unsaved document.',
  inputSchema:{type:'object',properties:{expected_document:sourceTool.inputSchema.properties.expected_document,type_id:sourceResult.properties.element_id,
    parameter_id:{...sourceResult.properties.parameters.items.properties.parameter_id,not:{enum:[0,-1,'0','-1']}}},
    required:['type_id','parameter_id'],additionalProperties:false},
  outputSchema:NATIVE_PARAMETER_QUERY_OUTPUT_SCHEMAS.revit_get_type_parameter_impact,annotations:{readOnlyHint:true}
}]);
const invalid=message=>{throw new Error('Native parameter query contract: '+message);};
export function supportsNativeParameterQueries(host,operation){
  if(operation!==undefined&&!Object.hasOwn(NATIVE_PARAMETER_QUERY_MIN_HOST_VERSION_BY_OPERATION,operation))return false;
  const parsed=/^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(host?.version??'');
  const requested=operation?[operation]:Object.values(NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL);
  const version=parsed?.slice(1).map(Number);
  const supported=Boolean(version?.every(Number.isSafeInteger)&&requested.every(value=>{
    const minimum=NATIVE_PARAMETER_QUERY_MIN_HOST_VERSION_BY_OPERATION[value].split('.').map(Number);
    for(let index=0;index<minimum.length;index++)if(version[index]!==minimum[index])return version[index]>minimum[index];
    return true;
  }));
  const operations=host?.nativeParameterQueryOperations;
  return Boolean(supported&&host.atomicReadSnapshot===true&&host.nativeParameterQueriesVersion===NATIVE_PARAMETER_QUERY_VERSION&&
    Array.isArray(operations)&&new Set(operations).size===operations.length&&
    requested.every(value=>operations.includes(value)));
}
export function assertNativeParameterQueryArguments(name,args){
  if(!isNativeParameterQuery(name))invalid('unknown named query');
  if(name==='revit_get_type_parameters')return assertNativeModelQueryArguments('revit_get_element_parameters',args);
  if(name==='revit_get_type_parameter_impact'){
    if(!args||typeof args!=='object'||Array.isArray(args)||![Object.prototype,null].includes(Object.getPrototypeOf(args))||
      Object.keys(args).some(key=>!['expected_document','type_id','parameter_id'].includes(key)))invalid('arguments do not match the explicit type impact schema');
    const common=assertNativeModelQueryArguments('revit_get_element_parameters',{element_id:args.type_id,...Object.hasOwn(args,'expected_document')?{expected_document:args.expected_document}:{}});
    const id=nativeModelQueryExactId(args.parameter_id,{signed:true,at:'parameter_id'});if(id===0n||id===-1n)invalid('parameter_id must not be 0 or -1');
    return {...Object.hasOwn(common,'expected_document')?{expected_document:common.expected_document}:{},type_id:common.element_id,parameter_id:args.parameter_id};
  }
  if(!args||typeof args!=='object'||Array.isArray(args)||![Object.prototype,null].includes(Object.getPrototypeOf(args))||
    Object.keys(args).some(key=>!['expected_document','element_id','parameter_id','parameter_name'].includes(key)))invalid('arguments do not match the named selector schema');
  const byId=Object.hasOwn(args,'parameter_id'),byName=Object.hasOwn(args,'parameter_name');if(byId===byName)invalid('supply exactly one parameter_id or parameter_name');
  const normalized=assertNativeModelQueryArguments('revit_get_element_parameters',Object.fromEntries(Object.entries(args).filter(([key])=>key==='element_id'||key==='expected_document')));
  if(byId){const id=nativeModelQueryExactId(args.parameter_id,{signed:true,at:'parameter_id'});if(id===0n||id===-1n)invalid('parameter_id must not be 0 or -1');normalized.parameter_id=args.parameter_id;}
  else{if(typeof args.parameter_name!=='string'||args.parameter_name.length<1||args.parameter_name.length>1024)invalid('parameter_name must be an exact nonempty bounded string');normalized.parameter_name=args.parameter_name;}
  return normalized;
}
export function assertNativeParameterQueryResult(name,value,args={}){
  if(!isNativeParameterQuery(name))invalid('unknown named query');
  const schema=NATIVE_PARAMETER_QUERY_RESULT_SCHEMAS[name];
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||
    Object.keys(value).some(key=>!Object.hasOwn(schema.properties,key))||schema.required.some(key=>!Object.hasOwn(value,key)))invalid('result fields do not match the named schema');
  if(name==='revit_get_type_parameter_impact'){
    if(Object.keys(args).length)assertNativeParameterQueryArguments(name,args);
    assertNativeModelQueryResult('revit_get_element_parameters',{schema_version:value.schema_version,element_id:value.type_id,element_name:value.type_name,parameters:[value.parameter]},
      args.type_id===undefined?{}:{element_id:args.type_id});
    const type=nativeModelQueryExactId(value.type_id),parameterId=nativeModelQueryExactId(value.parameter.parameter_id,{signed:true,at:'parameter_id'});
    if(parameterId===0n||parameterId===-1n||Object.hasOwn(args,'parameter_id')&&parameterId!==nativeModelQueryExactId(args.parameter_id,{signed:true,at:'parameter_id'}))invalid('impact parameter differs from the requested identity');
    const coverage=value.coverage,coverageKeys=['complete','scope','scanned_elements','indirect_effects'];
    if(value.write_authorization!=='not_granted'||!Array.isArray(value.instance_ids)||value.instance_ids.length>500||
      !Number.isInteger(value.instance_count)||value.instance_count!==value.instance_ids.length||
      !coverage||typeof coverage!=='object'||Array.isArray(coverage)||![Object.prototype,null].includes(Object.getPrototypeOf(coverage))||
      Object.keys(coverage).length!==coverageKeys.length||coverageKeys.some(key=>!Object.hasOwn(coverage,key))||
      coverage.complete!==true||coverage.scope!=='current_document_direct_type_references'||coverage.indirect_effects!=='not_assessed'||
      !Number.isInteger(coverage.scanned_elements)||coverage.scanned_elements<value.instance_count||coverage.scanned_elements>20000)invalid('impact coverage must remain bounded, complete and read-only');
    let previous=0n;
    for(const instanceId of value.instance_ids){if(typeof instanceId!=='string')invalid('instance identities must be canonical decimal strings');const id=nativeModelQueryExactId(instanceId);if(id<=previous||id===type)invalid('instance identities must be unique, numerically ordered and distinct from the type');previous=id;}
    return value;
  }
  if(name==='revit_get_parameter_value'){
    if(Object.keys(args).length)assertNativeParameterQueryArguments(name,args);
    assertNativeModelQueryResult('revit_get_element_parameters',{schema_version:value.schema_version,element_id:value.element_id,element_name:value.element_name,parameters:[value.parameter]},args);
    const id=nativeModelQueryExactId(value.parameter.parameter_id,{signed:true,at:'parameter_id'});if(id===0n||id===-1n)invalid('result parameter_id must identify a parameter');
    if(Object.hasOwn(args,'parameter_id')&&id!==nativeModelQueryExactId(args.parameter_id,{signed:true,at:'parameter_id'}))invalid('result parameter identity differs from the requested selector');
    if(Object.hasOwn(args,'parameter_name')&&value.parameter.name!==args.parameter_name)invalid('result parameter name differs from the exact selector');
    return value;
  }
  if(typeof value.source_is_type!=='boolean')invalid('source_is_type must be boolean');
  // The existing parameter owner alone interprets exact IDs, storage, raw and
  // display values and units. Only source-to-type resolution belongs here.
  assertNativeModelQueryResult('revit_get_element_parameters',{schema_version:value.schema_version,element_id:value.element_id,element_name:value.element_name,parameters:[]},args);
  assertNativeModelQueryResult('revit_get_element_parameters',{schema_version:value.schema_version,element_id:value.type_id,element_name:value.type_name,parameters:value.parameters},{element_id:value.type_id});
  if(value.source_is_type!==(BigInt(value.element_id)===BigInt(value.type_id)))invalid('source/type identities do not match source_is_type');
  if(value.source_is_type&&value.element_name!==value.type_name)invalid('a direct type input must retain the same observed name');
  return value;
}
