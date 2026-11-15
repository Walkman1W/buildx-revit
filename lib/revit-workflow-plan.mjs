import {createHash} from 'node:crypto';
import {CONFIRMED_WRITE_TOOLS} from './confirmed-write-profile.mjs';
import {modelOperationEffect} from './model-operation-effects.mjs';
import {validateToolArguments} from './workbench-client.mjs';

const stepId=/^[a-z][a-z0-9_]{0,47}$/;
const hostId=/^[a-f0-9]{32}$/;
const modelPath=/^[a-z]:[\\/].+\.rvt$/i;
const invalid=code=>Object.assign(new Error(code),{code});
const boundedText=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);
const owns=(value,key)=>Object.hasOwn(value,key);

function snapshot(value,depth=0,budget={nodes:0}){
  if(depth>12||++budget.nodes>3000)throw invalid('WORKFLOW_INPUT_LIMIT');
  if(value===null||typeof value==='boolean'||Number.isFinite(value)||typeof value==='string')return value;
  if(!value||typeof value!=='object')throw invalid('WORKFLOW_INVALID_INPUT');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Array.isArray(value)){
    const length=descriptors.length.value;
    if(length>3000||Reflect.ownKeys(descriptors).length!==length+1)throw invalid('WORKFLOW_INVALID_INPUT');
    return Object.freeze(Array.from({length},(_,index)=>{
      const item=descriptors[index];
      if(!item||!owns(item,'value'))throw invalid('WORKFLOW_INVALID_INPUT');
      return snapshot(item.value,depth+1,budget);
    }));
  }
  if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw invalid('WORKFLOW_INVALID_INPUT');
  return Object.freeze(Object.fromEntries(Reflect.ownKeys(descriptors).sort((a,b)=>String(a).localeCompare(String(b),'en')).map(key=>{
    if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key)||!owns(descriptors[key],'value'))throw invalid('WORKFLOW_INVALID_INPUT');
    return [key,snapshot(descriptors[key].value,depth+1,budget)];
  })));
}

// Builds review data only. A server-side approval owner still has to bind the
// user decision, recheck the scope, and publish each step through Revit.
export function prepareRevitWorkflow({draft,scope,availableTools,now,deadline}){
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(deadline)||deadline<=now||deadline-now>120000||!Array.isArray(availableTools))throw invalid('WORKFLOW_SCOPE_INVALID');
  const binding=snapshot(scope),input=snapshot(draft);
  if(!binding||!boundedText(binding.account,256)||!boundedText(binding.conversationId,200)||!hostId.test(binding.hostSession??'')||
     !boundedText(binding.document?.title,256)||!boundedText(binding.document?.path,2048)||!modelPath.test(binding.document.path)||
     !Number.isSafeInteger(binding.accessRevision)||binding.accessRevision<0)throw invalid('WORKFLOW_SCOPE_INVALID');
  if(!input||Object.keys(input).length!==1||!Array.isArray(input.steps)||input.steps.length<1||input.steps.length>12||Buffer.byteLength(JSON.stringify(input))>60000)throw invalid('WORKFLOW_INPUT_LIMIT');
  const allowed=new Set(availableTools),ids=new Set();
  const steps=input.steps.map(step=>{
    if(!step||Array.isArray(step)||Object.keys(step).length!==4||!stepId.test(step.id??'')||ids.has(step.id)||typeof step.tool!=='string'||
       !Array.isArray(step.dependsOn)||new Set(step.dependsOn).size!==step.dependsOn.length||!step.dependsOn.every(id=>ids.has(id))||
       !step.parameters||typeof step.parameters!=='object'||Array.isArray(step.parameters))throw invalid('WORKFLOW_STEP_INVALID');
    const effect=modelOperationEffect(step.tool).kind;
    if(!allowed.has(step.tool)||!(effect==='read'||effect==='model_transaction'&&CONFIRMED_WRITE_TOOLS.includes(step.tool)))throw invalid('WORKFLOW_TOOL_UNAVAILABLE');
    if(owns(step.parameters,'expected_document'))throw invalid('WORKFLOW_DOCUMENT_SUPPLIED');
    if(effect==='model_transaction'&&!['rollback','commit'].includes(step.parameters.mode))throw invalid('WORKFLOW_MODE_REQUIRED');
    let args;
    try{args=validateToolArguments(step.tool,step.parameters,{allowDocumentBinding:true});}
    catch{throw invalid('WORKFLOW_PARAMETERS_INVALID');}
    ids.add(step.id);
    return snapshot({id:step.id,tool:step.tool,dependsOn:step.dependsOn,effect,parameters:args});
  });
  const plan=snapshot({schemaVersion:1,binding,deadline,steps});
  const digest=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return Object.freeze({digest,plan});
}
