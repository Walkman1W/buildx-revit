import {commonWrite} from './workbench-contracts.mjs';
import {NATIVE_MODEL_QUERY_RESULT_SCHEMAS,nativeModelQueryExactId} from './native-model-queries.mjs';
import {assertNativeParameterQueryResult} from './native-parameter-queries.mjs';
import {assertParameterWriteResult} from './parameter-write-result.mjs';

const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail=message=>{throw new Error('Native type parameter write contract: '+message);};
const keys=(value,names)=>plain(value)&&Object.keys(value).length===names.length&&names.every(key=>Object.hasOwn(value,key));
const source=NATIVE_MODEL_QUERY_RESULT_SCHEMAS.revit_get_element_parameters;
const parameter=source.properties.parameters.items;
const int32=value=>Number.isInteger(value)&&value>=-2147483648&&value<=2147483647;
const typed=(value,storage)=>storage==='Double'?typeof value==='number'&&Number.isFinite(value):storage==='Integer'?int32(value):storage==='String'?typeof value==='string'&&value.length<=8192:false;
const rawSchema={anyOf:[{type:'number'},{type:'string',maxLength:8192},{type:'null'}]};
const stateSchema={type:'object',properties:{storage_type:{type:'string',enum:['Double','Integer','String']},has_value:{type:'boolean'},
 value_internal:rawSchema,data_type:parameter.properties.data_type},required:['storage_type','has_value','value_internal','data_type'],additionalProperties:false};
const idsSchema={type:'array',items:source.properties.element_id.anyOf.find(rule=>rule.type==='string'),maxItems:500};
const inputSchema={type:'object',properties:{...commonWrite,expected_document:{...commonWrite.expected_document,description:'Exact saved-document path from workbench status; must be allowed.'},type_id:source.properties.element_id,
 parameter_id:{...parameter.properties.parameter_id,not:{enum:[0,-1,'0','-1']}},value:{anyOf:[{type:'string',maxLength:8192},{type:'number'}]},
 value_unit:{type:'string',enum:['internal']},expected_state:stateSchema,expected_instance_ids:idsSchema},
 required:['expected_document','type_id','parameter_id','value','expected_state','expected_instance_ids'],additionalProperties:false};
export const NATIVE_TYPE_PARAMETER_WRITE_NAMES=freeze(['revit_set_type_parameter']);
export const isNativeTypeParameterWrite=name=>name==='revit_set_type_parameter';
export const nativeTypeParameterWriteOperationForTool=name=>isNativeTypeParameterWrite(name)?'set_type_parameter':undefined;
export const NATIVE_TYPE_PARAMETER_WRITE_TOOLS=freeze([{name:'revit_set_type_parameter',
 description:'Change exactly one explicitly identified parameter on a saved current-project ElementType. First read revit_get_type_parameter_impact, then supply its exact four raw state facts and complete sorted canonical instance IDs as guards. Never use an instance ID or resolve names implicitly. Double requires explicit internal units. Requires host 0.8.8, nativeTypeParameterWritesVersion:1 and set_type_parameter. Only the panel approval owner may execute: chat and manual form submissions are intents; all modes including rollback and automatic require a fresh human decision, an observed native preparation and a single-use host permit. Raw MCP and direct command dispatch cannot authorize it. Native owner checks type/parameter identity, before state and the full direct-reference set before Set and verifies value/metadata/membership after Set, regeneration and inner commit. Indirect effects are not assessed. Default rollback; commit keeps memory changes without saving. Unknown outcomes must be checked against the original request, never replayed.',
 inputSchema,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}}]);
export function supportsNativeTypeParameterWrites(host){
 if(!plain(host)||typeof host.version!=='string')return false;
 const match=/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(host?.version??'');
 const version=match?.slice(1).filter(value=>value!==undefined).map(Number),minimum=[0,8,8];
 if(!version?.every(Number.isSafeInteger))return false;
 let valid=true;for(let index=0;index<3;index++)if(version[index]!==minimum[index]){valid=version[index]>minimum[index];break;}
 const operations=host?.nativeTypeParameterWriteOperations;
 return Boolean(valid&&host.nativeTypeParameterWritesVersion===1&&Array.isArray(operations)&&new Set(operations).size===operations.length&&operations.includes('set_type_parameter'));
}
function state(value){
 if(!keys(value,['storage_type','has_value','value_internal','data_type'])||!['Double','Integer','String'].includes(value.storage_type)||
  typeof value.has_value!=='boolean'||value.has_value===false&&value.value_internal!==null||value.value_internal!==null&&!typed(value.value_internal,value.storage_type)||
  !(value.data_type===null||typeof value.data_type==='string'&&value.data_type.length<=1024))fail('invalid raw state guard');
}
function instances(value){
 if(!Array.isArray(value)||value.length>500)fail('direct instance list exceeds budget');
 let previous=0n;for(const text of value){if(typeof text!=='string')fail('instance IDs must be canonical strings');const id=nativeModelQueryExactId(text);if(id<=previous)fail('instance IDs must be strictly numerically ordered and unique');previous=id;}
}
function document(value){if(!keys(value,['session','title','path'])||!['session','title','path'].every(key=>typeof value[key]==='string'&&value[key].length>0&&!/[\0\r\n]/.test(value[key]))||value.session.length>160||value.title.length>1024||value.path.length>32768)fail('a bound saved document is required');}
export function assertNativeTypeParameterWriteArguments(name,args,{allowDocumentBinding=false}={}){
 if(!isNativeTypeParameterWrite(name)||!plain(args)||Object.keys(args).some(key=>!Object.hasOwn(inputSchema.properties,key))||
  inputSchema.required.some(key=>!(key==='expected_document'&&allowDocumentBinding)&&!Object.hasOwn(args,key)))fail('invalid named type write arguments');
 if(!(allowDocumentBinding&&!Object.hasOwn(args,'expected_document')||typeof args.expected_document==='string'&&args.expected_document.length>0&&args.expected_document.length<=32768&&!/[\0\r\n]/.test(args.expected_document))||
  args.mode!==undefined&&!['rollback','commit'].includes(args.mode))fail('invalid saved document or mode');
 const typeId=nativeModelQueryExactId(args.type_id),parameterId=nativeModelQueryExactId(args.parameter_id,{signed:true});
 if(parameterId===0n||parameterId===-1n)fail('invalid parameter ID');state(args.expected_state);instances(args.expected_instance_ids);
 if(args.expected_instance_ids.some(id=>nativeModelQueryExactId(id)===typeId))fail('a type cannot be listed as its instance');
 if(!typed(args.value,args.expected_state.storage_type)||Object.hasOwn(args,'value_unit')&&args.value_unit!=='internal'||args.expected_state.storage_type==='Double'&&args.value_unit!=='internal')fail('value must match storage and explicit internal units');
 const result=structuredClone({...args,mode:args.mode??'rollback'});if(Buffer.byteLength(JSON.stringify(result),'utf8')>100000)fail('type request exceeds review budget');return result;
}
function assertImpact(args,impact){
 assertNativeParameterQueryResult('revit_get_type_parameter_impact',impact,{type_id:args.type_id,parameter_id:args.parameter_id});
 const p=impact.parameter,before=args.expected_state;
 if(p.is_read_only!==false||Object.keys(before).some(key=>p[key]!==before[key])||JSON.stringify(impact.instance_ids)!==JSON.stringify(args.expected_instance_ids))fail('observed type facts differ from the requested guards');
}
export function buildTypeParameterWriteReview(args,impact,sourceDocument){
 const chosen=assertNativeTypeParameterWriteArguments('revit_set_type_parameter',args);document(sourceDocument);
 if(chosen.expected_document!==sourceDocument.path)fail('review document differs from the write target');assertImpact(chosen,impact);
 const review={schema_version:1,document:structuredClone(sourceDocument),type_id:String(chosen.type_id),type_name:impact.type_name,parameter:structuredClone(impact.parameter),
  mode:chosen.mode,value:chosen.value,value_unit:chosen.value_unit??null,instance_ids:structuredClone(impact.instance_ids),instance_count:impact.instance_count,
  scope:'current_document_direct_type_references',indirect_effects:'not_assessed'};
 return assertTypeParameterWriteReview(review);
}
export function assertTypeParameterWriteReview(value){
 if(!keys(value,['schema_version','document','type_id','type_name','parameter','mode','value','value_unit','instance_ids','instance_count','scope','indirect_effects'])||value.schema_version!==1||
  value.scope!=='current_document_direct_type_references'||value.indirect_effects!=='not_assessed'||!Number.isInteger(value.instance_count)||value.instance_count!==value.instance_ids?.length||
  !(value.value_unit===null||value.value_unit==='internal'))fail('invalid trusted review');
 document(value.document);
 const p=value.parameter;
 if(!(p?.value_display===null||typeof p?.value_display==='string'&&p.value_display.length<=8192))fail('parameter display exceeds review budget');
 const args={expected_document:value.document.path,mode:value.mode,type_id:value.type_id,parameter_id:p?.parameter_id,value:value.value,
  ...value.value_unit===null?{}:{value_unit:value.value_unit},expected_state:{storage_type:p?.storage_type,has_value:p?.has_value,value_internal:p?.value_internal,data_type:p?.data_type},expected_instance_ids:value.instance_ids};
 assertNativeTypeParameterWriteArguments('revit_set_type_parameter',args);
 assertImpact(args,{schema_version:1,type_id:value.type_id,type_name:value.type_name,parameter:p,instance_ids:value.instance_ids,instance_count:value.instance_count,
  coverage:{complete:true,scope:value.scope,scanned_elements:value.instance_count,indirect_effects:value.indirect_effects},write_authorization:'not_granted'});
 const json=JSON.stringify(value);if(json.length>60000||Buffer.byteLength(json,'utf8')>100000)fail('trusted review exceeds display budget');return freeze(structuredClone(value));
}
export function typeParameterWriteBindingKey(args,sourceDocument){
 const chosen=assertNativeTypeParameterWriteArguments('revit_set_type_parameter',args);document(sourceDocument);
 if(chosen.expected_document!==sourceDocument.path)fail('approval document differs');
 const before=chosen.expected_state;
 return JSON.stringify([sourceDocument.session,sourceDocument.title,sourceDocument.path,chosen.expected_document,chosen.mode,
  String(chosen.type_id),String(chosen.parameter_id),chosen.value,chosen.value_unit??null,before.storage_type,before.has_value,before.value_internal,before.data_type,chosen.expected_instance_ids]);
}
export function assertNativeTypeParameterWriteResult(value,args){
 const chosen=assertNativeTypeParameterWriteArguments('revit_set_type_parameter',args);
 if(!keys(value,['schema_version','target_kind','before','instance_ids','instance_count','scope','indirect_effects','result'])||value.schema_version!==1||value.target_kind!=='type'||
  value.scope!=='current_document_direct_type_references'||value.indirect_effects!=='not_assessed')fail('invalid type write result');
 state(value.before);instances(value.instance_ids);
 if(value.instance_count!==value.instance_ids.length||JSON.stringify(value.instance_ids)!==JSON.stringify(chosen.expected_instance_ids)||
  Object.keys(chosen.expected_state).some(key=>value.before[key]!==chosen.expected_state[key]))fail('type write observations differ from the approved guards');
 const change={element_id:chosen.type_id,parameter_id:chosen.parameter_id,value:chosen.value,...chosen.value_unit===undefined?{}:{value_unit:chosen.value_unit},expected_state:chosen.expected_state};
 assertParameterWriteResult(value.result,{changes:[change]},{exactIds:true});const row=value.result.changes[0];
 if(row.storage_type!==value.before.storage_type||row.data_type!==value.before.data_type||row.before_internal!==value.before.value_internal)fail('type write raw facts differ');return value;
}
