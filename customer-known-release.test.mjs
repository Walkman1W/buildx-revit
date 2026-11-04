import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createCustomerComponentBuilder} from './lib/customer-component-builder.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const definition=freeze({component:'buildx-known-release-fixture',stage:'known-release-fixture',
  manifest:'release/known.json',outputBase:'known-release',roles:['entry','module'],
  exactPaths:['entry.mjs','lib/action.mjs'],entryPath:'entry.mjs',generatedFiles:{'package.json':'{"version":"fixture-old"}\n'}});
const started=performance.now(),cpuStarted=process.cpuUsage();
test.after(()=>{const cpu=process.cpuUsage(cpuStarted);console.log('KNOWN_RELEASE_TEST_METRICS '+JSON.stringify({
  scope:'this test worker; fixtures, completed verification and cleanup; lifetime RSS high-water',
  pid:process.pid,node:process.version,wallMs:performance.now()-started,cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,
  lifetimePeakRssKiB:process.resourceUsage().maxRSS,processFamilyPeakMemory:null,tokens:null,coldWarmControlled:false}));});

async function fixture(t){
  const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'buildx-known-release-'));
  const real=await fs.realpath(root),identity=await fs.lstat(root,{bigint:true});
  t.after(async()=>{assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('buildx-known-release-'));
    assert.equal(await fs.realpath(root),real);const current=await fs.lstat(root,{bigint:true});
    assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);await fs.rm(root,{recursive:true});});
  await fs.mkdir(path.join(root,'release'));await fs.mkdir(path.join(root,'lib'));
  const manifest={schemaVersion:1,component:definition.component,releaseReady:false,entries:[]};
  for(const [name,role,dependencies] of [['entry.mjs','entry',['lib/action.mjs']],['lib/action.mjs','module',[]]]){
    const data=Buffer.from('fixture old '+name+'\n');await fs.writeFile(path.join(root,name),data);
    manifest.entries.push({path:name,sha256:sha(data),byteLength:data.length,role,dependencies,provenance:'BuildX application source'});
  }
  const manifestJson=json(manifest);await fs.writeFile(path.join(root,'release/known.json'),manifestJson);
  const initial=createCustomerComponentBuilder(definition),output=path.join(root,'artifacts/known-release/old-candidate');
  const built=await initial.build({root,output});assert.equal(built.ok,true);
  const releaseId=built.value.buildManifest.sha256;
  const record=freeze({releaseId,definition,manifestJson});
  const builder=createCustomerComponentBuilder(definition,freeze({knownReleases:[record]}));
  return {root,output,manifest,manifestJson,releaseId,record,builder};
}

test('fixed known bytes survive changed or missing current sources, manifest, stage and generated package without trusting artifact metadata',async t=>{
  const f=await fixture(t);
  const next=freeze({...definition,stage:'next-fixture-stage',generatedFiles:{'package.json':'{"version":"fixture-next"}\n'}});
  const builder=createCustomerComponentBuilder(next,freeze({knownReleases:[f.record]}));
  await fs.writeFile(path.join(f.root,'entry.mjs'),'changed current source\n');
  const first=await builder.verifyKnownRelease({root:f.root,output:f.output,releaseId:f.releaseId});assert.equal(first.ok,true);
  assert.equal(first.value.verifiedAgainst,'known_release_definition');assert.equal(first.value.releaseId,f.releaseId);
  assert.equal(first.value.buildManifest.sha256,f.releaseId);assert.equal(first.value.stage,definition.stage);
  assert.equal(first.value.releaseReady,false);assert.equal(first.value.fileCount,4);
  assert.equal((await builder.verify({root:f.root,output:f.output})).error.code,'INPUT_CHANGED');
  assert.throws(()=>{first.value.entries[0].sha256='0'.repeat(64);},TypeError);
  await fs.unlink(path.join(f.root,'release/known.json'));await fs.unlink(path.join(f.root,'entry.mjs'));await fs.unlink(path.join(f.root,'lib/action.mjs'));
  const second=await builder.verifyKnownRelease({root:f.root,output:f.output,releaseId:f.releaseId});assert.equal(second.ok,true);
  assert.deepEqual(second.value,first.value);
});

test('unknown release and malformed or claimed proof inputs reject before any filesystem observation',async()=>{
  const builder=createCustomerComponentBuilder(definition),root=path.resolve(os.tmpdir(),'not-created-known-source'),output=path.join(root,'artifacts/known-release/absent');
  const original=fs.lstat;let observations=0,getterReads=0;
  fs.lstat=async(...args)=>{observations++;return original(...args);};
  try{
    assert.equal((await builder.verifyKnownRelease({root,output,releaseId:'0'.repeat(64)})).error.code,'KNOWN_RELEASE_UNAVAILABLE');
    for(const extra of [{manifestJson:'{}'},{verified:{ok:true}},{verify:()=>true}])assert.equal((await builder.verifyKnownRelease({root,output,releaseId:'0'.repeat(64),...extra})).error.code,'INVALID_INPUT');
    const getter={root,output};Object.defineProperty(getter,'releaseId',{enumerable:true,get(){getterReads++;return '0'.repeat(64);}});
    assert.equal((await builder.verifyKnownRelease(getter)).error.code,'INVALID_INPUT');
    for(const bad of [null,[],{},new Date(),{root,output,releaseId:'not-a-version'},{root:'relative',output,releaseId:'0'.repeat(64)}])assert.equal((await builder.verifyKnownRelease(bad)).error.code,'INVALID_INPUT');
    assert.equal((await builder.verifyKnownRelease(new Proxy({root,output,releaseId:'0'.repeat(64)},{ownKeys(){throw new Error('unavailable');}}))).error.code,'INVALID_INPUT');
    assert.equal(observations,0);assert.equal(getterReads,0);
  }finally{fs.lstat=original;}
});

test('registration is immutable, exact, bounded and bound to its own complete definition and expected BUILD identity',async t=>{
  const f=await fixture(t);
  const badRecords=[
    {...f.record,releaseId:'0'.repeat(64)},
    {...f.record,manifestJson:'{}'},
    {...f.record,definition:{...definition,component:'buildx-other'}},
    {...f.record,definition:{...definition,outputBase:'other-base'}},
    {...f.record,definition:{...definition,generatedFiles:{'package.json':'changed\n'}}},
    {...f.record,artifactProof:{ok:true}},
  ];
  for(const record of badRecords)assert.throws(()=>createCustomerComponentBuilder(definition,freeze({knownReleases:[record]})));
  const oversizedManifest=' '.repeat(64*1024+1),originalFrom=Buffer.from;let oversizedCopies=0;
  Buffer.from=function(value,...args){if(value===oversizedManifest)oversizedCopies++;return originalFrom.call(Buffer,value,...args);};
  try{assert.throws(()=>createCustomerComponentBuilder(definition,freeze({knownReleases:[{...f.record,manifestJson:oversizedManifest}]})));}
  finally{Buffer.from=originalFrom;}
  assert.equal(oversizedCopies,0,'the manifest byte budget must reject before copying its string into a Buffer');
  assert.throws(()=>createCustomerComponentBuilder(definition,{knownReleases:[f.record]}));
  assert.throws(()=>createCustomerComponentBuilder(definition,freeze({knownReleases:[f.record,f.record]})));
  assert.throws(()=>createCustomerComponentBuilder(definition,freeze({knownReleases:[f.record],fallback:true})));
  let reads=0;const accessor={};Object.defineProperty(accessor,'knownReleases',{get(){reads++;return [f.record];}});Object.freeze(accessor);
  assert.throws(()=>createCustomerComponentBuilder(definition,accessor));assert.equal(reads,0);
  const hole=new Array(1);Object.freeze(hole);assert.throws(()=>createCustomerComponentBuilder(definition,freeze({knownReleases:hole})));
});

test('known verification rejects altered raw, package, BUILD, extra runtime and linked files using original artifact reader',async t=>{
  for(const mutation of ['raw','package','build','runtime','hardlink','junction']){
    const f=await fixture(t);
    if(mutation==='raw')await fs.appendFile(path.join(f.output,'entry.mjs'),'changed');
    if(mutation==='package')await fs.writeFile(path.join(f.output,'package.json'),'{}\n');
    if(mutation==='build')await fs.appendFile(path.join(f.output,'BUILD-MANIFEST.json'),' ');
    if(mutation==='runtime')await fs.mkdir(path.join(f.output,'runtime'));
    if(mutation==='hardlink')await fs.link(path.join(f.output,'entry.mjs'),path.join(f.root,'linked-entry'));
    if(mutation==='junction'){
      const target=path.join(f.root,'relocated-lib');await fs.rename(path.join(f.output,'lib'),target);
      await fs.symlink(target,path.join(f.output,'lib'),process.platform==='win32'?'junction':'dir');
    }
    const result=await f.builder.verifyKnownRelease({root:f.root,output:f.output,releaseId:f.releaseId});
    assert.equal(result.ok,false,mutation);assert.ok(['ARTIFACT_INVALID','LINK_REJECTED','INPUT_CHANGED'].includes(result.error.code),mutation);
  }
});

test('current and known definitions reject generated single-file, aggregate and count budgets before any generated Buffer copies',async t=>{
  const f=await fixture(t);
  const cases=[
    {'oversized.txt':'oversized:'+ 'x'.repeat(256*1024)},
    Object.fromEntries(Array.from({length:5},(_,i)=>['total-'+i+'.txt',i+':'+ 't'.repeat(256*1024-2)])),
    Object.fromEntries(Array.from({length:31},(_,i)=>['count-'+i+'.txt','count-content-'+i])),
  ];
  for(const generatedFiles of cases){
    const tracked=new Set(Object.values(generatedFiles)),bad=freeze({...definition,generatedFiles}),originalFrom=Buffer.from;let generatedCopies=0;
    Buffer.from=function(value,...args){if(tracked.has(value))generatedCopies++;return originalFrom.call(Buffer,value,...args);};
    try{
      assert.throws(()=>createCustomerComponentBuilder(bad),/Invalid generated component budget/);
      assert.throws(()=>createCustomerComponentBuilder(definition,freeze({knownReleases:[{...f.record,definition:bad}]})),/Invalid generated component budget/);
    }finally{Buffer.from=originalFrom;}
    assert.equal(generatedCopies,0,'all generated content budgets must reject before copying any generated input string');
  }
});

test('known and current operations share the exact failed FileHandle and only original cleanup closes it without rereading',async t=>{
  const f=await fixture(t),target=path.join(f.output,'entry.mjs'),original=fs.open;
  let held=null,closeCalls=0,readOpens=0,cleanupId=null;
  fs.open=async function(name,...args){readOpens++;const opened=await original.call(fs,name,...args);
    if(held===null&&path.resolve(name)===target){held=opened;const realClose=opened.close.bind(opened);
      opened.close=async()=>{closeCalls++;if(closeCalls<=2)throw new Error('controlled close not confirmed');return realClose();};}
    return opened;
  };
  try{
    const failed=await f.builder.verifyKnownRelease({root:f.root,output:f.output,releaseId:f.releaseId});assert.equal(failed.error.code,'CLEANUP_PENDING');cleanupId=failed.error.cleanupIds[0];
    const before=readOpens;assert.equal(closeCalls,1);assert.ok(held);
    for(const operation of [()=>f.builder.plan({root:f.root}),()=>f.builder.verify({root:f.root,output:f.output}),()=>f.builder.verifyKnownRelease({root:f.root,output:f.output,releaseId:f.releaseId}),()=>f.builder.build({root:f.root,output:path.join(f.root,'artifacts/known-release/blocked')})])assert.equal((await operation()).error.code,'CLEANUP_PENDING');
    assert.equal(readOpens,before);
    const other=createCustomerComponentBuilder(definition,freeze({knownReleases:[f.record]}));assert.equal((await other.cleanup({cleanupId})).error.code,'CLEANUP_ID_INVALID');
    assert.equal((await f.builder.cleanup({cleanupId})).error.code,'CLEANUP_PENDING');assert.equal(closeCalls,2);assert.equal(readOpens,before);
    assert.equal((await f.builder.verifyKnownRelease({root:f.root,output:f.output,releaseId:f.releaseId})).error.code,'CLEANUP_PENDING');
    const done=await f.builder.cleanup({cleanupId});assert.equal(done.ok,true);assert.equal(done.value.kind,'file');assert.equal(done.value.closed,true);cleanupId=null;
    assert.equal(closeCalls,3);assert.equal(readOpens,before);
    assert.equal((await f.builder.verifyKnownRelease({root:f.root,output:f.output,releaseId:f.releaseId})).ok,true);
  }finally{fs.open=original;if(cleanupId)assert.equal((await f.builder.cleanup({cleanupId})).ok,true);}
});
