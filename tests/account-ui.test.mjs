// Production account.js executes in a DOM/HTTP fixture. No browser, cloud,
// account, Codex, Revit or real credentials are used by these checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/account.js',import.meta.url),'utf8');
const html = await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
const flush = async()=>{for(let index=0;index<6;index++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {resolve,promise};};
const user={id:'fixture-user-1',email:'learner@example.test'};
const signedOut={configured:true,required:true,signedIn:false,user:null,expiresAt:null};
const signedIn={configured:true,required:true,signedIn:true,user,expiresAt:2000000000000};
class Element{
  constructor(){this.events=new Map();this.hidden=false;this.disabled=false;this.value='';this.textContent='';this.className='';}
  addEventListener(name,fn){const callbacks=this.events.get(name)||[];callbacks.push(fn);this.events.set(name,callbacks);}
  fire(name,options={}){const event={type:name,preventDefault(){this.defaultPrevented=true;},...options};for(const fn of this.events.get(name)||[])fn(event);return event;}
}
async function fixture(options={}){
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  const elements=new Map(ids.map(id=>[id,new Element()]));
  const get=id=>{assert.ok(elements.has(id),'unknown DOM id '+id);return elements.get(id);};
  let account=options.account??signedOut;
  let status={workspace:{kind:'model'},busy:false,csrf:'fixture-csrf',...options.status};
  let write=options.write??(async()=>({account:signedIn}));
  const requests=[],storage=new Map(),events=[],listeners=new Map(),opened=[];
  let timers=[];
  const window={open(...args){opened.push(args);},dispatchEvent(event){events.push(event);for(const fn of listeners.get(event.type)||[])fn(event);},
    addEventListener(name,fn){const list=listeners.get(name)||[];list.push(fn);listeners.set(name,list);}};
  const context=vm.createContext({document:{getElementById:id=>elements.get(id)||null},window,
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    crypto:{randomUUID:()=> 'fixture-client'},AbortController,TextEncoder,
    CustomEvent:class {constructor(type){this.type=type;}},
    setTimeout:(fn,ms)=>{if(options.manualTimers){const timer={fn,ms,cleared:false};timers.push(timer);return timer;}return setTimeout(fn,ms);},
    clearTimeout:timer=>{if(options.manualTimers)timer.cleared=true;else clearTimeout(timer);},
    fetch:async(url,input={})=>{
      requests.push({url,input});
      let data;
      if(url==='/api/status'){if(status instanceof Error)throw status;data={account,...status};}
      else if(url==='/api/account/status'){if(account instanceof Error)throw account;data=account;}
      else {const result=await write(url,input);if(result?.httpError)return {ok:false,status:result.status,json:async()=>result.data};data=result;}
      return {ok:true,status:200,json:async()=>data};
    }});
  vm.runInContext(source,context,{filename:'production/public/account.js'});await flush();
  return {get,requests,storage,events,timers,window,opened,
    setAccount:value=>{account=value;},setStatus:value=>{status=value;},setWrite:value=>{write=value;},
    fill(){get('account-email').value=user.email;get('account-password').value='fixture-passphrase';},
    async click(id){get(id).fire('click');await flush();},
    posts:()=>requests.filter(item=>item.input.method==='POST')};
}
test('unconfigured account remains a labelled research state and never submits credentials',async()=>{
  const f=await fixture({account:{...signedOut,configured:false,required:false}});
  assert.equal(f.get('account-panel').hidden,false);assert.equal(f.get('account-summary').textContent,'未配置');
  assert.match(f.get('account-state').textContent,/研究模式/);assert.equal(f.get('account-sign-in').disabled,true);
  f.fill();await f.click('account-sign-in');assert.equal(f.posts().length,0);assert.equal(f.get('account-password').value,'');
});
test('source profile hides account interface without any account request',async()=>{
  const f=await fixture({status:{workspace:{kind:'source-development'}}});
  assert.equal(f.get('account-panel').hidden,true);assert.deepEqual(f.requests.map(item=>item.url),['/api/status']);
  await f.click('account-sign-in');assert.equal(f.posts().length,0);assert.ok(f.requests.every(item=>item.url==='/api/status'));
  await f.click('account-sign-up');assert.deepEqual(f.opened,[]);assert.equal(f.posts().length,0);
});

test('model invitation registration opens its reserved page without credentials or a configured backend',async()=>{
  for(const configured of [false,true]){
    const f=await fixture({account:{...signedOut,configured,required:false}});
    assert.equal(f.get('account-sign-up').textContent,'邀请码注册');assert.equal(f.get('account-sign-up').disabled,false);
    const before=f.requests.length;f.fill();f.get('account-sign-up').fire('click');
    assert.deepEqual(f.opened,[['/register.html','_blank','noopener,noreferrer']]);
    assert.equal(f.requests.length,before);assert.equal(f.posts().length,0);assert.equal(f.get('account-password').value,'');
    await flush();assert.equal(f.posts().length,0);
  }
});

test('unverified workspace cannot open registration or submit signup',async()=>{
  const f=await fixture({status:{workspace:undefined}});
  assert.equal(f.get('account-sign-up').disabled,true);f.fill();await f.click('account-sign-up');
  assert.deepEqual(f.opened,[]);assert.equal(f.posts().length,0);
});

test('customer chat keeps BuildX login separate and visible without automatic credential submission',async()=>{
  const f=await fixture({status:{workspace:{kind:'customer-chat'},busy:false,csrf:'fixture-csrf'}});
  assert.equal(f.get('account-panel').hidden,false);assert.equal(f.get('account-summary').textContent,'未登录');
  assert.match(f.get('account-state').textContent,/先登录 BuildX/);assert.equal(f.posts().length,0);
  f.fill();await f.click('account-sign-in');assert.equal(f.posts().length,1);assert.equal(f.posts()[0].url,'/api/account/sign-in');
  assert.equal(f.get('account-summary').textContent,'已登录');assert.deepEqual(f.events.map(event=>event.type),['buildx-account-changed']);
});

test('customer account ceiling rejects foreign or missing workspace and optional-account fallback',async()=>{
  for(const workspace of [{kind:'model'},{kind:'source-development'},undefined]){
    const f=await fixture({status:{workspace:{kind:'customer-chat'},busy:false,csrf:'fixture-csrf'}});
    f.setStatus({workspace,busy:false,csrf:'fixture-csrf'});f.fill();await f.click('account-sign-in');
    assert.equal(f.posts().length,0);assert.equal(f.get('account-summary').textContent,'待检查');assert.equal(f.get('account-sign-in').disabled,true);
  }
  const f=await fixture({status:{workspace:{kind:'customer-chat'},busy:false,csrf:'fixture-csrf'},account:{...signedOut,required:false}});
  assert.equal(f.get('account-sign-in').disabled,true);assert.equal(f.posts().length,0);
});
test('fields do not auto-submit on input, blur or Enter',async()=>{
  const f=await fixture();f.fill();f.get('account-password').fire('input');f.get('account-email').fire('blur');
  const event=f.get('account-password').fire('keydown',{key:'Enter'});await flush();
  assert.equal(event.defaultPrevented,true);assert.equal(f.posts().length,0);assert.equal(f.get('account-sign-in').disabled,false);
});
test('sign in uses same-origin cookie request and CSRF, clears password and publishes no token',async()=>{
  const f=await fixture({write:async()=>({account:signedIn,access_token:'ignored-fixture-token'})});
  f.fill();await f.click('account-sign-in');const [request]=f.posts();
  assert.equal(request.url,'/api/account/sign-in');assert.equal(request.input.credentials,'same-origin');
  assert.equal(request.input.redirect,'error');assert.equal(request.input.headers['X-Local-Chat'],'fixture-csrf');
  assert.deepEqual(JSON.parse(request.input.body),{client:'fixture-client',email:user.email,password:'fixture-passphrase'});
  assert.equal(f.get('account-password').value,'');assert.equal(f.get('account-email').value,user.email);
  assert.equal(f.get('account-summary').textContent,'已登录');assert.equal(f.get('account-fields').hidden,true);
  assert.equal(f.events.length,1);assert.equal(f.events[0].type,'buildx-account-changed');
  assert.deepEqual([...f.storage],[['revit-codex-client','fixture-client']]);
  assert.doesNotMatch([...f.get('account-state').textContent,...f.get('account-notice').textContent].join(''),/ignored-fixture-token|fixture-passphrase/);
});
test('signup awaiting email confirmation is not treated as a logged-in or Codex-bound session',async()=>{
  const f=await fixture({status:{workspace:{kind:'customer-chat'},busy:false,csrf:'fixture-csrf'},write:async()=>({account:signedOut,verificationRequired:true})});f.fill();await f.click('account-sign-up');
  assert.equal(f.posts()[0].url,'/api/account/sign-up');assert.equal(f.get('account-summary').textContent,'未登录');
  assert.deepEqual(f.opened,[]);assert.deepEqual(JSON.parse(f.posts()[0].input.body),{client:'fixture-client',email:user.email,password:'fixture-passphrase'});
  assert.match(f.get('account-notice').textContent,/邮箱验证/);assert.equal(f.events.length,0);assert.equal(f.get('account-password').value,'');
});
test('existing valid short passwords can sign in while signup validates its own minimum',async()=>{
  const f=await fixture();f.fill();f.get('account-password').value='abc123';await f.click('account-sign-in');assert.equal(f.posts().length,1);
  const signup=await fixture({status:{workspace:{kind:'customer-chat'},busy:false,csrf:'fixture-csrf'}});signup.fill();signup.get('account-password').value='short';await signup.click('account-sign-up');
  assert.equal(signup.posts().length,0);assert.match(signup.get('account-notice').textContent,/至少 6/);
});
test('credential budget uses UTF8 bytes and never trims the password',async()=>{
  const f=await fixture();f.fill();f.get('account-password').value=' 密码  ';await f.click('account-sign-in');
  assert.equal(JSON.parse(f.posts()[0].input.body).password,' 密码  ');
  const large=await fixture();large.fill();large.get('account-password').value='密'.repeat(342);await large.click('account-sign-in');
  assert.equal(large.posts().length,0);assert.match(large.get('account-notice').textContent,/1024 字节/);
});
test('signout sends no credentials and does not claim to log out local Codex',async()=>{
  const f=await fixture({account:signedIn,write:async()=>({account:signedOut})});await f.click('account-sign-out');
  assert.deepEqual(JSON.parse(f.posts()[0].input.body),{client:'fixture-client'});
  assert.equal(f.get('account-summary').textContent,'未登录');assert.match(f.get('account-notice').textContent,/Codex 登录没有被注销/);
  assert.equal(f.events.length,1);
});
test('fresh busy status blocks sign in and sign out without posting',async()=>{
  const f=await fixture();f.fill();f.setStatus({workspace:{kind:'model'},busy:true,csrf:'fixture-csrf'});
  await f.click('account-sign-in');assert.equal(f.posts().length,0);assert.match(f.get('account-notice').textContent,/正在进行/);
  assert.equal(f.get('account-password').value,'');assert.equal(f.get('account-sign-in').disabled,true);
});
test('provider failures clear old displayed identity without echoing credential-bearing errors',async()=>{
  const f=await fixture({account:signedIn,write:async()=>({httpError:true,status:502,data:{error:'fixture-passphrase ignored-fixture-token'}})});
  await f.click('account-sign-out');assert.equal(f.get('account-summary').textContent,'待检查');assert.match(f.get('account-notice').textContent,/请求未完成/);
  assert.doesNotMatch(f.get('account-notice').textContent,/fixture-passphrase|ignored-fixture-token/);assert.equal(f.events.length,0);
});
test('account operations serialize and late completion after timeout cannot authenticate display',async()=>{
  const pending=deferred();const f=await fixture({manualTimers:true,write:()=>pending.promise});f.fill();
  await f.click('account-sign-in');await f.click('account-refresh');await f.click('account-sign-out');
  assert.equal(f.posts().length,1);assert.equal(f.get('account-refresh').disabled,true);
  const timer=f.timers.findLast(timer=>!timer.cleared);timer.fn();await flush();
  assert.match(f.get('account-notice').textContent,/超时/);assert.equal(f.get('account-password').value,'');
  pending.resolve({account:signedIn});await flush();assert.equal(f.get('account-summary').textContent,'待检查');assert.equal(f.events.length,0);
});
test('failed refresh invalidates a formerly displayed account',async()=>{
  const f=await fixture({account:signedIn});f.setAccount(new Error('fixture response failure'));await f.click('account-refresh');
  assert.equal(f.get('account-summary').textContent,'待检查');assert.doesNotMatch(f.get('account-state').textContent,/learner@/);
  assert.deepEqual({...f.get('account-panel').buildxDisplay},{signedIn:false,retained:false,email:null,summary:'待检查',canSignOut:false});
});

test('fresh model account observations clear expired identity and repeated projections cannot undo verification failure',async()=>{
  const f=await fixture({account:signedIn});
  const observe=account=>f.window.dispatchEvent({type:'buildx-model-view',detail:{enabled:true,busy:false,account}});
  observe(signedIn);
  f.setAccount(new Error('fixture unavailable'));await f.click('account-refresh');
  observe(signedIn);assert.equal(f.get('account-panel').buildxDisplay.email,null);
  observe(signedOut);assert.equal(f.get('account-summary').textContent,'未登录');
  assert.equal(f.get('account-panel').buildxDisplay.email,null);
  observe(signedIn);assert.equal(f.get('account-panel').buildxDisplay.email,user.email);
  observe(signedOut);assert.equal(f.get('account-panel').buildxDisplay.email,null);
});

test('server identity changes invalidate a pending account result without restoring the old user',async()=>{
  const pending=deferred();const f=await fixture({account:signedIn,write:()=>pending.promise});
  f.window.dispatchEvent({type:'buildx-model-view',detail:{enabled:true,busy:false,account:signedIn}});
  await f.click('account-renew');
  f.window.dispatchEvent({type:'buildx-model-view',detail:{enabled:true,busy:false,account:signedOut}});
  assert.equal(f.get('account-summary').textContent,'未登录');
  pending.resolve({account:signedIn});await flush();
  assert.equal(f.get('account-panel').buildxDisplay.email,null);assert.equal(f.get('account-summary').textContent,'未登录');
});
test('retained session is unverified, blocks new credentials, and permits explicit local cleanup',async()=>{
  const f=await fixture({account:{...signedOut,retainedSession:true},write:async()=>({account:signedOut,remoteRevoked:false})});
  assert.equal(f.get('account-summary').textContent,'待核验');assert.match(f.get('account-state').textContent,/未通过核验/);
  assert.equal(f.get('account-fields').hidden,true);assert.equal(f.get('account-sign-in').hidden,true);
  assert.equal(f.get('account-sign-up').hidden,true);assert.equal(f.get('account-sign-out').hidden,false);
  assert.equal(f.get('account-sign-out').textContent,'清除本机登录');assert.equal(f.get('account-sign-out').disabled,false);
  f.fill();await f.click('account-sign-in');assert.equal(f.posts().length,0);assert.match(f.get('account-notice').textContent,/保留的登录/);
  await f.click('account-sign-out');assert.equal(f.posts().length,1);assert.equal(f.posts()[0].url,'/api/account/sign-out');
  assert.deepEqual(JSON.parse(f.posts()[0].input.body),{client:'fixture-client'});assert.equal(f.get('account-summary').textContent,'未登录');
  assert.equal(f.events.length,1);
});
test('fresh verification restores readiness of a retained session without automatic sign in',async()=>{
  const f=await fixture({account:{...signedOut,retainedSession:true}});f.setAccount(signedIn);await f.click('account-refresh');
  assert.equal(f.get('account-summary').textContent,'已登录');assert.equal(f.get('account-sign-out').textContent,'退出 BuildX');
  assert.equal(f.posts().length,0);assert.deepEqual(f.events.map(event=>event.type),['buildx-account-refreshed']);
});
test('manual refresh reports readiness separately without an identity-change event or credentials',async()=>{
  const f=await fixture({account:signedIn});await f.click('account-refresh');
  assert.deepEqual(f.events.map(event=>event.type),['buildx-account-refreshed']);
  assert.equal(f.posts().length,0);assert.deepEqual(Object.keys(f.events[0]),['type']);
});
test('renewal posts only the local client and preserves identity-change semantics without a password',async()=>{
  const renewed={...signedIn,expiresAt:signedIn.expiresAt+3600000};
  const f=await fixture({account:signedIn,write:async()=>({ok:true,account:renewed})});
  assert.equal(f.get('account-renew').hidden,false);assert.equal(f.get('account-renew').disabled,false);
  const before=f.requests.length;f.fill();await f.click('account-renew');
  assert.deepEqual(f.requests.slice(before).map(request=>request.url),['/api/status','/api/account/refresh-session']);
  assert.equal(f.posts().length,1);const request=f.posts()[0];
  assert.equal(request.url,'/api/account/refresh-session');assert.deepEqual(JSON.parse(request.input.body),{client:'fixture-client'});
  assert.equal(request.input.headers['X-Local-Chat'],'fixture-csrf');assert.equal(request.input.credentials,'same-origin');
  assert.equal(f.get('account-password').value,'');assert.equal(f.get('account-summary').textContent,'已登录');
  assert.match(f.get('account-notice').textContent,/登录已续期/);
  assert.deepEqual(f.events.map(event=>event.type),['buildx-account-refreshed']);
  assert.deepEqual([...f.storage],[['revit-codex-client','fixture-client']]);
});
test('retained unverified session can request renewal without credentials or automatic login',async()=>{
  const f=await fixture({account:{...signedOut,retainedSession:true},write:async()=>({ok:true,account:signedIn})});
  assert.equal(f.get('account-renew').hidden,false);assert.equal(f.get('account-renew').disabled,false);
  const before=f.requests.length;assert.equal(f.get('account-password').value,'');await f.click('account-renew');
  assert.deepEqual(f.requests.slice(before).map(request=>request.url),['/api/status','/api/account/refresh-session']);
  assert.deepEqual(f.posts().map(request=>request.url),['/api/account/refresh-session']);
  assert.deepEqual(JSON.parse(f.posts()[0].input.body),{client:'fixture-client'});
  assert.equal(f.get('account-summary').textContent,'已登录');assert.deepEqual(f.events.map(event=>event.type),['buildx-account-refreshed']);
});
test('signed-out and expired server state never produces a renewal POST',async()=>{
  const f=await fixture({account:signedOut});assert.equal(f.get('account-renew').hidden,true);assert.equal(f.get('account-renew').disabled,true);
  await f.click('account-renew');assert.equal(f.posts().length,0);assert.match(f.get('account-notice').textContent,/没有可续期/);
});
test('renewal fails closed on missing status account without a second verification or fallback',async()=>{
  const f=await fixture({account:signedIn});f.setStatus({workspace:{kind:'model'},busy:false,csrf:'fixture-csrf',account:undefined});
  const before=f.requests.length;await f.click('account-renew');
  assert.deepEqual(f.requests.slice(before).map(request=>request.url),['/api/status']);assert.equal(f.posts().length,0);
  assert.equal(f.get('account-summary').textContent,'待检查');
});
test('busy or source status prevents renewal, including synthetic clicks on disabled controls',async()=>{
  const f=await fixture({account:signedIn});f.setStatus({workspace:{kind:'model'},busy:true,csrf:'fixture-csrf'});
  await f.click('account-renew');assert.equal(f.posts().length,0);assert.equal(f.get('account-renew').disabled,true);
  const source=await fixture({status:{workspace:{kind:'source-development'}}});await source.click('account-renew');
  assert.equal(source.get('account-panel').hidden,true);assert.equal(source.posts().length,0);
  assert.ok(source.requests.every(request=>request.url==='/api/status'));assert.equal(source.events.length,0);
});
test('renewal failures invalidate display and notify readiness without treating it as an identity switch',async()=>{
  for(const status of [401,502]){
    const f=await fixture({account:signedIn,write:async()=>({httpError:true,status,data:{error:'ignored-fixture-provider-secret'}})});
    await f.click('account-renew');assert.equal(f.posts().length,1);assert.equal(f.get('account-summary').textContent,'待检查');
    assert.doesNotMatch(f.get('account-notice').textContent,/ignored-fixture-provider-secret/);
    assert.deepEqual(f.events.map(event=>event.type),['buildx-account-refreshed']);
  }
});
test('renewal timeout stays unknown; explicit verification is GET only and late POST result cannot replace it',async()=>{
  const pending=deferred();const f=await fixture({account:signedIn,manualTimers:true,write:()=>pending.promise});
  await f.click('account-renew');await f.click('account-renew');assert.equal(f.posts().length,1);
  const timer=f.timers.findLast(timer=>!timer.cleared);assert.equal(timer.ms,12000);timer.fn();await flush();
  assert.equal(f.get('account-summary').textContent,'待检查');assert.match(f.get('account-notice').textContent,/超时.*核对结果.*勿重复提交/);
  assert.deepEqual(f.events.map(event=>event.type),['buildx-account-refreshed']);
  const before=f.requests.length;await f.click('account-refresh');
  assert.deepEqual(f.requests.slice(before).map(request=>request.url),['/api/status','/api/account/status']);
  assert.equal(f.posts().length,1);assert.equal(f.get('account-summary').textContent,'已登录');
  pending.resolve({ok:true,account:{...signedIn,user:{id:'late-user',email:'late@example.test'}}});await flush();
  assert.equal(f.get('account-state').textContent,'已登录：'+user.email);assert.doesNotMatch(f.get('account-notice').textContent,/登录已续期/);
  assert.deepEqual(f.events.map(event=>event.type),['buildx-account-refreshed','buildx-account-refreshed']);
});
test('pagehide invalidates a pending renewal without publishing completion or changing identity',async()=>{
  const pending=deferred();const f=await fixture({account:signedIn,write:()=>pending.promise});await f.click('account-renew');
  assert.equal(f.get('account-refresh').disabled,true);f.window.dispatchEvent({type:'pagehide'});
  assert.equal(f.get('account-refresh').disabled,false); // A bfcache return can explicitly recheck rather than remain stuck.
  pending.resolve({ok:true,account:signedIn});await flush();
  assert.equal(f.posts().length,1);assert.deepEqual(f.events.map(event=>event.type),['pagehide']);
  assert.doesNotMatch(f.get('account-notice').textContent,/登录已续期/);
});
test('nullable provider email is rendered as a verified user without using untrusted fallback metadata',async()=>{
  const f=await fixture({account:{...signedIn,user:{id:user.id,email:null},user_metadata:{email:'forged@example.test'}}});
  assert.equal(f.get('account-summary').textContent,'已登录');assert.match(f.get('account-state').textContent,/已验证用户/);
  assert.doesNotMatch(f.get('account-state').textContent,/forged/);
});
test('pagehide invalidates in-flight completion and clears the credential field',async()=>{
  const pending=deferred();const f=await fixture({write:()=>pending.promise});f.fill();await f.click('account-sign-in');
  f.window.dispatchEvent({type:'pagehide'});pending.resolve({account:signedIn});await flush();
  assert.equal(f.get('account-password').value,'');assert.equal(f.get('account-summary').textContent,'未登录');
  assert.deepEqual(f.events.map(event=>event.type),['pagehide']);
});
