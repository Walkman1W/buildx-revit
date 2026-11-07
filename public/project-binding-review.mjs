// Display-only validation; the permission owner binds the immutable facts.
const fail=()=>{throw new Error('项目参数影响事实不完整');};
export function parseProjectBindingReview(serialized){
 if(typeof serialized!=='string'||serialized.length>60000||new TextEncoder().encode(serialized).length>100000)fail();let r;try{r=JSON.parse(serialized);}catch{fail();}
 if(!r||typeof r!=='object'||!r.document||typeof r.document.path!=='string'||typeof r.document.title!=='string'||!['commit','rollback'].includes(r.mode)||r.schema_version!==1||typeof r.definition_name!=='string'||typeof r.definition_guid!=='string'||typeof r.definition_id!=='string'||typeof r.data_type!=='string'||!Array.isArray(r.category_ids)||r.category_ids.length<1||r.category_ids.length>30||!Array.isArray(r.instances)||r.instances.length!==r.instance_count||r.instances.length>500||r.coverage!=='complete_current_document_instances'||r.future_instances_affected!==true||r.authorization!=='not_granted'||r.binding_attempted!==false||r.external_file_accessed!==false)fail();
 let last=0n;const seen=new Set();for(const row of r.instances){if(!row||typeof row.element_id!=='string'||!/^\d{1,19}$/.test(row.element_id)||typeof row.category_id!=='string'||!r.category_ids.includes(row.category_id)||typeof row.unique_id!=='string'||!row.unique_id||seen.has(row.unique_id)||BigInt(row.element_id)<=last)fail();last=BigInt(row.element_id);seen.add(row.unique_id);}
 return r;
}
export function renderProjectBindingReview(doc,r){
 const section=doc.createElement('section');const h=doc.createElement('strong');h.textContent='项目实例参数绑定审阅';section.append(h);
 const rows=[['参数',r.definition_name+' · '+r.definition_guid+' · ID '+r.definition_id],['数据类型',r.data_type],['方式',r.mode==='rollback'?'回滚预览':'应用到当前模型'],['类别 ID',r.category_ids.join('、')],['受影响当前实例',String(r.instance_count)],['未来实例','所选类别的未来实例也会受影响'],['实例清单',r.instances.map(x=>x.element_id+' / '+x.category_id+' / '+x.unique_id).join('\n')||'无']];
 const dl=doc.createElement('dl');for(const [label,text] of rows){const dt=doc.createElement('dt'),dd=doc.createElement('dd');dt.textContent=label;dd.textContent=text;dd.tabIndex=0;dl.append(dt,dd);}section.append(dl);return section;
}
