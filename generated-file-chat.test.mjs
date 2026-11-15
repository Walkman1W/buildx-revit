import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createPanelServer} from './lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {createGeneratedFileApproval} from './lib/generated-file-approval.mjs';
import {createGeneratedFileOwner} from './lib/generated-file-owner.mjs';
import {createGeneratedFileTransport} from './lib/generated-file-transport.mjs';

const program=fileURLToPath(new URL('.',import.meta.url));
const sessionId='b'.repeat(32);
const parameters=Object.freeze({file_name:'端吸泵',width_mm:600,depth_mm:1200,height_mm:700,inlet_diameter_mm:100,outlet_diameter_mm:80,system:'hydronic_supply'});
const sha=value=>createHash('sha256').update(value).digest('hex');

class CodexPeer extends EventEmitter{
  profile=createCodexSessionProfile(program,{profile:MODEL_WORKSPACE_SESSION_PROFILE,generatedFiles:true});
  state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};
  answers=[];
  async newThread(){return 'local-thread';}
  async turn(){this.request(1);return {turn:{id:'local-turn'}};}
  async close(){return {closed:true};}
  request(id){
    const params=Object.freeze({threadId:'local-thread',turnId:'local-turn',callId:'call-'+id,tool:'buildx_generate_file',arguments:Object.freeze({format:'rfa',parameters})});
    this.emit('dynamic-tool-request',{id,params,generation:1,revision:2,respond:value=>{this.answers.push(value);return true;},reject(){},discard(){}});
  }
}

async function waitFor(read){
  for(let i=0;i<120;i++){
    const value=await read();if(value)return value;
    await delay(20);
  }
  throw new Error('Expected local fixture transition did not occur');
}

async function fixture(t,{timeoutMs=1600}={}){
  const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-generated-chat-'));
  const workbenchRoot=path.join(dataRoot,'workbench'),queue=path.join(workbenchRoot,'queue');
  for(const dir of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,dir),{recursive:true});
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId,pid:process.pid,startedUtc:new Date().toISOString(),pumpFamilyArtifactVersion:1}));
  const codex=new CodexPeer();
  const owner=createGeneratedFileOwner({dataRoot});
  const transport=createGeneratedFileTransport({workbenchRoot,timeoutMs,pollMs:15});
  const approval=createGeneratedFileApproval({owner,transport});
  const app=createPanelServer({root:program,dataRoot,port:0,codex,profile:MODEL_WORKSPACE_SESSION_PROFILE,
    confirmedWrite:true,invokeWorkbench:async()=>{throw new Error('Independent file generation should not query active project');},
    generatedFileOwner:owner,generatedFileTransport:transport,dynamicApprovalOwner:approval});
  const {origin}=await app.listen(),{csrf}=await (await fetch(origin+'/api/status')).json();
  t.after(async()=>{await app.close();await fs.rm(dataRoot,{recursive:true,force:true});});
  const post=async(route,payload,requestOrigin=origin)=>{
    const response=await fetch(`${origin}/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':csrf,...requestOrigin?{Origin:requestOrigin}:{}},body:JSON.stringify({client:'browser',...payload})});
    return {status:response.status,body:await response.json()};
  };
  const queueFiles=async()=> (await fs.readdir(path.join(queue,'inbox'))).filter(name=>name.endsWith('.json'));
  async function claim(operation='create_pump_family_artifact',args=parameters){
    const queued=await waitFor(async()=> (await queueFiles())[0]);
    const source=path.join(queue,'inbox',queued),destination=path.join(queue,'processing',queued);
    await fs.rename(source,destination);
    const wire=await fs.readFile(destination),request=JSON.parse(wire);
    assert.equal(request.targetSession,sessionId);
    assert.equal(request.operation,operation);
    assert.deepEqual(request.args,args);
    const permitName=path.join(queue,'pump-approvals',queued);
    const permit=JSON.parse(await fs.readFile(permitName));
    assert.deepEqual(permit,{schema_version:1,request_id:request.id,target_session:sessionId,request_sha256:sha(wire)});
    await fs.rename(permitName,permitName.replace(/\.json$/,'.used'));
    return request;
  }
  async function acknowledgeOpen(request){
    const result={id:request.id,ok:true,result:{operation:request.operation,hostSession:sessionId,value:{success:true,opened:true}}};
    await fs.writeFile(path.join(queue,'outbox',request.id+'.json'),JSON.stringify(result));
  }
  async function complete(request){
    const fileName=parameters.file_name+'-'+request.id.replaceAll('-','')+'.rfa';
    const contents=Buffer.from('Controlled fixture payload, never intended to open in Revit.');
    await fs.mkdir(owner.outputDirectory,{recursive:true});
    await fs.writeFile(path.join(owner.outputDirectory,fileName),contents);
    const result={id:request.id,ok:true,result:{operation:request.operation,hostSession:sessionId,value:{success:true,file_name:fileName,sha256:sha(contents),bytes:contents.length,reopened:true}}};
    await fs.writeFile(path.join(queue,'outbox',request.id+'.json'),JSON.stringify(result));
    return fileName;
  }
  async function fail(request,value){
    const result={id:request.id,ok:true,result:{operation:request.operation,hostSession:sessionId,value:{success:false,code:'PUMP_BUILD_FAILED',...value}}};
    await fs.writeFile(path.join(queue,'outbox',request.id+'.json'),JSON.stringify(result));
  }
  const preview=()=>app.snapshot('browser').dynamicApproval;
  const approve=(p,decision='accept')=>post('dynamic-approval',{requestId:p.id,conversationId:p.conversationId,digest:p.digest,decision});
  assert.equal((await post('turn',{message:'制作水泵族'})).status,202);
  return {app,codex,post,approve,preview,queueFiles,claim,complete,fail,acknowledgeOpen,owner};
}

test('one approved chat request publishes a bound permit and opens a verified file',async t=>{
  const f=await fixture(t),first=f.preview();
  assert.equal(first.kind,'file');
  assert.equal(first.cwd,f.owner.outputDirectory);
  assert.deepEqual(await f.queueFiles(),[]);
  assert.equal((await f.approve(first,'decline')).status,200);
  await waitFor(()=>f.codex.answers[0]);
  assert.deepEqual(await f.queueFiles(),[]);
  f.codex.request(2);
  const preview=f.preview();
  assert.equal((await f.approve(preview)).status,200);
  assert.equal((await f.approve(preview)).status,409);
  const request=await f.claim(),fileName=await f.complete(request);
  assert.equal(preview.target,fileName);
  const [generated]=await waitFor(()=>{const files=f.app.snapshot('browser').generatedFiles;return files?.length?files:null;});
  assert.equal(generated.artifactId,request.id);
  assert.deepEqual(f.app.snapshot('other').generatedFiles,[]);
  const payload={artifactId:request.id,conversationId:preview.conversationId};
  assert.equal((await f.post('chat-artifact/open',payload,null)).status,403);
  assert.equal((await f.post('chat-artifact/open',{...payload,path:'foreign.rfa'})).status,400);
  assert.equal((await f.post('chat-artifact/open',{...payload,client:'other'})).status,409);
  const opened=f.post('chat-artifact/open',payload);
  await f.acknowledgeOpen(await f.claim('open_pump_family_artifact',{file_name:fileName,sha256:generated.sha256,bytes:generated.bytes}));
  assert.equal((await opened).status,200);
});

test('late success is recovered from the original receipt without another queue request',async t=>{
  const f=await fixture(t,{timeoutMs:650}),preview=f.preview();
  assert.equal((await f.approve(preview)).status,200);
  const request=await f.claim();
  const pending=await waitFor(()=>f.app.snapshot('browser').generatedFilePending?.[0]);
  assert.equal(pending.artifactId,request.id);
  const payload={artifactId:request.id,conversationId:preview.conversationId};
  assert.equal((await f.post('chat-artifact/open',payload)).status,404);
  await f.complete(request);
  assert.deepEqual((await f.post('chat-artifact/check',payload)).body,{ok:true,status:'completed'});
  const view=f.app.snapshot('browser');
  assert.equal(view.generatedFiles[0].artifactId,request.id);
  assert.deepEqual(view.generatedFilePending,[]);
  assert.deepEqual(await f.queueFiles(),[]);
});

test('the failed pump request keeps its original ID and exposes only verified diagnostic fields',async t=>{
  const f=await fixture(t),preview=f.preview();
  assert.equal((await f.approve(preview)).status,200);
  const request=await f.claim();
  const diagnostic={stage:'inlet_face',reason:'port_face_missing',exceptionType:'System.InvalidOperationException',
    saveAttempted:false,cleanupComplete:true,failureIds:['3c0bfb00-b118-49b3-8b1f-c9f43247661d']};
  await f.fail(request,{outcome:'failed',diagnostic,message:'untrusted stack C:/private/test'});
  const answer=await waitFor(()=>f.codex.answers[0]);
  const body=JSON.parse(answer.contentItems[0].text);
  assert.equal(body.status,'failed');
  assert.equal(body.artifactId,request.id);
  assert.deepEqual(body.diagnostic,diagnostic);
  assert.match(body.message,/进水口端面/);
  assert.doesNotMatch(JSON.stringify(answer),/untrusted|private/);
  const original=await waitFor(()=>f.app.snapshot('browser').generatedFileFailures?.[0]);
  assert.equal(original.artifactId,request.id);
  assert.equal(original.fileName,preview.target);
  assert.deepEqual(original.diagnostic,diagnostic);
  const payload={artifactId:request.id,conversationId:preview.conversationId};
  assert.equal((await f.post('chat-artifact/check',payload,null)).status,403);
  assert.equal((await f.post('chat-artifact/check',{...payload,client:'other'})).status,409);
  const checked=await f.post('chat-artifact/check',payload);
  assert.equal(checked.status,200);
  assert.equal(checked.body.status,'failed');
  assert.equal(checked.body.artifactId,request.id);
  assert.deepEqual(checked.body.diagnostic,diagnostic);
  assert.equal((await f.post('chat-artifact/open',payload)).status,404);
  assert.deepEqual(await f.queueFiles(),[]);
});

test('an unknown save result retains the original pending slot and can be checked without opening it',async t=>{
  const f=await fixture(t),preview=f.preview();
  assert.equal((await f.approve(preview)).status,200);
  const request=await f.claim();
  const diagnostic={stage:'save',reason:'native_api_error',exceptionType:'System.IO.IOException',
    saveAttempted:true,cleanupComplete:true};
  await f.fail(request,{outcome:'unknown',diagnostic});
  const answer=JSON.parse((await waitFor(()=>f.codex.answers[0])).contentItems[0].text);
  assert.equal(answer.status,'unknown');
  assert.equal(answer.artifactId,request.id);
  assert.deepEqual(answer.diagnostic,diagnostic);
  const payload={artifactId:request.id,conversationId:preview.conversationId};
  const checked=await f.post('chat-artifact/check',payload);
  assert.equal(checked.body.status,'unknown');
  assert.deepEqual(checked.body.diagnostic,diagnostic);
  await waitFor(()=>f.app.snapshot('browser').generatedFilePending?.[0]);
  assert.equal((await f.post('chat-artifact/open',payload)).status,404);
  f.codex.request(2);
  assert.equal((await f.approve(f.preview())).status,200);
  const repeat=JSON.parse((await waitFor(()=>f.codex.answers[1])).contentItems[0].text);
  assert.equal(repeat.status,'unknown');
  assert.equal(repeat.artifactId,request.id);
  assert.deepEqual(await f.queueFiles(),[]);
});
