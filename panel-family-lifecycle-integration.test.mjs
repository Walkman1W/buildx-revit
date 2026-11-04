import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from './lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const HOST='a'.repeat(32);
const wait=async predicate=>{const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw new Error('fixture timeout');await new Promise(resolve=>setTimeout(resolve,5));}};
class Fake extends EventEmitter{
  constructor(){super();this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.answers=[];this.rejected=0;}
  async newThread(){return 'thread';}async turn(){return {turn:{id:'turn'}};}async interrupt(){}async close(){return {closed:true};}
  request(id,tool,parameters){let live=true;const params=Object.freeze({threadId:'thread',turnId:'turn',callId:'call-'+id,tool:'buildx_model_operation',arguments:Object.freeze({tool,parameters})});this.emit('dynamic-tool-request',{id,generation:1,revision:2,params,respond:value=>{if(!live)return false;live=false;this.answers.push(value);return true;},reject:()=>{live=false;this.rejected++;},discard:()=>{live=false;}});}
}
function job(handle='job'){
  const save={attempted:false,state:'not_started',path:null,sha256:null,independently_reopened_verified:false};
  const review={host_session:HOST,revit_pid:42,job_handle:handle,project_handle:'project',project_fingerprint:'fingerprint',template_id:'metric-generic-model',template_sha256:'b'.repeat(64),stage:'Built',build_state:'committed',build_complete:true,family_transaction:'Committed',owned:true,resource_retained:true,ownership_conflict:false,family_document_live:true,family_document_modified:true,family_content:{length_mm:300},save,cleanup_pending:false};
  return {operation:'family_inspect_job',hostSession:HOST,value:{operation:'family_inspect_job',host_session:HOST,revit_pid:42,success:true,code:'FAMILY_JOB_INSPECTED',job_handle:handle,job_scope:'bound_project',project_handle:'project',project_fingerprint:'fingerprint',core_registry_current:true,stage:'Built',build_state:'committed',save,cleanup_pending:false,approval:{schema_version:1,change_version:'1',expires_utc:new Date(Date.now()+60000).toISOString(),save_token:'d'.repeat(32),close_token:'c'.repeat(32),review}}};
}
async function fixture(t,enabled=true){
  const codex=new Fake(),calls=[],direct=[];let inspection=job();
  let observedCapability={hostSession:HOST,version:1};
  const readJob=control=>{const value=structuredClone(inspection);if(control?.requestLifecycleApproval!==true)value.value.approval=null;return value;};
  const services=Object.freeze({observeDocument:async()=>({session:HOST,path:'C:\\model.rvt',title:'Model'}),readCommand:async()=>{},inspectFamilyJob:async(_handle,control)=>readJob(control),invoke:async(...args)=>{calls.push(args);return {ok:true,value:{done:true}};}});
  const capability=enabled?Object.freeze({observe:async()=>observedCapability}):null;
  const app=createPanelServer({root,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,modelPermissionServices:services,familyCapabilityOwner:capability,invokeWorkbench:async()=>{throw new Error('unexpected');},invokeReadonlyCommand:async(...args)=>{direct.push(args);return {ok:true,value:{command:args[0],data:args[0]==='revit_family_inspect_job'?readJob(args[2]):{done:true}}};}});
  const {origin}=await app.listen(),status=await(await fetch(origin+'/api/status')).json();t.after(()=>app.close());
  const post=async(route,data={})=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':status.csrf,Origin:origin},body:JSON.stringify({client:'browser',...data})});return {status:response.status,body:await response.json()};};
  const session=app.snapshot('browser').session.conversation.id;await post('model-permission',{conversationId:session,level:'automatic',expectedRevision:0});
  return {app,codex,calls,direct,post,session,setInspection:value=>{inspection=value;},setCapability:value=>{observedCapability=value;}};
}

test('old composition rejects both direct and AI lifecycle operations',async t=>{
  const f=await fixture(t,false);assert.equal((await f.post('command',{conversationId:f.session,commandId:'revit_family_save_job',confirmed:true,parameters:{job_handle:'job'}})).status,403);
  await f.post('turn',{message:'save'});f.codex.request(1,'revit_family_save_job',{job_handle:'job'});await wait(()=>f.codex.rejected>0);assert.equal(f.calls.length,0);
});

test('an old host still permits ordinary inspection without issuing a token',async t=>{
  const f=await fixture(t);f.setCapability({hostSession:HOST,version:0});
  assert.equal((await f.post('command',{conversationId:f.session,commandId:'revit_family_inspect_job',parameters:{job_handle:'job'}})).status,202);
  await wait(()=>f.app.snapshot('browser').command?.status==='completed');assert.equal(f.direct[0][2].requestLifecycleApproval,undefined);
  assert.equal(f.app.snapshot('browser').command.result.data.value.approval,null);
  assert.equal((await f.post('command',{conversationId:f.session,commandId:'revit_family_close_job',confirmed:true,parameters:{job_handle:'job'}})).status,403);
});

test('AI lifecycle approval shows reviewed content, never exposes token and injects it only after acceptance',async t=>{
  const f=await fixture(t);await f.post('turn',{message:'save'});f.codex.request(1,'revit_family_save_job',{job_handle:'job'});
  await wait(()=>f.app.snapshot('browser').dynamicApproval);const p=f.app.snapshot('browser').dynamicApproval;
  assert.match(p.parameters,/length_mm/);assert.match(p.source,/RFA/);assert.equal(p.parameters.includes('d'.repeat(32)),false);assert.equal(f.calls.length,0);
  assert.equal((await f.post('dynamic-approval',{conversationId:f.session,requestId:p.id,digest:p.digest,decision:'accept'})).status,200);await wait(()=>f.calls.length===1);
  assert.equal(f.calls[0][2].approvedLifecycle.operation,'family_save_job');assert.equal(f.calls[0][2].approvedLifecycle.approval_token,'d'.repeat(32));assert.equal(f.calls[0][2].approvedFamilyIdentity.project_handle,'project');
  assert.equal((await f.post('dynamic-approval',{conversationId:f.session,requestId:p.id,digest:p.digest,decision:'accept'})).status,409);
});

test('direct close needs exact inspected job, explicit confirmation and the close token',async t=>{
  const f=await fixture(t);const direct=confirmed=>f.post('command',{conversationId:f.session,commandId:'revit_family_close_job',confirmed,parameters:{job_handle:'job'}});
  assert.equal((await direct(true)).status,403);assert.equal((await f.post('command',{conversationId:f.session,commandId:'revit_family_inspect_job',parameters:{job_handle:'job'}})).status,202);
  await wait(()=>f.app.snapshot('browser').command?.status==='completed');assert.equal(f.direct[0][2].requestLifecycleApproval,true);assert.equal(JSON.stringify(f.app.snapshot('browser').command).includes('c'.repeat(32)),false);assert.equal((await direct(false)).status,403);assert.equal((await direct(true)).status,202);await wait(()=>f.direct.some(item=>item[0]==='revit_family_close_job'));
  const call=f.direct.find(item=>item[0]==='revit_family_close_job');assert.equal(call[2].approvedLifecycle.approval_token,'c'.repeat(32));assert.equal(call[2].approvedLifecycle.operation,'family_close_job');
});

test('closing can review an unavailable template without claiming a verified digest',async t=>{
  const f=await fixture(t);const unknown=job();unknown.value.approval.review.template_sha256=null;f.setInspection(unknown);
  assert.equal((await f.post('command',{conversationId:f.session,commandId:'revit_family_inspect_job',parameters:{job_handle:'job'}})).status,202);await wait(()=>f.app.snapshot('browser').command?.status==='completed');
  assert.equal((await f.post('command',{conversationId:f.session,commandId:'revit_family_close_job',confirmed:true,parameters:{job_handle:'job'}})).status,202);await wait(()=>f.direct.some(item=>item[0]==='revit_family_close_job'));
  assert.equal(f.direct.find(item=>item[0]==='revit_family_close_job')[2].approvedFamilyIdentity.template.sha256,null);
});

test('missing, expired or mismatched host approval never reaches a lifecycle operation',async t=>{
  const f=await fixture(t);const bad=job();bad.value.approval.review.host_session='other';f.setInspection(bad);await f.post('turn',{message:'save'});f.codex.request(1,'revit_family_save_job',{job_handle:'job'});await wait(()=>f.codex.rejected>0);assert.equal(f.calls.length,0);
});

test('an approval snapshot which disagrees with the inspected job is rejected',async t=>{
  const f=await fixture(t);const bad=job();bad.value.approval.review.save={...bad.value.approval.review.save,state:'different'};f.setInspection(bad);await f.post('turn',{message:'save'});f.codex.request(1,'revit_family_save_job',{job_handle:'job'});await wait(()=>f.codex.rejected>0);assert.equal(f.calls.length,0);
});

test('changing the trusted host capability after display prevents dispatch',async t=>{
  const f=await fixture(t);await f.post('turn',{message:'save'});f.codex.request(1,'revit_family_save_job',{job_handle:'job'});await wait(()=>f.app.snapshot('browser').dynamicApproval);
  const p=f.app.snapshot('browser').dynamicApproval;f.setCapability({hostSession:'f'.repeat(32),version:1});
  assert.equal((await f.post('dynamic-approval',{conversationId:f.session,requestId:p.id,digest:p.digest,decision:'accept'})).status,200);await wait(()=>f.codex.answers.length===1);assert.equal(f.calls.length,0);assert.equal(f.codex.answers[0].success,false);
});
