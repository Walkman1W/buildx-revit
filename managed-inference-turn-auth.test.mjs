import test from 'node:test';
import assert from 'node:assert/strict';
import {createBuildxAuth} from './lib/buildx-auth.mjs';
const origin='https://abcdefghijklmnopqrst.supabase.co', cloud='https://inference.example.test', now=2_000_000_000_000;
const user={id:'12345678-1234-1234-1234-123456789abc',email:'fixture@example.test'};
function fixture(handler, extra={}) {
 return createBuildxAuth({url:origin,publishableKey:'sb_publishable_abcdefghijklmnopqrstuvwxyz',inferenceGrantOrigin:cloud,now:()=>now,...extra,fetchImpl:async(url,request)=>{
 if(url===origin+'/auth/v1/token?grant_type=password')return Response.json({access_token:'access-fixture',refresh_token:'refresh-fixture',token_type:'bearer',expires_in:3600});
 if(url===origin+'/auth/v1/user')return Response.json(user);
 return handler(url,request);
 }});
}
async function login(auth){return (await auth.signIn(user.email,'fixture')).value.sessionId;}
test('open and finish use fixed route and return only public turn facts',async t=>{
 const requests=[];const auth=fixture((url,r)=>{requests.push({url,r});return Response.json(url.endsWith('/open')?{turnId:'turn-1',expiresAt:now+60_000,extra:'ignored'}:{closed:true,extra:'ignored'});});t.after(auth.close);
 const id=await login(auth);assert.deepEqual(await auth.openInferenceTurn(id),{ok:true,value:{turnId:'turn-1',expiresAt:now+60_000}});
 assert.deepEqual(await auth.finishInferenceTurn(id,'turn-1'),{ok:true,value:{closed:true}});
 assert.deepEqual(requests.map(x=>x.url),[cloud+'/v1/managed/turns/open',cloud+'/v1/managed/turns/finish']);
 assert.deepEqual(requests.map(x=>JSON.parse(x.r.body)),[{}, {turnId:'turn-1'}]);assert.ok(requests.every(x=>x.r.headers.Authorization==='Bearer access-fixture' && x.r.headers.apikey===undefined && x.r.redirect==='error'));
});
test('denial is explicit, malformed results rejected',async t=>{let status=403;const auth=fixture(()=>status===403?Response.json({},{status}):Response.json({turnId:'bad turn',expiresAt:now+1}));t.after(auth.close);const id=await login(auth);assert.equal((await auth.openInferenceTurn(id)).error.code,'AUTH_DENIED');status=200;assert.equal((await auth.openInferenceTurn(id)).error.code,'AUTH_RESPONSE_INVALID');});
test('cancellation and session release discard late replies',async t=>{let release;const auth=fixture(()=>new Promise(resolve=>{release=resolve;}));t.after(auth.close);const id=await login(auth);const c=new AbortController();let work=auth.openInferenceTurn(id,{signal:c.signal});c.abort();assert.equal((await work).error.code,'AUTH_CANCELLED');assert.equal(auth.diagnostics().pendingRequests,1);release(Response.json({turnId:'late',expiresAt:now+1000}));await new Promise(r=>setImmediate(r));assert.equal(auth.diagnostics().pendingRequests,0);
 work=auth.finishInferenceTurn(id,'turn-1');auth.release(id);release(Response.json({closed:true}));assert.equal((await work).error.code,'AUTH_SESSION_CHANGED');});
test('timeout is reported without assuming remote outcome',async t=>{let release;const auth=fixture(()=>new Promise(resolve=>{release=resolve;}),{requestTimeoutMs:10});t.after(()=>{release?.(Response.json({turnId:'late',expiresAt:now+1000}));auth.close();});const id=await login(auth);assert.equal((await auth.openInferenceTurn(id)).error.code,'AUTH_TIMEOUT');assert.equal(auth.diagnostics().pendingRequests,1);});
