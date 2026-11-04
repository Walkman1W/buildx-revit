import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {invokeCommand} from './lib/command-store.mjs';

const draft={command_id:'lock-test',name:'测试',description:'测试命令',code:'return 42;'};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-save-ownership-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function getFailure(root){try{await invokeCommand('revit_save_command',draft,{root,retainReceiptOwner:true});assert.fail('expected failure');}catch(error){assert.ok(error.receiptOwner,'must retain exact receipt owner');return error;}}

test('a failed lock identity read retains the actual handle until retry',async t=>{
  const root=await fixture(t),open=fs.open.bind(fs);let failures=2;
  t.mock.method(fs,'open',async(filename,...rest)=>{const handle=await open(filename,...rest);if(String(filename).endsWith('publish.lock')){const stat=handle.stat.bind(handle);t.mock.method(handle,'stat',async(...args)=>{if(failures-->0)throw new Error('temporary stat fault');return stat(...args);});}return handle;});
  const error=await getFailure(root),lock=path.join(root,'command-store-state','publish.lock');assert.equal((await fs.lstat(lock)).isFile(),true);
  const status=await error.receiptOwner.inspect();assert.equal(status.value.status,'not_started');assert.equal(status.value.terminal,true);await assert.rejects(fs.lstat(lock),{code:'ENOENT'});assert.deepEqual(await error.receiptOwner.close(),{ok:true,value:{closed:true}});
});

test('failed stage identity is retried before releasing its original lock',async t=>{
  const root=await fixture(t),open=fs.open.bind(fs);let failures=3;
  t.mock.method(fs,'open',async(filename,...rest)=>{const handle=await open(filename,...rest);if(String(filename).endsWith('.staging')){const stat=handle.stat.bind(handle);t.mock.method(handle,'stat',async(...args)=>{if(failures-->0)throw new Error('temporary stage stat fault');return stat(...args);});}return handle;});
  const error=await getFailure(root),state=path.join(root,'command-store-state');assert.ok((await fs.readdir(state)).some(name=>name.endsWith('.staging')));assert.ok((await fs.readdir(state)).includes('publish.lock'));
  const status=await error.receiptOwner.inspect();assert.equal(status.value.status,'not_started');assert.equal(status.value.terminal,true);assert.deepEqual(await fs.readdir(state),[]);assert.deepEqual(await error.receiptOwner.close(),{ok:true,value:{closed:true}});
});

test('a replaced stage or lock never becomes deletion authority on cleanup retries',async t=>{
  for(const suffix of ['.staging','publish.lock']){
    const root=await fixture(t),unlink=fs.unlink.bind(fs);let swapped=false,replacement;
    t.mock.method(fs,'unlink',async(filename,...rest)=>{if(!swapped&&String(filename).startsWith(root)&&String(filename).endsWith(suffix)){swapped=true;replacement=String(filename);await fs.rename(filename,String(filename)+'.retained-original');await fs.writeFile(filename,'foreign data');throw new Error('unconfirmed unlink');}return unlink(filename,...rest);});
    let checks=0,caught;try{await invokeCommand('revit_save_command',draft,{root,retainReceiptOwner:true,shouldContinue:()=>suffix!=='.staging'||++checks<2});}catch(error){caught=error;}
    assert.ok(caught?.receiptOwner);assert.equal(await fs.readFile(replacement,'utf8'),'foreign data');
    const result=await caught.receiptOwner.inspect();assert.equal(result.value.terminal,false);assert.equal(await fs.readFile(replacement,'utf8'),'foreign data');
    assert.equal((await caught.receiptOwner.close()).ok,false);
    await fs.rename(replacement,replacement+'.foreign');await fs.rename(replacement+'.retained-original',replacement);
    assert.deepEqual(await caught.receiptOwner.close(),{ok:true,value:{closed:true}});assert.equal(await fs.readFile(replacement+'.foreign','utf8'),'foreign data');t.mock.restoreAll();
  }
});

test('a close error retains the same handle and can be retried',async t=>{
  const root=await fixture(t),open=fs.open.bind(fs);let failures=1;
  t.mock.method(fs,'open',async(filename,...rest)=>{const handle=await open(filename,...rest);if(String(filename).endsWith('publish.lock')){const close=handle.close.bind(handle);t.mock.method(handle,'close',async(...args)=>{if(failures-->0)throw new Error('temporary close fault');return close(...args);});}return handle;});
  const error=await getFailure(root);const status=await error.receiptOwner.inspect();assert.equal(status.value.terminal,true);assert.equal(status.value.status,'version_present');assert.deepEqual(await error.receiptOwner.close(),{ok:true,value:{closed:true}});
});
