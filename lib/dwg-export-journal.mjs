import {createHash} from 'node:crypto';

// Unregistered protocol model. This module neither proves a selector origin or
// staging isolation nor authorizes, exports, writes files or replays requests.
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const exact=(x,keys)=>plain(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const text=(x,max=1024)=>typeof x==='string'&&x.length>0&&x.length<=max&&!/[\u0000-\u001f\u007f]/u.test(x);
const exactId=x=>typeof x==='string'&&/^[1-9]\d{0,18}$/.test(x)&&BigInt(x)<=9223372036854775807n;
const leaf=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.dwg$/i.test(x)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(x);
const deepFreeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(deepFreeze);Object.freeze(x);}return x;};
const fail=message=>{throw new Error('Export journal: '+message);};
function validatePlan(plan){
 const keys=['request_id','host_session','document_id','view_id','stage_id','stage_directory_identity','destination_path','destination_directory_identity','selection_id','files'];
 if(!exact(plan,keys)||!uuid(plan.request_id)||!text(plan.host_session,128)||!text(plan.document_id,512)||!exactId(plan.view_id)||!uuid(plan.stage_id)||!text(plan.stage_directory_identity,256)||!text(plan.destination_path,32768)||!text(plan.destination_directory_identity,256)||!uuid(plan.selection_id)||!Array.isArray(plan.files)||plan.files.length<1||plan.files.length>16)fail('invalid bounded plan');
 let bytes=0;const seen=new Set(),identities=new Set();for(const file of plan.files){if(!exact(file,['name','source_identity','sha256','bytes'])||!leaf(file.name)||!text(file.source_identity,256)||!hash(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>64*1024*1024||seen.has(file.name.toLowerCase())||identities.has(file.source_identity))fail('invalid file manifest');seen.add(file.name.toLowerCase());identities.add(file.source_identity);bytes+=file.bytes;}
 if(bytes>128*1024*1024)fail('manifest exceeds total byte budget');
 return {request_id:plan.request_id,host_session:plan.host_session,document_id:plan.document_id,view_id:plan.view_id,stage_id:plan.stage_id,stage_directory_identity:plan.stage_directory_identity,destination_path:plan.destination_path,destination_directory_identity:plan.destination_directory_identity,selection_id:plan.selection_id,files:plan.files.map(f=>({name:f.name,source_identity:f.source_identity,sha256:f.sha256,bytes:f.bytes}))};
}
export function exportPlanDigest(plan){return createHash('sha256').update(JSON.stringify(validatePlan(plan)),'utf8').digest('hex');}
function validateRecord(r){
 if(!exact(r,['schema_version','revision','plan','digest','state','deadline','files'])||r.schema_version!==1||!Number.isSafeInteger(r.revision)||r.revision<0||!hash(r.digest)||r.digest!==exportPlanDigest(r.plan)||!['staged','approved','publishing','complete','failed','unconfirmed'].includes(r.state)||!(r.deadline===null||Number.isSafeInteger(r.deadline))||!Array.isArray(r.files)||r.files.length!==r.plan.files.length)fail('invalid journal record');
 for(const f of r.files)if(!exact(f,['name','status','target_identity','target_created'])||!leaf(f.name)||!['pending','inflight','published','failed','unknown'].includes(f.status)||!(f.target_identity===null||text(f.target_identity,256))||![null,true,false].includes(f.target_created))fail('invalid file record');
 if(r.files.some((f,i)=>f.name!==r.plan.files[i].name))fail('file order changed');
 const inflight=r.files.filter(f=>f.status==='inflight').length;
 if(inflight>1||r.state==='publishing'&&inflight!==1||r.state!=='publishing'&&inflight!==0)fail('invalid in-flight state');
 if(r.state==='staged'&&(r.deadline!==null||r.files.some(f=>f.status!=='pending'))||r.state==='approved'&&(r.deadline===null||r.files.some(f=>!['pending','published'].includes(f.status)))||r.state==='complete'&&r.files.some(f=>f.status!=='published')||r.state==='failed'&&!r.files.some(f=>f.status==='failed')||r.state==='unconfirmed'&&!r.files.some(f=>f.status==='unknown'))fail('inconsistent lifecycle');
 const pivot=r.files.findIndex(f=>f.status!=='published');for(let i=0;i<r.files.length;i++){const f=r.files[i];if((f.status==='published')!==(f.target_identity!==null))fail('invalid published identity');if(f.status==='published'&&f.target_created!==true||['pending','inflight','unknown'].includes(f.status)&&f.target_created!==null||f.status==='failed'&&typeof f.target_created!=='boolean')fail('invalid creation outcome');if(pivot>=0&&i>pivot&&f.status!=='pending')fail('nonterminal files must form a suffix');}
 if(['publishing','complete','failed','unconfirmed'].includes(r.state)&&r.deadline===null)fail('missing approval deadline');
 if(r.state==='failed'&&r.files.filter(f=>f.status==='failed').length!==1||r.state==='unconfirmed'&&r.files.filter(f=>f.status==='unknown').length!==1||r.files.some(f=>f.status==='failed')&&r.state!=='failed'||r.files.some(f=>f.status==='unknown')&&r.state!=='unconfirmed')fail('invalid terminal outcome');
 return r;
}
export function validateExportJournalSnapshot(record){return deepFreeze(structuredClone(validateRecord(record)));}
export function stagedExportJournal(plan){const checked=validatePlan(plan);return deepFreeze({schema_version:1,revision:0,plan:checked,digest:exportPlanDigest(checked),state:'staged',deadline:null,files:checked.files.map(f=>({name:f.name,status:'pending',target_identity:null,target_created:null}))});}
// Advance returns a candidate snapshot only. The caller must durably commit a
// compare-and-set before any external action. No action is performed here.
export function advanceExportJournal(record,event,{now=Date.now()}={}){
 const r=structuredClone(validateRecord(record));if(!plain(event)||!Number.isSafeInteger(now)||event.revision!==r.revision||event.digest!==r.digest)fail('stale or mismatched event');
 if(event.kind==='approve'){
  if(!exact(event,['kind','revision','digest','deadline'])||r.state!=='staged'||!Number.isSafeInteger(event.deadline)||event.deadline<=now||event.deadline>now+120000)fail('invalid approval intent');r.deadline=event.deadline;r.state='approved';
 }else if(event.kind==='start_file'){
  if(!exact(event,['kind','revision','digest','index'])||r.state!=='approved'||r.deadline<=now||!Number.isInteger(event.index)||event.index<0||event.index>=r.files.length||r.files[event.index].status!=='pending'||r.files.findIndex(f=>f.status==='pending')!==event.index)fail('file cannot start');r.files[event.index].status='inflight';r.state='publishing';
 }else if(event.kind==='finish_file'){
  if(!exact(event,['kind','revision','digest','index','status','target_identity','target_created'])||r.state!=='publishing'||!Number.isInteger(event.index)||r.files[event.index]?.status!=='inflight'||!['published','failed','unknown'].includes(event.status)||(event.status==='published'?!text(event.target_identity,256):event.target_identity!==null)||(event.status==='published'?event.target_created!==true:event.status==='failed'?typeof event.target_created!=='boolean':event.target_created!==null))fail('invalid file outcome');
  r.files[event.index].status=event.status;r.files[event.index].target_identity=event.target_identity;r.files[event.index].target_created=event.target_created;r.state=event.status==='published'?(r.files.every(f=>f.status==='published')?'complete':'approved'):event.status==='failed'?'failed':'unconfirmed';
 }else if(event.kind==='interrupt'){
  if(!exact(event,['kind','revision','digest'])||r.state!=='publishing')fail('no in-flight operation');r.files.find(f=>f.status==='inflight').status='unknown';r.state='unconfirmed';
 }else fail('unknown event');
 r.revision++;return deepFreeze(validateRecord(r));
}
