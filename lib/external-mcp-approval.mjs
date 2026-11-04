import {randomUUID} from 'node:crypto';
import {snapshotExternalMcpData} from './external-mcp-owner.mjs';

const identifier=x=>typeof x==='string'&&x.length>0&&x.length<=256&&!/[\x00-\x1f\x7f]/.test(x);
function identity(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='accountId,connectionId,conversationId,sessionId'||
     ![value.accountId,value.connectionId,value.conversationId,value.sessionId].every(identifier))return null;
  return {accountId:value.accountId,connectionId:value.connectionId,conversationId:value.conversationId,sessionId:value.sessionId};
}
const same=(a,b)=>a&&b&&a.accountId===b.accountId&&a.connectionId===b.connectionId&&a.conversationId===b.conversationId&&a.sessionId===b.sessionId;

// Trusted panel composition alone owns this API. `decide(...,'approve')` is
// reachable only after an authenticated, CSRF-protected explicit user action;
// the model, server metadata and MCP annotations cannot grant approval.
export function createExternalMcpApprovalOwner({readIdentity,now=()=>Date.now(),ttlMs=120000}={}){
  if(typeof readIdentity!=='function'||typeof now!=='function'||!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>300000)throw new TypeError('Invalid approval owner');
  const pending=new Map();let closed=false;
  const current=()=>{try{return identity(readIdentity());}catch{return null;}};
  const checkTime=()=>{const value=now();return Number.isSafeInteger(value)&&value>=0?value:null;};
  const prune=time=>{for(const [id,item] of pending)if(time>=item.expiresAt)pending.delete(id);};
  function validProposal(kind,value){
    if(!['mcp_start','mcp_call'].includes(kind)||!value||typeof value!=='object'||!identifier(value.proposalId)||!identifier(value.serverId)||!identifier(value.generation))return null;
    try{return snapshotExternalMcpData(value,65536);}catch{return null;}
  }
  return Object.freeze({
    request({kind,proposal}={}){
      const who=current(),time=checkTime(),snap=validProposal(kind,proposal);
      if(closed||!who||time===null||!snap)return {ok:false,code:'APPROVAL_INVALID'};
      prune(time);if(pending.size>=16)return {ok:false,code:'APPROVAL_CAPACITY'};
      const approvalId=randomUUID(),item={kind,who,proposal:snap.value,digest:snap.digest,expiresAt:time+ttlMs,status:'pending'};
      pending.set(approvalId,item);return {ok:true,approvalId,expiresAt:item.expiresAt,kind,proposal:snap.value};
    },
    decide({approvalId,decision}={}){
      const item=pending.get(approvalId),who=current(),time=checkTime();
      if(closed||!item||time===null||time>=item.expiresAt||!same(item.who,who)||item.status!=='pending'||!['approve','deny'].includes(decision)){
        if(item)pending.delete(approvalId);return {ok:false,code:'APPROVAL_INVALID'};
      }
      if(decision==='deny'){pending.delete(approvalId);return {ok:true,status:'denied'};}
      item.status='approved';return {ok:true,status:'approved'};
    },
    async consume({approvalId,kind,proposal}={}){
      const item=pending.get(approvalId);if(item)pending.delete(approvalId);
      const who=current(),time=checkTime(),snap=validProposal(kind,proposal);
      return Boolean(!closed&&item&&time!==null&&time<item.expiresAt&&item.status==='approved'&&same(item.who,who)&&item.kind===kind&&snap&&item.digest===snap.digest);
    },
    invalidate(){pending.clear();},
    close(){closed=true;pending.clear();},
  });
}
