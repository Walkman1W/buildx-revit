// Candidate only: no public registration until host, atomic receipt and policy
// integration pass together. Event records are observed changes, not net diffs.
import {expectedDocument,workbenchElementIdString} from './workbench-contracts.mjs';
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const token=v=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
const number=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const bad=()=>{throw new Error('Invalid snapshot delta contract');};
export const SNAPSHOT_DELTA_NAME='revit_get_snapshot_delta';
export const SNAPSHOT_DELTA_OPERATION='get_snapshot_delta';
export const SNAPSHOT_DELTA_TOOL={name:SNAPSHOT_DELTA_NAME,description:'Read an in-memory event log bound to the current host and document. status reports no baseline; start explicitly creates or reuses one complete bounded baseline; page requires exact baseline token, version and offset. Changes are observed events, not a net document diff. A changed version, expired tracker, incomplete enumeration or overflow fails closed. After event continuity failure, status returns an error instructing an explicit action=start to rebuild; old tokens are invalid.',inputSchema:{type:'object',properties:{expected_document:expectedDocument,action:{type:'string',enum:['status','start','page']},baseline_token:{type:'string',pattern:'^[a-f0-9]{32}$',minLength:32,maxLength:32},expected_version:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},offset:{type:'integer',minimum:0,maximum:5000},limit:{type:'integer',minimum:1,maximum:100}},required:['expected_document','action'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false}};
export function supportsSnapshotDelta(host){const ops=host?.nativeSnapshotDeltaOperations;return host?.nativeSnapshotDeltaVersion===1&&Array.isArray(ops)&&ops.length===1&&ops[0]===SNAPSHOT_DELTA_OPERATION;}
export function assertSnapshotArgs(args,{allowDocumentBinding=false}={}){
 if(!plain(args)||Object.keys(args).some(k=>!Object.hasOwn(SNAPSHOT_DELTA_TOOL.inputSchema.properties,k))||!(allowDocumentBinding&&!Object.hasOwn(args,'expected_document')||typeof args.expected_document==='string'&&args.expected_document.length<=32768&&!/[\0\r\n]/.test(args.expected_document)))bad();
 const keys=Object.keys(args).filter(k=>k!=='expected_document');
 if(args.action==='status'||args.action==='start'){if(keys.length!==1)bad();return;}
 if(args.action!=='page'||keys.length!==5||!token(args.baseline_token)||!number(args.expected_version,0,Number.MAX_SAFE_INTEGER)||!number(args.offset,0,5000)||!number(args.limit,1,100))bad();
}
export function assertSnapshotResult(value,args){
 assertSnapshotArgs(args,{allowDocumentBinding:true});
 if(!plain(value)||value.schema_version!==1)bad();
 if(args.action!=='page'){
  if(Object.keys(value).length!==6||!['none','active','expired'].includes(value.state)||args.action==='start'&&value.state!=='active')bad();
  if(value.state==='none'){if(value.baseline_token!==null||value.version!==null||value.baseline_count!==null||value.reason!==null)bad();}
  else if(!token(value.baseline_token)||!number(value.version,0,Number.MAX_SAFE_INTEGER)||!number(value.baseline_count,0,50000)||value.state==='active'&&value.reason!==null||value.state==='expired'&&(typeof value.reason!=='string'||!value.reason||value.reason.length>256))bad();
  return;
 }
 if(Object.keys(value).length!==9||value.state!=='active'||value.baseline_token!==args.baseline_token||value.version!==args.expected_version||value.offset!==args.offset||value.limit!==args.limit||!number(value.total,0,5000)||!Array.isArray(value.items)||args.offset>value.total||value.items.length!==Math.min(args.limit,value.total-args.offset)||value.has_more!==(args.offset+value.items.length<value.total))bad();
 let last=0;const seen=new Set();for(const item of value.items){if(!plain(item)||Object.keys(item).length!==4||!number(item.version,1,value.version)||item.version<last||!['added','modified','deleted'].includes(item.kind)||typeof item.unique_id!=='string'||!item.unique_id||item.unique_id.length>256||item.unique_id!==item.unique_id.trim()||/[\u0000-\u001f\u007f-\u009f]/u.test(item.unique_id))bad();const id=workbenchElementIdString(item.element_id),key=item.version+':'+id;if(seen.has(key))bad();seen.add(key);last=item.version;}
}
