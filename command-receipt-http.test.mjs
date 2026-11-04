import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createReadCommandFixture} from './test-support/read-command-host.mjs';
import {createModelWorkspaceFixture} from './test-support/model-workspace-preview.mjs';
const directory=fileURLToPath(new URL('./workbench/validation/20261027-command-receipt-inspection/',import.meta.url));
const wait=async fn=>{for(let i=0;i<600;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Receipt fixture deadline');};
async function ready(f){const signed=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'});assert.equal((await f.confirm(signed.cookie)).status,200);const stream=await f.events(signed.cookie),frame=await stream.next();return {cookie:signed.cookie,stream,id:frame.data.session.conversation.id};}
const view=f=>f.app.snapshot('model-test-client');
async function terminal(f,executionId){await wait(()=>view(f).command?.executionId===executionId&&!view(f).busy);return view(f).command;}
async function check(f,cookie,id,command){const response=await f.post('command/check',{conversationId:id,commandId:command.commandId,executionId:command.executionId},cookie);assert.equal(response.status,202,JSON.stringify(response));await wait(()=>!view(f).busy);return view(f).command;}

test('cabinet late receipt stays owned until exact terminal receipt is explicitly acknowledged',async t=>{
  let terminal=false,identityChanged=false,flipHostDuringRead=false,failClose=true,closed=0,calls=0,reads=0;
  const hostIdentity={sessionId:'e'.repeat(32),pid:123,version:'0.6.6',startedUtc:'2026-01-01T00:00:00Z'},recovery={jobHandle:'owned-cabinet',hostIdentity};
  const owner=Object.freeze({inspect:()=>({ok:true,value:identityChanged?{status:'host_changed',terminal:false,canCheckAgain:true}:terminal?{status:'received',terminal:true,canCheckAgain:false,message:'原回执已核实',recovery,evidence:{jobHandle:'owned-cabinet',savePath:'D:/artifacts/cabinet.rfa',savedVerified:true,outcome:'file_persists_independently'}}:{status:'unconfirmed',terminal:false,canCheckAgain:true,message:'仍需核对',recovery,evidence:{jobHandle:'owned-cabinet',cleanupPending:true}}}),close:()=>{closed++;return failClose?{ok:false,error:{code:'RECEIPT_CLEANUP_PENDING'}}:{ok:true,value:{closed:true}};}});
  const f=await createModelWorkspaceFixture({profile:'model-workspace',required:false,cabinetFixtureTesting:true,invokeReadonlyCommand:async(name,args,options)=>{if(name==='revit_family_inspect_job'){reads++;assert.deepEqual(args,{job_handle:'owned-cabinet'});assert.deepEqual(options.expectedHostIdentity,hostIdentity);if(flipHostDuringRead)identityChanged=true;return {ok:true,value:{data:{operation:'family_inspect_job',hostSession:hostIdentity.sessionId,value:{operation:'family_inspect_job',host_session:hostIdentity.sessionId,revit_pid:123,job_handle:'owned-cabinet',success:true,cleanup_pending:true}}}};}calls++;return {ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',outcome:'unconfirmed'},receiptOwner:owner};}});t.after(async()=>{failClose=false;await f.close();});
  const id=view(f).session.conversation.id,commandId='revit_family_save_cabinet';
  const started=await f.post('command',{conversationId:id,commandId,parameters:{job_handle:'owned-cabinet'},confirmed:true});assert.equal(started.status,202);
  let current=await terminalView(f,started.body.executionId);assert.equal(current.canInspectReceipt,true);
  const ack=()=>f.post('command/acknowledge',{conversationId:id,commandId,executionId:current.executionId,revision:current.receiptCheck?.revision,confirmed:true});
  assert.notEqual((await ack()).status,200);assert.equal((await f.post('command',{conversationId:id,commandId:'document',parameters:{}})).status,409);assert.equal(calls,1);
  current=await check(f,undefined,id,current);assert.equal(current.canAcknowledgeReceipt,false);assert.notEqual((await ack()).status,200);
  assert.equal(current.canInspectCabinetJob,true);
  assert.equal((await f.post('command/recover',{conversationId:id,commandId,executionId:current.executionId,job_handle:'other'})).status,400);
  assert.equal((await f.post('command/recover',{conversationId:id,commandId,executionId:current.executionId})).status,202);await wait(()=>!view(f).busy);assert.equal(reads,1);assert.equal(view(f).command.cabinetRecoveryInspection.job.job_handle,'owned-cabinet');assert.equal(view(f).command.cabinetRecoveryInspection.job.cleanup_pending,true);assert.equal(view(f).command.status,'unknown');assert.equal(closed,0);
  flipHostDuringRead=true;assert.equal((await f.post('command/recover',{conversationId:id,commandId,executionId:current.executionId})).status,202);await wait(()=>!view(f).busy);assert.equal(view(f).command.cabinetRecoveryInspection.status,'unconfirmed');assert.equal(view(f).command.cabinetRecoveryInspection.job,undefined);assert.equal(closed,0);identityChanged=false;flipHostDuringRead=false;
  terminal=true;current=await check(f,undefined,id,current);assert.equal(current.canAcknowledgeReceipt,true);assert.equal(current.receiptCheck.evidence.jobHandle,'owned-cabinet');assert.equal(current.receiptCheck.evidence.savePath,'D:/artifacts/cabinet.rfa');assert.equal(closed,0);
  assert.equal((await f.post('command/acknowledge',{conversationId:id,commandId,executionId:current.executionId,revision:current.receiptCheck.revision-1,confirmed:true})).status,409);
  identityChanged=true;assert.equal((await ack()).status,409);assert.equal(closed,0);assert.equal(view(f).command.canInspectReceipt,true);
  identityChanged=false;current=await check(f,undefined,id,current);assert.equal(current.canAcknowledgeReceipt,true);
  assert.equal((await ack()).status,503);assert.equal(closed,1);assert.equal(view(f).command.receiptCheck.cleanupPending,true);
  failClose=false;assert.equal((await ack()).status,200);assert.equal(closed,2);assert.equal(view(f).command.receiptAcknowledged,true);
  assert.equal((await ack()).status,409);
});
async function terminalView(f,id){return terminal(f,id);}

test('normal production composition advertises and enforces cabinet write blocks',async t=>{
  let calls=0;const f=await createModelWorkspaceFixture({profile:'model-workspace',required:false,invokeReadonlyCommand:async()=>{calls++;throw new Error('blocked writes must never dispatch');}});t.after(()=>f.close());
  const response=await fetch(f.origin+'/api/command-catalog'),catalog=await response.json();assert.equal(response.status,200);
  const conversationId=view(f).session.conversation.id;
  for(const commandId of ['revit_family_create_cabinet','revit_family_save_cabinet','revit_family_close_cabinet']){
    const row=catalog.commands.find(item=>item.id===commandId);assert.equal(row.enabled,false);assert.match(row.unavailableReason,/未知回执/);
    const result=await f.post('command',{conversationId,commandId,parameters:{},confirmed:true});assert.equal(result.status,409);
  }
  assert.equal(calls,0);
});

test('completed cabinet operations without retained cleanup allow the next command and service closure',async t=>{
  const calls=[];const f=await createModelWorkspaceFixture({profile:'model-workspace',required:false,cabinetFixtureTesting:true,invokeReadonlyCommand:async(id)=>{calls.push(id);return {ok:true,value:{command:id,requestIds:[],data:{}}};}});t.after(()=>f.close());
  const id=view(f).session.conversation.id;
  for(const commandId of ['revit_family_create_cabinet','revit_family_save_cabinet','revit_family_close_cabinet','document']){
    const response=await f.post('command',{conversationId:id,commandId,parameters:{},confirmed:true});assert.equal(response.status,202);assert.equal((await terminal(f,response.body.executionId)).status,'completed');
  }
  assert.equal(calls.length,4);await f.close();
});
test('a successful producer with an uncloneable projection retains its original owner',async t=>{
  let closed=0;const owner=Object.freeze({inspect:()=>({ok:true,value:{status:'received',terminal:true,canCheckAgain:false}}),close:()=>{closed++;return {ok:true,value:{closed:true}};}});
  const f=await createModelWorkspaceFixture({profile:'model-workspace',required:false,cabinetFixtureTesting:true,invokeReadonlyCommand:async(id)=>({ok:true,value:{command:id,requestIds:[],data:{bad:()=>{}}},receiptOwner:owner})});t.after(()=>f.close());
  const conversationId=view(f).session.conversation.id,commandId='revit_family_create_cabinet',started=await f.post('command',{conversationId,commandId,parameters:{},confirmed:true});
  let pending=await terminal(f,started.body.executionId);assert.equal(pending.status,'unknown');assert.equal(pending.canInspectReceipt,true);assert.equal(closed,0);
  pending=await check(f,undefined,conversationId,pending);assert.equal(pending.canAcknowledgeReceipt,true);
  assert.equal((await f.post('command/acknowledge',{conversationId,commandId,executionId:pending.executionId,revision:pending.receiptCheck.revision,confirmed:true})).status,200);assert.equal(closed,1);
});

test('account change hides original cabinet recovery and retains its owner',async()=>{
  // The isolated child deliberately exits with a retained unknown owner: no
  // cleanup can be authorized by the replacement account in this scenario.
  const code=`
    import assert from 'node:assert/strict';
    import {createModelWorkspaceFixture} from './test-support/model-workspace-preview.mjs';
    let closed=0;
    const owner=Object.freeze({inspect:()=>({ok:true,value:{status:'pending',canCheckAgain:true}}),close:()=>{closed++;return {ok:true,value:{closed:true}};}});
    const f=await createModelWorkspaceFixture({profile:'model-workspace',cabinetFixtureTesting:true,invokeReadonlyCommand:async()=>({ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',outcome:'unconfirmed'},receiptOwner:owner})});
    const first=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'}),cookie=first.cookie;
    const stream=await f.events(cookie),frame=await stream.next(),old=frame.data.session.conversation.id;
    const commandId='revit_family_save_cabinet',started=await f.post('command',{conversationId:old,commandId,parameters:{job_handle:'private-job'},confirmed:true},cookie);
    assert.equal(started.status,202);
    for(let i=0;i<200&&f.app.snapshot('model-test-client').busy;i++)await new Promise(r=>setTimeout(r,10));
    const unknown=f.app.snapshot('model-test-client').command;assert.equal(unknown.status,'unknown');
    assert.equal((await f.post('account/sign-out',{},cookie)).status,200);assert.equal(closed,0);
    const next=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'});assert.equal(next.status,200);
    const current=f.app.snapshot('model-test-client');assert.equal(current.command,null);
    assert.notEqual((await f.post('command/recover',{conversationId:old,commandId,executionId:unknown.executionId},next.cookie)).status,202);
    assert.notEqual((await f.post('command/acknowledge',{conversationId:old,commandId,executionId:unknown.executionId,revision:1,confirmed:true},next.cookie)).status,200);
    assert.equal(closed,0);stream.abort();process.exit(0);
  `;
  const run=promisify(execFile);await run(process.execPath,['--input-type=module','-e',code],{cwd:fileURLToPath(new URL('.',import.meta.url)),timeout:15000,windowsHide:true});
});

test('late expiry is checked only by the original owner without changing chat/JSONL or sending queries',async t=>{
  const f=await createReadCommandFixture({directory,timeout:300});t.after(()=>f.close());const {cookie,id}=await ready(f);
  await f.post('turn',{message:'原引用与对话必须保持'},cookie);f.codex.finish(0,'completed','原答复');await wait(()=>!view(f).busy);await f.post('chat/draft',{conversationId:id,draft:{text:'保留草稿',includeSelection:true}},cookie);
  const before=structuredClone(view(f).session),beforeDraft=structuredClone(view(f).draft),history=path.join(f.queueRoot,'history'),log=(await fs.readdir(history,{recursive:true})).find(name=>name.endsWith(id+'.jsonl')),bytes=await fs.readFile(path.join(history,log));
  f.hold('get_selection');const started=await f.post('command',{conversationId:id,commandId:'selection',parameters:{}},cookie),unknown=await terminal(f,started.body.executionId);assert.equal(unknown.status,'unknown');assert.equal(unknown.canInspectReceipt,true);assert.equal(f.queueRequests.length,2);
  const pending=await check(f,cookie,id,unknown);assert.equal(pending.status,'unknown');assert.equal(pending.receiptCheck.status,'pending');assert.equal(pending.receiptCheck.revision,1);assert.equal(pending.canInspectReceipt,true);assert.equal(f.queueRequests.length,2);
  for(const extra of [{requestId:f.queueRequests.at(-1).id},{path:'D:/foreign.json'},{executionId:'forged'}]){const response=await f.post('command/check',{conversationId:id,commandId:'selection',executionId:unknown.executionId,...extra},cookie);assert.ok([400,409].includes(response.status));}
  f.setMode('typed-expired');await f.release();const expired=await check(f,cookie,id,pending);assert.equal(expired.status,'failed');assert.equal(expired.error.code,'COMMAND_REQUEST_EXPIRED');assert.equal(expired.receiptCheck.status,'expired');assert.equal(expired.receiptCheck.revision,2);assert.equal(expired.receiptCheck.originalError.code,'COMMAND_READ_UNCONFIRMED');assert.equal(expired.canInspectReceipt,false);assert.equal(f.queueRequests.length,2);
  assert.equal((await f.post('command/check',{conversationId:id,commandId:'selection',executionId:unknown.executionId},cookie)).status,409);assert.deepEqual(view(f).session,before);assert.deepEqual(view(f).draft,beforeDraft);assert.deepEqual(await fs.readFile(path.join(history,log)),bytes);assert.equal(f.codex.turns.length,1);assert.equal(f.codex.interrupts.length,0);
});

test('late success is an observation, not a fabricated whole-command success or a continuation',async t=>{
  const f=await createReadCommandFixture({directory,timeout:250});t.after(()=>f.close());const {cookie,id}=await ready(f);f.hold('get_selection');const started=await f.post('command',{conversationId:id,commandId:'selection',parameters:{}},cookie),unknown=await terminal(f,started.body.executionId);await f.release();
  const result=await check(f,cookie,id,unknown);assert.equal(result.status,'unknown');assert.equal(result.receiptCheck.status,'received');assert.equal(result.result,undefined);assert.equal(result.canInspectReceipt,false);assert.deepEqual(f.queueRequests.map(request=>request.operation),['status','get_selection']);assert.equal(f.codex.turns.length,0);
});

test('host replacement and newer execution cannot adopt an old receipt',async t=>{
  const f=await createReadCommandFixture({directory,timeout:250});t.after(()=>f.close());const {cookie,id}=await ready(f);f.hold('get_selection');const started=await f.post('command',{conversationId:id,commandId:'selection',parameters:{}},cookie),unknown=await terminal(f,started.body.executionId);
  const hostFile=path.join(f.queueRoot,'queue','host.json'),original=await fs.readFile(hostFile),changed=JSON.parse(original);changed.sessionId='b'.repeat(32);await fs.writeFile(hostFile,JSON.stringify(changed));const inspected=await check(f,cookie,id,unknown);assert.equal(inspected.status,'unknown');assert.equal(inspected.receiptCheck.status,'host_changed');assert.equal(inspected.canInspectReceipt,false);assert.equal(f.queueRequests.length,2);await fs.writeFile(hostFile,original);
  f.setMode('normal');const next=await f.post('command',{conversationId:id,commandId:'document',parameters:{}},cookie);await terminal(f,next.body.executionId);assert.equal((await f.post('command/check',{conversationId:id,commandId:'selection',executionId:unknown.executionId},cookie)).status,409);assert.equal(view(f).command.executionId,next.body.executionId);
});

test('account generation changes retire a delayed inspector and cleanup remains with its owner',async t=>{
  let resolve,closed=0;const delayed=new Promise(done=>resolve=done),owner=Object.freeze({inspect:()=>delayed,close:()=>{closed++;return {ok:true,value:{closed:true}};}});
  const f=await createModelWorkspaceFixture({profile:'model-readonly',invokeReadonlyCommand:async()=>({ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',message:'unknown',outcome:'unconfirmed'},receiptOwner:owner})});t.after(async()=>{resolve({ok:true,value:{status:'received',canCheckAgain:false}});await f.close();});const {cookie,id}=await ready(f),started=await f.post('command',{conversationId:id,commandId:'document',parameters:{}},cookie),unknown=await terminal(f,started.body.executionId);
  assert.equal((await f.post('command/check',{conversationId:id,commandId:'document',executionId:unknown.executionId},cookie)).status,202);assert.equal(view(f).command.receiptCheck.checking,true);assert.match(view(f).activity,/核对回执/);assert.equal((await f.post('turn',{message:'blocked'},cookie)).status,409);assert.equal((await f.post('interrupt',{executionId:unknown.executionId,conversationId:id},cookie)).status,409);
  f.codex.failed('connection invalidated');assert.equal(closed,0,'nested confirmation invalidation must wait for the active inspector');resolve({ok:true,value:{status:'failed',canCheckAgain:false}});await wait(()=>!view(f).busy);assert.equal(view(f).command,null);assert.equal(closed,1);assert.equal(f.codex.turns.length,0);assert.equal(f.codex.interrupts.length,0);
});

test('receipt owner close failure blocks new work, retains ownership and supports same-owner cleanup retry',async t=>{
  let fail=true,closed=0;const owner=Object.freeze({inspect:()=>({ok:true,value:{status:'expired',canCheckAgain:false}}),close:()=>{closed++;return fail?{ok:false,error:{code:'RECEIPT_CLEANUP_PENDING'}}:{ok:true,value:{closed:true}};}});
  const f=await createModelWorkspaceFixture({profile:'model-readonly',required:false,invokeReadonlyCommand:async()=>({ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',message:'unknown',outcome:'unconfirmed'},receiptOwner:owner})});t.after(async()=>{fail=false;await f.close();});const id=view(f).session.conversation.id,started=await f.post('command',{conversationId:id,commandId:'document',parameters:{}}),unknown=await terminal(f,started.body.executionId);
  await f.post('command/check',{conversationId:id,commandId:'document',executionId:unknown.executionId});await wait(()=>!view(f).busy);assert.equal(view(f).command.status,'unknown');assert.equal((await f.status()).ready,false);assert.equal((await f.post('command',{conversationId:id,commandId:'document',parameters:{}})).status,409);
  fail=false;assert.equal((await f.post('command/check',{conversationId:id,commandId:'document',executionId:unknown.executionId})).status,202);await wait(()=>!view(f).busy);assert.equal(view(f).command.status,'failed');assert.equal((await f.status()).ready,true);assert.ok(closed>=2);
});

test('a late negative postflight receipt never rewrites a confirmed read into whole-command failure',async t=>{
  const f=await createReadCommandFixture({directory,timeout:250});t.after(()=>f.close());const {cookie,id}=await ready(f);f.hold('status',2);
  const started=await f.post('command',{conversationId:id,commandId:'selection',parameters:{}},cookie),unknown=await terminal(f,started.body.executionId);assert.equal(unknown.error.stage,'postflight');
  const request=f.queueRequests.at(-1);assert.equal(request.operation,'status');await fs.writeFile(path.join(f.queueRoot,'queue','outbox',request.id+'.json'),JSON.stringify({id:request.id,ok:false,hostSession:request.targetSession,error:{code:'WORKBENCH_REQUEST_EXPIRED',message:'late postflight expired'},execution:{started:false,phase:'validation',reason:'expired'},completedUtc:new Date().toISOString()}));
  const checked=await check(f,cookie,id,unknown);assert.equal(checked.status,'unknown');assert.equal(checked.error.stage,'postflight');assert.equal(checked.receiptCheck.status,'expired');assert.equal(checked.receiptCheck.originalError.stage,'postflight');assert.equal(checked.canInspectReceipt,false);assert.deepEqual(f.queueRequests.map(item=>item.operation),['status','get_selection','status']);assert.equal(f.codex.turns.length,0);
});

test('receipt inspection preserves authentication, confirmation, CSRF and workspace boundaries',async t=>{
  const f=await createModelWorkspaceFixture({profile:'model-readonly',invokeReadonlyCommand:async()=>{throw new Error('Must not execute');}});t.after(()=>f.close());const input={conversationId:'old',commandId:'document',executionId:'old'};
  assert.equal((await f.post('command/check',input)).status,401);const signed=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'});
  assert.equal((await f.post('command/check',input,signed.cookie)).status,403);await f.confirm(signed.cookie);
  assert.equal((await f.post('command/check',input,signed.cookie,{'X-Local-Chat':'wrong'})).status,403);assert.equal(f.codex.turns.length,0);assert.equal(f.workbenchCalls.length,0);
  for(const profile of ['source-development','customer-chat']){const other=await createModelWorkspaceFixture({profile});try{const cookie=profile==='customer-chat'?(await other.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'})).cookie:undefined;assert.equal((await other.post('command/check',input,cookie)).status,404);assert.equal(other.workbenchCalls.length,0);}finally{await other.close();}}
});

test('server shutdown waits for a pending receipt inspection and closes only its original owner',async t=>{
  let resolve,inspected=false,closed=0;const result=new Promise(done=>resolve=done),owner=Object.freeze({inspect:()=>{inspected=true;return result;},close:()=>{closed++;return {ok:true,value:{closed:true}};}});
  const f=await createModelWorkspaceFixture({profile:'model-readonly',invokeReadonlyCommand:async()=>({ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',message:'unknown',outcome:'unconfirmed'},receiptOwner:owner})});t.after(async()=>{resolve({ok:true,value:{status:'received',canCheckAgain:false}});await f.close();});const {cookie,id}=await ready(f),started=await f.post('command',{conversationId:id,commandId:'document',parameters:{}},cookie),unknown=await terminal(f,started.body.executionId);
  await f.post('command/check',{conversationId:id,commandId:'document',executionId:unknown.executionId},cookie);await wait(()=>inspected);let finished=false;const closing=f.close().then(()=>finished=true);await new Promise(done=>setImmediate(done));assert.equal(finished,false);assert.equal(closed,0);
  resolve({ok:true,value:{status:'received',canCheckAgain:false}});await closing;assert.equal(finished,true);assert.equal(closed,1);assert.equal(f.codex.turns.length,0);assert.equal(f.codex.interrupts.length,0);
});

test('a command retired before its unknown response still retains failed receipt cleanup ownership',async t=>{
  let resolve,called=false,closed=0;const result=new Promise(done=>resolve=done),owner=Object.freeze({inspect:()=>{throw new Error('Retired owner must not be inspected');},close:()=>++closed===1?{ok:false,error:{code:'RECEIPT_CLEANUP_PENDING'}}:{ok:true,value:{closed:true}}});
  const f=await createModelWorkspaceFixture({profile:'model-readonly',required:false,invokeReadonlyCommand:()=>{called=true;return result;}});t.after(async()=>{resolve({ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',outcome:'unconfirmed'},receiptOwner:owner});await f.close();});const id=view(f).session.conversation.id;
  await f.post('command',{conversationId:id,commandId:'document',parameters:{}});await wait(()=>called);f.codex.failed();resolve({ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',outcome:'unconfirmed'},receiptOwner:owner});await wait(()=>closed===1&&!view(f).busy);
  assert.equal(view(f).command,null);assert.equal((await f.status()).cleanupPending,true);await f.close();assert.equal(closed,2);assert.equal(f.codex.interrupts.length,0);
});

test('starting another command cannot erase the original cleanup retry entry',async t=>{
  let fail=true,invocations=0;const owner=Object.freeze({inspect:()=>({ok:true,value:{status:'expired',canCheckAgain:false}}),close:()=>fail?{ok:false,error:{code:'RECEIPT_CLEANUP_PENDING'}}:{ok:true,value:{closed:true}}});
  const f=await createModelWorkspaceFixture({profile:'model-readonly',required:false,invokeReadonlyCommand:async()=>{invocations++;return {ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',message:'unknown',outcome:'unconfirmed'},receiptOwner:owner};}});t.after(async()=>{fail=false;await f.close();});const id=view(f).session.conversation.id,started=await f.post('command',{conversationId:id,commandId:'document',parameters:{}}),unknown=await terminal(f,started.body.executionId);
  const rejected=await f.post('command',{conversationId:id,commandId:'levels',parameters:{}});assert.equal(rejected.status,409);assert.equal(invocations,1);assert.equal(view(f).command.executionId,unknown.executionId);assert.equal(view(f).command.canInspectReceipt,true);assert.equal(view(f).command.receiptCheck.cleanupPending,true);
  fail=false;const checked=await check(f,undefined,id,unknown);assert.equal(checked.status,'failed');assert.equal(checked.receiptCheck.status,'expired');assert.equal((await f.status()).ready,true);assert.equal(invocations,1);
});

test('research-mode connection invalidation releases orphaned receipt capabilities once',async t=>{
  let closed=0;const owner=Object.freeze({inspect:()=>{throw new Error('Retired inspection');},close:()=>{closed++;return {ok:true,value:{closed:true}};}});
  const f=await createModelWorkspaceFixture({profile:'model-readonly',required:false,invokeReadonlyCommand:async()=>({ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',outcome:'unconfirmed'},receiptOwner:owner})});t.after(()=>f.close());const id=view(f).session.conversation.id,started=await f.post('command',{conversationId:id,commandId:'document',parameters:{}});await terminal(f,started.body.executionId);
  f.codex.failed();await wait(()=>closed===1);assert.equal(view(f).command,null);await f.close();assert.equal(closed,1);
});
