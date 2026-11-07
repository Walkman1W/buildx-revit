// Preparation facts are not an approval and are not connected to a command.
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>v!=='-1'&&typeof v==='string'&&/^-?[1-9]\d{0,18}$/.test(v)&&BigInt(v)>=-9223372036854775808n&&BigInt(v)<=9223372036854775807n;
export function validateProjectParameterPreparation(value){
 const keys=['schema_version','guid','state','parameter_id','name','data_type','binding_kind','bound_category_ids','requested_categories','scope','write_authorization','external_definition_verified','impact_assessed','shared_parameter_file_accessed'];
 if(!plain(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k))||value.schema_version!==1||typeof value.guid!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.guid)||value.guid==='00000000-0000-0000-0000-000000000000')throw new Error('Invalid preparation identity');
 if(!['absent','present_unbound','bound'].includes(value.state)||value.scope!=='current_document_top_level_categories'||value.write_authorization!=='not_granted'||value.external_definition_verified!==false||value.impact_assessed!==false||value.shared_parameter_file_accessed!==false)throw new Error('Invalid preparation boundary');
 if(value.state==='absent'?value.parameter_id!==null||value.name!==null||value.data_type!==null:value.parameter_id===null||!id(value.parameter_id)||BigInt(value.parameter_id)<=0||typeof value.name!=='string'||!value.name||!(value.data_type===null||typeof value.data_type==='string'))throw new Error('Invalid definition facts');
 const bound=value.bound_category_ids,req=value.requested_categories;
 if(!Array.isArray(bound)||bound.length>200||!bound.every(id)||!Array.isArray(req)||req.length<1||req.length>30||req.some(x=>!plain(x)||Object.keys(x).length!==2||!id(x.category_id)||typeof x.category_name!=='string')||(value.state==='bound'?!['instance','type'].includes(value.binding_kind):value.binding_kind!==null||bound.length!==0))throw new Error('Invalid binding facts');
 for(const ids of [bound,req.map(x=>x.category_id)])for(let i=1;i<ids.length;i++)if(BigInt(ids[i-1])>=BigInt(ids[i]))throw new Error('Category IDs must be distinct and ordered');
 return structuredClone(value);
}
