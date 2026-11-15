import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createCustomerComponentBuilder} from '../lib/customer-component-builder.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const encoded=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const definition=Object.freeze({
  component:'buildx-evidence-fixture',stage:'evidence-fixture-component',
  manifest:'release/evidence.json',outputBase:'evidence-fixture',
  roles:Object.freeze(['entry']),exactPaths:Object.freeze(['public/index.html']),
  entryPath:'public/index.html',generatedFiles:Object.freeze({}),
});

async function fixture(t){
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'buildx-component-evidence-'));
  t.after(async()=>{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(parent));
    assert.ok(path.basename(root).startsWith('buildx-component-evidence-'));
    assert.equal(await fs.realpath(root),root);
    await fs.rm(root,{recursive:true});
  });
  await fs.mkdir(path.join(root,'release'));await fs.mkdir(path.join(root,'public'));
  const source=Buffer.from('<!doctype html><title>Independent component evidence fixture</title>\n');
  await fs.writeFile(path.join(root,'public/index.html'),source);
  const manifest={schemaVersion:1,component:definition.component,releaseReady:false,entries:[{
    path:'public/index.html',sha256:sha(source),byteLength:source.length,role:'entry',dependencies:[],provenance:'BuildX application source',
  }]};
  await fs.writeFile(path.join(root,definition.manifest),encoded(manifest));
  return {root,source,output:path.join(root,'artifacts',definition.outputBase,'candidate'),builder:createCustomerComponentBuilder(definition)};
}

test('successful build and fresh verify expose the exact final metadata digest without changing metadata or payload semantics',async t=>{
  const f=await fixture(t),planned=await f.builder.plan({root:f.root});assert.equal(planned.ok,true);
  assert.equal(Object.hasOwn(planned.value,'buildManifest'),false);
  const built=await f.builder.build({root:f.root,output:f.output});assert.equal(built.ok,true);
  const filename=path.join(f.output,'BUILD-MANIFEST.json'),before=await fs.readFile(filename);
  const facts={path:'BUILD-MANIFEST.json',sha256:sha(before),byteLength:before.length};
  assert.deepEqual(built.value.buildManifest,facts);
  assert.deepEqual(before,encoded(planned.value));assert.equal(Object.hasOwn(JSON.parse(before),'buildManifest'),false);
  assert.equal(built.value.totalBytes,f.source.length);assert.equal(built.value.fileCount,2);
  const checked=await f.builder.verify({root:f.root,output:f.output});assert.equal(checked.ok,true);
  assert.deepEqual(checked.value.buildManifest,facts);assert.deepEqual(await fs.readFile(filename),before);
});

test('metadata with unchanged JSON meaning but changed bytes cannot acquire trusted metadata evidence',async t=>{
  const f=await fixture(t);assert.equal((await f.builder.build({root:f.root,output:f.output})).ok,true);
  const filename=path.join(f.output,'BUILD-MANIFEST.json'),original=await fs.readFile(filename);
  await fs.appendFile(filename,' ');
  assert.deepEqual(JSON.parse(await fs.readFile(filename,'utf8')),JSON.parse(original));
  const result=await f.builder.verify({root:f.root,output:f.output});
  assert.equal(result.ok,false);assert.equal(result.error.code,'ARTIFACT_INVALID');assert.equal(Object.hasOwn(result,'value'),false);
});

test('an unconfirmed metadata close yields no evidence and retains the original handle and cleanup identifier across retries',async t=>{
  const f=await fixture(t);assert.equal((await f.builder.build({root:f.root,output:f.output})).ok,true);
  const target=path.join(f.output,'BUILD-MANIFEST.json'),originalOpen=fs.open;
  let retained=null,closeCalls=0,openCalls=0,cleanupId=null;
  fs.open=async function(filename,...args){
    openCalls++;const handle=await originalOpen.call(fs,filename,...args);
    if(retained===null&&path.resolve(filename)===target){
      retained=handle;const exactClose=handle.close.bind(handle);
      handle.close=async()=>{closeCalls++;if(closeCalls<=2)throw new Error('Fixture metadata close not confirmed');return exactClose();};
    }
    return handle;
  };
  try{
    const first=await f.builder.verify({root:f.root,output:f.output});
    cleanupId=first.error?.cleanupIds?.[0];
    assert.equal(first.ok,false);assert.equal(first.error.code,'CLEANUP_PENDING');assert.equal(Object.hasOwn(first,'value'),false);
    assert.equal(first.error.cleanupPending,true);assert.equal(first.error.cleanupIds.length,1);assert.equal(typeof cleanupId,'string');
    assert.ok(retained);assert.equal(closeCalls,1);
    const readsBefore=openCalls,blocked=await f.builder.verify({root:f.root,output:f.output});
    assert.equal(blocked.ok,false);assert.equal(blocked.error.code,'CLEANUP_PENDING');assert.deepEqual(blocked.error.cleanupIds,[cleanupId]);
    assert.equal(openCalls,readsBefore,'Unconfirmed cleanup must block fresh verification, not issue a new proof');
    const second=await f.builder.cleanup({cleanupId});
    assert.equal(second.ok,false);assert.equal(second.error.code,'CLEANUP_PENDING');assert.deepEqual(second.error.cleanupIds,[cleanupId]);
    assert.equal(closeCalls,2);assert.equal(openCalls,readsBefore);
    const cleaned=await f.builder.cleanup({cleanupId});assert.equal(cleaned.ok,true);assert.equal(cleaned.value.closed,true);assert.equal(cleaned.value.kind,'file');assert.equal(cleaned.value.remaining,0);
    assert.equal(closeCalls,3);cleanupId=null;
    const checked=await f.builder.verify({root:f.root,output:f.output});assert.equal(checked.ok,true);
    const bytes=await fs.readFile(target);assert.deepEqual(checked.value.buildManifest,{path:'BUILD-MANIFEST.json',sha256:sha(bytes),byteLength:bytes.length});
  }finally{
    fs.open=originalOpen;
    if(cleanupId){let outcome=await f.builder.cleanup({cleanupId});if(!outcome.ok)outcome=await f.builder.cleanup({cleanupId});assert.equal(outcome.ok,true);}
  }
});
