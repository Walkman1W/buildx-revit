import {MODEL_AI_EFFECT_TOOLS,MODEL_AI_READ_TOOLS} from './panel-tools.mjs';
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
const reads=MODEL_AI_READ_TOOLS.map(tool=>freeze({name:tool.name,description:tool.description,inputSchema:structuredClone(tool.inputSchema),...(tool.outputSchema?{outputSchema:structuredClone(tool.outputSchema)}:{})}));
const allContracts=[...reads,...contracts];
if(new Set(allContracts.map(item=>item.name)).size!==allContracts.length)throw new Error('Duplicate discovery contract');
const domainOf=name=>{
  if(/parameter/.test(name))return 'parameters';
  if(/pipe|duct|connector|system|network|schematic/.test(name))return 'mep';
  if(/family|symbol|type/.test(name))return 'families';
  if(/view|sheet|titleblock|visual|capture|inspect|annotat|schedule|revision/.test(name))return 'views';
  if(/wall|floor|door|window|element|geometry/.test(name))return 'elements';
  if(/command|csharp/.test(name))return 'commands';
  return 'document';
};
const domains=['document','elements','parameters','families','mep','views','commands'];

export function modelOperationContracts(includeFamilyLifecycle=false){
  if(typeof includeFamilyLifecycle!=='boolean')throw new TypeError('Explicit model capability selection required');
  return Object.freeze(contracts.filter(contract=>includeFamilyLifecycle||!contract.requiresFamilyLifecycleCapability));
}

export const MODEL_OPERATION_SCHEMA_TOOL=freeze({
  type:'function',name:'buildx_model_operation_schema',
  description:'Read one exact BuildX tool contract with {tool}, or discover compact tool names by {domain,offset?,limit?}. Domains: document, elements, parameters, families, mep, views, commands. Metadata only; does not execute or authorize. Writes use buildx_model_operation with {tool,parameters}; never probe writes.',
  inputSchema:{type:'object',properties:{tool:{type:'string',enum:allContracts.map(contract=>contract.name)},domain:{type:'string',enum:domains},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:20}},oneOf:[{required:['tool'],not:{anyOf:[{required:['domain']},{required:['offset']},{required:['limit']}]}},{required:['domain'],not:{required:['tool']}}],additionalProperties:false},
});

const invalid=freeze({ok:false,error:{code:'MODEL_OPERATION_SCHEMA_INPUT_INVALID',message:'参数契约查询只接受 {tool: "准确的已登记操作名"}。'}});
const unavailable=freeze({ok:false,error:{code:'MODEL_OPERATION_SCHEMA_UNAVAILABLE',message:'该名称没有可用的 BuildX 模型操作契约。'}});
const views=new Map(contracts.map(contract=>[contract.name,freeze({ok:true,value:{tool:contract.name,
  description:contract.description,inputSchema:contract.inputSchema,
  requiresFamilyLifecycleCapability:contract.requiresFamilyLifecycleCapability}})]));
for(const contract of reads)views.set(contract.name,freeze({ok:true,value:{tool:contract.name,description:contract.description,inputSchema:contract.inputSchema,...contract.outputSchema?{outputSchema:contract.outputSchema}:{},kind:'read'}}));

/** Contract discovery is not an execution capability or a model permission. */
export function describeModelOperationSchema(input){
  try{
    if(input===null||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid;
    const keys=Reflect.ownKeys(input),descriptors=Object.getOwnPropertyDescriptors(input);
    if(keys.some(key=>typeof key!=='string'||!Object.hasOwn(descriptors[key],'value')))return invalid;
    if(Object.hasOwn(descriptors,'domain')){
      if(keys.some(key=>!['domain','offset','limit'].includes(key)))return invalid;
      const domain=descriptors.domain.value,offset=Object.hasOwn(descriptors,'offset')?descriptors.offset.value:0,limit=Object.hasOwn(descriptors,'limit')?descriptors.limit.value:20;
      if(!domains.includes(domain)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20)return invalid;
      const matches=allContracts.filter(item=>domainOf(item.name)===domain);
      return {ok:true,value:{domain,offset,limit,total:matches.length,hasMore:offset+limit<matches.length,tools:matches.slice(offset,offset+limit).map(item=>({name:item.name,kind:reads.includes(item)?'read':'operation',description:(item.description??'').slice(0,240)}))}};
    }
    const property=descriptors.tool;
    if(keys.length!==1||keys[0]!=='tool'||!property||!Object.hasOwn(property,'value')||typeof property.value!=='string')return invalid;
    return views.get(property.value)??unavailable;
  }catch{return invalid;}
}
