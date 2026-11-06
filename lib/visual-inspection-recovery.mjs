// The original transport owns this capability. A caller supplies no path,
// document, session handle or replacement operation during recovery.
export function createVisualRecoveryOwner({receiptOwner,restore,failureEvidence}){
  let inFlight=null,recovery=null,restored=null;
  function completed(original){return {ok:true,value:{...original.value,status:'failed',terminal:true,canCheckAgain:false,message:'原视觉检查未完整完成；已核对随后恢复回执，检查视图已清理。',evidence:{...original.value.evidence,restorationStatus:'restored',recoveryRequestId:restored.requestId}}};}
  const hasPendingView=original=>original?.ok===true&&original.value?.evidence?.restorationStatus==='pending'&&typeof original.value.evidence.sessionHandle==='string';
  async function inspectOnce(){
    const original=await receiptOwner.inspect();
    if(!hasPendingView(original))return original;
    if(restored)return completed(original);
    if(recovery?.unknown){
      if(!recovery.owner)return {...original,value:{...original.value,recoveryStatus:'unconfirmed'}};
      const checked=await recovery.owner.inspect();
      if(checked?.ok===true&&checked.value?.terminal===true&&checked.value?.evidence?.restorationStatus==='restored'){
        restored={requestId:checked.value.requestId};return completed(original);
      }
      const prior=checked?.value;
      if(checked?.ok===true&&(prior?.terminal===true||prior?.evidence?.operation==='restore_visual_session'&&
        prior.evidence.restorationStatus==='pending'&&prior.evidence.sessionHandle===original.value.evidence.sessionHandle))recovery.unknown=false;
      recovery.status=prior?.status??'unconfirmed';recovery.requestId=prior?.requestId??recovery.requestId;
      return {...original,value:{...original.value,canRestoreVisual:!recovery.unknown,recoveryStatus:recovery.status,recoveryRequestId:recovery.requestId}};
    }
    return {...original,value:{...original.value,canRestoreVisual:true,...recovery?{recoveryStatus:recovery.status,recoveryRequestId:recovery.requestId}:{}}};
  }
  async function restoreOnce(shouldContinue){
    const original=await receiptOwner.inspect();
    if(!hasPendingView(original)||restored||recovery?.unknown)throw new Error('当前没有可恢复的原检查视图。');
    if(recovery?.owner){
      const closed=await recovery.owner.close();
      if(closed?.ok!==true||closed.value?.closed!==true)throw new Error('上次恢复的回执仍待核对。');
    }
    try{
      const value=await restore(original.value.evidence.sessionHandle,shouldContinue);
      recovery={owner:value.receiptOwner??null,unknown:false,status:'pending',requestId:value?.request_id??null};
      if(value?.value?.restoration?.status==='restored'&&value.value.cleanup_pending===false){restored={requestId:value.request_id};return completed(original);}
    }catch(error){
      const facts=failureEvidence(error);
      recovery={owner:facts.receiptOwner??error?.receiptOwner??null,unknown:facts.outcome!=='not_started',status:facts.outcome??'unconfirmed',requestId:facts.requestIds?.[0]??null};
    }
    return {...original,value:{...original.value,canRestoreVisual:!recovery.unknown,recoveryStatus:recovery.status,recoveryRequestId:recovery.requestId}};
  }
  return Object.freeze({
    inspect(){if(!inFlight)inFlight=inspectOnce().finally(()=>{inFlight=null;});return inFlight;},
    restoreVisual(shouldContinue=()=>true){
      if(inFlight)throw new Error('原检查视图正在核查。');
      inFlight=restoreOnce(shouldContinue).finally(()=>{inFlight=null;});
      return inFlight;
    },
    async close(){
      if(inFlight)await inFlight;
      if(recovery?.owner){const closed=await recovery.owner.close();if(closed?.ok!==true||closed.value?.closed!==true)return closed;recovery=null;}
      return receiptOwner.close();
    }
  });
}
