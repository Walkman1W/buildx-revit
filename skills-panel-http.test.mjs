import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createPanelServerCore} from './lib/panel-server-core.mjs';
import {panelProfile} from './lib/panel-profile.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';

const first='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',second='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
class Codex extends EventEmitter{
  constructor(){super();this.profile={id:'model-workspace'};this.state={ready:true,error:false,service:'revit-local-codex',mode:'document-workbench',connectionGeneration:1,codexAccount:{status:'verified',connectionGeneration:1,accountRevision:0}};this.ids=[];this.turns=[];}
  async listSkills(){this.ids=[];this.emit('skills-changed');this.ids=[this.count++?second:first];return [{id:this.ids[0],name:'Example',description:'Test skill'}];}
  count=0;
  assertSkillSelection(ids){if(ids.some(id=>!this.ids.includes(id)))throw Object.assign(new Error('expired'),{notSent:true});}
  async newThread(){return 'thread-1';}
  async turn(...args){this.turns.push(args);return {turn:{id:'turn-1'}};}
  async close(){return {closed:true};}
}

test('HTTP skills selection is limited to the observed conversation, rejects paths and expires on change',async t=>{
  const codex=new Codex(),app=createPanelServerCore({root:process.cwd(),codex,selection:panelProfile(MODEL_WORKSPACE_SESSION_PROFILE),port:0,invokeWorkbench:async()=>{throw new Error('no model access');}});
  const {origin}=await app.listen();t.after(async()=>{if(app.snapshot('a').busy)codex.emit('notification','turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}});await app.close();});
  const state=await (await fetch(origin+'/api/status')).json(),conversation=app.snapshot('a').session.conversation.id;
  const post=async(route,input,extra={})=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Chat':state.csrf,...extra},body:JSON.stringify(input)});return {status:response.status,body:await response.json()};};
  assert.equal((await post('skills',{client:'a',conversationId:conversation},{Origin:'https://foreign.invalid'})).status,403);
  assert.equal((await post('skills',{client:'a',conversationId:conversation,path:'C:\\secret\\SKILL.md'})).status,400);
  assert.equal((await post('skills',{client:'a',conversationId:'other'})).status,409);
  const list=await post('skills',{client:'a',conversationId:conversation});assert.equal(list.status,200);assert.deepEqual(list.body.skills,[{id:first,name:'Example',description:'Test skill'}]);assert.doesNotMatch(JSON.stringify(list.body),/SKILL\.md/);
  assert.equal((await post('turn',{client:'a',conversationId:conversation,message:'test',skillIds:['C:\\secret\\SKILL.md']})).status,400);
  const other=app.snapshot('b').session.conversation.id;
  assert.equal((await post('turn',{client:'b',conversationId:other,message:'test',skillIds:[first]})).status,409);
  codex.ids=[];codex.emit('skills-changed');
  assert.equal((await post('turn',{client:'a',conversationId:conversation,message:'test',skillIds:[first]})).status,409);assert.equal(codex.turns.length,0);
  const refresh=await post('skills',{client:'a',conversationId:conversation});assert.equal(refresh.body.skills[0].id,second);
  const accepted=await post('turn',{client:'a',conversationId:conversation,message:'test',skillIds:[second]});assert.equal(accepted.status,202);assert.deepEqual(codex.turns[0][5],[second]);
});

test('a skill invalidated during context capture is never sent to the native turn',async t=>{
  const codex=new Codex();let release,entered;const wait=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const app=createPanelServerCore({root:process.cwd(),codex,selection:panelProfile(MODEL_WORKSPACE_SESSION_PROFILE),port:0,invokeWorkbench:async()=>{entered();await wait;return {hostSession:'host',document:{title:'test',path:'D:\\model.rvt'}};}});
  const {origin}=await app.listen();t.after(()=>app.close());
  const state=await (await fetch(origin+'/api/status')).json(),conversationId=app.snapshot('a').session.conversation.id;
  const post=async(route,input)=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Chat':state.csrf},body:JSON.stringify(input)});return {status:response.status,body:await response.json()};};
  assert.equal((await post('skills',{client:'a',conversationId})).status,200);
  const pending=post('turn',{client:'a',conversationId,message:'test',skillIds:[first],context:{includeDocument:true,includeSelection:false}});
  await started;codex.ids=[];codex.emit('skills-changed');release();
  const result=await pending;assert.equal(result.status,502);assert.equal(codex.turns.length,0);
});
