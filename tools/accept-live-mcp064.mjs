// Explicit live, read-only acceptance. This file does nothing to Revit until
// invoked with an exact caller-selected document. Each business read runs once.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {MODEL_WORKSPACE_TOOLS} from '../lib/panel-tools.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const entry=path.join(root,'workbench-mcp.mjs');
const args=process.argv.slice(2),selected={};
for(let i=0;i<args.length;i++){
  if(args[i]==='--help'){
    console.log('Usage: node tools/accept-live-mcp064.mjs --expected-document <exact document.path> [--evidence-name <new-slug>]');
    process.exit(0);
  }
  const key=args[i];
  if(!['--expected-document','--evidence-name'].includes(key)||Object.hasOwn(selected,key)||i+1>=args.length)throw new Error('Use --help for the explicit live acceptance arguments.');
  selected[key]=args[++i];
}
if(!Object.hasOwn(selected,'--expected-document')||selected['--expected-document'].includes('\0')||selected['--expected-document'].length>32768)throw new Error('An exact caller-selected --expected-document is required.');
const expectedDocument=selected['--expected-document']; // Deliberately not normalized or substituted.
const evidenceName=selected['--evidence-name']??'mcp-'+new Date().toISOString().replaceAll(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
if(!/^[a-z0-9][a-z0-9-]{0,95}$/.test(evidenceName))throw new Error('Evidence name must be a new lowercase slug.');
const parent=path.join(root,'workbench','validation','20261028-live064');
for(let cursor=parent;cursor.length>=path.parse(root).root.length;cursor=path.dirname(cursor)){
  const stat=await fs.lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Evidence ancestors must be ordinary existing directories.');
  if(cursor===path.dirname(cursor))break;
}
const evidence=path.join(parent,evidenceName);
await fs.mkdir(evidence); // EEXIST is a refusal, never permission to overwrite.
const save=(name,value)=>fs.writeFile(path.join(evidence,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const started=performance.now();
const summary={schemaVersion:1,startedUtc:new Date().toISOString(),scope:'real --workspace stdio MCP; two explicitly selected readonly business calls; no retries',
  expectedDocument,evidenceDirectory:evidence,clientTransport:'bounded NDJSON stdio, matching the existing public entry and registry test',
  source:{entry,entrySha256:createHash('sha256').update(await fs.readFile(entry)).digest('hex')},
  calls:[],businessCallsAttempted:0,readOnlyBusinessToolNames:['revit_list_levels','revit_health'],completed:false,cleanup:null};
await save('00-start.json',summary);

function startPeer(){
  const child=spawn(process.execPath,[entry,'--workspace'],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const decoder=new StringDecoder('utf8'),maxFrameBytes=12*1024*1024;
  let pending='',inFlight=null,sequence=0,broken=null,exited=false,exit=null,stderrBytesDiscarded=0,otherFrames=0;
  const lateResponses=[];
  const onFailure=error=>{broken=error;if(inFlight){const owner=inFlight;inFlight=null;clearTimeout(owner.timer);owner.reject(error);}};
  const receive=text=>{
    pending+=text;
    if(Buffer.byteLength(pending,'utf8')>maxFrameBytes){pending='';onFailure(new Error('MCP response exceeded the bounded frame budget; outcome unconfirmed.'));return;}
    let newline;
    while((newline=pending.indexOf('\n'))>=0){
      const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line.trim())continue;
      let frame;try{frame=JSON.parse(line);}catch{onFailure(new Error('MCP returned invalid JSON; outcome unconfirmed.'));continue;}
      if(frame?.jsonrpc!=='2.0'){onFailure(new Error('MCP returned an invalid envelope; outcome unconfirmed.'));continue;}
      if(inFlight&&frame.id===inFlight.id){const owner=inFlight;inFlight=null;clearTimeout(owner.timer);owner.resolve(frame);}
      else{otherFrames++;if(lateResponses.length<4&&Object.hasOwn(frame,'id'))lateResponses.push(frame);}
    }
  };
  child.stdout.on('data',chunk=>receive(decoder.write(chunk)));
  child.stderr.on('data',chunk=>{stderrBytesDiscarded+=chunk.length;}); // Never retain ambient/provider diagnostics.
  child.stdin.on('error',()=>onFailure(new Error('MCP input transport failed; request outcome unconfirmed.')));
  child.once('error',()=>onFailure(new Error('Owned MCP child could not be started or its transport failed.')));
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>{receive(decoder.end());exited=true;exit={code,signal};onFailure(new Error('Owned MCP child closed before the pending result.'));resolve(exit);}));
  const request=(method,params,timeoutMs=15000)=>new Promise((resolve,reject)=>{
    if(broken||exited||inFlight){reject(broken??new Error('MCP peer is unavailable; no request was repeated.'));return;}
    const id=++sequence;
    const timer=setTimeout(()=>{if(inFlight?.id!==id)return;inFlight=null;const error=new Error('MCP response deadline exceeded; business outcome unconfirmed and not retried.');broken=error;reject(error);},timeoutMs);
    inFlight={id,resolve,reject,timer};
    try{child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,...params===undefined?{}:{params}})+'\n');}
    catch{onFailure(new Error('MCP request write outcome unconfirmed; request was not repeated.'));}
  });
  const waitForClose=ms=>new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),ms);closed.then(value=>{clearTimeout(timer);resolve(value);});});
  return {request,initializeNotification:()=>child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'),
    async close(){
      if(!exited)child.stdin.end();
      let observed=exited?exit:await waitForClose(8000),forced=false;
      if(!observed&&!exited){forced=child.kill();observed=await waitForClose(5000);}
      return {ownedChildPid:child.pid??null,method:forced?'owned-child-termination-after-stdin-eof-timeout':'stdin-eof',
        exitObserved:exited,exit:observed??exit,graceful:exited&&!forced&&exit?.code===0,forced,
        stderrBytesDiscarded,otherFrames,lateResponses,descendantCleanupClaim:'none; completed relay responses already await their own child cleanup'};
    }};
}
function resultOf(frame){
  if(frame.error)throw new Error('MCP protocol returned an error; inspect the saved original frame.');
  if(!frame.result||typeof frame.result!=='object')throw new Error('MCP returned no structured result.');
  return frame.result;
}
function requestIds(value){
  const ids=new Set();
  const visit=(item,depth=0)=>{if(!item||typeof item!=='object'||depth>16)return;for(const [key,part] of Object.entries(item)){
    if(['requestId','request_id'].includes(key)&&typeof part==='string')ids.add(part);
    else if(['requestIds','request_ids'].includes(key)&&Array.isArray(part)){for(const id of part)if(typeof id==='string')ids.add(id);}
    else if(part&&typeof part==='object')visit(part,depth+1);
  }};
  visit(value);return [...ids];
}
function nativeValue(result){
  if(result.isError!==false)throw new Error('MCP business call was not successful; inspect the saved original result without replaying it.');
  const texts=result.content?.filter(item=>item.type==='text');
  if(texts?.length!==1||typeof texts[0].text!=='string')throw new Error('MCP business response has no unambiguous native JSON value.');
  return JSON.parse(texts[0].text);
}

let peer;
try{
  const host=JSON.parse(await fs.readFile(path.join(root,'workbench','queue','host.json'),'utf8'));
  assert.equal(host.version,'0.6.4');assert.equal(host.atomicReadSnapshot,true);assert.ok(Number.isSafeInteger(host.pid)&&host.pid>0);
  summary.selectedHost={sessionId:host.sessionId,pid:host.pid,version:host.version};
  assert.equal(MODEL_WORKSPACE_TOOLS.length,37,'all six verified AEC contracts must be present before starting a live business read');
  peer=startPeer();
  const initialized=await peer.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'buildx-live064-acceptance',version:'1.0.0'}});
  await save('01-initialize.json',initialized);assert.ok(resultOf(initialized).capabilities?.tools);peer.initializeNotification();
  const catalogFrame=await peer.request('tools/list');await save('02-tools-list.json',catalogFrame);
  const catalog=resultOf(catalogFrame);assert.equal(catalog.nextCursor,undefined);assert.equal(catalog.tools?.length,37);
  const actual=new Map(catalog.tools.map(tool=>[tool.name,tool]));assert.equal(actual.size,37);
  for(const tool of MODEL_WORKSPACE_TOOLS)assert.deepEqual(actual.get(tool.name),tool,'named MCP schema/effect must match its existing owner: '+tool.name);
  summary.catalog={count:37,exactNamedContracts:true,exactReadOnlyAnnotations:true};
  let levels;
  for(const [name,parameters] of [['revit_list_levels',{expected_document:expectedDocument}],['revit_health',{}]]){
    assert.equal(actual.get(name)?.annotations?.readOnlyHint,true);
    const call={name,parameters,startedUtc:new Date().toISOString(),state:'requested',requestIds:[]};summary.calls.push(call);summary.businessCallsAttempted++;
    await save('03-'+summary.businessCallsAttempted+'-attempt.json',call);
    const t=performance.now();
    try{
      const frame=await peer.request('tools/call',{name,arguments:parameters},180000);
      call.elapsedMs=performance.now()-t;call.frame=frame;call.requestIds=requestIds(frame);
      await save('04-'+summary.businessCallsAttempted+'-response.json',call);
      const value=nativeValue(resultOf(frame));call.requestIds=[...new Set([...call.requestIds,...requestIds(value)])];
      assert.ok(call.requestIds.length>0,'the successful business response must retain its original request identity');
      if(name==='revit_list_levels'){
        assert.equal(value.operation,'list_levels');assert.equal(value.hostSession,host.sessionId);assert.equal(value.document?.path,expectedDocument);
        assert.equal(value.snapshot?.capabilities?.atomicReadSnapshot,true);assert.equal(value.snapshot.document?.modified,false);assert.ok(Array.isArray(value.value?.items));
        levels=value;call.acceptance={callerDocumentPreserved:true,atomicSnapshot:true,documentUnmodified:true,returnedLevels:value.value.items.length};
      }else{
        assert.equal(value.status,'healthy');assert.equal(value.active_document,levels.document.title);
        assert.equal(value._buildxAec?.hostSession,host.sessionId);assert.equal(value._buildxAec.pid,host.pid);assert.equal(value._buildxAec.beforeAfterMatched,true);
        assert.equal(value._buildxAec.document?.path,expectedDocument);
        call.acceptance={providerHealthy:true,sameHost:true,sameDocument:true,beforeAfterMatched:true};
      }
      call.state='verified';
    }catch(error){call.elapsedMs??=performance.now()-t;call.state='unconfirmed-or-failed';throw error;}
  }
  summary.completed=true;
}catch(error){summary.error={name:error.name,message:error.message};process.exitCode=1;}
finally{
  if(peer){summary.cleanup=await peer.close();if(!summary.cleanup.graceful){summary.completed=false;process.exitCode=1;}}
  summary.elapsedMs=performance.now()-started;summary.finishedUtc=new Date().toISOString();
  await save('summary.json',summary);
  console.log(JSON.stringify({evidenceDirectory:evidence,completed:summary.completed,businessCallsAttempted:summary.businessCallsAttempted,
    calls:summary.calls.map(call=>({name:call.name,state:call.state,elapsedMs:call.elapsedMs,requestIds:call.requestIds})),cleanupGraceful:summary.cleanup?.graceful??null}));
}
