// Closed candidate for the atomic host receipt. This parser does not itself
// prove receipt provenance or authorize a write; the queue owner must do that.
import {validateProjectBindingPreview} from './project-instance-binding-preview.mjs';
const fail=()=>{throw new Error('Project binding atomic review does not match its original request');};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function validateAtomicProjectBindingReview(review,preparation,args,document,requestId){
 const fields=['schema_version','definition_guid','definition_id','data_type','definition_name','document_title','document_path','category_ids','instance_count','instances','snapshot_id','coverage','future_instances_affected','authorization','binding_attempted','external_file_accessed'];
 if(!exact(review,fields)||!exact(preparation,['schema_version','token','request_id','snapshot_id','expires_utc'])||preparation.schema_version!==1||!/^[a-f0-9]{32}$/.test(preparation.token)||preparation.request_id!==requestId||preparation.snapshot_id!==review.snapshot_id||!Number.isFinite(Date.parse(preparation.expires_utc))||new Date(Date.parse(preparation.expires_utc)).toISOString()!==preparation.expires_utc||Date.parse(preparation.expires_utc)<=Date.now()||Date.parse(preparation.expires_utc)>Date.now()+120000||!document||review.document_path!==document.path||review.document_title!==document.title||args.expected_document!==document.path||!['commit','rollback'].includes(args.mode)||!Array.isArray(review.instances)||review.instances.length!==review.instance_count||review.instance_count>500)fail();
 const readArgs={expected_document:args.expected_document,definition_guid:args.definition_guid,definition_id:args.definition_id,data_type:args.data_type,category_ids:args.category_ids};
 // Validate the whole set in pages using the existing strict read contract.
 for(let offset=0;offset<Math.max(1,review.instance_count);offset+=50){
  const page={...review,binding_before:'unbound',proposed_binding:'instance',instances:review.instances.slice(offset,offset+50),offset,limit:50,has_more:offset+50<review.instance_count,host_session_bound:false,human_decision:false};
  validateProjectBindingPreview(page,{...readArgs,offset,limit:50,...offset?{expected_snapshot:review.snapshot_id}:{}});
 }
 let previous=0n;const unique=new Set();for(const row of review.instances){if(BigInt(row.element_id)<=previous||unique.has(row.unique_id))fail();previous=BigInt(row.element_id);unique.add(row.unique_id);}
 return structuredClone({review,preparation});
}
