import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {panelProfile} from './lib/panel-profile.mjs';
import {PANEL_TOOL_CATALOG} from './lib/panel-catalog.mjs';
import {MODEL_WORKSPACE_TOOLS} from './lib/panel-tools.mjs';
import {createPanelServer} from './lib/panel-server.mjs';
import {MODEL_READONLY_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {READONLY_WORKBENCH_TOOL_NAMES} from './lib/workbench-client.mjs';
import {MODEL_COMMANDS,modelToolCatalog,modelMentionParts} from './public/model-workspace.mjs';
import {createModelWorkspaceFixture} from './test-support/model-workspace-preview.mjs';
import {createReadCommandFixture} from './test-support/read-command-host.mjs';

const root=fileURLToPath(new URL('.',import.meta.url)),profile=MODEL_READONLY_SESSION_PROFILE;
const ordered=values=>[...values].sort();
const wait=async predicate=>{const end=Date.now()+6000;while(!await predicate()){if(Date.now()>end)throw new Error('Read-only composition fixture deadline');await new Promise(resolve=>setTimeout(resolve,10));}};
const draft=(text='',includeSelection=false)=>({text,includeSelection});
async function fixture(t,options){const value=await createModelWorkspaceFixture(options);t.after(()=>value.close());return value;}
async function login(f){const result=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'});assert.equal(result.status,200);return result.cookie;}
async function idle(f,cookie){await wait(async()=>(await f.status(cookie)).busy===false);}
async function chats(f,cookie){const response=await fetch(f.origin+'/api/chats?client=model-test-client',{headers:{Cookie:cookie}});assert.equal(response.status,200);return response.json();}
async function historyFile(directory,id){for(const name of await fs.readdir(directory,{recursive:true}))if(path.basename(name)===id+'.jsonl')return path.join(directory,name);throw new Error('Missing saved conversation');}

test('read-only panel catalog is the immutable named subset and keeps the original model capabilities',()=>{
  const legacy=panelProfile(),readonly=panelProfile(profile);
  assert.equal(legacy,panelProfile('model'));assert.equal(legacy.catalog.length,MODEL_WORKSPACE_TOOLS.length);
  assert.deepEqual(readonly.workspace,{kind:'model',supportsModelContext:true});
  assert.equal(readonly.workspace,legacy.workspace);
  assert.ok(Object.isFrozen(readonly)&&Object.isFrozen(readonly.catalog));
  assert.deepEqual(ordered(readonly.catalog.map(tool=>tool.name)),ordered(READONLY_WORKBENCH_TOOL_NAMES));
  for(const tool of readonly.catalog){assert.equal(tool.readOnly,true);assert.ok(Object.isFrozen(tool));assert.deepEqual(tool,PANEL_TOOL_CATALOG.find(candidate=>candidate.name===tool.name));}
  for(const key of ['cancelMessage','interruptUnconfirmed','interruptTimeout','stopUnknown'])assert.equal(readonly[key],legacy[key]);
  assert.equal(panelProfile('source-development').catalog.length,6);
  assert.deepEqual(MODEL_COMMANDS.map(command=>command.id),['document','selection','levels','search']);
});

test('read-only wrapper rejects legacy, unknown or mutable Codex metadata before creating a server',()=>{
  const metadata=(id=profile,names=READONLY_WORKBENCH_TOOL_NAMES)=>Object.freeze({id,toolNames:Object.freeze([...names])});
  const wrong=[undefined,metadata('model',PANEL_TOOL_CATALOG.map(tool=>tool.name)),metadata('source-development'),
    metadata(profile,READONLY_WORKBENCH_TOOL_NAMES.slice(1)),metadata(profile,[...READONLY_WORKBENCH_TOOL_NAMES,'revit_execute_csharp']),
    metadata(profile,[...READONLY_WORKBENCH_TOOL_NAMES.slice(0,3),READONLY_WORKBENCH_TOOL_NAMES[0]]),
    {id:profile,toolNames:READONLY_WORKBENCH_TOOL_NAMES},Object.freeze({id:profile,toolNames:[...READONLY_WORKBENCH_TOOL_NAMES]})];
  for(const value of wrong)assert.throws(()=>createPanelServer({root,profile,codex:{profile:value,state:{mode:'document-workbench'}},invokeWorkbench:async()=>{}}),/exact named four-tool/);
  for(const mode of [undefined,'source-development','customer-chat'])assert.throws(()=>createPanelServer({root,profile,codex:{profile:metadata(),state:{mode}},invokeWorkbench:async()=>{}}),/exact named four-tool/);
  let observed=0;
  const accessor=Object.freeze({get id(){observed++;return profile;},toolNames:READONLY_WORKBENCH_TOOL_NAMES});
  assert.throws(()=>createPanelServer({root,profile,codex:{profile:accessor,state:{mode:'document-workbench'}},invokeWorkbench:async()=>{}}),/exact named four-tool/);
  assert.equal(observed,0);
});

test('read-only HTTP never dispatches write commands even with explicit confirmation',async t=>{
  const invoked=[];
  const f=await fixture(t,{profile,required:false,invokeReadonlyCommand:async(id,parameters)=>{
    invoked.push({id,parameters});throw new Error('A disallowed command reached the executor');
  }});
  const conversationId=f.app.snapshot('model-test-client').session.conversation.id;
  const forbidden=['revit_execute_csharp','revit_set_parameters','revit_move_elements','revit_save_command',
    'revit_run_command','revit_family_create_valve','revit_family_create_cabinet','revit_family_save_cabinet','revit_family_close_cabinet','revit_export_schematic'];
  for(const commandId of forbidden){
    const result=await f.post('command',{conversationId,commandId,parameters:{mode:'commit',code:'return 1;'},confirmed:true});
    assert.equal(result.status,400,commandId);
  }
  assert.deepEqual(invoked,[]);
  assert.deepEqual(f.workbenchCalls,[]);
  assert.equal(f.codex.turns.length,0);
});

test('production HTTP exposes only the selected catalog and retains model layout versus source/customer boundaries',async t=>{
  for(const [name,count,model] of [[profile,4,true],['model',MODEL_WORKSPACE_TOOLS.length,true],['source-development',6,false],['customer-chat',0,false]])await t.test(name,async t=>{
    const f=await fixture(t,{profile:name}),status=await f.status();
    assert.equal(status.toolCount,count);assert.equal(status.toolCatalog.length,count);
    assert.deepEqual(status.workspace,{kind:model?'model':name,supportsModelContext:model});
    assert.notEqual(status.directCommandsAvailable,true);
    const html=await fetch(f.origin+'/').then(response=>response.text());
    for(const file of ['model-workspace.mjs','model-workspace.css']){assert.equal(html.includes('/'+file),model);assert.equal((await fetch(f.origin+'/'+file)).status,model?200:404);}
    if(name===profile){
      assert.equal(f.codex.profile.id,profile);assert.ok(Object.isFrozen(f.codex.profile)&&Object.isFrozen(f.codex.profile.toolNames));
      const catalog=modelToolCatalog(status.toolCatalog);
      assert.deepEqual(ordered(catalog.map(tool=>tool.name)),ordered(READONLY_WORKBENCH_TOOL_NAMES));
      for(const tool of READONLY_WORKBENCH_TOOL_NAMES)assert.equal(modelMentionParts('@'+tool,catalog).filter(part=>part.tool).length,1);
      assert.equal(modelMentionParts('@revit_execute_csharp @revit_run_command',catalog).some(part=>part.tool),false);
    }
    assert.equal(f.codex.turns.length,0);assert.equal(f.workbenchCalls.length,0);
  });
});

test('read-only model keeps account/context/chat/command/history owners across local reopening',{timeout:30000},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-readonly-composition-')),owners=[];
  t.after(async()=>{for(const owner of owners)await owner.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('buildx-readonly-composition-'));await fs.rm(directory,{recursive:true,force:true});});
  const f=await createReadCommandFixture({directory,profile,timeout:1500});owners.push(f);
  assert.equal((await f.post('turn',{message:'blocked'})).status,401);
  assert.equal((await f.events()).response.status,401);
  const cookie=await login(f),id=f.app.snapshot('model-test-client').session.conversation.id;
  assert.equal((await f.status(cookie)).ready,false);
  assert.equal((await f.post('context',{includeSelection:true},cookie)).status,403);
  assert.equal((await f.post('command',{conversationId:id,commandId:'document',parameters:{}},cookie)).status,403);
  assert.equal((await f.post('turn',{message:'blocked'},cookie,{'X-Local-Chat':'forged'})).status,403);
  assert.equal((await f.confirm(cookie)).status,200);
  const stream=await f.events(cookie),initial=await stream.next();assert.equal(initial.event,'snapshot');
  assert.equal(initial.data.state.workspace.kind,'model');assert.equal(initial.data.state.directCommandsAvailable,true);
  assert.equal(initial.data.history.available,true);
  const original='原问题：保留引用 [资料](D:/reference.md)';
  assert.equal((await f.post('turn',{message:original,context:{includeDocument:false,includeSelection:true}},cookie)).status,202);
  assert.match(f.codex.turns[0].text,/"elementIds":\["42","84"\]/);
  assert.deepEqual(f.workbenchCalls.map(call=>call.name),['revit_workbench_status','revit_get_selection','revit_workbench_status']);
  f.codex.finish(0,'completed','原回复：只读查询已完成。');await idle(f,cookie);
  const savedDraft=draft('保留 @revit_list_levels 草稿',true);
  assert.equal((await f.post('chat/draft',{conversationId:id,draft:savedDraft},cookie)).status,200);
  const historyDirectory=path.join(f.queueRoot,'history'),filename=await historyFile(historyDirectory,id),before=await fs.readFile(filename);
  const beforeView=structuredClone(f.app.snapshot('model-test-client').session);
  for(const commandId of ['document','selection','levels','search']){
    const accepted=await f.post('command',{conversationId:id,commandId,parameters:commandId==='search'?{keyword:'',category:'walls'}:{}},cookie);
    assert.equal(accepted.status,202);assert.equal(accepted.body.result,undefined);
    let terminal;
    do{terminal=await stream.next();}while(terminal.data.command?.executionId!==accepted.body.executionId||['running','stopping'].includes(terminal.data.command.status));
    assert.equal(terminal.data.command.status,'completed');assert.equal(terminal.data.command.result.command,commandId);await idle(f,cookie);
  }
  assert.equal(f.codex.turns.length,1);assert.equal(f.codex.threads,1);assert.equal(f.codex.interrupts.length,0);
  assert.deepEqual(f.app.snapshot('model-test-client').session,beforeView);
  assert.ok((await fs.readFile(filename)).equals(before));
  assert.deepEqual((await f.historyStore.get('model:user:11111111-1111-1111-1111-111111111111',id)).draft,savedDraft);
  const created=await f.post('new-chat',{draft:savedDraft},cookie);assert.equal(created.status,200);
  const second=created.body.session.conversation.id;assert.notEqual(second,id);
  const selected=await f.post('chat/select',{conversationId:id,draft:draft('第二个会话草稿')},cookie);assert.equal(selected.status,200);
  assert.deepEqual(selected.body.session.messages,beforeView.messages);assert.deepEqual(selected.body.draft,savedDraft);
  assert.ok((await chats(f,cookie)).sessions.some(item=>item.id===id));
  await f.close();
  const reopened=await fixture(t,{profile,historyDirectory});owners.push(reopened);
  const nextCookie=await login(reopened),history=await chats(reopened,nextCookie);
  assert.ok(history.sessions.some(item=>item.id===id));assert.ok(history.sessions.some(item=>item.id===second));
  const restored=await reopened.post('chat/select',{conversationId:id,draft:draft()},nextCookie);assert.equal(restored.status,200);
  assert.equal(restored.body.session.conversation.readOnly,true);
  assert.equal(restored.body.session.conversation.threadBinding.persistedResumeVerified,false);
  assert.deepEqual(restored.body.session.messages,beforeView.messages);assert.deepEqual(restored.body.draft,savedDraft);
  assert.equal(reopened.codex.turns.length,0);assert.equal(reopened.codex.threads,0);
  assert.ok((await fs.readFile(filename)).equals(before));
});
