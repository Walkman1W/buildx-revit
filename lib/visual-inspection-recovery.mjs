// The original transport owns this capability. A caller supplies no path,
// document, session handle or replacement operation during recovery.
export function createVisualRecoveryOwner({receiptOwner,restore,failureEvidence}){
  let inFlight=null,recovery=null,restored=null;
  function completed(original){return {ok:true,value:{...original.value,status:'failed',terminal:true,canCheckAgain:false,message:'原视觉检查未完整完成；已核对随后恢复回执，检查视图已清理。',evidence:{...original.value.evidence,restorationStatus:'restored',recoveryRequestId:restored.requestId}}};}
  async function inspectOnce(){
    const original=await receiptOwner.inspect();
    if(original?.ok!==true||original.value?.evidence?.restorationStatus!=='pending')return original;
    if(restored)return completed(original);
    if(recovery?.unknown){
      if(!recovery.owner)return {...original,value:{...original.value,recoveryStatus:'unconfirmed'}};
      const checked=await recovery.owner.inspect();
      if(checked?.ok===true&&checked.value?.terminal===true&&checked.value?.evidence?.restorationStatus==='restored'){
        restored={requestId:checked.value.requestId};return completed(original);
      }
      // Unknown requests are observed, never replayed. A known failed restore
      // may only be retried by a subsequent explicit inspection call.
      if(checked?.ok===true&&checked.value?.terminal===true){recovery.unknown=false;recovery.finished=true;}
      return {...original,value:{...original.value,recoveryStatus:checked?.value?.status??'unconfirmed',recoveryRequestId:checked?.value?.requestId??null}};
    }
    if(recovery?.owner){const closed=await recovery.owner.close();if(closed?.ok!==true||closed.value?.closed!==true)return original;recovery=null;}
    try{
      const value=await restore(original.value.evidence.sessionHandle);
      recovery={owner:value.receiptOwner??null,unknown:false,finished:true};
      if(value?.value?.restoration?.status==='restored'&&value.value.cleanup_pending===false){restored={requestId:value.request_id};return completed(original);}
      return {...original,value:{...original.value,recoveryStatus:'pending',recoveryRequestId:value?.request_id??null}};
    }catch(error){
      const facts=failureEvidence(error);recovery={owner:facts.receiptOwner??error?.receiptOwner??null,unknown:facts.outcome!=='not_started',finished:facts.outcome==='not_started'};
      return {...original,value:{...original.value,recoveryStatus:facts.outcome??'unconfirmed',recoveryRequestId:facts.requestIds?.[0]??null}};
    }
  }
  return Object.freeze({
    inspect(){if(!inFlight)inFlight=inspectOnce().finally(()=>{inFlight=null;});return inFlight;},
    async close(){
      if(inFlight)await inFlight;
      if(recovery?.owner){const closed=await recovery.owner.close();if(closed?.ok!==true||closed.value?.closed!==true)return closed;recovery=null;}
      return receiptOwner.close();
    }
  });
}
