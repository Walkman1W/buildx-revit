import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {createModelWorkspaceFixture} from './test-support/model-workspace-preview.mjs';
import {createCodexSessionProfile} from './lib/codex-profile.mjs';
import {createAccessServices} from './lib/access-services.mjs';
import {createMaterialIndex} from './lib/project-files.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const wait=async predicate=>{for(let i=0;i<300;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Controlled access fixture timeout');};
class Peer extends EventEmitter{
  constructor(){super();this.profile=createCodexSessionProfile(process.cwd(),{profile:'model-workspace'});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.sequence=0;this.current=null;}
  async newThread(){return 'access-thread-'+(++this.sequence);}
  async turn(threadId,text){this.current={threadId,turnId:'access-turn-'+this.sequence,text};return {turn:{id:this.current.turnId}};}
  async interrupt(){} async close(){return {closed:true};}
  request(tool,args){return new Promise((resolve,reject)=>{const p=Object.freeze({...this.current,callId:'call-'+(++this.sequence),tool,arguments:Object.freeze(args)});let settled=false;this.emit('dynamic-tool-request',{id:this.sequence,generation:1,revision:2,params:p,respond:result=>{if(settled)return false;settled=true;resolve(result);return true;},reject:()=>reject(new Error('Dynamic call rejected')),discard:()=>reject(new Error('Dynamic call discarded'))});});}
  finish(){this.emit('notification','turn/completed',{threadId:this.current.threadId,turn:{id:this.current.turnId,status:'completed'}});}
}
async function fixture(t,{oldHost=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-access-http-'));await fs.mkdir(path.join(root,'workbench'));const project=path.join(root,'project'),outside=path.join(root,'outside');await fs.mkdir(project);await fs.mkdir(outside);
  const documentPath=path.join(project,'model.rvt');await fs.writeFile(documentPath,'controlled model identity, not an RVT');
  const accessServices=createAccessServices({root,stateDirectory:path.join(root,'state')}),codex=new Peer(),calls=[],observations=[];
  const index=createMaterialIndex(),selected=await index.addRoot({path:project,kind:'directory'});assert.equal(selected.ok,true);
  const modelPermissionServices=Object.freeze({observeDocument:async control=>{observations.push(control);if(oldHost)throw new Error('Revit 宿主需加载0.8.0以核实访问策略。');assert.ok(control?.accessPolicy);return {session:'controlled-host',title:'Controlled',path:documentPath};},readCommand:async()=>{},inspectFamilyJob:async()=>{},invoke:async(tool,args,control)=>{calls.push({tool,args,control});return {ok:true,value:{request_id:'controlled-write',operation:tool,mode:args.mode,committed:args.mode==='commit'}};}});
  const f=await createModelWorkspaceFixture({profile:'model-workspace',required:false,historyDirectory:path.join(root,'history'),codexClient:codex,accessServices,modelPermissionServices,materialIndexFactory:()=>index});
  t.after(async()=>{await f.close();assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});
  f.app.snapshot('model-test-client');await wait(()=>accessServices.view('model:research-local'));
  const choose=async(mode,extra={})=>f.post('access-policy',{mode,confirmed:true,expectedRevision:accessServices.view('model:research-local').revision,...extra});
  const start=async()=>{assert.equal((await f.post('turn',{message:'Controlled explicit file and model work'})).status,202);await wait(()=>codex.current);};
  const finish=async()=>{codex.finish();await wait(async()=>!(await f.status()).busy);};
  return {...f,root,project,outside,index,rootId:selected.value.root.id,choose,start,finish,calls,observations};
}

test('HTTP scope selection requires explicit confirmation, current revision, CSRF and a real library directory',async t=>{
  const f=await fixture(t);assert.equal(f.app.snapshot('model-test-client').session.accessPolicy.mode,'read-only');
  assert.equal((await f.choose('full-access',{confirmed:false})).status,400);
  const stale=await f.choose('full-access',{expectedRevision:999});assert.equal(stale.status,409);
  assert.equal(stale.body.accessPolicy.preparation.operation,'activate');
  assert.equal(stale.body.accessPolicy.preparation.phase,'settled');
  assert.equal(stale.body.accessPolicy.preparation.pending,false);
  assert.equal((await f.post('access-policy',{mode:'full-access',confirmed:true,expectedRevision:0},undefined,{Origin:'http://other.invalid'})).status,403);
  assert.equal((await f.choose('project-write',{rootId:'invented'})).status,409);
  const selected=await f.choose('project-write',{rootId:f.rootId});assert.equal(selected.status,200);assert.equal(selected.body.accessPolicy.mode,'project-write');assert.equal(selected.body.accessPolicy.modelWritable,true);
  await f.start();const denied=await f.codex.request('buildx_file_write',{path:path.join(f.outside,'no.txt'),content:'no',create:true});assert.equal(denied.success,false);assert.equal(await fs.stat(path.join(f.outside,'no.txt')).then(()=>true,()=>false),false);await f.finish();
});

test('full access edits an external scratch file through dynamic tools; model actions carry policy and preview/commit stay separate',async t=>{
  const f=await fixture(t),target=path.join(f.outside,'allowed.txt');await fs.writeFile(target,'before');
  const chosen=await f.choose('full-access');assert.equal(chosen.status,200);assert.equal(chosen.body.accessPolicy.modelWritable,true);
  const permission=f.app.snapshot('model-test-client').modelPermission;
  assert.equal((await f.post('model-permission',{conversationId:permission.conversationId,level:'automatic',expectedRevision:permission.revision})).status,200);
  await f.start();const read=await f.codex.request('buildx_file_read',{path:target});assert.equal(read.success,true);
  const written=await f.codex.request('buildx_file_write',{path:target,content:'after',expected_sha256:digest('before')});assert.equal(written.success,true);assert.equal(await fs.readFile(target,'utf8'),'after');
  const script=await f.codex.request('buildx_model_operation',{tool:'revit_execute_csharp',parameters:{code:'return 1;',mode:'commit'}});assert.equal(script.success,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].control.accessPolicy.mode,'full-access');assert.equal(f.calls[0].args.mode,'commit');await f.finish();
  const revoked=await f.choose('read-only');assert.equal(revoked.status,200);assert.equal(revoked.body.accessPolicy.modelWritable,false);
  await f.start();const denied=await f.codex.request('buildx_file_write',{path:target,content:'forbidden',expected_sha256:digest('after')});assert.equal(denied.success,false);assert.equal(await fs.readFile(target,'utf8'),'after');await f.finish();
});

test('old native host is explicitly blocked while file access works; new conversations never inherit a stale editable label',async t=>{
  const f=await fixture(t,{oldHost:true}),chosen=await f.choose('full-access');assert.equal(chosen.status,200);assert.equal(chosen.body.accessPolicy.mode,'full-access');assert.equal(chosen.body.accessPolicy.modelWritable,false);assert.match(chosen.body.accessPolicy.modelMessage,/0.8.0/);
  await f.start();const created=await f.codex.request('buildx_file_write',{path:path.join(f.outside,'file-only.txt'),content:'explicit file access',create:true});assert.equal(created.success,true);
  const blocked=await f.codex.request('buildx_model_operation',{tool:'revit_create_wall',parameters:{mode:'commit'}});assert.equal(blocked.success,false);assert.equal(f.calls.length,0);await f.finish();
});

test('a new conversation keeps the remembered scope but revalidates its own model grant',async t=>{
  const f=await fixture(t);const chosen=await f.choose('full-access');assert.equal(chosen.body.accessPolicy.modelWritable,true);
  assert.equal((await f.post('new-chat')).status,200);
  const state=f.app.snapshot('model-test-client');assert.equal(state.session.accessPolicy.mode,'full-access');assert.equal(state.session.accessPolicy.modelWritable,false);
  await f.start();const result=await f.codex.request('buildx_model_operation',{tool:'revit_move_elements',parameters:{element_ids:[42],delta_mm:{x:10,y:0,z:0},mode:'rollback'}});assert.equal(result.success,true);assert.equal(f.calls[0].control.accessPolicy.mode,'full-access');await f.finish();
});

test('invalid named parameters without a current grant cannot trigger automatic model binding',async t=>{
  const f=await fixture(t);assert.equal((await f.choose('full-access')).body.accessPolicy.modelWritable,true);
  assert.equal((await f.post('new-chat')).status,200);
  const state=f.app.snapshot('model-test-client');assert.equal(state.session.accessPolicy.mode,'full-access');assert.equal(state.session.accessPolicy.modelWritable,false);
  // Discard setup observations so this measures only the new conversation.
  f.observations.length=0;await f.start();
  const rejected=await f.codex.request('buildx_model_operation',{tool:'revit_create_wall',parameters:{}});
  assert.equal(rejected.success,false);const result=JSON.parse(rejected.contentItems[0].text);
  assert.equal(result.error.code,'MODEL_OPERATION_PARAMETERS_INVALID');assert.equal(result.error.outcome,'not_started');
  assert.equal(result.error.details.tool,'revit_create_wall');assert.equal(result.error.details.field,'arguments.wall_type_id');
  assert.equal(f.observations.length,0);assert.equal(f.calls.length,0);assert.equal(f.app.snapshot('model-test-client').session.accessPolicy.modelWritable,false);
  // A valid new call still follows the real access owner and rebinds this model.
  const valid=await f.codex.request('buildx_model_operation',{tool:'revit_move_elements',parameters:{element_ids:[42],delta_mm:{x:10,y:0,z:0},mode:'rollback'}});
  assert.equal(valid.success,true);assert.ok(f.observations.length>0);assert.equal(f.calls.length,1);await f.finish();
});
