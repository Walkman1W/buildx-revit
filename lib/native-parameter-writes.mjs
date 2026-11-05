import {commonWrite} from './workbench-contracts.mjs';
import {NATIVE_MODEL_QUERY_RESULT_SCHEMAS,nativeModelQueryExactId} from './native-model-queries.mjs';
import {assertParameterWriteResult} from './parameter-write-result.mjs';

const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const invalid=message=>{throw new Error('Native parameter write contract: '+message);};
const keys=(value,names)=>plain(value)&&Object.keys(value).length===names.length&&names.every(key=>Object.hasOwn(value,key));
const int32=value=>Number.isInteger(value)&&value>=-2147483648&&value<=2147483647;
const typed=(value,storage)=>storage==='Double'?typeof value==='number'&&Number.isFinite(value):storage==='Integer'?int32(value):storage==='String'?typeof value==='string'&&value.length<=64000:false;
const parameter=NATIVE_MODEL_QUERY_RESULT_SCHEMAS.revit_get_element_parameters.properties.parameters.items;
const element=NATIVE_MODEL_QUERY_RESULT_SCHEMAS.revit_get_element_parameters.properties.element_id;
const stateSchema={type:'object',properties:{storage_type:{type:'string',enum:['Double','Integer','String']},has_value:{type:'boolean'},
  value_internal:{anyOf:[{type:'number'},{type:'string',maxLength:64000},{type:'null'}]},data_type:parameter.properties.data_type},
  required:['storage_type','has_value','value_internal','data_type'],additionalProperties:false};
const changeSchema={type:'object',properties:{element_id:element,parameter_id:{...parameter.properties.parameter_id,not:{enum:[0,-1,'0','-1']}},
  value:{anyOf:[{type:'number'},{type:'string',maxLength:64000}]},value_unit:{type:'string',enum:['internal']},expected_state:stateSchema},
  required:['element_id','parameter_id','value','expected_state'],additionalProperties:false};
export const NATIVE_PARAMETER_WRITE_VERSION=1;
export const NATIVE_PARAMETER_WRITE_MIN_HOST_VERSION='0.8.5';
export const NATIVE_PARAMETER_WRITE_OPERATION_BY_TOOL=freeze({revit_set_parameter_value:'set_parameter_value'});
export const NATIVE_PARAMETER_WRITE_NAMES=freeze(Object.keys(NATIVE_PARAMETER_WRITE_OPERATION_BY_TOOL));
export const isNativeParameterWrite=name=>Object.hasOwn(NATIVE_PARAMETER_WRITE_OPERATION_BY_TOOL,name);
export const nativeParameterWriteOperationForTool=name=>NATIVE_PARAMETER_WRITE_OPERATION_BY_TOOL[name];
export const NATIVE_PARAMETER_WRITE_TOOLS=freeze([{name:'revit_set_parameter_value',
  description:'Set exactly one explicitly identified INSTANCE parameter, never an ElementType or implicit type/name fallback. First read native parameter facts and copy storage_type, has_value, value_internal and data_type into expected_state; stale state fails before Set. Precise Int64 IDs preserve strings. Double values require value_unit="internal"; no display-unit guessing. Host 0.8.5 plus nativeParameterWritesVersion 1 and set_parameter_value are required. Uses the panel bound approval and original-receipt owner; unavailable through unbound MCP. Shared setter verifies owner, metadata and value after Set, regeneration and inner commit. Results are observed before the outer group decision. Default rollback; commit keeps changes without saving. Unknown outcomes must be checked against the original receipt, never automatically replayed.',
  inputSchema:{type:'object',properties:{...commonWrite,changes:{type:'array',minItems:1,maxItems:1,items:changeSchema}},required:['expected_document','changes'],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}}]);
export const nativeParameterWriteTools=()=>NATIVE_PARAMETER_WRITE_TOOLS;
// The legacy batch operation has its own target policy. Do not raise the
// independent guarded single-write minimum or infer this promise from it.
export function hostSupportsParameterWriteTargetPolicy(host){
  if(!plain(host)||typeof host.version!=='string')return false;
  const match=/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(host.version);
  const version=match?.slice(1).filter(value=>value!==undefined).map(Number),minimum=[0,8,7];
  if(!version?.every(Number.isSafeInteger))return false;
  let supported=true;
  for(let index=0;index<minimum.length;index++)if(version[index]!==minimum[index]){supported=version[index]>minimum[index];break;}
  return supported&&host.parameterWriteTargetPolicyVersion===1&&host.parameterWriteTargetPolicy==='instance_only';
}
export function hostSupportsNativeParameterWrite(host,operation='set_parameter_value'){
  if(operation!=='set_parameter_value')return false;
  const match=/^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(host?.version??'');
  const version=match?.slice(1).map(Number),minimum=[0,8,5];
  let supported=Boolean(version?.every(Number.isSafeInteger));
  if(supported)for(let index=0;index<3;index++){if(version[index]!==minimum[index]){supported=version[index]>minimum[index];break;}}
  const operations=host?.nativeParameterWriteOperations;
  return Boolean(supported&&host.nativeParameterWritesVersion===NATIVE_PARAMETER_WRITE_VERSION&&Array.isArray(operations)&&
    new Set(operations).size===operations.length&&operations.includes(operation));
}
function assertState(state){
  if(!keys(state,['storage_type','has_value','value_internal','data_type'])||!['Double','Integer','String'].includes(state.storage_type)||
    typeof state.has_value!=='boolean'||state.has_value===false&&state.value_internal!==null||state.value_internal!==null&&!typed(state.value_internal,state.storage_type)||
    !(state.data_type===null||typeof state.data_type==='string'&&state.data_type.length<=1024))invalid('expected_state must preserve the exact raw parameter facts');
}
export function assertNativeParameterWriteArguments(name,args,{allowDocumentBinding=false}={}){
  if(!isNativeParameterWrite(name))invalid('unknown named write');
  if(!plain(args)||Object.keys(args).some(key=>!['expected_document','mode','changes'].includes(key))||
    !(allowDocumentBinding&&!Object.hasOwn(args,'expected_document')||typeof args.expected_document==='string'&&args.expected_document.length>0&&args.expected_document.length<=32768&&!/[\0\r\n]/.test(args.expected_document))||
    args.mode!==undefined&&!['rollback','commit'].includes(args.mode)||!Array.isArray(args.changes)||args.changes.length!==1)invalid('requires one change and a bound saved document');
  const change=args.changes[0];
  if(!plain(change)||Object.keys(change).some(key=>!Object.hasOwn(changeSchema.properties,key))||changeSchema.required.some(key=>!Object.hasOwn(change,key)))invalid('change fields do not match the instance write schema');
  nativeModelQueryExactId(change.element_id,{at:'element_id'});
  const id=nativeModelQueryExactId(change.parameter_id,{signed:true,at:'parameter_id'});if(id===0n||id===-1n)invalid('parameter_id must not be 0 or -1');
  assertState(change.expected_state);
  if(!typed(change.value,change.expected_state.storage_type)||Object.hasOwn(change,'value_unit')&&change.value_unit!=='internal'||
    change.expected_state.storage_type==='Double'&&change.value_unit!=='internal')invalid('value must match the observed storage type and explicit internal unit');
  return structuredClone({...args,mode:args.mode??'rollback'});
}
export function assertNativeParameterWriteResult(value,args){
  assertNativeParameterWriteArguments('revit_set_parameter_value',args);
  if(!keys(value,['schema_version','target_kind','before','result'])||value.schema_version!==1||value.target_kind!=='instance')invalid('result is not an instance write DTO');
  assertState(value.before);
  const change=args.changes[0],expected=change.expected_state;
  if(Object.keys(expected).some(key=>value.before[key]!==expected[key]))invalid('observed before state differs from the approved guard');
  assertParameterWriteResult(value.result,args,{exactIds:true});
  const row=value.result.changes[0];
  if(row.storage_type!==value.before.storage_type||row.data_type!==value.before.data_type||row.before_internal!==value.before.value_internal)invalid('write observations differ from the original parameter facts');
  return value;
}
