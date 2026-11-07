// Read-only candidate contract. The atomic transport binds host identity; this
// result itself grants no consent or authority to insert a binding.
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exactKeys=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const guid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
const id=(v,positive=false)=>typeof v==='string'&&/^-?[1-9]\d{0,18}$/.test(v)&&BigInt(v)>=-9223372036854775808n&&BigInt(v)<=9223372036854775807n&&v!=='-1'&&(!positive||BigInt(v)>0n);
const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
const fail=()=>{throw new Error('Project binding preview facts do not match the bounded request');};
export function validateProjectBindingPreviewArguments(args,{allowDocumentBinding=false}={}){
 const keys=['definition_guid','definition_id','data_type','category_ids',...['expected_document','offset','limit','expected_snapshot'].filter(k=>Object.hasOwn(args??{},k))];
 if(!exactKeys(args,keys)||(!allowDocumentBinding&&!Object.hasOwn(args,'expected_document'))||(Object.hasOwn(args,'expected_document')&&!(allowDocumentBinding&&args.expected_document==='')&&!text(args.expected_document,32768))||!guid(args.definition_guid)||!id(args.definition_id,true)||!text(args.data_type,1024)||!Array.isArray(args.category_ids)||args.category_ids.length<1||args.category_ids.length>30||!args.category_ids.every(v=>id(v))||new Set(args.category_ids).size!==args.category_ids.length)fail();
 const offset=args.offset??0,limit=args.limit??50;
 if(!Number.isInteger(offset)||offset<0||offset>500||!Number.isInteger(limit)||limit<1||limit>50||(offset>0&&!Object.hasOwn(args,'expected_snapshot'))||(Object.hasOwn(args,'expected_snapshot')&&!/^[a-f0-9]{64}$/.test(args.expected_snapshot)))fail();
 return args;
}
export function validateProjectBindingPreview(value,args){
 const keys=['schema_version','definition_guid','definition_id','data_type','definition_name','document_title','document_path','binding_before','proposed_binding','category_ids','instance_count','instances','offset','limit','snapshot_id','has_more','coverage','future_instances_affected','authorization','host_session_bound','human_decision','binding_attempted','external_file_accessed'];
 validateProjectBindingPreviewArguments(args);
 const requested=[...args.category_ids].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
 if(new Set(requested).size!==requested.length)fail();
 if(!exactKeys(value,keys)||value.schema_version!==1||value.definition_guid!==args.definition_guid||value.definition_id!==args.definition_id||value.data_type!==args.data_type||!text(value.definition_name,1024)||!text(value.document_title,1024)||value.document_path!==args.expected_document||value.binding_before!=='unbound'||value.proposed_binding!=='instance'||value.coverage!=='complete_current_document_instances'||value.future_instances_affected!==true||value.authorization!=='not_granted'||value.host_session_bound!==false||value.human_decision!==false||value.binding_attempted!==false||value.external_file_accessed!==false||!Array.isArray(value.category_ids)||JSON.stringify(value.category_ids)!==JSON.stringify(requested)||!Array.isArray(value.instances)||!Number.isInteger(value.instance_count)||value.instance_count<0||value.instance_count>500||value.offset!==(args.offset??0)||value.limit!==(args.limit??50)||value.offset>value.instance_count||value.instances.length!==Math.min(value.limit,value.instance_count-value.offset)||value.has_more!==(value.offset+value.instances.length<value.instance_count)||!/^[a-f0-9]{64}$/.test(value.snapshot_id)||(args.expected_snapshot!==undefined&&value.snapshot_id!==args.expected_snapshot))fail();
 let previous=0n;const uniqueIds=new Set();
 for(const item of value.instances){
  if(!exactKeys(item,['element_id','category_id','unique_id'])||!id(item.element_id,true)||!requested.includes(item.category_id)||!text(item.unique_id,512)||uniqueIds.has(item.unique_id)||BigInt(item.element_id)<=previous)fail();
  previous=BigInt(item.element_id);uniqueIds.add(item.unique_id);
 }
 return structuredClone(value);
}
