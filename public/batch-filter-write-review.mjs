const invalid=()=>{throw new Error('批量参数审阅事实不完整，请重新核对模型。');};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(o,keys)=>plain(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const text=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\0\r\n]/.test(v);
const signed=v=>typeof v==='string'&&/^-?(?:0|[1-9]\d{0,18})$/.test(v)&&BigInt(v)>=-9223372036854775808n&&BigInt(v)<=9223372036854775807n;
const positive=v=>signed(v)&&BigInt(v)>0n;
const typed=(v,s)=>s==='String'?typeof v==='string'&&v.length<=4000:s==='Integer'?Number.isInteger(v)&&v>=-2147483648&&v<=2147483647:s==='Double'?typeof v==='number'&&Number.isFinite(v):false;
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export function parseBatchFilterWriteReview(serialized){
 if(typeof serialized!=='string'||serialized.length>60000||new TextEncoder().encode(serialized).length>100000)invalid();let v;try{v=JSON.parse(serialized);}catch{invalid();}
 if(!exact(v,['schema_version','document','mode','category','type_id','level_id','parameter_id','storage_type','value_unit','value','scanned','total','items','scope'])||v.schema_version!==1||v.scope!=='exact_category_type_level_instances'||!exact(v.document,['session','title','path'])||!/^[a-f0-9]{32}$/.test(v.document.session)||!text(v.document.title,1024)||!text(v.document.path,32768)||!['commit','rollback'].includes(v.mode)||!text(v.category,256)||!/^OST_[A-Za-z0-9_]+$/.test(v.category)||v.type_id!==null&&!positive(v.type_id)||v.level_id!==null&&!positive(v.level_id)||!signed(v.parameter_id)||['0','-1'].includes(v.parameter_id)||!['String','Integer','Double'].includes(v.storage_type)||!typed(v.value,v.storage_type)||(v.storage_type==='Double'?v.value_unit!=='internal':v.value_unit!==null)||!Number.isSafeInteger(v.scanned)||v.scanned<0||v.scanned>20000||!Number.isSafeInteger(v.total)||v.total<1||v.total>50||v.total>v.scanned||!Array.isArray(v.items)||v.items.length!==v.total)invalid();
 let last=0n;const ids=new Set();for(const r of v.items){if(!exact(r,['element_id','unique_id','parameter_id','storage_type','has_value','value_internal','data_type'])||!positive(r.element_id)||BigInt(r.element_id)<=last||!text(r.unique_id,256)||ids.has(r.unique_id)||r.parameter_id!==v.parameter_id||r.storage_type!==v.storage_type||typeof r.has_value!=='boolean'||!r.has_value&&r.value_internal!==null||r.value_internal!==null&&!typed(r.value_internal,r.storage_type)||!(r.data_type===null||typeof r.data_type==='string'&&r.data_type.length<=1024))invalid();last=BigInt(r.element_id);ids.add(r.unique_id);}
 return freeze(v);
}
export function renderBatchFilterWriteReview(document,review){
 const make=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};const card=make('section');card.className='type-parameter-write-review';card.setAttribute('aria-label','本次批量参数修改审阅');
 const dl=make('dl');const rows=[['模型名称',review.document.title],['模型路径',review.document.path],['宿主会话',review.document.session],['类别',review.category],['类型 ID',review.type_id??'全部'],['标高 ID',review.level_id??'全部'],['参数 ID',review.parameter_id],['存储类型',review.storage_type],['拟议值',JSON.stringify(review.value)],['单位',review.value_unit??'未指定'],['执行方式',review.mode==='commit'?'应用修改，不自动保存':'回滚预览'],['匹配数量',String(review.total)]];
 for(const r of review.items)rows.push(['元素 '+r.element_id+' / '+r.unique_id,'HasValue: '+r.has_value+'；原值: '+JSON.stringify(r.value_internal)+'；数据类型: '+JSON.stringify(r.data_type)]);
 for(const [label,value] of rows){const dd=make('dd',value);dd.tabIndex=0;dl.append(make('dt',label),dd);}card.append(make('strong','请逐项审阅本次批量参数修改'),dl,make('p','只读预览不授予写权限；本次操作需要逐次确认。'));return card;
}
