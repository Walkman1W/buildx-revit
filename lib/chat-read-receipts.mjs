import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {panelConversationId} from './panel-chat-format.mjs';

export const CHAT_READ_RECEIPT_PATH='/internal/workbench-read-receipt';
export const CHAT_READ_RECEIPT_META='buildx/readReceipt';
export const CHAT_READ_RECEIPT_KEY_ENV='BUILDX_CHAT_READ_RECEIPT_KEY';
export const CHAT_READ_RECEIPT_PORT_ENV='BUILDX_CHAT_READ_RECEIPT_PORT';
const terminalStatuses=new Set(['received','expired','not_started','failed']);
const budget=180_000,capacity=64;
const pollDelays=[0,1000,3000,10000,20000,30000,30000,30000,30000];
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const equal=(left,right)=>hex(left)&&hex(right)&&timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[null,Object.prototype].includes(Object.getPrototypeOf(value));
const fields=(value,names)=>object(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const sign=(key,proof)=>createHmac('sha256',Buffer.from(key,'hex')).update(JSON.stringify([
  proof.version,proof.ticket,proof.requestId,proof.tool,proof.expires
])).digest('hex');
const fresh=proof=>Number.isSafeInteger(proof.expires)&&proof.expires>Date.now()&&proof.expires<=Date.now()+budget;
function verify(key,proof){
  return fields(proof,['version','ticket','requestId','tool','expires','signature'])&&proof.version===1&&
    panelConversationId(proof.ticket)&&panelConversationId(proof.requestId)&&typeof proof.tool==='string'&&
    /^revit_[a-z0-9_]{1,70}$/.test(proof.tool)&&fresh(proof)&&equal(proof.signature,sign(key,proof));
}

export function createChatReadReceiptProducer({key,port}){
  if(!hex(key)||!Number.isSafeInteger(port)||port<1024||port>65535)return null;
  let active=0;
  return Object.freeze({
    retain(tool,requestId,owner){
      if(active>=capacity||!panelConversationId(requestId)||typeof owner?.inspect!=='function'||typeof owner.close!=='function')return null;
      const proof={version:1,ticket:randomUUID(),requestId,tool,expires:Date.now()+budget};
      proof.signature=sign(key,proof);
      if(!verify(key,proof))return null;
      active++;
      void (async()=>{
        try{
          for(const delay of pollDelays){
            await wait(delay,undefined,{ref:false});
            if(!fresh(proof))break;
            const checked=await owner.inspect(),result=checked?.ok===true?checked.value:null;
            if(result?.requestId!==requestId)continue;
            if(result.status==='host_changed')break;
            if(result.terminal===true&&terminalStatuses.has(result.status)){
              await fetch('http://127.0.0.1:'+port+CHAT_READ_RECEIPT_PATH,{method:'POST',redirect:'error',
                headers:{'Content-Type':'application/json','X-BuildX-Read-Receipt-Key':key},
                body:JSON.stringify({proof,status:result.status}),signal:AbortSignal.timeout(2500)}).then(response=>response.body?.cancel());
              break;
            }
          }
        }catch{/* An absent or unverified receipt remains unknown. */}
        finally{try{await owner.close();}catch{}active--;}
      })();
      return proof;
    }
  });
}

export function createChatReadReceiptInbox(key,eligibleTools){
  if(!hex(key))return null;
  const pending=new Map();let closed=false;
  const accepted=proof=>!closed&&verify(key,proof)&&eligibleTools.has(proof.tool);
  function slot(proof){
    if(!accepted(proof))return null;
    const prior=pending.get(proof.ticket);
    if(prior)return prior.signature===proof.signature?prior:null;
    if(pending.size>=capacity)return null;
    const entry={signature:proof.signature,listener:null,result:null,delivered:false};
    entry.timer=setTimeout(()=>pending.delete(proof.ticket),Math.max(0,proof.expires-Date.now()));entry.timer.unref?.();
    pending.set(proof.ticket,entry);return entry;
  }
  function deliver(entry){
    if(!entry.listener||!entry.result)return;
    const listener=entry.listener,result=entry.result;
    entry.listener=null;entry.result=null;entry.delivered=true;
    listener(result);
  }
  return Object.freeze({
    path:CHAT_READ_RECEIPT_PATH,
    authorized:header=>!closed&&equal(key,header),
    read(item){
      const proof=item?.result?._meta?.[CHAT_READ_RECEIPT_META];
      if(item?.type!=='mcpToolCall'||item.server!=='revit_workbench'||!['failed','completed'].includes(item.status)||
        item.result?.structuredContent?.buildxToolOutcome?.outcome!=='unconfirmed'||!accepted(proof)||
        proof.tool!==(item.tool||item.name))return null;
      return Object.freeze({...proof});
    },
    observe(proof,listener){
      const entry=slot(proof);if(!entry||entry.listener||entry.delivered)return false;
      entry.listener=listener;deliver(entry);return true;
    },
    receive(value){
      if(!fields(value,['proof','status'])||!terminalStatuses.has(value.status))return false;
      const entry=slot(value.proof);if(!entry||entry.result||entry.delivered)return false;
      entry.result={requestId:value.proof.requestId,status:value.status,checkedAt:new Date().toISOString()};
      deliver(entry);return true;
    },
    hasPending(){return !closed&&[...pending.values()].some(entry=>entry.listener&&!entry.delivered);},
    close(){closed=true;for(const entry of pending.values())clearTimeout(entry.timer);pending.clear();}
  });
}
