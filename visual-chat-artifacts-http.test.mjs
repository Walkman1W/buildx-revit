import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {createPanelServer} from './lib/panel-server.mjs';
import {createPanelChatStore} from './lib/chat-store.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const wait=async predicate=>{const end=Date.now()+6000;while(!await predicate()){if(Date.now()>end)throw new Error('Controlled visual fixture timeout');await new Promise(resolve=>setTimeout(resolve,5));}};
class Fake extends EventEmitter{
  constructor(root){super();this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.answers=[];this.rejected=0;}
  async newThread(){return 'visual-thread';}async turn(){return {turn:{id:'visual-turn'}};}async interrupt(){}async close(){return {closed:true};}
  request(tool,parameters){let live=true;this.emit('dynamic-tool-request',{id:1,generation:1,revision:2,params:Object.freeze({threadId:'visual-thread',turnId:'visual-turn',callId:'visual-call',tool:'buildx_model_operation',arguments:Object.freeze({tool,parameters})}),respond:result=>{if(!live)return false;live=false;this.answers.push(result);return true;},reject:()=>{live=false;this.rejected++;},discard:()=>{live=false;this.rejected++;}});}
  finish(){this.emit('notification','turn/completed',{threadId:'visual-thread',turnId:'visual-turn',turn:{id:'visual-turn',status:'completed'}});}
}
async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-visual-chat-')),host='a'.repeat(32),request=randomUUID(),id=randomUUID(),folder=path.join(root,'workbench','visual-captures',host,request),filename=path.join(folder,id+'.png');
  await fs.mkdir(folder,{recursive:true});await fs.writeFile(filename,png);
  const document={session:host,title:'测试模型',path:'D:\\visual-model.rvt'};
  const receipt={operation:'inspect_elements',hostSession:host,document:{title:document.title,path:document.path},request_id:request,value:{schema_version:1,operation:'inspect_elements',host_session:host,document:{title:document.title,path:document.path},success:true,cleanup_pending:false,target_ids:[42],context_ids:[],images:[{artifact_id:id,request_id:request,path:filename,sha256:createHash('sha256').update(png).digest('hex'),bytes:png.length,width:1,height:1,view_id:100,view_name:'临时检查',orientation:'isometric',captured_at:new Date().toISOString()}],restoration:{status:'restored',session_handle:null,source_view_unchanged:true},outcome:'captured_restored',code:'VISUAL_INSPECTION_COMPLETED'}};
  const owners=[];
  const open=async()=>{
    const codex=new Fake(root),store=createPanelChatStore({stateDirectory:path.join(root,'history')});
    if(options.modelPolicy)codex.assertModelSelection=options.modelPolicy;
    const services=Object.freeze({observeDocument:async()=>({...document}),readCommand:async()=>{throw new Error('Unexpected command read');},inspectFamilyJob:async()=>{throw new Error('Unexpected family read');},invoke:async(...args)=>options.invoke?options.invoke(receipt,...args):{ok:true,value:receipt}});
    const app=createPanelServer({root,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,modelPermissionServices:services,historyStore:store,invokeWorkbench:async()=>{throw new Error('Unexpected real Revit read');}});
    const {origin}=await app.listen(),status=await(await fetch(origin+'/api/status')).json();
    const post=async(route,data={})=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'X-Local-Chat':status.csrf,'Content-Type':'application/json'},body:JSON.stringify({client:'visual-browser',...data})});return {status:response.status,body:await response.json()};};
    const image=async data=>{const response=await fetch(origin+'/api/chat/attachment',{method:'POST',headers:{Origin:origin,'X-Local-Chat':status.csrf,'Content-Type':'application/json'},body:JSON.stringify({client:'visual-browser',...data})});return {status:response.status,type:response.headers.get('content-type'),bytes:Buffer.from(await response.arrayBuffer())};};
    const f={root,app,codex,post,image,store,origin,receipt,filename,model:options.model,conversationId:app.snapshot('visual-browser').session.conversation.id,close:()=>app.close()};owners.push(f);return f;
  };
  t.after(async()=>{for(const f of owners)await f.close();assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('buildx-visual-chat-'));await fs.rm(root,{recursive:true,force:true});});
  return {open,receipt,filename};
}
async function start(f){assert.equal((await f.post('model-permission',{conversationId:f.conversationId,level:'automatic',expectedRevision:0})).status,200);assert.equal((await f.post('turn',{conversationId:f.conversationId,message:'检查刚创建的元素',...(f.model?{model:f.model}:{})})).status,202);f.codex.request('revit_inspect_elements',{element_ids:[42]});}

test('native PNG becomes dynamic model image, assistant attachment and persisted history image through public HTTP',async t=>{
  const {open}=await fixture(t),f=await open();await start(f);await wait(()=>f.codex.answers.length===1);
  const response=f.codex.answers[0];assert.equal(response.success,true);assert.deepEqual(response.contentItems.filter(item=>item.type==='inputImage'),[{type:'inputImage',imageUrl:'data:image/png;base64,'+png.toString('base64')}]);
  const text=JSON.parse(response.contentItems[0].text);assert.equal(text.visualReview.status,'images_ready');assert.equal(JSON.stringify(text).includes(f.filename),false);
  const message=f.app.snapshot('visual-browser').session.messages.find(item=>item.role==='assistant');assert.equal(message.attachments.length,1);assert.equal(Object.hasOwn(message.attachments[0],'data'),false);
  const binding={conversationId:f.conversationId,messageId:message.id,attachmentId:message.attachments[0].id};
  const image=await f.image(binding);assert.equal(image.status,200);assert.equal(image.type,'image/png');assert.deepEqual(image.bytes,png);
  assert.equal((await f.image({...binding,messageId:randomUUID()})).status,404);
  f.codex.finish();await wait(()=>f.app.snapshot('visual-browser').busy===false);await f.close();const reopened=await open();
  const selected=await reopened.post('chat/select',{conversationId:binding.conversationId,draft:{text:'',includeSelection:false}});assert.equal(selected.status,200);assert.equal(selected.body.session.conversation.readOnly,true);assert.deepEqual((await reopened.image(binding)).bytes,png);
});

test('a changed native screenshot is explicit incomplete visual review and cannot create an assistant attachment',async t=>{
  const {open,filename}=await fixture(t);await fs.writeFile(filename,Buffer.alloc(png.length));const f=await open();await start(f);await wait(()=>f.codex.answers.length===1);
  assert.equal(f.codex.answers[0].success,false);assert.equal(f.codex.answers[0].contentItems.length,1);assert.equal(JSON.parse(f.codex.answers[0].contentItems[0].text).status,'visual_review_incomplete');assert.equal(f.app.snapshot('visual-browser').session.messages.find(item=>item.role==='assistant').attachments,undefined);
  f.codex.finish();await wait(()=>f.app.snapshot('visual-browser').busy===false);
});

test('connection changes while native completion is pending discard the old images before chat admission',async t=>{
  let complete,entered=false;const {open}=await fixture(t,{invoke:receipt=>{entered=true;return new Promise(resolve=>{complete=()=>resolve({ok:true,value:receipt});});}}),f=await open();await start(f);await wait(()=>entered);
  f.codex.state={...f.codex.state,connectionGeneration:2};complete();await wait(()=>f.codex.rejected>0||f.codex.answers.length>0);
  assert.equal(f.codex.answers.some(answer=>answer.contentItems?.some(item=>item.type==='inputImage')),false);assert.equal(f.app.snapshot('visual-browser').session.messages.find(item=>item.role==='assistant').attachments,undefined);
  const pending=f.app.snapshot('visual-browser').modelReceipt;assert.ok(pending);
  assert.equal((await f.post('model-receipt/check',{conversationId:f.conversationId,ticket:pending.ticket})).status,200);
  const checked=f.app.snapshot('visual-browser').modelReceipt;assert.equal(checked.check.terminal,true);
  assert.equal((await f.post('model-receipt/acknowledge',{conversationId:f.conversationId,ticket:pending.ticket,checkRevision:checked.checkRevision,confirmed:true})).status,200);
  f.codex.finish();await wait(()=>f.app.snapshot('visual-browser').busy===false);
});

test('a selected model without image capability never receives a native screenshot as visual evidence',async t=>{
  const {open}=await fixture(t,{model:'text-only-fixture',modelPolicy:(model,{requiresImages=false}={})=>{assert.equal(model,'text-only-fixture');if(requiresImages)throw new Error('所选模型不支持图片。');}}),f=await open();await start(f);await wait(()=>f.codex.answers.length===1);
  assert.equal(f.codex.answers[0].success,false);assert.match(f.codex.answers[0].contentItems[0].text,/不支持图片/);assert.equal(f.codex.answers[0].contentItems.some(item=>item.type==='inputImage'),false);assert.equal(f.app.snapshot('visual-browser').session.messages.find(item=>item.role==='assistant').attachments,undefined);
  f.codex.finish();await wait(()=>f.app.snapshot('visual-browser').busy===false);
});
