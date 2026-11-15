import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {accessDirectoryChain,createAccessPolicy} from '../lib/access-policy.mjs';
import {prepareAccessLockRecovery,recoverAbandonedAccessLock} from '../lib/access-lock-recovery.mjs';

const windows=process.platform==='win32';
const record=()=>JSON.stringify({schema:1,owner:randomUUID()});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-access-lock-'));
  const account=path.join(root,'access-'+digest('fixture').slice(0,32));await fs.mkdir(account);
  const file=path.join(account,'.owner.lock'),sourceChain=await accessDirectoryChain(account);
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^buildx-access-lock-/u);await fs.rm(root,{recursive:true,force:true});});
  return {root,account,file,input:{stateDirectory:root,file,sourceChain}};
}
function child(code,args){return spawn(process.execPath,['--input-type=module','-e',code,...args],{windowsHide:true,stdio:['pipe','pipe','pipe']});}
async function status(process){return new Promise((resolve,reject)=>{let text='';process.once('error',reject);process.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n'))resolve(text.trim());});process.once('close',code=>{if(!text.includes('\n'))reject(new Error('Fixture exited without status: '+code));});});}
async function stop(process){if(process.exitCode!==null||process.signalCode!==null)return;process.kill();await new Promise(resolve=>process.once('close',resolve));}
async function archiveNames(root){return (await fs.readdir(path.join(root,'access-lock-recovery'))).filter(name=>name.endsWith('.bak'));}

test('real Windows RW proof rejects a live Node wx owner and archives its closed legacy lock exactly',{skip:!windows},async t=>{
  const f=await fixture(t),bytes=record();
  const owner=child('import fs from "node:fs/promises";const h=await fs.open(process.argv[1],"wx");await h.writeFile(process.argv[2]);await h.sync();console.log("READY");process.stdin.resume();',[f.file,bytes]);t.after(()=>stop(owner));assert.equal(await status(owner),'READY');
  assert.equal((await recoverAbandonedAccessLock(f.input)).ok,false);assert.equal(await fs.readFile(f.file,'utf8'),bytes);
  await stop(owner);const result=await recoverAbandonedAccessLock(f.input);assert.equal(result.ok,true);
  assert.equal(await fs.readFile(path.join(f.root,'access-lock-recovery',result.value.archiveName),'utf8'),bytes);
  await assert.rejects(fs.lstat(f.file),{code:'ENOENT'});
  const evidence=JSON.parse(await fs.readFile(path.join(f.root,'access-lock-recovery',result.value.evidenceName),'utf8'));
  assert.equal(evidence.sha256,digest(bytes));assert.equal(evidence.fileIdentity,result.value.fileIdentity);assert.equal(evidence.sourceName,'.owner.lock');
  assert.deepEqual(await fs.readdir(f.account),[]);assert.deepEqual(await fs.readdir(path.join(f.root,'access-lock-recovery-helpers')),[]);
});

test('the second Windows lease rejects an existing DELETE handle that permits the RW proof',{skip:!windows},async t=>{
  const f=await fixture(t),bytes=record();await fs.writeFile(f.file,bytes);
  const source=path.join(f.root,'delete-owner.cs'),executable=path.join(f.root,'delete-owner.exe');
  await fs.writeFile(source,`using System;
using System.Runtime.InteropServices;
static class DeleteOwner {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Main(string[] args) {
    IntPtr held=CreateFile(args[0],0x10000,7,IntPtr.Zero,3,0,IntPtr.Zero);
    if(held==new IntPtr(-1))throw new Exception("DELETE lease failed");
    try {
      IntPtr proof=CreateFile(args[0],0xC0000000,4,IntPtr.Zero,3,0,IntPtr.Zero);
      if(proof==new IntPtr(-1))throw new Exception("RW proof was not compatible");
      CloseHandle(proof);Console.WriteLine("READY");Console.ReadLine();
    } finally { CloseHandle(held); }
  }
}`);
  const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  const compiled=spawn(compiler,['/nologo','/target:exe',`/out:${executable}`,source],{windowsHide:true,stdio:'ignore'});assert.equal(await new Promise(resolve=>compiled.once('close',resolve)),0);
  const owner=spawn(executable,[f.file],{windowsHide:true,stdio:['pipe','pipe','pipe']});t.after(()=>stop(owner));assert.equal(await status(owner),'READY');
  assert.equal((await recoverAbandonedAccessLock(f.input)).ok,false);assert.equal(await fs.readFile(f.file,'utf8'),bytes);assert.deepEqual(await archiveNames(f.root),[]);
  await stop(owner);assert.equal((await recoverAbandonedAccessLock(f.input)).ok,true);
});

test('malformed, foreign, duplicate-key and noncanonical lock records remain untouched',{skip:!windows},async t=>{
  const f=await fixture(t);
  for(const bytes of ['', '{"schema":1', '{"schema":1,"owner":"foreign"}', JSON.stringify({schema:1,owner:randomUUID(),pid:1}), '{"schema":0,"schema":1,"owner":"'+randomUUID()+'"}', JSON.stringify({owner:randomUUID(),schema:1}), ' '.repeat(1025)]){
    await fs.writeFile(f.file,bytes);assert.equal((await recoverAbandonedAccessLock(f.input)).ok,false);assert.equal(await fs.readFile(f.file,'utf8'),bytes);
  }
});

test('hard links, redirected ancestors and stale ancestor identities cannot authorize archival',{skip:!windows},async t=>{
  const f=await fixture(t),bytes=record();await fs.writeFile(f.file,bytes);const alias=path.join(f.root,'alias');await fs.link(f.file,alias);
  assert.equal((await recoverAbandonedAccessLock(f.input)).ok,false);await fs.unlink(alias);
  const stale=f.input.sourceChain.map((item,index)=>index===f.input.sourceChain.length-1?{...item,id:'0:0:0'}:item);
  assert.equal((await recoverAbandonedAccessLock({...f.input,sourceChain:stale})).ok,false);
  const moved=f.account+'-original';await fs.rename(f.account,moved);await fs.symlink(moved,f.account,'junction');
  assert.equal((await recoverAbandonedAccessLock(f.input)).ok,false);assert.equal(await fs.readFile(path.join(moved,'.owner.lock'),'utf8'),bytes);
});

test('concurrent recovery attempts retain one exact original and never overwrite an archive',{skip:!windows},async t=>{
  const f=await fixture(t),bytes=record();await fs.writeFile(f.file,bytes);
  const result=await Promise.all([recoverAbandonedAccessLock(f.input),recoverAbandonedAccessLock(f.input)]);
  assert.equal(result.filter(item=>item.ok).length,1);const names=await archiveNames(f.root);assert.equal(names.length,1);assert.equal(await fs.readFile(path.join(f.root,'access-lock-recovery',names[0]),'utf8'),bytes);
});

test('the helper rechecks exact lock identity after a replacement race',{skip:!windows},async t=>{
  const f=await fixture(t),bytes=record();await fs.writeFile(f.file,bytes);const prepared=await prepareAccessLockRecovery(f.input);assert.equal(prepared.ok,true);
  // Exercise the native boundary directly with a previously prepared request.
  // The replacement deliberately has identical bytes and a distinct file id.
  const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),executable=path.join(f.root,'fixture-helper.exe');
  const compiled=spawn(compiler,['/nologo','/target:exe','/reference:System.Web.Extensions.dll',`/out:${executable}`,fileURLToPath(new URL('../lib/access-lock-recovery.cs',import.meta.url))],{windowsHide:true,stdio:'ignore'});assert.equal(await new Promise(resolve=>compiled.once('close',resolve)),0);
  await fs.rename(f.file,f.file+'.original');await fs.writeFile(f.file,bytes);
  const helper=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='';helper.stdout.on('data',chunk=>output+=chunk);helper.stdin.end(JSON.stringify(prepared.value));assert.equal(await new Promise(resolve=>helper.once('close',resolve)),0);
  assert.equal(JSON.parse(output).ok,false);assert.equal(await fs.readFile(f.file,'utf8'),bytes);assert.deepEqual(await archiveNames(f.root),[]);
});

test('backup budget and unowned compiler slots fail closed with the journal and lock preserved',{skip:!windows},async t=>{
  const f=await fixture(t),bytes=record();await fs.writeFile(f.file,bytes);const backup=path.join(f.root,'access-lock-recovery');await fs.mkdir(backup);
  for(let index=0;index<128;index++)await fs.writeFile(path.join(backup,`owner-lock-${randomUUID()}.bak`),'');
  assert.equal((await recoverAbandonedAccessLock(f.input)).ok,false);assert.equal(await fs.readFile(f.file,'utf8'),bytes);assert.equal((await archiveNames(f.root)).length,128);
  const cache=path.join(f.root,'access-lock-recovery-helpers');for(let index=0;index<4;index++)await fs.mkdir(path.join(cache,`slot-${index}`));
  const result=await recoverAbandonedAccessLock(f.input);assert.equal(result.ok,false);assert.equal(await fs.readFile(f.file,'utf8'),bytes);assert.equal((await fs.readdir(cache)).length,4);
});

test('policy crash recovery restores the same full-access journal without appending or resetting it',{skip:!windows},async t=>{
  const f=await fixture(t),moduleUrl=new URL('../lib/access-policy.mjs',import.meta.url).href;
  const code=`import{createAccessPolicy}from${JSON.stringify(moduleUrl)};const p=globalThis.owner=createAccessPolicy({stateDirectory:process.argv[1],accountScope:"journal"});if(!(await p.ready()).ok)throw Error("ready");if(!(await p.update({mode:"full-access",roots:[],confirmedFullAccess:true,expectedRevision:0})).ok)throw Error("update");console.log(p.storageDirectory);process.stdin.resume();`;
  const owner=child(code,[f.root]);t.after(()=>stop(owner));const account=await status(owner),journal=path.join(account,'policy-00000001.json'),prior=await fs.readFile(journal),lock=await fs.readFile(path.join(account,'.owner.lock'));
  const contender=createAccessPolicy({stateDirectory:f.root,accountScope:'journal'});t.after(()=>contender.close());assert.equal((await contender.ready()).error.code,'ACCESS_POLICY_LOCKED');
  await stop(owner);const recovered=createAccessPolicy({stateDirectory:f.root,accountScope:'journal'});t.after(()=>recovered.close());const result=await recovered.ready();assert.equal(result.ok,true);assert.equal(result.value.mode,'full-access');assert.equal(result.value.revision,1);assert.equal(result.value.id,JSON.parse(prior).policy.id);
  assert.deepEqual(await fs.readFile(journal),prior);assert.deepEqual((await fs.readdir(account)).sort(),['.owner.lock','policy-00000001.json']);
  const names=await archiveNames(f.root);assert.equal(names.length,1);assert.deepEqual(await fs.readFile(path.join(f.root,'access-lock-recovery',names[0])),lock);
});

test('two independent policy processes after a crash admit at most one live journal owner',{skip:!windows},async t=>{
  const f=await fixture(t),moduleUrl=new URL('../lib/access-policy.mjs',import.meta.url).href;
  const code=`import{createAccessPolicy}from${JSON.stringify(moduleUrl)};const p=globalThis.owner=createAccessPolicy({stateDirectory:process.argv[1],accountScope:"race"});const r=await p.ready();console.log(r.ok?"READY":r.error.code);if(r.ok)process.stdin.resume();`;
  const start=()=>child(code,[f.root]),original=start();t.after(()=>stop(original));assert.equal(await status(original),'READY');await stop(original);
  const a=start(),b=start();t.after(()=>stop(a));t.after(()=>stop(b));const values=await Promise.all([status(a),status(b)]);assert.deepEqual(values.sort(),['ACCESS_POLICY_LOCKED','READY']);assert.equal((await archiveNames(f.root)).length,1);
});
