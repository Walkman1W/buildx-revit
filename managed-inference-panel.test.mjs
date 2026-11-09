import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {setTimeout as wait} from 'node:timers/promises';
import test from 'node:test';
import {createModelWorkspaceSessionProfile,MANAGED_WORKBENCH_PILOT_PROFILE,MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {createManagedPanelInference,createManagedPanelInferenceForAccount} from './lib/managed-panel-inference.mjs';
import {createManagedInferenceGrants} from './lib/managed-inference-grants.mjs';
import {createManagedInferenceTurns} from './lib/managed-inference-turns.mjs';
import {createManagedInferenceGrantRoute} from './lib/managed-inference-grant-route.mjs';
import {MANAGED_WORKBENCH_DYNAMIC_TOOL} from './lib/managed-workbench-reads.mjs';
import {MODEL_OPERATION_SCHEMA_TOOL} from './lib/model-operation-contracts.mjs';
import {createModelWorkspaceFixture,FixtureCodex} from './test-support/selection-preview-fixture.mjs';

async function fixture(t,{holdOpen,holdFinish,onManagedClose,useTurnTransport=false,accessServices=null,invokeManagedWorkbenchRead,readContextFailure,contextReceiptPollDelays,inferenceModeFactory}={}){
  let allowedGeneration=null;
  const accountId='11111111-1111-1111-1111-111111111111',sessionId='fixture-cloud-session';
  const provider={
    type:'api_key',providerId:'buildx_managed_fixture',
    providerRevision:'4c0bfe0e-f04f-4c6d-a756-df8d60806001',model:'fixture-model'
  };
  const cloudIdentity={verified:true,accountId,sessionId,expiresAt:Date.now()+600000};
  const cloudTurns=createManagedInferenceTurns({identityOwner:Object.freeze({
    authenticate:({accessToken})=>accessToken==='fixture-access'?cloudIdentity:null,
    verifySession:({sessionId:current})=>current===sessionId?cloudIdentity:null
  })});
  const cloudGrants=createManagedInferenceGrants({model:provider.model,resolveTurn:cloudTurns.resolveTurn});
  const opens=[],finishes=[];
  const isCurrent=({account,connection})=>account.userId===accountId&&connection.generation===allowedGeneration&&
    connection.providerRevision===provider.providerRevision;
  let managedInference=useTurnTransport?null:createManagedPanelInference({
    isCurrent,
    async openTurn({account,signal}){
      if(account.userId!==accountId)return null;
      const opened=await cloudTurns.open({accessToken:'fixture-access',signal});
      if(opened)opens.push(opened.turnId);
      if(opened&&holdOpen)await holdOpen();
      return opened;
    },
    async finishTurn({turnId}){
      finishes.push(turnId);
      if(holdFinish)await holdFinish();
      return {closed:await cloudTurns.finish({accessToken:'fixture-access',turnId})};
    }
  });
  if(managedInference&&onManagedClose){
    const owner=managedInference;
    managedInference=Object.freeze({...owner,close(){onManagedClose();return owner.close();}});
  }
  let cloudRoute,cloudServer,cloudOrigin;
  const cloudRequests=[];
  if(useTurnTransport){
    cloudRoute=createManagedInferenceGrantRoute({
      identityOwner:cloudTurns.identityOwner,grantOwner:cloudGrants,
      turnOwner:Object.freeze({
        async open(input){
          const result=await cloudTurns.open(input);
          if(result)opens.push(result.turnId);
          return result;
        },
        async finish(input){
          const finished=await cloudTurns.finish(input);
          if(finished)finishes.push(input.turnId);
          return finished;
        }
      })
    });
    cloudServer=http.createServer((req,res)=>void cloudRoute.handle(req,res));
    cloudServer.listen(0,'127.0.0.1');
    await once(cloudServer,'listening');
    cloudOrigin=`http://127.0.0.1:${cloudServer.address().port}`;
  }
  const f=await createModelWorkspaceFixture({
    profile:MODEL_WORKSPACE_SESSION_PROFILE,requireLicense:true,
    managedInference,accessServices,readContextFailure,contextReceiptPollDelays,inferenceModeFactory,
    ...(invokeManagedWorkbenchRead?{invokeManagedWorkbenchRead,dynamicTools:[MANAGED_WORKBENCH_DYNAMIC_TOOL]}:{}),
    managedInferenceFactory:useTurnTransport?accountAuth=>{
      managedInference=createManagedPanelInferenceForAccount({accountAuth,isCurrent});
      return managedInference;
    }:null,
    async inferenceGrantFixture(request,pathname){
      if(cloudOrigin){
        cloudRequests.push(pathname);
        return fetch(cloudOrigin+pathname,request);
      }
      if(request.headers.Authorization!=='Bearer fixture-access')return new Response(null,{status:401});
      const {turnId}=JSON.parse(request.body);
      const grant=await cloudGrants.issue({sessionId,turnId,signal:request.signal});
      return grant?Response.json(grant):new Response(null,{status:403});
    }
  });
  t.after(async()=>{
    try{await f.close();}
    finally{
      cloudRoute?.close();cloudGrants.close();cloudTurns.close();
      if(cloudServer)await new Promise(resolve=>{cloudServer.close(resolve);cloudServer.closeAllConnections();});
    }
  });
  f.codex.state={...f.codex.state,codexAccount:{...f.codex.state.codexAccount,...provider}};
  return {...f,opens,finishes,managedInference,cloudTurns,cloudGrants,cloudRequests,model:provider.model,
    allow(generation=f.codex.state.connectionGeneration){allowedGeneration=generation;},revoke(){allowedGeneration=null;}};
}

async function signIn(f){
  const signed=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'});
  assert.equal(signed.status,200);
  return signed.cookie;
}

function managedReadCall(codex,turn,id,tool,parameters={},binding={}){
  const settled=Promise.withResolvers();
  const call={outcome:null,settled:settled.promise,attempts:[]};
  const settle=(kind,value)=>{
    call.attempts.push(kind);
    if(call.outcome!==null)return false;
    call.outcome={kind,value};
    settled.resolve(call.outcome);
    return true;
  };
  codex.emit('dynamic-tool-request',{
    id,generation:codex.state.connectionGeneration,revision:codex.state.codexAccount.accountRevision,...binding,
    params:Object.freeze({threadId:turn.threadId,turnId:turn.turnId,callId:'managed-'+id,
      tool:MANAGED_WORKBENCH_DYNAMIC_TOOL.name,arguments:Object.freeze({tool,parameters:Object.freeze(parameters)})}),
    respond:value=>settle('response',value),reject:()=>settle('rejected'),discard:()=>settle('discarded')
  });
  return call;
}

async function managedReadResult(call,success){
  const outcome=await call.settled;
  assert.equal(outcome.kind,'response');
  assert.equal(outcome.value.success,success);
  assert.equal(outcome.value.contentItems.length,1);
  assert.equal(outcome.value.contentItems[0].type,'inputText');
  return JSON.parse(outcome.value.contentItems[0].text);
}

test('managed mode needs BuildX login and a current grant, without accepting a Codex confirmation',async t=>{
  const f=await fixture(t);
  f.allow();
  assert.equal((await f.status()).ready,false);
  assert.equal((await f.post('turn',{message:'unsigned'})).status,401);
  const cookie=await signIn(f);
  const conversationId=f.app.snapshot('model-test-client').session.conversation.id;
  assert.equal((await f.post('inference-mode/switch',{
    conversationId,expectedMode:'buildx-managed',mode:'local-codex'
  },cookie)).status,404);
  f.revoke();
  const pending=await f.status(cookie);
  assert.equal(pending.inferenceMode,'buildx-managed');
  assert.equal(pending.managedInferenceReady,false);
  assert.equal(pending.codexConfirmation.localConnectionConfirmed,false);
  assert.equal((await f.post('codex-account/inspect',{},cookie)).status,404);
  assert.equal((await f.post('turn',{message:'no grant'},cookie)).status,403);
  assert.equal(f.codex.turns.length,0);

  f.allow();
  const ready=await f.status(cookie);
  assert.equal(ready.managedInferenceReady,true);
  assert.equal(ready.ready,true);
  assert.equal(ready.codexConfirmation.localConnectionConfirmed,false);
  f.setLicense('disabled');
  assert.equal((await f.post('turn',{message:'blocked by license'},cookie)).status,403);
  assert.equal(f.codex.turns.length,0);
  f.setLicense('trial');
  assert.equal((await f.post('turn',{message:'accepted'},cookie)).status,202);
  assert.equal(f.codex.turns.length,1);
  f.codex.finish(0);
});

test('managed retirement inspection waits for both the active turn and its cloud finish confirmation', {timeout:10000},async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  t.after(()=>release.resolve());
  const f=await fixture(t,{holdFinish:()=>{entered.resolve();return release.promise;}});
  const cookie=await signIn(f);
  f.allow();
  let starts=0,closes=0;
  const start=f.codex.start.bind(f.codex),close=f.codex.close.bind(f.codex);
  f.codex.start=async()=>{starts++;return start();};
  f.codex.close=async()=>{closes++;return close();};
  const ready={mode:'buildx-managed',ready:true};
  assert.deepEqual(f.app.inspectInferenceModeRetirement(),ready);
  assert.deepEqual(f.opens,[]);
  assert.deepEqual(f.finishes,[]);

  assert.equal((await f.post('turn',{message:'等待本轮完成'},cookie)).status,202);
  assert.deepEqual(f.app.inspectInferenceModeRetirement(),{mode:'buildx-managed',ready:false,reason:'busy'});
  assert.equal(f.opens.length,1);
  assert.deepEqual(f.finishes,[]);
  try{
    f.codex.finish(0);
    await entered.promise;
    assert.equal((await f.status(cookie)).busy,false);
    assert.deepEqual(f.app.inspectInferenceModeRetirement(),{
      mode:'buildx-managed',ready:false,reason:'managed_turn_pending'
    });
    assert.deepEqual(f.finishes,f.opens);
  }finally{release.resolve();}

  assert.equal((await f.status(cookie)).busy,false);
  assert.deepEqual(f.app.inspectInferenceModeRetirement(),ready);
  const settledConnection=f.codex.state;
  f.codex.state={...settledConnection,cleanupPending:true};
  assert.deepEqual(f.app.inspectInferenceModeRetirement(),{
    mode:'buildx-managed',ready:false,reason:'connection_cleanup_pending'
  });
  f.codex.state=settledConnection;
  assert.deepEqual(f.app.inspectInferenceModeRetirement(),ready);
  assert.deepEqual(f.finishes,f.opens);
  assert.equal(starts,0);
  assert.equal(closes,0);
  assert.equal(f.codex.turns.length,1);
});

test('local Codex retirement inspection is available without a managed inference owner',async t=>{
  const f=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,requireLicense:true});
  t.after(()=>f.close());
  const cookie=await signIn(f);
  const status=await f.status(cookie);
  assert.notEqual(status.inferenceMode,'buildx-managed');
  assert.equal(status.codexConfirmation.localConnectionConfirmed,false);
  assert.deepEqual(f.app.inspectInferenceModeRetirement(),{mode:'local-codex',ready:true});
  assert.equal(f.codex.state.connectionGeneration,status.connectionGeneration);
  assert.equal(f.codex.closed,false);
  assert.deepEqual(f.codex.turns,[]);
  assert.deepEqual(f.workbenchCalls,[]);
});

test('retiring a confirmed local Codex keeps the panel account and conversation',async t=>{
  const f=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,requireLicense:true});
  t.after(()=>f.close());
  const cookie=await signIn(f);
  assert.equal((await f.confirm(cookie)).status,200);
  assert.equal((await f.post('turn',{message:'保留这段对话'},cookie)).status,202);
  f.codex.finish(0);
  const before=f.app.snapshot('model-test-client').session;
  const close=f.codex.close.bind(f.codex);
  f.codex.close=async()=>{
    const generation=f.codex.state.connectionGeneration;
    f.codex.state={...f.codex.state,ready:false,error:true};
    f.codex.emit('account-invalidated',{connectionGeneration:generation});
    f.codex.emit('state',f.codex.state);
    return close();
  };
  assert.deepEqual(await f.app.retireInferenceMode(),{closed:true});
  const status=await f.status(cookie),after=f.app.snapshot('model-test-client').session;
  assert.equal(status.account.signedIn,true);
  assert.equal(status.codexConfirmation.localConnectionConfirmed,false);
  assert.equal(after.conversation.id,before.conversation.id);
  assert.deepEqual(after.messages,before.messages);
  assert.equal(after.conversation.threadBinding.threadId,null);
});

test('managed retirement shares the original close attempt and preserves the signed-in conversation across retry', {timeout:10000},async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  t.after(()=>release.resolve());
  let starts=0,closes=0,managedCloses=0;
  const f=await fixture(t,{onManagedClose:()=>managedCloses++});
  const cookie=await signIn(f);
  f.allow();
  const start=f.codex.start.bind(f.codex),close=f.codex.close.bind(f.codex);
  f.codex.start=async()=>{starts++;return start();};
  f.codex.close=async()=>{
    if(++closes!==1)return close();
    entered.resolve();
    await release.promise;
    return {closed:false};
  };
  const stream=await f.events(cookie);
  t.after(()=>stream.abort());
  const readUntil=async predicate=>{
    while(true){
      const event=await stream.next();
      if(predicate(event))return event.data;
    }
  };
  const initial=await readUntil(event=>event.event==='snapshot');
  const accountId=initial.state.account.user.id,generation=initial.state.connectionGeneration;
  assert.equal((await f.post('turn',{message:'保留本轮对话'},cookie)).status,202);
  assert.deepEqual(await f.app.retireInferenceMode(),{closed:false,reason:'busy'});
  assert.equal(closes,0);
  assert.equal(managedCloses,0);
  f.codex.finish(0);
  await readUntil(event=>event.event==='done');
  const before=f.app.snapshot('model-test-client').session;
  assert.equal(before.conversation.threadBinding.threadId,f.codex.turns[0].threadId);
  assert.equal((await f.status(cookie)).busy,false);

  const first=f.app.retireInferenceMode(),joined=f.app.retireInferenceMode();
  try{
    await entered.promise;
    assert.equal(closes,1);
    const retiring=await readUntil(event=>event.event==='state'&&event.data.inferenceRetirement==='retiring');
    assert.equal(retiring.ready,false);
    assert.equal(retiring.account.user.id,accountId);
    assert.equal((await f.post('reconnect',{},cookie)).status,409);
    assert.equal((await f.post('turn',{message:'等待原连接关闭'},cookie)).status,409);
  }finally{release.resolve();}
  assert.deepEqual(await Promise.all([first,joined]),[
    {closed:false,reason:'connection_cleanup_pending'},
    {closed:false,reason:'connection_cleanup_pending'}
  ]);
  assert.equal(closes,1);
  assert.equal(managedCloses,0);
  const pending=await f.status(cookie);
  assert.equal(pending.inferenceRetirement,'retiring');
  assert.equal(pending.cleanupPending,true);
  assert.equal(pending.ready,false);
  assert.equal(pending.account.signedIn,true);
  assert.equal(pending.account.user.id,accountId);
  const beforeRetry=f.app.snapshot('model-test-client').session;
  assert.equal(beforeRetry.conversation.id,before.conversation.id);
  assert.deepEqual(beforeRetry.messages,before.messages);
  assert.equal(beforeRetry.conversation.threadBinding.threadId,before.conversation.threadBinding.threadId);
  assert.equal((await f.post('reconnect',{},cookie)).status,409);
  assert.equal((await f.post('turn',{message:'旧连接不可继续'},cookie)).status,409);

  assert.deepEqual(await f.app.retireInferenceMode(),{closed:true});
  const retired=await readUntil(event=>event.event==='state'&&event.data.inferenceRetirement==='retired');
  assert.equal(retired.ready,false);
  assert.equal(retired.cleanupPending,false);
  assert.equal(retired.account.user.id,accountId);
  const after=f.app.snapshot('model-test-client').session;
  assert.equal(after.conversation.id,before.conversation.id);
  assert.deepEqual(after.messages,before.messages);
  assert.equal(after.conversation.threadBinding.threadId,null);
  assert.equal((await f.post('reconnect',{},cookie)).status,409);
  assert.equal((await f.post('turn',{message:'旧连接仍不可继续'},cookie)).status,409);
  assert.equal((await f.status(cookie)).connectionGeneration,generation);
  assert.equal(starts,0);
  assert.equal(closes,2);
  assert.equal(managedCloses,1);
  assert.equal(f.codex.turns.length,1);
  assert.equal(f.opens.length,1);
  assert.deepEqual(f.finishes,f.opens);
});

test('a signed-in panel can switch from managed to local and back with fresh clients and owners', {timeout:10000},async t=>{
  const modes=[];
  const local=new FixtureCodex({profile:MODEL_WORKSPACE_SESSION_PROFILE,cold:true,threadPrefix:'fixture-switched-local-'});
  const nextManaged=new FixtureCodex({profile:MODEL_WORKSPACE_SESSION_PROFILE,cold:true,threadPrefix:'fixture-switched-managed-'});
  let nextOwner;
  const f=await fixture(t,{inferenceModeFactory(mode){
    modes.push(mode);
    return mode==='local-codex'
      ?Object.freeze({codex:local,managedInference:null})
      :Object.freeze({codex:nextManaged,managedInference:nextOwner});
  }});
  const cookie=await signIn(f);
  f.allow();
  assert.deepEqual(await f.app.activateInferenceMode('local-codex'),{activated:false,reason:'retirement_required'});
  assert.deepEqual(modes,[]);
  assert.equal(local.state.connectionGeneration,0);
  const clientId='model-test-client';
  assert.equal((await f.post('turn',{message:'保留托管对话'},cookie)).status,202);
  const oldTurn=f.codex.turns[0];
  f.codex.finish(oldTurn,'completed','托管原始回复');
  const before=f.app.snapshot(clientId).session;
  const accountId=(await f.status(cookie)).account.user.id;
  assert.deepEqual(await f.app.retireInferenceMode(),{closed:true});
  assert.deepEqual(await f.app.activateInferenceMode('local-codex'),{activated:true,mode:'local-codex'});
  assert.deepEqual(modes,['local-codex']);
  assert.equal(local.state.connectionGeneration,1);
  assert.equal(f.codex.closed,true);
  const localStatus=await f.status(cookie);
  assert.equal(localStatus.inferenceMode,'local-codex');
  assert.equal(localStatus.account.signedIn,true);
  assert.equal(localStatus.account.user.id,accountId);
  assert.equal(localStatus.codexConfirmation.localConnectionConfirmed,false);
  const after=f.app.snapshot(clientId).session;
  assert.equal(after.conversation.id,before.conversation.id);
  assert.deepEqual(after.messages,before.messages);
  assert.equal(after.conversation.threadBinding.threadId,null);
  assert.equal((await f.post('turn',{message:'未确认的本机发送'},cookie)).status,403);
  assert.deepEqual(local.turns,[]);
  assert.equal((await f.confirm(cookie)).status,200);

  assert.equal((await f.post('turn',{message:'确认后的本机发送'},cookie)).status,202);
  assert.equal(local.turns.length,1);
  const current=local.turns[0];
  assert.notEqual(current.threadId,oldTurn.threadId);
  const currentMessages=f.app.snapshot(clientId).session.messages;
  // Reuse the current IDs to prove that a former client itself cannot act.
  f.codex.finish(current,'completed','旧客户端迟到回复');
  f.codex.emit('account-invalidated',{connectionGeneration:local.state.connectionGeneration});
  assert.deepEqual(f.app.snapshot(clientId).session.messages,currentMessages);
  assert.equal((await f.status(cookie)).busy,true);
  local.finish(current,'completed','本机新回复');
  const done=f.app.snapshot(clientId).session;
  assert.equal(done.conversation.id,before.conversation.id);
  assert.equal(done.conversation.threadBinding.threadId,current.threadId);
  assert.deepEqual(done.messages.slice(0,before.messages.length),before.messages);
  assert.equal(done.messages.at(-1).text,'本机新回复');
  assert.equal(f.codex.turns.length,1);
  assert.equal(f.opens.length,1);
  assert.deepEqual(f.finishes,f.opens);

  const nextProvider={type:'api_key',providerId:'buildx_managed_roundtrip_fixture',
    providerRevision:'9cbb6af4-a248-4db3-82a0-46cc6b1933f8',model:f.model};
  nextManaged.state={...nextManaged.state,codexAccount:{...nextManaged.state.codexAccount,...nextProvider}};
  const nextOpens=[],nextFinishes=[],grants=[];
  nextOwner=createManagedPanelInference({
    isCurrent({account,connection}){
      const state=nextManaged.state;
      return state.ready&&account.userId===accountId&&connection.generation===state.connectionGeneration&&
        connection.revision===state.codexAccount.accountRevision&&connection.providerId===nextProvider.providerId&&
        connection.providerRevision===nextProvider.providerRevision&&connection.model===nextProvider.model;
    },
    async openTurn({signal}){
      const opened=await f.cloudTurns.open({accessToken:'fixture-access',signal});
      if(opened)nextOpens.push(opened.turnId);
      return opened;
    },
    async finishTurn({turnId}){
      nextFinishes.push(turnId);
      return {closed:await f.cloudTurns.finish({accessToken:'fixture-access',turnId})};
    }
  });
  const nextTurn=nextManaged.turn.bind(nextManaged);
  nextManaged.turn=async(...args)=>{
    const grant=await nextOwner.getCloudAuthorization();
    grants.push(await f.cloudGrants.authorizationOwner.authorize({
      authorization:'Bearer '+grant.token,turnId:grant.turnId,model:nextProvider.model
    }));
    return nextTurn(...args);
  };
  assert.deepEqual(await f.app.retireInferenceMode(),{closed:true});
  assert.deepEqual(await f.app.activateInferenceMode('buildx-managed'),{activated:true,mode:'buildx-managed'});
  assert.deepEqual(modes,['local-codex','buildx-managed']);
  assert.equal(local.closed,true);
  assert.equal(nextManaged.state.connectionGeneration,1);
  const managedStatus=await f.status(cookie);
  assert.equal(managedStatus.inferenceMode,'buildx-managed');
  assert.equal(managedStatus.managedInferenceReady,true);
  assert.equal(managedStatus.account.user.id,accountId);
  assert.equal(managedStatus.codexConfirmation.localConnectionConfirmed,false);
  assert.equal((await f.post('codex-account/inspect',{},cookie)).status,404);
  const switched=f.app.snapshot(clientId).session;
  assert.equal(switched.conversation.id,done.conversation.id);
  assert.deepEqual(switched.messages,done.messages);
  assert.equal(switched.conversation.threadBinding.threadId,null);
  assert.equal((await f.post('turn',{message:'新的托管发送'},cookie)).status,202);
  assert.equal(nextManaged.turns.length,1);
  assert.notEqual(nextManaged.turns[0].threadId,current.threadId);
  assert.equal(nextOpens.length,1);
  assert.notEqual(nextOpens[0],f.opens[0]);
  assert.equal(grants.length,1);
  assert.equal(grants[0].allowed,true);
  assert.equal(grants[0].accountId,accountId);
  assert.equal(grants[0].turnId,nextOpens[0]);
  assert.equal(f.opens.length,1);
  nextManaged.finish(0);
  assert.equal((await f.status(cookie)).busy,false);
  assert.deepEqual(nextFinishes,nextOpens);
});

test('a throwing factory or mismatched cold client leaves the managed connection retired',async t=>{
  let factoryCalls=0,rejectedStarts=0;
  const rejected=new FixtureCodex({profile:'model-readonly',cold:true});
  rejected.start=async()=>{rejectedStarts++;};
  const f=await fixture(t,{inferenceModeFactory(){
    if(++factoryCalls===1)throw new Error('fixture factory failure');
    return Object.freeze({codex:rejected,managedInference:null});
  }});
  const cookie=await signIn(f);
  f.allow();
  const accountId=(await f.status(cookie)).account.user.id;
  const conversationId=f.app.snapshot('model-test-client').session.conversation.id;
  assert.deepEqual(await f.app.retireInferenceMode(),{closed:true});
  for(let attempt=1;attempt<=2;attempt++){
    assert.deepEqual(await f.app.activateInferenceMode('local-codex'),{activated:false,reason:'incompatible_composition'});
    assert.equal(factoryCalls,attempt);
    assert.equal(rejectedStarts,0);
    assert.equal(f.codex.closed,true);
    const status=await f.status(cookie);
    assert.equal(status.ready,false);
    assert.equal(status.inferenceRetirement,'retired');
    assert.equal(status.account.user.id,accountId);
    assert.equal(f.app.snapshot('model-test-client').session.conversation.id,conversationId);
    assert.equal((await f.post('turn',{message:'退役旧连接不可使用'},cookie)).status,409);
  }
});

test('a failed local startup reconnects the new owner without restoring the retired managed client', {timeout:10000},async t=>{
  const restarted=Promise.withResolvers();
  const local=new FixtureCodex({profile:MODEL_WORKSPACE_SESSION_PROFILE,cold:true});
  let factoryCalls=0,oldStarts=0,newStarts=0,newCloses=0;
  const start=local.start.bind(local),close=local.close.bind(local);
  local.start=async()=>{
    if(++newStarts===1)throw new Error('fixture startup failure');
    await start();
    restarted.resolve();
  };
  local.close=async()=>{newCloses++;return close();};
  const f=await fixture(t,{inferenceModeFactory(){
    factoryCalls++;
    return Object.freeze({codex:local,managedInference:null});
  }});
  const oldStart=f.codex.start.bind(f.codex);
  f.codex.start=async()=>{oldStarts++;return oldStart();};
  const cookie=await signIn(f);
  f.allow();
  const accountId=(await f.status(cookie)).account.user.id;
  const conversationId=f.app.snapshot('model-test-client').session.conversation.id;
  assert.deepEqual(await f.app.retireInferenceMode(),{closed:true});
  assert.deepEqual(await f.app.activateInferenceMode('local-codex'),{
    activated:false,reason:'new_connection_unconfirmed'
  });
  assert.equal((await f.status(cookie)).ready,false);
  assert.equal(local.state.error,true);
  assert.equal(f.codex.closed,true);
  assert.equal(newStarts,1);
  assert.deepEqual(f.codex.turns,[]);
  assert.deepEqual(local.turns,[]);

  assert.equal((await f.post('reconnect',{},cookie)).status,202);
  await restarted.promise;
  const state=await f.status(cookie);
  assert.equal(state.codexConnectionReady,true);
  assert.equal(state.codexConfirmation.localConnectionConfirmed,false);
  assert.equal(state.account.user.id,accountId);
  assert.equal(f.app.snapshot('model-test-client').session.conversation.id,conversationId);
  assert.equal(factoryCalls,1);
  assert.equal(oldStarts,0);
  assert.equal(newStarts,2);
  assert.equal(newCloses,1);
});

function managedWorkbenchSwitchPeer(dynamicTools,familyLifecycleDynamicTools,trustedProfile){
  const codex=new FixtureCodex({profile:MODEL_WORKSPACE_SESSION_PROFILE,cold:true,
    threadPrefix:'fixture-managed-tool-switch-',dynamicTools,familyLifecycleDynamicTools,trustedProfile});
  const provider={type:'api_key',providerId:'fixture_managed_tool_switch',
    providerRevision:'40fb690f-5d08-40b0-9b82-404b71b9faad',model:'fixture-model'};
  codex.state={...codex.state,codexAccount:{...codex.state.codexAccount,...provider}};
  const opens=[],finishes=[];
  const turnId='fixture-managed-workbench-switch-turn';
  const managedInference=createManagedPanelInference({
    isCurrent({account,connection}){
      const state=codex.state;
      return account.verified&&state.ready&&connection.generation===state.connectionGeneration&&
        connection.revision===state.codexAccount.accountRevision&&connection.providerId===provider.providerId&&
        connection.providerRevision===provider.providerRevision&&connection.model===provider.model;
    },
    async openTurn({account}){
      opens.push(account.userId);
      return {turnId,expiresAt:Date.now()+60000};
    },
    async finishTurn({turnId:original}){
      finishes.push(original);
      return {closed:original===turnId};
    }
  });
  return {codex,managedInference,opens,finishes,turnId};
}

test('mode switching activates only the named managed read and drops its document binding on return to BYO', {timeout:10000},async t=>{
  const baseTools=[MODEL_OPERATION_SCHEMA_TOOL];
  const managedTools=[...baseTools,MANAGED_WORKBENCH_DYNAMIC_TOOL];
  const peer=managedWorkbenchSwitchPeer(managedTools,managedTools);
  const localOptions={profile:MODEL_WORKSPACE_SESSION_PROFILE,dynamicTools:baseTools,familyLifecycleDynamicTools:baseTools};
  const local=new FixtureCodex({...localOptions,cold:true});
  const calls=[];
  const document={title:'fixture-managed-tool-private-title',path:'D:\\fixture-managed-tool\\private.rvt'};
  const hostSession='fixture-managed-tool-switch-host';
  const f=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,requireLicense:true,
    codexClient:new FixtureCodex(localOptions),
    inferenceModeFactory(mode){
      return mode==='buildx-managed'
        ?Object.freeze({codex:peer.codex,managedInference:peer.managedInference})
        :Object.freeze({codex:local,managedInference:null});
    },
    async invokeManagedWorkbenchRead(name,args,control){
      assert.equal(control.shouldContinue(),true);
      calls.push({name,args,sourceDocument:control.sourceDocument});
      if(name==='revit_workbench_status')return {document,hostSession};
      return {document,hostSession,value:{total:1,returned:1,truncated:false,items:[
        {element_id:'9223372036854775807',name:'fixture-managed-tool-private-detail'}
      ]}};
    }
  });
  t.after(()=>f.close());
  const cookie=await signIn(f);
  const accountId=(await f.status(cookie)).account.user.id;
  assert.equal((await f.status(cookie)).inferenceMode,'local-codex');
  assert.deepEqual(calls,[]);
  assert.deepEqual(await f.app.retireInferenceMode(),{closed:true});
  assert.deepEqual(await f.app.activateInferenceMode('buildx-managed'),{activated:true,mode:'buildx-managed'});
  const managedStatus=await f.status(cookie);
  assert.equal(managedStatus.inferenceMode,'buildx-managed');
  assert.equal(managedStatus.managedInferenceReady,true);
  assert.equal(managedStatus.account.user.id,accountId);
  assert.equal((await f.post('turn',{message:'读取托管模型选择'},cookie)).status,202);
  const managedTurn=peer.codex.turns[0];
  const status=await managedReadResult(managedReadCall(peer.codex,managedTurn,201,'revit_workbench_status'),true);
  assert.deepEqual(status,{documentOpen:true,documentRef:status.documentRef});
  assert.match(status.documentRef,/^[0-9a-f-]{36}$/);
  const forged=managedReadCall(peer.codex,managedTurn,202,'revit_get_selection',{expected_document:document.path});
  assert.deepEqual(await managedReadResult(forged,false),{buildxToolOutcome:{schemaVersion:1,outcome:'not_started'}});
  const selection=managedReadCall(peer.codex,managedTurn,203,'revit_get_selection',{document_ref:status.documentRef});
  assert.deepEqual(await managedReadResult(selection,true),{
    count:1,returned:1,truncated:false,elementIds:['9223372036854775807']
  });
  assert.deepEqual(calls,[
    {name:'revit_workbench_status',args:{},sourceDocument:undefined},
    {name:'revit_get_selection',args:{},sourceDocument:{session:hostSession,...document}}
  ]);
  peer.codex.finish(managedTurn);
  assert.equal((await f.status(cookie)).busy,false);
  assert.deepEqual(peer.opens,[accountId]);
  assert.deepEqual(peer.finishes,[peer.turnId]);

  assert.deepEqual(await f.app.retireInferenceMode(),{closed:true});
  assert.deepEqual(await f.app.activateInferenceMode('local-codex'),{activated:true,mode:'local-codex'});
  assert.equal((await f.status(cookie)).inferenceMode,'local-codex');
  assert.equal((await f.confirm(cookie)).status,200);
  assert.equal((await f.post('turn',{message:'本机对话不会使用托管引用'},cookie)).status,202);
  const localTurn=local.turns[0];
  const late=managedReadCall(peer.codex,localTurn,204,'revit_get_selection',{document_ref:status.documentRef});
  const unexpected=managedReadCall(local,localTurn,205,'revit_get_selection',{document_ref:status.documentRef});
  assert.deepEqual(late.attempts,[]);
  assert.notEqual(unexpected.outcome?.kind,'response');
  assert.equal(calls.length,2);
  local.finish(localTurn);
});

test('mode switching rejects forged, additional and inconsistent family tool specs before startup',async t=>{
  const baseTools=[MODEL_OPERATION_SCHEMA_TOOL];
  const managedTools=[...baseTools,MANAGED_WORKBENCH_DYNAMIC_TOOL];
  const forged=Object.freeze({...MANAGED_WORKBENCH_DYNAMIC_TOOL});
  const extra=Object.freeze({...MODEL_OPERATION_SCHEMA_TOOL,name:'fixture_unexpected_dynamic'});
  const candidates=[
    managedWorkbenchSwitchPeer([...baseTools,forged],managedTools),
    managedWorkbenchSwitchPeer([...managedTools,extra],managedTools),
    managedWorkbenchSwitchPeer(managedTools,baseTools),
    managedWorkbenchSwitchPeer(managedTools,[MANAGED_WORKBENCH_DYNAMIC_TOOL,...baseTools])
  ];
  let next=0;
  const f=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,requireLicense:true,
    codexClient:new FixtureCodex({profile:MODEL_WORKSPACE_SESSION_PROFILE,dynamicTools:baseTools,familyLifecycleDynamicTools:baseTools}),
    invokeManagedWorkbenchRead:()=>assert.fail('no Revit reads are allowed before a compatible activation'),
    inferenceModeFactory(){
      const {codex,managedInference}=candidates[next++];
      return Object.freeze({codex,managedInference});
    }
  });
  t.after(()=>f.close());
  const cookie=await signIn(f);
  assert.deepEqual(await f.app.retireInferenceMode(),{closed:true});
  for(const peer of candidates){
    assert.deepEqual(await f.app.activateInferenceMode('buildx-managed'),{activated:false,reason:'incompatible_composition'});
    assert.equal(peer.codex.state.connectionGeneration,0);
    assert.deepEqual(peer.opens,[]);
    const status=await f.status(cookie);
    assert.equal(status.inferenceMode,'local-codex');
    assert.equal(status.inferenceRetirement,'retired');
  }
  assert.equal(next,candidates.length);
});

test('the authenticated HTTP switch round trips canonical BYO and pilot profiles without carrying BYO input capabilities', {timeout:15000},async t=>{
  const byoProfile=createModelWorkspaceSessionProfile(process.cwd());
  const skillId='52038d51-04f7-4352-9920-54ae1fcda197';
  const model='fixture-local-model';
  let localSkillReads=0,skillChecks=0,localModelReads=0,imageModelChecks=0;
  const localClient=(trustedProfile,options={})=>{
    const codex=new FixtureCodex({profile:MODEL_WORKSPACE_SESSION_PROFILE,trustedProfile,...options});
    codex.listSkills=async()=>{localSkillReads++;return [{id:skillId,name:'fixture local skill'}];};
    codex.assertSkillSelection=ids=>{skillChecks++;assert.deepEqual(ids,[skillId]);};
    let listed=false;
    codex.listModels=async()=>{
      listed=true;localModelReads++;
      return [{id:model,model,displayName:'Fixture Local Model',description:'',isDefault:true}];
    };
    codex.assertModelSelection=(selected,{requiresImages=false}={})=>{
      assert.equal(listed,true);
      assert.equal(selected,model);
      if(requiresImages)imageModelChecks++;
    };
    return codex;
  };
  const pilotPeer=trustedProfile=>{
    const peer=managedWorkbenchSwitchPeer(undefined,undefined,trustedProfile);
    peer.codex.listSkills=()=>assert.fail('pilot must not read the local skill catalog');
    peer.codex.assertSkillSelection=()=>assert.fail('pilot must not admit local skills');
    peer.codex.listModels=()=>assert.fail('pilot must not read the local model catalog');
    peer.codex.assertModelSelection=()=>assert.fail('pilot must not admit model overrides');
    return peer;
  };
  const original=localClient(byoProfile);
  const closeOriginal=original.close.bind(original);
  let originalCloseAttempts=0,simulateUnconfirmedClose=false;
  original.close=async()=>{
    originalCloseAttempts++;
    if(!simulateUnconfirmedClose)return closeOriginal();
    simulateUnconfirmedClose=false;
    return {closed:false};
  };
  const returned=localClient(byoProfile,{cold:true,threadPrefix:'fixture-byoreturn-'});
  const wrongByoProfiles=[
    localClient(Object.freeze({...byoProfile}),{cold:true}),
    localClient(createModelWorkspaceSessionProfile(process.cwd()),{cold:true})
  ];
  const pilot=pilotPeer(MANAGED_WORKBENCH_PILOT_PROFILE);
  const wrongPilot=pilotPeer(Object.freeze({...MANAGED_WORKBENCH_PILOT_PROFILE}));
  let chosenLocal=returned,chosenPilot=wrongPilot;
  const historyDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-pilot-roundtrip-'));
  let f;
  t.after(async()=>{
    simulateUnconfirmedClose=false;
    try{await f?.close();}
    finally{
      const [resolved,temp]=await Promise.all([fs.realpath(historyDirectory),fs.realpath(os.tmpdir())]);
      assert.equal(path.dirname(resolved),temp);
      assert.ok(path.basename(resolved).startsWith('buildx-pilot-roundtrip-'));
      await fs.rm(resolved,{recursive:true,force:true});
    }
  });
  const reads=[],document={title:'pilot fixture model',path:'D:\\fixture-pilot-roundtrip\\private.rvt'};
  const hostSession='fixture-pilot-roundtrip-host';
  f=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,requireLicense:true,
    codexClient:original,historyDirectory,managedWorkbenchPilotSwitch:true,
    inferenceModeFactory(mode){
      const {codex,managedInference}=chosenPilot;
      return mode==='buildx-managed'?Object.freeze({codex,managedInference}):
        Object.freeze({codex:chosenLocal,managedInference:null});
    },
    async invokeManagedWorkbenchRead(name,args,control){
      assert.equal(control.shouldContinue(),true);
      reads.push({name,args,sourceDocument:control.sourceDocument});
      if(name==='revit_workbench_status')return {document,hostSession};
      return {document,hostSession,value:{total:1,returned:1,truncated:false,items:[{element_id:42}]}};
    }
  });
  const client='model-test-client',otherClient='other-model-test-client';
  const otherConversation='e148fbf2-0d90-49c8-90a0-7751d466825b';
  const pilotSwitch={expectedMode:'local-codex',mode:'buildx-managed'};
  const localSwitch={expectedMode:'buildx-managed',mode:'local-codex'};
  assert.equal((await f.post('inference-mode/switch',{conversationId:otherConversation,...pilotSwitch})).status,401);
  const cookie=await signIn(f);
  const accountId=(await f.status(cookie)).account.user.id;
  const snapshot=()=>f.app.snapshot(client).session;
  const waitForIdle=async()=>{
    for(let retry=0;!f.app.inspectInferenceModeRetirement().ready&&retry<100;retry++)await wait(20);
    assert.equal(f.app.inspectInferenceModeRetirement().ready,true);
  };
  assert.equal((await f.confirm(cookie)).status,200);
  const conversationId=snapshot().conversation.id;
  const switchMode=(modes,changes={},headers={})=>f.post('inference-mode/switch',
    {conversationId,...modes,...changes},cookie,headers);
  const assertConflict=({status,body},phase,reason)=>{
    assert.equal(status,409);
    assert.equal(body.ok,false);
    assert.equal(body.phase,phase);
    if(reason)assert.equal(body.reason,reason);
    assert.ok(['local-codex','buildx-managed'].includes(body.mode));
    assert.equal(typeof body.error,'string');
  };
  assert.equal((await f.status(cookie)).inferenceSwitchAvailable,true);
  const otherLoopbackOrigin=f.origin.replace('127.0.0.1','localhost');
  assert.equal((await switchMode(pilotSwitch,{},{Origin:otherLoopbackOrigin})).status,403);
  assert.equal((await switchMode(pilotSwitch,{}, {'X-Local-Chat':'wrong-csrf'})).status,403);
  assert.equal((await switchMode(pilotSwitch,{mode:'untrusted-provider'})).status,400);
  assert.equal((await switchMode(pilotSwitch,{provider:'untrusted-provider'})).status,400);
  assertConflict(await switchMode(pilotSwitch,{conversationId:otherConversation}),'preflight','stale_conversation');
  assertConflict(await switchMode(localSwitch),'preflight','stale_mode');
  f.setLicense('expired');
  assert.equal((await switchMode(pilotSwitch)).status,403);
  f.setLicense('trial');
  assert.equal(originalCloseAttempts,0);
  const attachments=[{name:'fixture.png',mediaType:'image/png',
    data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='}];
  assert.equal((await f.post('skills',{conversationId},cookie)).status,200);
  assert.equal((await f.post('models',{},cookie)).status,200);
  assert.equal((await f.post('turn',{conversationId,message:'本机原始对话',model,attachments},cookie)).status,202);
  assertConflict(await switchMode(pilotSwitch),'retire','busy');
  assert.equal(originalCloseAttempts,0);
  original.finish(0,'completed','保留本机回复');
  const originalMessages=snapshot().messages;
  const originalUser=originalMessages.find(message=>message.role==='user');
  const originalAttachmentId=originalUser.attachments[0].id;
  await waitForIdle();
  const otherSelected=await f.post('chat/select',{client:otherClient,conversationId,draft:{text:'',includeSelection:false}},cookie);
  assert.equal(otherSelected.status,200,JSON.stringify(otherSelected.body));
  assert.equal(otherSelected.body.session.conversation.id,conversationId);
  await waitForIdle();
  simulateUnconfirmedClose=true;
  assertConflict(await switchMode(pilotSwitch),'retire','connection_cleanup_pending');
  assert.equal(originalCloseAttempts,1);
  assert.equal(wrongPilot.codex.state.connectionGeneration,0);
  assert.equal(pilot.codex.state.connectionGeneration,0);
  assertConflict(await switchMode(pilotSwitch,{client:otherClient}),'preflight','original_switch_required');
  assert.equal((await f.post('turn',{conversationId,message:'原连接仍在退出'},cookie)).status,409);
  assert.equal(originalCloseAttempts,1);
  assertConflict(await switchMode(pilotSwitch),'activate','incompatible_composition');
  assert.equal(originalCloseAttempts,2);
  assert.equal(wrongPilot.codex.state.connectionGeneration,0);
  chosenPilot=pilot;
  const activated=await switchMode(pilotSwitch);
  assert.equal(activated.status,200,JSON.stringify(activated.body));
  assert.deepEqual(activated.body,{ok:true,mode:'buildx-managed'});
  assert.equal(originalCloseAttempts,2);
  const managedStatus=await f.status(cookie);
  assert.equal(managedStatus.account.user.id,accountId);
  assert.equal(managedStatus.managedInferenceReady,true);
  assert.equal(managedStatus.turnAttachmentsAvailable,false);
  assert.equal(managedStatus.skillsAvailable,false);
  assert.equal(managedStatus.modelSelectionAvailable,false);
  assert.equal(snapshot().conversation.id,conversationId);
  assert.deepEqual(snapshot().messages,originalMessages);
  assert.equal((await f.post('skills',{conversationId},cookie)).status,404);
  assert.equal((await f.post('models',{},cookie)).status,404);
  assert.equal((await f.post('turn',{conversationId,message:'试点拒绝模型覆盖',model},cookie)).status,403);
  assert.equal((await f.post('turn',{conversationId,message:'试点拒绝本机技能',skillIds:[skillId]},cookie)).status,409);
  assert.equal((await f.post('turn',{conversationId,message:'试点拒绝附件',attachments},cookie)).status,403);
  const preview=await fetch(f.origin+'/api/chat/attachment',{
    method:'POST',headers:{Origin:f.origin,Cookie:cookie,'Content-Type':'application/json','X-Local-Chat':f.initial.csrf},
    body:JSON.stringify({client,conversationId,messageId:originalUser.id,attachmentId:originalAttachmentId}),
    signal:AbortSignal.timeout(5000)
  });
  assert.equal(preview.status,200);
  assert.equal(preview.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()),Buffer.from(attachments[0].data,'base64'));
  assert.deepEqual(pilot.codex.turns,[]);
  assert.equal((await f.post('turn',{conversationId,message:'试点只读选择'},cookie)).status,202);
  const turn=pilot.codex.turns[0];
  const readStatus=await managedReadResult(managedReadCall(pilot.codex,turn,301,'revit_workbench_status'),true);
  assert.deepEqual(await managedReadResult(managedReadCall(pilot.codex,turn,302,'revit_get_selection',{
    document_ref:readStatus.documentRef
  }),true),{count:1,returned:1,truncated:false,elementIds:['42']});
  assert.deepEqual(reads,[
    {name:'revit_workbench_status',args:{},sourceDocument:undefined},
    {name:'revit_get_selection',args:{},sourceDocument:{session:hostSession,...document}}
  ]);
  pilot.codex.finish(turn,'completed','保留托管选择结果');
  const pilotMessages=snapshot().messages;
  await waitForIdle();
  for(const client of wrongByoProfiles){
    chosenLocal=client;
    assertConflict(await switchMode(localSwitch),'activate','incompatible_composition');
    assert.equal(client.state.connectionGeneration,0);
  }
  chosenLocal=returned;
  const restored=await switchMode(localSwitch);
  assert.equal(restored.status,200,JSON.stringify(restored.body));
  assert.deepEqual(restored.body,{ok:true,mode:'local-codex'});
  const localStatus=await f.status(cookie);
  assert.equal(localStatus.account.user.id,accountId);
  assert.equal(localStatus.codexConfirmation.localConnectionConfirmed,false);
  assert.equal(localStatus.turnAttachmentsAvailable,true);
  assert.equal(localStatus.skillsAvailable,true);
  assert.equal(localStatus.modelSelectionAvailable,true);
  assert.equal(snapshot().conversation.id,conversationId);
  assert.deepEqual(snapshot().messages,pilotMessages);
  assert.equal((await f.post('turn',{conversationId,message:'还未重新确认'},cookie)).status,403);
  assert.equal((await f.confirm(cookie)).status,200);
  assert.equal((await f.post('skills',{conversationId},cookie)).status,200);
  assert.equal((await f.post('models',{},cookie)).status,200);
  assert.equal((await f.post('turn',{conversationId,message:'本机能力已恢复',model,attachments,skillIds:[skillId]},cookie)).status,202);
  assert.equal(returned.turns[0].localImages.length,1);
  assert.equal(localSkillReads,2);
  assert.equal(localModelReads,2);
  assert.equal(imageModelChecks,2);
  assert.ok(skillChecks>=1);
  assert.equal(pilot.codex.turns.length,1);
  returned.finish(0);
});

test('managed panel sends limited context while local reads and previews keep the original model identity',async t=>{
  const directory='D:\\fixture-private-root';
  const document={title:'Fixture private title',path:directory+'\\private-project.rvt',activeViewId:12,activeViewType:'FloorPlan'};
  const access={mode:'project-write',roots:[{path:directory}],revision:1,modelWritable:true};
  const accessServices=Object.freeze({
    tools:[],view:()=>access,control:()=>access,activate:async()=>({ok:true}),deactivate:async()=>{},
    select:()=>assert.fail('unexpected policy change'),current:()=>true,authorize:()=>({ok:true}),
    invoke:()=>assert.fail('unexpected file operation'),close:async()=>({closed:true})
  });
  const f=await fixture(t,{accessServices});
  f.setDocument(document,[42,'9223372036854775807']);
  const cookie=await signIn(f);
  f.allow();
  const context={includeDocument:true,includeSelection:true};
  const preview=await f.post('context',context,cookie);
  assert.equal(preview.status,200);
  assert.equal(preview.body.context.document.path,document.path);
  assert.equal(preview.body.context.document.title,document.title);
  assert.equal((await f.post('turn',{message:'统计所选',context},cookie)).status,202);
  const [{text}]=f.codex.turns;
  assert.match(text,/"document":\{"available":true,"activeView":\{"id":"12"\}\}/);
  assert.match(text,/"elementIds":\["42","9223372036854775807"\]/);
  assert.match(text,/"mode":"project-write","rootCount":1/);
  assert.match(text,/任何写入前仍须重新调用工作台状态/);
  for(const value of ['fixture-private-root','private-project.rvt',document.title,'FloorPlan','isolated-host','"roots"']){
    assert.equal(text.includes(value),false,value);
  }
  const reads=f.workbenchCalls.filter(({name})=>name==='revit_get_selection');
  assert.equal(reads.length,2);
  assert.ok(reads.every(({args})=>args.expected_document===document.path));
  f.codex.finish(0);
});

test('managed workbench reads wait for the native ack and bind document references to the active turn', {timeout:10000}, async t=>{
  const document={title:'Private fixture project',path:'D:\\fixture-private-root\\private-project.rvt'};
  const hostSession='fixture-managed-private-host';
  const privateReceipt='fixture-managed-private-receipt';
  const calls=[];
  let readFailure=false;
  const f=await fixture(t,{async invokeManagedWorkbenchRead(name,args,control){
    assert.equal(control.shouldContinue(),true);
    calls.push({name,args:structuredClone(args),sourceDocument:control.sourceDocument});
    if(name==='revit_workbench_status')return {document,hostSession,receipt:privateReceipt};
    if(readFailure)throw Object.assign(new Error(privateReceipt+' '+document.path),{
      requestId:'bcfe95b7-6b61-4b1a-9701-3c70db41ba10',producerResult:{document,hostSession,receipt:privateReceipt}
    });
    return {document,hostSession,value:{total:2,returned:2,truncated:false,items:[
      {element_id:42,name:privateReceipt},{element_id:'9223372036854775807'}
    ]}};
  }});
  const cookie=await signIn(f);
  f.allow();
  const ack=Promise.withResolvers(),entered=Promise.withResolvers();
  const turn=f.codex.turn.bind(f.codex);
  f.codex.turn=async(...args)=>{
    const result=await turn(...args);
    entered.resolve(f.codex.turns.at(-1));
    await ack.promise;
    return result;
  };

  const sending=f.post('turn',{message:'查看当前选择'},cookie);
  let firstTurn,valid;
  try {
    firstTurn=await entered.promise;
    const wrongRevision=managedReadCall(f.codex,firstTurn,1,'revit_workbench_status',{},{
      revision:f.codex.state.codexAccount.accountRevision+1
    });
    assert.equal(wrongRevision.outcome?.kind,'rejected');
    const wrongTurn=managedReadCall(f.codex,{...firstTurn,turnId:'foreign-turn'},2,'revit_workbench_status');
    valid=managedReadCall(f.codex,firstTurn,3,'revit_workbench_status');
    assert.equal(wrongTurn.outcome,null);
    assert.equal(valid.outcome,null);
    assert.equal(calls.length,0);
    ack.resolve();
    assert.equal((await sending).status,202);
    assert.equal(wrongTurn.outcome?.kind,'rejected');
  } finally {
    ack.resolve();
  }

  const status=await managedReadResult(valid,true);
  assert.deepEqual(status,{documentOpen:true,documentRef:status.documentRef});
  assert.match(status.documentRef,/^[0-9a-f-]{36}$/);
  const selection=managedReadCall(f.codex,firstTurn,4,'revit_get_selection',{document_ref:status.documentRef});
  assert.deepEqual(await managedReadResult(selection,true),{
    count:2,returned:2,truncated:false,elementIds:['42','9223372036854775807']
  });
  assert.deepEqual(calls,[
    {name:'revit_workbench_status',args:{},sourceDocument:undefined},
    {name:'revit_get_selection',args:{},sourceDocument:{session:hostSession,title:document.title,path:document.path}}
  ]);

  f.codex.finish(firstTurn);
  assert.equal((await f.status(cookie)).busy,false);
  assert.equal((await f.post('turn',{message:'刷新选择'},cookie)).status,202);
  const secondTurn=f.codex.turns.at(-1);
  assert.notEqual(firstTurn.turnId,secondTurn.turnId);
  const staleTurn=managedReadCall(f.codex,firstTurn,5,'revit_workbench_status');
  assert.equal(staleTurn.outcome?.kind,'rejected');
  const staleRef=managedReadCall(f.codex,secondTurn,6,'revit_get_selection',{document_ref:status.documentRef});
  assert.deepEqual(await managedReadResult(staleRef,false),{buildxToolOutcome:{schemaVersion:1,outcome:'not_started'}});
  assert.equal(calls.length,2);

  const fresh=await managedReadResult(managedReadCall(f.codex,secondTurn,7,'revit_workbench_status'),true);
  assert.notEqual(fresh.documentRef,status.documentRef);
  readFailure=true;
  const failed=managedReadCall(f.codex,secondTurn,8,'revit_get_selection',{document_ref:fresh.documentRef});
  assert.deepEqual(await managedReadResult(failed,false),{buildxToolOutcome:{schemaVersion:1,outcome:'unconfirmed'}});
  for(const marker of [privateReceipt,document.title,document.path,hostSession,'bcfe95b7']){
    assert.equal(failed.outcome.value.contentItems[0].text.includes(marker),false,marker);
  }
  assert.equal(calls.length,4);
  f.codex.finish(secondTurn);
});

test('a delayed managed read cannot reply or replace the next turn document binding', {timeout:10000}, async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),returned=Promise.withResolvers();
  t.after(()=>release.resolve());
  const original={title:'Retired fixture',path:'D:\\fixture-private\\old.rvt'};
  const next={title:'Current fixture',path:'D:\\fixture-private\\next.rvt'};
  const hostSession='fixture-late-read-host';
  const calls=[];
  const f=await fixture(t,{async invokeManagedWorkbenchRead(name,args,control){
    calls.push(name);
    assert.equal(control.shouldContinue(),true);
    if(calls.length===1){
      entered.resolve(control);
      await release.promise;
      returned.resolve();
      return {document:original,hostSession};
    }
    if(name==='revit_workbench_status')return {document:next,hostSession};
    assert.deepEqual(control.sourceDocument,{session:hostSession,...next});
    return {document:next,hostSession,value:{total:1,returned:1,truncated:false,items:[{element_id:84}]}};
  }});
  const cookie=await signIn(f);
  f.allow();
  assert.equal((await f.post('turn',{message:'读取文档'},cookie)).status,202);
  const oldTurn=f.codex.turns.at(-1);
  const late=managedReadCall(f.codex,oldTurn,9,'revit_workbench_status');
  const originalControl=await entered.promise;
  try {
    f.codex.finish(oldTurn,'completed','');
    assert.equal((await late.settled).kind,'discarded');
    assert.equal(originalControl.shouldContinue(),false);
    assert.equal((await f.status(cookie)).busy,false);
    assert.equal((await f.post('turn',{message:'读取新文档'},cookie)).status,202);
    const newTurn=f.codex.turns.at(-1);
    const fresh=await managedReadResult(managedReadCall(f.codex,newTurn,10,'revit_workbench_status'),true);
    release.resolve();
    await returned.promise;
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(late.attempts,['discarded']);
    assert.deepEqual(await managedReadResult(managedReadCall(f.codex,newTurn,11,'revit_get_selection',{document_ref:fresh.documentRef}),true),{
      count:1,returned:1,truncated:false,elementIds:['84']
    });
    assert.deepEqual(calls,['revit_workbench_status','revit_workbench_status','revit_get_selection']);
    f.codex.finish(newTurn,'completed','');
  } finally {
    release.resolve();
  }
});

for(const changeConversation of [false,true])test(changeConversation
  ?'a late managed read receipt cannot attach to a different conversation'
  :'an unknown managed read adds only its original terminal receipt to the panel',
{timeout:10000},async t=>{
  const requestId='1961dc6f-b8df-4d3a-9c9f-7e10d3706547';
  const wrongId='8e3fac0a-9432-4b40-8891-2c43b780ce7f';
  const rawMarker='fixture-private-workbench-timeout';
  const rawDetail=rawMarker+' D:\\fixture-private\\original.rvt';
  const failure=new Error(rawDetail);
  const waiting=Promise.withResolvers(),complete=Promise.withResolvers(),closed=Promise.withResolvers();
  let calls=0,checks=0,closes=0;
  t.after(()=>complete.resolve());
  const owner=Object.freeze({
    async inspect(){
      checks++;
      if(checks===1)return {ok:true,value:{requestId:wrongId,status:'received',terminal:true,detail:rawDetail}};
      if(checks===2)return {ok:true,value:{requestId,status:'pending',terminal:false,detail:rawDetail}};
      waiting.resolve();
      await complete.promise;
      return {ok:true,value:{requestId,status:'received',terminal:true,detail:rawDetail}};
    },
    close(){closes++;closed.resolve();return {ok:true,value:{closed:true}};}
  });
  const f=await fixture(t,{
    contextReceiptPollDelays:[0,0,0],
    readContextFailure:error=>error===failure?{outcome:'unconfirmed',requestIds:[requestId],receiptOwner:owner}:null,
    invokeManagedWorkbenchRead(name,args,control){
      calls++;
      assert.equal(name,'revit_workbench_status');
      assert.deepEqual(args,{});
      assert.equal(control.shouldContinue(),true);
      assert.equal(control.retainReceiptOwner,true);
      assert.equal(control.stopWaitingOnCancel,true);
      throw failure;
    }
  });
  const cookie=await signIn(f);
  f.allow();
  assert.equal((await f.post('turn',{message:'核对文档状态'},cookie)).status,202);
  const turn=f.codex.turns.at(-1);
  const call=managedReadCall(f.codex,turn,12,'revit_workbench_status');
  try {
    assert.deepEqual(await managedReadResult(call,false),{buildxToolOutcome:{schemaVersion:1,outcome:'unconfirmed'}});
    await waiting.promise;
    f.codex.finish(turn);
    assert.equal((await f.status(cookie)).busy,false);
    assert.deepEqual(f.app.inspectInferenceModeRetirement(),{
      mode:'buildx-managed',ready:false,reason:'receipt_pending'
    });
    const before=f.app.snapshot('model-test-client').session;
    const assistant=before.messages.find(message=>message.role==='assistant');
    const tool=assistant.tools.find(item=>item.status==='unknown');
    assert.ok(tool);
    assert.equal(before.toolReceipts,undefined);
    assert.equal(JSON.stringify(before).includes(rawMarker),false);
    if(changeConversation){
      const next=await f.post('new-chat',{},cookie);
      assert.equal(next.status,200);
      assert.notEqual(next.body.session.conversation.id,before.conversation.id);
    }
    complete.resolve();
    await closed.promise;
    assert.equal((await f.status(cookie)).busy,false);
    assert.deepEqual(f.app.inspectInferenceModeRetirement(),{mode:'buildx-managed',ready:true});
    const after=f.app.snapshot('model-test-client').session;
    assert.equal(JSON.stringify(after).includes(wrongId),false);
    assert.equal(JSON.stringify(after).includes(rawMarker),false);
    if(changeConversation){
      assert.notEqual(after.conversation.id,before.conversation.id);
      assert.deepEqual(after.messages,[]);
      assert.equal(after.toolReceipts,undefined);
    }else{
      assert.deepEqual(after.messages,before.messages);
      assert.deepEqual(after.toolReceipts,[{
        messageId:assistant.id,itemId:tool.id,requestId,status:'received',checkedAt:after.toolReceipts?.[0]?.checkedAt
      }]);
      assert.ok(Number.isFinite(Date.parse(after.toolReceipts[0].checkedAt)));
    }
    assert.deepEqual(call.attempts,['response']);
    assert.equal(calls,1);
    assert.equal(checks,3);
    assert.equal(closes,1);
  }finally{complete.resolve();}
});

test('revocation during thread startup prevents the native turn from being sent',async t=>{
  const f=await fixture(t);
  const cookie=await signIn(f);
  f.allow();
  let resume,started;
  const paused=new Promise(resolve=>{resume=resolve;});
  const entered=new Promise(resolve=>{started=resolve;});
  t.after(()=>resume());
  const newThread=f.codex.newThread.bind(f.codex);
  f.codex.newThread=async()=>{started();await paused;return newThread();};
  const request=f.post('turn',{message:'grant will change'},cookie);
  await entered;
  f.revoke();
  resume();
  assert.equal((await request).status,502);
  assert.equal(f.codex.turns.length,0);
  assert.equal((await f.status(cookie)).busy,false);
});

test('reconnect waits for confirmed cleanup and requires a grant for the new generation',async t=>{
  const f=await fixture(t);
  const cookie=await signIn(f);
  f.allow();
  const oldGeneration=f.codex.state.connectionGeneration;
  let confirmed=false;
  const close=f.codex.close.bind(f.codex);
  f.codex.close=async()=>confirmed?close():{closed:false};
  t.after(()=>{confirmed=true;});
  assert.equal((await f.post('reconnect',{},cookie)).status,202);
  const blocked=await f.status(cookie);
  assert.equal(blocked.ready,false);
  assert.equal(f.codex.state.connectionGeneration,oldGeneration);
  confirmed=true;
  assert.equal((await f.post('reconnect',{},cookie)).status,202);
  const restarted=await f.status(cookie);
  assert.ok(restarted.connectionGeneration>oldGeneration);
  assert.equal(restarted.managedInferenceReady,false);
  f.allow();
  assert.equal((await f.status(cookie)).managedInferenceReady,true);
});

test('the normal panel send opens one cloud turn and binds every grant to the verified account',async t=>{
  const f=await fixture(t,{useTurnTransport:true});
  const cookie=await signIn(f);
  f.allow();
  await assert.rejects(f.managedInference.getCloudAuthorization(),{code:'MANAGED_TURN_UNAVAILABLE'});
  const decisions=[];
  const turn=f.codex.turn.bind(f.codex);
  f.codex.turn=async(...args)=>{
    for(let request=0;request<2;request++){
      const grant=await f.managedInference.getCloudAuthorization();
      const accepted=await f.cloudGrants.authorizationOwner.authorize({
        authorization:'Bearer '+grant.token,turnId:grant.turnId,model:f.model
      });
      decisions.push(accepted);
    }
    return turn(...args);
  };
  assert.equal((await f.post('turn',{message:'managed panel'},cookie)).status,202);
  assert.equal(f.opens.length,1);
  assert.equal(decisions.length,2);
  for(const decision of decisions){
    assert.equal(decision.allowed,true);
    assert.equal(decision.accountId,'11111111-1111-1111-1111-111111111111');
    assert.equal(decision.turnId,f.opens[0]);
  }
  f.codex.finish(0);
  for(let retry=0;f.finishes.length===0&&retry<30;retry++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(f.finishes,f.opens);
  assert.deepEqual(f.cloudRequests,[
    '/v1/managed/turns/open','/v1/managed/grants','/v1/managed/grants','/v1/managed/turns/finish'
  ]);
  await assert.rejects(f.managedInference.getCloudAuthorization(),{code:'MANAGED_TURN_UNAVAILABLE'});
});

test('stopping during cloud turn creation closes the late original turn without sending Codex',async t=>{
  let release,entered;
  const wait=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{holdOpen:()=>{entered();return wait;}});
  t.after(()=>release());
  const cookie=await signIn(f);
  f.allow();
  const sending=f.post('turn',{message:'stop before native send'},cookie);
  await started;
  assert.equal((await f.post('interrupt',{},cookie)).status,202);
  release();
  assert.equal((await sending).status,202);
  assert.equal(f.codex.turns.length,0);
  assert.equal(f.opens.length,1);
  assert.deepEqual(f.finishes,f.opens);
  assert.equal((await f.status(cookie)).busy,false);
});
