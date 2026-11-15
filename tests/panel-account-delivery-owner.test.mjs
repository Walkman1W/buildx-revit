// Original account owner with controlled response events. No HTTP/native/cloud
// provider is created here; production HTTP delivery is checked separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createPanelAccounts} from '../lib/panel-accounts.mjs';

const started=performance.now(),cpuStarted=process.cpuUsage();
test.after(()=>{const cpu=process.cpuUsage(cpuStarted);console.log('ACCOUNT_DELIVERY_OWNER_METRICS '+JSON.stringify({
  scope:'this test worker; CPU/wall since test module initialization, RSS is process lifetime high-water',
  pid:process.pid,node:process.version,wallMs:performance.now()-started,
  cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,lifetimePeakRssKiB:process.resourceUsage().maxRSS,
  processFamilyCpu:null,processFamilyPeakMemory:null,tokens:null,coldWarmControlled:false}));});

const anonymous={headers:{}};
const input={client:'owner-test-client',email:'owner@example.invalid',password:'fixture-password'};
const cookie=sessionId=>({headers:{cookie:'buildx_model_session='+sessionId}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
class ResponseEvents extends EventEmitter{
  destroyed=false;writableEnded=false;writableFinished=false;
  finishResponse(){this.writableEnded=true;this.writableFinished=true;this.emit('finish');}
  closeResponse(){this.destroyed=true;this.emit('close');}
}
function noListeners(response){assert.equal(response.listenerCount('finish'),0);assert.equal(response.listenerCount('close'),0);}
function fixture(t,{authenticate}={}){
  const now=Date.now(),calls={signIn:0,signUp:0,signOut:[],release:[],close:0,clear:[]};
  let sequence=0;
  const facts=(label='owner')=>({state:'signed_in',sessionId:'fixture-'+label+'-session-'+(++sequence),
    user:{id:'fixture-'+label+'-user',email:label+'@example.invalid'},expiresAt:now+3600000});
  const defaultAuthenticate=()=>({ok:true,value:facts()});
  const auth={
    signIn:async()=>{calls.signIn++;return (authenticate??defaultAuthenticate)();},
    signUp:async()=>{calls.signUp++;return (authenticate??defaultAuthenticate)();},
    verifySession:async sessionId=>({ok:true,value:{...facts(),sessionId}}),
    refresh:async()=>{throw new Error('No refresh expected');},
    signOut:async sessionId=>{calls.signOut.push(sessionId);return {ok:true,value:{remoteRevoked:true}};},
    release:sessionId=>{calls.release.push(sessionId);return {ok:true,value:{locallySignedOut:true}};},
    close:()=>{calls.close++;return {ok:true,value:{closed:true}};},
  };
  const account=createPanelAccounts({auth,required:true,now:()=>now,onClear:reason=>calls.clear.push(reason)});
  t.after(()=>account.close());
  return {account,calls,facts};
}

test('known close during pending sign-in or signup releases only its late local session and retains operation ownership until settlement',async t=>{
  for(const route of ['sign-in','sign-up']){
    const gate=deferred(),entered=deferred(),f=fixture(t,{authenticate:()=>{entered.resolve();return gate.promise;}}),response=new ResponseEvents();
    const pending=f.account.action(route,input,anonymous,response);await entered.promise;
    response.closeResponse();noListeners(response);
    assert.equal((await f.account.action('sign-in',input,anonymous)).status,409);
    const late=f.facts(route);gate.resolve({ok:true,value:late});
    const result=await pending;assert.equal(result.status,409);assert.equal(result.cookie,undefined);
    assert.equal(f.account.view().signedIn,false);assert.equal(f.account.bindingIdentity(),null);
    assert.deepEqual(f.calls.release,[late.sessionId]);assert.deepEqual(f.calls.signOut,[]);
    assert.equal(f.calls.signIn+f.calls.signUp,1);noListeners(response);
  }
});

test('a close after session issuance but before local finish clears exactly that session',async t=>{
  const f=fixture(t),response=new ResponseEvents();
  const result=await f.account.action('sign-in',input,anonymous,response);assert.equal(result.status,200);
  const identity=f.account.bindingIdentity();assert.ok(identity);assert.equal(f.account.view().signedIn,true);
  assert.equal(response.listenerCount('close'),1);assert.equal(response.listenerCount('finish'),1);
  response.closeResponse();assert.equal(f.account.bindingIdentity(),null);assert.equal(f.account.view().signedIn,false);
  assert.deepEqual(f.calls.release,[identity.sessionId]);assert.deepEqual(f.calls.signOut,[]);noListeners(response);
  response.closeResponse();assert.deepEqual(f.calls.release,[identity.sessionId]);
});

test('local finish detaches the delivery guard and later transport close keeps the normal login',async t=>{
  const f=fixture(t),response=new ResponseEvents();
  assert.equal((await f.account.action('sign-in',input,anonymous,response)).status,200);
  const identity=f.account.bindingIdentity();response.finishResponse();noListeners(response);
  response.closeResponse();assert.deepEqual(f.account.bindingIdentity(),identity);assert.equal(f.account.view().signedIn,true);
  assert.deepEqual(f.calls.release,[]);assert.deepEqual(f.calls.signOut,[]);assert.equal(f.calls.signIn,1);
});

test('an old response close cannot clear the next user after explicit signout and another login',async t=>{
  const f=fixture(t),oldResponse=new ResponseEvents();
  assert.equal((await f.account.action('sign-in',input,anonymous,oldResponse)).status,200);
  const old=f.account.bindingIdentity();
  assert.equal((await f.account.action('sign-out',{client:input.client},cookie(old.sessionId))).status,200);
  noListeners(oldResponse);
  const newResponse=new ResponseEvents();assert.equal((await f.account.action('sign-in',input,anonymous,newResponse)).status,200);
  const current=f.account.bindingIdentity();assert.notEqual(current.sessionId,old.sessionId);
  oldResponse.closeResponse();assert.deepEqual(f.account.bindingIdentity(),current);assert.equal(f.account.view().signedIn,true);
  assert.deepEqual(f.calls.release,[]);assert.deepEqual(f.calls.signOut,[old.sessionId]);
  newResponse.finishResponse();noListeners(newResponse);
});

test('confirmation-required, rejected, thrown and malformed outcomes leave no delivery listeners or login',async t=>{
  const outcomes=[
    ()=>({ok:true,value:{state:'confirmation_required'}}),
    ()=>({ok:false,error:{code:'AUTH_INVALID_CREDENTIALS'}}),
    ()=>{throw new Error('fixture upstream failed');},
    ()=>({ok:true,value:{state:'signed_in',sessionId:'fixture-malformed-session'}}),
  ];
  for(const authenticate of outcomes){
    const f=fixture(t,{authenticate}),response=new ResponseEvents();
    const result=await f.account.action('sign-up',input,anonymous,response);assert.equal(result.cookie,undefined);
    assert.equal(f.account.view().signedIn,false);assert.equal(f.account.bindingIdentity(),null);noListeners(response);
    response.closeResponse();assert.deepEqual(f.calls.signOut,[]);assert.equal(f.calls.signUp,1);assert.equal(f.calls.signIn,0);
  }
});

test('service close while sign-in is pending prevents late resurrection and removes original response listeners',async t=>{
  const gate=deferred(),entered=deferred(),f=fixture(t,{authenticate:()=>{entered.resolve();return gate.promise;}}),response=new ResponseEvents();
  const pending=f.account.action('sign-in',input,anonymous,response);await entered.promise;
  assert.deepEqual(await f.account.close(),{closed:true});
  const late=f.facts('late');gate.resolve({ok:true,value:late});
  const result=await pending;assert.equal(result.status,409);assert.equal(result.cookie,undefined);
  assert.equal(f.account.view().signedIn,false);assert.equal(f.account.bindingIdentity(),null);
  assert.deepEqual(f.calls.release,[late.sessionId]);assert.deepEqual(f.calls.signOut,[]);noListeners(response);
});

test('an already closed or locally completed response refuses before any provider operation',async t=>{
  for(const complete of [response=>response.closeResponse(),response=>response.finishResponse()]){
    const f=fixture(t),response=new ResponseEvents();complete(response);
    const result=await f.account.action('sign-in',input,anonymous,response);assert.equal(result.status,409);
    assert.equal(f.calls.signIn+f.calls.signUp,0);assert.deepEqual(f.calls.release,[]);assert.deepEqual(f.calls.signOut,[]);
    noListeners(response);assert.equal(f.account.view().signedIn,false);
  }
});
