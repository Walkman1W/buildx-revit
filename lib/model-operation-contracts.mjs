import {MODEL_AI_EFFECT_TOOLS} from './panel-tools.mjs';
import {supportsModelPermissionTool} from './model-operation-effects.mjs';

const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const lifecycleNames=new Set(['revit_family_save_job','revit_family_close_job']);
// The registered public tools own their schemas. Keep one detached immutable
// metadata view for both the dynamic advertisement and on-demand discovery.
const contracts=Object.freeze(MODEL_AI_EFFECT_TOOLS
  .filter(tool=>supportsModelPermissionTool(tool.name)||lifecycleNames.has(tool.name))
  .map(tool=>freeze({name:tool.name,description:tool.description,inputSchema:structuredClone(tool.inputSchema),
    requiresFamilyLifecycleCapability:lifecycleNames.has(tool.name)})));
const byName=new Map(contracts.map(contract=>[contract.name,contract]));
if(byName.size!==contracts.length)throw new Error('Duplicate named model operation contract');

export function modelOperationContracts(includeFamilyLifecycle=false){
  if(typeof includeFamilyLifecycle!=='boolean')throw new TypeError('Explicit model capability selection required');
  return Object.freeze(contracts.filter(contract=>includeFamilyLifecycle||!contract.requiresFamilyLifecycleCapability));
}

export const MODEL_OPERATION_SCHEMA_TOOL=freeze({
  type:'function',name:'buildx_model_operation_schema',
  description:'Read the exact parameter contract for one registered BuildX model operation before calling it. Returns its inputSchema, required fields, units and defaults. This is metadata only; it neither reads a Revit model nor authorizes or executes an operation. Then call buildx_model_operation with exactly {tool,parameters}; mode belongs inside parameters. Never probe a write tool with missing or empty parameters.',
  inputSchema:{type:'object',properties:{tool:{type:'string',enum:contracts.map(contract=>contract.name)}},required:['tool'],additionalProperties:false},
});

const invalid=freeze({ok:false,error:{code:'MODEL_OPERATION_SCHEMA_INPUT_INVALID',message:'参数契约查询只接受 {tool: "准确的已登记操作名"}。'}});
const unavailable=freeze({ok:false,error:{code:'MODEL_OPERATION_SCHEMA_UNAVAILABLE',message:'该名称没有可用的 BuildX 模型操作契约。'}});
const views=new Map(contracts.map(contract=>[contract.name,freeze({ok:true,value:{tool:contract.name,
  description:contract.description,inputSchema:contract.inputSchema,
  requiresFamilyLifecycleCapability:contract.requiresFamilyLifecycleCapability}})]));

/** Contract discovery is not an execution capability or a model permission. */
export function describeModelOperationSchema(input){
  try{
    if(input===null||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid;
    const keys=Reflect.ownKeys(input),property=Object.getOwnPropertyDescriptor(input,'tool');
    if(keys.length!==1||keys[0]!=='tool'||!property||!Object.hasOwn(property,'value')||typeof property.value!=='string')return invalid;
    return views.get(property.value)??unavailable;
  }catch{return invalid;}
}
