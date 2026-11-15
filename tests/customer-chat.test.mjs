import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createBuildxAuth} from '../lib/buildx-auth.mjs';
import {createCodexConfirmation} from '../lib/codex-confirmation.mjs';
import {createCustomerChatServer,customerChatConfiguration} from '../lib/customer-chat.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const authUrl='https://abcdefghijklmnopqrst.supabase.co';
const publishableKey='sb_publishable_abcdefghijklmnopqrst';
const user={id:'11111111-1111-1111-1111-111111111111',email:'customer@example.invalid'};
const client='customer-browser';
class FakeCodex extends EventEmitter{
  state={kind:'customer-chat',mode:'customer-chat',toolCount:0,ready:true,error:false,
    message:'fixture ready',connectionGeneration:1,codexAccount:{status:'verified',connectionGeneration:1,
      accountRevision:0,observationSequence:1,observedAt:new Date().toISOString(),stableAccountId:null,workspaceId:null}};
  turns=[];threads=0;closes=0;accountReads=0;interrupts=[];
  async start(){throw new Error('No real Codex connection is permitted');}
  async close(){this.closes++;return {closed:true};}
  async refreshAccount(){
    this.accountReads++;
    const meta={...this.state.codexAccount,observationSequence:this.state.codexAccount.observationSequence+1,
      observedAt:new Date().toISOString()};
    this.state={...this.state,codexAccount:meta};
    return {...meta,type:'chatgpt',email:'customer-codex@example.invalid',planType:'free'};
  }
  async newThread(){return 'customer-thread-'+(++this.threads);}
  async turn(threadId,text){const turn={threadId,text,turnId:'customer-turn-'+(this.turns.length+1)};
    this.turns.push(turn);return {turn:{id:turn.turnId}};}
  async interrupt(threadId,turnId){this.interrupts.push({threadId,turnId});}
  complete(index=0,text='模拟客户回复'){
    const turn=this.turns[index];
    this.emit('notification','item/completed',{threadId:turn.threadId,turnId:turn.turnId,
      item:{id:'answer-'+index,type:'agentMessage',text}});
    this.emit('notification','turn/completed',{threadId:turn.threadId,turnId:turn.turnId,
      turn:{id:turn.turnId,status:'completed'}});
  }
  drift(change){this.state={...this.state,...change};this.emit('state',this.state);}
}
function authFixture(){
  const calls=[];
  const auth=createBuildxAuth({url:authUrl,publishableKey,fetchImpl:async(url,options)=>{
    calls.push({path:new URL(url).pathname,query:new URL(url).search,method:options.method});
    if(url.includes('/token?'))return Response.json({access_token:'fixture-customer-access',
      refresh_token:'fixture-customer-refresh',token_type:'bearer',expires_in:3600});
    if(url.endsWith('/user'))return Response.json(user);
    if(url.includes('/logout?scope=local'))return new Response(null,{status:204});
    if(url.endsWith('/signup'))return Response.json({user,session:null});
    throw new Error('Unexpected fake auth route');
  }});
  return {auth,calls};
}
async function assertAuthClosed(auth){
  const result=await auth.close();assert.equal(result.ok,true);assert.equal(result.value.closed,true);
  assert.equal(result.value.pendingRequests,0);assert.equal(result.value.retainedSessions,0);
}
async function fixture(t){
  const {auth,calls}=authFixture(),codex=new FakeCodex();
  const app=createCustomerChatServer({root,accountAuth:auth,codex,port:0});
  const {origin}=await app.listen(),initial=await(await fetch(origin+'/api/status')).json();
  const streams=[];
  t.after(async()=>{
    for(const stream of streams){stream.controller.abort();await stream.reader?.cancel().catch(()=>{});}
    assert.deepEqual(await app.close(),{closed:true});
    assert.equal(codex.closes,1);
    assert.deepEqual(codex.eventNames(),[]);
  });
  async function get(route,cookie){return fetch(origin+'/api/'+route,{headers:cookie?{Cookie:cookie}:{}});}
  async function post(route,input={},cookie,csrf=initial.csrf,originHeader=origin){
    const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:originHeader,
      'X-Local-Chat':csrf,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
    body:JSON.stringify({client,...input})});
    return {status:response.status,body:await response.json(),cookieHeader:response.headers.get('set-cookie'),
      cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(){const value=await post('account/sign-in',{email:user.email,password:'fixture-password'});
    assert.equal(value.status,200);return value;}
  async function confirm(cookie){const inspected=await post('codex-account/inspect',{},cookie);
    assert.equal(inspected.status,200);
    const confirmed=await post('codex-account/confirm',{challengeId:inspected.body.challengeId},cookie);
    assert.equal(confirmed.status,200);return {inspected,confirmed};}
  async function stream(cookie){
    const controller=new AbortController(),entry={controller,reader:null};streams.push(entry);
    const response=await fetch(origin+'/api/events?client='+client,{headers:cookie?{Cookie:cookie}:{},signal:controller.signal});
    if(response.status!==200)return {response};
    const reader=response.body.getReader(),decoder=new TextDecoder();entry.reader=reader;let buffer='';
    async function next(){
      for(;;){const split=buffer.indexOf('\n\n');if(split!==-1){const frame=buffer.slice(0,split);buffer=buffer.slice(split+2);
        if(!frame.startsWith('event: '))continue;
        return {event:frame.slice(7,frame.indexOf('\n')),data:JSON.parse(frame.slice(frame.indexOf('data: ')+6))};}
        const chunk=await reader.read();if(chunk.done)throw new Error('Fixture SSE ended');
        buffer+=decoder.decode(chunk.value,{stream:true});}
    }
    async function until(predicate){
      const timeout=setTimeout(()=>controller.abort(),3000);
      try{for(let i=0;i<80;i++){const value=await next();if(predicate(value))return value;}throw new Error('Fixture SSE event budget exhausted');}
      finally{clearTimeout(timeout);}
    }
    return {response,next,until};
  }
  return {auth,calls,codex,app,origin,initial,get,post,login,confirm,stream};
}

test('dedicated customer construction requires configuration and rejects research/profile/permission overrides',async()=>{
  assert.throws(()=>customerChatConfiguration({}),/必须/);
  for(const mode of ['research','unknown',''])assert.throws(()=>customerChatConfiguration({BUILDX_MODE:mode}),/customer/);
  const config=customerChatConfiguration({BUILDX_SUPABASE_URL:authUrl,BUILDX_SUPABASE_PUBLISHABLE_KEY:publishableKey});
  assert.equal(config.mode,'customer');assert.equal(config.requireAccount,true);
  await assertAuthClosed(config.accountAuth);
  const {auth}=authFixture();
  try{
    assert.throws(()=>createCustomerChatServer({root,codex:new FakeCodex(),port:0}),/账号后端/);
    assert.throws(()=>createCustomerChatServer({root,accountAuth:{},codex:new FakeCodex(),port:0}),/provider/);
    for(const extra of [{profile:'model'},{selection:{}},{requireAccount:false},{mode:'research'},{invokeWorkbench:async()=>{}}])
      assert.throws(()=>createCustomerChatServer({root,accountAuth:auth,codex:new FakeCodex(),port:0,...extra}),/固定应用配置/);
    for(const drift of [{mode:'document-workbench'},{toolCount:1}]){
      const codex=new FakeCodex();codex.state={...codex.state,...drift};
      assert.throws(()=>createCustomerChatServer({root,accountAuth:auth,codex,port:0}),/own profile/);
      assert.equal(codex.closes,0);assert.deepEqual(codex.eventNames(),[]);
    }
  }finally{await assertAuthClosed(auth);}
});

test('real auth owner gates HTTP/SSE, then explicit confirmation enables zero-tool chat and SSE results',async t=>{
  const f=await fixture(t);
  assert.deepEqual(f.initial.workspace,{kind:'customer-chat',supportsModelContext:false});
  assert.deepEqual(f.initial.toolCatalog,[]);assert.equal(f.initial.ready,false);
  assert.equal(f.initial.account.required,true);assert.equal(f.initial.codexConfirmation.required,true);
  for(const route of ['turn','context','new-chat','reconnect','interrupt','stop-service'])
    assert.equal((await f.post(route,{message:'blocked'})).status,401);
  assert.equal((await f.stream()).response.status,401);
  assert.equal(f.codex.turns.length,0);assert.equal(f.calls.length,0);
  const login=await f.login();
  assert.match(login.cookieHeader,/^buildx_customer_chat_session=[A-Za-z0-9_-]+;/);
  assert.match(login.cookieHeader,/HttpOnly/);assert.match(login.cookieHeader,/SameSite=Strict/);
  assert.doesNotMatch(JSON.stringify(login.body),/fixture-customer-access|fixture-customer-refresh|fixture-password|sessionId/);
  assert.equal((await f.post('turn',{message:'still blocked'},login.cookie)).status,403);
  assert.equal(f.codex.turns.length,0);
  const {confirmed}=await f.confirm(login.cookie);
  assert.equal(confirmed.body.confirmation.localConnectionConfirmed,true);
  assert.equal(confirmed.body.confirmation.stableAccountId,null);
  assert.equal((await(await f.get('status',login.cookie)).json()).ready,true);
  const events=await f.stream(login.cookie);assert.equal(events.response.status,200);
  assert.equal((await events.next()).event,'snapshot');
  assert.equal((await f.post('turn',{message:'仅对话'},login.cookie)).status,202);
  f.codex.complete();
  const done=await events.until(value=>value.event==='done');assert.equal(done.data.status,'completed');
  const snapshot=f.app.snapshot(client);
  assert.deepEqual(snapshot.session.messages.map(message=>message.text),['仅对话','模拟客户回复']);
  assert.deepEqual(snapshot.session.messages[1].tools,[]);assert.equal(f.codex.threads,1);
  assert.equal(f.codex.turns[0].text,'仅对话');assert.equal(f.codex.interrupts.length,0);
});

test('customer model/selection context requests fail before chat history or AI side effects',async t=>{
  const f=await fixture(t),login=await f.login();await f.confirm(login.cookie);
  const before=f.app.snapshot(client).session;
  for(const input of [{includeDocument:true},{includeSelection:true},{includeDocument:false,includeSelection:false}])
    assert.equal((await f.post('context',input,login.cookie)).status,403);
  for(const context of [{includeDocument:true},{includeSelection:true},{includeDocument:true,includeSelection:true}])
    assert.equal((await f.post('turn',{message:'must not start',context},login.cookie)).status,403);
  assert.deepEqual(f.app.snapshot(client).session,before);
  assert.equal(f.codex.threads,0);assert.equal(f.codex.turns.length,0);
});

test('model cookies and another customer instance CSRF cannot authorize login or confirmation',async t=>{
  const first=await fixture(t),second=await fixture(t),login=await first.login();
  const modelCookie=login.cookie.replace(/^buildx_customer_chat_session=/,'buildx_model_session=');
  assert.equal((await(await first.get('account/status',modelCookie)).json()).signedIn,false);
  assert.equal((await first.post('codex-account/inspect',{},modelCookie)).status,401);
  assert.equal((await first.post('turn',{message:'wrong scope'},modelCookie)).status,401);
  assert.equal((await first.post('account/sign-in',{email:user.email,password:'fixture-password'},modelCookie)).status,409);
  const firstInspection=await first.post('codex-account/inspect',{},login.cookie);
  assert.equal(firstInspection.status,200);const firstReads=first.codex.accountReads;
  assert.equal((await first.post('codex-account/confirm',{challengeId:firstInspection.body.challengeId},modelCookie)).status,401);
  assert.equal(first.codex.accountReads,firstReads);
  const firstCalls=first.calls.length,secondCalls=second.calls.length;
  assert.equal((await second.post('account/sign-in',{email:user.email,password:'fixture-password'},undefined,first.initial.csrf)).status,403);
  assert.equal(second.calls.length,secondCalls);
  const secondLogin=await second.login(),inspection=await second.post('codex-account/inspect',{},secondLogin.cookie);
  assert.equal((await(await second.get('account/status',login.cookie)).json()).signedIn,false);
  assert.equal(inspection.status,200);const reads=second.codex.accountReads;
  assert.equal((await second.post('codex-account/confirm',{challengeId:inspection.body.challengeId},secondLogin.cookie,first.initial.csrf)).status,403);
  assert.equal(second.codex.accountReads,reads);
  assert.equal((await(await second.get('status',secondLogin.cookie)).json()).codexConfirmation.localConnectionConfirmed,false);
  assert.equal((await second.post('codex-account/confirm',{challengeId:inspection.body.challengeId},secondLogin.cookie,second.initial.csrf,first.origin)).status,403);
  assert.equal(first.calls.length,firstCalls);assert.equal(first.codex.turns.length,0);assert.equal(second.codex.turns.length,0);
});

test('customer mode or tool-count drift retires old history and confirmation and blocks new turns',async t=>{
  for(const change of [{mode:'document-workbench'},{toolCount:1}]){
    const f=await fixture(t),login=await f.login();await f.confirm(login.cookie);
    assert.equal((await f.post('turn',{message:'old customer history'},login.cookie)).status,202);f.codex.complete();
    assert.equal(f.app.snapshot(client).session.messages.length,2);
    f.codex.drift(change);
    const status=await(await f.get('status',login.cookie)).json();
    assert.equal(status.ready,false);assert.equal(status.codexConnectionReady,false);
    assert.equal(status.codexConfirmation.localConnectionConfirmed,false);
    assert.deepEqual(f.app.snapshot(client).session.messages,[]);
    assert.equal((await f.post('turn',{message:'must stay blocked'},login.cookie)).status,403);
    assert.equal(f.codex.turns.length,1);assert.equal(f.codex.threads,1);
  }
});

function confirmationFacts(scope,at,sequence=1){return {scope,clientId:client,
  buildx:{sessionId:'opaque-confirmation-session',userId:user.id,generation:1,verified:true,expiresAt:at+3600000},
  codex:{connectionGeneration:1,accountRevision:1,observationSequence:sequence,observedAt:new Date(at).toISOString(),
    status:'verified',type:'chatgpt',ready:true}};}
test('model/customer challenge scope is exclusive even with otherwise identical trusted identities',()=>{
  const at=Date.parse('2026-10-25T19:45:00.000Z');
  for(const scope of ['model','customer-chat']){
    const invalidations=[],owner=createCodexConfirmation({required:true,now:()=>at,onInvalidate:reason=>invalidations.push(reason)});
    try{
      const prepared=owner.prepare(confirmationFacts(scope,at));assert.equal(prepared.ok,true);
      const other=scope==='model'?'customer-chat':'model';
      assert.equal(owner.confirm(prepared.value.challengeId,confirmationFacts(other,at,2)).ok,false);
      assert.deepEqual(invalidations,['connection_changed']);
      assert.equal(owner.status(confirmationFacts(scope,at,2)).localConnectionConfirmed,false);
      assert.equal(owner.prepare(confirmationFacts('source-development',at,3)).ok,false);
    }finally{assert.deepEqual(owner.close(),{closed:true});}
  }
});

test('confirmed scope cannot transfer while same-scope same-session renewal preserves confirmation',()=>{
  let at=Date.parse('2026-10-25T19:45:00.000Z');
  for(const scope of ['model','customer-chat']){
    const invalidations=[],owner=createCodexConfirmation({required:true,now:()=>at,onInvalidate:reason=>invalidations.push(reason)});
    try{
      const prepared=owner.prepare(confirmationFacts(scope,at));assert.equal(prepared.ok,true);
      assert.equal(owner.confirm(prepared.value.challengeId,confirmationFacts(scope,at,2)).ok,true);
      at+=600000;
      const renewed=confirmationFacts(scope,at,3);renewed.buildx.verified=false;
      assert.equal(owner.status(renewed).phase,'checking');assert.deepEqual(invalidations,[]);
      renewed.buildx.verified=true;assert.equal(owner.status(renewed).localConnectionConfirmed,true);
      const other=scope==='model'?'customer-chat':'model';
      assert.equal(owner.status(confirmationFacts(other,at,3)).localConnectionConfirmed,false);
      assert.deepEqual(invalidations,['connection_changed']);
      assert.equal(owner.status(confirmationFacts(scope,at,4)).localConnectionConfirmed,false);
      assert.deepEqual(invalidations,['connection_changed']);
    }finally{assert.deepEqual(owner.close(),{closed:true});}
  }
});
