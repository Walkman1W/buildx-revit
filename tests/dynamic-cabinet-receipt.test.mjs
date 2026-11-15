// Real queue/receipt implementation against a temporary fake host only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {invokeModelCommand} from '../lib/model-tool-dispatch.mjs';
import {createDynamicCabinetOwner} from '../lib/dynamic-cabinet-owner.mjs';

test('cancel after real queue publication retains late successful original receipt until confirmed',async t=>{
  const base=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(base,'buildx-dynamic-cabinet-'));
  if(path.dirname(await fs.realpath(root))!==base||!path.basename(root).startsWith('buildx-dynamic-cabinet-'))throw new Error('Unexpected test path');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const queue=path.join(root,'queue');for(const folder of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,folder),{recursive:true});
  const host={sessionId:'e'.repeat(32),pid:process.pid,version:'0.6.6',startedUtc:new Date().toISOString(),familyCabinetContractVersion:1};await fs.writeFile(path.join(queue,'host.json'),JSON.stringify(host));
  let current=true,calls=0;
  const owner=createDynamicCabinetOwner({invokeCommand:(name,args,options)=>{calls++;return invokeModelCommand(name,args,{...options,root,timeout:2000});}});
  const binding={client:'client',conversationId:'conversation',threadId:'thread',turnId:'turn',generation:1,revision:1,account:{scope:'model',sessionId:'session',userId:'user',generation:1}};
  const params={threadId:'thread',turnId:'turn',callId:'call',tool:'buildx_cabinet_job',arguments:{action:'create',parameters:{template_id:'metric-generic-model'}}};
  const p=owner.propose({params,scope:binding,isCurrent:()=>current});const work=owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'});let file;
  for(let i=0;i<200&&!file;i++){await delay(10);file=(await fs.readdir(path.join(queue,'inbox'))).find(name=>name.endsWith('.json'));}
  assert.ok(file);current=false;assert.equal(await owner.cancel({ticket:p.ticket}),false);const id=file.slice(0,-5);
  await fs.writeFile(path.join(queue,'outbox',file),JSON.stringify({id,ok:true,completedUtc:new Date().toISOString(),result:{operation:'family_create_cabinet',hostSession:host.sessionId,value:{operation:'family_create_cabinet',host_session:host.sessionId,revit_pid:host.pid,success:true,code:'FAMILY_CREATED',outcome:'created_in_owned_family_document',job_handle:'owned-cabinet',cleanup_pending:false}}}));
  await assert.rejects(work);const first=await owner.inspect({ticket:p.ticket,scope:binding});assert.equal(first.value.status,'received');assert.equal(first.value.evidence.jobHandle,'owned-cabinet');
  await delay(10);const second=await owner.inspect({ticket:p.ticket,scope:binding});assert.notEqual(first.value.checkedAt,second.value.checkedAt);
  assert.equal((await owner.close()).closed,false);assert.deepEqual(await owner.acknowledge({ticket:p.ticket,scope:binding,expected:first.value}),{closed:true});assert.equal((await owner.close()).closed,true);
  assert.equal(calls,1);assert.deepEqual((await fs.readdir(path.join(queue,'inbox'))).filter(x=>x.endsWith('.json')),[file]);
});
