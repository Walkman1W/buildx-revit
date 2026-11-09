import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import test from 'node:test';
import {createBuildxAuth} from './lib/buildx-auth.mjs';
import {createPanelAccounts} from './lib/panel-accounts.mjs';
import {createManagedInferenceGrants} from './lib/managed-inference-grants.mjs';
import {createManagedInferenceGrantRoute} from './lib/managed-inference-grant-route.mjs';

const authOrigin = 'https://abcdefghijklmnopqrst.supabase.co';
const grantOrigin = 'https://inference.example.test';
const model = 'test-model';
const at = 2_000_000_000_000;
const user = {id:'12345678-1234-1234-1234-123456789abc',email:'fixture@example.test'};
const tokens = {access_token:'login-access-fixture',refresh_token:'login-refresh-fixture',token_type:'bearer',expires_in:3600};
const json = (body,status=200) => Response.json(body,{status});
const fixtureGrant = {token:'A'.repeat(43),turnId:'turn-one',expiresAt:at+60_000};
function authFixture(onExchange, options={}) {
  return createBuildxAuth({
    url:authOrigin, publishableKey:'sb_publishable_abcdefghijklmnopqrstuvwxyz',
    now:()=>at, inferenceGrantOrigin:grantOrigin, ...options,
    fetchImpl:async (url,request) => {
      if (url===authOrigin+'/auth/v1/token?grant_type=password') return json(tokens);
      if (url===authOrigin+'/auth/v1/user') return json(user);
      if (url===authOrigin+'/auth/v1/logout?scope=local') return new Response(null,{status:204});
      assert.equal(url,grantOrigin+'/v1/managed/grants');
      return onExchange(request);
    }
  });
}
async function signIn(accounts) {
  const login = await accounts.action('sign-in',{email:user.email,password:'fixture-password'},{headers:{}});
  assert.equal(login.status,200);
  const req = {headers:{cookie:login.cookie.split(';')[0]}};
  return {login,req,binding:accounts.bindingIdentity(req)};
}

test('the panel account exchanges its verified login for a turn-bound grant through the fixed route',async t=>{
  const cloud = createManagedInferenceGrants({
    model, now:()=>at,
    resolveTurn:({sessionId,turnId}) => ({verified:true,accountId:user.id,sessionId,turnId,expiresAt:at+90_000})
  });
  const route = createManagedInferenceGrantRoute({
    grantOwner:cloud,
    identityOwner:Object.freeze({authenticate:({accessToken})=>accessToken===tokens.access_token
      ? {verified:true,accountId:user.id,sessionId:'verified-cloud-session',expiresAt:at+90_000}
      : null})
  });
  const server = http.createServer((req,res)=>void route.handle(req,res));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{
    route.close();
    cloud.close();
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  });
  let exchanges = 0;
  const auth = authFixture(async request => {
    exchanges++;
    assert.equal(request.redirect,'error');
    assert.equal(request.headers.Authorization,'Bearer '+tokens.access_token);
    assert.equal(request.headers.apikey,undefined);
    assert.deepEqual(JSON.parse(request.body),{turnId:'turn-one'});
    return fetch(`http://127.0.0.1:${server.address().port}/v1/managed/grants`,request);
  });
  const accounts = createPanelAccounts({auth,required:true,now:()=>at});
  t.after(async ()=>{await accounts.close();});
  const {login,req,binding}=await signIn(accounts);
  assert.doesNotMatch(JSON.stringify(login.body),/login-access|login-refresh|fixture-password/);
  assert.equal((await accounts.action('inference-grant',{},req)).status,404);
  assert.equal(await accounts.requestCurrentInferenceGrant({...binding,generation:binding.generation+1},'turn-one'),null);
  assert.equal(exchanges,0);
  const grant = await accounts.requestCurrentInferenceGrant(binding,'turn-one');
  assert.deepEqual(Object.keys(grant).sort(),['expiresAt','token','turnId']);
  assert.deepEqual(await cloud.authorizationOwner.authorize({authorization:'Bearer '+grant.token,turnId:'turn-one',model}),
    {allowed:true,accountId:user.id,turnId:'turn-one'});
  assert.equal(exchanges,1);
});

test('sign-out while the exchange is in flight discards the late grant',async t=>{
  let release;
  const pending = new Promise(resolve=>{release=resolve;});
  const auth = authFixture(()=>pending);
  const accounts = createPanelAccounts({auth,required:true,now:()=>at});
  t.after(async()=>{release(json(fixtureGrant));await accounts.close();});
  const {req,binding}=await signIn(accounts);
  const request = accounts.requestCurrentInferenceGrant(binding,'turn-one');
  assert.equal((await accounts.action('sign-out',{},req)).status,200);
  release(json(fixtureGrant));
  assert.equal(await request,null);
  assert.equal(await accounts.requestCurrentInferenceGrant(binding,'turn-one'),null);
});

test('cancellation discards a late response while the underlying request still owns capacity',async t=>{
  let release;
  const pending = new Promise(resolve=>{release=resolve;});
  const auth = authFixture(()=>pending);
  t.after(()=>{release(json(fixtureGrant));auth.close();});
  const login = await auth.signIn(user.email,'fixture-password');
  const controller = new AbortController();
  const request = auth.requestInferenceGrant(login.value.sessionId,'turn-one',{signal:controller.signal});
  controller.abort();
  assert.equal((await request).error.code,'AUTH_CANCELLED');
  assert.equal(auth.diagnostics().pendingRequests,1);
  release(json(fixtureGrant));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(auth.diagnostics().pendingRequests,0);
});

test('default runtime has no grant destination and a mismatched cloud grant is rejected',async t=>{
  const disabled = authFixture(()=>assert.fail('unconfigured exchange'),{inferenceGrantOrigin:undefined});
  t.after(disabled.close);
  assert.equal((await disabled.requestInferenceGrant('unused','turn-one')).error.code,'AUTH_INFERENCE_UNCONFIGURED');
  const auth = authFixture(()=>json({...fixtureGrant,turnId:'other-turn'}));
  t.after(auth.close);
  const login = await auth.signIn(user.email,'fixture-password');
  assert.equal((await auth.requestInferenceGrant(login.value.sessionId,'turn-one')).error.code,'AUTH_RESPONSE_INVALID');
  assert.throws(()=>authFixture(()=>null,{inferenceGrantOrigin:'http://inference.example.test'}),{code:'AUTH_CONFIG_INVALID'});
});
