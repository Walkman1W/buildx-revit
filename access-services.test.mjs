import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAccessServices} from './lib/access-services.mjs';
import {createAccessPolicy} from './lib/access-policy.mjs';
import {createAccessFileTools} from './lib/access-file-tools.mjs';

async function fixture(t,options={}){const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-access-services-'));await fs.mkdir(path.join(root,'workbench'));const service=createAccessServices({root,stateDirectory:path.join(root,'state'),...options});t.after(async()=>{assert.equal((await service.close()).closed,true);assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});return {root,service};}
test('cold activations share one owner; policy publication and revocation are verified on disk',async t=>{
  const {root,service}=await fixture(t),scope='controlled-account';const [a,b]=await Promise.all([service.activate(scope),service.activate(scope)]);assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(a.value.id,b.value.id);assert.equal(a.value.mode,'read-only');
  const selected=await service.select(scope,{mode:'full-access',confirmed:true,expectedRevision:0});assert.equal(selected.ok,true);assert.equal(service.current(scope,selected.value),true);
  const projection=JSON.parse(await fs.readFile(path.join(root,'workbench','access-policy.json'),'utf8'));assert.equal(projection.mode,'full-access');assert.equal(projection.id,selected.value.id);
  assert.equal((await service.select(scope,{mode:'full-access',confirmed:false,expectedRevision:selected.value.revision})).ok,false);assert.equal(service.current(scope,selected.value),true);
  assert.equal((await service.deactivate()).closed,true);assert.equal(service.current(scope,selected.value),false);assert.equal(JSON.parse(await fs.readFile(path.join(root,'workbench','access-policy.json'),'utf8')).mode,'read-only');
});
test('scope identity, protected authorization files and policy replay remain enforced',async t=>{
  const {root,service}=await fixture(t),scope='first';await service.activate(scope);const full=await service.select(scope,{mode:'full-access',confirmed:true,expectedRevision:0});assert.equal(full.ok,true);
  assert.equal((await service.authorize(scope,path.join(root,'workbench','access-policy.json'),{write:true})).ok,false);
  await service.activate('second');assert.equal(service.current(scope,full.value),false);assert.equal(service.view('second').mode,'read-only');
  assert.equal((await service.authorize('second',path.join(root,'workbench'),{write:true})).ok,false);
  const restored=await service.activate(scope);assert.equal(restored.ok,true);assert.equal(restored.value.mode,'full-access');assert.equal(service.current(scope,full.value),true);
});

test('legacy lock activation settles with its explicit cause and cannot remove an unowned lock',async t=>{
  const {root,service}=await fixture(t),stateDirectory=path.join(root,'state'),scope='legacy-lock';await fs.mkdir(stateDirectory);
  const layout=createAccessPolicy({stateDirectory,accountScope:scope});await fs.mkdir(layout.storageDirectory);const filename=path.join(layout.storageDirectory,'.owner.lock'),bytes=JSON.stringify({schema:1,owner:'previous-owner'});await fs.writeFile(filename,bytes);
  const result=await service.activate(scope);assert.equal(result.ok,false);assert.equal(result.error.code,'ACCESS_POLICY_LOCKED');assert.equal(service.view(scope),null);assert.equal(service.control(scope),null);
  const trace=service.diagnostics(scope);assert.equal(trace.operation,'activate');assert.equal(trace.phase,'error');assert.equal(trace.pending,false);assert.equal(trace.queued,0);assert.equal(trace.errorCode,'ACCESS_POLICY_LOCKED');assert.equal(trace.failurePhase,'policy-lock');assert.ok(Object.isFrozen(trace));assert.equal(JSON.stringify(trace).includes(root),false);
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'workbench','access-policy.json'),'utf8')).mode,'read-only');assert.deepEqual(await service.close(),{closed:true});assert.equal(await fs.readFile(filename,'utf8'),bytes);
});

test('explicit activation retries a failed real owner after the live lock is released and preserves its journal',async t=>{
  let created=0;const {root,service}=await fixture(t,{policyFactory:options=>{created++;return createAccessPolicy(options);}}),stateDirectory=path.join(root,'state'),scope='reconnect';await fs.mkdir(stateDirectory);
  const owner=createAccessPolicy({stateDirectory,accountScope:scope});
  try{
    assert.equal((await owner.ready()).ok,true);const chosen=await owner.update({mode:'full-access',roots:[],confirmedFullAccess:true,expectedRevision:0});assert.equal(chosen.ok,true);
    const filename=path.join(owner.storageDirectory,'.owner.lock'),lock=await fs.readFile(filename),journal=path.join(owner.storageDirectory,'policy-00000001.json'),bytes=await fs.readFile(journal);
    assert.equal((await service.activate(scope)).error.code,'ACCESS_POLICY_LOCKED');assert.deepEqual(await fs.readFile(filename),lock);assert.equal(created,1);
    for(let index=0;index<2;index++){
      assert.equal((await service.authorize(scope,root)).ok,false);assert.equal((await service.invoke('read_file',{path:journal},{scope,isCurrent:()=>true})).ok,false);
    }
    assert.equal(created,1);assert.equal(service.control(scope),null);
    assert.deepEqual(await owner.close(),{closed:true});
    const [first,second]=await Promise.all([service.activate(scope),service.activate(scope)]);assert.equal(first.ok,true);assert.equal(second.ok,true);assert.equal(created,2);
    assert.equal(first.value.id,chosen.value.policy.id);assert.equal(second.value.id,first.value.id);assert.equal(first.value.mode,'full-access');assert.equal(first.value.revision,1);assert.deepEqual(await fs.readFile(journal),bytes);assert.equal(service.diagnostics(scope).phase,'settled');
  }finally{await owner.close();}
});

test('failed owner cleanup must be confirmed before reconnect can create another lock owner',async t=>{
  let created=0,blockClose=true;const {root,service}=await fixture(t,{policyFactory:options=>{
    const policy=createAccessPolicy(options);return ++created===1?Object.freeze({...policy,close:()=>blockClose?Promise.resolve({closed:false}):policy.close()}):policy;
  }}),stateDirectory=path.join(root,'state'),scope='cleanup-reconnect';await fs.mkdir(stateDirectory);
  const layout=createAccessPolicy({stateDirectory,accountScope:scope});await fs.mkdir(layout.storageDirectory);const blocker=path.join(layout.storageDirectory,'unknown-record');await fs.writeFile(blocker,'preserved fixture');
  try{
    assert.equal((await service.activate(scope)).error.code,'ACCESS_POLICY_INVALID');const filename=path.join(layout.storageDirectory,'.owner.lock'),lock=await fs.readFile(filename);await fs.unlink(blocker);
    assert.equal((await service.activate(scope)).error.code,'ACCESS_POLICY_CLEANUP_PENDING');assert.equal(created,1);assert.deepEqual(await fs.readFile(filename),lock);assert.equal(service.diagnostics(scope).failurePhase,'policy-cleanup');
    assert.equal((await service.authorize(scope,root)).ok,false);assert.equal(created,1);blockClose=false;
    const [first,second]=await Promise.all([service.activate(scope),service.activate(scope)]);assert.equal(first.ok,true);assert.equal(second.ok,true);assert.equal(created,2);assert.equal(first.value.id,second.value.id);
  }finally{blockClose=false;}
});

test('file cleanup failure retains the policy lock until a later close confirms release',async t=>{
  let blockClose=true;const {root,service}=await fixture(t,{fileToolsFactory:options=>{
    const files=createAccessFileTools(options);return Object.freeze({...files,close:()=>blockClose?Promise.resolve({closed:false}):files.close()});
  }}),scope='file-cleanup',stateDirectory=path.join(root,'state');
  let contender;
  try{
    assert.equal((await service.activate(scope)).ok,true);contender=createAccessPolicy({stateDirectory,accountScope:scope});const filename=path.join(contender.storageDirectory,'.owner.lock'),bytes=await fs.readFile(filename);
    assert.deepEqual(await service.close(),{closed:false});assert.deepEqual(await fs.readFile(filename),bytes);assert.equal((await contender.ready()).error.code,'ACCESS_POLICY_LOCKED');
    blockClose=false;assert.deepEqual(await service.close(),{closed:true});await assert.rejects(fs.lstat(filename),{code:'ENOENT'});
  }finally{blockClose=false;await contender?.close();}
});

test('diagnostics distinguish a blocked producer from a queued account and never grant access',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-access-preparation-'));await fs.mkdir(path.join(root,'workbench'));
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const service=createAccessServices({root,stateDirectory:path.join(root,'state'),policyFactory:options=>{
    const policy=createAccessPolicy(options);if(options.accountScope!=='first')return policy;
    return Object.freeze({...policy,ready:async()=>{options.onStage({phase:'lock'});entered();await gate;return policy.ready();}});
  }});
  t.after(async()=>{release();assert.equal((await service.close()).closed,true);assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('buildx-access-preparation-'));await fs.rm(root,{recursive:true,force:true});});
  assert.equal(service.diagnostics('unknown'),null);const first=service.activate('first');await started;const second=service.activate('second');
  const producer=service.diagnostics('first'),queued=service.diagnostics('second');assert.equal(producer.phase,'policy-lock');assert.equal(producer.pending,true);assert.equal(producer.queued,0);assert.equal(queued.phase,'queued');assert.equal(queued.queued,1);assert.equal(queued.blockingOperation,'activate');assert.equal(queued.blockingPhase,'policy-lock');assert.equal(service.control('first'),null);assert.equal(service.view('first'),null);
  assert.deepEqual(service.diagnostics('first'),producer);assert.equal(Object.hasOwn(producer,'accountScope'),false);assert.equal(JSON.stringify(queued).includes(root),false);
  release();assert.equal((await first).ok,true);assert.equal((await second).ok,true);assert.equal(service.diagnostics('first').phase,'settled');assert.equal(service.diagnostics('second').pending,false);
});
