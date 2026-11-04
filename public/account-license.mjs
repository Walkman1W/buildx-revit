// License state is always fetched from the account backend. A redeemed code is
// never retained in browser storage, and a timed-out redemption is not repeated.
const panel=document.getElementById('account-panel');
if(panel){
  const section=document.createElement('section');
  section.setAttribute('aria-label','软件授权');
  const title=document.createElement('h3');title.textContent='软件授权';
  const status=document.createElement('p');status.setAttribute('role','status');status.textContent='登录后可查询授权或兑换邀请码。';
  const label=document.createElement('label');label.textContent='邀请码';
  const code=document.createElement('input');code.type='password';code.autocomplete='off';code.maxLength=64;label.append(code);
  const check=document.createElement('button');check.type='button';check.className='secondary-button';check.textContent='查询授权';
  const redeem=document.createElement('button');redeem.type='button';redeem.className='secondary-button';redeem.textContent='兑换';
  section.append(title,status,label,check,redeem);panel.querySelector('.account-content').append(section);
  let generation=0,busy=false;
  const states={unactivated:'未激活',trial:'试用中',active:'有效',expired:'已到期',disabled:'已停用'};
  async function request(url,options,signal){
    const response=await fetch(url,{cache:'no-store',credentials:'same-origin',redirect:'error',...options,signal});
    const data=await response.json();
    if(!response.ok){const error=new Error('request_failed');error.status=response.status;throw error;}
    return data;
  }
  async function perform(action){
    if(busy)return;
    const invitation=action==='redeem'?code.value.trim():'';
    if(action==='redeem')code.value='';
    if(action==='redeem'&&!/^[a-f0-9]{64}$/.test(invitation)){status.textContent='邀请码格式无效，请核对后重新输入。';return;}
    busy=true;check.disabled=true;redeem.disabled=true;const owner=++generation;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try{
      const state=await request('/api/status',{},controller.signal);
      if(owner!==generation)return;
      if(state.workspace?.kind!=='model'||state.account?.signedIn!==true||typeof state.csrf!=='string'){
        status.textContent='请先登录并核验 BuildX 账号。';return;
      }
      const client=sessionStorage.getItem('revit-codex-client');
      if(!client||!/^[a-zA-Z0-9-]{1,80}$/.test(client))throw new Error('client_unavailable');
      const data=await request('/api/account/'+(action==='redeem'?'redeem':'license-status'),{
        method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':state.csrf},
        body:JSON.stringify(action==='redeem'?{client,code:invitation}:{client})},controller.signal);
      if(owner!==generation)return;
      const license=data?.license;
      if(data?.ok!==true||!license||!Object.hasOwn(states,license.status)||
        ![null,'string'].includes(license.startsAt===null?null:typeof license.startsAt)||
        ![null,'string'].includes(license.endsAt===null?null:typeof license.endsAt))throw new Error('invalid_license');
      status.textContent='授权状态：'+states[license.status]+(license.endsAt?'；截止 '+license.endsAt:'')+'。';
    }catch(error){
      if(owner!==generation)return;
      status.textContent=action==='redeem'?(error.status>=400&&error.status<500?'兑换未通过，请查询授权状态并核对邀请码。':'兑换结果尚未确认，请先查询授权状态；不要重复提交。'):'授权状态未能核验，请稍后查询。';
    }finally{clearTimeout(timer);if(owner===generation){busy=false;check.disabled=false;redeem.disabled=false;}}
  }
  check.addEventListener('click',()=>void perform('status'));
  redeem.addEventListener('click',()=>void perform('redeem'));
  const invalidate=()=>{generation++;busy=false;check.disabled=false;redeem.disabled=false;code.value='';status.textContent='账号或页面已变化，请重新查询授权。';};
  window.addEventListener('buildx-account-changed',invalidate);
  window.addEventListener('pagehide',invalidate);
}
