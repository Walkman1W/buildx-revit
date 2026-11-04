import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {registerHooks,isBuiltin} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const sourceRoot=fileURLToPath(new URL('.',import.meta.url));
const requestedComponent=process.env.BUILDX_DELIVERY_COMPONENT;
if(requestedComponent!==undefined&&!path.isAbsolute(requestedComponent))throw new Error('The selected customer component must be an absolute path');
const root=requestedComponent===undefined?sourceRoot:path.resolve(requestedComponent);
const resolvedProduction=new Set(),deniedProduction=[];
const productionHook=registerHooks({resolve(specifier,context,nextResolve){
  const selected=nextResolve(specifier,context);
  if(isBuiltin(selected.url)||selected.url.startsWith('node:'))return selected;
  const selectedPath=selected.url.startsWith('file:')?fileURLToPath(selected.url):null;
  const relative=selectedPath===null?null:path.relative(root,selectedPath);
  if(relative===null||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep)){
    deniedProduction.push(selected.url);throw new Error('Production import is outside the selected customer component');
  }
  resolvedProduction.add(selected.url);return selected;
}});
const {createBuildxAuth}=await import(pathToFileURL(path.join(root,'lib','buildx-auth.mjs')).href);
const {createCustomerChatServer}=await import(pathToFileURL(path.join(root,'lib','customer-chat.mjs')).href);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
class NoExecutionCodex extends EventEmitter{
  state={mode:'customer-chat',toolCount:0,ready:false,error:false,message:'fixture not connected',
    connectionGeneration:0,codexAccount:null};
  closes=0;
  async start(){throw new Error('This account delivery test must not connect Codex');}
  async close(){this.closes++;return {closed:true};}
}

test('a disconnected first sign-in cannot retain an undeliverable local login or block the next explicit sign-in',{timeout:10000},async t=>{
  const started=deferred(),releaseVerification=deferred(),settled=deferred();
  const user={id:'11111111-1111-1111-1111-111111111111',email:'delivery@example.invalid'};
  const evidence={scenario:'POST body complete, client destroyed before delayed verification succeeds',
    productionHttp:true,productionAuth:true,upstream:'controlled fake',realCodex:false,
    realSupabase:false,cloudCalls:0,providerCalls:[],rawClientClosed:false,serverResponseClosed:false,
    firstResponseHeadersReceived:false,cleanup:null,componentRoot:root,
    componentSelection:requestedComponent===undefined?'source_default':'explicit_component'};
  let firstVerification=true;
  const auth=createBuildxAuth({url:'https://abcdefghijklmnopqrst.supabase.co',
    publishableKey:'sb_publishable_abcdefghijklmnopqrst',fetchImpl:async(url,options)=>{
      evidence.providerCalls.push({path:new URL(url).pathname,query:new URL(url).search,method:options.method});
      if(url.includes('/token?grant_type=password'))return Response.json({access_token:'fixture-delivery-access',
        refresh_token:'fixture-delivery-refresh',token_type:'bearer',expires_in:3600});
      if(url.endsWith('/user')){
        if(firstVerification){firstVerification=false;started.resolve();await releaseVerification.promise;}
        return Response.json(user);
      }
      throw new Error('Unexpected controlled upstream operation');
    }});
  // Observe only the completion of the existing producer; no alternate session
  // interpretation or HTTP identity is injected into the production account owner.
  const observedAuth=Object.freeze({...auth,signIn:async(...args)=>{
    try{return await auth.signIn(...args);}finally{settled.resolve();}
  }});
  const codex=new NoExecutionCodex(),app=createCustomerChatServer({root,accountAuth:observedAuth,codex,port:0});
  let rawRequest;
  t.after(async()=>{
    releaseVerification.resolve();
    if(rawRequest&&!rawRequest.destroyed)rawRequest.destroy();
    await settled.promise;
    const closed=await app.close();
    evidence.cleanup={panel:closed,auth:auth.diagnostics(),codexCloses:codex.closes,
      serverListening:app.server.listening,codexListeners:codex.eventNames().length};
    evidence.productionImports=[...resolvedProduction].sort();evidence.deniedProductionImports=[...deniedProduction];
    productionHook.deregister();
    if(process.env.BUILDX_DELIVERY_EVIDENCE){
      const selected=path.resolve(process.env.BUILDX_DELIVERY_EVIDENCE);
      await fs.mkdir(selected,{recursive:true});
      await fs.writeFile(path.join(selected,'receipt.json'),JSON.stringify(evidence,null,2)+'\n');
    }
    assert.deepEqual(closed,{closed:true});assert.equal(evidence.cleanup.auth.pendingRequests,0);
    assert.equal(evidence.cleanup.auth.retainedSessions,0);assert.equal(app.server.listening,false);
    assert.equal(codex.closes,1);assert.equal(codex.eventNames().length,0);
    assert.equal(deniedProduction.length,0);
  });
  const {origin}=await app.listen(),state=await(await fetch(origin+'/api/status')).json();
  const serverResponseClosed=deferred();
  app.server.on('request',(req,res)=>{
    if(req.url!=='/api/account/sign-in')return;
    res.once('close',()=>{evidence.serverResponseClosed=true;serverResponseClosed.resolve();});
  });
  const body=JSON.stringify({client:'delivery-browser',email:user.email,password:'fixture-password'});
  rawRequest=http.request(origin+'/api/account/sign-in',{method:'POST',headers:{Origin:origin,
    'X-Local-Chat':state.csrf,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
    evidence.firstResponseHeadersReceived=true;res.resume();
  });
  rawRequest.on('error',error=>{evidence.rawClientErrorCode=error.code||'unknown';});
  const rawClosed=new Promise(resolve=>rawRequest.once('close',resolve));
  rawRequest.end(body);
  await started.promise;
  evidence.uploadCompleted=rawRequest.writableFinished;
  rawRequest.destroy();await rawClosed;evidence.rawClientClosed=rawRequest.closed;
  await serverResponseClosed.promise;
  releaseVerification.resolve();await settled.promise;await nextTurn();await nextTurn();
  evidence.afterLateResult=auth.diagnostics();
  const anonymous=await(await fetch(origin+'/api/status')).json();
  evidence.anonymousSignedIn=anonymous.account.signedIn;
  const second=await fetch(origin+'/api/account/sign-in',{method:'POST',headers:{Origin:origin,
    'X-Local-Chat':state.csrf,'Content-Type':'application/json'},body});
  const secondValue=await second.json();
  evidence.nextExplicitSignInStatus=second.status;
  evidence.nextExplicitSignedIn=secondValue.account?.signedIn===true;
  evidence.nextExplicitCookieIssued=Boolean(second.headers.get('set-cookie'));
  assert.equal(evidence.uploadCompleted,true);
  assert.equal(evidence.firstResponseHeadersReceived,false);
  assert.equal(evidence.rawClientClosed,true);assert.equal(evidence.serverResponseClosed,true);
  assert.equal(evidence.anonymousSignedIn,false);
  assert.equal(evidence.afterLateResult.retainedSessions,0,'the disconnected request must release its late local session');
  assert.equal(second.status,200,'a new explicit sign-in must not be locked out by an undelivered cookie');
  assert.equal(evidence.nextExplicitSignedIn,true);assert.equal(evidence.nextExplicitCookieIssued,true);
});
