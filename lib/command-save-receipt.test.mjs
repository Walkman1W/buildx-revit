import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createCommandSaveReceiptOwner} from './command-save-receipt.mjs';
import {invokeCommand} from './command-store.mjs';

const draft={command_id:'receipt-check',name:'Receipt check',description:'Save one exact version',code:'return 42;'};
async function fixture(t){
  const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'buildx-save-owner-'));
  const rel=path.relative(parent,path.resolve(root));assert.ok(rel.startsWith('buildx-save-owner-')&&!rel.includes(path.sep)&&!path.isAbsolute(rel));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,call:(name,args)=>invokeCommand(name,args,{root})};
}
const hash=value=>createHash('sha256').update(value).digest('hex');
const identity={commandId:draft.command_id,revision:hash(JSON.stringify({schema_version:1,...draft}))};
const ready=()=>({settled:true,cleanupConfirmed:true});

test('exact stored version is observable without claiming this request created it',async t=>{
  const f=await fixture(t);await f.call('revit_save_command',draft);let state={settled:false,cleanupConfirmed:false};
  const owner=createCommandSaveReceiptOwner({...identity,publicationState:()=>state,readExact:(id,revision)=>f.call('revit_get_command',{command_id:id,revision})});
  assert.equal((await owner.inspect()).value.status,'unconfirmed');assert.equal((await owner.close()).error.code,'RECEIPT_CLEANUP_PENDING');
  state={settled:true,cleanupConfirmed:false};assert.equal((await owner.inspect()).value.terminal,false);
  state=ready();const result=(await owner.inspect()).value;
  assert.equal(result.status,'version_present');assert.equal(result.terminal,true);assert.equal(result.evidence.createdByThisRequest,'unknown');assert.equal(result.evidence.revision,identity.revision);
  assert.equal((await owner.close()).value.closed,true);assert.equal((await owner.inspect()).error.code,'RECEIPT_OWNER_CLOSED');
});

test('missing, tampered or mismatched revision remains unknown rather than not started',async t=>{
  const f=await fixture(t);const owner=createCommandSaveReceiptOwner({...identity,publicationState:ready,readExact:(id,revision)=>f.call('revit_get_command',{command_id:id,revision})});
  assert.equal((await owner.inspect()).value.status,'unconfirmed');
  await f.call('revit_save_command',draft);const file=path.join(f.root,'commands',identity.commandId,identity.revision+'.json');
  const record=JSON.parse(await fs.readFile(file,'utf8'));record.code='return 99;';await fs.writeFile(file,JSON.stringify(record));
  assert.equal((await owner.inspect()).value.status,'unconfirmed');
  const mismatch=createCommandSaveReceiptOwner({...identity,publicationState:ready,readExact:async()=>({command_id:'another',revision:identity.revision})});
  assert.equal((await mismatch.inspect()).value.status,'unconfirmed');
});

test('a referenced execution record requires independent matching evidence',async t=>{
  const f=await fixture(t),id=randomUUID(),stamp=new Date().toISOString();
  const request={id,operation:'execute_csharp',args:{code:draft.code,expected_document:'D:\\sample.rvt',mode:'rollback'},createdUtc:stamp};
  const outcome={id,ok:true,result:{operation:'execute_csharp',mode:'rollback',committed:false,value:42},completedUtc:stamp};
  for(const [folder,data] of [['processing',request],['outbox',outcome]]){await fs.mkdir(path.join(f.root,'queue',folder),{recursive:true});await fs.writeFile(path.join(f.root,'queue',folder,id+'.json'),JSON.stringify(data));}
  await f.call('revit_save_command',{...draft,source_request_id:id});
  const readExact=(command_id,revision)=>f.call('revit_get_command',{command_id,revision});
  const without=createCommandSaveReceiptOwner({...identity,sourceRequestId:id,readExact,publicationState:ready});assert.equal((await without.inspect()).value.terminal,false);
  const verifySource=async(sourceId,record)=>{
    const requestBytes=await fs.readFile(path.join(f.root,'queue','processing',sourceId+'.json'));
    const outcomeBytes=await fs.readFile(path.join(f.root,'queue','outbox',sourceId+'.json'));
    const a=JSON.parse(requestBytes),b=JSON.parse(outcomeBytes);
    if(a.id!==sourceId||b.id!==sourceId||a.args.code!==record.code||b.ok!==true)throw new Error('source mismatch');
    return {status:'source_execution_succeeded',source_request_id:sourceId,mode:a.args.mode,expected_document:a.args.expected_document,request_created_utc:a.createdUtc,completed_utc:b.completedUtc,request_sha256:hash(requestBytes),outcome_sha256:hash(outcomeBytes),outcome:'ok'};
  };
  const owner=createCommandSaveReceiptOwner({...identity,sourceRequestId:id,readExact,verifySource,publicationState:ready});
  assert.equal((await owner.inspect()).value.evidence.sourceEvidence,'verified');
  await fs.appendFile(path.join(f.root,'queue','outbox',id+'.json'),' ');
  assert.equal((await owner.inspect()).value.status,'unconfirmed');
});

test('settlement is rechecked after the read and close cannot abandon active cleanup',async()=>{
  let resolve,readyNow=true;const held=new Promise(r=>resolve=r);
  const owner=createCommandSaveReceiptOwner({...identity,publicationState:()=>({settled:readyNow,cleanupConfirmed:readyNow}),readExact:async()=>{await held;return {command_id:identity.commandId,revision:identity.revision};}});
  const pending=owner.inspect();readyNow=false;resolve();assert.equal((await pending).value.terminal,false);
  assert.equal((await owner.close()).error.code,'RECEIPT_CLEANUP_PENDING');
});
