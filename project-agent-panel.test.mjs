import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from './lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
class Fake extends EventEmitter{
  constructor(){super();this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.answers=[];this.rejected=0;}
  async newThread(){return 'thread';}
  async turn(){if(this.early)this.early();else{this.send('turn');this.send('foreign');}return {turn:{id:'turn'}};}
  async interrupt(){} async close(){return {closed:true};}
  send(turnId,tool='buildx_project_search',args={query:'净宽'}){let live=true;const params=Object.freeze({threadId:'thread',turnId,callId:'call-'+turnId,tool,arguments:Object.freeze(args)});
    this.emit('dynamic-tool-request',{id:turnId,generation:1,revision:2,params,respond:value=>{if(!live)return false;live=false;this.answers.push(value);return true;},reject:()=>{if(live){live=false;this.rejected++;}},discard:()=>{live=false;}});}
}
test('project dynamic tools bind early requests to the acknowledged active turn and selected source',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-project-agent-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.writeFile(path.join(directory,'design.txt'),'净宽 1200 mm\n');const codex=new Fake();
  const app=createPanelServer({root,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,invokeWorkbench:async()=>{throw new Error('unexpected');}});
  const {origin}=await app.listen();t.after(()=>app.close());const state=await (await fetch(origin+'/api/status')).json();
  const post=async(route,data)=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Chat':state.csrf},body:JSON.stringify({client:'test',...data})});return {status:response.status,body:await response.json()};};
  assert.equal((await post('project-knowledge',{action:'bind',parameters:{projectId:'A',rootPath:directory}})).status,200);
  assert.equal((await post('turn',{message:'查净宽'})).status,202);
  for(let i=0;i<100&&!codex.answers.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(codex.rejected,1);assert.equal(codex.answers.length,1);assert.equal(codex.answers[0].success,true);
  const answer=JSON.parse(codex.answers[0].contentItems[0].text);assert.equal(answer.value.matches[0].path,'design.txt');assert.match(answer.value.matches[0].snippet,/1200/);
});

test('removed viewer dynamic tools are not advertised or executed in an active turn',async t=>{
  const codex=new Fake(),viewerCalls=[];
  const viewer=Object.freeze({refresh:async()=>{viewerCalls.push('refresh');return {ok:true};},status:async()=>{viewerCalls.push('status');return {ok:true};},get:()=>({ok:true}),locate:()=>{viewerCalls.push('locate');return {ok:true};}});
  const removed=['buildx_viewer_refresh','buildx_viewer_status','buildx_viewer_locate'];
  assert.equal(codex.profile.dynamicTools.some(tool=>removed.includes(tool.name)),false);
  const app=createPanelServer({root,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,viewerService:viewer,invokeWorkbench:async()=>{throw new Error('unexpected');}});
  const {origin}=await app.listen();t.after(()=>app.close());const state=await (await fetch(origin+'/api/status')).json();
  codex.early=()=>{for(const tool of removed)codex.send('turn',tool,{});};
  const response=await fetch(origin+'/api/turn',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Chat':state.csrf},body:JSON.stringify({client:'test',message:'查看模型'})});
  assert.equal(response.status,202);
  for(let i=0;i<100&&codex.rejected<removed.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(codex.rejected,removed.length);assert.deepEqual(viewerCalls,[]);assert.equal(codex.answers.length,0);
});

