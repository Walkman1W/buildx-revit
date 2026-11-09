const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const denied=(status,error)=>({status,body:{error}});

// A local installation has one signed-in BuildX account at a time. The browser's
// chat client ID is never an authentication credential. Only this owner consumes
// the opaque HttpOnly cookie; Supabase credentials never enter HTTP responses.
export function createPanelAccounts({auth=null,required=false,getBusy=()=>false,onClear=()=>{},now=Date.now,cookieName='buildx_model_session'}){
  if(required&&!auth)throw new Error('客户模式缺少 BuildX 认证配置，已停止启动。');
  if(!/^[a-z_]{1,40}$/.test(cookieName))throw new Error('Invalid account cookie configuration');
  const methods=auth?Object.fromEntries(['signIn','signUp','verifySession','refresh','signOut','release','close'].map(key=>{
    if(typeof auth[key]!=='function')throw new Error('Incomplete account provider');return [key,auth[key].bind(auth)];
  })):null;
  const requestGrant=typeof auth?.requestInferenceGrant==='function'?auth.requestInferenceGrant.bind(auth):null;
  let current=null,changing=false,closed=false,generation=0,expiryTimer=null;
  const empty=()=>({configured:Boolean(auth),required:Boolean(required),signedIn:false,user:null,expiresAt:null,message:auth?'请登录 BuildX 账号。':'账号后端未配置；当前为本地研究模式。'});
  function cookie(req){
    const raw=req.headers.cookie;if(typeof raw!=='string'||raw.length>4096)return null;
    const values=raw.split(';').map(item=>item.trim()).filter(item=>item.startsWith(cookieName+'='));
    if(values.length!==1)return null;const value=values[0].slice(cookieName.length+1);
    return /^[A-Za-z0-9_-]{16,160}$/.test(value)?value:null;
  }
  const setCookie=id=>cookieName+'='+id+'; HttpOnly; SameSite=Strict; Path=/';
  const clearCookie=()=>cookieName+'=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
  const publicView=value=>({configured:true,required:Boolean(required),signedIn:true,user:{id:value.user.id,email:value.user.email??null},expiresAt:value.expiresAt,message:'BuildX 已登录；Codex 登录和产品授权需分别核对。'});
  function sessionFacts(value){
    if(!plain(value))return null;
    const {sessionId,user,expiresAt}=value;
    if(!plain(user))return null;
    const {id,email=null}=user,at=now();
    if(typeof sessionId!=='string'||!/^[A-Za-z0-9_-]{16,160}$/.test(sessionId)||typeof id!=='string'||!id||id.length>100||
      (email!==null&&(typeof email!=='string'||!email||email.length>320))||!Number.isSafeInteger(expiresAt)||expiresAt<=at||expiresAt-at>366*86400000)return null;
    return {sessionId,user:{id,email},expiresAt};
  }
  function clear(reason,{release=true}={}){
    const old=current;current=null;generation++;clearTimeout(expiryTimer);expiryTimer=null;
    old?.delivery?.detach();
    if(old&&release)methods.release(old.sessionId);
    if(old)onClear(reason);
  }
  function schedule(){
    clearTimeout(expiryTimer);const owner=current;if(!owner)return;
    const remaining=owner.expiresAt-now();
    expiryTimer=setTimeout(()=>{if(current!==owner)return;if(owner.expiresAt<=now())clear('BuildX 登录已到期，请重新登录。');else schedule();},Math.min(remaining,2147483647));
    expiryTimer.unref?.();
  }
  function pendingView(){return {...empty(),retainedSession:true,message:'BuildX 本机登录仍保留，但身份核验未完成；请刷新或清除本机登录。'};}
  function view(){return current&&current.expiresAt>now()?current.verified===true?publicView(current):pendingView():empty();}
  function checkIdentity(owner,renew=false){
    const revision=generation,check={promise:null};
    // Verification and an explicitly requested rotation share one operation.
    // No old verify is allowed to invalidate a newer successful rotation.
    if(renew)owner.verified=false;
    check.promise=Promise.resolve().then(()=>methods[renew?'refresh':'verifySession'](owner.sessionId)).catch(()=>({ok:false})).then(checked=>{
      if(closed||current!==owner||revision!==generation)return {state:'stale',account:empty()};
      // Timers can be delayed. A late result must not replace an already-passed
      // access deadline with a future expiry before the timer gets to clear it.
      if(owner.expiresAt<=now()){clear('BuildX 登录已到期，请重新登录。');return {state:'cleared',account:empty()};}
      if(!checked?.ok){
        owner.verified=false;
        if(renew||['AUTH_SESSION_EXPIRED','AUTH_SESSION_INVALID','AUTH_SESSION_CHANGED','AUTH_DENIED'].includes(checked?.error?.code))clear(renew?'BuildX 登录续期未确认，请重新登录。':'BuildX 登录已失效，请重新登录。');
        return {state:current===owner?'retained':'cleared',account:current===owner?pendingView():empty()};
      }
      const facts=sessionFacts(checked.value);
      if(!facts||facts.sessionId!==owner.sessionId||facts.user.id!==owner.user.id){clear('BuildX 账号身份发生变化，请重新登录。');return {state:'cleared',account:empty()};}
      Object.assign(owner,facts,{verified:true});schedule();return {state:'verified',account:publicView(owner)};
    }).finally(()=>{if(owner.checking===check)owner.checking=null;});
    owner.checking=check;return check;
  }
  async function status(req){
    if(!auth||closed)return empty();
    const owner=current;if(!owner||cookie(req)!==owner.sessionId)return empty();
    if(owner.expiresAt<=now()){clear('BuildX 登录已到期，请重新登录。');return empty();}
    return (await (owner.checking||checkIdentity(owner)).promise).account;
  }
  async function authorize(req){const account=await status(req);return {allowed:!required||account.signedIn,account};}
  // The caller opts into this check for operations that require a licence.
  // Each decision is freshly obtained from the backend; network uncertainty,
  // stale identity, expiry and disabled licences all deny the new operation.
  async function authorizeLicense(req){
    const owner=current,revision=generation;
    if(!owner||closed||cookie(req)!==owner.sessionId||owner.expiresAt<=now()||typeof auth?.licenseStatus!=='function')
      return {allowed:false,license:null,reason:'unavailable'};
    return checkLicense(owner,revision);
  }
  async function authorizeCurrentLicense(){
    const owner=current,revision=generation;
    if(!owner||owner.verified!==true||closed||owner.expiresAt<=now()||typeof auth?.licenseStatus!=='function')return {allowed:false,license:null,reason:'unavailable'};
    return checkLicense(owner,revision);
  }
  async function checkLicense(owner,revision){
    try{
      const result=await auth.licenseStatus(owner.sessionId);
      if(closed||current!==owner||generation!==revision||owner.expiresAt<=now())return {allowed:false,license:null,reason:'identity_changed'};
      if(!result?.ok)return {allowed:false,license:null,reason:'unavailable'};
      const license=result.value;
      if(!plain(license)||!['unactivated','trial','active','expired','disabled'].includes(license.status))
        return {allowed:false,license:null,reason:'unavailable'};
      return {allowed:['trial','active'].includes(license.status),license,reason:license.status};
    }catch{return {allowed:false,license:null,reason:'unavailable'};}
  }
  // Server-internal identity facts, never returned by an HTTP account view.
  // With a request, only its current cookie can select this owner. Internal
  // state/SSE consumers can inspect the one installation-wide current owner.
  function bindingIdentity(req){
    const owner=current;
    if(closed||!owner||owner.expiresAt<=now()||(req&&cookie(req)!==owner.sessionId))return null;
    return {sessionId:owner.sessionId,userId:owner.user.id,generation,verified:owner.verified===true,expiresAt:owner.expiresAt};
  }
  // Only an internal active-turn owner can bind this call to the account it
  // captured when accepting the turn. The browser's account API has no route
  // for fetching or observing inference grants.
  async function requestCurrentInferenceGrant(binding,turnId,{signal}={}){
    const owner=current,revision=generation;
    function ownsTurnAccount(){
      return requestGrant&&!closed&&!changing&&!signal?.aborted&&current===owner&&generation===revision&&
        owner?.verified===true&&owner.expiresAt>now()&&binding?.verified===true&&binding.generation===revision&&
        binding.sessionId===owner.sessionId&&binding.userId===owner.user.id&&binding.expiresAt>now();
    }
    if(!ownsTurnAccount())return null;
    try{
      const grant=await requestGrant(owner.sessionId,turnId,{signal});
      return ownsTurnAccount()&&grant?.ok===true?grant.value:null;
    }catch{return null;}
  }
  // The HTTP adapter passes its original ServerResponse, never browser data.
  // finish proves local flush only, not that a browser received the cookie.
  // A known close before finish cannot leave an unclaimed local login behind.
  function loginDelivery(response){
    if(!response)return null;
    let abandoned=false,issued=null;
    const detach=()=>{response.removeListener('close',onClose);response.removeListener('finish',onFinish);};
    const onFinish=()=>{detach();if(issued)issued.delivery=null;};
    const onClose=()=>{
      detach();
      if(response.writableFinished)return;
      abandoned=true;
      if(issued&&current===issued)clear('登录响应已断开，本次本机登录已清除。');
    };
    response.once('close',onClose);response.once('finish',onFinish);
    return {detach,unavailable:()=>abandoned||response.destroyed||response.writableEnded,
      issue:owner=>{issued=owner;owner.delivery={detach};}};
  }
  async function action(route,input,req,response=null){
    if(!auth)return denied(503,'BuildX 账号后端未配置。');
    if(closed)return denied(503,'账号服务正在停止。');
    if(changing||getBusy())return denied(409,'请等待当前对话、连接或账号操作结束，再操作账号。');
    if(!['sign-in','sign-up','sign-out','refresh-session','license-status','redeem'].includes(route))return denied(404,'未知账号操作。');
    if(['license-status','redeem'].includes(route)){
      const allowed=route==='redeem'?['client','code']:['client'];
      if(!plain(input)||Reflect.ownKeys(input).some(key=>!allowed.includes(key))||route==='redeem'&&(typeof input.code!=='string'||!/^[0-9a-f]{64}$/.test(input.code)))return denied(400,'许可请求格式无效。');
      const owner=current,revision=generation;
      if(!owner||cookie(req)!==owner.sessionId||owner.expiresAt<=now())return denied(401,'请先登录 BuildX 账号。');
      const fn=route==='redeem'?auth.redeemInvite:auth.licenseStatus;
      if(typeof fn!=='function')return denied(503,'产品许可服务尚未配置。');
      changing=true;
      try{
        const result=await fn.call(auth,owner.sessionId,...(route==='redeem'?[input.code]:[]));
        if(closed||current!==owner||generation!==revision||owner.expiresAt<=now())return route==='redeem'
          ?{status:409,body:{error:'账号已变化，兑换结果未确认；请在原账号刷新许可状态。',outcome:'unknown'}}
          :denied(409,'账号已变化，许可结果未应用。');
        if(!result?.ok)return {status:502,body:{error:route==='redeem'?'兑换结果未确认，请先刷新许可状态，勿自动重试。':'许可状态未确认，请稍后刷新。',outcome:route==='redeem'?'unknown':undefined}};
        return {status:200,body:{ok:true,license:result.value}};
      }catch{return {status:502,body:{error:route==='redeem'?'兑换结果未确认，请先刷新许可状态，勿自动重试。':'许可状态未确认，请稍后刷新。',outcome:route==='redeem'?'unknown':undefined}};}
      finally{changing=false;}
    }
    if(route==='refresh-session'&&(!plain(input)||Reflect.ownKeys(input).some(key=>key!=='client')))return denied(400,'续期只接受本机请求标识，不接收凭据或账号覆盖。');
    if(current&&cookie(req)!==current.sessionId)return denied(409,'本机已有其他 BuildX 登录，请先在原窗口退出。');
    if(!['sign-out','refresh-session'].includes(route)&&current)return denied(409,'请先退出当前 BuildX 账号，再登录或注册。');
    if(route==='refresh-session'){
      if(!current)return denied(401,'没有可续期的本机登录，请重新登录。');
      if(current.expiresAt<=now()){clear('BuildX 登录已到期，请重新登录。');return {status:401,cookie:clearCookie(),body:{error:'登录已到期，请重新登录。',account:empty()}};}
      if(current.checking)return denied(409,'账号核验尚未结束，请稍后再续期。');
    }
    if(route==='sign-out'&&!current)return {status:200,body:{ok:true,account:empty()},cookie:clearCookie()};
    const delivery=['sign-in','sign-up'].includes(route)?loginDelivery(response):null;
    if(delivery?.unavailable()){delivery.detach();return denied(409,'账号响应连接已断开，本次请求未发起。');}
    changing=true;const revision=generation;let issued=false;
    try{
      if(route==='refresh-session'){
        const outcome=await checkIdentity(current,true).promise;
        if(outcome.state==='verified')return {status:200,body:{ok:true,account:outcome.account}};
        if(outcome.state==='stale')return denied(409,'登录已变化，本次续期结果未应用。');
        return {status:502,cookie:clearCookie(),body:{error:'登录续期未确认，本机登录已清除；请重新登录，勿重复提交续期。',account:outcome.account}};
      }
      if(route==='sign-out'){
        const owner=current;clear('BuildX 已退出；旧会话和上下文已清除。',{release:false});
        let result;try{result=await methods.signOut(owner.sessionId);}catch{result={ok:false};}
        return {status:200,cookie:clearCookie(),body:{ok:true,account:empty(),remoteRevoked:result?.ok?result.value?.remoteRevoked===true:null,message:result?.ok?'已退出 BuildX。':'本机已退出；远端会话注销未确认。'}};
      }
      const result=await methods[route==='sign-in'?'signIn':'signUp'](input.email,input.password);
      if(closed||revision!==generation||delivery?.unavailable()){if(result?.ok&&result.value?.sessionId)methods.release(result.value.sessionId);return denied(409,'账号连接已变化，本次结果未应用。');}
      if(!result?.ok)return denied(result?.error?.code==='AUTH_INPUT_INVALID'?400:401,'注册或登录未完成，请核对信息后重试。');
      if(result.value?.state==='confirmation_required')return {status:200,body:{ok:true,verificationRequired:true,account:empty(),message:'请先完成邮箱验证，再返回登录。'}};
      const facts=sessionFacts(result.value);
      if(!facts){if(result.value?.sessionId)methods.release(result.value.sessionId);return denied(502,'账号服务返回了无法核验的会话。');}
      onClear('BuildX 身份已变更；旧会话和上下文已清除。');
      current={...facts,verified:true};delivery?.issue(current);issued=true;generation++;schedule();
      return {status:200,cookie:setCookie(current.sessionId),body:{ok:true,account:publicView(current)}};
    }catch{return denied(502,'账号服务暂时不可用，请稍后重试。');}
    finally{changing=false;if(!issued)delivery?.detach();}
  }
  async function close(){closed=true;clear('BuildX 服务已停止。');if(!methods)return {closed:true};const result=await methods.close();return {closed:result?.ok===true&&result.value?.closed===true};}
  return Object.freeze({required:Boolean(required),configured:Boolean(auth),view,status,authorize,authorizeLicense,authorizeCurrentLicense,bindingIdentity,requestCurrentInferenceGrant,action,close});
}
