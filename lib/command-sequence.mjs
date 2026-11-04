import {randomUUID} from 'node:crypto';
import {workbenchFailureEvidence} from './workbench-client.mjs';

// The adapter must bind and recheck the same host/document for every call and
// invoke the ordinary tool dispatcher, which owns permissions and validation.
export const SEQUENCE_TOOLS=Object.freeze(['revit_get_selection','revit_list_levels','revit_search_elements','revit_list_family_types','revit_describe_parameters']);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const id=/^[a-z][a-z0-9-]{0,63}$/;
function bad(message){throw new Error('Command sequence: '+message);}
function data(value,depth=0){
  if(depth>12)bad('argument nesting exceeds limit');
  if(value===null||typeof value==='boolean'||typeof value==='string'||typeof value==='number'&&Number.isFinite(value))return;
  if(Array.isArray(value)){if(value.length>100)bad('argument array exceeds limit');for(const item of value)data(item,depth+1);return;}
  if(!plain(value)||Object.keys(value).length>100)bad('arguments must contain bounded JSON data');
  for(const [key,item] of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))bad('unsafe key');data(item,depth+1);}
}
export function validateSequence(steps,types){
  if(!Array.isArray(steps)||steps.length<1||steps.length>10)bad('one to ten steps required');
  const previous=new Set();
  function refs(value){
    if(Array.isArray(value)){value.forEach(refs);return;}
    if(!plain(value))return;
    if(Object.hasOwn(value,'$input')){if(Object.keys(value).length!==1||typeof value.$input!=='string'||!Object.hasOwn(types,value.$input))bad('unknown input reference');return;}
    if(Object.hasOwn(value,'$step')){if(Object.keys(value).some(k=>!['$step','path'].includes(k))||!previous.has(value.$step)||!Array.isArray(value.path)||value.path.length>12||value.path.some(k=>typeof k!=='string'||['__proto__','prototype','constructor'].includes(k)))bad('invalid earlier step reference');return;}
    Object.values(value).forEach(refs);
  }
  for(const step of steps){
    if(!plain(step)||Object.keys(step).some(k=>!['id','tool','arguments'].includes(k))||!id.test(step.id)||previous.has(step.id)||!SEQUENCE_TOOLS.includes(step.tool)||!plain(step.arguments))bad('invalid step');
    if(Object.hasOwn(step.arguments,'expected_document'))bad('document identity is supplied by the adapter');
    data(step.arguments);refs(step.arguments);previous.add(step.id);
  }
  if(Buffer.byteLength(JSON.stringify(steps),'utf8')>64000)bad('steps exceed byte limit');
  return structuredClone(steps);
}
function resolve(value,inputs,outputs){
  if(Array.isArray(value))return value.map(item=>resolve(item,inputs,outputs));
  if(!plain(value))return value;
  if(Object.hasOwn(value,'$input'))return structuredClone(inputs[value.$input]);
  if(Object.hasOwn(value,'$step')){
    let result=outputs.get(value.$step);
    for(const key of value.path){if(result===null||typeof result!=='object'||!Object.hasOwn(result,key))bad('referenced step output is unavailable');result=result[key];}
    return structuredClone(result);
  }
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolve(item,inputs,outputs)]));
}
// The receipt owner is a live capability, not serializable command data. Transfer
// the exact producing owner separately; the caller owns inspection and cleanup.
function withOwner(result,source){
  const owner=workbenchFailureEvidence(source).receiptOwner??source?.receiptOwner;
  if(owner)Object.defineProperty(result,'receiptOwner',{value:owner,enumerable:false});
  return result;
}
export async function runSequence(record,inputs,options){
  if(typeof options.bindSequence!=='function'||typeof options.verifySequence!=='function'||typeof options.executeStep!=='function')bad('identity-bound dispatcher is required');
  const execution_id=randomUUID(),results=record.steps.map(s=>({id:s.id,tool:s.tool,status:'not_started'})),outputs=new Map();
  let identity;
  try{identity=await options.bindSequence();if(!identity||typeof identity.session!=='string'||!identity.session||typeof identity.path!=='string'||!identity.path)bad('bound host/document identity is unavailable');}
  catch(error){const facts=workbenchFailureEvidence(error),uncertain=Boolean(facts.receiptOwner);return withOwner({execution_id,status:uncertain?'unknown':'not_started',steps:results,error:{message:error.message,...facts.requestIds.length?{request_ids:facts.requestIds}:{}}},error);}
  for(let i=0;i<record.steps.length;i++){
    const step=record.steps[i],result=results[i];
    let args;
    try{
      if(options.shouldContinue&&options.shouldContinue()!==true)bad('stopped before step');
      args=resolve(step.arguments,inputs,outputs);
      if(await options.verifySequence(identity)!==true)bad('host or document identity changed');
    }catch(error){const facts=workbenchFailureEvidence(error),uncertain=Boolean(facts.receiptOwner);result.status=uncertain?'unknown':'not_started';result.error={message:error.message,...facts.requestIds.length?{request_ids:facts.requestIds}:{}};return withOwner({execution_id,status:uncertain?'unknown':i?'partial':'not_started',steps:results},error);}
    let receipt;
    try{receipt=await options.executeStep(step.tool,args,identity);}
    catch(error){const facts=workbenchFailureEvidence(error);result.status=facts.outcome==='not_started'?'not_started':facts.outcome==='failed'?'failed':'unknown';result.error={message:error.message,...error.requestId?{request_id:error.requestId}:{}};return withOwner({execution_id,status:result.status==='unknown'?'unknown':i?'partial':result.status,steps:results},error);}
    if(!receipt||receipt.ok!==true){result.status=receipt?.outcome==='not_started'?'not_started':receipt?.outcome==='failed'?'failed':'unknown';if(receipt){const {receiptOwner,...safeReceipt}=receipt;result.receipt=safeReceipt;}else result.receipt=null;return withOwner({execution_id,status:result.status==='unknown'?'unknown':i?'partial':result.status,steps:results},receipt);}
    result.receipt=receipt.value;
    try{if(await options.verifySequence(identity)!==true)bad('host or document identity changed after step');}
    catch(error){const facts=workbenchFailureEvidence(error);result.status='unknown';result.error={message:error.message,...facts.requestIds.length?{request_ids:facts.requestIds}:{}};return withOwner({execution_id,status:'unknown',steps:results},error);}
    result.status='succeeded';outputs.set(step.id,receipt.value);
  }
  return {execution_id,status:'succeeded',steps:results};
}
