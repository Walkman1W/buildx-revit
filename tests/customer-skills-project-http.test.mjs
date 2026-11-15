import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {CodexClient} from '../lib/codex-client.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';

// Real panel and project service, simulated Codex protocol/account only.
test('customer skill requires a selected library and invalidates selection when library roots change',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-skills-project-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.writeFile(path.join(directory,'design.txt'),'示例项目资料');
  const root=process.cwd(),client=new CodexClient(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE},{skillCatalogMode:'customer'});
  const child=new EventEmitter(),connection={child,generation:1,phase:'ready',closed:false,fault:null,delays:new Set()};
  client._generation=1;client._connection=connection;client.child=child;client.initialized=true;client.authReady=true;client.toolsReady=true;
  client._accountStatus='verified';client._accountObservation={connectionGeneration:1,accountRevision:0};client._accountSequence=1;client._accountObservedAt=new Date().toISOString();
  const sent=[];
  client.request=async method=>method==='skills/list'?{data:[{cwd:root,errors:[],skills:[
    {name:'buildx-project-research',description:'product',enabled:true,scope:'repo',path:path.join(root,'.agents','skills','buildx-project-research','SKILL.md')},
    {name:'private',description:'private details',enabled:true,scope:'user',path:path.resolve('private','SKILL.md')},
  ]}]}:{};
  client.refreshAccount=async()=>{client._accountSequence++;client._accountObservedAt=new Date().toISOString();return {...client.state.codexAccount,type:'chatgpt',email:'fixture@example.invalid',planType:'free'};};
  client.newThread=async()=> 'thread';
  client.turn=async(...args)=>{client.assertSkillSelection(args[5]);sent.push(args);return {turn:{id:'turn'}};};
  client.close=async()=>({closed:true});
  const f=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,codexClient:client});
  t.after(()=>f.close());
  const login=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'}),cookie=login.cookie;
  const inspected=await f.post('codex-account/inspect',{},cookie);assert.equal(inspected.status,200,JSON.stringify(inspected.body));
  assert.equal((await f.post('codex-account/confirm',{challengeId:inspected.body.challengeId},cookie)).status,200);
  const conversationId=f.app.snapshot('model-test-client').session.conversation.id;
  const skills=()=>f.post('skills',{conversationId},cookie);
  const before=await skills();assert.equal(before.status,200);assert.equal(before.body.skills[0].selectable,false);
  const added=await f.post('project-files',{action:'add-root',parameters:{path:directory,kind:'directory'}},cookie);
  assert.equal(added.status,200,JSON.stringify(added.body));let rootId=added.body.value.root.id;
  // A root removed after readiness was observed must not publish a stale usable skill.
  const request=client.request;let release,entered;const started=new Promise(resolve=>{entered=resolve;}),wait=new Promise(resolve=>{release=resolve;});
  client.request=async method=>{if(method==='skills/list'){entered();await wait;}return request(method);};
  const pending=skills();await started;
  assert.equal((await f.post('project-files',{action:'remove-root',parameters:{id:rootId}},cookie)).status,200);
  release();assert.equal((await pending).status,409);
  client.request=request;
  const afterStale=await f.post('project-files',{action:'add-root',parameters:{path:directory,kind:'directory'}},cookie);
  assert.equal(afterStale.status,200);rootId=afterStale.body.value.root.id;
  const found=await skills();assert.equal(found.status,200);const skill=found.body.skills[0];
  assert.equal(skill.availability,'available');assert.equal(skill.selectable,true);assert.doesNotMatch(JSON.stringify(found.body),/private|SKILL\.md/);
  assert.equal((await f.post('turn',{conversationId,message:'查找示例',skillIds:[skill.id]},cookie)).status,202);
  assert.equal(sent.length,1);client.emit('notification','turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed'}});
  const again=await skills(),old=again.body.skills[0];assert.equal(old.selectable,true);
  assert.equal((await f.post('project-files',{action:'remove-root',parameters:{id:rootId}},cookie)).status,200);
  assert.ok(f.app.snapshot('model-test-client').state.skillsRevision>again.body.revision);
  assert.equal((await f.post('turn',{conversationId,message:'使用旧技能',skillIds:[old.id]},cookie)).status,409);
  assert.equal((await skills()).body.skills[0].selectable,false);
  const readded=await f.post('project-files',{action:'add-root',parameters:{path:directory,kind:'directory'}},cookie);
  assert.equal(readded.status,200);const replacementRootId=readded.body.value.root.id;
  const replacement=(await skills()).body.skills[0];assert.equal(replacement.selectable,true);
  // A selected address is an index, not proof that its contents remain readable.
  await fs.rename(directory,directory+'-moved');t.after(()=>fs.rm(directory+'-moved',{recursive:true,force:true}));
  const missing=await f.post('project-files',{action:'read-file',parameters:{rootId:replacementRootId,path:'design.txt'}},cookie);
  assert.equal(missing.status,400);assert.equal(missing.body.ok,false);
  assert.equal((await skills()).body.skills[0].selectable,true);
  assert.equal(sent.length,1);
});
