import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createAccessPolicy} from './lib/access-policy.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-access-policy-'));const state=path.join(root,'state'),project=path.join(root,'project'),other=path.join(root,'project-other');await Promise.all([state,project,other].map(p=>fs.mkdir(p)));const owners=[];const open=scope=>{const owner=createAccessPolicy({stateDirectory:state,accountScope:scope??'research:local'});owners.push(owner);return owner;};t.after(async()=>{for(const owner of owners)await owner.close();assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('buildx-access-policy-'));await fs.rm(root,{recursive:true,force:true});});return {root,state,project,other,open};}

test('default policy is readonly and explicit project/full updates are versioned and account-partitioned',async t=>{
  const f=await fixture(t),p=f.open();const initial=await p.ready();assert.equal(initial.value.mode,'read-only');assert.equal(initial.value.revision,0);assert.deepEqual(initial.value.roots,[]);assert.equal((await p.authorize(f.project)).ok,false);
  const denied=await p.update({mode:'full-access',roots:[],expectedRevision:0});assert.equal(denied.error.code,'ACCESS_FULL_CONFIRMATION_REQUIRED');
  const chosen=await p.update({mode:'project-write',roots:[f.project],expectedRevision:0});assert.equal(chosen.ok,true);assert.equal(chosen.value.policy.revision,1);assert.equal(chosen.value.previous.mode,'read-only');
  assert.equal((await p.authorize(path.join(f.project,'new.txt'),{write:true,allowMissing:true})).ok,true);assert.equal((await p.authorize(f.other,{write:true})).ok,false);
  assert.equal((await p.update({mode:'read-only',roots:[],expectedRevision:0})).ok,false);
  const full=await p.update({mode:'full-access',roots:[],confirmedFullAccess:true,expectedRevision:1});assert.equal(full.ok,true);assert.equal(p.isCurrent({id:initial.value.id,revision:1}),false);assert.equal((await p.authorize(f.other,{write:true})).ok,true);
  const projection=await p.nativeProjection();assert.deepEqual(Object.keys(projection.value).sort(),['accountScope','id','mode','revision','roots','schemaVersion']);assert.equal(projection.value.mode,'full-access');
  const other=f.open('user:other');assert.equal((await other.ready()).value.mode,'read-only');
  assert.deepEqual(await p.close(),{closed:true});const again=f.open();const restored=await again.ready();assert.equal(restored.value.mode,'full-access');assert.equal(restored.value.revision,2);assert.equal(restored.value.id,initial.value.id);
});

test('explicit readonly roots allow reads only and reverting a failed publication restores prior scope with a new revision',async t=>{
  const f=await fixture(t),p=f.open();await p.ready();const first=await p.update({mode:'read-only',roots:[f.project],expectedRevision:0});assert.equal((await p.authorize(f.project)).ok,true);assert.equal((await p.authorize(f.project,{write:true})).error.code,'ACCESS_READ_ONLY');
  await p.update({mode:'full-access',roots:[],confirmedFullAccess:true,expectedRevision:1});const reverted=await p.revert({expectedRevision:2});assert.equal(reverted.value.policy.mode,'read-only');assert.equal(reverted.value.policy.revision,3);assert.deepEqual(reverted.value.policy.roots,first.value.policy.roots);assert.equal((await p.revert({expectedRevision:3})).ok,false);
});

test('project directory replacement, symbolic redirects and protected authorization state cannot become writable',async t=>{
  const f=await fixture(t),p=f.open();await p.ready();await p.update({mode:'project-write',roots:[f.project],expectedRevision:0});
  const link=path.join(f.project,'outside');await fs.symlink(f.other,link,process.platform==='win32'?'junction':'dir');assert.equal((await p.authorize(link,{write:true})).ok,false);
  const moved=path.join(f.root,'old-project');await fs.rename(f.project,moved);await fs.mkdir(f.project);assert.equal((await p.authorize(f.project,{write:true})).error.code,'ACCESS_ROOT_CHANGED');
  await p.update({mode:'full-access',roots:[],confirmedFullAccess:true,expectedRevision:1});assert.equal((await p.authorize(path.join(p.storageDirectory,'policy-00000001.json'),{write:true})).error.code,'ACCESS_POLICY_PATH_RESERVED');
});

test('changed journals fail closed and existing ownership locks cannot be adopted',async t=>{
  const f=await fixture(t),p=f.open();await p.ready();await p.update({mode:'project-write',roots:[f.project],expectedRevision:0});const second=f.open();assert.equal((await second.ready()).error.code,'ACCESS_POLICY_LOCKED');
  const record=path.join(p.storageDirectory,'policy-00000001.json');await fs.appendFile(record,'broken');assert.equal((await p.describe()).error.code,'ACCESS_POLICY_INVALID');assert.equal(p.isCurrent({id:(await p.nativeProjection()).value?.id,revision:1}),false);
});

test('a legacy ownership lock fails at the lock boundary and remains untouched on close',async t=>{
  const f=await fixture(t),stages=[];
  const p=createAccessPolicy({stateDirectory:f.state,accountScope:'legacy-lock',onStage:event=>{stages.push(event);throw new Error('A diagnostic observer cannot change policy results');}});
  await fs.mkdir(p.storageDirectory);const filename=path.join(p.storageDirectory,'.owner.lock'),bytes=JSON.stringify({schema:1,owner:'legacy-owner'});await fs.writeFile(filename,bytes);
  const result=await p.ready();assert.equal(result.ok,false);assert.equal(result.error.code,'ACCESS_POLICY_LOCKED');assert.match(result.error.message,/原锁和权限记录已保留/);
  assert.deepEqual(stages.map(event=>event.phase),['directories','lock','error']);assert.deepEqual(stages.at(-1),{phase:'error',errorCode:'ACCESS_POLICY_LOCKED',failurePhase:'lock',...(process.platform==='win32'?{recoveryCode:'ACCESS_LOCK_NOT_RECOVERABLE'}:{})});assert.ok(stages.every(Object.isFrozen));
  assert.deepEqual(await p.close(),{closed:true});assert.equal(await fs.readFile(filename,'utf8'),bytes);
  const healthy=createAccessPolicy({stateDirectory:f.state,accountScope:'observer-errors',onStage(){throw new Error('Ignored diagnostic failure');}});try{assert.equal((await healthy.ready()).ok,true);}finally{assert.deepEqual(await healthy.close(),{closed:true});}
});

test('a missing recovery helper source reports unavailability instead of a live-owner conflict',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),isolated=path.join(f.root,'isolated-lib');await fs.mkdir(isolated);
  for(const name of ['access-policy.mjs','access-lock-recovery.mjs'])await fs.copyFile(new URL('./lib/'+name,import.meta.url),path.join(isolated,name));
  const {createAccessPolicy:isolatedPolicy}=await import(pathToFileURL(path.join(isolated,'access-policy.mjs'))),stages=[],policy=isolatedPolicy({stateDirectory:f.state,accountScope:'missing-helper',onStage:event=>stages.push(event)});
  try{
    await fs.mkdir(policy.storageDirectory);const filename=path.join(policy.storageDirectory,'.owner.lock'),bytes=JSON.stringify({schema:1,owner:randomUUID()});await fs.writeFile(filename,bytes);
    const result=await policy.ready();assert.equal(result.error.code,'ACCESS_LOCK_RECOVERY_UNAVAILABLE');assert.equal(result.error.recoveryCode,'ACCESS_LOCK_RECOVERY_UNAVAILABLE');assert.equal(stages.at(-1).recoveryCode,'ACCESS_LOCK_RECOVERY_UNAVAILABLE');assert.equal(JSON.stringify(result).includes(f.root),false);assert.equal(await fs.readFile(filename,'utf8'),bytes);
  }finally{assert.deepEqual(await policy.close(),{closed:true});}
});

test('an unlink failure retains the open owner and retries exact lock cleanup on close',async t=>{
  const f=await fixture(t),policy=f.open('cleanup-lock');assert.equal((await policy.ready()).ok,true);const filename=path.join(policy.storageDirectory,'.owner.lock'),bytes=await fs.readFile(filename),unlink=fs.unlink;
  const mocked=t.mock.method(fs,'unlink',async(...args)=>{if(args[0]===filename)throw Object.assign(new Error('Injected unlink failure'),{code:'EPERM'});return unlink(...args);});
  try{
    assert.deepEqual(await policy.close(),{closed:false});assert.equal(await fs.readFile(filename,'utf8'),bytes.toString('utf8'));
    const contender=f.open('cleanup-lock');assert.equal((await contender.ready()).error.code,'ACCESS_POLICY_LOCKED');assert.deepEqual(await fs.readFile(filename),bytes);
  }finally{mocked.mock.restore();}
  assert.deepEqual(await policy.close(),{closed:true});await assert.rejects(fs.lstat(filename),{code:'ENOENT'});
});
