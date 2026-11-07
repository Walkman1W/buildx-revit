// Research-only recovery adapter. The fixed interpreter is a synthetic test
// contract; no production operation is registered here.
import fs from 'node:fs';
import {interpretModelWriteReceipt} from './workbench-client.mjs';
import {buildBatchFilterWriteReview} from './batch-filter-write-review.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const statId=(p,kind)=>{const s=fs.lstatSync(p,{bigint:true});if(s.isSymbolicLink()||(kind==='file'?!s.isFile()||s.nlink!==1n:!s.isDirectory())||s.ino===0n)throw Error('invalid identity');return `${s.dev}:${s.ino}:${s.birthtimeNs}`;};
function read(p,max,expected){
 const before=statId(p,'file');if(expected&&expected!==before)throw Error('identity changed');
 const fd=fs.openSync(p,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 try{const s=fs.fstatSync(fd,{bigint:true});if(!s.isFile()||`${s.dev}:${s.ino}:${s.birthtimeNs}`!==before||s.size>BigInt(max))throw Error('invalid file');const b=fs.readFileSync(fd);const a=fs.fstatSync(fd,{bigint:true});if(a.size!==s.size||a.mtimeNs!==s.mtimeNs||statId(p,'file')!==before)throw Error('file changed');return b;}finally{fs.closeSync(fd);}
}
function chain(queue){const full=path.resolve(queue),parts=[];let p=path.parse(full).root;for(const part of full.slice(p.length).split(path.sep).filter(Boolean)){p=path.join(p,part);parts.push([p,statId(p,'dir')]);}for(const name of ['inbox','processing','outbox']){const d=path.join(full,name);parts.push([d,statId(d,'dir')]);}return parts;}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const parse=b=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
const validId=id=>typeof id==='string'&&/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(id);
function interpretSynthetic(receipt,record){
 if(!receipt||Object.keys(receipt).sort().join(',')!=='id,operation,outcome,request_digest,session,version'||receipt.id!==record.id||receipt.operation!=='research.synthetic.write'||receipt.version!==1||receipt.session!==record.host.sessionId||receipt.request_digest!==record.digest||!['committed','rolled_back'].includes(receipt.outcome))return null;
 return receipt.outcome;
}
// Only the original captured project-binding request may settle this scope.
const interpreters=Object.freeze({'batch_set_parameters_by_filter@1':(receipt,record,payload)=>{
 const request=parse(payload),source=record.sourceDocument,review=record.batchReview;
 if(request.id!==record.id||request.targetSession!==record.host.sessionId||request.operation!=='batch_set_parameters_by_filter'||!source||source.session!==record.host.sessionId||request.args?.expected_document!==source.path)throw Error('request identity mismatch');
 const {batch_write_preparation,...args}=request.args;
 if(!batch_write_preparation||Object.keys(batch_write_preparation).sort().join(',')!=='schema_version,token'||batch_write_preparation.schema_version!==1||!/^[a-f0-9]{32}$/.test(batch_write_preparation.token))throw Error('missing preparation identity');
 const expected=buildBatchFilterWriteReview(args,receipt.result?.value?.before,source);
 if(JSON.stringify(expected)!==JSON.stringify(review))throw Error('approved facts mismatch');
 const result=interpretModelWriteReceipt(JSON.stringify(receipt),record.host,record.id,'batch_set_parameters_by_filter',args,source,review);
 return result.terminal===true&&result.status==='received'?(result.evidence.committed?'committed':'rolled_back'):null;
}});
export function captureRecovery({queue,preparedPath,id,host,operation,version,recordPath,sourceDocument,batchReview}){
 if(!validId(id)||!interpreters[operation+"@"+version]||!host||typeof host.sessionId!=='string'||!host.sessionId||!Number.isSafeInteger(host.pid)||host.pid<1||path.resolve(preparedPath)!==path.join(path.resolve(queue),'inbox',id+'.tmp'))throw Error('invalid capture');
 const directories=chain(queue),fileIdentity=statId(preparedPath,'file'),payload=read(preparedPath,128*1024,fileIdentity),liveHost=parse(read(path.join(queue,'host.json'),16384));
 if(!equal(liveHost,host))throw Error('host mismatch');
 const record={schema:1,queue:path.resolve(queue),id,host,operation,version,directories,fileIdentity,digest:sha(payload),...sourceDocument?{sourceDocument}:{},...batchReview?{batchReview}:{}};
 const fd=fs.openSync(recordPath,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 return record;
}
export function recoverOriginal(recordPath){
 try{
  const record=parse(read(recordPath,256*1024));
  if(!record||record.schema!==1||!validId(record.id)||!interpreters[`${record.operation}@${record.version}`]||!Array.isArray(record.directories)||typeof record.fileIdentity!=='string'||!/^[a-f0-9]{64}$/.test(record.digest)||!equal(chain(record.queue),record.directories))return {state:'unknown'};
  if(!equal(parse(read(path.join(record.queue,'host.json'),16384)),record.host))return {state:'unknown'};
  let payload=null;
  for(const folder of ['inbox','processing'])try{const b=read(path.join(record.queue,folder,record.id+'.json'),128*1024,record.fileIdentity);if(payload)throw Error('duplicate');payload=b;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!payload||sha(payload)!==record.digest)return {state:'unknown'};
  const receipt=parse(read(path.join(record.queue,'outbox',record.id+'.json'),3*1024*1024));
  const outcome=interpreters[`${record.operation}@${record.version}`](receipt,record,payload);
  return outcome?{state:outcome,id:record.id,digest:record.digest}:{state:'unknown'};
 }catch{return {state:'unknown'};}
}
// Only a trusted server-owned record path may be passed to this factory.
// Receipt contents are always read by recoverOriginal, never from caller input.
export function recoveryVerifier(recordPath){
 return async (supplied,original)=>{const result=recoverOriginal(recordPath);return ['committed','rolled_back'].includes(result.state)&&result.state===supplied.outcome&&result.id===original.id&&result.digest===original.digest;};
}
