import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createPanelServer} from '../lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';
import {createModelPermissionServices} from '../lib/model-permission-services.mjs';
import {invokeAtomicWorkbenchRead,invokeWorkbench,workbenchFailureEvidence} from '../lib/workbench-client.mjs';
import {TYPE_TRANSPORT_DOCUMENT,typeWriteQueueFixture} from './native-type-parameter-write-transport-fixtures.mjs';

export const MANUAL_TYPE_WRITE_TOOL='revit_set_type_parameter';
export async function waitManualTypeWrite(predicate){
 const deadline=Date.now()+8000;
 while(!await predicate()){if(Date.now()>deadline)throw new Error('Controlled manual type-write observation timeout');await new Promise(resolve=>setTimeout(resolve,5));}
}

class ManualTransportCodex extends EventEmitter {
 constructor(root){super();this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.turnCalls=0;}
 async newThread(){throw new Error('Manual type writes must not start an AI thread.');}
 async turn(){this.turnCalls++;throw new Error('Manual type writes must not start an AI turn.');}
 async interrupt(){}async close(){return {closed:true};}
}

// The loopback server and Codex/status metadata are controlled. Preparation,
// approval owner, queue publication, native book/impact/writer and receipts use
// the production implementations. The invoke hook never consumes a proof.
export async function manualTypeWriteTransportFixture(t,{nativeSession,writeBarrier,writeTimeout=3000,unconfirmedDriftEvidence=null}={}){
 assert.ok(nativeSession,'Actual persistent C# session is required');
 const queue=await typeWriteQueueFixture(t,{nativeSession,writeBarrier});
 const parent=await fs.realpath(os.tmpdir()),base=await fs.mkdtemp(path.join(parent,'buildx-manual-type-transport-')),identity=await fs.lstat(base,{bigint:true}),nonce=randomUUID();
 const root=path.join(base,'program');await fs.mkdir(root);await fs.writeFile(path.join(base,'owner.json'),JSON.stringify({kind:'manual-type-transport',nonce}),{flag:'wx'});
 let app,codex,closed=false;
 const close=async()=>{
  if(closed)return;
  let rejectedClose;
  if(app)try{await app.close();}catch(error){rejectedClose=error;}
  if(rejectedClose){
   // An unresolved production receipt must continue to block core.close().
   // This closes only this fixture's HTTP listener after copying its evidence;
   // it never marks the permission receipt terminal or asserts model rollback.
   try{
    assert.ok(unconfirmedDriftEvidence,'Unexpected fixture close rejection: '+rejectedClose.message);
    assert.match(rejectedClose.message,/模型操作原回执尚未确认/);
    const request=queue.requests.findLast(item=>item.operation==='set_type_parameter');assert.ok(request);
    const response=JSON.parse(await fs.readFile(path.join(queue.queue,'outbox',request.id+'.json'),'utf8'));
    const native=queue.observed.findLast(item=>item.operation==='set_type_parameter')?.native;
    assert.equal(native.ok,false);assert.equal(native.facts.SetCalls,0);assert.equal(response.ok,false);
    const preserved={schemaVersion:1,kind:'manual-type-write-controlled-unconfirmed-receipt',syntheticOnly:true,drift:unconfirmedDriftEvidence,
     request,response,native,fixtureForcedListenerCloseExpected:true,permissionReceiptRemainedUnconfirmed:true,productionCoreCloseSucceeded:false,realRevitExecuted:false};
    if(process.env.BUILDX_MANUAL_TRANSPORT_EVIDENCE_DIR){
     const directory=path.resolve(process.env.BUILDX_MANUAL_TRANSPORT_EVIDENCE_DIR),real=await fs.realpath(directory);assert.equal(real.toLowerCase(),directory.toLowerCase());
     const filename=path.join(directory,'manual-transport-'+unconfirmedDriftEvidence+'-unconfirmed-'+nonce+'.json');
     await fs.writeFile(filename,JSON.stringify(preserved,null,2)+'\n',{flag:'wx'});t.diagnostic(JSON.stringify({preservedUnconfirmedEvidence:filename,fixtureForcedListenerCloseExpected:true,permissionReceiptRemainedUnconfirmed:true}));
    }else t.diagnostic(JSON.stringify(preserved));
   }finally{
    app.server.closeAllConnections();await new Promise((resolve,reject)=>app.server.listening?app.server.close(error=>error?reject(error):resolve()):resolve());
    if(codex)await codex.close();
   }
  }
  const target=path.resolve(base),current=await fs.lstat(target,{bigint:true});assert.ok(path.isAbsolute(target));assert.equal(path.dirname(target),parent);assert.match(path.basename(target),/^buildx-manual-type-transport-/);assert.ok(current.isDirectory()&&!current.isSymbolicLink());assert.deepEqual([current.dev,current.ino,current.birthtimeNs],[identity.dev,identity.ino,identity.birthtimeNs]);assert.equal((await fs.realpath(target)).toLowerCase(),target.toLowerCase());assert.deepEqual(JSON.parse(await fs.readFile(path.join(target,'owner.json'),'utf8')),{kind:'manual-type-transport',nonce});await fs.rm(target,{recursive:true,force:false});closed=true;
 };
 t.after(close);
 codex=new ManualTransportCodex(root);const observations=[],invocations=[];
 const services=createModelPermissionServices({observe:async(name,args,control)=>{
  observations.push({name,args:structuredClone(args)});
  if(name==='revit_workbench_status')return {hostSession:TYPE_TRANSPORT_DOCUMENT.session,document:{title:TYPE_TRANSPORT_DOCUMENT.title,path:TYPE_TRANSPORT_DOCUMENT.path,allowedSample:true}};
  assert.equal(name,'revit_get_type_parameter_impact');
  const result=await invokeAtomicWorkbenchRead(name,args,queue.options(control));queue.remember(result.receiptOwner);return result;
 },invoke:async(tool,args,control)=>{
  assert.equal(tool,MANUAL_TYPE_WRITE_TOOL);invocations.push({tool,args:structuredClone(args),retainReceiptOwner:control.retainReceiptOwner});
  try{const result=await invokeWorkbench(tool,args,queue.options({...control,timeout:writeTimeout}));queue.remember(result.receiptOwner);return result;}
  catch(error){queue.remember(workbenchFailureEvidence(error).receiptOwner);throw error;}
 }});
 app=createPanelServer({root,dataRoot:path.join(base,'data'),codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,modelPermissionServices:services,
  modelReceiptPollDelays:[60000],invokeWorkbench:async()=>{throw new Error('Manual transport must not reach a live host.');},
  invokeReadonlyCommand:async()=>{throw new Error('Manual type writes must use the shared approval owner.');}});
 const {origin}=await app.listen(),status=await(await fetch(origin+'/api/status')).json(),session=app.snapshot('browser').session.conversation.id;
 const post=async(route,data={})=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':status.csrf,Origin:origin},body:JSON.stringify({client:'browser',...data})});return {status:response.status,body:await response.json()};};
 const choose=level=>post('model-permission',{conversationId:session,level,expectedRevision:app.snapshot('browser').modelPermission.revision});
 const command=(args,{confirmed=true}={})=>{const parameters=structuredClone(args);delete parameters.expected_document;return post('command',{conversationId:session,commandId:MANUAL_TYPE_WRITE_TOOL,parameters,sourceDocument:TYPE_TRANSPORT_DOCUMENT,confirmed});};
 const snapshot=()=>app.snapshot('browser'),preview=()=>snapshot().dynamicApproval;
 const decide=(proposal,decision='accept')=>post('dynamic-approval',{conversationId:session,requestId:proposal.id,digest:proposal.digest,decision});
 return {...queue,app,codex,services,observations,invocations,origin,session,post,choose,command,snapshot,preview,decide,close};
}
