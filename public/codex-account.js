// Local connection confirmation is deliberately narrower than binding a stable
// provider account. Challenges and visible account observations stay in memory.
function createCodexAccountPanel(env) {
  const {document,fetch,sessionStorage,crypto,window,CustomEvent,AbortController,TextEncoder,
    setTimeout,clearTimeout,now=Date.now,timeoutMs=12000}=env;
  const get=id=>document.getElementById(id),panel=get('codex-account-panel');
  if(!panel)return null;
  let client;
  try{client=sessionStorage.getItem('revit-codex-client')||crypto.randomUUID();sessionStorage.setItem('revit-codex-client',client);}
  catch{client=crypto.randomUUID();}
  let latest=null,scopeKey=null,source=false,workspaceKind=null,generation=0,active=null,challenge=null,observation=null,expiryTimer=null;
  const controllers=new Set();
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const iso=value=>typeof value==='string'&&value.length<=64&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
  function notice(message='',error=false){get('codex-account-notice').textContent=message;get('codex-account-notice').hidden=!message;get('codex-account-notice').className='account-notice'+(error?' error':'');}
  function confirmation(value){
    if(!record(value)||typeof value.required!=='boolean'||typeof value.phase!=='string'||value.phase.length>64||typeof value.localConnectionConfirmed!=='boolean')return null;
    return {required:value.required,phase:value.phase,localConnectionConfirmed:value.localConnectionConfirmed};
  }
  function parseStatus(value){
    if(!record(value)||!record(value.workspace)||!['model','source-development','customer-chat'].includes(value.workspace.kind))throw new Error('invalid_status');
    const kind=value.workspace.kind;
    if(workspaceKind==='customer-chat'&&kind!==workspaceKind)throw new Error('wrong_workspace');
    const account=value.account,meta=value.codexAccount;
    const customer=record(account)&&(kind!=='customer-chat'||account.configured===true)&&account.required===true&&account.signedIn===true&&record(account.user)&&typeof account.user.id==='string'&&account.user.id.length>0&&account.user.id.length<=128;
    const validMeta=record(meta)&&integer(meta.connectionGeneration)&&integer(meta.accountRevision)&&integer(meta.observationSequence)&&typeof meta.status==='string'&&meta.status.length<=64;
    const key=kind!=='source-development'&&customer&&validMeta?JSON.stringify([kind,account.user.id,meta.connectionGeneration,meta.accountRevision]):null;
    return {kind,source:kind==='source-development',customer,key,busy:value.busy!==false,
      ready:value.codexConnectionReady===true,meta:validMeta?{status:meta.status,observedAt:meta.observedAt,
        observationSequence:meta.observationSequence}:null,confirmation:confirmation(value.codexConfirmation),
      csrf:typeof value.csrf==='string'&&value.csrf.length>0&&value.csrf.length<=200?value.csrf:null};
  }
  function clearChallenge(){challenge=null;clearTimeout(expiryTimer);expiryTimer=null;}
  function invalidate(){generation++;active=null;clearChallenge();observation=null;for(const controller of controllers)controller.abort();}
  function checking(){return latest?.meta?.status==='checking'||latest?.confirmation?.phase==='checking';}
  function connectionUsable(){return Boolean(!source&&latest?.customer&&scopeKey&&latest.meta&&latest.confirmation&&latest.ready&&latest.meta.status==='verified'&&latest.meta.observationSequence>0&&iso(latest.meta.observedAt)&&!checking()&&!latest.busy);}
  function canOperate(){return connectionUsable()&&!active;}
  function render(){
    panel.hidden=source;
    const confirmed=Boolean(latest?.confirmation?.localConnectionConfirmed&&latest?.customer&&scopeKey);
    get('codex-account-summary').textContent=confirmed?'本机连接已确认':checking()?'正在核对':'未确认';
    get('codex-account-state').textContent=!latest?'本机连接状态尚未确认，请刷新。':!latest.customer
      ?'尚未作本机身份确认。请先登录已配置的 BuildX 账号；研究模式不能确认连接。'
      :!latest.meta||!latest.confirmation?'本机 Codex 确认契约尚未就绪，请核对本地服务。'
      :confirmed?'已确认使用此本机连接；稳定账号 ID 和工作区 ID 仍未取得。'
      :checking()?'正在核对本机 Codex，等待本次回执后再操作。'
      :!latest.ready||latest.meta.status!=='verified'?'本机 Codex 连接尚未就绪，请先重新连接并核对。'
      :challenge?'请核对本次读取的邮箱、套餐和时间，再明确确认使用此连接。'
      :'先读取本机 Codex，再明确确认使用此连接。';
    get('codex-account-observation').hidden=!observation;
    get('codex-account-email').textContent=observation?'邮箱：'+(observation.email===null?'未返回':observation.email):'';
    get('codex-account-plan').textContent=observation?'套餐：'+observation.planType:'';
    get('codex-account-observed-at').textContent=observation?'读取时间（UTC）：'+observation.observedAt:'';
    get('codex-account-inspect').disabled=!canOperate();
    get('codex-account-confirm').disabled=!canOperate()||!challenge||challenge.key!==scopeKey||challenge.expiresAt<=now();
    get('codex-account-refresh').disabled=source||Boolean(active);
  }
  function applyStatus(value){
    const next=parseStatus(value),changed=next.key!==scopeKey||next.source!==source;
    if(changed){const hadObservation=Boolean(scopeKey||challenge||observation);invalidate();if(hadObservation)notice('BuildX 身份或 Codex 连接已变化，旧读取与确认已清除。');}
    latest=next;scopeKey=next.key;source=next.source;workspaceKind=next.kind;render();
    return !changed;
  }
  const current=owner=>active===owner&&owner.generation===generation;
  async function request(route,options,owner){
    const controller=new AbortController();controllers.add(controller);let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('codex_account_timeout'));},timeoutMs);});
    try{
      const response=await Promise.race([fetch(route,{cache:'no-store',credentials:'same-origin',redirect:'error',...options,signal:controller.signal}),timeout]);
      if(!current(owner))throw new Error('stale_codex_account');
      const value=await Promise.race([response.json(),timeout]);
      if(!current(owner))throw new Error('stale_codex_account');
      if(!response.ok){const error=new Error('codex_account_request_failed');error.status=response.status;throw error;}
      return value;
    }finally{clearTimeout(timer);controllers.delete(controller);}
  }
  function scheduleChallenge(){
    clearTimeout(expiryTimer);const owner=challenge;if(!owner)return;
    expiryTimer=setTimeout(()=>{
      if(challenge!==owner)return;
      if(owner.expiresAt>now()){scheduleChallenge();return;}
      clearChallenge();notice('本次读取的确认凭据已过期，请重新读取。');render();
    },Math.min(Math.max(0,owner.expiresAt-now()),2147483647));
  }
  function parsedInspection(value){
    if(!record(value)||value.ok!==true||typeof value.challengeId!=='string'||!/^[A-Za-z0-9_-]{16,200}$/.test(value.challengeId)||!integer(value.expiresAt)||value.expiresAt<=now()||!record(value.display)||
      value.display.type!=='chatgpt'||!(value.display.email===null||typeof value.display.email==='string'&&new TextEncoder().encode(value.display.email).length<=4096)||typeof value.display.planType!=='string'||value.display.planType.length>80||!iso(value.display.observedAt)||!confirmation(value.confirmation))throw new Error('invalid_inspection');
    return {challenge:{id:value.challengeId,expiresAt:value.expiresAt,key:scopeKey},display:{type:'chatgpt',email:value.display.email,planType:value.display.planType,observedAt:value.display.observedAt},confirmation:confirmation(value.confirmation)};
  }
  async function operate(action,initial=false){
    if(active||action!=='refresh'&&!canOperate())return;
    const owner={generation:++generation,key:scopeKey,action};active=owner;notice();render();
    try{
      const state=await request('/api/status',undefined,owner);
      applyStatus(state);
      if(!current(owner))return;
      if(action==='refresh')return;
      if(!connectionUsable()||!latest.csrf){notice('当前身份、连接或任务状态不允许确认，请刷新后核对。');return;}
      let input={client};
      if(action==='confirm'){
        if(!challenge||challenge.key!==scopeKey||challenge.expiresAt<=now()){clearChallenge();notice('没有有效的本次读取凭据，请先重新读取本机 Codex。');return;}
        input={client,challengeId:challenge.id};
      }
      const result=await request('/api/codex-account/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':latest.csrf},body:JSON.stringify(input)},owner);
      if(action==='inspect'){
        const parsed=parsedInspection(result);clearChallenge();challenge=parsed.challenge;observation=parsed.display;latest={...latest,confirmation:parsed.confirmation};scheduleChallenge();
        notice('本次读取已返回。请核对可见信息，再点击确认使用此连接。');
      }else{
        const accepted=confirmation(result?.confirmation);
        if(result?.ok!==true||!accepted||accepted.localConnectionConfirmed!==true)throw new Error('invalid_confirmation');
        clearChallenge();latest={...latest,confirmation:accepted};notice('已确认使用此本机连接；这不是稳定账号或工作区身份绑定。');
      }
    }catch(error){
      if(!current(owner))return;
      clearChallenge();observation=null;
      notice(error.message==='codex_account_timeout'?'本次结果尚未确认（请求超时）。请先刷新状态核对，不要重复提交。'
        :error.status===409?'当前连接或任务状态发生变化，请刷新状态后重新核对。'
        :error.status===401||error.status===403?'本次确认未通过身份核验，请刷新状态或重新登录 BuildX。'
        :'本次读取或确认未完成，请先刷新状态核对；不会自动重试。',true);
    }finally{
      if(current(owner)){active=null;render();if(!initial&&!source)window?.dispatchEvent(new CustomEvent('buildx-account-refreshed'));}
    }
  }
  for(const [id,action] of [['codex-account-inspect','inspect'],['codex-account-confirm','confirm'],['codex-account-refresh','refresh']])get(id).addEventListener('click',()=>{void operate(action);});
  window?.addEventListener('buildx-status',event=>{try{applyStatus(event.detail);}catch{invalidate();latest=null;scopeKey=null;notice('本机连接状态无法核对，请刷新。',true);render();}});
  window?.addEventListener('buildx-account-changed',()=>{invalidate();latest=null;scopeKey=null;notice('BuildX 账号已变化，请重新读取本机 Codex。');render();});
  window?.addEventListener('pagehide',()=>{invalidate();latest=null;scopeKey=null;render();});
  render();void operate('refresh',true);
  return {refresh:()=>operate('refresh')};
}
if(typeof document!=='undefined'&&document.getElementById('codex-account-panel'))
  createCodexAccountPanel({document,fetch,sessionStorage,crypto,window,CustomEvent,AbortController,TextEncoder,setTimeout,clearTimeout});
