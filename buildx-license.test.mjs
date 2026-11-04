import test from 'node:test';
import assert from 'node:assert/strict';
import {createBuildxAuth} from './lib/buildx-auth.mjs';
import {createPanelAccounts} from './lib/panel-accounts.mjs';
import {buildxRuntimeConfig} from './lib/buildx-runtime-config.mjs';

const user={id:'12345678-1234-1234-1234-123456789abc',email:'one@example.test'};
const tokens={access_token:'test-access',refresh_token:'test-refresh',token_type:'bearer',expires_in:3600};
const response=x=>new Response(JSON.stringify(x));
const license={status:'trial',startsAt:'2026-10-29T00:00:00Z',endsAt:'2026-10-30T00:00:00Z'};
const code='a'.repeat(64);
test('license enforcement requires explicit configuration and a configured account backend',()=>{
  const base={BUILDX_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',BUILDX_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_abcdefghijklmnopqrstuvwxyz'};
  assert.equal(buildxRuntimeConfig(base).requireLicense,false);
  const customer=buildxRuntimeConfig({...base,BUILDX_MODE:'customer'});assert.equal(customer.requireLicense,true);customer.accountAuth.close();
  assert.throws(()=>buildxRuntimeConfig({...base,BUILDX_MODE:'customer',BUILDX_REQUIRE_LICENSE:'false'}));
  const configured=buildxRuntimeConfig({...base,BUILDX_REQUIRE_LICENSE:'true'});
  assert.equal(configured.requireLicense,true);assert.equal(configured.requireAccount,true);configured.accountAuth.close();
  assert.throws(()=>buildxRuntimeConfig({BUILDX_REQUIRE_LICENSE:'true'}));
  assert.throws(()=>buildxRuntimeConfig({...base,BUILDX_REQUIRE_LICENSE:'yes'}));
});
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('license RPC uses verified session, fixed route, and excludes provider fields',async()=>{
  const calls=[];
  const auth=createBuildxAuth({url:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_abcdefghijklmnopqrstuvwxyz',
    fetchImpl:async(url,init)=>{calls.push({url,init});return response(url.endsWith('/user')?user:url.includes('/rpc/')?{...license,secret:'untrusted'}:tokens);}});
  const signed=await auth.signIn(user.email,'password');
  const result=await auth.redeemInvite(signed.value.sessionId,code);
  assert.deepEqual(result,{ok:true,value:license});
  assert.equal(calls.at(-1).url,'https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/buildx_redeem_invite');
  assert.deepEqual(JSON.parse(calls.at(-1).init.body),{invite_code:code});
  assert.equal(calls.at(-2).url,'https://abcdefghijklmnopqrst.supabase.co/auth/v1/user');
  assert.equal((await auth.redeemInvite(signed.value.sessionId,'bad')).error.code,'AUTH_INPUT_INVALID');
  auth.close();
});

test('timeout is not retried and a late response cannot revive a signed-out session',async()=>{
  const gate=deferred();let rpc=0;
  const auth=createBuildxAuth({url:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_abcdefghijklmnopqrstuvwxyz',requestTimeoutMs:20,
    fetchImpl:async(url)=>url.includes('/rpc/')?(rpc++,await gate.promise):response(url.endsWith('/user')?user:tokens)});
  const signed=await auth.signIn(user.email,'password');
  assert.equal((await auth.redeemInvite(signed.value.sessionId,code)).error.code,'AUTH_TIMEOUT');
  assert.equal(rpc,1);auth.release(signed.value.sessionId);gate.resolve(response(license));
  await new Promise(r=>setImmediate(r));
  assert.equal((await auth.licenseStatus(signed.value.sessionId)).error.code,'AUTH_SESSION_INVALID');auth.close();
});

test('account owner binds license requests to its cookie and reports unknown redemption',async()=>{
  const gate=deferred();let calls=0;
  const auth={signIn:async()=>({ok:true,value:{sessionId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',user,expiresAt:Date.now()+60000}}),
    signUp:async()=>({ok:false}),verifySession:async()=>({ok:false}),refresh:async()=>({ok:false}),
    signOut:async()=>({ok:true,value:{}}),release:()=>{},close:async()=>({ok:true,value:{closed:true}}),
    licenseStatus:async()=>({ok:true,value:license}),redeemInvite:async()=>{calls++;return gate.promise;}};
  const accounts=createPanelAccounts({auth,required:true});
  const signed=await accounts.action('sign-in',{email:user.email,password:'password'},{headers:{}});
  const req={headers:{cookie:signed.cookie.split(';')[0]}};
  assert.equal((await accounts.action('license-status',{}, {headers:{}})).status,401);
  assert.deepEqual((await accounts.action('license-status',{},req)).body.license,license);
  assert.equal((await accounts.authorizeLicense(req)).allowed,true);
  assert.equal((await accounts.authorizeLicense({headers:{}})).allowed,false);
  assert.equal((await accounts.action('redeem',{code:'bad'},req)).status,400);
  const pending=accounts.action('redeem',{code},req);gate.resolve({ok:false,error:{code:'AUTH_TIMEOUT'}});
  const result=await pending;assert.equal(result.body.outcome,'unknown');assert.equal(calls,1);
  await accounts.close();
});
