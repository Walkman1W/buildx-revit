// Unregistered receipt candidate. This validator is not an approval authority;
// only a future trusted claimed-request owner may call it with captured facts.
import {sameWorkbenchDocumentIdentity,workbenchDocumentIdentity,workbenchElementIdString} from './workbench-contracts.mjs';
import {nativeModelQueryExactId} from './native-model-queries.mjs';
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const unknown=()=>({status:'unconfirmed',terminal:false,message:'原请求或批量模型结果尚未核实，禁止自动重发。'});
export function interpretBatchFilterCandidateReceipt(text,host,id,args,source){
 try{
  if(typeof text!=='string'||text.length>1024*1024||!plain(host)||!plain(args)||!plain(source))return unknown();
  const e=JSON.parse(text),v=e?.result?.value,r=e?.result,t=e?.timing;
  if(!plain(e)||e.id!==id||e.ok!==true||!Number.isFinite(Date.parse(e.completedUtc))||!plain(t)||t.schemaVersion!==1||t.requestId!==id||t.hostSession!==host.sessionId||
   !plain(r)||r.operation!=='batch_set_parameters_by_filter'||r.request_id!==id||r.hostSession!==host.sessionId||r.effect!=='model_transaction'||r.context_current_after!==true||!sameWorkbenchDocumentIdentity(source,workbenchDocumentIdentity(r))||!plain(v))return unknown();
  const preview=v.reviewed,mode=args.mode??'rollback',unit=args.value_unit??null;
  if(!['completed','declined'].includes(v.status)||v.mode!==mode||v.saved!==false||typeof v.committed!=='boolean'||v.committed!==(v.status==='completed'&&mode==='commit')||v.value_unit!==unit||v.target!==args.value||
   !plain(preview)||preview.schema_version!==1||preview.complete!==true||preview.scope!=='exact_category_type_level_instances'||preview.write_authorization!=='not_granted'||preview.category!==args.category||
   (preview.type_id??null)!==(args.type_id===undefined?null:String(nativeModelQueryExactId(args.type_id)))||(preview.level_id??null)!==(args.level_id===undefined?null:String(nativeModelQueryExactId(args.level_id)))||
   String(preview.parameter_id)!==String(nativeModelQueryExactId(args.parameter_id,{signed:true}))||!Number.isSafeInteger(preview.scanned)||preview.scanned<0||preview.scanned>20000||!Array.isArray(preview.items)||preview.total!==preview.items.length||v.selected_count!==preview.total||preview.total<1||preview.total>20)return unknown();
  const ids=new Set(),uids=new Set();let previous=0n;
  for(const row of preview.items){
   if(!plain(row)||!['Double','Integer','String'].includes(row.storage_type)||typeof row.has_value!=='boolean'||typeof row.unique_id!=='string'||!row.unique_id||row.unique_id.length>256||uids.has(row.unique_id)||String(row.parameter_id)!==String(preview.parameter_id)||!(row.data_type===null||typeof row.data_type==='string'&&row.data_type.length<=1024)||(!row.has_value&&row.value_internal!==null))return unknown();
   const idValue=workbenchElementIdString(row.element_id),idNum=BigInt(idValue);if(ids.has(idValue)||idNum<=previous)return unknown();previous=idNum;ids.add(idValue);uids.add(row.unique_id);
   const raw=row.value_internal;if(raw!==null&&!(row.storage_type==='String'?typeof raw==='string'&&raw.length<=4000:row.storage_type==='Integer'?Number.isInteger(raw)&&raw>=-2147483648&&raw<=2147483647:typeof raw==='number'&&Number.isFinite(raw)))return unknown();
  }
  return {status:'received',terminal:true,evidence:{operation:r.operation,mode,committed:v.committed,reviewed_count:preview.total},message:'已核对原请求的受控候选回执。'};
 }catch{return unknown();}
}
