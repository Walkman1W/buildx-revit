import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {invokeCommand} from './lib/command-store.mjs';
import {validateTool,invokeWorkbench} from './lib/workbench-client.mjs';
import {timeoutAfterPublication} from './test-support/workbench-timeout.mjs';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-sequence-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return (name,args,options={})=>invokeCommand(name,args,{root,...options});}
const base={command_id:'read-data',name:'Read',description:'Find model data.'};
const identity={session:'host-1',path:'C:/model.rvt'};
const runArgs=saved=>({command_id:base.command_id,revision:saved.revision,expected_document:identity.path});
test('parameterized immutable code sends data separately, and old host fails closed',async t=>{
 const call=await fixture(t),code='return parameters["query"];',saved=await call('revit_save_command',{...base,code,parameters:{query:'string',n:'integer'}}),calls=[];
 const args={...runArgs(saved),parameters:{query:'"; throw new Exception(); //',n:3}};
 await assert.rejects(call('revit_run_command',args,{execute:async(...x)=>calls.push(x)}),/capability/);assert.equal(calls.length,0);
 await call('revit_run_command',args,{parameterizedScriptsSupported:true,execute:async(...x)=>{calls.push(x);return {request_id:'r1'};}});
 assert.equal(calls[0][1].code,code);assert.deepEqual(calls[0][1].parameters,args.parameters);
 assert.deepEqual(validateTool('revit_execute_csharp',calls[0][1]).args.parameters,args.parameters);
 await assert.rejects(call('revit_run_command',{...args,parameters:{query:'x',n:1.5}},{parameterizedScriptsSupported:true,execute:async()=>{throw Error('must not run');}}),/invalid parameter/);
});
test('exact sequence revision resolves inputs and earlier output in order',async t=>{
 const call=await fixture(t),steps=[{id:'first',tool:'revit_get_selection',arguments:{}},{id:'search',tool:'revit_search_elements',arguments:{name_contains:{$input:'text'},limit:{$step:'first',path:['value','count']}}}],saved=await call('revit_save_command',{...base,parameters:{text:'string'},steps});
 const seen=[],run=await call('revit_run_command',{...runArgs(saved),parameters:{text:'wall'}},{bindSequence:async()=>identity,verifySequence:async x=>x===identity,executeStep:async(name,args)=>{seen.push([name,args]);return {ok:true,value:{value:{count:7},request_id:'r'+seen.length}};}});
 assert.equal(run.execution.status,'succeeded');assert.deepEqual(seen,[['revit_get_selection',{}],['revit_search_elements',{name_contains:'wall',limit:7}]]);assert.equal(run.execution.steps[1].receipt.request_id,'r2');
});
test('unknown and changed identity stop later calls with retained receipts',async t=>{
 const call=await fixture(t),steps=[{id:'one',tool:'revit_get_selection',arguments:{}},{id:'two',tool:'revit_list_levels',arguments:{}},{id:'three',tool:'revit_list_levels',arguments:{}}],saved=await call('revit_save_command',{...base,steps});
 let count=0;const options={bindSequence:async()=>identity,verifySequence:async()=>true,executeStep:async()=>{count++;if(count===2)throw Object.assign(new Error('unknown'),{requestId:'r2'});return {ok:true,value:{request_id:'r1'}};}};
 const result=await call('revit_run_command',runArgs(saved),options);assert.equal(count,2);assert.equal(result.execution.status,'unknown');assert.deepEqual(result.execution.steps.map(x=>x.status),['succeeded','unknown','not_started']);assert.equal(result.execution.steps[1].error.request_id,'r2');
 count=0;let checks=0;const changed=await call('revit_run_command',runArgs(saved),{...options,verifySequence:async()=>++checks<3});assert.equal(count,1);assert.equal(changed.execution.status,'partial');assert.equal(changed.execution.steps[1].status,'not_started');
});
test('sequence rejects unsupported tools, forward references and missing adapters',async t=>{
 const call=await fixture(t);
 for(const steps of [[{id:'a',tool:'revit_execute_csharp',arguments:{}}],[{id:'a',tool:'revit_list_levels',arguments:{a:{$step:'later',path:[]}}}]])await assert.rejects(call('revit_save_command',{...base,steps}),/Command sequence/);
 const saved=await call('revit_save_command',{...base,steps:[{id:'a',tool:'revit_list_levels',arguments:{}}]});await assert.rejects(call('revit_run_command',runArgs(saved)),/identity-bound dispatcher/);
});

test('an unknown native step transfers its original receipt owner for inspection and retryable cleanup',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-sequence-receipt-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const queue=path.join(root,'queue');for(const folder of ['inbox','outbox','processing'])await fs.mkdir(path.join(queue,folder),{recursive:true});
 const session='a'.repeat(32);await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version:'0.6.2'}));
 const call=(name,args,options={})=>invokeCommand(name,args,{root,...options});
 const steps=[{id:'one',tool:'revit_get_selection',arguments:{}},{id:'two',tool:'revit_list_levels',arguments:{}}];
 const saved=await call('revit_save_command',{...base,steps});let calls=0;
 const run=await call('revit_run_command',runArgs(saved),{bindSequence:async()=>identity,verifySequence:async()=>true,executeStep:async(name)=>{
   calls++;return {ok:true,value:await timeoutAfterPublication(options=>invokeWorkbench(name,{expected_document:identity.path},options),{root,retainReceiptOwner:true,expectedHostSession:session})};
 }});
 assert.equal(calls,1);assert.equal(run.execution.status,'unknown');assert.deepEqual(run.execution.steps.map(x=>x.status),['unknown','not_started']);
 const owner=run.receiptOwner;assert.ok(owner);assert.equal(owner,run.execution.receiptOwner);assert.equal(Object.getOwnPropertyDescriptor(run,'receiptOwner').enumerable,false);
 assert.equal(owner.inspect().value.status,'pending');assert.equal((await fs.readdir(path.join(queue,'inbox'))).length,1);
 const close=fsSync.closeSync;let fail=true;t.mock.method(fsSync,'closeSync',fd=>{if(fail)throw new Error('controlled cleanup failure');return close(fd);});
 assert.equal(owner.inspect().error.code,'RECEIPT_CLEANUP_PENDING');assert.equal(owner.close().error.code,'RECEIPT_CLEANUP_PENDING');
 fail=false;assert.equal(owner.close().value.closed,true);assert.equal(owner.inspect().error.code,'RECEIPT_OWNER_CLOSED');
});
test('an adapter result transfers its owner without serializing it',async t=>{
 const call=await fixture(t),saved=await call('revit_save_command',{...base,steps:[{id:'one',tool:'revit_list_levels',arguments:{}}]});
 const owner={inspect:()=>({ok:true}),close:()=>({ok:true,value:{closed:true}})},receipt={ok:false,outcome:'unconfirmed',request_id:'r1'};
 Object.defineProperty(receipt,'receiptOwner',{value:owner});
 const result=await call('revit_run_command',runArgs(saved),{bindSequence:async()=>identity,verifySequence:async()=>true,executeStep:async()=>receipt});
 assert.equal(result.receiptOwner,owner);assert.equal(result.execution.receiptOwner,owner);assert.equal(result.execution.status,'unknown');assert.equal(JSON.stringify(result).includes('receiptOwner'),false);assert.equal(owner.close().value.closed,true);
});
