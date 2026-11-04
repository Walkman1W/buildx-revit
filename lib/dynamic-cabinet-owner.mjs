import {createHash, randomUUID} from 'node:crypto';
import {FAMILY_TOOLS, FAMILY_OPERATION_BY_TOOL, assertFamilyArguments} from './family-tools.mjs';

// Isolated, opt-in composition only. No panel, service or MCP catalog imports
// this module. A trusted adapter must hold the sole human decision channel and
// must expose the receipt review/acknowledgement path before it is enabled.
const names=Object.freeze({create:'revit_family_create_cabinet',save:'revit_family_save_cabinet',close:'revit_family_close_cabinet'});
const labels=Object.freeze({create:'创建独立柜族',save:'保存柜族文件',close:'关闭柜族并放弃未保存内容'});
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const data=v=>plain(v)&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const exact=(v,keys)=>data(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const text=(v,max=200)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const reply=(success,message)=>({success,contentItems:[{type:'inputText',text:message}]});
const stableReceipt=value=>{const copy=structuredClone(value);delete copy.checkedAt;return JSON.stringify(copy);};
const definitions=new Map(FAMILY_TOOLS.map(tool=>[tool.name,tool]));
const freeze=v=>{if(v&&typeof v==='object'){for(const value of Object.values(v))freeze(value);Object.freeze(v);}return v;};

// Reuse the named family's owning schema; the outer operation selects exactly
// one named command. It is never advertised by the native MCP catalog.
export const DYNAMIC_CABINET_TOOL=freeze({type:'function',name:'buildx_cabinet_job',description:'Request one bounded cabinet family operation. Each operation requires separate human approval. Never retry an unknown result; inspect the original receipt.',inputSchema:{type:'object',properties:{action:{type:'string',enum:Object.keys(names)},parameters:{type:'object'}},required:['action','parameters'],additionalProperties:false,oneOf:Object.entries(names).map(([action,name])=>({properties:{action:{const:action},parameters:structuredClone(definitions.get(name).inputSchema)}}))}});

function snapshotArgs(args){
  if(!exact(args,['action','parameters'])||!Object.hasOwn(names,args.action)||!data(args.parameters))throw new Error('Invalid cabinet request');
  const name=names[args.action], schema=definitions.get(name).inputSchema, chosen=args.parameters;
  for(const key of Reflect.ownKeys(chosen)){
    const rule=schema.properties[key],value=chosen[key];
    if(!rule)throw new Error('Invalid cabinet parameter');
    if(rule.type==='string'&&(!text(value,rule.maxLength??200)||value.length<(rule.minLength??0)||rule.enum&&!rule.enum.includes(value)))throw new Error('Invalid cabinet parameter');
    if(['number','integer'].includes(rule.type)&&(!Number.isFinite(value)||rule.type==='integer'&&!Number.isInteger(value)||value<rule.minimum||value>rule.maximum))throw new Error('Invalid cabinet parameter');
  }
  if(schema.required.some(key=>!Object.hasOwn(chosen,key)))throw new Error('Missing cabinet parameter');
  assertFamilyArguments(name,chosen);
  // Copy in schema order: the approved digest and dispatched snapshot have
  // identical stable fields, including omission instead of invented defaults.
  const parameters={};for(const key of Object.keys(schema.properties))if(Object.hasOwn(chosen,key))parameters[key]=chosen[key];
  return freeze({action:args.action,parameters});
}
function snapshotScope(scope,params){
  if(!exact(scope,['client','conversationId','threadId','turnId','generation','revision','account'])||!['client','conversationId','threadId','turnId'].every(k=>text(scope[k]))||!Number.isSafeInteger(scope.generation)||scope.generation<1||!Number.isSafeInteger(scope.revision)||scope.revision<0||scope.threadId!==params.threadId||scope.turnId!==params.turnId)throw new Error('Invalid cabinet scope');
  const a=scope.account;
  if(a!==null&&(!exact(a,['scope','sessionId','userId','generation'])||a.scope!=='model'||!text(a.sessionId)||!text(a.userId)||!Number.isSafeInteger(a.generation)||a.generation<1))throw new Error('Invalid cabinet account');
  return freeze({client:scope.client,conversationId:scope.conversationId,threadId:scope.threadId,turnId:scope.turnId,generation:scope.generation,revision:scope.revision,account:a===null?null:{scope:a.scope,sessionId:a.sessionId,userId:a.userId,generation:a.generation}});
}

export function createDynamicCabinetOwner({invokeCommand,approvalTimeoutMs=60000,maxHistory=4096}={}){
  if(typeof invokeCommand!=='function'||!Number.isSafeInteger(approvalTimeoutMs)||approvalTimeoutMs<1||approvalTimeoutMs>120000||!Number.isSafeInteger(maxHistory)||maxHistory<1||maxHistory>65536)throw new TypeError('Invalid cabinet owner configuration');
  const entries=new Map(),seen=new Set();let closing=false;
  const current=e=>{try{return !closing&&e.isCurrent()===true;}catch{return false;}};
  function propose({params,scope,isCurrent}={}){
    if(closing||entries.size||seen.size>=maxHistory||typeof isCurrent!=='function'||isCurrent()!==true)throw new Error('Cabinet request unavailable');
    if(!exact(params,['threadId','turnId','callId','tool','arguments'])||params.tool!==DYNAMIC_CABINET_TOOL.name||!text(params.threadId)||!text(params.turnId)||!text(params.callId))throw new Error('Invalid cabinet request');
    const chosen=snapshotArgs(params.arguments),binding=snapshotScope(scope,params),key=hash([binding,params.callId]);
    if(seen.has(key))throw new Error('Duplicate cabinet request');
    const ticket=randomUUID(),deadline=Date.now()+approvalTimeoutMs;
    const digest=hash({version:1,ticket,scope:binding,callId:params.callId,tool:params.tool,request:chosen,deadline});
    const entry={ticket,digest,binding,chosen,isCurrent,deadline,state:'proposed',cancelled:false,receiptOwner:null,result:null};
    seen.add(key);entries.set(ticket,entry);
    entry.timer=setTimeout(()=>{if(entry.state==='proposed'){entry.state='cancelled';entries.delete(ticket);}},approvalTimeoutMs);entry.timer.unref?.();
    return Object.freeze({ticket,digest,kind:'plugin',action:labels[chosen.action],target:chosen.parameters.job_handle??'新建独立族文档',cwd:'',source:'BuildX 柜族作业',parameters:JSON.stringify(chosen.parameters),deadline});
  }
  async function decide({ticket,digest,decision}={}){
    const e=entries.get(ticket);
    if(!e||e.state!=='proposed'||digest!==e.digest||!['accept','decline'].includes(decision)||!current(e)||Date.now()>=e.deadline)throw new Error('Cabinet approval unavailable');
    clearTimeout(e.timer);
    if(decision==='decline'){e.state='declined';entries.delete(ticket);return reply(false,'用户拒绝了此柜族操作。');}
    // Set the one-shot state before calling the injected producer; neither a
    // timeout nor an exception may be interpreted as proof of non-publication.
    e.state='dispatching';
    let result;try{result=await invokeCommand(names[e.chosen.action],e.chosen.parameters,{confirmed:true,retainReceiptOwner:true,shouldContinue:()=>current(e)&&!e.cancelled});}catch{result={ok:false,error:{outcome:'unconfirmed'}};}
    e.receiptOwner=result?.receiptOwner??null;e.result=result;e.state='received';
    const command=names[e.chosen.action],received=result?.value?.data;
    const completed=result?.ok===true&&result.value?.command===command&&result.value?.tool===command&&
      received?.operation===FAMILY_OPERATION_BY_TOOL[command]&&text(received.hostSession)&&received.value?.success===true;
    if(completed&&!e.receiptOwner){try{e.confirmedResult=structuredClone(result.value);}catch{/* Keep unknown when the response is not safe to retain. */}}
    if(!current(e)||e.cancelled){e.state='unconfirmed';throw new Error('Cabinet result retained for original owner');}
    if(e.receiptOwner||!completed&&(result?.ok!==false||result?.error?.outcome!=='not_started')){
      e.state='unconfirmed';return reply(false,'柜族操作结果待核对；保留原回执，不要重新提交。');
    }
    entries.delete(ticket);
    if(completed){let output;try{output=JSON.stringify(result.value);}catch{output='操作已返回；输出无法序列化。';}return reply(true,output);}
    return reply(false,'柜族操作未开始。');
  }
  async function cancel({ticket}={}){
    const e=entries.get(ticket);if(!e)return false;
    e.cancelled=true;clearTimeout(e.timer);
    if(e.state==='proposed'){e.state='cancelled';entries.delete(ticket);return true;}
    // An in-flight request may already have been published. Keep its original
    // receipt and promise ownership even when the originating turn is gone.
    return false;
  }
  async function close(){
    closing=true;
    for(const e of entries.values()){clearTimeout(e.timer);e.cancelled=true;if(e.state==='proposed')entries.delete(e.ticket);}
    return {closed:entries.size===0};
  }
  // A future trusted panel may bridge these operations to authenticated UI.
  // They cannot adopt another account's owner or release an unverified receipt.
  async function inspect({ticket,scope}={}){
    const e=entries.get(ticket);if(!e||e.state!=='unconfirmed'||hash(snapshotScope(scope,{threadId:e.binding.threadId,turnId:e.binding.turnId}))!==hash(e.binding))throw new Error('Original cabinet receipt unavailable');
    if(e.receiptOwner&&typeof e.receiptOwner.inspect==='function')return e.receiptOwner.inspect();
    if(e.confirmedResult)return {ok:true,value:{terminal:true,status:'received',result:structuredClone(e.confirmedResult)}};
    throw new Error('Original cabinet receipt unavailable');
  }
  async function acknowledge({ticket,scope,expected}={}){
    const e=entries.get(ticket);if(!e||e.state!=='unconfirmed'||!data(expected)||e.acknowledging||e.receiptOwner&&typeof e.receiptOwner.close!=='function')throw new Error('Original cabinet receipt unavailable');
    e.acknowledging=true;
    try{
    const result=await inspect({ticket,scope});
    if(result?.ok!==true||result.value?.terminal!==true||stableReceipt(result.value)!==stableReceipt(expected))throw new Error('Original cabinet receipt changed or remains unconfirmed');
    if(e.receiptOwner){const stopped=await e.receiptOwner.close();if(stopped?.ok!==true||stopped.value?.closed!==true)throw new Error('Original cabinet receipt cleanup unconfirmed');}
    entries.delete(ticket);return {closed:true};
    }finally{e.acknowledging=false;}
  }
  return Object.freeze({propose,decide,cancel,close,inspect,acknowledge});
}
