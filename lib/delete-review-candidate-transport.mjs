import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureReadonlyReceiptOwner} from './workbench-receipt.mjs';
import {nativeAccessPolicyBinding,nativeRequestId} from './workbench-client.mjs';
import {workbenchElementIdString} from './workbench-contracts.mjs';

// Internal candidate only: absent from production registration/package lists.
// Host TaskDialog decisions, not any value here, authorize the operation.
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const text=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\0\r\n]/.test(v);
const fail=()=>{throw new Error('Internal delete review request or original receipt is invalid');};
function context(source,args){
 if(!exact(source,['session','path','title'])||!/^[a-f0-9]{32}$/.test(source.session)||!text(source.path,32768)||!text(source.title,1024)||
  !exact(args,['mode','target_kind','target_id','target_unique_id'])||!['rollback','commit'].includes(args.mode)||!['sheet','element'].includes(args.target_kind)||!text(args.target_unique_id,256))fail();
 const target=workbenchElementIdString(args.target_id);return {source:structuredClone(source),args:{expected_document:source.path,mode:args.mode,target_kind:args.target_kind,target_id:target,target_unique_id:args.target_unique_id}};
}
function interpret(textValue,host,id,args,doc){
 const response=JSON.parse(textValue);if(!plain(response)||response.id!==id||typeof response.ok!=='boolean'||typeof response.completedUtc!=='string'||!Number.isFinite(Date.parse(response.completedUtc)))fail();
 if(!response.ok){
  if(response.hostSession!==host.sessionId||!plain(response.error)||typeof response.error.code!=='string'||!exact(response.execution,['started','phase','reason'])||typeof response.execution.started!=='boolean'||response.execution.phase!==(response.execution.started?'dispatch':'validation')||![null,'expired'].includes(response.execution.reason)||response.execution.started&&response.execution.reason!==null||response.execution.reason==='expired'&&response.error.code!=='WORKBENCH_REQUEST_EXPIRED')fail();
  if(response.execution.started===false&&response.error.code!=='DELETE_REVIEW_OUTCOME_UNKNOWN')return {status:'not_started',terminal:true,message:'原请求在宿主分发前被拒绝。'};
  return {status:'unconfirmed',terminal:false,message:'原请求的执行或回滚状态尚未核实，不得重发。'};
 }
 const r=response.result;if(!plain(r)||Object.keys(r).length!==11||r.operation!=='internal_delete_review_candidate'||r.request_id!==id||r.hostSession!==host.sessionId||
  !exact(r.document,['title','path'])||r.document.title!==doc.title||r.document.path!==doc.path||r.mode!==args.mode||r.target_kind!==args.target_kind||
  workbenchElementIdString(r.target_id)!==args.target_id||r.target_unique_id!==args.target_unique_id||!['preview_declined','preview_rolled_back','delete_declined','committed'].includes(r.status))fail();
 if(r.status==='preview_declined') {if(r.affected!==null||r.preview_expires_utc!==null)fail();}
 else {
  if(!Array.isArray(r.affected)||r.affected.length<1||r.affected.length>20||typeof r.preview_expires_utc!=='string'||!Number.isFinite(Date.parse(r.preview_expires_utc)))fail();
  const ids=new Set(),uids=new Set();let found=false;for(const row of r.affected){if(!exact(row,['element_id','unique_id'])||!text(row.unique_id,1024))fail();const idValue=workbenchElementIdString(row.element_id);if(ids.has(idValue)||uids.has(row.unique_id))fail();ids.add(idValue);uids.add(row.unique_id);if(idValue===args.target_id&&row.unique_id===args.target_unique_id)found=true;}if(!found)fail();
 }
 if(r.status==='preview_rolled_back'&&args.mode!=='rollback'||['delete_declined','committed'].includes(r.status)&&args.mode!=='commit')fail();
 return {status:r.status==='committed'?'received':r.status==='preview_rolled_back'?'preview_rolled_back':'declined',terminal:true,outcome:r.status,committed:r.status==='committed',value:structuredClone(r),message:r.status==='committed'?'已核对删除回执。':'操作未提交；已核对原请求的宿主回执。'};
}
export async function startInternalDeleteReview({queue,sourceDocument,args,accessPolicy,isCurrent,timeoutMs=120000}={}){
 if(typeof queue!=='string'||!path.isAbsolute(queue)||typeof isCurrent!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)fail();
 const current=()=>{try{return isCurrent()===true;}catch{return false;}};
 const bound=context(sourceDocument,args),policy=nativeAccessPolicyBinding(accessPolicy);if(!policy||!current())fail();
 const host=JSON.parse(await fs.readFile(path.join(queue,'host.json'),'utf8'));
 if(!plain(host)||host.sessionId!==bound.source.session||!Number.isSafeInteger(host.pid)||host.pid<1||host.nativeDeleteReviewCandidateVersion!==1||typeof host.version!=='string'||typeof host.startedUtc!=='string'||!Number.isFinite(Date.parse(host.startedUtc)))fail();
 const id=randomUUID();if(!nativeRequestId(id))fail();
 const request={id,targetSession:host.sessionId,operation:'internal_delete_review_candidate',args:bound.args,accessPolicy:policy,createdUtc:new Date().toISOString(),expiresUtc:new Date(Date.now()+timeoutMs).toISOString()};
 const payload=JSON.stringify(request);if(Buffer.byteLength(payload)>128*1024)fail();
 const temp=path.join(queue,'inbox',id+'.tmp'),destination=path.join(queue,'inbox',id+'.json');
 if(!current())fail();await fs.writeFile(temp,payload,{flag:'wx'});
 const receiptOwner=captureReadonlyReceiptOwner({queue,preparedPath:temp,request,payload,host,requireConfirmation:true,interpret:wire=>interpret(wire,host,id,bound.args,bound.source)});
 if(!receiptOwner){const e=new Error('原请求所有者不可用，未发布。');e.unpublishedRequest={requestId:id,tempPath:temp};throw e;}
 if(!current()){const e=new Error('原请求尚未发布，访问范围已变化。');e.unpublishedRequest={requestId:id,tempPath:temp};e.receiptOwner=receiptOwner;throw e;}
 try{await fs.rename(temp,destination);}catch(cause){const e=new Error('原请求发布结果未知；不要重发。',{cause});e.requestId=id;e.receiptOwner=receiptOwner;e.outcome='unconfirmed';throw e;}
 const cancel=async()=>{
  const marker=path.join(queue,'cancel',id+'.json'),value=JSON.stringify({schema_version:1,request_id:id,target_session:host.sessionId});
  try{await fs.writeFile(marker,value,{flag:'wx'});return {ok:true};}catch(error){if(error.code==='EEXIST'&&await fs.readFile(marker,'utf8')===value)return {ok:true};return {ok:false,error:'取消标记未确认；必须继续核对原回执。'};}
 };
 return Object.freeze({requestId:id,receiptOwner,cancel});
}
