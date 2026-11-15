import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from '../lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';
import {ACCESS_FILE_TOOLS} from '../lib/access-file-tools.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const tool=Object.freeze({type:'function',name:'buildx_test',description:'test',inputSchema:Object.freeze({type:'object',properties:Object.freeze({}),additionalProperties:false})});
class Fake extends EventEmitter{
  constructor(){super();this.profile=Object.freeze({...createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE}),dynamicTools:Object.freeze([tool])});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.answers=[];this.rejects=0;this.discards=0;}
  async newThread(){return 'thread';}
  async turn(){this.early?.();return {turn:{id:'turn'}};}
  async interrupt(){}
  async close(){return {closed:true};}
  request(id=42,overrides={}){
    let live=true;const params=Object.freeze({threadId:'thread',turnId:'turn',callId:'call-'+id,tool:'buildx_test',arguments:Object.freeze({value:'original'}),...overrides});
    this.emit('dynamic-tool-request',{id,generation:1,revision:2,params,respond:value=>{if(!live)return false;live=false;this.answers.push(value);return true;},reject:()=>{if(live){live=false;this.rejects++;}},discard:()=>{if(live){live=false;this.discards++;}}});
  }
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,{lifetime=60000,work=async()=>({success:true,contentItems:[{type:'inputText',text:'completed'}]}),closeWork=async()=>({closed:true})}={}){
  const codex=new Fake(),calls=[],cancels=[],prepared=[];let finishClose=false;
  const owner=Object.freeze({
    propose({params,scope,isCurrent}){prepared.push({params,scope,isCurrent});return Object.freeze({ticket:'ticket-'+params.callId,digest:'a'.repeat(64),kind:'terminal',action:'echo',target:'test',cwd:'C:\\fixture',source:'fixture',parameters:JSON.stringify(params.arguments),deadline:Date.now()+lifetime});},
    decide:async input=>{calls.push(input);return work(input);},cancel:input=>{cancels.push(input);},close:async()=>{const result=await closeWork();finishClose=result?.closed===true;return result;}
  });
  const app=createPanelServer({root,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,dynamicApprovalOwner:owner,invokeWorkbench:async()=>{throw new Error('unexpected model read');}});
  const {origin}=await app.listen(),status=await(await fetch(origin+'/api/status')).json();t.after(()=>app.close());
  const post=async(route,data={},options={})=>{const headers={'Content-Type':'application/json','X-Local-Chat':status.csrf};if(options.origin!==null)headers.Origin=options.origin??origin;
    const response=await fetch(origin+'/api/'+route,{method:'POST',headers,body:JSON.stringify({client:'browser',...data})});return {status:response.status,body:await response.json()};};
  return {codex,app,owner,post,calls,cancels,prepared,origin,get closed(){return finishClose;}};
}
const input=p=>({conversationId:p.conversationId,requestId:p.id,digest:p.digest,decision:'accept'});

test('early callbacks bind to acknowledged turn, exact client and displayed one-use action',async t=>{
  const f=await fixture(t);f.codex.early=()=>{f.codex.request(1,{turnId:'foreign'});f.codex.request(2);};
  assert.equal((await f.post('turn',{message:'test'})).status,202);assert.equal(f.codex.rejects,1);assert.equal(f.prepared.length,1);
  const preview=f.app.snapshot('browser').dynamicApproval;assert.equal(preview.parameters,'{"value":"original"}');assert.equal(f.app.snapshot('other').dynamicApproval,null);assert.equal(f.calls.length,0);
  assert.equal((await f.post('dynamic-approval',{...input(preview),client:'other'})).status,409);
  assert.equal((await f.post('dynamic-approval',{...input(preview),digest:'b'.repeat(64)})).status,409);
  assert.equal((await f.post('dynamic-approval',{...input(preview),parameters:'changed'})).status,400);
  assert.equal((await f.post('dynamic-approval',input(preview),{origin:null})).status,403);
  assert.equal((await f.post('dynamic-approval',input(preview),{origin:'http://attacker.test'})).status,403);
  assert.equal((await f.post('dynamic-approval',input(preview))).body.status,'submitted');
  assert.equal((await f.post('dynamic-approval',input(preview))).status,409);await tick();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].ticket,'ticket-call-2');assert.equal(f.codex.answers[0].success,true);
  assert.equal(f.app.snapshot('browser').dynamicApproval,null);
});

test('denial, timeout and scope changes cannot reuse an approval',async t=>{
  const f=await fixture(t,{lifetime:25});f.codex.early=()=>f.codex.request(1);await f.post('turn',{message:'test'});
  const p=f.app.snapshot('browser').dynamicApproval;assert.equal((await f.post('dynamic-approval',{...input(p),decision:'decline'})).status,200);await tick();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].decision,'decline');assert.equal((await f.post('dynamic-approval',input(p))).status,409);
  f.codex.request(2);const expired=f.app.snapshot('browser').dynamicApproval;await new Promise(resolve=>setTimeout(resolve,45));
  assert.equal((await f.post('dynamic-approval',input(expired))).status,409);assert.equal(f.cancels.length,1);
  f.codex.request(3);const stale=f.app.snapshot('browser').dynamicApproval;f.codex.state={...f.codex.state,connectionGeneration:2};
  assert.equal((await f.post('dynamic-approval',input(stale))).status,409);assert.equal(f.calls.length,1);
});

test('cancel after decision retains owner cancellation and suppresses late native response',async t=>{
  let resolve;const f=await fixture(t,{work:()=>new Promise(done=>{resolve=done;})});f.codex.early=()=>f.codex.request();await f.post('turn',{message:'test'});
  const p=f.app.snapshot('browser').dynamicApproval;assert.equal((await f.post('dynamic-approval',input(p))).status,200);await tick();
  assert.equal(f.calls.length,1);await f.post('interrupt');assert.equal(f.cancels.length,1);assert.equal(f.codex.discards,1);
  resolve({success:true,contentItems:[{type:'inputText',text:'late'}]});await tick();assert.equal(f.codex.answers.length,0);
});

test('a profile with only routed project, model and schema tools cannot install another approval owner',()=>{
  const codex=new Fake(),profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE}),fileNames=new Set(ACCESS_FILE_TOOLS.map(tool=>tool.name));
  // File tools are a separate named capability; this fixture intentionally
  // contains only the already-routed project/model/metadata registrations.
  codex.profile=Object.freeze({...profile,dynamicTools:Object.freeze(profile.dynamicTools.filter(tool=>!fileNames.has(tool.name)))});
  assert.throws(()=>createPanelServer({root,codex,profile:MODEL_WORKSPACE_SESSION_PROFILE,invokeWorkbench:async()=>{},dynamicApprovalOwner:Object.freeze({propose(){},decide(){},cancel(){},close(){}})}),/explicitly enabled/);
});

test('SSE projects pending operation only to its matching client',async t=>{
  const f=await fixture(t);f.codex.early=()=>{};await f.post('turn',{message:'test'});
  const controller=new AbortController();t.after(()=>controller.abort());
  const response=await fetch(f.origin+'/api/events?client=browser',{signal:controller.signal});const reader=response.body.getReader();
  await reader.read();f.codex.request();const event=await reader.read();const text=new TextDecoder().decode(event.value);
  assert.match(text,/event: conversation/);assert.match(text,/"dynamicApproval":\{"id":/);assert.match(text,/\\"value\\":\\"original\\"/);
  assert.equal(f.app.snapshot('other').dynamicApproval,null);controller.abort();
});

test('owner cleanup failure keeps close retryable and retains ownership',async t=>{
  let attempts=0;const f=await fixture(t,{closeWork:async()=>({closed:++attempts>1})});
  await assert.rejects(f.app.close(),/清理尚未确认/);assert.equal(f.closed,false);
  assert.deepEqual(await f.app.close(),{closed:true});assert.equal(attempts,2);assert.equal(f.closed,true);
});
