import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildCustomerChatPackage} from './lib/customer-chat-package.mjs';
import {snapshotCustomerComponent} from './test-support/customer-chat-fixture.mjs';

const source=path.dirname(fileURLToPath(import.meta.url));
const template=JSON.parse(await fs.readFile(path.join(source,'release/customer-chat-component.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const executableFiles=['customer-install-plan.mjs','lib/customer-install-plan.mjs','lib/customer-chat-package.mjs','lib/customer-component-builder.mjs','lib/customer-component-definitions.mjs','release/customer-chat-known-releases.mjs'];

async function fixture(t,withArtifact){
  const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'buildx-install-cli-'));
  const identity=await fs.realpath(root),owned=new Set();
  t.after(async()=>{
    assert.equal(owned.size,0,'Retain fixture if a child close is unconfirmed');
    assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('buildx-install-cli-'));
    assert.equal(await fs.realpath(root),identity);await fs.rm(root,{recursive:true});
    await assert.rejects(fs.stat(root),{code:'ENOENT'});
  });
  for(const name of executableFiles){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.copyFile(path.join(source,name),path.join(root,name));}
  const artifact=path.join(root,'artifacts/customer-chat/fixture');
  if(withArtifact){
    const manifest=structuredClone(template);
    for(const entry of manifest.entries){const bytes=Buffer.from('Installation plan fixture only: '+entry.path+'\n');
      await fs.mkdir(path.dirname(path.join(root,entry.path)),{recursive:true});await fs.writeFile(path.join(root,entry.path),bytes);
      entry.sha256=hash(bytes);entry.byteLength=bytes.length;
    }
    await fs.writeFile(path.join(root,'release/customer-chat-component.json'),JSON.stringify(manifest,null,2)+'\n');
    const result=await buildCustomerChatPackage({root,output:artifact});assert.equal(result.ok,true);
  }
  return {root,artifact,target:path.join(root,'target-not-created'),owned};
}
async function cli(f,args){
  const environment={...process.env};delete environment.NODE_OPTIONS;
  const child=spawn(process.execPath,[path.join(f.root,'customer-install-plan.mjs'),...args],{cwd:f.root,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  f.owned.add(child);const stdout=[],stderr=[];let problem=null;
  child.stdout.on('data',bytes=>stdout.push(bytes));child.stderr.on('data',bytes=>stderr.push(bytes));
  child.on('error',error=>{problem=error;});
  const terminal=await new Promise(resolve=>child.once('close',(code,signal)=>{f.owned.delete(child);resolve({code,signal});}));
  assert.equal(problem,null);assert.equal(terminal.signal,null);assert.equal(Buffer.concat(stderr).length,0);
  return {...terminal,result:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stdout)))};
}

test('production CLI verifies real component bytes and returns a blocked read-only plan without creating its target',{timeout:15000},async t=>{
  const f=await fixture(t,true),before=await snapshotCustomerComponent(f.root);
  const response=await cli(f,['--plan','--artifact',f.artifact,'--target-root',f.target]);
  assert.equal(response.code,0);assert.equal(response.result.ok,true);const plan=response.result.value;
  assert.equal(plan.planOnly,true);assert.equal(plan.readyToApply,false);assert.equal(plan.releaseReady,false);assert.equal(plan.operation,'install');
  assert.equal(plan.artifact.releaseId,hash(await fs.readFile(path.join(f.artifact,'BUILD-MANIFEST.json'))));
  assert.equal(plan.target.existence,'not_checked');assert.equal(plan.target.activeRelease,'not_checked');
  assert.equal(await fs.stat(f.target).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}),false);
  assert.deepEqual(await snapshotCustomerComponent(f.root),before);
});

test('CLI rejects apply before verification even when no release manifest exists',{timeout:15000},async t=>{
  const f=await fixture(t,false),before=await snapshotCustomerComponent(f.root);
  const response=await cli(f,['--apply','--artifact',f.artifact,'--target-root',f.target]);
  assert.equal(response.code,1);assert.equal(response.result.error.code,'INVALID_ARGUMENTS');
  assert.deepEqual(await snapshotCustomerComponent(f.root),before);
});

test('CLI rejects ambiguous duplicate choices instead of choosing an operation or reading the artifact',{timeout:15000},async t=>{
  const f=await fixture(t,false),before=await snapshotCustomerComponent(f.root);
  const response=await cli(f,['--plan','--artifact',f.artifact,'--target-root',f.target,'--operation','install','--operation','rollback']);
  assert.equal(response.code,1);assert.equal(response.result.error.code,'INVALID_ARGUMENTS');
  assert.deepEqual(await snapshotCustomerComponent(f.root),before);
});
