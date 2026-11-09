// Internal owner: identity, turn creation and grant issuance are supplied by
// trusted application composition, never by a panel request.
export function createManagedPanelInference({isCurrent,openTurn,finishTurn,now=Date.now}={}) {
  if (![isCurrent,openTurn,finishTurn,now].every(fn=>typeof fn==='function')) throw new TypeError('Invalid managed inference owner');
  let active=null,stopped=false;
  const unavailable=()=>Object.assign(new Error('托管推理轮次不可用或清理未确认。'),{code:'MANAGED_TURN_UNAVAILABLE'});
  function current(lease,signal) {
    if(stopped||active!==lease||lease.closing||signal?.aborted||lease.signal?.aborted||!lease.turnId||now()>=lease.expiresAt)return false;
    try {
      const valid=isCurrent({account:lease.account,connection:lease.connection});
      return valid===true&&!stopped&&active===lease&&!lease.closing&&!signal?.aborted&&!lease.signal?.aborted&&now()<lease.expiresAt;
    } catch {return false;}
  }
  function closeLease(lease) {
    if(lease.closing)return lease.closing;
    lease.closing=(async()=>{
      if(lease.opening)await lease.opening.catch(()=>{});
      if(!lease.turnId){
        if(lease.knownAbsent){lease.signal?.removeEventListener('abort',lease.onAbort);if(active===lease)active=null;return Object.freeze({closed:true});}
        return Object.freeze({closed:false});
      }
      try {
        const result=await finishTurn({account:lease.account,turnId:lease.turnId});
        if(result?.closed!==true)return Object.freeze({closed:false});
        lease.signal?.removeEventListener('abort',lease.onAbort);
        if(active===lease)active=null;
        return Object.freeze({closed:true});
      } catch {return Object.freeze({closed:false});}
    })();
    return lease.closing;
  }
  async function beginTurn({account,connection,requestGrant,signal,allowLocalTools}={}) {
    if(stopped||active||typeof requestGrant!=='function'||signal?.aborted||allowLocalTools!==undefined&&typeof allowLocalTools!=='function')throw unavailable();
    const localToolScope=allowLocalTools?Symbol():null;
    const lease={account,connection,requestGrant,signal,turnId:null,expiresAt:0,opening:null,closing:null,onAbort:null,
      localToolScope,allowLocalTools};
    active=lease;
    lease.onAbort=()=>{void closeLease(lease);};
    signal?.addEventListener('abort',lease.onAbort,{once:true});
    lease.opening=Promise.resolve().then(async()=>{
      if(isCurrent({account,connection})!==true||signal?.aborted||stopped){lease.knownAbsent=true;throw unavailable();}
      const value=await openTurn({account,signal});
      if(value===null){lease.knownAbsent=true;throw unavailable();}
      if(!value||typeof value.turnId!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(value.turnId)||!Number.isSafeInteger(value.expiresAt))throw unavailable();
      lease.turnId=value.turnId;lease.expiresAt=value.expiresAt;
    });
    try {await lease.opening;} catch(error) {
      // A failing open can have committed remotely: retain the slot for audit.
      if(lease.knownAbsent)await closeLease(lease);
      else if(!lease.closing)lease.closing=Promise.resolve(Object.freeze({closed:false}));
      throw error;
    }
    if(!await current(lease,signal)){await closeLease(lease);throw unavailable();}
    return Object.freeze({close:()=>closeLease(lease),...(localToolScope?{localToolScope}:{})});
  }
  function isLocalToolScopeCurrent(scope){
    const lease=active;
    if(typeof scope!=='symbol'||lease?.localToolScope!==scope)return false;
    try{
      if(current(lease)&&lease.allowLocalTools()===true&&current(lease))return true;
    }catch{/* A failed owner check revokes this local scope. */}
    lease.localToolScope=null;
    return false;
  }
  async function getCloudAuthorization({signal}={}) {
    const lease=active;
    if(!lease||!await current(lease,signal))throw unavailable();
    const onAbort=()=>{void closeLease(lease);};
    signal?.addEventListener('abort',onAbort,{once:true});
    try {
      if(signal?.aborted){void closeLease(lease);throw unavailable();}
      const grant=await lease.requestGrant(lease.turnId,{signal});
      if(!await current(lease,signal))throw unavailable();
      if(!grant||typeof grant.token!=='string'||!grant.token||grant.turnId!==lease.turnId||
        !Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=now()||grant.expiresAt>lease.expiresAt)throw unavailable();
      return grant;
    } finally {signal?.removeEventListener('abort',onAbort);}
  }
  async function close(){stopped=true;return active?closeLease(active):Object.freeze({closed:true});}
  const isIdleForModeSwitch=()=>!stopped&&active===null;
  return Object.freeze({isCurrent,beginTurn,isLocalToolScopeCurrent,getCloudAuthorization,close,isIdleForModeSwitch});
}

// The same local auth owner used by the panel retains the login bearer.
// Only a confirmed denial releases the slot as "not opened".
export function createManagedPanelInferenceForAccount({accountAuth,isCurrent,now}={}) {
  const open=accountAuth&&Object.getOwnPropertyDescriptor(accountAuth,'openInferenceTurn')?.value;
  const finish=accountAuth&&Object.getOwnPropertyDescriptor(accountAuth,'finishInferenceTurn')?.value;
  if(!Object.isFrozen(accountAuth)||typeof open!=='function'||typeof finish!=='function')
    throw new TypeError('Managed inference requires the trusted BuildX account owner');
  return createManagedPanelInference({
    isCurrent,now,
    async openTurn({account,signal}){
      const result=await open.call(accountAuth,account.sessionId,{signal});
      if(result?.ok===true)return result.value;
      if(['AUTH_DENIED','AUTH_SESSION_INVALID','AUTH_SESSION_EXPIRED','AUTH_INFERENCE_UNCONFIGURED','AUTH_BUSY'].includes(result?.error?.code))return null;
      throw new Error('托管推理轮次开通结果尚未确认。');
    },
    async finishTurn({account,turnId}){
      const result=await finish.call(accountAuth,account.sessionId,turnId);
      return {closed:result?.ok===true&&result.value?.closed===true};
    }
  });
}
