import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {CodexClient} from './lib/codex-client.mjs';
import {createModelWorkspaceFixture} from './test-support/model-workspace-preview.mjs';
import {invokeWorkbench} from './lib/workbench-client.mjs';
import {createPanelAudit,sanitizePanelAudit} from './lib/panel-audit.mjs';
const directory=fileURLToPath(new URL('./workbench/validation/20261027-phase-timing/',import.meta.url));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const wait=async fn=>{for(let i=0;i<300;i++){if(await fn())return;await pause(10);}throw new Error('Timing fixture deadline');};
const phases=f=>f.audits.filter(row=>row.file==='phase-timing.jsonl').map(row=>row.data);
async function saveTrace(label,rows){await fs.mkdir(directory,{recursive:true});const folder=await fs.mkdtemp(path.join(directory,'trace-'+label+'-'));await fs.writeFile(path.join(folder,'phase-timing.jsonl'),rows.map(row=>sanitizePanelAudit('phase-timing.jsonl',row)).filter(Boolean).map(row=>JSON.stringify(row)).join('\n')+'\n');}

test('original RPC owner records queue/write/ACK separately, timeout never retries and diagnostics omit bodies',async()=>{
  const client=new CodexClient(process.cwd()),records=[],writes=[];
  client.child={stdin:{write:line=>writes.push(JSON.parse(line))}};client.on('diagnostic',data=>records.push(data));
  const promised=client.request('turn/start',{threadId:'thread-original',input:[{text:'PRIVATE-PROMPT'}]},200),request=writes[0];await pause(15);client.dispatch({id:request.id,result:{turn:{id:'turn-original'},private:'PRIVATE-OUTPUT'}});assert.equal((await promised).turn.id,'turn-original');
  const rows=records.filter(row=>row.rpcId===request.id);assert.deepEqual(rows.map(row=>row.phase),['rpc_queued','rpc_write_attempted','rpc_acknowledged']);assert.ok(rows.at(-1).elapsedMs>=10);assert.equal(rows.at(-1).turnId,'turn-original');assert.equal(rows.at(-1).threadId,'thread-original');
  await assert.rejects(client.request('turn/interrupt',{threadId:'thread-original',turnId:'turn-original'},15),/超时/);assert.equal(writes.length,2);assert.equal(records.at(-1).phase,'rpc_timeout');assert.equal(client.pending.size,0);assert.equal(JSON.stringify(records).includes('PRIVATE'),false);
  await saveTrace('rpc-ack-timeout',records);
  client.child=null;
});

test('the actual stdin backlog has its own duration and never counts queued time as ACK time',async()=>{
  const client=new CodexClient(process.cwd()),records=[],writes=[],pipe=new EventEmitter();pipe.writable=true;pipe.write=(line,callback)=>{writes.push(JSON.parse(line));queueMicrotask(()=>callback?.());return true;};
  const c={child:{stdin:pipe},generation:1,phase:'ready',fault:null,closed:false,queue:[],queuedBytes:0,writes:new Set(),writeBytes:0,blocked:true,pumping:false};client.child=c.child;client._connection=c;client.on('diagnostic',row=>records.push(row));
  const pending=client.request('turn/start',{threadId:'queued-thread'},200);assert.equal(writes.length,0);await pause(20);c.blocked=false;client._pump(c);client.dispatch({id:writes[0].id,result:{turn:{id:'queued-turn'}}},c);await pending;
  const attempt=records.find(row=>row.phase==='rpc_write_attempted'),ack=records.find(row=>row.phase==='rpc_acknowledged');assert.ok(attempt.elapsedMs>=15);assert.ok(ack.elapsedMs>=attempt.elapsedMs);assert.ok(ack.sinceWriteMs<ack.elapsedMs);assert.equal(records.filter(row=>row.phase==='rpc_queued').length,1);
  await saveTrace('rpc-backlog',records);
  client.child=null;client._connection=null;
});

test('panel timings distinguish acceptance, first visible text, tool wait and terminal without changing chat',async t=>{
  const f=await createModelWorkspaceFixture({profile:'model-readonly',required:false});t.after(()=>f.close());const response=await f.post('turn',{message:'PRIVATE-INPUT',context:{includeDocument:false,includeSelection:false}});assert.equal(response.status,202);
  const turn=f.codex.turns[0];f.codex.emit('notification','item/agentMessage/delta',{threadId:turn.threadId,turnId:'wrong-turn',itemId:'bad',delta:'not-owned'});assert.equal(phases(f).some(row=>row.phase==='first_text_received'),false);
  await pause(15);f.codex.notify('item/started',turn,{item:{id:'tool-owned',type:'mcpToolCall',tool:'revit_workbench_status',arguments:{private:'PRIVATE-ARG'}}});await pause(20);f.codex.notify('item/completed',turn,{item:{id:'tool-owned',type:'mcpToolCall',tool:'revit_workbench_status',status:'completed',result:{private:'PRIVATE-RESULT'}}});f.codex.finish(0,'completed','PRIVATE-ANSWER');
  const rows=phases(f),first=rows.find(row=>row.phase==='first_text_received'),tool=rows.find(row=>row.phase==='tool_completed');assert.ok(rows.find(row=>row.phase==='native_acknowledged'));assert.ok(first.sinceNativeRequestMs>=25);assert.ok(tool.durationMs>=15);assert.equal(first.threadId,turn.threadId);assert.equal(first.turnId,turn.turnId);assert.equal(rows.at(-1).phase,'turn_finished');assert.equal(JSON.stringify(rows).includes('PRIVATE'),false);assert.equal(f.app.snapshot('model-test-client').session.messages.at(-1).text,'PRIVATE-ANSWER');assert.equal(f.codex.turns.length,1);
  await saveTrace('panel-tool-and-text',rows);
});

test('early notifications use their original arrival time after the exact ACK binds; foreign early turns are ignored',async t=>{
  const f=await createModelWorkspaceFixture({profile:'model-readonly',required:false});t.after(()=>f.close());let resolve;
  const original=f.codex.turn.bind(f.codex);f.codex.turn=async(...args)=>{const value=await original(...args),turn=f.codex.turns[0];f.codex.emit('notification','item/agentMessage/delta',{threadId:turn.threadId,turnId:'foreign-early',itemId:'foreign',delta:'PRIVATE-FOREIGN'});f.codex.notify('item/agentMessage/delta',turn,{itemId:'answer-early',delta:'hello'});await new Promise(done=>resolve=done);return value;};
  const pending=f.post('turn',{message:'hello'});await wait(()=>resolve);await pause(30);resolve();assert.equal((await pending).status,202);
  const rows=phases(f),first=rows.find(row=>row.phase==='first_text_received'),ack=rows.find(row=>row.phase==='native_acknowledged'),ready=rows.find(row=>row.phase==='first_text_ready_for_sse');assert.ok(first);assert.equal(first.turnId,f.codex.turns[0].turnId);assert.ok(first.elapsedMs<ack.elapsedMs);assert.ok(ready.elapsedMs>=ack.elapsedMs);assert.equal(rows.filter(row=>row.phase==='first_text_received').length,1);f.codex.finish(0,'completed','hello');
  await saveTrace('early-text-buffer',phases(f));
});

async function nativeFixture(){await fs.mkdir(directory,{recursive:true});const root=await fs.mkdtemp(path.join(directory,'transport-')),queue=path.join(root,'queue');for(const folder of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,folder),{recursive:true});const session='a'.repeat(32);await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version:'0.6.3'}));return {root,queue,session};}
const timing=(id,session)=>{const utc=new Date().toISOString();return {schemaVersion:1,requestId:id,hostSession:session,observedUtc:utc,raiseReturnedUtc:utc,executeEnteredUtc:utc,claimedUtc:utc,dispatchStartedUtc:utc,dispatchFinishedUtc:utc,responsePreparedUtc:utc,observedToExecuteMs:40,validationMs:2,dispatchMs:3,hostWorkMs:6,schedulerCorrelation:'matched',raiseResult:'Accepted'};};

test('production native transport records published and receipt stages, validates optional timing without changing results',async()=>{
  for(const mode of ['valid','legacy','foreign','contradiction','negative']){const f=await nativeFixture(),records=[];const pending=invokeWorkbench('revit_workbench_status',{}, {root:f.root,timeout:500,onTiming:data=>records.push(data)});let name;await wait(async()=>{name=(await fs.readdir(path.join(f.queue,'inbox'))).find(name=>name.endsWith('.json'));return name;});const id=path.basename(name,'.json'),value={hostSession:f.session,document:null};let response={id,ok:true,result:value};if(mode!=='legacy')response.timing=timing(id,f.session);if(mode==='foreign')response.timing.requestId='foreign';if(mode==='contradiction')response.timing.hostWorkMs=0;if(mode==='negative')response={id,ok:false,hostSession:f.session,error:{code:'WORKBENCH_REQUEST_EXPIRED',message:'expired'},execution:{started:false,phase:'validation',reason:'expired'},completedUtc:new Date().toISOString(),timing:{...timing(id,f.session),dispatchStartedUtc:null,dispatchFinishedUtc:null,dispatchMs:null}};await fs.writeFile(path.join(f.queue,'outbox',name),JSON.stringify(response));
    if(mode==='negative')await assert.rejects(pending,/EXPIRED/);else assert.deepEqual(await pending,{...value,request_id:id});
    assert.ok(records.find(row=>row.phase==='published'));const received=records.find(row=>row.phase==='receipt_received');assert.equal(received.hostTimingState,mode==='legacy'?'unavailable':['foreign','contradiction'].includes(mode)?'invalid':'valid');assert.equal(records.at(-1).phase,'transport_finished');assert.equal(records.at(-1).outcome,mode==='negative'?'expired':'received');assert.equal(records.at(-1).requestId,id);assert.equal((await fs.readdir(path.join(f.queue,'inbox'))).length,1);
    await saveTrace('native-'+mode,records);
  }
});

test('native timeout has one terminal unknown record and no replay; failing diagnostic observers do not change success',async()=>{
  const f=await nativeFixture(),records=[];await assert.rejects(invokeWorkbench('revit_workbench_status',{}, {root:f.root,timeout:20,onTiming:data=>records.push(data)}),/timeout/);assert.equal(records.at(-1).outcome,'unconfirmed');assert.equal((await fs.readdir(path.join(f.queue,'inbox'))).filter(name=>name.endsWith('.json')).length,1);
  const ok=await nativeFixture(),pending=invokeWorkbench('revit_workbench_status',{}, {root:ok.root,timeout:500,onTiming:()=>{throw new Error('controlled observer failure');}});let name;await wait(async()=>{name=(await fs.readdir(path.join(ok.queue,'inbox'))).find(name=>name.endsWith('.json'));return name;});const id=path.basename(name,'.json');await fs.writeFile(path.join(ok.queue,'outbox',name),JSON.stringify({id,ok:true,result:{hostSession:ok.session,document:null}}));assert.equal((await pending).request_id,id);
});

test('phase journal uses the existing bounded audit owner, omits raw content and preserves existing evidence',async()=>{
  const root=await fs.mkdtemp(path.join(directory,'audit-')),before=path.join(root,'tool-calls.jsonl');await fs.writeFile(before,'original\n');const audit=createPanelAudit(root);assert.equal((await audit.ready()).ok,true);
  audit.audit('phase-timing.jsonl',{code:'phase_timing',source:'panel',phase:'first_text_received',elapsedMs:12,conversationId:'chat-1',observedUtc:new Date().toISOString(),prompt:'PRIVATE-PROMPT',text:'PRIVATE-ANSWER'},true);await audit.flush();const saved=await fs.readFile(path.join(root,'phase-timing.jsonl'),'utf8');assert.equal(saved.includes('PRIVATE'),false);assert.equal(JSON.parse(saved).elapsedMs,12);assert.equal(await fs.readFile(before,'utf8'),'original\n');assert.equal(sanitizePanelAudit('phase-timing.jsonl',{code:'phase_timing',source:'panel',phase:'arbitrary',text:'PRIVATE'}),null);assert.equal((await audit.close()).value.closed,true);
});

test('MCP timing metadata reaches only the exact accepted tool owner and never enters chat references or content',async t=>{
  const f=await createModelWorkspaceFixture({profile:'model-readonly',required:false});t.after(()=>f.close());await f.post('turn',{message:'hello'});const turn=f.codex.turns[0],requestId='12345678-1234-4234-8234-123456789012',event={code:'phase_timing',source:'workbench',phase:'receipt_received',elapsedMs:35,requestId,hostSession:'a'.repeat(32),hostTimingState:'valid',hostValidationMs:1,hostDispatchMs:2,hostWorkMs:3};
  const item={id:'native-read',type:'mcpToolCall',tool:'revit_workbench_status',status:'completed',result:{content:[{type:'text',text:'unchanged-result'}],_meta:{'buildx/phaseTiming':{schemaVersion:1,events:[event]}}}};
  f.codex.emit('notification','item/completed',{threadId:turn.threadId,turnId:'foreign',item});assert.equal(phases(f).some(row=>row.source==='workbench'),false);f.codex.notify('item/completed',turn,{item});const received=phases(f).find(row=>row.source==='workbench');assert.equal(received.requestId,requestId);assert.equal(received.turnId,turn.turnId);assert.equal(received.itemId,item.id);assert.equal(received.elapsedMs,35);
  const saved=f.app.snapshot('model-test-client').session;assert.equal(JSON.stringify(saved).includes('buildx/phaseTiming'),false);assert.equal(JSON.stringify(saved).includes(requestId),false);assert.ok(JSON.stringify(saved).includes('unchanged-result'));
  for(const events of [[{...event,requestId:'foreign'}],[event,{...event,elapsedMs:1}],[{...event,phase:'turn_finished'}]])f.codex.notify('item/completed',turn,{item:{...item,id:'rejected-'+events.length,result:{content:[],_meta:{'buildx/phaseTiming':{schemaVersion:1,events}}}}});assert.equal(phases(f).filter(row=>row.source==='workbench').length,1);f.codex.finish(0,'completed','done');
  await saveTrace('mcp-metadata-to-panel',phases(f));
});
