import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from './lib/panel-server.mjs';
import {createBuildxAuth} from './lib/buildx-auth.mjs';
import {buildxRuntimeConfig} from './lib/buildx-runtime-config.mjs';
import {createPanelAccounts} from './lib/panel-accounts.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
class FakeCodex extends EventEmitter{
  state={ready:true,error:false,mode:'document-workbench',toolCount:37,message:'fixture ready',connectionGeneration:1,codexAccount:{status:'verified',connectionGeneration:1,accountRevision:0,observationSequence:1,observedAt:new Date().toISOString(),stableAccountId:null,workspaceId:null}};
  turns=[];interrupts=[];threads=0;closes=0;accountReads=0;accountWait=null;
  async start(){const connectionGeneration=this.state.connectionGeneration+1;this.state={...this.state,ready:true,error:false,connectionGeneration,codexAccount:{...this.state.codexAccount,status:'verified',connectionGeneration,accountRevision:this.state.codexAccount.accountRevision+1,observationSequence:this.state.codexAccount.observationSequence+1,observedAt:new Date().toISOString()}};this.emit('state',this.state);}
  async refreshAccount(){this.accountReads++;this.onAccountRead?.();if(this.accountWait)await this.accountWait;const meta={...this.state.codexAccount,observationSequence:this.state.codexAccount.observationSequence+1,observedAt:new Date().toISOString()};this.state={...this.state,codexAccount:meta};return {...meta,type:'chatgpt',email:'local-codex@example.invalid',planType:'free'};}
  invalidateAccount(){const meta={...this.state.codexAccount,status:'invalidated',accountRevision:this.state.codexAccount.accountRevision+1};this.state={...this.state,ready:false,codexAccount:meta};this.emit('account-invalidated',{connectionGeneration:meta.connectionGeneration,accountRevision:meta.accountRevision,reason:'account_updated'});this.emit('state',this.state);}
  failed(message){this.state={...this.state,ready:false,error:true,message};this.emit('state',this.state);}
  async close(){this.closes++;return {closed:true};}
  async newThread(){return 'thread-'+(++this.threads);}
  async turn(threadId,text){const result={threadId,turnId:'turn-'+(this.turns.length+1),text};this.turns.push(result);return {turn:{id:result.turnId}};}
  async interrupt(threadId,turnId){this.interrupts.push({threadId,turnId});}
  complete(index=0){const turn=this.turns[index];this.emit('notification','turn/completed',{threadId:turn.threadId,turnId:turn.turnId,turn:{id:turn.turnId,status:'completed'}});}
}
async function setup(t,{required=true,config=true,requestTimeoutMs=8000,profile='model'}={}){
  let clock=Date.now(),networkFailure=false,interceptor=null;const calls=[];
  const userA={id:'11111111-1111-1111-1111-111111111111',email:'a@example.invalid'};
  const userB={id:'22222222-2222-2222-2222-222222222222',email:'b@example.invalid'};
  const auth=config?createBuildxAuth({url:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_abcdefghijklmnopqrst',now:()=>clock,requestTimeoutMs,fetchImpl:async(url,options)=>{
    calls.push({path:new URL(url).pathname,query:new URL(url).search,method:options.method});
    if(networkFailure)throw new Error('fixture upstream failure');
    if(interceptor){const intercepted=await interceptor(url,options);if(intercepted!==undefined)return intercepted;}
    if(url.includes('/token?')){const input=JSON.parse(options.body);const renewal=url.includes('grant_type=refresh_token');const label=renewal?input.refresh_token.endsWith('-a')?'a':'b':input.email===userA.email?'a':'b';return Response.json({access_token:(renewal?'fixture-rotated-access-':'fixture-access-')+label,refresh_token:(renewal?'fixture-rotated-refresh-':'fixture-refresh-')+label,token_type:'bearer',expires_in:3600,expires_at:Math.floor(clock/1000)+3600});}
    if(url.endsWith('/user'))return Response.json(options.headers.Authorization.endsWith('-a')?userA:userB);
    if(url.includes('/logout?scope=local'))return new Response(null,{status:204});
    if(url.endsWith('/signup'))return Response.json({user:userA,session:null});
    throw new Error('Unexpected fixture route');
  }}):null;
  const codex=new FakeCodex();let modelCalls=0;
  if(profile==='source-development')codex.state={...codex.state,mode:profile,toolCount:6};
  const app=createPanelServer({root,codex,profile,port:0,accountAuth:auth,requireAccount:required,invokeWorkbench:async()=>{modelCalls++;throw new Error('No model expected');}});
  const {origin}=await app.listen();const publicStatus=await(await fetch(origin+'/api/status')).json();
  const controllers=[];t.after(async()=>{for(const controller of controllers)controller.abort();await app.close();});
  async function post(route,input={},cookie){const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'X-Local-Chat':publicStatus.csrf,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify({client:'same-browser-client',...input})});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],cookieHeader:response.headers.get('set-cookie')};}
  async function get(route,cookie){return fetch(origin+'/api/'+route,{headers:cookie?{Cookie:cookie}:{}});}
  async function confirmCodex(cookie){const inspected=await post('codex-account/inspect',{},cookie);assert.equal(inspected.status,200);const confirmed=await post('codex-account/confirm',{challengeId:inspected.body.challengeId},cookie);assert.equal(confirmed.status,200);return {inspected,confirmed};}
  async function login(email='a@example.invalid',cookie,{confirm=true}={}){const result=await post('account/sign-in',{email,password:'fixture-password'},cookie);if(confirm&&result.status===200&&result.body.account.signedIn)await confirmCodex(result.cookie);return result;}
  async function stream(cookie){const controller=new AbortController();controllers.push(controller);const response=await fetch(origin+'/api/events?client=same-browser-client',{headers:cookie?{Cookie:cookie}:{},signal:controller.signal});return {response,controller};}
  return {app,codex,auth,calls,origin,publicStatus,post,get,login,confirmCodex,stream,modelCalls:()=>modelCalls,advance:delta=>{clock+=delta;},network:value=>{networkFailure=value;},intercept:value=>{interceptor=value;}};
}

test('customer mode requires complete provider configuration; research stays explicitly unconfigured',()=>{
  assert.throws(()=>buildxRuntimeConfig({BUILDX_MODE:'customer'}),/专用/);
  assert.throws(()=>buildxRuntimeConfig({BUILDX_MODE:'unknown'}),/research/);
  assert.throws(()=>buildxRuntimeConfig({BUILDX_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co'}),/不完整/);
  assert.throws(()=>buildxRuntimeConfig({BUILDX_SUPABASE_URL:'',BUILDX_SUPABASE_PUBLISHABLE_KEY:''}),/不能为空/);
  assert.throws(()=>buildxRuntimeConfig({BUILDX_SUPABASE_URL:null,BUILDX_SUPABASE_PUBLISHABLE_KEY:null}),/不能为空/);
  assert.throws(()=>buildxRuntimeConfig({BUILDX_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',BUILDX_SUPABASE_PUBLISHABLE_KEY:'sb_secret_fixture'}),/配置/);
  assert.deepEqual(buildxRuntimeConfig({}),{mode:'research',accountAuth:null,requireAccount:false,requireLicense:false});
  assert.throws(()=>buildxRuntimeConfig({BUILDX_REQUIRE_LICENSE:'true'}),/许可核验/);
  assert.throws(()=>buildxRuntimeConfig({BUILDX_REQUIRE_LICENSE:'1'}),/true 或 false/);
});
test('unauthenticated HTTP/SSE cannot create chat history, read contexts, control service or call Codex',async t=>{
  const f=await setup(t);assert.equal(f.publicStatus.ready,false);assert.equal(f.publicStatus.account.required,true);assert.equal(f.publicStatus.account.signedIn,false);
  for(const route of ['turn','context','new-chat','reconnect','stop-service','interrupt'])assert.equal((await f.post(route,{message:'blocked',includeDocument:true})).status,401);
  const response=await f.get('events?client=forged-client');assert.equal(response.status,401);
  assert.equal(f.codex.turns.length,0);assert.equal(f.modelCalls(),0);assert.equal(f.codex.closes,0);
});
test('real auth owner through HTTP issues only opaque HttpOnly cookie, never provider tokens or credentials',async t=>{
  const f=await setup(t);const login=await f.login();assert.equal(login.status,200);assert.equal(login.body.account.signedIn,true);
  assert.match(login.cookieHeader,/HttpOnly/);assert.match(login.cookieHeader,/SameSite=Strict/);
  assert.doesNotMatch(JSON.stringify(login.body),/fixture-access|fixture-refresh|fixture-password|sessionId/);
  const status=await(await f.get('status',login.cookie)).json();assert.equal(status.ready,true);assert.equal(status.account.user.email,'a@example.invalid');
  const anonymous=await(await f.get('status')).json();assert.equal(anonymous.account.user,null);assert.equal(anonymous.ready,false);
  const concurrent=await Promise.all([f.get('account/status',login.cookie),f.get('account/status',login.cookie)]);
  for(const response of concurrent)assert.equal((await response.json()).signedIn,true);
});
test('register awaiting email confirmation does not authorize chat or claim a Codex binding',async t=>{
  const f=await setup(t);const result=await f.post('account/sign-up',{email:'a@example.invalid',password:'fixture-password'});
  assert.equal(result.status,200);assert.equal(result.body.verificationRequired,true);assert.equal(result.body.account.signedIn,false);assert.equal(result.cookie,undefined);
  assert.equal((await f.post('turn',{message:'blocked'})).status,401);assert.equal(f.codex.turns.length,0);
});
test('forged client ID and unrelated cookie cannot inspect an existing account or switch local identity',async t=>{
  const f=await setup(t);const login=await f.login();assert.equal((await f.login('b@example.invalid','buildx_model_session=unrelated-fixture-cookie')).status,409);
  assert.equal((await f.post('turn',{message:'no cookie',client:'same-browser-client'})).status,401);
  assert.equal((await f.post('turn',{message:'accepted'},login.cookie)).status,202);f.codex.complete();
  assert.equal((await f.post('account/sign-out',{},'buildx_model_session=wrong-fixture-cookie')).status,409);
  assert.equal(f.codex.turns.length,1);
});
test('account switch clears old history/context and never reuses the previous user thread',async t=>{
  const f=await setup(t);const a=await f.login();await f.post('turn',{message:'account-A-private'},a.cookie);f.codex.complete();
  assert.equal(f.app.snapshot('same-browser-client').session.messages[0].text,'account-A-private');
  const out=await f.post('account/sign-out',{},a.cookie);assert.equal(out.status,200);assert.equal(out.body.account.signedIn,false);
  const b=await f.login('b@example.invalid');assert.equal(b.status,200);
  await f.post('turn',{message:'account-B'},b.cookie);f.codex.complete(1);
  assert.equal(f.codex.threads,2);assert.doesNotMatch(JSON.stringify(f.app.snapshot('same-browser-client')),/account-A-private/);
  assert.equal((await f.post('turn',{message:'stale cookie'},a.cookie)).status,401);
});
test('in-flight model tool blocks signout; expiry closes streams without writing after end and drains old work',async t=>{
  const f=await setup(t);const login=await f.login();const stream=await f.stream(login.cookie);assert.equal(stream.response.status,200);
  await f.post('turn',{message:'old-account-task'},login.cookie);
  assert.equal((await f.post('account/sign-out',{},login.cookie)).status,409);
  f.advance(3600001);const expired=await(await f.get('account/status',login.cookie)).json();assert.equal(expired.signedIn,false);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.codex.interrupts.length,1);
  assert.equal((await f.login('b@example.invalid')).status,409);
  f.codex.complete();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.login('b@example.invalid')).status,200);assert.equal((await f.get('status')).status,200);
  assert.equal(f.codex.turns.length,1);assert.equal(f.modelCalls(),0);
});
test('temporary upstream verification failure fails closed without pretending a local client is authenticated',async t=>{
  const f=await setup(t);const a=await f.login();f.network(true);
  assert.equal((await f.post('turn',{message:'no offline authorization'},a.cookie)).status,401);
  assert.equal((await(await f.get('account/status',a.cookie)).json()).signedIn,false);
  f.network(false);assert.equal((await(await f.get('account/status',a.cookie)).json()).signedIn,true);
  assert.equal(f.codex.turns.length,0);
});
test('retained unverified identity never becomes ready again through unsolicited Codex state',async t=>{
  const f=await setup(t);const a=await f.login();const stream=await f.stream(a.cookie);assert.equal(stream.response.status,200);
  f.network(true);const status=await(await f.get('status',a.cookie)).json();assert.equal(status.ready,false);assert.equal(status.account.retainedSession,true);
  assert.equal(f.app.snapshot('same-browser-client').state.ready,false);
  f.codex.emit('state',f.codex.state);assert.equal(f.app.snapshot('same-browser-client').state.ready,false);
  const out=await f.post('account/sign-out',{},a.cookie);assert.equal(out.status,200);assert.equal(out.body.remoteRevoked,null);assert.equal(out.body.account.signedIn,false);
});
test('close failure retains ownership and permits precise cleanup retry rather than overlap',async t=>{
  const f=await setup(t,{required:false,config:false});let tries=0;
  f.codex.close=async()=>{if(++tries===1)throw new Error('unconfirmed owned child');return {closed:true};};
  await assert.rejects(f.app.close(),/unconfirmed/);
  assert.equal((await f.post('turn',{message:'closed'})).status,503);
  assert.equal((await f.get('events?client=late-reader')).status,503);
  assert.deepEqual(await f.app.close(),{closed:true});assert.equal(tries,2);
});
test('an explicit unconfirmed close receipt cannot be promoted to completed shutdown',async t=>{
  const f=await setup(t,{required:false,config:false});let confirmed=false;
  f.codex.close=async()=>({closed:confirmed});
  await assert.rejects(f.app.close(),/尚未确认/);assert.equal((await f.get('events?client=late')).status,503);
  confirmed=true;assert.deepEqual(await f.app.close(),{closed:true});
});
test('HTTP shutdown owner can retry cleanup after failure without reusing invalidated authentication',async t=>{
  const f=await setup(t);const login=await f.login();let calls=0;
  f.codex.close=async()=>{if(++calls===1)throw new Error('fixture owned close unknown');return {closed:true};};
  const first=await f.post('stop-service',{},login.cookie);assert.equal(first.status,202);assert.match(first.body.cleanupId,/^[a-f0-9]{48}$/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal((await f.get('events?client=late')).status,503);
  assert.equal((await f.post('stop-service',{},login.cookie)).status,503);
  assert.equal((await f.post('stop-service',{client:'unrelated',cleanupId:first.body.cleanupId},login.cookie)).status,503);
  const retried=await f.post('stop-service',{cleanupId:first.body.cleanupId},login.cookie);assert.equal(retried.status,202);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
});
test('a stale failed connect cannot invalidate a later reconnected client',async t=>{
  const f=await setup(t,{required:false,config:false});let rejectFirst,resolveSecond,starts=0;
  const secondStarted=new Promise(resolve=>{resolveSecond=resolve;});
  f.codex.start=async()=>{if(++starts===1)return new Promise((_,reject)=>{rejectFirst=reject;});f.codex.state={...f.codex.state,ready:true,error:false,message:'new owner ready'};resolveSecond();};
  const original=f.app.connect();assert.equal((await f.post('reconnect')).status,202);
  await secondStarted;assert.equal(starts,2);
  rejectFirst(new Error('old connection failure'));await original;
  assert.equal(f.codex.state.message,'new owner ready');assert.equal(f.codex.state.ready,true);
});

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise(done=>setImmediate(done));
const rotations=f=>f.calls.filter(call=>call.query==='?grant_type=refresh_token');

test('explicit HTTP renewal preserves the same opaque cookie, conversation, thread and SSE',async t=>{
  const f=await setup(t),signed=await f.login();
  await f.post('turn',{message:'same-account-history'},signed.cookie);f.codex.complete();
  const original=f.app.snapshot('same-browser-client').session;
  const originalThread=f.codex.turns[0].threadId;
  const {response,controller}=await f.stream(signed.cookie),reader=response.body.getReader();
  assert.equal((await reader.read()).done,false);
  f.advance(120000);
  const renewed=await f.post('account/refresh-session',{},signed.cookie);
  assert.equal(renewed.status,200);assert.equal(renewed.cookie,undefined);
  assert.equal(renewed.body.account.user.id,signed.body.account.user.id);
  assert.ok(renewed.body.account.expiresAt>signed.body.account.expiresAt);
  assert.deepEqual(f.app.snapshot('same-browser-client').session.messages,original.messages);
  assert.equal(f.codex.threads,1);assert.equal(rotations(f).length,1);
  assert.doesNotMatch(JSON.stringify(renewed.body),/fixture-|token|sessionId|password/);
  f.codex.emit('state',f.codex.state);assert.equal((await reader.read()).done,false);
  assert.equal((await f.post('turn',{message:'continue same conversation'},signed.cookie)).status,202);
  assert.equal(f.codex.turns.at(-1).threadId,originalThread);f.codex.complete(1);
  controller.abort();await reader.cancel().catch(()=>{});
});

test('renewal requires the current cookie, CSRF and idle model work before upstream rotation',async t=>{
  const f=await setup(t),signed=await f.login();
  assert.equal((await f.post('account/refresh-session')).status,409);
  assert.equal((await f.post('account/refresh-session',{},'buildx_model_session=wrong-fixture-cookie')).status,409);
  assert.equal((await f.post('account/refresh-session',{refresh_token:'fixture-client-token-not-used'},signed.cookie)).status,400);
  const rejected=await fetch(f.origin+'/api/account/refresh-session',{method:'POST',headers:{Origin:f.origin,'X-Local-Chat':'incorrect','Content-Type':'application/json',Cookie:signed.cookie},body:JSON.stringify({client:'same-browser-client'})});
  assert.equal(rejected.status,403);await rejected.body.cancel();
  await f.post('turn',{message:'in-progress'},signed.cookie);
  assert.equal((await f.post('account/refresh-session',{},signed.cookie)).status,409);
  assert.equal(rotations(f).length,0);f.codex.complete();
});

test('a verification already in flight rejects rotation without invalidating that verification',async t=>{
  const f=await setup(t),signed=await f.login(),gate=deferred(),entered=deferred();
  f.intercept(async url=>{if(url.endsWith('/user')){entered.resolve();await gate.promise;}});
  const reading=f.get('account/status',signed.cookie);await entered.promise;
  try{
    assert.equal((await f.post('account/refresh-session',{},signed.cookie)).status,409);
    assert.equal(rotations(f).length,0);
  }finally{gate.resolve();}
  assert.equal((await(await reading).json()).signedIn,true);
});

test('parallel status readers share one explicit rotation, and another tab cannot rotate twice',async t=>{
  const f=await setup(t),signed=await f.login(),gate=deferred(),entered=deferred();
  const readsBefore=f.calls.filter(call=>call.path==='/auth/v1/user').length;
  f.intercept(async url=>{if(url.includes('grant_type=refresh_token')){entered.resolve();await gate.promise;}});
  const renewing=f.post('account/refresh-session',{},signed.cookie);await entered.promise;
  const reading=f.get('account/status',signed.cookie),stateReading=f.get('status',signed.cookie);
  try{
    assert.equal((await f.post('account/refresh-session',{},signed.cookie)).status,409);
    assert.equal(f.app.snapshot('same-browser-client').state.ready,false);
    f.codex.emit('state',f.codex.state);assert.equal(f.app.snapshot('same-browser-client').state.ready,false);
    assert.equal(f.calls.filter(call=>call.path==='/auth/v1/user').length,readsBefore);
    assert.equal(rotations(f).length,1);
  }finally{gate.resolve();}
  assert.equal((await renewing).status,200);
  assert.equal((await(await reading).json()).signedIn,true);
  assert.equal((await(await stateReading).json()).ready,true);
  assert.equal(f.calls.filter(call=>call.path==='/auth/v1/user').length,readsBefore+1);
  assert.equal(f.modelCalls(),0);
});

test('unknown rotation outcome clears local authorization and never replays the POST',async t=>{
  const f=await setup(t,{requestTimeoutMs:40}),signed=await f.login(),gate=deferred(),entered=deferred();
  f.intercept(async url=>{if(url.includes('grant_type=refresh_token')){entered.resolve();await gate.promise;}});
  const renewing=f.post('account/refresh-session',{},signed.cookie);await entered.promise;
  try{
    const result=await renewing;assert.equal(result.status,502);assert.equal(result.body.account.signedIn,false);
    assert.match(result.cookieHeader,/Max-Age=0/);
    assert.equal(f.auth.diagnostics().retainedSessions,0);assert.equal(f.auth.diagnostics().pendingRequests,1);
    assert.equal((await(await f.get('account/status',signed.cookie)).json()).signedIn,false);
    assert.equal((await f.post('account/refresh-session',{},signed.cookie)).status,401);
    assert.equal(rotations(f).length,1);assert.equal(f.codex.turns.length,0);
  }finally{gate.resolve();await tick();await tick();}
  assert.equal(f.auth.diagnostics().pendingRequests,0);
});

test('verified user drift during renewal clears old history instead of silently switching accounts',async t=>{
  const f=await setup(t),signed=await f.login();
  await f.post('turn',{message:'original-user-private'},signed.cookie);f.codex.complete();
  f.intercept(async url=>url.endsWith('/user')?Response.json({id:'22222222-2222-2222-2222-222222222222',email:'b@example.invalid'}):undefined);
  const result=await f.post('account/refresh-session',{},signed.cookie);
  assert.equal(result.status,502);assert.equal(result.body.account.signedIn,false);
  assert.doesNotMatch(JSON.stringify(f.app.snapshot('same-browser-client')),/original-user-private/);
  assert.equal(f.auth.diagnostics().retainedSessions,0);assert.equal(f.modelCalls(),0);
});

test('expiry while renewing releases the original owner and cannot apply its late success',async()=>{
  let at=Date.now();const gate=deferred(),entered=deferred(),released=[],cleared=[];
  const sid='11111111-1111-1111-1111-111111111111';
  const facts=()=>({sessionId:sid,user:{id:'user-one',email:'a@example.invalid'},expiresAt:at+3600000});
  const auth={signIn:async()=>({ok:true,value:facts()}),signUp:async()=>({ok:false}),verifySession:async()=>({ok:true,value:facts()}),
    refresh:async()=>{entered.resolve();await gate.promise;return {ok:true,value:facts()};},signOut:async()=>({ok:true,value:{remoteRevoked:true}}),
    release:id=>{released.push(id);},close:async()=>({ok:true,value:{closed:true}})};
  const account=createPanelAccounts({auth,required:true,now:()=>at,onClear:reason=>cleared.push(reason)});
  const signed=await account.action('sign-in',{email:'fixture',password:'fixture'},{headers:{}}),req={headers:{cookie:signed.cookie.split(';')[0]}};
  cleared.length=0;
  const renewing=account.action('refresh-session',{},req);await entered.promise;
  at+=3600001;assert.equal((await account.status(req)).signedIn,false);
  gate.resolve();const result=await renewing;
  assert.equal(result.status,409);assert.equal(account.view().signedIn,false);
  assert.deepEqual(released,[sid]);assert.equal(cleared.length,1);await account.close();
});

test('service close invalidates a pending rotation and its later result cannot restore identity',async t=>{
  const f=await setup(t),signed=await f.login(),gate=deferred(),entered=deferred();
  f.intercept(async url=>{if(url.includes('grant_type=refresh_token')){entered.resolve();await gate.promise;}});
  const renewing=f.post('account/refresh-session',{},signed.cookie);await entered.promise;
  await assert.rejects(f.app.close(),/账号连接清理尚未确认/);
  gate.resolve();assert.equal((await renewing).status,409);await tick();
  assert.equal(f.auth.diagnostics().retainedSessions,0);assert.equal(f.auth.diagnostics().pendingRequests,0);
  assert.deepEqual(await f.app.close(),{closed:true});
});

test('a late rotation cannot extend a passed expiry merely because its timer has not run',async t=>{
  let at=Date.now();const gate=deferred(),entered=deferred(),released=[];
  const sid='11111111-1111-1111-1111-111111111111';
  const facts=()=>({sessionId:sid,user:{id:'user-one',email:'a@example.invalid'},expiresAt:at+3600000});
  const auth={signIn:async()=>({ok:true,value:facts()}),signUp:async()=>({ok:false}),verifySession:async()=>({ok:true,value:facts()}),
    refresh:async()=>{entered.resolve();await gate.promise;return {ok:true,value:facts()};},signOut:async()=>({ok:true,value:{remoteRevoked:true}}),
    release:id=>{released.push(id);},close:async()=>({ok:true,value:{closed:true}})};
  const account=createPanelAccounts({auth,required:true,now:()=>at});t.after(()=>account.close());
  const signed=await account.action('sign-in',{email:'fixture',password:'fixture'},{headers:{}}),req={headers:{cookie:signed.cookie.split(';')[0]}};
  const renewing=account.action('refresh-session',{},req);await entered.promise;
  at+=3600001;gate.resolve();
  const result=await renewing;
  assert.equal(result.status,502);assert.equal(account.view().signedIn,false);assert.deepEqual(released,[sid]);
});

test('customer dialogue and context require a fresh two-step local Codex confirmation',async t=>{
  const f=await setup(t),signed=await f.login('a@example.invalid',undefined,{confirm:false});
  const pending=await(await f.get('status',signed.cookie)).json();
  assert.equal(pending.account.signedIn,true);assert.equal(pending.codexConnectionReady,true);assert.equal(pending.ready,false);
  assert.equal((await f.post('turn',{message:'not yet authorized'},signed.cookie)).status,403);
  assert.equal((await f.post('context',{includeDocument:true},signed.cookie)).status,403);assert.equal(f.modelCalls(),0);
  const {inspected,confirmed}=await f.confirmCodex(signed.cookie);
  assert.equal(inspected.body.display.email,'local-codex@example.invalid');
  assert.equal(confirmed.body.confirmation.localConnectionConfirmed,true);
  assert.equal(confirmed.body.confirmation.stableAccountId,null);assert.equal(confirmed.body.confirmation.workspaceId,null);
  const status=await(await f.get('status',signed.cookie)).json();assert.equal(status.ready,true);
  assert.doesNotMatch(JSON.stringify(status.codexAccount),/email|planType|local-codex/);
  assert.doesNotMatch(JSON.stringify(status.codexConfirmation),/challengeId|sessionId|userId|local-codex/);
  assert.equal((await f.post('turn',{message:'confirmed connection'},signed.cookie)).status,202);f.codex.complete();
});

test('confirmation refuses forged cookies, caller account DTOs, CSRF and source or unconfigured modes',async t=>{
  const f=await setup(t),signed=await f.login('a@example.invalid',undefined,{confirm:false});
  assert.equal((await f.post('codex-account/inspect')).status,401);
  assert.equal((await f.post('codex-account/inspect',{},'buildx_model_session=wrong-fixture-cookie')).status,401);
  assert.equal((await f.post('codex-account/inspect',{account:{type:'chatgpt'},accessToken:'fixture-forged'},signed.cookie)).status,400);
  const invalid=await fetch(f.origin+'/api/codex-account/inspect',{method:'POST',headers:{Origin:f.origin,'X-Local-Chat':'wrong','Content-Type':'application/json',Cookie:signed.cookie},body:JSON.stringify({client:'same-browser-client'})});
  assert.equal(invalid.status,403);await invalid.body.cancel();assert.equal(f.codex.accountReads,0);
  for(const profile of ['model','source-development']){
    const research=await setup(t,{required:false,config:false,profile});
    assert.equal((await research.post('codex-account/inspect')).status,403);
    const status=await(await research.get('status')).json();assert.equal(status.codexConfirmation.localConnectionConfirmed,false);assert.equal(research.codex.accountReads,0);
  }
});

test('confirmation challenge is scoped to the requesting panel, consumed once and not a stable account key',async t=>{
  const f=await setup(t),signed=await f.login('a@example.invalid',undefined,{confirm:false});
  const inspected=await f.post('codex-account/inspect',{},signed.cookie);
  const wrong=await f.post('codex-account/confirm',{client:'different-panel',challengeId:inspected.body.challengeId},signed.cookie);assert.equal(wrong.status,409);
  const confirmed=await f.post('codex-account/confirm',{challengeId:inspected.body.challengeId},signed.cookie);assert.equal(confirmed.status,200);
  const replay=await f.post('codex-account/confirm',{challengeId:inspected.body.challengeId},signed.cookie);assert.equal(replay.status,409);
  assert.equal((await(await f.get('status',signed.cookie)).json()).codexConfirmation.localConnectionConfirmed,true);
  assert.doesNotMatch(JSON.stringify(confirmed.body),/11111111|local-codex|planType/);
});

test('an outstanding account inspection blocks overlap, model use and local signout without replay',async t=>{
  const f=await setup(t),signed=await f.login('a@example.invalid',undefined,{confirm:false}),gate=deferred(),entered=deferred();
  f.codex.accountWait=gate.promise;f.codex.onAccountRead=()=>entered.resolve();
  const reading=f.post('codex-account/inspect',{},signed.cookie);await entered.promise;
  try{
    assert.equal((await f.post('codex-account/inspect',{},signed.cookie)).status,409);
    assert.equal((await f.post('turn',{message:'blocked while reading'},signed.cookie)).status,409);
    assert.equal((await f.post('account/sign-out',{},signed.cookie)).status,409);
    assert.equal(f.codex.accountReads,1);assert.equal(f.codex.turns.length,0);
  }finally{gate.resolve();}
  assert.equal((await reading).status,200);
});

test('account information invalidation retires history and proof even when visible email did not change',async t=>{
  const f=await setup(t),signed=await f.login();
  await f.post('turn',{message:'old-connection-private'},signed.cookie);f.codex.complete();
  const oldThread=f.codex.turns[0].threadId;
  f.codex.invalidateAccount();
  assert.equal((await(await f.get('status',signed.cookie)).json()).ready,false);
  assert.doesNotMatch(JSON.stringify(f.app.snapshot('same-browser-client')),/old-connection-private/);
  assert.equal((await f.post('turn',{message:'cannot reuse proof'},signed.cookie)).status,403);
  assert.equal((await f.post('reconnect',{},signed.cookie)).status,202);await tick();await tick();
  assert.equal((await(await f.get('status',signed.cookie)).json()).ready,false);
  await f.confirmCodex(signed.cookie);
  assert.equal((await f.post('turn',{message:'new connection'},signed.cookie)).status,202);f.codex.complete(1);
  assert.notEqual(f.codex.turns.at(-1).threadId,oldThread);
});

test('a late inspection cannot issue proof after an intervening account revision',async t=>{
  const f=await setup(t),signed=await f.login('a@example.invalid',undefined,{confirm:false}),gate=deferred(),entered=deferred();
  f.codex.accountWait=gate.promise;f.codex.onAccountRead=()=>entered.resolve();
  const reading=f.post('codex-account/inspect',{},signed.cookie);await entered.promise;
  f.codex.invalidateAccount();gate.resolve();
  const result=await reading;assert.equal(result.status,409);assert.equal(result.body.challengeId,undefined);
  const status=await(await f.get('status',signed.cookie)).json();assert.equal(status.codexConfirmation.localConnectionConfirmed,false);assert.equal(f.codex.accountReads,1);
});

test('postflight BuildX expiry cannot turn a successful Codex read into another users confirmation',async t=>{
  const f=await setup(t),signed=await f.login('a@example.invalid',undefined,{confirm:false}),gate=deferred(),entered=deferred();
  f.codex.accountWait=gate.promise;f.codex.onAccountRead=()=>entered.resolve();
  const reading=f.post('codex-account/inspect',{},signed.cookie);await entered.promise;
  f.advance(3600001);gate.resolve();
  const result=await reading;assert.equal(result.status,409);assert.equal(result.body.challengeId,undefined);
  assert.equal((await(await f.get('status',signed.cookie)).json()).ready,false);
  assert.equal(f.codex.turns.length,0);
});
