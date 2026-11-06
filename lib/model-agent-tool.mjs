import {modelOperationContracts} from './model-operation-contracts.mjs';

const freezeTree=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeTree(child);Object.freeze(value);}return value;};
// The trusted dispatcher validates each complete operation contract. The
// compact advertisement is only an index, not that validation boundary.
function modelAgentTool(includeFamilyLifecycle){
const supportedTools=modelOperationContracts(includeFamilyLifecycle);
return freezeTree({
  type:'function',
  name:'buildx_model_operation',
  description:'Request a registered Revit operation through the BuildX permission owner using exactly {tool,parameters}; mode belongs inside parameters. First read buildx_model_operation_schema for the exact required fields and units. Do not probe this write entry with missing or empty parameters. Model writes follow the selected transaction permission; visual tools own temporary views and cleanup. C#, commands and family/file workflows retain their separate approval. Never retry an unknown outcome.',
  inputSchema:{type:'object',properties:{tool:{type:'string',enum:supportedTools.map(tool=>tool.name)},parameters:{type:'object'}},required:['tool','parameters'],additionalProperties:false}
});
}
export const MODEL_AGENT_TOOL=modelAgentTool(false);
export const MODEL_AGENT_TOOL_WITH_FAMILY_LIFECYCLE=modelAgentTool(true);
