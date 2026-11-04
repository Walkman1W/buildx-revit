import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createCustomerChatServer} from './lib/customer-chat.mjs';
import {createBuildxAuth} from './lib/buildx-auth.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
class IdleCodex extends EventEmitter{
  state={ready:false,mode:'customer-chat',toolCount:0,message:'fixture'};
  closes=0;starts=0;
  async close(){this.closes++;return {closed:true};}
  async start(){this.starts++;}
}
function auth(){return createBuildxAuth({url:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_abcdefghijklmnopqrst',fetchImpl:async(url)=>{
  if(url.includes('/token?grant_type=password'))return Response.json({access_token:'controlled-access',refresh_token:'controlled-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600});
  if(url.endsWith('/user'))return Response.json({id:'11111111-1111-1111-1111-111111111111',email:'fixture@example.invalid'});
  throw new Error('Unexpected controlled Auth route');
}});}
const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Owned fixture did not reach its expected state');};

test('customer stop retains HTTP status and original cleanup proof until the same audit handle is released',async()=>{
  const codex=new IdleCodex(),provider=auth(),calls=[];
  let cleanupAttempts=0,released=false;
  const id='audit-owned-fixture-close';
  const owner=Object.freeze({audit(){},ready:async()=>({ok:true}),
    close:async()=>{calls.push('close');return released?{ok:false,error:{code:'audit_io_failed'},value:{closed:true}}:{ok:false,error:{code:'audit_cleanup_pending',cleanupId:id},value:{closed:false}};},
    cleanup:async observed=>{assert.equal(observed,id);calls.push('cleanup');cleanupAttempts++;if(cleanupAttempts===1)return {ok:false,error:{code:'audit_cleanup_pending',cleanupId:id},value:{closed:false}};released=true;return {ok:true,value:{closed:false}};},
  });
  const app=createCustomerChatServer({root,codex,accountAuth:provider,auditLifecycle:owner,port:0});
  try{
    const {origin}=await app.listen(),initial=await(await fetch(origin+'/api/status')).json();
    const post=async(route,input={},cookie)=>{
      const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'X-Local-Chat':initial.csrf,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify({client:'audit-owner-client',...input}),signal:AbortSignal.timeout(3000)});
      return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
    };
    const signed=await post('account/sign-in',{email:'fixture@example.invalid',password:'fixture-password'});assert.equal(signed.status,200);
    const stopping=await post('stop-service',{},signed.cookie);assert.equal(stopping.status,202);assert.equal(typeof stopping.body.cleanupId,'string');
    await wait(()=>calls.length===1);
    assert.equal(app.server.listening,true);assert.equal(cleanupAttempts,0);
    const pending=await(await fetch(origin+'/api/status')).json();assert.equal(pending.cleanupPending,true);assert.equal(pending.ready,false);assert.equal(pending.account.signedIn,false);
    assert.equal((await post('stop-service',{},signed.cookie)).status,503);
    assert.equal((await post('stop-service',{cleanupId:'wrong'},signed.cookie)).status,503);
    assert.deepEqual(calls,['close']);
    const retry=await post('stop-service',{cleanupId:stopping.body.cleanupId});assert.equal(retry.status,202);
    await wait(()=>cleanupAttempts===1);assert.equal(app.server.listening,true);assert.deepEqual(calls,['close','cleanup']);
    const finalRetry=await post('stop-service',{cleanupId:stopping.body.cleanupId});assert.equal(finalRetry.status,202);
    await wait(()=>!app.server.listening);assert.deepEqual(calls,['close','cleanup','cleanup','close']);assert.deepEqual(await app.close(),{closed:true});
    assert.equal(provider.diagnostics().retainedSessions,0);assert.equal(provider.diagnostics().pendingRequests,0);assert.equal(codex.starts,0);
  }finally{
    released=true;
    if(app.server.listening)await app.close();
    await provider.close();
  }
});

test('audit readiness rejection precedes listener and Codex startup; historical write failure does not prevent confirmed cleanup',async()=>{
  const codex=new IdleCodex(),provider=auth();let closes=0;
  const owner=Object.freeze({audit(){},ready:async()=>({ok:false,error:{code:'audit_directory_changed'}}),close:async()=>{closes++;return {ok:false,error:{code:'audit_directory_changed'},value:{closed:true}};},cleanup:async()=>{assert.fail('No owned pending handle exists');}});
  const app=createCustomerChatServer({root,codex,accountAuth:provider,auditLifecycle:owner,port:0});
  try{await assert.rejects(app.listen(),/日志目录/);assert.equal(app.server.listening,false);assert.equal(codex.starts,0);assert.deepEqual(await app.close(),{closed:true});assert.equal(closes,1);assert.equal(provider.diagnostics().closed,true);}
  finally{await app.close();}
});

test('a different writer or accessor-backed lifecycle cannot replace the captured audit owner',async()=>{
  const codex=new IdleCodex(),provider=auth();let getterCalls=0;
  const owner=Object.freeze({audit(){},ready:async()=>({ok:true}),close:async()=>({ok:true,value:{closed:true}}),cleanup:async()=>({ok:true})});
  try{
    assert.throws(()=>createCustomerChatServer({root,codex,accountAuth:provider,auditLifecycle:owner,audit(){},port:0}),/same owner/);
    const accessor={audit:owner.audit,ready:owner.ready,cleanup:owner.cleanup};Object.defineProperty(accessor,'close',{get(){getterCalls++;return owner.close;}});Object.freeze(accessor);
    assert.throws(()=>createCustomerChatServer({root,codex,accountAuth:provider,auditLifecycle:accessor,port:0}),/immutable trusted owner/);assert.equal(getterCalls,0);
  }finally{await provider.close();}
});

test('a late audit-ready receipt cannot reopen a server already explicitly closed',async()=>{
  const codex=new IdleCodex(),provider=auth();let release;
  const ready=new Promise(resolve=>{release=resolve;});
  const owner=Object.freeze({audit(){},ready:()=>ready,close:async()=>({ok:true,value:{closed:true}}),cleanup:async()=>{assert.fail('No retained handle');}});
  const app=createCustomerChatServer({root,codex,accountAuth:provider,auditLifecycle:owner,port:0});
  const listening=app.listen();
  assert.deepEqual(await app.close(),{closed:true});release({ok:true});
  await assert.rejects(listening,/迟到/);assert.equal(app.server.listening,false);assert.equal(codex.starts,0);
  await assert.rejects(app.listen(),/关闭/);
});
