import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createAccessPolicy} from '../lib/access-policy.mjs';
import {createAccessFileTools} from '../lib/access-file-tools.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-access-files-')),state=path.join(root,'state'),project=path.join(root,'project'),other=path.join(root,'other');await Promise.all([state,project,other].map(p=>fs.mkdir(p)));const policy=createAccessPolicy({stateDirectory:state,accountScope:'research:local'});await policy.ready();const tools=createAccessFileTools({policy});t.after(async()=>{await tools.close();await policy.close();assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('buildx-access-files-'));await fs.rm(root,{recursive:true,force:true});});const grant=async mode=>{const value=(await policy.describe()).value;return policy.update({mode,roots:mode==='full-access'?[]:[project],confirmedFullAccess:mode==='full-access',expectedRevision:value.revision});};return {root,state,project,other,policy,tools,grant};}

test('project text read/create/replace preserve exact source versions and durable original backup',async t=>{
  const f=await fixture(t);await f.grant('project-write');const target=path.join(f.project,'说明.md'),original='原始正文\n第二行';await fs.writeFile(target,original);
  const read=await f.tools.invoke('buildx_file_read',{path:target,max_chars:3});assert.equal(read.ok,true);assert.equal(read.value.text,original.slice(0,3));assert.equal(read.value.complete,false);const second=await f.tools.invoke('buildx_file_read',{path:target,offset:read.value.nextOffset,sha256:read.value.sha256});assert.equal(second.value.text,original.slice(3));
  const changed=await f.tools.invoke('buildx_file_write',{path:target,content:'改后文本',expected_sha256:read.value.sha256});assert.equal(changed.ok,true);assert.equal(await fs.readFile(target,'utf8'),'改后文本');assert.equal(await fs.readFile(changed.value.backupPath,'utf8'),original);assert.equal(changed.value.sha256,hash(Buffer.from('改后文本')));
  const created=await f.tools.invoke('buildx_file_write',{path:path.join(f.project,'新文件.txt'),content:'新建',create:true});assert.equal(created.ok,true);assert.equal(created.value.created,true);assert.equal((await f.tools.invoke('buildx_file_write',{path:path.join(f.project,'新文件.txt'),content:'覆盖',create:true})).error.code,'ACCESS_FILE_EXISTS');
});

test('wrong digest, context revocation and changed policy never overwrite the target',async t=>{
  const f=await fixture(t);await f.grant('project-write');const target=path.join(f.project,'a.txt');await fs.writeFile(target,'must remain');
  assert.equal((await f.tools.invoke('buildx_file_write',{path:target,content:'bad',expected_sha256:'a'.repeat(64)})).error.code,'ACCESS_FILE_CHANGED');
  assert.equal((await f.tools.invoke('buildx_file_write',{path:target,content:'bad',expected_sha256:hash(Buffer.from('must remain'))},{isCurrent:()=>false})).ok,false);assert.equal(await fs.readFile(target,'utf8'),'must remain');
  await f.grant('read-only');assert.equal((await f.tools.invoke('buildx_file_write',{path:target,content:'bad',expected_sha256:hash(Buffer.from('must remain'))})).error.code,'ACCESS_READ_ONLY');assert.equal((await f.tools.invoke('buildx_file_read',{path:target})).ok,true);
});

test('full access can read external normal text while project scope, links, binary and policy state remain explicit',async t=>{
  const f=await fixture(t);await f.grant('project-write');const outside=path.join(f.other,'outside.txt');await fs.writeFile(outside,'outside');assert.equal((await f.tools.invoke('buildx_file_read',{path:outside})).error.code,'ACCESS_PATH_OUTSIDE_SCOPE');
  await f.grant('full-access');assert.equal((await f.tools.invoke('buildx_file_read',{path:outside})).value.text,'outside');const binary=path.join(f.project,'binary.bin');await fs.writeFile(binary,Buffer.from([0,1,2]));assert.equal((await f.tools.invoke('buildx_file_read',{path:binary})).error.code,'ACCESS_BINARY_UNSUPPORTED');
  const target=path.join(f.project,'link.txt');await fs.symlink(outside,target,process.platform==='win32'?'file':undefined);assert.equal((await f.tools.invoke('buildx_file_read',{path:target})).ok,false);
  const policyFile=path.join(f.policy.storageDirectory,'policy-00000001.json');assert.equal((await f.tools.invoke('buildx_file_write',{path:policyFile,content:'{}',expected_sha256:'a'.repeat(64)})).error.code,'ACCESS_POLICY_PATH_RESERVED');
});

test('directory listing is paged, text input is bounded and owner close prevents new work',async t=>{
  const f=await fixture(t);await f.grant('project-write');await Promise.all(['a.txt','b.txt','c.txt'].map(name=>fs.writeFile(path.join(f.project,name),name)));
  const first=await f.tools.invoke('buildx_file_list',{path:f.project,limit:2});assert.deepEqual(first.value.entries.map(item=>item.name),['a.txt','b.txt']);assert.equal(first.value.complete,false);const last=await f.tools.invoke('buildx_file_list',{path:f.project,offset:first.value.nextOffset,limit:2});assert.equal(last.value.complete,true);
  assert.equal((await f.tools.invoke('buildx_file_write',{path:path.join(f.project,'too-big.txt'),content:'中'.repeat(400000),create:true})).error.code,'ACCESS_FILE_UNSUPPORTED');
  assert.deepEqual(await f.tools.close(),{closed:true});assert.equal((await f.tools.invoke('buildx_file_list',{path:f.project})).error.code,'ACCESS_FILE_BUSY');
});

test('a policy revoked during the actual file read suppresses the late text result',async t=>{
  const f=await fixture(t);await f.grant('project-write');const target=path.join(f.project,'late.txt');await fs.writeFile(target,'not returned after revocation');
  const originalOpen=fs.open;let delayed=false;
  fs.open=async function(filename,...args){const handle=await originalOpen.call(this,filename,...args);if(filename===target&&!delayed){delayed=true;const originalRead=handle.read.bind(handle);handle.read=async(...values)=>{await f.grant('read-only');return originalRead(...values);};}return handle;};
  try{const result=await f.tools.invoke('buildx_file_read',{path:target});assert.equal(result.ok,false);assert.equal(result.value,undefined);assert.equal(result.error.code,'ACCESS_POLICY_CHANGED');}finally{fs.open=originalOpen;}
});

test('failure while staging a replacement leaves original bytes and an owned recovery backup intact',async t=>{
  const f=await fixture(t);await f.grant('project-write');const target=path.join(f.project,'keep.txt'),source='original must remain';await fs.writeFile(target,source);
  const originalOpen=fs.open;
  fs.open=async function(filename,...args){if(typeof filename==='string'&&filename.includes('.buildx-write-'))throw Object.assign(new Error('controlled staging failure'),{code:'EACCES'});return originalOpen.call(this,filename,...args);};
  try{const result=await f.tools.invoke('buildx_file_write',{path:target,content:'replacement',expected_sha256:hash(Buffer.from(source))});assert.equal(result.ok,false);assert.equal(await fs.readFile(target,'utf8'),source);const names=await fs.readdir(f.policy.backupDirectory);const backup=names.find(name=>name.endsWith('.bin'));assert.ok(backup);assert.equal(await fs.readFile(path.join(f.policy.backupDirectory,backup),'utf8'),source);}finally{fs.open=originalOpen;}
});
