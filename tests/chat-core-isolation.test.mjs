import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

const root=path.resolve(fileURLToPath(new URL("../", import.meta.url)));
// Keep the copied dependency list explicit so unexpected imports fail in the child.
const modules=Object.freeze([
  'lib/access-lock-recovery.mjs',
  'lib/access-policy.mjs',
  'lib/batch-filter-preview.mjs',
  'lib/buildx-paths.mjs',
  'lib/cad-candidates.mjs',
  'lib/cad-document-path.mjs',
  'lib/cad-inventory.mjs',
  'lib/cad-tools.mjs',
  'lib/chat-context.mjs',
  'lib/chat-session.mjs',
  'lib/codex-client-core.mjs',
  'lib/codex-confirmation.mjs',
  'lib/command-save-receipt.mjs',
  'lib/command-sequence.mjs',
  'lib/command-store.mjs',
  'lib/confirmed-write-profile.mjs',
  'lib/family-tools.mjs',
  'lib/generated-file-diagnostic.mjs',
  'lib/local-chat-tools.mjs',
  'lib/local-image-generation.mjs',
  'lib/local-runtimes.mjs',
  'lib/model-operation-contracts.mjs',
  'lib/model-operation-effects.mjs',
  'lib/model-permission-owner.mjs',
  'lib/modelling-tools.mjs',
  'lib/native-chat-image.mjs',
  'lib/native-model-queries.mjs',
  'lib/native-parameter-queries.mjs',
  'lib/native-parameter-writes.mjs',
  'lib/native-schematic-tools.mjs',
  'lib/native-snapshot-delta.mjs',
  'lib/native-type-parameter-writes.mjs',
  'lib/panel-accounts.mjs',
  'lib/panel-audit.mjs',
  'lib/panel-chat-format.mjs',
  'lib/panel-server-core.mjs',
  'lib/panel-tools.mjs',
  'lib/parameter-write-result.mjs',
  'lib/project-instance-binding-preview.mjs',
  'lib/type-parameter-write-approval.mjs',
  'lib/visual-artifact-owner.mjs',
  'lib/visual-inspection-recovery.mjs',
  'lib/visual-inspection-tools.mjs',
  'lib/workbench-client.mjs',
  'lib/workbench-contracts.mjs',
  'lib/workbench-receipt.mjs',
  'public/command-parameter-options.mjs',
]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// This is a real module resolver boundary, not a source-text dependency scan.
// The fixture never constructs/starts the real Codex client or reads its config.
const fixture=String.raw`
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {registerHooks,isBuiltin} from 'node:module';

const root=path.dirname(fileURLToPath(import.meta.url));
const names=JSON.parse(process.argv[2]);
const permitted=new Set(names.map(name=>pathToFileURL(path.join(root,name)).href));
const resolved=[],denied=[];
registerHooks({resolve(specifier,context,nextResolve){
  const result=nextResolve(specifier,context);
  if(isBuiltin(result.url)||result.url.startsWith('node:')){resolved.push(result.url);return result;}
  if(!permitted.has(result.url)){
    denied.push(result.url);const error=new Error('Fixture import is outside the declared core');error.code='CORE_IMPORT_SCOPE';throw error;
  }
  resolved.push(result.url);return result;
}});
const {CodexClientCore}=await import('./lib/codex-client-core.mjs');
const {createPanelServerCore}=await import('./lib/panel-server-core.mjs');
assert.equal(typeof CodexClientCore,'function');
assert.equal(typeof createPanelServerCore,'function');
await assert.rejects(import('./lib/panel-profile.mjs'),{code:'ERR_MODULE_NOT_FOUND'});
await assert.rejects(import('./forbidden.mjs'),{code:'CORE_IMPORT_SCOPE'});
await assert.rejects(fs.stat(path.join(root,'forbidden-ran')),{code:'ENOENT'});
for(const directory of ['lib','public']){
  const copied=(await fs.readdir(path.join(root,directory))).map(name=>directory+'/'+name);
  assert.deepEqual(copied.sort(),names.filter(name=>name.startsWith(directory+'/')).sort());
}
for(const wrapper of ['panel-server.mjs','codex-client.mjs','panel-profile.mjs','codex-profile.mjs','model-command-catalog.mjs','source-tools.mjs'])await assert.rejects(fs.stat(path.join(root,'lib',wrapper)),{code:'ENOENT'});

class FakeCodex extends EventEmitter{
  constructor(){super();this.state={service:'isolated-fixture',ready:true,error:false,message:'fixture ready',mode:'source-development',toolCount:0,connectionGeneration:1};this.starts=0;this.closes=0;this.turns=[];this.threads=0;}
  async start(){this.starts++;this.emit('state',this.state);}
  failed(message){this.state={...this.state,ready:false,error:true,message};this.emit('state',this.state);}
  async newThread(){return 'isolated-thread-'+(++this.threads);}
  async turn(threadId,text){const turn={threadId,text,turnId:'isolated-turn-'+(this.turns.length+1)};this.turns.push(turn);return {turn:{id:turn.turnId}};}
  async interrupt(){throw new Error('No interrupt expected in a completed dialogue');}
  async close(){this.closes++;this.failed('fixture closed');return {closed:true};}
  notify(method,turn,rest){this.emit('notification',method,{threadId:turn.threadId,turnId:turn.turnId,...rest});}
}
const selection=Object.freeze({workspace:Object.freeze({kind:'source-development',supportsModelContext:false}),catalog:Object.freeze([]),cancelMessage:'fixture cancelling',interruptUnconfirmed:'fixture interrupt unconfirmed',interruptTimeout:'fixture interrupt timeout',stopUnknown:'fixture stop unknown'});
const codex=new FakeCodex();let workbenchCalls=0;
const app=createPanelServerCore({root,codex,selection,port:0,invokeWorkbench:async()=>{workbenchCalls++;throw new Error('Unexpected model operation');}});
let stream,reader,buffer='',sseBytes=0,sseFrames=0,streamEnded=false,closeResult;
const controller=new AbortController();
try{
  const {origin}=await app.listen();await app.connect();
  const statusResponse=await fetch(origin+'/api/status',{signal:AbortSignal.timeout(3000)});assert.equal(statusResponse.status,200);
  const status=await statusResponse.json();
  assert.deepEqual(status.toolCatalog,[]);assert.equal(status.toolCount,0);assert.equal(status.workspace.kind,'source-development');assert.equal(status.workspace.supportsModelContext,false);assert.equal(status.ready,true);assert.equal(status.account.required,false);
  const post=async(route,input={})=>{
    const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':status.csrf,Origin:origin},body:JSON.stringify({client:'core-isolation',...input}),signal:AbortSignal.timeout(3000)});
    return {status:response.status,body:await response.json()};
  };
  stream=await fetch(origin+'/api/events?client=core-isolation',{signal:controller.signal});assert.equal(stream.status,200);assert.match(stream.headers.get('content-type'),/text\/event-stream/);reader=stream.body.getReader();
  const nextEvent=async()=>{
    while(true){
      const end=buffer.indexOf('\n\n');
      if(end>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!block.startsWith('event: '))continue;sseFrames++;assert.ok(sseFrames<=32);return {event:block.slice(7,block.indexOf('\n')),data:JSON.parse(block.slice(block.indexOf('data: ')+6))};}
      const result=await reader.read();if(result.done){streamEnded=true;throw new Error('SSE ended before expected event');}
      sseBytes+=result.value.byteLength;assert.ok(sseBytes<=128*1024);buffer+=new TextDecoder().decode(result.value);
    }
  };
  const initial=await nextEvent();assert.equal(initial.event,'snapshot');assert.equal(initial.data.workspace.supportsModelContext,false);assert.deepEqual(initial.data.session.messages,[]);
  assert.equal((await post('context',{includeDocument:true,includeSelection:true})).status,403);
  assert.equal((await post('turn',{message:'forbidden model context',context:{includeDocument:true}})).status,403);assert.equal(codex.turns.length,0);
  assert.equal((await post('turn',{message:'isolation dialogue'})).status,202);assert.equal(codex.turns.length,1);
  const turn=codex.turns[0];assert.equal(turn.text,'isolation dialogue');
  codex.notify('item/agentMessage/delta',turn,{itemId:'isolated-answer',delta:'isolated reply'});
  codex.notify('item/completed',turn,{item:{id:'isolated-answer',type:'agentMessage',text:'isolated reply'}});
  codex.notify('turn/completed',turn,{turn:{id:turn.turnId,status:'completed'}});
  let finalConversation,terminal;
  while(!terminal){const event=await nextEvent();if(event.event==='conversation')finalConversation=event.data;if(event.event==='done')terminal=event.data;}
  assert.equal(terminal.status,'completed');assert.equal(finalConversation.busy,false);assert.deepEqual(finalConversation.session.messages.map(message=>message.text),['isolation dialogue','isolated reply']);assert.deepEqual(finalConversation.session.context.document,null);assert.deepEqual(finalConversation.session.context.selection,null);assert.equal(workbenchCalls,0);
  const stopping=await post('stop-service');assert.equal(stopping.status,202);assert.equal(stopping.body.ok,true);assert.equal(typeof stopping.body.cleanupId,'string');
  closeResult=await app.close();assert.deepEqual(closeResult,{closed:true});assert.equal(codex.closes,1);assert.equal(app.server.listening,false);
  while(!streamEnded){const result=await reader.read();if(result.done)streamEnded=true;else{sseBytes+=result.value.byteLength;assert.ok(sseBytes<=128*1024);}}
  await assert.rejects(fetch(origin+'/api/status',{signal:AbortSignal.timeout(1000)}));
  const actual=[...new Set(resolved.filter(url=>url.startsWith('file:')))];
  assert.deepEqual(actual.sort(),[...permitted].sort());assert.equal(denied.length,1);
  await fs.writeFile(path.join(root,'import-trace.json'),JSON.stringify({resolved,denied},null,2));
  console.log(JSON.stringify({ok:true,productionModules:actual.length,coreClientImported:true,realCodexConstructed:false,statusEmptyCatalog:true,modelContextRejected:true,httpTurnAccepted:true,sseTerminal:terminal.status,canonicalMessages:finalConversation.session.messages.length,workbenchCalls,starts:codex.starts,closeResult,codexCloseCalls:codex.closes,serverListening:app.server.listening,sseEnded:streamEnded,sseBytes,sseFrames,missingResearchRejected:true,existingForeignModuleDenied:true,foreignModuleExecuted:false}));
}finally{
  if(reader){if(!streamEnded)controller.abort();try{await reader.cancel();}catch{}reader.releaseLock();}
  if(!closeResult)await app.close();
}
`;

async function runChild(temp){
  const child=spawn(process.execPath,[path.join(temp,'runner.mjs'),JSON.stringify(modules)],{cwd:temp,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const record={pid:null,closeObserved:false,exitCode:null,signal:null,terminationRequested:false,spawnError:null};
  let stdout='',stderr='',problem=null;
  const stop=error=>{problem??=error;if(!record.closeObserved){record.terminationRequested=true;child.kill();}};
  const deadline=setTimeout(()=>stop(new Error('Isolated child exceeded 15-second fixture deadline')),15000);
  child.on('spawn',()=>{record.pid=child.pid;});
  child.stdout.on('data',chunk=>{if(Buffer.byteLength(stdout)+chunk.length>256*1024)stop(new Error('Fixture stdout budget exceeded'));else stdout+=chunk.toString('utf8');});
  child.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr)+chunk.length>16*1024)stop(new Error('Fixture stderr budget exceeded'));else stderr+=chunk.toString('utf8');});
  child.on('error',error=>{record.spawnError=error.code||error.name;problem??=error;});
  const closed=await new Promise(resolve=>child.once('close',(code,signal)=>{clearTimeout(deadline);record.closeObserved=true;record.exitCode=code;record.signal=signal;resolve(true);}));
  assert.equal(closed,true);return {record,stdout,stderr,problem};
}

test('copied chat cores run HTTP/SSE and confirmed cleanup with only declared production dependencies',{timeout:20000},async()=>{
  const evidence=path.join(root,'workbench','validation','20261025-chat-core','isolation-'+new Date().toISOString().replace(/[:.]/g,'')+'-'+randomUUID().slice(0,8));
  await fs.mkdir(evidence,{recursive:true});
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-chat-core-'));
  const tempReal=await fs.realpath(temp),hashes=[];let execution=null,removed=false;
  try{
    for(const name of modules){
      const target=path.join(temp,name),bytes=await fs.readFile(path.join(root,name));
      await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.writeFile(target,bytes);
      hashes.push({module:name,sha256:hash(bytes),byteLength:bytes.byteLength});
    }
    await fs.writeFile(path.join(temp,'runner.mjs'),fixture);
    await fs.writeFile(path.join(temp,'forbidden.mjs'),"import fs from 'node:fs/promises'; await fs.writeFile(new URL('./forbidden-ran',import.meta.url),'unexpected');");
    execution=await runChild(temp);
    await fs.writeFile(path.join(evidence,'child-stderr.txt'),execution.stderr);
    assert.equal(execution.record.closeObserved,true);assert.equal(execution.problem,null,execution.problem?.message);assert.equal(execution.record.exitCode,0,execution.stderr);assert.equal(execution.record.signal,null);assert.equal(execution.record.terminationRequested,false);
    const result=JSON.parse(execution.stdout.trim());assert.equal(result.ok,true);assert.equal(result.productionModules,modules.length);assert.deepEqual(result.closeResult,{closed:true});
    await fs.copyFile(path.join(temp,'import-trace.json'),path.join(evidence,'import-trace.json'));
    await fs.writeFile(path.join(evidence,'workflow-result.json'),JSON.stringify(result,null,2)+'\n');
  }finally{
    // Never release a directory while an unconfirmed child may still own it.
    if(!execution||execution.record.closeObserved){
      assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.ok(path.basename(temp).startsWith('buildx-chat-core-'));assert.equal(await fs.realpath(temp),tempReal);
      await fs.rm(temp,{recursive:true});await assert.rejects(fs.stat(temp),{code:'ENOENT'});removed=true;
    }
    await fs.writeFile(path.join(evidence,'isolation-summary.json'),JSON.stringify({recordedAt:new Date().toISOString(),fixture:'isolated-copy-real-node-http-sse',productionModules:hashes,child:execution?.record||null,tempRemoved:removed,tempRetained:removed?null:temp,realCodexOrCloudOrRevit:false,measurements:{tokens:null,cpu:null,peakProcessFamilyMemory:null},limitation:'FakeCodex checks composition/HTTP/SSE/lifecycle only; no actual Codex, account, cloud, Revit or customer acceptance.'},null,2)+'\n');
  }
});
