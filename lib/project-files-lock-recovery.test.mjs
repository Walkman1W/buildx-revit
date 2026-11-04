import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {inspectExistingPanelDirectory} from './panel-audit.mjs';
import {recoverAbandonedLibraryLock} from './project-files-lock-recovery.mjs';
import {createProjectFilesStore} from './project-files-store.mjs';

const windows=process.platform==='win32';
const record=()=>JSON.stringify({schema:1,owner:randomUUID()});
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-library-lock-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,file:path.join(dir,'.library.lock'),chain:inspectExistingPanelDirectory(dir).value.chain};}
function childLock(file,data){const code=`import fs from 'node:fs/promises';const file=await fs.open(process.argv[1],'wx');await file.writeFile(process.argv[2]);await file.sync();process.stdout.write('READY\\n');process.stdin.resume();`;return spawn(process.execPath,['--input-type=module','-e',code,file,data],{stdio:['pipe','pipe','pipe'],windowsHide:true});}
async function ready(child){await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);child.once('exit',code=>reject(new Error('fixture exited '+code)));});}
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;child.kill();await new Promise(resolve=>child.once('close',resolve));}

test('active owner cannot be recovered; crashed owner lock is archived byte-for-byte',{skip:!windows},async t=>{
  const f=await fixture(t),data=record(),child=childLock(f.file,data);t.after(()=>stop(child));await ready(child);
  assert.equal(await recoverAbandonedLibraryLock(f.file,f.chain),false);assert.equal(await fs.readFile(f.file,'utf8'),data);
  await stop(child);assert.equal(await recoverAbandonedLibraryLock(f.file,f.chain),true);
  const names=await fs.readdir(f.dir);assert.equal(names.length,1);assert.match(names[0],/^\.library\.lock\.recovered\./);assert.equal(await fs.readFile(path.join(f.dir,names[0]),'utf8'),data);
});

test('racing recoveries archive only one original; malformed locks and changed ancestors stay untouched',{skip:!windows},async t=>{
  const f=await fixture(t),data=record();await fs.writeFile(f.file,data);
  const outcomes=await Promise.all([recoverAbandonedLibraryLock(f.file,f.chain),recoverAbandonedLibraryLock(f.file,f.chain)]);assert.equal(outcomes.filter(Boolean).length,1);
  let names=await fs.readdir(f.dir);assert.equal(names.length,1);assert.equal(await fs.readFile(path.join(f.dir,names[0]),'utf8'),data);
  for(const value of ['', '{"schema":1', '{"schema":1,"owner":"bad"}']){await fs.writeFile(f.file,value);assert.equal(await recoverAbandonedLibraryLock(f.file,f.chain),false);assert.equal(await fs.readFile(f.file,'utf8'),value);}
  await fs.writeFile(f.file,data);const wrong=f.chain.map((item,i)=>i===f.chain.length-1?{...item,identity:'0:0:0'}:item);
  assert.equal(await recoverAbandonedLibraryLock(f.file,wrong),false);assert.equal(await fs.readFile(f.file,'utf8'),data);
});

test('crashed store reopens original addresses and keeps exact archived lock',{skip:!windows},async t=>{
  const f=await fixture(t),source=path.join(f.dir,'example.txt');await fs.writeFile(source,'fixture');
  const moduleUrl=new URL('./project-files-store.mjs',import.meta.url).href;
  const code=`import {createProjectFilesStore} from ${JSON.stringify(moduleUrl)};const s=createProjectFilesStore({stateDirectory:process.argv[1],accountId:'account'});const r=await s.ready();if(!r.ok)throw Error('not ready');const a=await s.add({path:process.argv[2],kind:'file'});if(!a.ok)throw Error('not saved');process.stdout.write('READY\\n');process.stdin.resume();`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,f.dir,source],{stdio:['pipe','pipe','pipe'],windowsHide:true});t.after(()=>stop(child));await ready(child);
  const account=(await fs.readdir(f.dir)).find(name=>name.startsWith('library-')),lock=path.join(f.dir,account,'.library.lock'),original=await fs.readFile(lock,'utf8');
  const competing=createProjectFilesStore({stateDirectory:f.dir,accountId:'account'});assert.equal((await competing.ready()).error.code,'LIBRARY_STORE_LOCKED');
  await stop(child);const recovered=createProjectFilesStore({stateDirectory:f.dir,accountId:'account'});assert.equal((await recovered.ready()).ok,true);
  assert.deepEqual((await recovered.list()).value.entries,[{path:source,kind:'file'}]);
  const names=await fs.readdir(path.join(f.dir,account)),archive=names.find(name=>name.startsWith('.library.lock.recovered.'));assert.ok(archive);assert.equal(await fs.readFile(path.join(f.dir,account,archive),'utf8'),original);
  assert.equal((await recovered.close()).closed,true);
});

test('a crashed partial journal is retained and never retried or overwritten',{skip:!windows},async t=>{
  const f=await fixture(t),source=path.join(f.dir,'example.txt');await fs.writeFile(source,'fixture');
  const moduleUrl=new URL('./project-files-store.mjs',import.meta.url).href;
  const code=`import {createProjectFilesStore} from ${JSON.stringify(moduleUrl)};const s=createProjectFilesStore({stateDirectory:process.argv[1],accountId:'account'});if(!(await s.ready()).ok)throw Error('not ready');process.stdout.write('READY\\n');process.stdin.resume();`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,f.dir],{stdio:['pipe','pipe','pipe'],windowsHide:true});t.after(()=>stop(child));await ready(child);
  const account=(await fs.readdir(f.dir)).find(name=>name.startsWith('library-')),recordFile=path.join(f.dir,account,'entry-00000001.json');await fs.writeFile(recordFile,'{"partial":');await stop(child);
  const recovered=createProjectFilesStore({stateDirectory:f.dir,accountId:'account'});assert.equal((await recovered.ready()).ok,false);assert.equal(await fs.readFile(recordFile,'utf8'),'{"partial":');assert.equal((await recovered.close()).closed,false);
  assert.equal(await fs.readFile(recordFile,'utf8'),'{"partial":');
});

test('two independent processes after a crash admit at most one live writer',{skip:!windows},async t=>{
  const f=await fixture(t),moduleUrl=new URL('./project-files-store.mjs',import.meta.url).href;
  const code=`import {createProjectFilesStore} from ${JSON.stringify(moduleUrl)};const s=createProjectFilesStore({stateDirectory:process.argv[1],accountId:'account'});const r=await s.ready();process.stdout.write((r.ok?'READY':r.error.code)+'\\n');if(r.ok)process.stdin.resume();`;
  const start=()=>spawn(process.execPath,['--input-type=module','-e',code,f.dir],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const original=start();t.after(()=>stop(original));await ready(original);await stop(original);
  const a=start(),b=start();t.after(()=>stop(a));t.after(()=>stop(b));
  const status=child=>new Promise((resolve,reject)=>{let output='';child.once('error',reject);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n'))resolve(output.trim());});child.once('exit',()=>{if(!output.includes('\n'))reject(new Error('fixture exited without status'));});});
  const values=await Promise.all([status(a),status(b)]);assert.deepEqual([...values].sort(),['LIBRARY_STORE_LOCKED','READY']);
  const account=(await fs.readdir(f.dir)).find(name=>name.startsWith('library-')),names=await fs.readdir(path.join(f.dir,account));
  assert.equal(names.filter(name=>name.startsWith('.library.lock.recovered.')).length,1);assert.ok(names.includes('.library.lock'));
  await stop(a);await stop(b);
});
