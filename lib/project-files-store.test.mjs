import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createProjectFilesStore} from './project-files-store.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-library-store-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const make=(root,accountId='one')=>createProjectFilesStore({stateDirectory:root,accountId});

test('saves only explicit addresses, recovers after close, and isolates accounts',async t=>{
  const root=await fixture(t),file=path.join(root,'source.txt');await fs.writeFile(file,'contents never stored');
  const one=make(root);assert.equal((await one.ready()).ok,true);
  assert.equal((await one.add({path:file,kind:'file'})).ok,true);
  assert.equal((await one.add({path:file,kind:'file'})).value.changed,false);
  assert.deepEqual((await one.list()).value.entries,[{path:file,kind:'file'}]);
  const two=make(root,'two');assert.equal((await two.ready()).ok,true);assert.deepEqual((await two.list()).value.entries,[]);
  assert.equal((await two.close()).closed,true);assert.equal((await one.close()).closed,true);
  const reopened=make(root);assert.equal((await reopened.ready()).ok,true);assert.deepEqual((await reopened.list()).value.entries,[{path:file,kind:'file'}]);
  assert.equal((await reopened.remove({path:file,kind:'file'})).ok,true);assert.deepEqual((await reopened.list()).value.entries,[]);
  assert.equal((await reopened.close()).closed,true);
  const dirs=(await fs.readdir(root)).filter(name=>name.startsWith('library-'));
  for(const dir of dirs)for(const name of await fs.readdir(path.join(root,dir)))assert.doesNotMatch(await fs.readFile(path.join(root,dir,name),'utf8'),/contents never stored/);
});

test('refuses another owner and unknown stale lock; never removes a foreign lock',async t=>{
  const root=await fixture(t),first=make(root),other=make(root);assert.equal((await first.ready()).ok,true);
  assert.equal((await other.ready()).error.code,'LIBRARY_STORE_LOCKED');assert.equal((await other.close()).closed,true);
  assert.equal((await first.close()).closed,true);
  const account=(await fs.readdir(root)).find(name=>name.startsWith('library-')),lock=path.join(root,account,'.library.lock');
  await fs.writeFile(lock,'foreign lock');const third=make(root);assert.equal((await third.ready()).error.code,'LIBRARY_STORE_LOCKED');assert.equal(await fs.readFile(lock,'utf8'),'foreign lock');
});

test('malformed or changed records and unexpected files block without replacement',async t=>{
  const root=await fixture(t),file=path.join(root,'x.txt');await fs.writeFile(file,'x');const one=make(root);
  assert.equal((await one.ready()).ok,true);assert.equal((await one.add({path:file,kind:'file'})).ok,true);assert.equal((await one.close()).closed,true);
  const dir=(await fs.readdir(root)).find(name=>name.startsWith('library-')),record=path.join(root,dir,'entry-00000001.json');
  await fs.writeFile(record,'{broken');const other=make(root);assert.equal((await other.ready()).ok,false);assert.equal(await fs.readFile(record,'utf8'),'{broken');assert.equal((await other.close()).closed,false);
});

test('rejects missing state root, invalid inputs, missing paths and directory substitution',async t=>{
  const root=await fixture(t),file=path.join(root,'x.txt');await fs.writeFile(file,'x');
  const no=make(path.join(root,'missing'),'one');assert.equal((await no.ready()).ok,false);assert.deepEqual((await fs.readdir(root)).sort(),['x.txt']);
  const owner=make(root,'two');assert.equal((await owner.ready()).ok,true);
  assert.equal((await owner.add({path:'relative',kind:'file'})).ok,false);
  assert.equal((await owner.add({path:file,kind:'directory'})).ok,false);
  assert.equal((await owner.add({path:path.join(root,'absent'),kind:'file'})).ok,false);
  assert.deepEqual((await owner.list()).value.entries,[]);assert.equal((await owner.close()).closed,true);
});

test('detects external changes and does not overwrite existing journal data',async t=>{
  const root=await fixture(t),file=path.join(root,'x.txt');await fs.writeFile(file,'x');const owner=make(root);assert.equal((await owner.ready()).ok,true);
  const dir=(await fs.readdir(root)).find(name=>name.startsWith('library-')),rogue=path.join(root,dir,'unexpected.json');await fs.writeFile(rogue,'do not overwrite');
  assert.equal((await owner.add({path:file,kind:'file'})).ok,false);assert.equal(await fs.readFile(rogue,'utf8'),'do not overwrite');assert.equal((await owner.close()).closed,false);
});

test('detects external truncation even when remaining journal is structurally valid',async t=>{
  const root=await fixture(t),file=path.join(root,'x.txt');await fs.writeFile(file,'x');const owner=make(root);assert.equal((await owner.ready()).ok,true);
  assert.equal((await owner.add({path:file,kind:'file'})).ok,true);
  const dir=(await fs.readdir(root)).find(name=>name.startsWith('library-')),record=path.join(root,dir,'entry-00000001.json');await fs.unlink(record);
  assert.equal((await owner.add({path:file,kind:'file'})).ok,false);
  await assert.rejects(fs.stat(record),{code:'ENOENT'});assert.equal((await owner.close()).closed,false);
});
