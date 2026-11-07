import {createHash} from 'node:crypto';
import {stagedExportJournal,advanceExportJournal,validateExportJournalSnapshot} from './dwg-export-journal.mjs';

// Unregistered wiring prototype. `storage` must be an independently trusted,
// directory-identity-bound, exclusive-create adapter. No such production
// adapter or human authorization is installed by this module.
const hash=b=>createHash('sha256').update(b).digest('hex');
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const encode=r=>Buffer.from(JSON.stringify(validateExportJournalSnapshot(r)),'utf8');
function requireReceipt(receipt,record,bytes){
 if(!plain(receipt)||Object.keys(receipt).length!==5||!['request_id','revision','identity','sha256','bytes'].every(k=>Object.hasOwn(receipt,k))||receipt.request_id!==record.plan.request_id||receipt.revision!==record.revision||typeof receipt.identity!=='string'||!receipt.identity||receipt.sha256!==hash(bytes)||receipt.bytes!==bytes.length)throw new Error('Unverified persisted export journal receipt');
 return Object.freeze({...receipt});
}
export function createDwgJournalPrototype(storage){
 if(!plain(storage)||typeof storage.append!=='function'||typeof storage.read!=='function')throw new TypeError('A journal storage adapter is required');
 async function write(record,previous){const bytes=encode(record),result=await storage.append({request_id:record.plan.request_id,revision:record.revision,previous,bytes});return Object.freeze({record,receipt:requireReceipt(result,record,bytes)});}
 return Object.freeze({
  async stage(plan){return write(stagedExportJournal(plan),null);},
  async advance(current,event,{now}={}){
   if(!plain(current)||!plain(current.receipt))throw new Error('Journal receipt required');const record=validateExportJournalSnapshot(current.record);requireReceipt(current.receipt,record,encode(record));
   const next=advanceExportJournal(record,event,now===undefined?{}:{now});return write(next,current.receipt);
  },
  async recover(requestId,revision){
   const raw=await storage.read({request_id:requestId,revision});if(!plain(raw)||!Buffer.isBuffer(raw.bytes)||raw.bytes.length>262144||!plain(raw.receipt))throw new Error('Journal recovery unavailable');
   let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.bytes));}catch{throw new Error('Journal recovery contains partial or invalid data');}
   const record=validateExportJournalSnapshot(parsed);if(record.plan.request_id!==requestId||record.revision!==revision)throw new Error('Recovered journal identity mismatch');
   const receipt=requireReceipt(raw.receipt,record,raw.bytes);return Object.freeze({record,receipt});
  }
 });
}
