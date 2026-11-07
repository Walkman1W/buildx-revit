// Experimental, unregistered transport. The host feature is compile-time disabled
// by default. This creates no human approval and grants no model authority.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {inspectExistingPanelDirectory} from './panel-audit.mjs';
import {captureReadonlyReceiptOwner} from './workbench-receipt.mjs';
import {assertBatchPreviewArgs} from './batch-filter-preview.mjs';
import {interpretBatchFilterCandidateReceipt} from './batch-filter-receipt-candidate.mjs';
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const invalid=()=>{throw new Error('Experimental batch request not published: invalid trusted context.');};
export async function publishBatchFilterCandidate({queue,host,source,accessPolicy,args,shouldContinue,timeout=30000}){
 if(typeof queue!=='string'||!path.isAbsolute(queue)||!plain(host)||!/^([a-f0-9]{32})$/.test(host.sessionId??'')||!Number.isSafeInteger(host.pid)||host.pid<1||!plain(source)||source.session!==host.sessionId||typeof source.title!=='string'||typeof source.path!=='string'||!source.path.trim()||!plain(accessPolicy)||Object.keys(accessPolicy).sort().join(',')!=='accountScope,id,revision'||typeof accessPolicy.id!=='string'||!Number.isSafeInteger(accessPolicy.revision)||typeof accessPolicy.accountScope!=='string'||!plain(args)||typeof shouldContinue!=='function'||!Number.isSafeInteger(timeout)||timeout<1000||timeout>30000)invalid();
 const allowed=new Set(['category','type_id','level_id','parameter_id','mode','value','value_unit']);if(Object.keys(args).some(k=>!allowed.has(k))||!Object.hasOwn(args,'value')||!['commit','rollback'].includes(args.mode??'rollback')||!['string','number'].includes(typeof args.value)||typeof args.value==='number'&&!Number.isFinite(args.value)||typeof args.value==='string'&&args.value.length>4000||args.value_unit!==undefined&&args.value_unit!=='internal')invalid();
 assertBatchPreviewArgs({expected_document:source.path,category:args.category,parameter_id:args.parameter_id,...Object.hasOwn(args,'type_id')?{type_id:args.type_id}:{},...Object.hasOwn(args,'level_id')?{level_id:args.level_id}:{}});
 const paths=['','inbox','processing','outbox','cancel'].map(x=>path.join(queue,x));if(paths.some(x=>!inspectExistingPanelDirectory(x).ok)||shouldContinue()!==true)invalid();
 const id=randomUUID(),request={id,targetSession:host.sessionId,operation:'batch_set_parameters_by_filter',args:{...structuredClone(args),expected_document:source.path},accessPolicy:structuredClone(accessPolicy),createdUtc:new Date().toISOString(),expiresUtc:new Date(Date.now()+timeout).toISOString()};
 const payload=JSON.stringify(request);if(Buffer.byteLength(payload)>128*1024)invalid();
 const temp=path.join(queue,'inbox',id+'.tmp'),target=path.join(queue,'inbox',id+'.json');await fs.writeFile(temp,payload,{flag:'wx'});
 const owner=captureReadonlyReceiptOwner({queue,preparedPath:temp,request,payload,host,requireConfirmation:true,interpret:text=>interpretBatchFilterCandidateReceipt(text,host,id,request.args,source)});
 if(!owner||shouldContinue()!==true)invalid();
 try{await fs.rename(temp,target);}catch(cause){const error=new Error('Batch publication outcome unknown; inspect the original request without replay.',{cause});error.requestId=id;error.receiptOwner=owner;throw error;}
 let cancelled=false;
 return Object.freeze({requestId:id,receiptOwner:owner,cancel:async()=>{
  if(cancelled)return;if(!inspectExistingPanelDirectory(path.join(queue,'cancel')).ok)throw new Error('Cancellation directory is unverified.');const marker=path.join(queue,'cancel',id+'.json'),content=JSON.stringify({schema_version:1,request_id:id,target_session:host.sessionId});
  try{await fs.writeFile(marker,content,{flag:'wx'});cancelled=true;}catch(e){if(e.code!=='EEXIST'||await fs.readFile(marker,'utf8')!==content)throw e;cancelled=true;}
 }});
}
