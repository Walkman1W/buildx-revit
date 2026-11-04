import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createModelWorkspaceFixture} from './test-support/model-workspace-preview.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {invokeReadonlyPanelCommand,invokeWorkbench,combineWorkbenchTiming} from './lib/workbench-client.mjs';
import {sanitizePanelAudit} from './lib/panel-audit.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(check){const end=Date.now()+5000;while(!await check()){if(Date.now()>end)throw new Error('Async command progress fixture deadline');await pause(5);}}
const event=(phase,requestId=randomUUID(),operation='status',extra={})=>({code:'phase_timing',source:'workbench',phase,requestId,operation,...extra});
const success=command=>({ok:true,value:{command,data:{activeView:{id:12,type:'FloorPlan'}}}});
const command=f=>f.app.snapshot('model-test-client').command;
const terminal=async(f,id)=>{await wait(()=>command(f)?.executionId===id&&!['running','stopping'].includes(command(f).status));return command(f);};

// This peer services only a fresh test directory. It never attaches to Revit.
async function nativePeer(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-async-progress-')),queue=path.join(root,'queue'),session='b'.repeat(32);
  for(const name of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,name),{recursive:true});
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version:'0.6.5',atomicReadSnapshot:true}));
  const requests=[],pending=[];let stopped=false,held=true;
  const document={title:'异步样例',path:'D:/isolated-progress/sample.rvt',activeViewId:12,activeViewType:'FloorPlan',allowedSample:true,modified:false};
  async function complete(request){
    const status={hostSession:session,hostVersion:'0.6.5',document,capabilities:{atomicReadSnapshot:true,structuredScriptParameters:true}};
    const value=request.operation==='status'?request.atomicRead?{operation:'status',hostSession:session,snapshot:status,value:status,atomicReadSnapshot:true}:status:
      {operation:request.operation,mode:'rollback',committed:false,document:document.title,value:{text:'PRIVATE-RESULT'}};
    const destination=path.join(queue,'outbox',request.id+'.json');
    await fs.writeFile(destination+'.tmp',JSON.stringify({id:request.id,ok:true,result:value}));await fs.rename(destination+'.tmp',destination);
  }
  const work=(async()=>{while(!stopped){
    for(const name of (await fs.readdir(path.join(queue,'inbox'))).filter(name=>name.endsWith('.json'))){
      const from=path.join(queue,'inbox',name),request=JSON.parse(await fs.readFile(from,'utf8'));await fs.rename(from,path.join(queue,'processing',name));requests.push(request);
      if(held)pending.push(request);else await complete(request);
    }await pause(5);
  }})();
  t.after(async()=>{stopped=true;await work;await fs.rm(root,{recursive:true,force:true});});
  return {root,requests,document,async release(){held=false;for(const request of pending.splice(0))await complete(request);}};
}

async function fixture(t,invokeReadonlyCommand){
  const f=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,required:false,invokeReadonlyCommand});t.after(()=>f.close());
  const stream=await f.events(),snapshot=(await stream.next()).data;return {...f,stream,conversationId:snapshot.session.conversation.id};
}
const start=(f,id='document')=>f.post('command',{conversationId:f.conversationId,commandId:id,parameters:{}});

test('real HTTP and SSE expose waiting before a held native read completes without extra requests or inference',async t=>{
  const peer=await nativePeer(t),journal=[];
  const f=await fixture(t,(id,args,control)=>invokeReadonlyPanelCommand(id,args,{...control,root:peer.root,timeout:3000,onTiming:combineWorkbenchTiming(data=>journal.push(sanitizePanelAudit('phase-timing.jsonl',data)),control.onTiming)}));
  const clock=performance.now(),accepted=await start(f),acceptanceMs=performance.now()-clock;
  assert.equal(accepted.status,202);assert.equal(Object.hasOwn(accepted.body,'result'),false);
  const phases=[];let firstWaitingMs;
  while(firstWaitingMs===undefined){const next=await f.stream.next(),view=next.data.command;if(view?.executionId===accepted.body.executionId&&view.progress){phases.push(view.progress.phase);if(view.progress.phase==='waiting_revit')firstWaitingMs=performance.now()-clock;}}
  assert.equal(command(f).status,'running');assert.equal(command(f).result,undefined);
  assert.equal(command(f).progress.operation,'status');assert.match(command(f).progress.requestId,/^[a-f0-9-]{36}$/i);
  await wait(()=>peer.requests.length===1);assert.equal(peer.requests[0].atomicRead,true);
  await pause(200);assert.equal(peer.requests.length,1);assert.equal(command(f).status,'running');
  await peer.release();let completed;
  while(!completed){const next=await f.stream.next(),view=next.data.command;if(view?.executionId!==accepted.body.executionId)continue;if(view.progress)phases.push(view.progress.phase);if(view.status==='completed')completed=view;}
  const completionMs=performance.now()-clock;
  assert.deepEqual(phases,['preparing','waiting_revit','checking_result']);assert.equal(Object.hasOwn(completed,'progress'),false);assert.equal(peer.requests.length,1);
  assert.ok(completionMs>firstWaitingMs+150);assert.ok(completionMs>acceptanceMs+150);
  assert.equal(f.codex.turns.length,0);assert.equal(f.codex.threads,0);assert.ok(journal.some(row=>row?.phase==='published'));assert.ok(journal.some(row=>row?.phase==='receipt_received'));
  t.diagnostic(JSON.stringify({scope:'controlled native queue + real HTTP/SSE; not real Revit latency',acceptanceMs,firstWaitingMs,completionMs,nativeRequests:peer.requests.length,aiInferenceTokens:0,cpuAndProcessFamilyMemory:'unmeasured'}));
});

test('script transport observations are bounded metadata and independent observers cannot alter the result',async t=>{
  const peer=await nativePeer(t),events=[],journal=[];await peer.release();
  const result=await invokeWorkbench('revit_execute_csharp',{expected_document:peer.document.path,code:'// PRIVATE-CODE\nreturn parameters;',parameters:{note:'PRIVATE-PARAMETER'}},{root:peer.root,timeout:2000,onTiming:combineWorkbenchTiming(data=>{journal.push(sanitizePanelAudit('phase-timing.jsonl',data));throw new Error('controlled journal failure');},data=>events.push(data))});
  assert.deepEqual(result.value,{text:'PRIVATE-RESULT'});assert.equal(peer.requests.length,1);
  assert.deepEqual(events.map(row=>row.phase),['request_prepared','temp_ready','published','receipt_received','transport_finished']);
  assert.ok(events.every(row=>row.code==='phase_timing'&&row.source==='workbench'&&Number.isFinite(row.elapsedMs)));
  assert.equal(JSON.stringify(events).includes('PRIVATE'),false);assert.equal(JSON.stringify(journal).includes('PRIVATE'),false);
});

test('repeated, malformed and late observers cannot spam stages or overwrite a terminal or newer execution',async t=>{
  const calls=[],f=await fixture(t,(id,args,control)=>new Promise(resolve=>{calls.push({id,control,resolve});}));
  const accepted=await start(f);await wait(()=>calls.length===1);const first=calls[0],requestId=randomUUID();
  first.control.onTiming(event('request_prepared',requestId));first.control.onTiming(event('published',requestId));
  const waiting=structuredClone(command(f));
  for(let index=0;index<100;index++)first.control.onTiming(event('published',requestId));
  for(const invalid of [event('constructor',requestId),event('receipt_received','bad-id'),event('receipt_received',requestId,'unsafe operation'),event('receipt_received',randomUUID())])first.control.onTiming(invalid);
  assert.deepEqual(command(f),waiting);
  first.control.onTiming(event('receipt_received',requestId,'status',{code:'phase_timing',private:'PRIVATE-PROGRESS',args:{code:'PRIVATE-CODE'}}));
  const checking=structuredClone(command(f));first.control.onTiming(event('published',requestId));assert.deepEqual(command(f),checking);assert.equal(JSON.stringify(checking.progress).includes('PRIVATE'),false);
  first.resolve(success('document'));const finished=await terminal(f,accepted.body.executionId);assert.equal(Object.hasOwn(finished,'progress'),false);
  first.control.onTiming(event('request_prepared'));first.control.onTiming(event('published'));assert.deepEqual(command(f),finished);
  const secondAccepted=await start(f,'levels');await wait(()=>calls.length===2);const secondBefore=structuredClone(command(f));
  first.control.onTiming(event('receipt_received',requestId));assert.deepEqual(command(f),secondBefore);
  calls[1].resolve(success('levels'));await terminal(f,secondAccepted.body.executionId);
  const phases=[],terminals=new Set();while(terminals.size<2){const next=await f.stream.next(),view=next.data.command;if(view?.progress)phases.push(view.progress.phase);if(view?.status==='completed')terminals.add(view.executionId);}
  assert.deepEqual(phases,['preparing','waiting_revit','checking_result','preparing']);assert.equal(f.codex.turns.length,0);
});

test('cancelled commands retain stopping ownership and ignore subsequent progress until their receipt settles',async t=>{
  let call;const f=await fixture(t,(id,args,control)=>new Promise(resolve=>{call={id,control,resolve};}));
  const accepted=await start(f);await wait(()=>call);const requestId=randomUUID();call.control.onTiming(event('request_prepared',requestId));call.control.onTiming(event('published',requestId));
  assert.equal((await f.post('interrupt',{conversationId:f.conversationId,executionId:accepted.body.executionId})).status,202);
  const stopping=structuredClone(command(f));assert.equal(stopping.status,'stopping');assert.equal(stopping.cancelRequested,true);
  call.control.onTiming(event('receipt_received',requestId));assert.deepEqual(command(f),stopping);assert.equal((await start(f,'levels')).status,409);
  call.resolve(success('document'));const final=await terminal(f,accepted.body.executionId);assert.equal(final.cancelRequested,true);assert.equal(Object.hasOwn(final,'progress'),false);
});

test('account invalidation retires the progress owner and late observations cannot restore its projection',async t=>{
  let call;const f=await fixture(t,(id,args,control)=>new Promise(resolve=>{call={id,control,resolve};}));
  await start(f);await wait(()=>call);const requestId=randomUUID();call.control.onTiming(event('request_prepared',requestId));call.control.onTiming(event('published',requestId));
  f.codex.emit('account-invalidated',{connectionGeneration:f.codex.state.connectionGeneration});
  assert.equal(command(f),null);call.control.onTiming(event('receipt_received',requestId));assert.equal(command(f),null);
  call.resolve(success('document'));await wait(()=>!f.app.snapshot('model-test-client').busy);assert.equal(command(f),null);
});
