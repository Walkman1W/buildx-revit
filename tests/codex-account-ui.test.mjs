import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Real widget code; DOM, HTTP and clock peers are synthetic. No browser, cloud,
// Codex process, provider login, AI turn or Revit operation is performed.
const source=await fs.readFile(new URL('../public/codex-account.js',import.meta.url),'utf8');
const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
const flush=async()=>{for(let index=0;index<8;index++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {resolve,promise};};
const start=Date.parse('2026-10-25T19:45:00.000Z');
const meta={status:'verified',connectionGeneration:1,accountRevision:2,observationSequence:3,observedAt:'2026-10-25T19:45:00.000Z',stableAccountId:null,workspaceId:null};
const confirmation={required:true,phase:'unconfirmed',localConnectionConfirmed:false,stableAccountId:null,workspaceId:null,message:'fixture'};
const modelStatus=extra=>({workspace:{kind:'model'},busy:false,csrf:'fixture-csrf',codexConnectionReady:true,
  account:{configured:true,required:true,signedIn:true,user:{id:'fixture-buildx-user',email:'buildx@example.test'}},
  codexAccount:{...meta},codexConfirmation:{...confirmation},...extra});
const inspection=extra=>({ok:true,challengeId:'fixturechallenge00000001',expiresAt:start+60000,
  display:{type:'chatgpt',email:'local-codex@example.test',planType:'pro',observedAt:'2026-10-25T19:45:00.000Z'},
  confirmation:{...confirmation,phase:'awaiting_confirmation'},...extra});
class Element{
  constructor(){this.events=new Map();this.hidden=false;this.disabled=false;this.textContent='';this.className='';}
  addEventListener(name,fn){const items=this.events.get(name)||[];items.push(fn);this.events.set(name,items);}
  fire(name,extra={}){for(const fn of this.events.get(name)||[])fn({type:name,...extra});}
}
async function fixture(t,options={}){
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element()]));
  const get=id=>{assert.ok(elements.has(id),'unknown DOM hook '+id);return elements.get(id);};
  let state=options.status??modelStatus(),clock=start;
  let inspect=options.inspect??(async()=>inspection()),confirm=options.confirm??(async()=>({ok:true,confirmation:{...confirmation,phase:'confirmed',localConnectionConfirmed:true}}));
  const requests=[],events=[],listeners=new Map(),timers=[],storage=new Map();
  const window={addEventListener(name,fn){const values=listeners.get(name)||[];values.push(fn);listeners.set(name,values);},
    dispatchEvent(event){events.push(event);for(const fn of listeners.get(event.type)||[])fn(event);}};
  const context=vm.createContext({document:{getElementById:id=>elements.get(id)||null},window,crypto:{randomUUID:()=> 'fixture-client'},
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    Date:class extends Date{static now(){return clock;}},AbortController,TextEncoder,CustomEvent:class{constructor(type){this.type=type;}},
    setTimeout:(fn,ms)=>{const timer={fn,ms,cleared:false};timers.push(timer);return timer;},clearTimeout:timer=>{if(timer)timer.cleared=true;},
    fetch:async(url,input={})=>{
      requests.push({url,input});let data;
      if(url==='/api/status'){if(state instanceof Error)throw state;data=state;}
      else if(url==='/api/codex-account/inspect')data=await inspect(input);
      else if(url==='/api/codex-account/confirm')data=await confirm(input);
      else throw new Error('unexpected fixture route');
      return data?.httpError?{ok:false,status:data.status,json:async()=>data.data}:{ok:true,status:200,json:async()=>data};
    }});
  vm.runInContext(source,context,{filename:'production/public/codex-account.js'});await flush();
  t.after(()=>window.dispatchEvent({type:'pagehide'}));
  return {get,requests,events,timers,storage,window,
    posts:()=>requests.filter(item=>item.input.method==='POST'),
    emitted:()=>events.filter(event=>['buildx-account-changed','buildx-account-refreshed'].includes(event.type)),
    setStatus:value=>{state=value;},setInspect:value=>{inspect=value;},setConfirm:value=>{confirm=value;},advance:ms=>{clock+=ms;},
    emitStatus(value){state=value;window.dispatchEvent({type:'buildx-status',detail:value});},
    async click(id){get(id).fire('click');await flush();}};
}
test('model bootstrap is GET-only; inspect and confirm remain explicit separate operations',async t=>{
  const f=await fixture(t);assert.deepEqual(f.requests.map(item=>item.url),['/api/status']);assert.equal(f.posts().length,0);
  assert.equal(f.get('codex-account-panel').hidden,false);assert.equal(f.get('codex-account-inspect').disabled,false);
  assert.equal(f.get('codex-account-confirm').disabled,true);assert.equal(f.get('codex-account-observation').hidden,true);
  assert.match(f.get('codex-account-state').textContent,/先读取/);
});
test('source workspace hides the widget and never POSTs even when its disabled control is synthetically clicked',async t=>{
  const f=await fixture(t,{status:modelStatus({workspace:{kind:'source-development'}})});
  assert.equal(f.get('codex-account-panel').hidden,true);await f.click('codex-account-inspect');await f.click('codex-account-confirm');
  assert.deepEqual(f.requests.map(item=>item.url),['/api/status']);assert.equal(f.posts().length,0);
});

test('customer chat supports explicit two-step local Codex confirmation without a stable identity claim',async t=>{
  const state=modelStatus({workspace:{kind:'customer-chat'}});
  const f=await fixture(t,{status:state});assert.equal(f.get('codex-account-panel').hidden,false);assert.equal(f.posts().length,0);
  await f.click('codex-account-inspect');assert.equal(f.get('codex-account-confirm').disabled,false);
  await f.click('codex-account-confirm');assert.deepEqual(f.posts().map(request=>request.url),['/api/codex-account/inspect','/api/codex-account/confirm']);
  assert.equal(f.get('codex-account-summary').textContent,'本机连接已确认');assert.match(f.get('codex-account-state').textContent,/稳定账号 ID 和工作区 ID 仍未取得/);
  assert.ok(f.emitted().every(event=>event.type==='buildx-account-refreshed'));
});

test('confirmation scope includes customer workspace and ignores late model, source or missing-profile states',async t=>{
  const f=await fixture(t);await f.click('codex-account-inspect');
  f.emitStatus(modelStatus({workspace:{kind:'customer-chat'}}));assert.equal(f.get('codex-account-observation').hidden,true);assert.equal(f.get('codex-account-confirm').disabled,true);
  await f.click('codex-account-inspect');assert.equal(f.get('codex-account-confirm').disabled,false);
  for(const workspace of [{kind:'model'},{kind:'source-development'},undefined]){
    f.emitStatus(modelStatus({workspace}));assert.equal(f.get('codex-account-email').textContent,'');assert.equal(f.get('codex-account-inspect').disabled,true);assert.equal(f.get('codex-account-confirm').disabled,true);
    await f.click('codex-account-confirm');
  }
  assert.equal(f.posts().length,2);assert.ok(f.posts().every(request=>request.url==='/api/codex-account/inspect'));
});
test('research/unconfigured and signed-out users cannot inspect or confirm a provider identity',async t=>{
  for(const account of [{configured:false,required:false,signedIn:false,user:null},{configured:true,required:true,signedIn:false,user:null}]){
    const f=await fixture(t,{status:modelStatus({account})});assert.equal(f.get('codex-account-inspect').disabled,true);
    await f.click('codex-account-inspect');assert.equal(f.posts().length,0);assert.match(f.get('codex-account-state').textContent,/尚未作本机身份确认/);
  }
});
test('missing metadata or confirmation disables operations without constructing fallback identity keys',async t=>{
  for(const extra of [{codexAccount:undefined},{codexAccount:{...meta,accountRevision:undefined}},
    {codexAccount:{...meta,observedAt:null}},{codexConfirmation:undefined}]){
    const f=await fixture(t,{status:modelStatus(extra)});assert.equal(f.get('codex-account-inspect').disabled,true);
    await f.click('codex-account-inspect');assert.equal(f.posts().length,0);
  }
});
test('inspect uses one fresh preflight and a credential-free CSRF request, displaying only the named observation',async t=>{
  const display={type:'chatgpt',email:'<img src=x onerror=fixture()>',planType:'pro',observedAt:meta.observedAt};
  const f=await fixture(t,{inspect:async()=>inspection({display,providerToken:'must-not-display'})});const before=f.requests.length;
  await f.click('codex-account-inspect');assert.deepEqual(f.requests.slice(before).map(item=>item.url),['/api/status','/api/codex-account/inspect']);
  const request=f.posts()[0];assert.deepEqual(JSON.parse(request.input.body),{client:'fixture-client'});
  assert.equal(request.input.headers['X-Local-Chat'],'fixture-csrf');assert.equal(request.input.credentials,'same-origin');assert.equal(request.input.redirect,'error');
  assert.equal(f.get('codex-account-email').textContent,'邮箱：'+display.email);assert.equal(f.get('codex-account-observation').hidden,false);
  assert.equal(f.get('codex-account-confirm').disabled,false);assert.deepEqual([...f.storage],[['revit-codex-client','fixture-client']]);
  assert.deepEqual(f.emitted().map(event=>event.type),['buildx-account-refreshed']);
  assert.ok(f.emitted().every(event=>Object.keys(event).join(',')==='type'));
  const visible=['codex-account-email','codex-account-plan','codex-account-observed-at','codex-account-state','codex-account-notice'].map(id=>f.get(id).textContent).join(' ');
  assert.doesNotMatch(visible,/fixturechallenge|must-not-display/);
});
test('explicit confirm uses the retained challenge only and never claims a stable account or workspace binding',async t=>{
  const f=await fixture(t);await f.click('codex-account-inspect');const before=f.requests.length;await f.click('codex-account-confirm');
  assert.deepEqual(f.requests.slice(before).map(item=>item.url),['/api/status','/api/codex-account/confirm']);
  assert.deepEqual(JSON.parse(f.posts()[1].input.body),{client:'fixture-client',challengeId:'fixturechallenge00000001'});
  assert.equal(f.get('codex-account-summary').textContent,'本机连接已确认');assert.match(f.get('codex-account-state').textContent,/稳定账号 ID 和工作区 ID 仍未取得/);
  assert.equal(f.get('codex-account-confirm').disabled,true);assert.deepEqual(f.emitted().map(event=>event.type),['buildx-account-refreshed','buildx-account-refreshed']);
});
test('a confirmation status does not restore a challenge into the browser',async t=>{
  const f=await fixture(t,{status:modelStatus({codexConfirmation:{...confirmation,phase:'confirmed',localConnectionConfirmed:true}})});
  assert.equal(f.get('codex-account-summary').textContent,'本机连接已确认');assert.equal(f.get('codex-account-confirm').disabled,true);
  await f.click('codex-account-confirm');assert.equal(f.posts().length,0);
});
test('a fresh busy preflight prevents POST and leaves no credential side effects',async t=>{
  const f=await fixture(t);f.setStatus(modelStatus({busy:true}));await f.click('codex-account-inspect');assert.equal(f.posts().length,0);
  assert.equal(f.get('codex-account-inspect').disabled,true);assert.match(f.get('codex-account-notice').textContent,/不允许确认/);
});
test('same-key checking observations pause controls without cancelling the widget own pending inspect',async t=>{
  const pending=deferred();const f=await fixture(t,{inspect:()=>pending.promise});await f.click('codex-account-inspect');
  f.emitStatus(modelStatus({codexConnectionReady:false,codexAccount:{...meta,status:'checking'},codexConfirmation:{...confirmation,phase:'checking'}}));
  assert.equal(f.get('codex-account-inspect').disabled,true);pending.resolve(inspection());await flush();
  assert.equal(f.get('codex-account-email').textContent,'邮箱：local-codex@example.test');
  f.emitStatus(modelStatus());assert.equal(f.get('codex-account-confirm').disabled,false);assert.equal(f.posts().length,1);
});
test('BuildX identity and Codex generation/revision changes clear PII and stale challenge',async t=>{
  for(const change of [modelStatus({account:{configured:true,required:true,signedIn:true,user:{id:'other-user'}}}),
    modelStatus({account:{configured:true,required:true,signedIn:false,user:null}}),
    modelStatus({codexAccount:{...meta,connectionGeneration:2}}),modelStatus({codexAccount:{...meta,accountRevision:3}})]){
    const f=await fixture(t);await f.click('codex-account-inspect');f.emitStatus(change);
    assert.equal(f.get('codex-account-observation').hidden,true);assert.equal(f.get('codex-account-email').textContent,'');assert.equal(f.get('codex-account-confirm').disabled,true);
  }
});
test('a changed preflight scope never sends an inspect POST on behalf of the previous identity',async t=>{
  const f=await fixture(t);f.setStatus(modelStatus({codexAccount:{...meta,connectionGeneration:2}}));await f.click('codex-account-inspect');
  assert.equal(f.posts().length,0);assert.equal(f.get('codex-account-observation').hidden,true);
});
test('late inspection cannot reintroduce PII after a connection revision event',async t=>{
  const pending=deferred();const f=await fixture(t,{inspect:()=>pending.promise});await f.click('codex-account-inspect');
  f.emitStatus(modelStatus({codexAccount:{...meta,accountRevision:9}}));pending.resolve(inspection());await flush();
  assert.equal(f.get('codex-account-email').textContent,'');assert.equal(f.get('codex-account-confirm').disabled,true);assert.equal(f.emitted().length,0);
});
test('BuildX account change event clears the observation and never auto-inspects the new account',async t=>{
  const f=await fixture(t);await f.click('codex-account-inspect');const before=f.requests.length;
  f.window.dispatchEvent({type:'buildx-account-changed'});assert.equal(f.get('codex-account-observation').hidden,true);
  assert.equal(f.get('codex-account-confirm').disabled,true);assert.equal(f.requests.length,before);
});
test('expired challenge disables confirmation and cannot be restored by a plain status',async t=>{
  const f=await fixture(t);await f.click('codex-account-inspect');f.advance(60001);
  const expiry=f.timers.findLast(timer=>!timer.cleared&&timer.ms===60000);assert.ok(expiry);expiry.fn();await flush();
  assert.equal(f.get('codex-account-confirm').disabled,true);assert.match(f.get('codex-account-notice').textContent,/已过期/);
  f.emitStatus(modelStatus());assert.equal(f.get('codex-account-confirm').disabled,true);await f.click('codex-account-confirm');assert.equal(f.posts().length,1);
});
test('timeout remains unknown and manual recheck is GET-only with no automatic POST replay',async t=>{
  const pending=deferred();const f=await fixture(t,{inspect:()=>pending.promise});await f.click('codex-account-inspect');
  const timer=f.timers.findLast(timer=>!timer.cleared&&timer.ms===12000);timer.fn();await flush();
  assert.match(f.get('codex-account-notice').textContent,/尚未确认.*超时.*不要重复提交/);assert.equal(f.get('codex-account-confirm').disabled,true);
  const before=f.requests.length;await f.click('codex-account-refresh');assert.deepEqual(f.requests.slice(before).map(item=>item.url),['/api/status']);
  pending.resolve(inspection());await flush();assert.equal(f.get('codex-account-email').textContent,'');assert.equal(f.posts().length,1);
  assert.ok(f.emitted().every(event=>event.type==='buildx-account-refreshed'));
});
test('same-key checking does not cancel an explicit confirmation already in flight',async t=>{
  const pending=deferred();const f=await fixture(t,{confirm:()=>pending.promise});await f.click('codex-account-inspect');await f.click('codex-account-confirm');
  f.emitStatus(modelStatus({codexConnectionReady:false,codexAccount:{...meta,status:'checking'},codexConfirmation:{...confirmation,phase:'checking'}}));
  pending.resolve({ok:true,confirmation:{...confirmation,phase:'confirmed',localConnectionConfirmed:true}});await flush();
  assert.equal(f.get('codex-account-summary').textContent,'本机连接已确认');assert.equal(f.posts().length,2);
  assert.deepEqual(f.emitted().map(event=>event.type),['buildx-account-refreshed','buildx-account-refreshed']);
});
test('confirmation timeout is resolved only by a fresh GET status, never by replaying the challenge',async t=>{
  const pending=deferred();const f=await fixture(t,{confirm:()=>pending.promise});await f.click('codex-account-inspect');await f.click('codex-account-confirm');
  const timer=f.timers.findLast(timer=>!timer.cleared&&timer.ms===12000);timer.fn();await flush();
  assert.match(f.get('codex-account-notice').textContent,/尚未确认/);assert.equal(f.get('codex-account-confirm').disabled,true);
  f.setStatus(modelStatus({codexConfirmation:{...confirmation,phase:'confirmed',localConnectionConfirmed:true}}));
  const before=f.requests.length;await f.click('codex-account-refresh');
  assert.deepEqual(f.requests.slice(before).map(item=>item.url),['/api/status']);assert.equal(f.posts().length,2);
  assert.equal(f.get('codex-account-summary').textContent,'本机连接已确认');assert.equal(f.get('codex-account-confirm').disabled,true);
  pending.resolve({ok:true,confirmation:{...confirmation,phase:'confirmed',localConnectionConfirmed:true}});await flush();
  assert.equal(f.posts().length,2);assert.ok(f.emitted().every(event=>event.type==='buildx-account-refreshed'));
});
test('HTTP failure hides raw error bodies and reports readiness without changing BuildX identity',async t=>{
  const f=await fixture(t,{inspect:async()=>({httpError:true,status:403,data:{error:'must-not-display-provider-secret'}})});
  await f.click('codex-account-inspect');assert.equal(f.get('codex-account-observation').hidden,true);
  assert.doesNotMatch(f.get('codex-account-notice').textContent,/must-not-display/);assert.match(f.get('codex-account-notice').textContent,/未通过身份核验/);
  assert.deepEqual(f.emitted().map(event=>event.type),['buildx-account-refreshed']);
});
test('malformed inspection cannot fabricate an account observation or a confirmable challenge',async t=>{
  for(const response of [inspection({expiresAt:start-1}),inspection({challengeId:'short'}),inspection({display:{type:'chatgpt',email:null,planType:'pro',observedAt:'not-an-iso-time'}})]){
    const f=await fixture(t,{inspect:async()=>response});await f.click('codex-account-inspect');
    assert.equal(f.get('codex-account-observation').hidden,true);assert.equal(f.get('codex-account-confirm').disabled,true);
  }
});
test('nullable provider email is displayed as not returned without constructing an identity from plan',async t=>{
  const f=await fixture(t,{inspect:async()=>inspection({display:{type:'chatgpt',email:null,planType:'unknown',observedAt:meta.observedAt}})});
  await f.click('codex-account-inspect');assert.equal(f.get('codex-account-email').textContent,'邮箱：未返回');assert.equal(f.get('codex-account-plan').textContent,'套餐：unknown');
});
test('display email preserves the producer 4096 UTF8 byte budget without truncation or a character-count substitute',async t=>{
  for(const email of ['a'.repeat(4096),'中'.repeat(1365)]){
    const f=await fixture(t,{inspect:async()=>inspection({display:{type:'chatgpt',email,planType:'pro',observedAt:meta.observedAt}})});
    await f.click('codex-account-inspect');assert.equal(f.get('codex-account-email').textContent,'邮箱：'+email);
    assert.equal(f.get('codex-account-confirm').disabled,false);
  }
  for(const email of ['a'.repeat(4097),'中'.repeat(1366)]){
    const f=await fixture(t,{inspect:async()=>inspection({display:{type:'chatgpt',email,planType:'pro',observedAt:meta.observedAt}})});
    await f.click('codex-account-inspect');assert.equal(f.get('codex-account-observation').hidden,true);
    assert.equal(f.get('codex-account-confirm').disabled,true);
  }
});
test('pagehide revokes pending ownership and exposes only a deliberate refresh on return',async t=>{
  const pending=deferred();const f=await fixture(t,{inspect:()=>pending.promise});await f.click('codex-account-inspect');
  f.window.dispatchEvent({type:'pagehide'});pending.resolve(inspection());await flush();
  assert.equal(f.get('codex-account-observation').hidden,true);assert.equal(f.get('codex-account-confirm').disabled,true);
  assert.equal(f.get('codex-account-refresh').disabled,false);assert.equal(f.emitted().length,0);
});
