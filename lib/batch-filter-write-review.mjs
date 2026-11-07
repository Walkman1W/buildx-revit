import {assertBatchPreviewArgs,assertBatchPreviewResult} from './batch-filter-preview.mjs';

// Review facts only; possession of this DTO is never human approval.
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const fail=()=>{throw new Error('Invalid batch filter write review');};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export function buildBatchFilterWriteReview(args,preview,document){
 if(!plain(args)||Object.keys(args).some(k=>!['expected_document','category','type_id','level_id','parameter_id','mode','storage_type','value_unit','value'].includes(k)))fail();
 const {mode,storage_type:storage,value_unit:unit,value,...filter}=args;
 assertBatchPreviewArgs(filter);assertBatchPreviewResult(preview,filter);
 if(!plain(document)||Object.keys(document).sort().join(',')!=='path,session,title'||typeof document.session!=='string'||!/^[a-f0-9]{32}$/.test(document.session)||typeof document.path!=='string'||!document.path||document.path.length>32768||/[\0\r\n]/.test(document.path)||typeof document.title!=='string'||!document.title||document.title.length>1024||/[\0\r\n]/.test(document.title)||filter.expected_document!==document.path)fail();
 if(!['commit','rollback'].includes(mode)||!['String','Integer','Double'].includes(storage)||!preview.total||preview.items.some(row=>row.storage_type!==storage))fail();
 if(storage==='Double'?unit!=='internal':unit!==undefined)fail();
 if(storage==='String'?(typeof value!=='string'||value.length>4000):storage==='Integer'?(!Number.isInteger(value)||value< -2147483648||value>2147483647):(typeof value!=='number'||!Number.isFinite(value)))fail();
 const review={schema_version:1,document:structuredClone(document),mode,category:preview.category,type_id:preview.type_id,level_id:preview.level_id,parameter_id:preview.parameter_id,storage_type:storage,value_unit:unit??null,value,scanned:preview.scanned,total:preview.total,items:structuredClone(preview.items),scope:preview.scope};
 if(Buffer.byteLength(JSON.stringify(review),'utf8')>100000)fail();return freeze(review);
}
