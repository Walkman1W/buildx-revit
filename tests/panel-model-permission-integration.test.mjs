import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from '../lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';
import {supportsModelPermissionTool} from '../lib/model-operation-effects.mjs';
import {createPanelChatStore} from '../lib/chat-store.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const wait=async predicate=>{const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw new Error('fixture timeout');await new Promise(resolve=>setTimeout(resolve,5));}};
class Fake extends EventEmitter{
  constructor(){super();this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.answers=[];this.rejected=0;}
  async newThread(){return 'thread';} async turn(){return {turn:{id:'turn'}};} async interrupt(){} async close(){return {closed:true};}
  request(id,tool,parameters){let live=true;const params=Object.freeze({threadId:'thread',turnId:'turn',callId:'call-'+id,tool:'buildx_model_operation',arguments:Object.freeze({tool,parameters})});this.emit('dynamic-tool-request',{id,generation:1,revision:2,params,respond:value=>{if(!live)return false;live=false;this.answers.push(value);return true;},reject:()=>{live=false;this.rejected++;},discard:()=>{live=false;}});}
}
async function fixture(t,options={}){
  const codex=new Fake(),calls=[],direct=[];let document={session:'host',path:'C:\\model.rvt',title:'模型'};
  let familySha='a'.repeat(64),scopedHost=options.scoped===true,panelRoot=root;
  const policy=Object.freeze({id:'test-policy',revision:1,accountScope:'test-project',mode:'project-write'});
  if(options.scoped){
    const profileRoot=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-scoped-profile-'));
    await fs.writeFile(path.join(profileRoot,'buildx-confirmed-write.json'),JSON.stringify({schemaVersion:1,scope:'confirmed-write'}));
    t.after(()=>fs.rm(profileRoot,{recursive:true,force:true}));
    codex.profile=createCodexSessionProfile(profileRoot,{profile:MODEL_WORKSPACE_SESSION_PROFILE,scopedAutomatic:true});
    panelRoot=profileRoot;
  }
  const accessServices=options.scoped?Object.freeze({tools:[],activate:async()=>({ok:true}),view:()=>({...policy,roots:[]}),
    control:()=>policy,current:(_scope,value)=>value?.id===policy.id&&value.revision===policy.revision,
    authorize:async()=>({ok:true}),select:async()=>({ok:true,value:policy}),invoke:async()=>{},deactivate:async()=>{},close:async()=>({closed:true})}):null;
  const services=Object.freeze({observeDocument:async control=>{if(control?.requireScopedAutoApply&&!scopedHost)throw new Error("当前项目的 Revit 宿主未声明自动应用能力");return {...document};},readCommand:async(args,control)=>options.readCommand?options.readCommand(args,control):({schema_version:1,command_id:args.command_id,revision:args.revision,name:'已保存命令',description:'示例',code:'return 42;'}),inspectFamilyJob:async job_handle=>({operation:'family_inspect_job',hostSession:'host',value:{operation:'family_inspect_job',host_session:'host',success:true,code:'FAMILY_JOB_INSPECTED',job_handle,job_scope:'bound_project',project_handle:'project',project_fingerprint:'fingerprint',core_registry_current:true,cleanup_pending:false,save:{state:'saved_reopened_verified_closed',path:'C:\\family.rfa',sha256:familySha,independently_reopened_verified:true}}}),invoke:async(...args)=>{calls.push(args);return options.invoke?options.invoke(...args):{ok:true,value:{done:true}};}});
  const app=createPanelServer({root:panelRoot,codex,port:0,...options.scoped?{confirmedWrite:true,accessServices}:{},...options.historyStore?{historyStore:options.historyStore}:{},...options.pollDelays?{modelReceiptPollDelays:options.pollDelays}:{},profile:MODEL_WORKSPACE_SESSION_PROFILE,modelPermissionServices:services,invokeWorkbench:async()=>{throw new Error('unexpected read');},invokeReadonlyCommand:async(...args)=>{direct.push(args);const [id,parameters]=args;if(options.directInvoke)return options.directInvoke(...args);return {ok:true,value:{command:id,data:id==='revit_get_command'?await services.readCommand(parameters):id==='revit_family_inspect_job'?await services.inspectFamilyJob(parameters.job_handle):{done:true}}};}});
  const {origin}=await app.listen(),status=await(await fetch(origin+'/api/status')).json();t.after(()=>app.close());
  const post=async(route,data={},client='browser')=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':status.csrf,Origin:origin},body:JSON.stringify({client,...data})});return {status:response.status,body:await response.json()};};
  const session=app.snapshot('browser').session.conversation.id;
  return {app,codex,calls,direct,origin,post,session,changeDocument:value=>{document=value;},changeFamilySha:value=>{familySha=value;},changeScopedHost:value=>{scopedHost=value;}};
}
const choose=(f,level,revision=0)=>f.post('model-permission',{conversationId:f.session,level,expectedRevision:revision});
const approve=(f,p,decision='accept',client='browser')=>f.post('dynamic-approval',{conversationId:f.session,requestId:p.id,digest:p.digest,decision},client);

test('actual HTTP/SSE grants automatic authority only after a verified document and keeps preview intent',async t=>{
  const f=await fixture(t);const controller=new AbortController();t.after(()=>controller.abort());
  const events=await fetch(f.origin+'/api/events?client=browser',{signal:controller.signal}),reader=events.body.getReader(),first=new TextDecoder().decode((await reader.read()).value);
  assert.match(first,/"modelPermission":\{"available":true,"level":null/);
  assert.equal((await choose(f,'automatic')).status,200);assert.equal(f.app.snapshot('browser').modelPermission.level,'automatic');
  assert.equal((await f.post('turn',{message:'开始'})).status,202);
  f.codex.request(1,'revit_move_elements',{mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}});await wait(()=>f.calls.length===1);
  assert.equal(f.calls[0][1].mode,'commit');assert.equal(f.codex.answers[0].success,true);
  f.codex.request(2,'revit_move_elements',{mode:'rollback',element_ids:[1],delta_mm:{x:1,y:0,z:0}});await wait(()=>f.calls.length===2);assert.equal(f.calls[1][1].mode,'rollback');
  assert.equal(f.app.snapshot('other').modelPermission.level,null);controller.abort();
});

test('scoped candidate negotiates automatic apply and records distinct native write outcomes',async t=>{
  const requestId=randomUUID(),group={name:'Fixture group',element_ids:[1,2]};
  const receiptOwner={inspect:async()=>({ok:true,value:{status:'failed_rolled_back',terminal:true,requestId}}),
    close:async()=>({ok:true,value:{closed:true}})};
  const f=await fixture(t,{scoped:true,pollDelays:[5000],invoke:async(_tool,args)=>args.name==='Native failure'
    ? {ok:false,error:{outcome:'failed'},evidence:{nativeFailure:{started:true,phase:'dispatch',outcome:'failed',hostSession:'host',requestId}},receiptOwner}
    : {ok:true,value:{request_id:randomUUID()}}});
  f.changeScopedHost(false);
  const denied=await choose(f,'automatic');assert.equal(denied.status,409);assert.match(denied.body.error,/未声明自动应用能力/);
  f.changeScopedHost(true);
  assert.equal((await choose(f,'automatic')).status,200);
  assert.equal((await f.post('turn',{message:'候选回执测试'})).status,202);
  const tools=()=>f.app.snapshot('browser').session.messages.at(-1).tools;
  f.codex.request(1,'revit_create_wall',{});
  await wait(()=>tools().some(tool=>tool.operationReceipt?.code==='MODEL_OPERATION_UNSUPPORTED'));
  assert.equal(f.calls.length,0);
  f.codex.request(2,'revit_create_group',group);
  await wait(()=>f.codex.answers.length===2);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].mode,'commit');assert.equal(f.calls[0][2].approvedScopedAutoApply,true);
  assert.equal(f.app.snapshot('browser').dynamicApproval,null);
  f.codex.request(3,'revit_create_group',{...group,mode:'rollback'});
  await wait(()=>Boolean(f.app.snapshot('browser').dynamicApproval));
  const pending=f.app.snapshot('browser').dynamicApproval;
  t.mock.timers.enable({apis:['Date'],now:pending.deadline+1});
  try{assert.equal((await approve(f,pending)).body.code,'MODEL_APPROVAL_EXPIRED');}
  finally{t.mock.timers.reset();}
  assert.ok(tools().some(tool=>tool.operationReceipt?.code==='MODEL_APPROVAL_EXPIRED'));
  assert.equal(f.calls.length,1);
  f.codex.request(4,'revit_create_group',{...group,name:'Native failure'});
  await wait(()=>tools().some(tool=>tool.operationReceipt?.code==='MODEL_REVIT_EXECUTION_FAILED'));
  assert.equal(tools().find(tool=>tool.operationReceipt?.code==='MODEL_REVIT_EXECUTION_FAILED').operationReceipt.requestId,requestId);
  const {ticket}=f.app.snapshot('browser').modelReceipt;
  assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket})).status,200);
  const checked=f.app.snapshot('browser').modelReceipt;
  if(checked)assert.equal((await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket,checkRevision:checked.checkRevision,confirmed:true})).status,200);
});

test('confirmation is one use and C# always requires user review even in automatic mode',async t=>{
  const f=await fixture(t);await choose(f,'confirm');await f.post('turn',{message:'开始'});
  f.codex.request(1,'revit_move_elements',{mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}});const p=f.app.snapshot('browser').dynamicApproval;
  assert.equal(p.kind,'model');assert.equal(f.calls.length,0);assert.equal((await approve(f,p,'accept','other')).status,409);
  assert.equal((await approve(f,p)).status,200);assert.equal((await approve(f,p)).status,409);await wait(()=>f.calls.length===1);
  f.codex.request(2,'revit_execute_csharp',{mode:'rollback',code:'return 42;'});const script=f.app.snapshot('browser').dynamicApproval;
  assert.match(script.parameters,/return 42/);assert.match(script.source,/文件、网络/);assert.equal(f.calls.length,1);
  assert.equal((await approve(f,script,'decline')).status,200);await wait(()=>f.codex.answers.length===2);assert.equal(f.calls.length,1);
});

test('a second visible model approval cannot start while the first owns an execution',async t=>{
  let settle;const pending=new Promise(resolve=>{settle=resolve;});t.after(()=>settle({ok:true,value:{done:true}}));
  const f=await fixture(t,{invoke:()=>pending});await choose(f,'confirm');await f.post('turn',{message:'分别确认两项操作'});
  const args={mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}};
  f.codex.request(1,'revit_move_elements',args);f.codex.request(2,'revit_move_elements',{...args,element_ids:[2]});
  const first=f.app.snapshot('browser').dynamicApproval;
  assert.equal((await approve(f,first)).status,200);await wait(()=>f.calls.length===1);
  const second=f.app.snapshot('browser').dynamicApproval;assert.ok(second);assert.notEqual(second.id,first.id);
  const rejected=await approve(f,second);assert.equal(rejected.status,409);assert.equal(rejected.body.code,'MODEL_OPERATION_BUSY');assert.equal(f.calls.length,1);
  settle({ok:true,value:{done:true}});await wait(()=>f.codex.answers.length===1);
  assert.equal((await approve(f,second,'decline')).status,200);await wait(()=>f.codex.answers.length===2);assert.equal(f.calls.length,1);
});

test('cross-conversation, changing documents and direct command attempts cannot bypass the model policy',async t=>{
  const f=await fixture(t);const id=f.session;
  assert.equal((await f.post('command',{conversationId:id,commandId:'revit_move_elements',confirmed:true,parameters:{mode:'commit'}})).status,403);
  assert.equal((await choose(f,'rollback')).status,200);
  assert.equal((await f.post('command',{conversationId:id,commandId:'revit_move_elements',confirmed:true,parameters:{mode:'commit'}})).status,403);
  const run=await f.post('command',{conversationId:id,commandId:'revit_move_elements',confirmed:true,parameters:{mode:'rollback'}});assert.equal(run.status,202);await wait(()=>f.direct.length===1);
  assert.equal(f.direct[0][2].sourceDocument.session,'host');
  await wait(()=>f.app.snapshot('browser').busy===false);
  f.changeDocument({session:'host',path:'C:\\other.rvt',title:'另一模型'});
  const changed=await f.post('command',{conversationId:id,commandId:'revit_move_elements',confirmed:true,parameters:{mode:'rollback'}});assert.equal(changed.status,409);assert.equal(f.direct.length,1);
  assert.equal(f.app.snapshot('browser').modelPermission.level,null);
});

test('personal command save requires one independent approval even in automatic mode',async t=>{
  const f=await fixture(t);await choose(f,'automatic');await f.post('turn',{message:'创建命令'});
  const parameters={command_id:'wall-demo',name:'墙体工具',description:'测试命令',code:'return 42;'};
  f.codex.request(1,'revit_save_command',parameters);const pending=f.app.snapshot('browser').dynamicApproval;
  assert.equal(pending.kind,'model');assert.match(pending.source,/保存不会运行/);assert.match(pending.parameters,/return 42/);assert.equal(f.calls.length,0);
  assert.equal((await approve(f,pending)).status,200);await wait(()=>f.calls.length===1);
  assert.equal(f.calls[0][0],'revit_save_command');assert.equal(f.calls[0][1].code,'return 42;');assert.equal(Object.hasOwn(f.calls[0][1],'mode'),false);
});

test('running an exact personal revision shows its full source and requires approval even in automatic mode',async t=>{
  const f=await fixture(t);await choose(f,'automatic');await f.post('turn',{message:'运行命令'});
  const revision='a'.repeat(64);f.codex.request(1,'revit_run_command',{command_id:'wall-demo',revision,mode:'commit'});
  await wait(()=>Boolean(f.app.snapshot('browser').dynamicApproval));const p=f.app.snapshot('browser').dynamicApproval;
  assert.match(p.parameters,/return 42/);assert.match(p.parameters,new RegExp(revision));assert.match(p.source,/事务回滚不能撤销/);assert.equal(f.calls.length,0);
  assert.equal((await approve(f,p)).status,200);await wait(()=>f.calls.length===1);assert.equal(f.calls[0][0],'revit_run_command');assert.equal(f.calls[0][1].revision,revision);
});

test('a late personal command read from an old connection never becomes an approval',async t=>{
  let resolve,started=false;const f=await fixture(t,{readCommand:()=>{started=true;return new Promise(done=>{resolve=done;});}});
  await choose(f,'automatic');await f.post('turn',{message:'运行命令'});const revision='a'.repeat(64);
  f.codex.request(1,'revit_run_command',{command_id:'wall-demo',revision,mode:'commit'});await wait(()=>started);
  f.codex.state={...f.codex.state,connectionGeneration:2};resolve({schema_version:1,command_id:'wall-demo',revision,name:'旧命令',description:'示例',code:'return 42;'});
  await wait(()=>f.codex.rejected>0);assert.equal(f.calls.length,0);assert.equal(f.app.snapshot('browser').dynamicApproval,null);
});

test('command page requires a prior displayed exact revision and confirmation before executing personal code',async t=>{
  const f=await fixture(t);await choose(f,'automatic');const revision='a'.repeat(64),id=f.session;
  const invoke=()=>f.post('command',{conversationId:id,commandId:'revit_run_command',confirmed:true,parameters:{command_id:'wall-demo',revision,mode:'rollback'}});
  assert.equal((await invoke()).status,403);
  assert.equal((await f.post('command',{conversationId:id,commandId:'revit_get_command',parameters:{command_id:'wall-demo',revision}})).status,202);
  await wait(()=>f.app.snapshot('browser').command?.status==='completed');
  assert.equal((await f.post('command',{conversationId:id,commandId:'revit_run_command',parameters:{command_id:'wall-demo',revision}})).status,403);
  assert.equal((await invoke()).status,202);await wait(()=>f.direct.some(item=>item[0]==='revit_run_command'));
  const call=f.direct.find(item=>item[0]==='revit_run_command');assert.equal(call[1].revision,revision);assert.equal(call[2].sourceDocument.session,'host');
});

test('model dropdown reads preserve an independently reviewed personal revision and still revalidate its full metadata',async t=>{
  const revision='a'.repeat(64);let reads=0,options={level:{kind:'model',source:'level_id'},scheme:{kind:'enum',values:['A','B']}};
  const f=await fixture(t,{readCommand:async({command_id,revision})=>{reads++;return {schema_version:5,command_id,revision,name:'参数命令',description:'按标高和方案运行',code:'return parameters;',parameters:{level:'integer',scheme:'string'},parameter_options:structuredClone(options)};}});
  await choose(f,'automatic');
  assert.equal((await f.post('command',{conversationId:f.session,commandId:'revit_get_command',parameters:{command_id:'level-command',revision}})).status,202);
  await wait(()=>f.app.snapshot('browser').command?.status==='completed');assert.equal(reads,1);
  assert.equal((await f.post('command',{conversationId:f.session,commandId:'levels',parameters:{}})).status,202);
  await wait(()=>f.app.snapshot('browser').command?.commandId==='levels'&&f.app.snapshot('browser').command.status==='completed');
  const run=chosen=>f.post('command',{conversationId:f.session,commandId:'revit_run_command',confirmed:true,parameters:{command_id:'level-command',revision:chosen,mode:'rollback',parameters:{level:42,scheme:'A'}},sourceDocument:{session:'host',path:'C:\\model.rvt',title:'模型'}});
  assert.equal((await run('b'.repeat(64))).status,403);assert.equal(reads,1);
  assert.equal((await run(revision)).status,202);await wait(()=>f.app.snapshot('browser').command?.commandId==='revit_run_command'&&f.app.snapshot('browser').command.status==='completed');
  assert.equal(reads,2);assert.equal(f.direct.filter(call=>call[0]==='revit_run_command').length,1);
  assert.deepEqual(f.direct.find(call=>call[0]==='revit_run_command')[1].parameters,{level:42,scheme:'A'});
  options={...options,scheme:{kind:'enum',values:['A','C']}};
  assert.equal((await run(revision)).status,409);assert.equal(reads,3);
  assert.equal(f.app.snapshot('browser').command.error.outcome,'not_started');assert.equal(f.direct.filter(call=>call[0]==='revit_run_command').length,1);
  const created=await f.post('new-chat',{});assert.equal(created.status,200);const current=created.body.session.conversation.id,permission=f.app.snapshot('browser').modelPermission;
  assert.equal((await f.post('model-permission',{conversationId:current,level:'automatic',expectedRevision:permission.revision})).status,200);
  assert.equal((await f.post('command',{conversationId:current,commandId:'revit_run_command',confirmed:true,parameters:{command_id:'level-command',revision,mode:'rollback',parameters:{level:42,scheme:'A'}}})).status,403);
  assert.equal(f.direct.filter(call=>call[0]==='revit_run_command').length,1);
});

test('switching conversation revokes automatic permission and stale revisions cannot restore it',async t=>{
  const f=await fixture(t);await choose(f,'automatic');const prior=f.app.snapshot('browser').modelPermission;
  assert.equal((await f.post('new-chat',{})).status,200);const now=f.app.snapshot('browser').modelPermission;
  assert.equal(now.level,null);assert.notEqual(now.conversationId,prior.conversationId);assert.ok(now.revision>prior.revision);
  assert.equal((await f.post('model-permission',{conversationId:prior.conversationId,level:'automatic',expectedRevision:prior.revision})).status,409);
});

test('model change before approval revokes the grant and does not submit the operation',async t=>{
  const f=await fixture(t);await choose(f,'confirm');await f.post('turn',{message:'开始'});
  f.codex.request(1,'revit_move_elements',{mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}});const pending=f.app.snapshot('browser').dynamicApproval;
  f.changeDocument({session:'host',path:'C:\\other.rvt',title:'另一模型'});
  assert.equal((await approve(f,pending)).status,200);await wait(()=>f.codex.answers.length===1);
  assert.equal(f.calls.length,0);assert.equal(f.codex.answers[0].success,false);assert.equal(f.app.snapshot('browser').modelPermission.level,null);
});

test('family load requires explicit review of the same job and RFA in automatic mode',async t=>{
  const f=await fixture(t);await choose(f,'automatic');await f.post('turn',{message:'加载族'});
  f.codex.request(1,'revit_family_load_job',{job_handle:'job',mode:'commit'});await wait(()=>Boolean(f.app.snapshot('browser').dynamicApproval));
  const p=f.app.snapshot('browser').dynamicApproval;assert.match(p.parameters,/family\.rfa/);assert.match(p.parameters,new RegExp('a'.repeat(64)));assert.match(p.source,/不删除原 RFA/);assert.equal(f.calls.length,0);
  assert.equal((await approve(f,p)).status,200);await wait(()=>f.calls.length===1);
  assert.equal(f.calls[0][0],'revit_family_load_job');assert.equal(f.calls[0][2].approvedFamily.job_handle,'job');assert.equal(f.calls[0][2].approvedFamily.save.sha256,'a'.repeat(64));
});

test('family creation in automatic mode still shows exact default dimensions for approval',{skip:!supportsModelPermissionTool('revit_family_create_valve')},async t=>{
  const f=await fixture(t);await choose(f,'automatic');await f.post('turn',{message:'创建族'});
  f.codex.request(1,'revit_family_create_valve',{template_id:'metric-generic-model'});await wait(()=>Boolean(f.app.snapshot('browser').dynamicApproval));const p=f.app.snapshot('browser').dynamicApproval;
  assert.match(p.source,/宿主执行时选择并核验/);assert.match(p.source,/不随项目事务回滚/);assert.match(p.parameters,/"length_mm":300/);assert.match(p.parameters,/"diameter_mm":100/);assert.equal(f.calls.length,0);
  assert.equal((await approve(f,p)).status,200);await wait(()=>f.calls.length===1);assert.equal(f.calls[0][0],'revit_family_create_valve');assert.equal(Object.hasOwn(f.calls[0][1],'mode'),false);
});

test('third-party annotation and schematics never auto-execute and disclose extra effects',async t=>{
  const f=await fixture(t);await choose(f,'automatic');await f.post('turn',{message:'标注和系统图'});
  for(const [id,tool,parameters] of [[1,'revit_smart_annotate',{mode:'rollback',element_ids:[1],view_id:2,tag_type_id:3}],[2,'revit_build_schematic',{mode:'commit',start_element_id:1,schematic_type:'pipe'}]]){
    f.codex.request(id,tool,parameters);await wait(()=>Boolean(f.app.snapshot('browser').dynamicApproval));const p=f.app.snapshot('browser').dynamicApproval;
    assert.equal(p.action,tool);assert.match(p.source,/事务外副作用/);assert.equal(f.calls.length,id-1);
    assert.equal((await approve(f,p)).status,200);await wait(()=>f.calls.length===id);assert.equal(f.calls[id-1][1].mode,parameters.mode);
  }
});

test('a family artifact changed after review cannot be loaded',async t=>{
  const f=await fixture(t);await choose(f,'automatic');await f.post('turn',{message:'加载族'});
  f.codex.request(1,'revit_family_load_job',{job_handle:'job',mode:'commit'});await wait(()=>Boolean(f.app.snapshot('browser').dynamicApproval));const p=f.app.snapshot('browser').dynamicApproval;
  f.changeFamilySha('b'.repeat(64));assert.equal((await approve(f,p)).status,200);await wait(()=>f.codex.answers.length===1);assert.equal(f.calls.length,0);assert.equal(f.codex.answers[0].success,false);
});

test('command page family load requires inspected job, exact artifact and user confirmation',async t=>{
  const f=await fixture(t),id=f.session;await choose(f,'automatic');const args={job_handle:'job',mode:'rollback'};
  assert.equal((await f.post('command',{conversationId:id,commandId:'revit_family_load_job',parameters:args,confirmed:true})).status,403);
  assert.equal((await f.post('command',{conversationId:id,commandId:'revit_family_inspect_job',parameters:{job_handle:'job'}})).status,202);
  await wait(()=>f.app.snapshot('browser').command?.status==='completed');
  assert.equal((await f.post('command',{conversationId:id,commandId:'revit_family_load_job',parameters:args})).status,403);
  assert.equal((await f.post('command',{conversationId:id,commandId:'revit_family_load_job',parameters:args,confirmed:true})).status,202);await wait(()=>f.direct.some(item=>item[0]==='revit_family_load_job'));
  const call=f.direct.find(item=>item[0]==='revit_family_load_job');assert.equal(call[2].approvedFamily.save.sha256,'a'.repeat(64));
});

test('direct command confirmation is waived only for granted ordinary preview or automatic mode',async t=>{
  for(const [level,mode,expected] of [['rollback','rollback',202],['rollback','commit',403],['confirm','rollback',202],['confirm','commit',403],['automatic','commit',202]]){
    const f=await fixture(t),id=f.session;const catalog=await(await fetch(f.origin+'/api/command-catalog')).json();assert.equal(catalog.commands.find(item=>item.tool==='revit_move_elements').effectKind,'model_transaction');
    assert.equal((await choose(f,level)).status,200);
    const response=await f.post('command',{conversationId:id,commandId:'revit_move_elements',parameters:{mode}});assert.equal(response.status,expected,level+' '+mode);
    if(expected===202){await wait(()=>f.direct.length===1);assert.equal(f.direct[0][2].confirmed,true);}
    assert.equal((await f.post('command',{conversationId:id,commandId:'revit_execute_csharp',parameters:{mode:'rollback',code:'return 1;'}})).status,403);
  }
});

test('uncertain model receipt is retained, blocks repeats, and is checked and acknowledged by its owner',async t=>{
  let inspectCount=0,closes=0;const receiptOwner={inspect:async()=>({ok:true,value:{status:'received',terminal:true,requestId:'original',checkedAt:String(++inspectCount),evidence:{requestId:'original'}}}),close:async()=>{closes++;return {ok:true,value:{closed:true}};}};
  const f=await fixture(t,{invoke:async()=>({ok:false,error:{outcome:'unconfirmed'},receiptOwner})});await choose(f,'automatic');await f.post('turn',{message:'开始'});
  f.codex.request(1,'revit_move_elements',{mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}});
  await wait(()=>Boolean(f.app.snapshot('browser').modelReceipt));const r=f.app.snapshot('browser').modelReceipt;
  assert.equal(r.check,null);assert.equal(f.app.snapshot('other').modelReceipt.ticket,r.ticket);
  f.codex.request(2,'revit_move_elements',{mode:'commit'});await wait(()=>f.codex.answers.length===2);assert.equal(f.calls.length,1);
  assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:r.ticket},'other')).status,409);
  assert.equal((await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket:r.ticket,checkRevision:0,confirmed:true})).status,409);
  assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:r.ticket})).status,200);
  const checked=f.app.snapshot('browser').modelReceipt;assert.equal(checked.check.terminal,true);assert.equal(checked.check.requestId,'original');
  assert.equal((await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket:r.ticket,checkRevision:checked.checkRevision,confirmed:true})).status,200);
  assert.equal(f.app.snapshot('browser').modelReceipt,null);assert.equal(closes,1);
});

test('direct write unknown receipt survives until the original terminal result is checked and confirmed',async t=>{
  let closed=0,checked=0;const owner=Object.freeze({inspect:async()=>({ok:true,value:{status:'received',terminal:true,requestId:'original',checkedAt:String(++checked),evidence:{requestId:'original'}}}),close:async()=>{closed++;return {ok:true,value:{closed:true}};}});
  const f=await fixture(t,{directInvoke:async id=>id==='document'?{ok:true,value:{command:id,data:{title:'只读'}}}:{ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',outcome:'unconfirmed',message:'unknown'},receiptOwner:owner}});await choose(f,'automatic');
  assert.equal((await f.post('command',{conversationId:f.session,commandId:'revit_move_elements',parameters:{mode:'commit'}})).status,202);
  await wait(()=>Boolean(f.app.snapshot('browser').modelReceipt));const receipt=f.app.snapshot('browser').modelReceipt;
  assert.equal(closed,0);assert.equal((await f.post('command',{conversationId:f.session,commandId:'revit_move_elements',parameters:{mode:'commit'}})).status,409);assert.equal(closed,0);
  assert.equal((await f.post('new-chat',{})).status,200);const current=f.app.snapshot('browser').session.conversation.id;
  assert.notEqual(current,f.session);assert.equal(f.app.snapshot('browser').modelReceipt.sourceConversationId,f.session);
  assert.equal((await f.post('command',{conversationId:current,commandId:'document',parameters:{}})).status,202);
  await wait(()=>f.app.snapshot('browser').command?.status==='completed');assert.equal(closed,0);
  assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:receipt.ticket})).status,409);
  assert.equal((await f.post('model-receipt/check',{conversationId:current,ticket:receipt.ticket})).status,200);const checkedView=f.app.snapshot('browser').modelReceipt;
  assert.equal((await f.post('model-receipt/acknowledge',{conversationId:current,ticket:receipt.ticket,checkRevision:checkedView.checkRevision,confirmed:true})).status,200);assert.equal(closed,1);assert.equal(f.app.snapshot('browser').modelReceipt,null);
});

test('automatic receipt checks observe late results and retire them without rerunning the model operation',async t=>{
  let terminal=false,reads=0,closes=0;
  const receiptOwner={inspect:async()=>({ok:true,value:{status:terminal?'received':'pending',terminal,requestId:'original',checkedAt:String(++reads)}}),close:async()=>{closes++;return {ok:true,value:{closed:true}};}};
  const f=await fixture(t,{pollDelays:[20,40],invoke:async()=>({ok:false,error:{outcome:'unconfirmed'},receiptOwner})});
  await choose(f,'automatic');await f.post('turn',{message:'开始'});f.codex.request(1,'revit_move_elements',{mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}});
  await wait(()=>f.app.snapshot('browser').modelReceipt?.check?.status==='pending');
  assert.equal(closes,0);assert.equal(f.calls.length,1);assert.equal(f.app.snapshot('browser').modelReceipt.autoCheck.active,true);
  terminal=true;await wait(()=>!f.app.snapshot('browser').modelReceipt);
  assert.equal(closes,1);assert.equal(f.calls.length,1);assert.ok(reads>=3);
  assert.match(f.app.snapshot('browser').session.messages.at(-1).text,/自动核实/);
});

const scriptFailure=()=>({status:'unconfirmed',terminal:false,requestId:'original',recovery:{kind:'script_failure',requiresReview:true,modelRollback:'unknown',externalEffects:'unknown'},evidence:{nativeFailure:{code:'ArgumentNullException',message:'Value cannot be null.',outcome:'failed',phase:'dispatch',started:true,completedUtc:'2026-11-04T10:00:00.000Z',requestId:'original',hostSession:'host'}}});
test('an ended old C# error can be reviewed and recovered from a new conversation without claiming rollback',async t=>{
  let closes=0,reads=0;
  const receiptOwner={inspect:async()=>({ok:true,value:{...scriptFailure(),checkedAt:String(++reads)}}),close:async()=>{closes++;return {ok:true,value:{closed:true}};}};
  const f=await fixture(t,{pollDelays:[20],invoke:async()=>({ok:false,error:{outcome:'unconfirmed'},receiptOwner})});
  await choose(f,'automatic');await f.post('turn',{message:'脚本'});f.codex.request(1,'revit_execute_csharp',{mode:'commit',code:'throw new Exception();'});
  await approve(f,f.app.snapshot('browser').dynamicApproval);await wait(()=>f.app.snapshot('browser').modelReceipt?.check?.recovery?.requiresReview);
  f.codex.emit('notification','turn/completed',{threadId:'thread',turnId:'turn',turn:{id:'turn',status:'completed'}});await wait(()=>!f.app.snapshot('browser').busy);
  const created=await f.post('new-chat',{});assert.equal(created.status,200);const current=created.body.session.conversation.id,r=f.app.snapshot('browser').modelReceipt;
  assert.equal(r.conversationId,current);assert.equal(r.sourceConversationId,f.session);assert.equal(r.autoCheck.active,false);
  assert.equal((await f.post('model-receipt/recover',{conversationId:current,ticket:r.ticket,checkRevision:r.checkRevision,confirmed:false})).status,400);
  assert.equal((await f.post('model-receipt/recover',{conversationId:current,ticket:r.ticket,checkRevision:r.checkRevision-1,confirmed:true})).status,409);
  f.changeDocument({session:'host',path:'C:\\other.rvt',title:'另一模型'});
  assert.equal((await f.post('model-receipt/recover',{conversationId:current,ticket:r.ticket,checkRevision:r.checkRevision,confirmed:true})).status,409);assert.equal(closes,0);
  f.changeDocument({session:'host',path:'C:\\model.rvt',title:'模型'});
  assert.equal((await f.post('model-receipt/recover',{conversationId:current,ticket:r.ticket,checkRevision:r.checkRevision,confirmed:true})).status,200);
  assert.equal(f.app.snapshot('browser').modelReceipt,null);assert.equal(closes,1);assert.equal(f.calls.length,1);
  await f.post('turn',{message:'继续只读核查'});assert.equal(f.calls.length,1);
});

test('verified rollback failures auto recover, while document mismatch and cleanup failures retain the gate for retry',async t=>{
  let failClose=true,closes=0;
  const value={status:'failed_rolled_back',terminal:true,requestId:'original',recovery:{kind:'script_failure',requiresReview:false,modelRollback:'rolled_back',externalEffects:'unknown'}};
  const receiptOwner={inspect:async()=>({ok:true,value}),close:async()=>{closes++;return failClose?{ok:false}:{ok:true,value:{closed:true}};}};
  const f=await fixture(t,{pollDelays:[20,40],invoke:async()=>({ok:false,error:{outcome:'unconfirmed'},receiptOwner})});
  await choose(f,'automatic');await f.post('turn',{message:'脚本'});f.codex.request(1,'revit_execute_csharp',{mode:'commit',code:'throw new Exception();'});
  await approve(f,f.app.snapshot('browser').dynamicApproval);await wait(()=>closes>=1);assert.ok(f.app.snapshot('browser').modelReceipt);
  f.changeDocument({session:'host',path:'C:\\other.rvt',title:'另一模型'});const before=closes;
  await wait(()=>f.app.snapshot('browser').modelReceipt?.autoCheck.attempts>=3);assert.equal(closes,before);
  assert.match(f.app.snapshot('browser').modelReceipt.autoCheck.message,/切回原模型/);
  failClose=false;f.changeDocument({session:'host',path:'C:\\model.rvt',title:'模型'});await wait(()=>!f.app.snapshot('browser').modelReceipt);
  assert.equal(f.calls.length,1);assert.match(f.app.snapshot('browser').session.messages.at(-1).text,/失败.*事务回滚/);
});

test('pending receipts survive creating and selecting saved conversations and remain actionable in the selected chat',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-receipt-history-'));
  const historyStore=createPanelChatStore({stateDirectory:directory});
  let terminal=false;const owner=Object.freeze({inspect:async()=>({ok:true,value:{status:terminal?'received':'pending',terminal,requestId:'original'}}),close:async()=>({ok:true,value:{closed:true}})});
  const f=await fixture(t,{historyStore,directInvoke:async()=>({ok:false,error:{outcome:'unconfirmed',message:'等待回执'},receiptOwner:owner})});
  t.after(async()=>{await f.app.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('buildx-receipt-history-'));await fs.rm(directory,{recursive:true,force:true});});
  await choose(f,'automatic');await f.post('command',{conversationId:f.session,commandId:'revit_move_elements',parameters:{mode:'commit'}});await wait(()=>Boolean(f.app.snapshot('browser').modelReceipt));
  const original=f.app.snapshot('browser').modelReceipt.ticket,created=await f.post('new-chat',{});assert.equal(created.status,200);
  assert.equal(f.app.snapshot('browser').modelReceipt.ticket,original);assert.equal(f.app.snapshot('browser').modelPermission.level,null);
  const selected=await f.post('chat/select',{conversationId:f.session,draft:{text:'',includeSelection:false}});assert.equal(selected.status,200);
  assert.equal(f.app.snapshot('browser').modelReceipt.ticket,original);assert.equal(f.app.snapshot('browser').modelReceipt.conversationId,f.session);
  assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:original})).status,200);
  const r=f.app.snapshot('browser').modelReceipt;
  assert.equal((await f.post('model-receipt/recover',{conversationId:f.session,ticket:original,checkRevision:r.checkRevision,confirmed:true})).status,409);
  const reopened=f.app.snapshot('reopened'),reopenedId=reopened.session.conversation.id;
  assert.equal(reopened.modelReceipt.ticket,original);
  assert.equal((await f.post('model-receipt/check',{conversationId:reopenedId,ticket:original},'reopened')).status,200);
  terminal=true;assert.equal((await f.post('model-receipt/check',{conversationId:reopenedId,ticket:original},'reopened')).status,200);
  const checked=f.app.snapshot('reopened').modelReceipt;
  assert.equal((await f.post('model-receipt/acknowledge',{conversationId:reopenedId,ticket:original,checkRevision:checked.checkRevision,confirmed:true},'reopened')).status,200);
});

test('late script failure after stopping and starting a chat retains its original conversation and recovery owner',async t=>{
  let resolveInvoke,terminal=false,closes=0;
  const invoked=new Promise(resolve=>{resolveInvoke=resolve;}),owner={inspect:async()=>({ok:true,value:terminal?{status:'received',terminal:true,requestId:'original'}:{status:'pending',terminal:false,requestId:'original'}}),close:async()=>{closes++;return {ok:true,value:{closed:true}};}};
  const f=await fixture(t,{pollDelays:[20],invoke:()=>invoked});await choose(f,'automatic');await f.post('turn',{message:'开始'});
  f.codex.request(1,'revit_execute_csharp',{mode:'commit',code:'return 42;'});await approve(f,f.app.snapshot('browser').dynamicApproval);await wait(()=>f.calls.length===1);
  f.codex.emit('notification','turn/completed',{threadId:'thread',turnId:'turn',turn:{id:'turn',status:'interrupted'}});await wait(()=>!f.app.snapshot('browser').busy);
  const created=await f.post('new-chat',{});assert.equal(created.status,200);const current=created.body.session.conversation.id;
  const permission=f.app.snapshot('browser').modelPermission;
  assert.equal((await f.post('model-permission',{conversationId:current,level:'automatic',expectedRevision:permission.revision})).status,200);
  assert.equal((await f.post('command',{conversationId:current,commandId:'revit_move_elements',parameters:{mode:'commit'}})).status,409);assert.equal(f.direct.length,0);
  resolveInvoke({ok:false,error:{outcome:'unconfirmed'},receiptOwner:owner});await wait(()=>Boolean(f.app.snapshot('browser').modelReceipt));
  assert.equal(f.app.snapshot('browser').modelReceipt.sourceConversationId,f.session);assert.equal(f.app.snapshot('browser').modelReceipt.conversationId,current);
  terminal=true;await wait(()=>!f.app.snapshot('browser').modelReceipt);
  assert.equal(closes,1);assert.equal(f.calls.length,1);assert.equal(f.app.snapshot('browser').session.messages.length,0,'late result must not be appended to the new conversation');
});

test('automatic final cleanup retains the write gate until completion and is drained by service close',async t=>{
  let releaseClose,started=false,closes=0;
  const closing=new Promise(resolve=>{releaseClose=resolve;}),owner={inspect:async()=>({ok:true,value:{status:'received',terminal:true,requestId:'original'}}),close:async()=>{started=true;closes++;return closing;}};
  const f=await fixture(t,{pollDelays:[20],invoke:async()=>({ok:false,error:{outcome:'unconfirmed'},receiptOwner:owner})});
  await choose(f,'automatic');await f.post('turn',{message:'开始'});f.codex.request(1,'revit_move_elements',{mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}});await wait(()=>started);
  assert.ok(f.app.snapshot('browser').modelReceipt);f.codex.request(2,'revit_move_elements',{mode:'commit'});await wait(()=>f.codex.answers.length===2);assert.equal(f.calls.length,1);
  let closed=false;const stopped=f.app.close().then(value=>{closed=true;return value;});await tick();assert.equal(closed,false);
  releaseClose({ok:true,value:{closed:true}});assert.deepEqual(await stopped,{closed:true});assert.equal(closes,1);
});

test('UI selection requires explicit confirmation in automatic mode for HTTP and Codex',async t=>{
  const f=await fixture(t);await choose(f,'automatic');const id=f.session;
  for(const [commandId,parameters] of [['revit_set_selection',{element_ids:[1]}],['revit_select_by_unique_ids',{element_uids:['uid-a']}]]){
    const rejected=await f.post('command',{conversationId:id,commandId,parameters});assert.equal(rejected.status,403);assert.equal(f.direct.length,0);
  }
  const accepted=await f.post('command',{conversationId:id,commandId:'revit_set_selection',parameters:{element_ids:[1]},confirmed:true});assert.equal(accepted.status,202);await wait(()=>f.direct.length===1);assert.equal(f.direct[0][1].mode,undefined);await wait(()=>!f.app.snapshot('browser').busy);
  await f.post('turn',{message:'选择测试'});f.codex.request(1,'revit_select_by_unique_ids',{element_uids:['uid-a']});const approval=f.app.snapshot('browser').dynamicApproval;assert.ok(approval);assert.equal(f.calls.length,0);assert.equal((await approve(f,approval,'decline')).status,200);await wait(()=>f.codex.answers.length===1);assert.equal(f.calls.length,0);
});
