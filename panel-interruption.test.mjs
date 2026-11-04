import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createBuildxAuth} from './lib/buildx-auth.mjs';
import {createCustomerChatServer} from './lib/customer-chat.mjs';
import {createPanelServer} from './lib/panel-server.mjs';

const root=fileURLToPath(new URL('.',import.meta.url)),client='interruption-browser';
const notice={code:'turn_result_unknown',message:'上一轮对话的结果未知；请核对后再明确发起新消息。'};
const users={a:{id:'11111111-1111-1111-1111-111111111111',email:'a@example.invalid'},
  b:{id:'22222222-2222-2222-2222-222222222222',email:'b@example.invalid'}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check,label){const end=Date.now()+2500;while(!await check()){
  if(Date.now()>end)throw new Error('Fixture deadline: '+label);await new Promise(resolve=>setTimeout(resolve,15));}}
class FakeCodex extends EventEmitter{
  state={mode:'customer-chat',toolCount:0,ready:true,error:false,message:'fixture ready',connectionGeneration:1,
    codexAccount:{status:'verified',connectionGeneration:1,accountRevision:0,observationSequence:1,
      observedAt:new Date().toISOString(),stableAccountId:null,workspaceId:null}};
  turns=[];threads=0;closes=0;starts=0;interrupts=[];threadFailure=false;
  async start(){this.starts++;const generation=this.state.connectionGeneration+1;
    this.state={...this.state,ready:true,error:false,message:'fixture reconnected',connectionGeneration:generation,
      codexAccount:{...this.state.codexAccount,status:'verified',connectionGeneration:generation,
        accountRevision:this.state.codexAccount.accountRevision+1,observationSequence:this.state.codexAccount.observationSequence+1,
        observedAt:new Date().toISOString()}};this.emit('state',this.state);}
  async close(){this.closes++;return {closed:true};}
  async refreshAccount(){const meta={...this.state.codexAccount,
    observationSequence:this.state.codexAccount.observationSequence+1,observedAt:new Date().toISOString()};
    this.state={...this.state,codexAccount:meta};return {...meta,type:'chatgpt',email:'local@example.invalid',planType:'free'};}
  async newThread(){if(this.threadFailure)throw new Error('fixture thread not created');return 'thread-'+(++this.threads);}
  async turn(threadId,text){const turn={threadId,text,turnId:'turn-'+(this.turns.length+1)};this.turns.push(turn);return {turn:{id:turn.turnId}};}
  async interrupt(threadId,turnId){this.interrupts.push({threadId,turnId});if(this.state.error)throw new Error('fixture connection already failed');}
  failed(message='fixture connection failed'){this.state={...this.state,ready:false,error:true,message,
    codexAccount:{...this.state.codexAccount,status:'unknown',accountRevision:this.state.codexAccount.accountRevision+1,observedAt:null}};
    this.emit('state',this.state);}
  notify(method,turn,params={}){this.emit('notification',method,{threadId:turn.threadId,turnId:turn.turnId,...params});}
  complete(index=0,text='fixture answer'){const turn=this.turns[index];
    this.notify('item/completed',turn,{item:{id:'answer-'+index,type:'agentMessage',text}});
    this.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'completed'}});}
}
async function fixture(t,{expiresIn=3600,workspace='customer-chat'}={}){
  let lifetime=expiresIn,networkFailure=false;const calls=[];
  const auth=createBuildxAuth({url:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_abcdefghijklmnopqrst',
    fetchImpl:async(url,options)=>{calls.push(new URL(url).pathname);
      if(networkFailure)throw new Error('fake auth unavailable');
      if(url.includes('/token?')){const input=JSON.parse(options.body),label=input.email===users.b.email||input.refresh_token?.endsWith('-b')?'b':'a';
        return Response.json({access_token:'fixture-access-'+label,refresh_token:'fixture-refresh-'+label,token_type:'bearer',expires_in:lifetime});}
      if(url.endsWith('/user'))return Response.json(options.headers.Authorization.endsWith('-b')?users.b:users.a);
      if(url.includes('/logout?scope=local'))return new Response(null,{status:204});
      throw new Error('Unexpected fake auth request');}});
  const codex=new FakeCodex();let modelCalls=0;
  if(workspace==='model')codex.state={...codex.state,mode:'document-workbench',toolCount:37};
  const app=workspace==='model'?createPanelServer({root,codex,accountAuth:auth,requireAccount:true,port:0,
    invokeWorkbench:async()=>{modelCalls++;throw new Error('No model calls are permitted');}}):
    createCustomerChatServer({root,codex,accountAuth:auth,port:0});
  const {origin}=await app.listen(),initial=await(await fetch(origin+'/api/status')).json(),streams=[];
  t.after(async()=>{for(const stream of streams){stream.controller.abort();await stream.reader?.cancel().catch(()=>{});}
    const before=codex.closes;assert.deepEqual(await app.close(),{closed:true});assert.equal(codex.closes,before+1);
    assert.deepEqual(codex.eventNames(),[]);assert.equal(auth.diagnostics().pendingRequests,0);});
  async function status(cookie){return (await fetch(origin+'/api/status',{headers:cookie?{Cookie:cookie}:{}})).json();}
  async function post(route,input={},cookie){const response=await fetch(origin+'/api/'+route,{method:'POST',
    headers:{Origin:origin,'Content-Type':'application/json','X-Local-Chat':initial.csrf,...(cookie?{Cookie:cookie}:{})},
    body:JSON.stringify({client,...input})});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  async function login(label='a'){const value=await post('account/sign-in',{email:users[label].email,password:'fixture-password'});
    assert.equal(value.status,200);return value.cookie;}
  async function confirm(cookie){const first=await post('codex-account/inspect',{},cookie);assert.equal(first.status,200);
    const last=await post('codex-account/confirm',{challengeId:first.body.challengeId},cookie);assert.equal(last.status,200);}
  async function reconnect(cookie){assert.equal((await post('reconnect',{},cookie)).status,202);
    await until(()=>codex.state.ready&&!codex.state.error,'explicit reconnect');}
  async function stream(cookie){const controller=new AbortController(),entry={controller,reader:null};streams.push(entry);
    const response=await fetch(origin+'/api/events?client='+client,{headers:cookie?{Cookie:cookie}:{},signal:controller.signal});
    assert.equal(response.status,200);const reader=response.body.getReader(),decoder=new TextDecoder();entry.reader=reader;let buffer='';
    async function next(){for(;;){const split=buffer.indexOf('\n\n');if(split>=0){const frame=buffer.slice(0,split);buffer=buffer.slice(split+2);
      if(!frame.startsWith('event: '))continue;return {event:frame.slice(7,frame.indexOf('\n')),data:JSON.parse(frame.slice(frame.indexOf('data: ')+6))};}
      const chunk=await reader.read();if(chunk.done)return {event:'EOF'};buffer+=decoder.decode(chunk.value,{stream:true});}}
    async function find(predicate){const timeout=setTimeout(()=>controller.abort(),2500);try{
      for(let i=0;i<100;i++){const item=await next();if(predicate(item))return item;if(item.event==='EOF')throw new Error('Fixture stream ended before expected state');}
      throw new Error('Fixture event budget exceeded');}finally{clearTimeout(timeout);}}
    return {next,find};}
  async function unknown(cookie,text='private interrupted question'){
    assert.equal((await post('turn',{message:text},cookie)).status,202);const turn=codex.turns.at(-1);
    codex.notify('item/agentMessage/delta',turn,{itemId:'private-partial',delta:'private partial answer'});
    codex.failed();await tick();return turn;
  }
  return {app,codex,auth,calls,status,post,login,confirm,reconnect,stream,unknown,
    lifetime:value=>{lifetime=value;},network:value=>{networkFailure=value;},modelCalls:()=>modelCalls};
}

test('EOF-retired customer history leaves a fixed content-free notice for same-identity status and recovered SSE',async t=>{
  const f=await fixture(t),cookie=await f.login();await f.confirm(cookie);
  const old=await f.stream(cookie);assert.equal((await old.next()).event,'snapshot');
  await f.unknown(cookie);await old.find(item=>item.event==='EOF');
  const state=await f.status(cookie);assert.equal(state.ready,false);assert.equal(state.busy,false);
  assert.deepEqual(f.app.snapshot(client).session.messages,[]);assert.equal(f.codex.starts,0);
  assert.deepEqual(state.interruptionNotice,notice);
  assert.deepEqual(f.app.snapshot(client).state.interruptionNotice,notice);
  const recovered=await f.stream(cookie),snapshot=await recovered.next();assert.equal(snapshot.event,'snapshot');
  assert.deepEqual(snapshot.data.state.interruptionNotice,notice);assert.deepEqual(snapshot.data.session.messages,[]);
  assert.doesNotMatch(JSON.stringify(state.interruptionNotice),/private|thread|session|11111111|scope|error/);
});

test('wrong or absent cookies cannot read or erase the notice even with the same client ID',async t=>{
  const f=await fixture(t),cookie=await f.login();await f.confirm(cookie);await f.unknown(cookie);
  for(const wrong of [undefined,'buildx_customer_chat_session=unrelated-fixture-id',cookie.replace('buildx_customer_chat_session=','buildx_model_session=')]){
    const state=await f.status(wrong);assert.equal(state.account.signedIn,false);assert.equal(state.interruptionNotice,null);
    assert.equal((await f.post('new-chat',{},wrong)).status,401);
    assert.equal((await f.post('turn',{message:'forged client cannot acknowledge'},wrong)).status,401);
  }
  assert.deepEqual((await f.status(cookie)).interruptionNotice,notice);
});

test('same-session renewal, explicit reconnect and confirmation preserve notice until an acknowledged new turn',async t=>{
  const f=await fixture(t),cookie=await f.login();await f.confirm(cookie);await f.unknown(cookie);
  await f.reconnect(cookie);assert.deepEqual((await f.status(cookie)).interruptionNotice,notice);
  await f.confirm(cookie);assert.deepEqual((await f.status(cookie)).interruptionNotice,notice);
  const renewal=await f.post('account/refresh-session',{},cookie);assert.equal(renewal.status,200);assert.equal(renewal.cookie,undefined);
  assert.deepEqual((await f.status(cookie)).interruptionNotice,notice);
  const events=await f.stream(cookie);assert.deepEqual((await events.next()).data.state.interruptionNotice,notice);
  f.codex.threadFailure=true;
  assert.equal((await f.post('turn',{message:'failed thread creation'},cookie)).status,502);
  assert.deepEqual((await f.status(cookie)).interruptionNotice,notice);
  f.codex.threadFailure=false;
  assert.equal((await f.post('turn',{message:'explicit new message'},cookie)).status,202);
  const published=await events.find(item=>item.event==='conversation'&&item.data.state.interruptionNotice===null&&
    item.data.session.messages.some(message=>message.text==='explicit new message'));
  assert.equal(published.data.state.interruptionNotice,null);
  assert.equal((await f.status(cookie)).interruptionNotice,null);
  assert.equal(f.codex.turns.length,2);f.codex.complete(1);
});

test('successful explicit new-chat clears the fixed notice and publishes the cleared projection',async t=>{
  const f=await fixture(t),cookie=await f.login();await f.confirm(cookie);await f.unknown(cookie);
  const events=await f.stream(cookie);assert.deepEqual((await events.next()).data.state.interruptionNotice,notice);
  assert.equal((await f.post('new-chat',{},cookie)).status,200);
  const cleared=await events.find(item=>item.event==='conversation'&&item.data.state.interruptionNotice===null);
  assert.deepEqual(cleared.data.session.messages,[]);assert.equal((await f.status(cookie)).interruptionNotice,null);
  assert.equal(f.codex.turns.length,1);assert.equal(f.codex.starts,0);
});

test('signout and account switch clear notice and late old notifications cannot issue it to the new user',async t=>{
  const f=await fixture(t),a=await f.login();await f.confirm(a);const old=await f.unknown(a,'account A private input');
  assert.deepEqual((await f.status(a)).interruptionNotice,notice);
  assert.equal((await f.post('account/sign-out',{},a)).status,200);assert.equal((await f.status(a)).interruptionNotice,null);
  const b=await f.login('b');await f.reconnect(b);await f.confirm(b);
  assert.equal((await f.status(b)).interruptionNotice,null);
  assert.equal((await f.post('turn',{message:'account B current input'},b)).status,202);
  f.codex.notify('item/agentMessage/delta',old,{itemId:'old-late',delta:'account A private late text'});
  f.codex.notify('turn/completed',old,{turn:{id:old.turnId,status:'unknown'}});
  assert.equal((await f.status(b)).interruptionNotice,null);
  assert.doesNotMatch(JSON.stringify(f.app.snapshot(client)),/account A private/);
  assert.equal(f.codex.turns.length,2);f.codex.complete(1);
  assert.equal((await f.status(a)).interruptionNotice,null);
});

test('actual access expiry clears a previously issued notice rather than leaving it for the next account',async t=>{
  const f=await fixture(t,{expiresIn:1}),cookie=await f.login();await f.confirm(cookie);const old=await f.unknown(cookie);
  assert.deepEqual((await f.status(cookie)).interruptionNotice,notice);
  await until(async()=>!(await f.status(cookie)).account.signedIn,'real access expiry');
  assert.equal((await f.status(cookie)).interruptionNotice,null);assert.equal(f.app.snapshot(client).state.interruptionNotice,null);
  f.codex.notify('turn/completed',old,{turn:{id:old.turnId,status:'unknown'}});
  f.lifetime(3600);const next=await f.login('b');assert.equal((await f.status(next)).interruptionNotice,null);
});

test('an old run finishing unknown after BuildX expiry cannot issue a notice under a new identity',async t=>{
  const f=await fixture(t,{expiresIn:1}),a=await f.login();await f.confirm(a);
  assert.equal((await f.post('turn',{message:'old active account task'},a)).status,202);const old=f.codex.turns[0];
  await until(async()=>!(await f.status(a)).account.signedIn,'expiry with active turn');
  f.codex.failed();await tick();
  assert.equal((await f.status(a)).interruptionNotice,null);assert.equal(f.app.snapshot(client).state.interruptionNotice,null);
  f.lifetime(3600);const b=await f.login('b');await f.reconnect(b);await f.confirm(b);
  f.codex.notify('turn/completed',old,{turn:{id:old.turnId,status:'unknown'}});
  assert.equal((await f.status(b)).interruptionNotice,null);assert.equal(f.codex.turns.length,1);
});

test('temporary verification failure hides notice without destroying its same-owner recovery',async t=>{
  const f=await fixture(t),cookie=await f.login();await f.confirm(cookie);await f.unknown(cookie);
  f.network(true);const unavailable=await f.status(cookie);
  assert.equal(unavailable.account.signedIn,false);assert.equal(unavailable.interruptionNotice,null);
  assert.equal(f.app.snapshot(client).state.interruptionNotice,null);
  f.network(false);assert.deepEqual((await f.status(cookie)).interruptionNotice,notice);
  const recovered=await f.stream(cookie);assert.deepEqual((await recovered.next()).data.state.interruptionNotice,notice);
  assert.equal(f.codex.turns.length,1);
});

test('an unknown outcome during temporary BuildX verification failure retains only same-owner notice until reverified',async t=>{
  const f=await fixture(t),cookie=await f.login();await f.confirm(cookie);
  assert.equal((await f.post('turn',{message:'active before verification outage'},cookie)).status,202);
  f.network(true);assert.equal((await f.status(cookie)).account.signedIn,false);
  f.codex.failed();await tick();
  assert.equal(f.app.snapshot(client).state.interruptionNotice,null);
  assert.deepEqual(f.app.snapshot(client).session.messages,[]);
  f.network(false);assert.deepEqual((await f.status(cookie)).interruptionNotice,notice);
  assert.equal(f.codex.turns.length,1);assert.equal(f.codex.starts,0);
});

test('authenticated model SSE remains available while unknown model runs cannot issue the customer-only notice',async t=>{
  const f=await fixture(t,{workspace:'model'}),cookie=await f.login();await f.confirm(cookie);
  const events=await f.stream(cookie),first=await events.next();assert.equal(first.event,'snapshot');
  assert.equal(first.data.workspace.kind,'model');assert.equal(first.data.state.interruptionNotice,null);
  await f.unknown(cookie);await events.find(item=>item.event==='EOF');
  assert.equal((await f.status(cookie)).interruptionNotice,null);assert.equal(f.app.snapshot(client).state.interruptionNotice,null);
  assert.equal(f.modelCalls(),0);assert.equal(f.codex.starts,0);
});
