import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createPanelServer} from '../lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';
import {createModelPermissionServices} from '../lib/model-permission-services.mjs';
import {capturePreparedTypeWrite,consumeApprovedTypeWrite} from '../lib/type-parameter-write-approval.mjs';
import {invokeWorkbench as queueInvoke} from '../lib/workbench-client.mjs';
import {singleParameterWriteFixture,writeEnvelope} from './native-single-parameter-write-fixtures.mjs';
import {initializeResearchRoot} from '../lib/research-scope-owner.mjs';

export const TYPE_WRITE_TOOL='revit_batch_set_parameters_by_filter';
export {SOURCE_DOCUMENT as TYPE_WRITE_DOCUMENT} from './native-single-parameter-write-fixtures.mjs';
import {SOURCE_DOCUMENT as TYPE_WRITE_DOCUMENT} from './native-single-parameter-write-fixtures.mjs';
export const TYPE_WRITE_NATIVE_TOKEN='abcd'.repeat(8);
export const typeWriteHost=(patch={})=>({sessionId:TYPE_WRITE_DOCUMENT.session,pid:process.pid,version:'0.8.8',nativeTypeParameterWritesVersion:1,nativeTypeParameterWriteOperations:['set_type_parameter'],...patch});
export const typeWriteArgs=(patch={})=>({expected_document:TYPE_WRITE_DOCUMENT.path,mode:'rollback',type_id:'9223372036854775806',parameter_id:'-123',value:3,value_unit:'internal',
  expected_state:{storage_type:'Double',has_value:true,value_internal:2,data_type:'autodesk.spec.aec:length-2.0.0'},expected_instance_ids:['2','10','9007199254740993'],...patch});
export const typeWriteImpact=(patch={})=>({schema_version:1,type_id:'9223372036854775806',type_name:'受控类型中文',
  parameter:{parameter_id:'-123',name:'类型宽度',storage_type:'Double',is_read_only:false,has_value:true,data_type:'autodesk.spec.aec:length-2.0.0',unit_type:'autodesk.unit.unit:millimeters-1.0.1',value_internal:2,value_display:'609.6 mm'},
  instance_ids:['2','10','9007199254740993'],instance_count:3,coverage:{complete:true,scope:'current_document_direct_type_references',scanned_elements:4,indirect_effects:'not_assessed'},write_authorization:'not_granted',...patch});
export const nativeTypePreparation=(patch={})=>({schema_version:1,token:TYPE_WRITE_NATIVE_TOKEN,expires_utc:new Date(Date.now()+110000).toISOString(),...patch});
export const preparedTypeWrite=(args=typeWriteArgs(),{impact=typeWriteImpact(),sourceDocument=TYPE_WRITE_DOCUMENT,nativePreparation=nativeTypePreparation()}={})=>
  capturePreparedTypeWrite({args,impact,sourceDocument,nativePreparation});
export const waitTypeWrite=async predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error('Controlled type-write fixture timeout');await new Promise(resolve=>setTimeout(resolve,5));}};

class TypeWriteCodex extends EventEmitter{
  constructor(root){super();this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.answers=[];this.rejected=0;this.discarded=0;}
  async newThread(){return 'controlled-thread';}async turn(){return {turn:{id:'controlled-turn'}};}async interrupt(){}async close(){return {closed:true};}
  request(id,parameters,tool=TYPE_WRITE_TOOL){
    let live=true;const params=Object.freeze({threadId:'controlled-thread',turnId:'controlled-turn',callId:'type-call-'+id,tool:'buildx_model_operation',arguments:Object.freeze({tool,parameters})});
    this.emit('dynamic-tool-request',{id,params,generation:1,revision:2,respond:value=>{if(!live)return false;live=false;this.answers.push(value);return true;},reject:()=>{if(live){live=false;this.rejected++;}},discard:()=>{if(live){live=false;this.discarded++;}}});
  }
}

export async function typeWriteHttpFixture(t,{prepare,invoke,expiryMs=110000,writeReceiptCorrupt=false}={}){
  const parent=await fs.realpath(os.tmpdir()),base=await fs.mkdtemp(path.join(parent,'buildx-type-write-http-')),identity=await fs.lstat(base,{bigint:true}),root=path.join(base,'program');await fs.mkdir(root);
  let app;
  t.after(async()=>{if(app)await app.close();const target=path.resolve(base),current=await fs.lstat(target,{bigint:true});assert.ok(path.isAbsolute(target));assert.equal(path.dirname(target),parent);assert.match(path.basename(target),/^buildx-type-write-http-/);
    assert.ok(current.isDirectory()&&!current.isSymbolicLink());assert.deepEqual([current.dev,current.ino,current.birthtimeNs],[identity.dev,identity.ino,identity.birthtimeNs]);assert.equal((await fs.realpath(target)).toLowerCase(),target.toLowerCase());await fs.rm(target,{recursive:true,force:false});});
    const codex=new TypeWriteCodex(root),writes=[],preparations=[],direct=[],observations=[],receiptSnapshots=[];let document={...TYPE_WRITE_DOCUMENT};
  const value={schema_version:1,scope:'exact_category_type_level_instances',category:'OST_Walls',type_id:null,level_id:null,parameter_id:'-100',scanned:1,complete:true,total:1,items:[{element_id:'101',unique_id:'u1',parameter_id:'-100',storage_type:'Integer',has_value:true,value_internal:1,data_type:'number'}],write_authorization:'not_granted'};
  const queue=await singleParameterWriteFixture(t,{hostPatch:{version:'0.8.9',atomicReadSnapshot:true,nativeBatchFilterPreviewVersion:1,nativeBatchFilterPreviewOperations:['preview_batch_parameter_filter'],nativeBatchFilterPreparationVersion:1,nativeBatchFilterFixtureVersion:1},operations:['preview_batch_parameter_filter','batch_set_parameters_by_filter'],respondEnvelope:r=>{const e=writeEnvelope(r,{value:r.operation==='batch_set_parameters_by_filter'?{count:writeReceiptCorrupt?2:1,mode:r.args.mode,saved:false,transaction_status:r.args.mode==='commit'?'Committed':'RolledBack',before:value,after:{...value,items:value.items.map(item=>({...item,value_internal:r.args.value}))}}:value});
    if(r.operation==='preview_batch_parameter_filter'){const doc={title:TYPE_WRITE_DOCUMENT.title,path:TYPE_WRITE_DOCUMENT.path,activeViewId:12,activeViewType:'ThreeD',modified:false};e.result={operation:r.operation,hostSession:TYPE_WRITE_DOCUMENT.session,atomicReadSnapshot:true,snapshot:{hostSession:TYPE_WRITE_DOCUMENT.session,hostVersion:'0.8.9',document:doc,capabilities:{atomicReadSnapshot:true,nativeBatchFilterPreviewVersion:1,nativeBatchFilterPreviewOperations:[r.operation],nativeBatchFilterPreparationVersion:1}},value:{operation:r.operation,hostSession:TYPE_WRITE_DOCUMENT.session,document:{title:doc.title,path:doc.path},modifiedByOperation:false,value},batch_write_preparation:{schema_version:1,token:TYPE_WRITE_NATIVE_TOKEN,expires_utc:new Date(Date.now()+60000).toISOString()}};}else e.result.operation=r.operation;return e;}});
  const recoveryRoot=path.join(queue.options().root,'batch-recovery');for(const dir of ['scopes','requests','archive','records'])await fs.mkdir(path.join(recoveryRoot,dir),{recursive:true});await initializeResearchRoot(recoveryRoot);
  const services=createModelPermissionServices({observe:async(name,args,control)=>{
    observations.push({name,args,control});
    if(name==='revit_workbench_status')return {hostSession:document.session,document:{title:document.title,path:document.path,allowedSample:true}};
    assert.equal(name,'revit_preview_batch_parameter_filter');preparations.push({args:structuredClone(control.batchWriteProposal),control});
    const output=await queueInvoke(name,args,queue.options({...control,atomicRead:true}));queue.remember(output.receiptOwner);return output;
  },invoke:async(tool,args,control)=>{
    writes.push({tool,args,control});const output=await queueInvoke(tool,args,queue.options({...control,batchFixtureTesting:true,batchRecoveryTesting:true,batchRecoveryRoot:recoveryRoot}));queue.remember(output.receiptOwner);receiptSnapshots.push(output.receiptOwner.inspect().value);return output;
  }});
  app=createPanelServer({root,dataRoot:path.join(base,'data'),codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,modelPermissionServices:services,
    batchFixtureTesting:true,modelReceiptPollDelays:[60000],invokeWorkbench:async()=>{throw new Error('Unexpected live host');},
    invokeReadonlyCommand:async(...args)=>{direct.push(args);return {ok:true,value:{controlled:true}};}});
  const {origin}=await app.listen(),status=await(await fetch(origin+'/api/status')).json(),session=app.snapshot('browser').session.conversation.id;
  const post=async(route,data={},options={})=>{const headers={'Content-Type':'application/json','X-Local-Chat':status.csrf};if(options.origin!==null)headers.Origin=options.origin??origin;
    const response=await fetch(origin+'/api/'+route,{method:'POST',headers,body:JSON.stringify({client:'browser',...data})});return {status:response.status,body:await response.json()};};
  const choose=level=>post('model-permission',{conversationId:session,level,expectedRevision:app.snapshot('browser').modelPermission.revision});
  const begin=()=>post('turn',{message:'受控类型参数审批测试'});
  const preview=()=>app.snapshot('browser').dynamicApproval;
  const decide=(value,decision='accept',patch={},options={})=>post('dynamic-approval',{conversationId:session,requestId:value.id,digest:value.digest,decision,...patch},options);
  return {app,codex,writes,preparations,direct,observations,receiptSnapshots,queue,services,origin,post,session,choose,begin,preview,decide,changeDocument:patch=>{document={...document,...patch};}};
}
