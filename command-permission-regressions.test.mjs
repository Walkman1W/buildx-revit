import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {invokeCommand} from './lib/command-store.mjs';

const draft={command_id:'test-command',name:'测试',description:'测试命令',code:'return 42;'};
async function temp(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-command-permission-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('revoked approval before immutable publication does not save a command',async t=>{
  const root=await temp(t);let checks=0;
  await assert.rejects(invokeCommand('revit_save_command',draft,{root,shouldContinue:()=>++checks<2}),error=>error.interruptedBeforeEnqueue===true);
  const list=await invokeCommand('revit_list_commands',{}, {root});assert.equal(list.total,0);
  assert.deepEqual(await fs.readdir(path.join(root,'command-store-state')),[]);
});

test('an exact saved C# revision keeps its original execution receipt owner',async t=>{
  const root=await temp(t),saved=await invokeCommand('revit_save_command',draft,{root}),receipt=Object.freeze({inspect(){}});
  const result=await invokeCommand('revit_run_command',{command_id:draft.command_id,revision:saved.revision,expected_document:'C:\\model.rvt',mode:'rollback'},{root,execute:async()=>{const value={operation:'execute_csharp'};Object.defineProperty(value,'receiptOwner',{value:receipt});return value;}});
  assert.equal(result.receiptOwner,receipt);assert.equal(Object.keys(result).includes('receiptOwner'),false);
});

test('an uncertain save after publication retains a verifiable original version owner',async t=>{
  const root=await temp(t),original=fs.rename.bind(fs);
  t.mock.method(fs,'rename',async(from,to)=>{
    await original(from,to);
    if(from.startsWith(root)&&from.endsWith('.staging'))throw new Error('publication acknowledgement lost');
  });
  let caught;try{await invokeCommand('revit_save_command',draft,{root,retainReceiptOwner:true,shouldContinue:()=>true});}catch(error){caught=error;}
  assert.ok(caught?.receiptOwner);assert.notEqual(caught.interruptedBeforeEnqueue,true);
  const result=await caught.receiptOwner.inspect();assert.equal(result.ok,true);assert.equal(result.value.terminal,true);
  assert.equal(result.value.status,'version_present');assert.equal(result.value.evidence.createdByThisRequest,'unknown');
  assert.deepEqual(await caught.receiptOwner.close(),{ok:true,value:{closed:true}});
});
