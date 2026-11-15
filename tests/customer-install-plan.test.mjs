import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {planCustomerInstall,cleanupCustomerInstallPlan} from '../lib/customer-install-plan.mjs';
import {buildCustomerChatPackage,verifyCustomerChatPackage,cleanupCustomerChatPackageReads} from '../lib/customer-chat-package.mjs';
import {CUSTOMER_CHAT_COMPONENT_DEFINITION as definition} from '../lib/customer-component-definitions.mjs';

const template=JSON.parse(await fs.readFile(new URL('../release/customer-chat-component.json',import.meta.url),'utf8'));
const hash=data=>createHash('sha256').update(data).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const started=performance.now(),cpuStarted=process.cpuUsage();
test.after(()=>{const cpu=process.cpuUsage(cpuStarted);console.log('CUSTOMER_INSTALL_PLAN_METRICS '+JSON.stringify({
  scope:'this test worker since metric initialization; own fixture creation, plans and cleanup; RSS is process lifetime high-water',
  pid:process.pid,node:process.version,
  wallMs:performance.now()-started,cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,
  lifetimePeakRssKiB:process.resourceUsage().maxRSS,processFamilyPeakMemory:null,tokens:null,coldWarmControlled:false}));});

async function fixture(t){
  const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'buildx-install-plan-test-')),real=await fs.realpath(root);
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),parent);assert.ok(path.basename(root).startsWith('buildx-install-plan-test-'));assert.equal(await fs.realpath(root),real);await fs.rm(root,{recursive:true});});
  const manifest=structuredClone(template);
  await fs.mkdir(path.join(root,'release'));
  for(const entry of manifest.entries){
    const data=Buffer.from('Install plan fixture: '+entry.path+'\n');
    await fs.mkdir(path.dirname(path.join(root,entry.path)),{recursive:true});await fs.writeFile(path.join(root,entry.path),data);
    entry.sha256=hash(data);entry.byteLength=data.length;
  }
  const save=()=>fs.writeFile(path.join(root,...definition.manifest.split('/')),json(manifest));await save();
  const artifact=path.join(root,'artifacts',definition.outputBase,'candidate');
  const built=await buildCustomerChatPackage({root,output:artifact});assert.equal(built.ok,true);
  const targetRoot=process.platform==='win32'?path.join(root,'proposal'):'C:\\BuildX-Plan-Test\\proposal';
  return {root,artifact,targetRoot,manifest,save};
}

async function tree(root){
  const records=[];
  async function walk(relative){
    const directory=path.join(root,relative),entries=(await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    for(const entry of entries){const name=relative?relative+'/'+entry.name:entry.name;
      if(entry.isDirectory()){records.push({path:name,kind:'directory'});await walk(name);}
      else records.push({path:name,kind:'file',sha256:hash(await fs.readFile(path.join(root,name)))});
    }
  }
  await walk('');return records;
}

test('real verified candidate yields three review-only intents bound to exact metadata without creating the target',async t=>{
  const f=await fixture(t),before=await tree(f.root),metadata=await fs.readFile(path.join(f.artifact,'BUILD-MANIFEST.json'));
  for(const operation of ['install','upgrade','rollback']){
    const result=await planCustomerInstall({root:f.root,artifact:f.artifact,targetRoot:f.targetRoot,operation});assert.equal(result.ok,true);
    const plan=result.value;assert.equal(plan.operation,operation);assert.equal(plan.planOnly,true);assert.equal(plan.readyToApply,false);assert.equal(plan.releaseReady,false);
    assert.equal(plan.artifact.releaseId,hash(metadata));assert.equal(plan.artifact.buildManifest.byteLength,metadata.length);
    assert.equal(plan.artifact.totalFileBytes,plan.artifact.payloadBytesExcludingBuildManifest+metadata.length);
    assert.equal(plan.target.requestedRoot,f.targetRoot);assert.equal(plan.target.existence,'not_checked');assert.equal(plan.target.activeRelease,'not_checked');
    assert.equal(plan.target.releaseDirectory,path.win32.join(plan.target.normalizedRoot,'releases',hash(metadata)));
    assert.equal(plan.blockers.some(item=>item.code==='RUNTIME_LAYOUT_COUPLED'),false);
    assert.equal(plan.blockers.find(item=>item.code==='DATA_DIRECTORY_ADMISSION_NOT_CHECKED').status,'not_checked');
    for(const code of ['HISTORICAL_RELEASE_TRUST_UNAVAILABLE','COMMERCIAL_ACCEPTANCE_PENDING'])assert.equal(plan.blockers.find(item=>item.code===code).status,'blocked');
    assert.equal(plan.steps.find(step=>step.id==='select_release').status,'blocked');assert.equal(plan.recovery.globalRollback,false);
    assert.equal(plan.sideEffects.targetInspectionPerformed,false);assert.equal(plan.sideEffects.targetMutationAttempted,false);
    assert.equal(plan.sideEffects.filesystemScope,'current_source_and_artifact_verification_only');assert.equal(plan.sideEffects.processControls,0);
  }
  assert.deepEqual(await tree(f.root),before);
  if(process.platform==='win32')await assert.rejects(fs.lstat(f.targetRoot),{code:'ENOENT'});
  assert.equal(cleanupCustomerInstallPlan,cleanupCustomerChatPackageReads);
});

test('existing target remains unobserved and unchanged; caller mutation cannot change the captured proposal',async t=>{
  const f=await fixture(t);
  if(process.platform==='win32'){await fs.mkdir(f.targetRoot);await fs.writeFile(path.join(f.targetRoot,'user-owned.txt'),'preserve');}
  const before=await tree(f.root),input={root:f.root,artifact:f.artifact,targetRoot:f.targetRoot,operation:'upgrade'};
  const pending=planCustomerInstall(input);input.targetRoot='Z:\\Later-Caller-Value';input.operation='rollback';
  const result=await pending;assert.equal(result.ok,true);assert.equal(result.value.operation,'upgrade');assert.equal(result.value.target.requestedRoot,f.targetRoot);
  assert.equal(result.value.target.physicalIdentity,'not_checked');assert.equal(result.value.target.existence,'not_checked');
  assert.deepEqual(await tree(f.root),before);
  if(process.platform==='win32'){
    const overlap=await planCustomerInstall({root:f.root,artifact:f.artifact,targetRoot:f.artifact,operation:'upgrade'});
    assert.equal(overlap.ok,true);assert.equal(overlap.value.target.requestedRoot,f.artifact);assert.equal(overlap.value.target.observation,'not_checked');
    assert.equal(overlap.value.sideEffects.targetInspectionPerformed,false);assert.equal(overlap.value.sideEffects.targetMutationAttempted,false);
    assert.equal(overlap.value.sideEffects.filesystemScope,'current_source_and_artifact_verification_only');
    assert.equal(Object.hasOwn(overlap.value.sideEffects,'targetFilesystemReads'),false);
  }
  const normalized=await planCustomerInstall({root:f.root,artifact:f.artifact,targetRoot:'c:/BuildX Review/组件',operation:'install'});
  assert.equal(normalized.ok,true);assert.equal(normalized.value.target.requestedRoot,'c:/BuildX Review/组件');assert.equal(normalized.value.target.normalizedRoot,'C:\\BuildX Review\\组件');
});

test('ambiguous Windows targets reject before reading any purported artifact',async()=>{
  const root=path.resolve(os.tmpdir(),'absent-install-plan-root'),artifact=path.join(root,'artifacts','customer-chat','absent');
  for(const targetRoot of ['relative','C:relative','\\\\server\\share\\BuildX','\\\\?\\C:\\BuildX','C:\\','C:\\BuildX\\..\\other','C:\\BuildX:stream','C:\\BuildX\\CON.txt','C:\\BuildX.\\release','C:\\BuildX\\\\release','C:\\BuildX\\'+ 'x'.repeat(256)]){
    const result=await planCustomerInstall({root,artifact,targetRoot});assert.equal(result.ok,false,targetRoot);assert.equal(result.error.code,'INVALID_INSTALL_PLAN_INPUT',targetRoot);
  }
});

test('unknown options, claimed proof and accessor inputs cannot enter verification or authorize an action',async()=>{
  const valid={root:path.resolve(os.tmpdir(),'absent-root'),artifact:path.resolve(os.tmpdir(),'absent-artifact'),targetRoot:'C:\\BuildX-Review'};
  for(const extra of [{operation:'apply'},{operation:null},{readyToApply:true},{verified:{ok:true,value:{}}},{verify:()=>({ok:true})}]){
    const result=await planCustomerInstall({...valid,...extra});assert.equal(result.ok,false);assert.equal(result.error.code,'INVALID_INSTALL_PLAN_INPUT');
  }
  let reads=0;const accessor={...valid};Object.defineProperty(accessor,'targetRoot',{enumerable:true,get(){reads++;return valid.targetRoot;}});
  assert.equal((await planCustomerInstall(accessor)).error.code,'INVALID_INSTALL_PLAN_INPUT');assert.equal(reads,0);
  const unavailable=new Proxy(valid,{getPrototypeOf(){throw new Error('unavailable input');}});
  assert.equal((await planCustomerInstall(unavailable)).error.code,'INVALID_INSTALL_PLAN_INPUT');
});

test('tampered artifact and historical bytes are rejected by the original verifier rather than trusted as rollback proof',async t=>{
  const changed=await fixture(t);await fs.appendFile(path.join(changed.artifact,'BUILD-MANIFEST.json'),' ');
  const original=await verifyCustomerChatPackage({root:changed.root,output:changed.artifact});assert.equal(original.ok,false);
  const composed=await planCustomerInstall({root:changed.root,artifact:changed.artifact,targetRoot:changed.targetRoot,operation:'rollback'});assert.deepEqual(composed,original);
  const historical=await fixture(t),entry=historical.manifest.entries.find(value=>value.path==='lib/chat-session.mjs');
  const bytes=Buffer.from('New current-source revision, old candidate remains unchanged\n');await fs.writeFile(path.join(historical.root,entry.path),bytes);entry.sha256=hash(bytes);entry.byteLength=bytes.length;await historical.save();
  const result=await planCustomerInstall({root:historical.root,artifact:historical.artifact,targetRoot:historical.targetRoot,operation:'rollback'});
  assert.equal(result.ok,false);assert.equal(result.error.code,'ARTIFACT_INVALID');
});
