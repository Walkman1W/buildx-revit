import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {link,mkdir,mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createGeneratedFileOwner,readPumpFileParameters} from './lib/generated-file-owner.mjs';

const pump=Object.freeze({file_name:'卧式端吸泵 P1',width_mm:500,depth_mm:620,height_mm:450,
  inlet_diameter_mm:120,outlet_diameter_mm:100,system:'hydronic_supply'});
const scope={conversationId:'conversation-1',accountId:'account-1'};
const fixtureContents=Buffer.from('native artifact fixture');
const sha256=data=>createHash('sha256').update(data).digest('hex');

async function fixture(t){
  const tempDirectory=path.resolve(os.tmpdir());
  const dataRoot=await mkdtemp(path.join(tempDirectory,'buildx-generated-files-'));
  t.after(async()=>{
    assert.equal(path.dirname(path.resolve(dataRoot)),tempDirectory);
    assert.match(path.basename(dataRoot),/^buildx-generated-files-[A-Za-z0-9]+$/);
    await rm(dataRoot,{recursive:true,force:true});
  });
  const owner=createGeneratedFileOwner({dataRoot});
  await mkdir(owner.outputDirectory,{recursive:true});
  return {owner,dataRoot};
}

async function nativeArtifact(owner,requestId,{data=fixtureContents,fileName=pump.file_name+'-'+requestId.replaceAll('-','')+'.rfa'}={}){
  await writeFile(path.join(owner.outputDirectory,fileName),data,{flag:'wx'});
  return {ok:true,value:{file_name:fileName,bytes:data.length,reopened:true,sha256:sha256(data)}};
}

test('pump file schema rejects path, extension, device names and geometrically invalid connectors',()=>{
  assert.deepEqual(readPumpFileParameters(pump),pump);
  for(const patch of [{file_name:'../sink'},{file_name:'name.rfa'},{file_name:'A/B'},{file_name:'CON'},{file_name:'P1 '},
    {file_name:'_P1'},{file_name:'a'.repeat(49)},{height_mm:NaN},{width_mm:149},{depth_mm:6001},
    {inlet_diameter_mm:136},{outlet_diameter_mm:9},{system:'unknown'},{output_path:'C:\\anything'}]){
    assert.throws(()=>readPumpFileParameters({...pump,...patch}),TypeError);
  }
});

test('a generated RFA is returned only after matching the original native receipt and remains readable after restart',async t=>{
  const {owner,dataRoot}=await fixture(t),requestId=randomUUID();
  const saved=await owner.execute({scope,requestId,parameters:pump,invoke:async input=>{
    assert.equal(input.requestId,requestId);
    assert.deepEqual(input.parameters,pump);
    return nativeArtifact(owner,requestId);
  }});
  assert.equal(saved.status,'completed');
  assert.equal(saved.artifact.kind,'file');
  assert.equal(saved.artifact.fileName,pump.file_name+'-'+requestId.replaceAll('-','')+'.rfa');
  assert.equal(Object.hasOwn(saved.artifact,'path'),false);
  const restarted=createGeneratedFileOwner({dataRoot});
  assert.deepEqual(await restarted.list({scope}),[saved.artifact]);
  const opened=await restarted.read({scope,artifactId:requestId});
  assert.deepEqual(opened.data,fixtureContents);
  assert.equal(opened.path,path.join(owner.outputDirectory,saved.artifact.fileName));
  const repeat=await restarted.execute({scope,requestId,parameters:pump,invoke:()=>assert.fail('Terminal request replayed')});
  assert.deepEqual(repeat,saved);
});

test('concurrent owner instances cannot enqueue a job twice and a delayed original receipt can recover after restart',async t=>{
  const {owner,dataRoot}=await fixture(t),requestId=randomUUID(),peer=createGeneratedFileOwner({dataRoot});
  let submissions=0;
  const invoke=async()=>{submissions++;throw new Error('lost original queue response');};
  const one=owner.execute({scope,requestId,parameters:pump,invoke});
  const two=peer.execute({scope,requestId,parameters:pump,invoke});
  assert.deepEqual((await Promise.all([one,two])).map(result=>result.status),['unknown','unknown']);
  assert.equal(submissions,1);
  const records=await readdir(path.join(dataRoot,'generated-file-jobs'));
  assert.deepEqual(records.filter(name=>name.endsWith('.request.json')),[requestId+'.request.json']);
  assert.equal(records.filter(name=>name.endsWith('.spec.json')).length,1);
  const restarted=createGeneratedFileOwner({dataRoot});
  const pending=await restarted.execute({scope,requestId,parameters:pump,invoke});
  assert.equal(pending.status,'unknown');
  assert.equal(submissions,1);
  assert.deepEqual(await restarted.pending({scope}),[{artifactId:requestId,fileName:pump.file_name+'-'+requestId.replaceAll('-','')+'.rfa'}]);
  const blocked=await restarted.execute({scope,requestId:randomUUID(),parameters:pump,invoke});
  assert.deepEqual(blocked,pending);
  assert.equal(submissions,1);
  assert.equal((await restarted.pending({scope})).length,1);
  const receipt=await nativeArtifact(owner,requestId);
  const recovered=await restarted.recover({scope,artifactId:requestId,observe:async input=>{
    assert.equal(input.requestId,requestId);
    assert.deepEqual(input.parameters,pump);
    return receipt;
  }});
  assert.equal(recovered.status,'completed');
  assert.deepEqual(await restarted.list({scope}),[recovered.artifact]);
  assert.deepEqual(await restarted.pending({scope}),[]);
  const repeatId=randomUUID();
  const repeat=await restarted.execute({scope,requestId:repeatId,parameters:pump,invoke:()=>nativeArtifact(owner,repeatId)});
  assert.equal(repeat.status,'completed');
});

test('scope change, malformed or mismatched receipts, and byte or inode changes block file delivery',async t=>{
  const {owner}=await fixture(t),requestId=randomUUID();
  let receipt;
  const mismatch=await owner.execute({scope,requestId,parameters:pump,invoke:async()=>{
    receipt=await nativeArtifact(owner,requestId);
    return {...receipt,value:{...receipt.value,file_name:'someone-else.rfa'}};
  }});
  assert.equal(mismatch.status,'unknown');
  assert.equal(await owner.read({scope,artifactId:requestId}),null);
  for(const deniedScope of [{...scope,accountId:'account-2'},{...scope,conversationId:'conversation-2'}]){
    assert.equal(await owner.recover({scope:deniedScope,artifactId:requestId,observe:()=>assert.fail('Foreign receipt observed')}),null);
    assert.deepEqual(await owner.list({scope:deniedScope}),[]);
  }
  assert.equal((await owner.recover({scope,artifactId:requestId,observe:async()=>receipt})).status,'completed');
  assert.equal(await owner.read({scope,artifactId:requestId,shouldContinue:()=>false}),null);
  const written=path.join(owner.outputDirectory,receipt.value.file_name);
  await link(written,path.join(owner.outputDirectory,'other-name.rfa'));
  assert.equal(await owner.read({scope,artifactId:requestId}),null);
  await rm(path.join(owner.outputDirectory,'other-name.rfa'));
  await writeFile(written,Buffer.alloc(fixtureContents.length,1));
  assert.equal(await owner.read({scope,artifactId:requestId}),null);
});

test('a definite not-started receipt is persisted without invoking the host on retry',async t=>{
  const {owner,dataRoot}=await fixture(t),requestId=randomUUID();
  const failed=await owner.execute({scope,requestId,parameters:pump,invoke:async()=>({ok:false,outcome:'not_started'})});
  assert.equal(failed.code,'GENERATED_FILE_NOT_STARTED');
  const restarted=createGeneratedFileOwner({dataRoot});
  assert.deepEqual(await restarted.execute({scope,requestId,parameters:pump,invoke:()=>assert.fail('Failed job replayed')}),failed);
});

test('a started failure remains recoverable when its receipt conflicts with disk evidence',async t=>{
  const {owner}=await fixture(t),requestId=randomUUID();
  const failed=await owner.execute({scope,requestId,parameters:pump,invoke:async()=>{
    await nativeArtifact(owner,requestId);
    return {ok:false,outcome:'failed',artifactCreated:false,code:'PUMP_GEOMETRY_FAILED'};
  }});
  assert.equal(failed.status,'unknown');
  assert.equal((await owner.pending({scope}))[0].artifactId,requestId);
  assert.equal(await owner.read({scope,artifactId:requestId}),null);
});
