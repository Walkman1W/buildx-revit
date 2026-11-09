import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import test from 'node:test';
import {createManagedInferenceGrantRoute} from './lib/managed-inference-grant-route.mjs';
import {createManagedInferenceGrants} from './lib/managed-inference-grants.mjs';
import {createManagedInferenceTurns} from './lib/managed-inference-turns.mjs';

const model = 'fixture-model';
const turnId = 'first-turn';
const identity = {verified:true,accountId:'account-one',sessionId:'session-one',expiresAt:1050};
const validBody = JSON.stringify({turnId});
const requestHeaders = {authorization:'Bearer fixture-login','content-type':'application/json'};

async function fixture(t, options={}) {
  const grant = createManagedInferenceGrants({
    model,now:()=>1000,resolveTurn:({sessionId,turnId:requested}) =>
      sessionId===identity.sessionId&&requested===turnId
        ? {...identity,accountId:options.turnAccount??identity.accountId,turnId,expiresAt:1200}
        : null
  });
  const route = createManagedInferenceGrantRoute({
    identityOwner:Object.freeze({authenticate:options.authenticate??(({accessToken})=>accessToken==='fixture-login'?identity:null)}),
    grantOwner:options.grantOwner??grant, ...(options.turnOwner?{turnOwner:options.turnOwner}:{}), ...options.limits
  });
  const server = http.createServer((req,res)=>void route.handle(req,res));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{
    route.close();
    grant.close();
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  });
  const url = `http://127.0.0.1:${server.address().port}/v1/managed/grants`;
  return {route,grant,url,send:(body=validBody,headers=requestHeaders)=>fetch(url,{method:'POST',headers,body})};
}

test('the grant route binds a live turn and caps its expiry at verified login expiry',async t=>{
  const f = await fixture(t);
  const response = await f.send();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const grant = await response.json();
  assert.deepEqual(Object.keys(grant).sort(),['expiresAt','token','turnId']);
  assert.equal(grant.expiresAt,1050);
  assert.deepEqual(await f.grant.authorizationOwner.authorize({authorization:'Bearer '+grant.token,turnId,model}),
    {allowed:true,accountId:'account-one',turnId});
  assert.equal((await f.send('{"turnId":"someone-elses-turn"}')).status,403);
});

test('invalid bearers and bodies cannot select an account or call the identity owner',async t=>{
  let identityChecks=0;
  const f=await fixture(t,{authenticate:()=>{identityChecks++;return null;}});
  for(const [body,headers,status] of [
    [validBody,{'content-type':'application/json'},401],
    [validBody,{...requestHeaders,authorization:'Bearer one, Bearer two'},401],
    [validBody,{...requestHeaders,'content-type':'text/plain'},415],
    ['{"turnId":"first-turn","accountId":"account-one"}',requestHeaders,400],
    ['{"turnId":"wrong","turnId":"first-turn"}',requestHeaders,400],
    [' '.repeat(1025),requestHeaders,413]
  ]){
    const response = await f.send(body,headers);
    assert.equal(response.status,status);
    assert.deepEqual(await response.json(),{error:'grant_unavailable'});
  }
  assert.equal(identityChecks,0);
  assert.equal((await f.send()).status,401);
  assert.equal(identityChecks,1);
});

test('an account change between login verification and issue does not mint a grant',async t=>{
  const f=await fixture(t,{turnAccount:'replacement-account'});
  const response=await f.send();
  assert.equal(response.status,403);
  assert.deepEqual(await response.json(),{error:'grant_unavailable'});
});

test('timed-out authentication retains its slot and cannot mint a late grant',async t=>{
  let release,started,signal,mints=0;
  const authStarted=new Promise(resolve=>{started=resolve;});
  const ignoredAbort=new Promise(resolve=>{release=resolve;});
  t.after(()=>release(identity));
  const f=await fixture(t,{
    limits:{timeoutMs:50,maxInflight:1},
    authenticate:input=>{signal=input.signal;started();return ignoredAbort;},
    grantOwner:Object.freeze({issue(){mints++;return null;}})
  });
  const initial=f.send();
  await authStarted;
  const timedOut=await initial;
  assert.equal(timedOut.status,408);
  assert.deepEqual(await timedOut.json(),{error:'grant_unavailable'});
  assert.equal(signal.aborted,true);
  const busy=await f.send();
  assert.equal(busy.status,503);
  assert.deepEqual(await f.route.close(),{closed:false,pending:1});
  release(identity);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(mints,0);
  assert.deepEqual(f.route.close(),{closed:true,pending:0});
});


test('turn routes authenticate bearer and reject foreign finish on loopback',async t=>{
  const identities=Object.freeze({authenticate:({accessToken})=>accessToken==='fixture-login'?identity:accessToken==='other-login'?{...identity,accountId:'account-two',sessionId:'session-two'}:null,verifySession:()=>identity});
  const turns=createManagedInferenceTurns({identityOwner:identities,now:()=>1000});t.after(()=>turns.close());
  const f=await fixture(t,{turnOwner:turns});const endpoint=f.url.replace('/grants','/turns/');
  const send=(path,body,authorization='Bearer fixture-login')=>fetch(endpoint+path,{method:'POST',headers:{authorization,'content-type':'application/json'},body});
  assert.equal((await send('open','{"accountId":"account-one"}')).status,400);
  assert.equal((await send('open','{}','Bearer forged')).status,403);
  const opened=await send('open','{}');assert.equal(opened.status,200);const value=await opened.json();assert.equal(value.expiresAt,1050);
  assert.equal((await send('finish',JSON.stringify({turnId:value.turnId}),'Bearer other-login')).status,403);
  assert.equal((await send('finish',`{"turnId":"${value.turnId}","turnId":"${value.turnId}"}`)).status,400);
  const finished=await send('finish',JSON.stringify({turnId:value.turnId}));assert.equal(finished.status,200);assert.deepEqual(await finished.json(),{closed:true});
  assert.equal((await send('finish',JSON.stringify({turnId:value.turnId}))).status,403);
});

test('turn route unknown errors fail closed and no route is exposed without owner',async t=>{
  const f=await fixture(t);const endpoint=f.url.replace('/grants','/turns/open');
  assert.equal((await fetch(endpoint,{method:'POST',headers:requestHeaders,body:'{}'})).status,404);
  const g=await fixture(t,{turnOwner:Object.freeze({open:()=>{throw Error('unknown')},finish:()=>true})});
  assert.equal((await fetch(g.url.replace('/grants','/turns/open'),{method:'POST',headers:requestHeaders,body:'{}'})).status,503);
});

test('timed out turn open retains capacity until original owner settles',async t=>{
  let release,started,signal;const entered=new Promise(r=>started=r);const blocked=new Promise(r=>release=r);
  t.after(()=>release(null));
  const owner=Object.freeze({open:input=>{signal=input.signal;started();return blocked;},finish:()=>true});
  const f=await fixture(t,{turnOwner:owner,limits:{timeoutMs:50,maxInflight:1}});
  const endpoint=f.url.replace('/grants','/turns/open');const send=()=>fetch(endpoint,{method:'POST',headers:requestHeaders,body:'{}'});
  const first=send();await entered;assert.equal((await first).status,408);assert.equal(signal.aborted,true);
  assert.equal((await send()).status,503);assert.deepEqual(f.route.close(),{closed:false,pending:1});
  release({turnId:'late',expiresAt:2000});await new Promise(r=>setImmediate(r));assert.deepEqual(f.route.close(),{closed:true,pending:0});
});
