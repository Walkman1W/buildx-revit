import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from '../lib/panel-server.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const revision='4c0bfe0e-f04f-4c6d-a756-df8d60806001';
const apiMeta=()=>({type:'api_key',providerId:'buildx_api_provider',providerRevision:revision,model:'fixture-model',modelAvailability:'unverified'});

class FakeCodex extends EventEmitter {
  constructor(){super();this.reads=0;this.onRead=null;this.state={ready:true,error:false,mode:'document-workbench',toolCount:37,message:'fixture',connectionGeneration:1,
    codexAccount:{status:'verified',connectionGeneration:1,accountRevision:1,observationSequence:1,observedAt:new Date().toISOString(),stableAccountId:null,workspaceId:null}};}
  async refreshAccount(){
    this.reads++;
    if(this.onRead)await this.onRead();
    const meta={...this.state.codexAccount,observationSequence:this.state.codexAccount.observationSequence+1,observedAt:new Date().toISOString()};
    this.state={...this.state,codexAccount:meta};
    return {...meta,type:'chatgpt',email:'fixture@example.invalid',planType:'free'};
  }
  async close(){return {closed:true};}
  setMeta(value){this.state={...this.state,codexAccount:{...this.state.codexAccount,...value}};this.emit('state',this.state);}
}

async function fixture(t){
  const sessionId='fixture_session_0123456789',user={id:'fixture-user',email:'fixture@example.invalid'};
  const current=()=>({sessionId,user,expiresAt:Date.now()+600000});
  const success=()=>({ok:true,value:current()});
  const auth={signIn:async()=>success(),signUp:async()=>success(),verifySession:async()=>success(),refresh:async()=>success(),
    signOut:async()=>({ok:true,value:{remoteRevoked:true}}),release:()=>{},close:async()=>({ok:true,value:{closed:true}})};
  const codex=new FakeCodex();
  const app=createPanelServer({root,codex,port:0,accountAuth:auth,requireAccount:true,invokeWorkbench:async()=>{throw new Error('not used');}});
  const {origin}=await app.listen();t.after(()=>app.close());
  const initial=await (await fetch(origin+'/api/status')).json();
  let cookie;
  async function post(route,input={}){
    const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'X-Local-Chat':initial.csrf,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
      body:JSON.stringify({client:'fixture-client',...input})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function status(){return (await fetch(origin+'/api/status',{headers:cookie?{Cookie:cookie}:{}})).json();}
  const signed=await post('account/sign-in',{email:'fixture@example.invalid',password:'fixture-not-a-real-password'});assert.equal(signed.status,200);cookie=signed.cookie;
  return {codex,post,status};
}

async function confirmChat(f){
  const inspected=await f.post('codex-account/inspect');assert.equal(inspected.status,200);
  assert.equal(inspected.body.display.type,'chatgpt');
  const confirmed=await f.post('codex-account/confirm',{challengeId:inspected.body.challengeId});assert.equal(confirmed.status,200);
  assert.equal(confirmed.body.confirmation.localConnectionConfirmed,true);
}

test('API mode retires ChatGPT confirmation and cannot use the public ChatGPT account flow',async t=>{
  const f=await fixture(t);await confirmChat(f);const reads=f.codex.reads;
  f.codex.setMeta(apiMeta());
  const status=await f.status();assert.equal(status.codexAccount.type,'api_key');
  assert.equal(status.codexAccount.modelAvailability,'unverified');
  assert.equal(status.codexConfirmation.localConnectionConfirmed,false);
  assert.equal(status.codexConfirmation.phase,'confirmation_required');
  assert.equal((await f.post('codex-account/inspect')).status,403);assert.equal(f.codex.reads,reads);
  assert.equal((await f.status()).ready,false);
});

test('unknown, null, or malformed explicit API identity cannot be confirmed as ChatGPT',async t=>{
  const f=await fixture(t);
  for(const value of [{type:'api_key',providerId:'p',providerRevision:'bad',model:'m'},{type:'other'}, {type:null}]){
    f.codex.setMeta(value);
    const status=await f.status();assert.equal(status.codexConfirmation.localConnectionConfirmed,false);
    assert.equal(status.codexConfirmation.phase,'unavailable');
  }
});

test('provider switch during an in-flight account read cannot confirm the earlier ChatGPT identity',async t=>{
  const f=await fixture(t);let resume,started;
  const entered=new Promise(resolve=>{started=resolve;}),wait=new Promise(resolve=>{resume=resolve;});
  f.codex.onRead=async()=>{started();await wait;};
  const inspecting=f.post('codex-account/inspect');await entered;
  f.codex.setMeta(apiMeta());resume();
  const response=await inspecting;assert.equal(response.status,409);
  assert.equal((await f.status()).codexConfirmation.localConnectionConfirmed,false);
});
