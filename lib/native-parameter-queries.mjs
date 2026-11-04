import {NATIVE_MODEL_QUERY_TOOLS,NATIVE_MODEL_QUERY_RESULT_SCHEMAS,NATIVE_MODEL_QUERY_OUTPUT_SCHEMAS,assertNativeModelQueryArguments,assertNativeModelQueryResult} from './native-model-queries.mjs';

const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const sourceResult=NATIVE_MODEL_QUERY_RESULT_SCHEMAS.revit_get_element_parameters;
const sourceTool=NATIVE_MODEL_QUERY_TOOLS.find(tool=>tool.name==='revit_get_element_parameters');
const sourceEnvelope=NATIVE_MODEL_QUERY_OUTPUT_SCHEMAS.revit_get_element_parameters;
export const NATIVE_PARAMETER_QUERY_VERSION=1;
export const NATIVE_PARAMETER_QUERY_MIN_HOST_VERSION='0.8.2';
export const NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL=freeze({revit_get_type_parameters:'get_type_parameters'});
export const NATIVE_PARAMETER_QUERY_NAMES=freeze(Object.keys(NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL));
export const isNativeParameterQuery=name=>Object.hasOwn(NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL,name);
export const NATIVE_PARAMETER_QUERY_RESULT_SCHEMAS=freeze({revit_get_type_parameters:{
  type:'object',properties:{schema_version:sourceResult.properties.schema_version,element_id:sourceResult.properties.element_id,
    element_name:sourceResult.properties.element_name,source_is_type:{type:'boolean'},type_id:sourceResult.properties.element_id,
    type_name:sourceResult.properties.element_name,parameters:sourceResult.properties.parameters},
  required:['schema_version','element_id','element_name','source_is_type','type_id','type_name','parameters'],additionalProperties:false
}});
export const NATIVE_PARAMETER_QUERY_OUTPUT_SCHEMAS=freeze({revit_get_type_parameters:{...sourceEnvelope,properties:{...sourceEnvelope.properties,
  operation:{type:'string',enum:['get_type_parameters']},value:NATIVE_PARAMETER_QUERY_RESULT_SCHEMAS.revit_get_type_parameters
}}});
export const NATIVE_PARAMETER_QUERY_TOOLS=freeze([{
  name:'revit_get_type_parameters',
  description:'Read native type parameters for one exact current-document element. Instances resolve their actual ElementType; an ElementType input returns itself. Source and type identities are separate; no instance-parameter fallback or name guessing. Parameter storage, raw internal/display values, units and writeability share the native parameter owner. Missing/invalid type or over-budget data fails explicitly. Requires host 0.8.2 and nativeParameterQueriesVersion 1. Read-only; omitted expected_document binds atomically to the current document, including an unsaved document.',
  inputSchema:sourceTool.inputSchema,outputSchema:NATIVE_PARAMETER_QUERY_OUTPUT_SCHEMAS.revit_get_type_parameters,annotations:{readOnlyHint:true}
}]);
const invalid=message=>{throw new Error('Native parameter query contract: '+message);};
export function supportsNativeParameterQueries(host,operation){
  const parsed=/^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(host?.version??'');
  const version=parsed?.slice(1).map(Number),minimum=NATIVE_PARAMETER_QUERY_MIN_HOST_VERSION.split('.').map(Number);
  let supported=Boolean(version?.every(Number.isSafeInteger));
  if(supported){for(let index=0;index<minimum.length;index++){if(version[index]!==minimum[index]){supported=version[index]>minimum[index];break;}}}
  const operations=host?.nativeParameterQueryOperations;
  return Boolean(supported&&host.atomicReadSnapshot===true&&host.nativeParameterQueriesVersion===NATIVE_PARAMETER_QUERY_VERSION&&
    Array.isArray(operations)&&new Set(operations).size===operations.length&&
    (operation?operations.includes(operation):Object.values(NATIVE_PARAMETER_QUERY_OPERATION_BY_TOOL).every(value=>operations.includes(value))));
}
export function assertNativeParameterQueryArguments(name,args){
  if(!isNativeParameterQuery(name))invalid('unknown named query');
  return assertNativeModelQueryArguments('revit_get_element_parameters',args);
}
export function assertNativeParameterQueryResult(name,value,args={}){
  if(!isNativeParameterQuery(name))invalid('unknown named query');
  const schema=NATIVE_PARAMETER_QUERY_RESULT_SCHEMAS[name];
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||
    Object.keys(value).some(key=>!Object.hasOwn(schema.properties,key))||schema.required.some(key=>!Object.hasOwn(value,key)))invalid('result fields do not match the named schema');
  if(typeof value.source_is_type!=='boolean')invalid('source_is_type must be boolean');
  // The existing parameter owner alone interprets exact IDs, storage, raw and
  // display values and units. Only source-to-type resolution belongs here.
  assertNativeModelQueryResult('revit_get_element_parameters',{schema_version:value.schema_version,element_id:value.element_id,element_name:value.element_name,parameters:[]},args);
  assertNativeModelQueryResult('revit_get_element_parameters',{schema_version:value.schema_version,element_id:value.type_id,element_name:value.type_name,parameters:value.parameters},{element_id:value.type_id});
  if(value.source_is_type!==(BigInt(value.element_id)===BigInt(value.type_id)))invalid('source/type identities do not match source_is_type');
  if(value.source_is_type&&value.element_name!==value.type_name)invalid('a direct type input must retain the same observed name');
  return value;
}
