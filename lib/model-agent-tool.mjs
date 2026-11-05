import {modelOperationContracts} from './model-operation-contracts.mjs';

const freezeTree=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeTree(child);Object.freeze(value);}return value;};
// Descriptions remain complete in the on-demand contract. Strip only schema
// annotations from the registration copy, keeping every validation keyword and
// literal value. Property maps are not schema nodes: a user field named
// "description" (or data inside enum/default) must survive unchanged.
function registrationSchema(schema){
  const copy=structuredClone(schema);
  const visit=rule=>{
    if(!rule||typeof rule!=='object'||Array.isArray(rule))return;
    delete rule.description;
    for(const keyword of ['properties','patternProperties','$defs','definitions','dependentSchemas','dependencies'])for(const child of Object.values(rule[keyword]??{}))visit(child);
    for(const keyword of ['items','additionalProperties','additionalItems','contains','propertyNames','not','if','then','else','unevaluatedProperties','unevaluatedItems']){
      if(Array.isArray(rule[keyword]))rule[keyword].forEach(visit);else visit(rule[keyword]);
    }
    for(const keyword of ['allOf','anyOf','oneOf'])rule[keyword]?.forEach(visit);
  };
  visit(copy);return copy;
}
// This schema advertises each registered operation's existing contract. It is
// not an authorization or a substitute for trusted dispatch-side validation.
function modelAgentTool(includeFamilyLifecycle){
const supportedTools=modelOperationContracts(includeFamilyLifecycle);
const variants=supportedTools.map(tool=>({properties:{tool:{type:'string',enum:[tool.name]},parameters:registrationSchema(tool.inputSchema)},required:['tool','parameters']}));
return freezeTree({
  type:'function',
  name:'buildx_model_operation',
  description:'Request a registered Revit operation through the BuildX permission owner using exactly {tool,parameters}; mode belongs inside parameters. First read buildx_model_operation_schema for the exact required fields and units. Do not probe this write entry with missing or empty parameters. Model writes follow the selected transaction permission; visual tools own temporary views and cleanup. C#, commands and family/file workflows retain their separate approval. Never retry an unknown outcome.',
  inputSchema:{type:'object',properties:{tool:{type:'string',enum:supportedTools.map(tool=>tool.name)},parameters:{type:'object'}},required:['tool','parameters'],additionalProperties:false,oneOf:variants}
});
}
export const MODEL_AGENT_TOOL=modelAgentTool(false);
export const MODEL_AGENT_TOOL_WITH_FAMILY_LIFECYCLE=modelAgentTool(true);
