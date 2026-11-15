// Real isolated panel HTTP server and terminal process, with a simulated Codex
// callback. No real Codex, Revit instance or production service is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,realpath,readFile,rm,stat} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createPanelServer} from '../lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';
import {createDynamicTerminalOwner} from '../lib/dynamic-terminal-owner.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const tool=Object.freeze({type:'function',name:'buildx_terminal',description:'test',inputSchema:Object.freeze({type:'object',properties:Object.freeze({}),additionalProperties:false})});
class FakeCodex extends EventEmitter {
  constructor(){super();this.profile=Object.freeze({...createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE}),dynamicTools:Object.freeze([tool])});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.answers=[];this.rejects=0;this.discards=0;}
  async newThread(){return 'thread';}
  async turn(){this.early?.();return {turn:{id:'turn'}};}
  async interrupt(){}
  async close(){return {closed:true};}
  request(id,args,overrides={}){
    let live=true;const params=Object.freeze({threadId:'thread',turnId:'turn',callId:'call-'+id,tool:'buildx_terminal',arguments:Object.freeze(args),...overrides});
    this.emit('dynamic-tool-request',{id,generation:1,revision:2,params,respond:value=>{if(!live)return false;live=false;this.answers.push(value);return true;},reject:()=>{if(live){live=false;this.rejects++;}},discard:()=>{if(live){live=false;this.discards++;}}});
  }
}
async function absent(file){try{await stat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await delay(20);}throw new Error('Expected response did not arrive');}
const decision=(preview,decision='accept')=>({conversationId:preview.conversationId,requestId:preview.id,digest:preview.digest,decision});

test('isolated panel approval gates a real terminal process and keeps each action one-use',async()=>{
  const tempRoot=await realpath(os.tmpdir()),dir=await mkdtemp(path.join(tempRoot,'buildx-panel-terminal-')),owned=await realpath(dir);
  if(path.dirname(owned)!==tempRoot||!path.basename(owned).startsWith('buildx-panel-terminal-'))throw new Error('Unexpected test directory');
  const codex=new FakeCodex(),owner=createDynamicTerminalOwner();
  const app=createPanelServer({root,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,dynamicApprovalOwner:owner,invokeWorkbench:async()=>{throw new Error('unexpected model access');}});
  try{
    const {origin}=await app.listen(),status=await(await fetch(origin+'/api/status')).json();
    const post=async(route,data={})=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':status.csrf,Origin:origin},body:JSON.stringify({client:'browser',...data})});return {status:response.status,body:await response.json()};};
    const marker=path.join(owned,'marker.txt');
    const args={executable:process.execPath,cwd:owned,args:['-e',"require('node:fs').appendFileSync(process.argv[1],'1');process.stdout.write('ok')",marker]};
    codex.early=()=>{codex.request(1,args,{turnId:'other-turn'});codex.request(2,args);};
    assert.equal((await post('turn',{message:'test'})).status,202);assert.equal(codex.rejects,1);
    const denied=app.snapshot('browser').dynamicApproval;
    assert.equal(denied.target,args.executable);assert.equal(denied.cwd,args.cwd);assert.deepEqual(JSON.parse(denied.parameters),args.args);
    await delay(80);assert.equal(await absent(marker),true);
    assert.equal((await post('dynamic-approval',{...decision(denied),client:'other'})).status,409);
    assert.equal((await post('dynamic-approval',{...decision(denied),digest:'b'.repeat(64)})).status,409);
    assert.equal((await post('dynamic-approval',decision(denied,'decline'))).status,200);
    await until(()=>codex.answers.length===1);assert.equal(codex.answers[0].success,false);assert.equal(await absent(marker),true);
    codex.request(3,args);const allowed=app.snapshot('browser').dynamicApproval;
    assert.equal((await post('dynamic-approval',decision(allowed))).status,200);
    assert.equal((await post('dynamic-approval',decision(allowed))).status,409);
    await until(()=>codex.answers.length===2);assert.equal(codex.answers[1].success,true);
    assert.equal(JSON.parse(codex.answers[1].contentItems[0].text).stdout,'ok');assert.equal(await readFile(marker,'utf8'),'1');
    codex.request(4,args);const stale=app.snapshot('browser').dynamicApproval;
    codex.state={...codex.state,connectionGeneration:2};assert.equal((await post('dynamic-approval',decision(stale))).status,409);
    assert.equal(await readFile(marker,'utf8'),'1');
  }finally{
    const closed=await app.close();assert.equal(closed.closed,true);
    await rm(owned,{recursive:true,force:true});
  }
});
