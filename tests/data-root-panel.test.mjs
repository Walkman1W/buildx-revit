import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {createPanelServer} from '../lib/panel-server.mjs';
import {createPanelChatStore} from '../lib/chat-store.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const wait=async predicate=>{const end=Date.now()+6000;while(!await predicate()){if(Date.now()>end)throw new Error('Data-root fixture timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
class CodexFixture extends EventEmitter{
  constructor(root){super();this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.answers=[];}
  async newThread(){return 'data-root-thread';}async turn(){return {turn:{id:'data-root-turn'}};}async interrupt(){}async close(){return {closed:true};}
  inspect(){let live=true;this.emit('dynamic-tool-request',{id:1,generation:1,revision:2,params:Object.freeze({threadId:'data-root-thread',turnId:'data-root-turn',callId:'data-root-call',tool:'buildx_model_operation',arguments:Object.freeze({tool:'revit_inspect_elements',parameters:{element_ids:[42]}})}),respond:result=>{if(!live)return false;live=false;this.answers.push(result);return true;},reject:()=>{live=false;},discard:()=>{live=false;}});}
  finish(){this.emit('notification','turn/completed',{threadId:'data-root-thread',turnId:'data-root-turn',turn:{id:'data-root-turn',status:'completed'}});}
}
async function fixture(t,{captureUnderProgram=false}={}){
  const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-data-root-panel-')),root=path.join(sandbox,'program'),dataRoot=path.join(sandbox,'data');
  await fs.mkdir(path.join(root,'public'),{recursive:true});await fs.mkdir(path.join(dataRoot,'public'),{recursive:true});
  await fs.writeFile(path.join(root,'public','app.js'),'/* program resource */');await fs.writeFile(path.join(dataRoot,'public','app.js'),'/* unrelated data resource */');
  const host='c'.repeat(32),request=randomUUID(),imageId=randomUUID(),captureRoot=captureUnderProgram?root:dataRoot;
  const folder=path.join(captureRoot,'workbench','visual-captures',host,request),filename=path.join(folder,imageId+'.png');
  await fs.mkdir(folder,{recursive:true});await fs.writeFile(filename,png);
  const document={session:host,title:'Data-root model fixture',path:'D:\\data-root-fixture.rvt'};
  const receipt={operation:'inspect_elements',hostSession:host,document:{title:document.title,path:document.path},request_id:request,value:{schema_version:1,operation:'inspect_elements',host_session:host,document:{title:document.title,path:document.path},success:true,cleanup_pending:false,target_ids:[42],context_ids:[],images:[{artifact_id:imageId,request_id:request,path:filename,sha256:createHash('sha256').update(png).digest('hex'),bytes:png.length,width:1,height:1,view_id:100,view_name:'Controlled view',orientation:'isometric',captured_at:new Date().toISOString()}],restoration:{status:'restored',session_handle:null,source_view_unchanged:true},outcome:'captured_restored',code:'VISUAL_INSPECTION_COMPLETED'}};
  const codex=new CodexFixture(root),store=createPanelChatStore({stateDirectory:path.join(dataRoot,'runtime-history')});
  const modelPermissionServices=Object.freeze({observeDocument:async()=>({...document}),readCommand:async()=>{throw new Error('No command access');},inspectFamilyJob:async()=>{throw new Error('No family access');},invoke:async()=>({ok:true,value:receipt})});
  const app=createPanelServer({root,dataRoot,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,historyStore:store,modelPermissionServices,invokeWorkbench:async()=>{throw new Error('No real Revit access');}});
  t.after(async()=>{await app.close();const resolved=path.resolve(sandbox);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('buildx-data-root-panel-'));await fs.rm(resolved,{recursive:true,force:true});});
  const {origin}=await app.listen(),status=await(await fetch(origin+'/api/status')).json();
  const post=async(route,data={})=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'X-Local-Chat':status.csrf,'Content-Type':'application/json'},body:JSON.stringify({client:'data-root-browser',...data})});return response;};
  const conversationId=app.snapshot('data-root-browser').session.conversation.id;
  async function inspect(){assert.equal((await post('model-permission',{conversationId,level:'automatic',expectedRevision:0})).status,200);assert.equal((await post('turn',{conversationId,message:'Inspect the controlled fixture'})).status,202);codex.inspect();await wait(()=>codex.answers.length===1);}
  return {root,dataRoot,filename,app,codex,store,origin,post,conversationId,inspect};
}

test('program assets and data-root native captures remain separate through public HTTP',async t=>{
  const f=await fixture(t);
  const asset=await fetch(f.origin+'/app.js');assert.equal(asset.status,200);assert.equal(await asset.text(),'/* program resource */');
  await f.inspect();assert.equal(f.codex.answers[0].success,true);
  assert.ok(f.codex.answers[0].contentItems.some(item=>item.type==='inputImage'&&item.imageUrl==='data:image/png;base64,'+png.toString('base64')));
  const message=f.app.snapshot('data-root-browser').session.messages.find(item=>item.role==='assistant');assert.equal(message.attachments.length,1);
  const binding={conversationId:f.conversationId,messageId:message.id,attachmentId:message.attachments[0].id};
  const image=await f.post('chat/attachment',binding);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  assert.equal((await f.post('chat/attachment',{...binding,dataRoot:f.root})).status,400);
  assert.equal((await f.post('chat/attachment',{...binding,accountScope:'foreign-account'})).status,400);
  assert.equal((await f.store.readTurnAttachment('foreign-account',binding.attachmentId)).ok,false);
  assert.deepEqual((await fs.readdir(f.root)).sort(),['public']);
  assert.ok((await fs.readdir(f.dataRoot)).includes('runtime-history'));
  f.codex.finish();await wait(()=>f.app.snapshot('data-root-browser').busy===false);
});

test('a valid-looking capture under the program root cannot become a data-root image',async t=>{
  const f=await fixture(t,{captureUnderProgram:true});await f.inspect();
  const result=f.codex.answers[0];assert.equal(result.success,false);assert.equal(result.contentItems.some(item=>item.type==='inputImage'),false);
  assert.equal(JSON.parse(result.contentItems[0].text).status,'visual_review_incomplete');
  assert.equal(f.app.snapshot('data-root-browser').session.messages.find(item=>item.role==='assistant').attachments,undefined);
  f.codex.finish();await wait(()=>f.app.snapshot('data-root-browser').busy===false);
});
