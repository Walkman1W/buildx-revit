// Isolated panel and fake Codex/host only. Never connects to Revit or an
// existing service; this does not enable the feature in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createPanelServer} from '../lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';
import {createDynamicCabinetOwner,DYNAMIC_CABINET_TOOL} from '../lib/dynamic-cabinet-owner.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
class FakeCodex extends EventEmitter {
  constructor(){super();this.profile=Object.freeze({...createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE}),dynamicTools:Object.freeze([Object.freeze({type:'function',...DYNAMIC_CABINET_TOOL})])});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.answers=[];}
  async newThread(){return 'thread';}async turn(){this.early?.();return {turn:{id:'turn'}};}async interrupt(){}async close(){return {closed:true};}
  request(id,action,parameters){let live=true;const params=Object.freeze({threadId:'thread',turnId:'turn',callId:'call-'+id,tool:DYNAMIC_CABINET_TOOL.name,arguments:Object.freeze({action,parameters})});this.emit('dynamic-tool-request',{id,generation:1,revision:2,params,respond:value=>{if(!live)return false;live=false;this.answers.push(value);return true;},reject:()=>{live=false;},discard:()=>{live=false;}});}
}
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await delay(20);}throw new Error('Expected response did not arrive');}
const choice=(preview,decision='accept')=>({conversationId:preview.conversationId,requestId:preview.id,digest:preview.digest,decision});

test('isolated panel requires its own human decision before dispatch to the fake named host',async()=>{
  const calls=[],codex=new FakeCodex();
  const owner=createDynamicCabinetOwner({invokeCommand:async(name,parameters,options)=>{calls.push({name,parameters,options});return {ok:true,value:{command:name,tool:name,data:{operation:name.replace('revit_',''),hostSession:'fake-host',value:{success:true,job_handle:'fake-only'}}}};}});
  const app=createPanelServer({root,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,dynamicApprovalOwner:owner,invokeWorkbench:async()=>{throw new Error('unexpected host access');}});
  try{
    const {origin}=await app.listen(),status=await(await fetch(origin+'/api/status')).json();
    const post=async(route,data={})=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':status.csrf,Origin:origin},body:JSON.stringify({client:'browser',...data})});return {status:response.status,body:await response.json()};};
    codex.early=()=>codex.request(1,'create',{template_id:'metric-generic-model',width_mm:1300});
    assert.equal((await post('turn',{message:'test'})).status,202);
    const denied=app.snapshot('browser').dynamicApproval;assert.equal(JSON.parse(denied.parameters).width_mm,1300);assert.equal(calls.length,0);
    assert.equal((await post('dynamic-approval',{...choice(denied),digest:'a'.repeat(64)})).status,409);
    assert.equal((await post('dynamic-approval',choice(denied,'decline'))).status,200);await until(()=>codex.answers.length===1);assert.equal(calls.length,0);
    codex.request(2,'save',{job_handle:'fake-only'});const accepted=app.snapshot('browser').dynamicApproval;assert.equal(accepted.target,'fake-only');
    assert.equal((await post('dynamic-approval',choice(accepted))).status,200);assert.equal((await post('dynamic-approval',choice(accepted))).status,409);
    await until(()=>codex.answers.length===2);assert.equal(calls.length,1);assert.equal(calls[0].name,'revit_family_save_cabinet');assert.deepEqual(calls[0].parameters,{job_handle:'fake-only'});assert.equal(calls[0].options.confirmed,true);
  }finally{assert.equal((await app.close()).closed,true);}
});
