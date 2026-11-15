import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {detectLocalRuntimes,resolveLocalRuntimes} from '../lib/local-runtimes.mjs';
import {CodexClient} from '../lib/codex-client.mjs';

async function fixture(t){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-detect-'));
  const bin=path.join(home,'bin');await fs.mkdir(bin);
  t.after(async()=>{
    const target=path.resolve(home);
    assert.equal(path.dirname(target),path.resolve(os.tmpdir()));
    assert.match(path.basename(target),/^buildx-detect-/);
    await fs.rm(target,{recursive:true,force:true});
  });
  const env={Path:bin,LOCALAPPDATA:path.join(home,'local')};
  async function file(relative){const target=path.join(home,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,'never execute');return target;}
  return {home,bin,env,file,options:{home,env,executable:path.join(home,'missing','node.exe')}};
}
test('finds all three existing executables without executing them or inspecting login',async t=>{
  const f=await fixture(t);
  const [node,python,codex]=await Promise.all(['bin/node.exe','bin/python.exe','bin/codex.exe'].map(f.file));
  const result=detectLocalRuntimes(f.options);
  assert.equal(result.schemaVersion,1);
  assert.deepEqual(result.runtimes.node,{status:'found',path:node,code:null});
  assert.deepEqual(result.runtimes.python,{status:'found',path:python,code:null});
  assert.deepEqual(result.runtimes.codex,{status:'found',path:codex,code:null});
  assert.deepEqual(resolveLocalRuntimes(f.options),{codex,python});
  assert.equal(result.codexInstallUrl,'https://developers.openai.com/codex/cli/');
});
test('detects independent missing and explicit invalid states without assuming account status',async t=>{
  const f=await fixture(t);f.env.BUILDX_CODEX_EXE='codex.exe';
  const result=detectLocalRuntimes(f.options);
  assert.deepEqual(result.runtimes.node,{status:'missing',path:null,code:'NODE_NOT_FOUND'});
  assert.deepEqual(result.runtimes.python,{status:'missing',path:null,code:'PYTHON_NOT_FOUND'});
  assert.deepEqual(result.runtimes.codex,{status:'invalid',path:null,code:'CODEX_PATH_INVALID'});
  assert.equal(Object.hasOwn(result,'loggedIn'),false);
});
test('npm wrappers are reported as unresolved and never treated as codex.exe',async t=>{
  const f=await fixture(t);await f.file('bin/codex.cmd');
  const status=detectLocalRuntimes(f.options).runtimes.codex;
  assert.deepEqual(status,{status:'unavailable',path:null,code:'CODEX_WRAPPER_ONLY'});
  assert.throws(()=>resolveLocalRuntimes(f.options),{code:'CODEX_WRAPPER_ONLY'});
});
test('an earlier npm wrapper makes a later executable ambiguous instead of silently changing versions',async t=>{
  const f=await fixture(t);await f.file('bin/codex.cmd');
  const exe=await f.file('later/codex.exe');
  f.env.Path=[f.bin,path.dirname(exe)].join(path.delimiter);
  assert.deepEqual(detectLocalRuntimes(f.options).runtimes.codex,{status:'ambiguous',path:null,code:'CODEX_PATH_AMBIGUOUS'});
  await f.file('bin/python.exe');
  assert.throws(()=>resolveLocalRuntimes(f.options),{code:'CODEX_PATH_AMBIGUOUS'});
  f.env.Path=[path.dirname(exe),f.bin].join(path.delimiter);
  assert.equal(detectLocalRuntimes(f.options).runtimes.codex.path,exe);
});
test('WindowsApps Python aliases are not selected or run, even when later PATH has a real executable',async t=>{
  const f=await fixture(t),alias=await f.file('local/Microsoft/WindowsApps/python.exe');
  const python=await f.file('later/python.exe');
  f.env.Path=[path.dirname(alias),path.dirname(python)].join(path.delimiter);
  assert.deepEqual(detectLocalRuntimes(f.options).runtimes.python,{status:'unavailable',path:null,code:'PYTHON_PATH_UNVERIFIED'});
  f.env.BUILDX_PYTHON_EXE=python;
  assert.equal(detectLocalRuntimes(f.options).runtimes.python.path,python);
});
test('installer refuses a manually selected WindowsApps Python alias before running any version probe',async t=>{
  const f=await fixture(t),alias=await f.file('local/Microsoft/WindowsApps/python.exe');
  const node=await f.file('bin/node.exe'),codex=await f.file('bin/codex.exe');
  const pkg=path.join(f.home,'package'),addin=path.join(f.home,'addins'),target=path.join(f.home,'installed');
  await fs.mkdir(pkg);await fs.mkdir(addin);
  const entry=path.join(process.cwd(),'tools','buildx-installer.mjs');
  await assert.rejects(promisify(execFile)(process.execPath,[entry,'--plan',pkg,target,addin,node,alias,codex,path.join(f.home,'data')],{
    windowsHide:true,timeout:10000,env:{...f.env,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}
  }),error=>JSON.parse(error.stderr).code==='PYTHON_PATH_UNVERIFIED');
  await assert.rejects(fs.stat(target),{code:'ENOENT'});
});
test('an npm wrapper and a desktop executable are ambiguous without an explicit choice',async t=>{
  const f=await fixture(t);await f.file('bin/codex.cmd');
  const desktop=await f.file('local/OpenAI/Codex/bin/0123456789abcdef/codex.exe');
  await f.file('bin/python.exe');
  assert.throws(()=>resolveLocalRuntimes(f.options),{code:'CODEX_PATH_AMBIGUOUS'});
  assert.deepEqual(detectLocalRuntimes(f.options).runtimes.codex,{status:'ambiguous',path:null,code:'CODEX_PATH_AMBIGUOUS'});
  f.env.BUILDX_CODEX_EXE=desktop;
  assert.equal(detectLocalRuntimes(f.options).runtimes.codex.path,desktop);
  assert.equal(resolveLocalRuntimes(f.options).codex,desktop);
});
test('multiple desktop executables stay ambiguous; selected path is shared with runtime',async t=>{
  const f=await fixture(t);
  const a=await f.file('local/OpenAI/Codex/bin/0123456789abcdef/codex.exe');
  await f.file('local/OpenAI/Codex/bin/abcdef0123456789/codex.exe');
  const python=await f.file('bin/python.exe');
  assert.deepEqual(detectLocalRuntimes(f.options).runtimes.codex,{status:'ambiguous',path:null,code:'CODEX_PATH_AMBIGUOUS'});
  f.env.BUILDX_CODEX_EXE=a;
  assert.equal(detectLocalRuntimes(f.options).runtimes.codex.path,a);
  assert.deepEqual(resolveLocalRuntimes(f.options),{codex:a,python});
});
test('installer --detect exposes the same independent discovery without side effects',async t=>{
  const f=await fixture(t),codex=await f.file('bin/codex.exe'),python=await f.file('bin/python.exe');
  // Launch only the already-running Node runtime, never the fixture programs.
  const entry=path.join(process.cwd(),'tools','buildx-installer.mjs');
  const {stdout,stderr}=await promisify(execFile)(process.execPath,[entry,'--detect'],{
    windowsHide:true,timeout:10000,env:{...f.env,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),BUILDX_CODEX_EXE:codex,BUILDX_PYTHON_EXE:python}
  });
  const result=JSON.parse(stdout);
  assert.equal(stderr,'');assert.equal(result.schemaVersion,1);
  assert.deepEqual(result.runtimes.codex,{status:'found',path:codex,code:null});
  assert.deepEqual(result.runtimes.python,{status:'found',path:python,code:null});
  assert.equal(Object.hasOwn(result,'account'),false);
});

// Same contract for detection, direct resolver and app-server runtime dependency.
test('stale explicit Codex paths fail closed even when another source is available',async t=>{
  const f=await fixture(t);await f.file('bin/codex.exe');await f.file('bin/python.exe');
  f.env.BUILDX_CODEX_EXE=await f.file('selected/codex.exe');
  assert.equal(resolveLocalRuntimes(f.options).codex,f.env.BUILDX_CODEX_EXE);
  await fs.unlink(f.env.BUILDX_CODEX_EXE);
  assert.deepEqual(detectLocalRuntimes(f.options).runtimes.codex,{status:'invalid',path:null,code:'CODEX_PATH_INVALID'});
  assert.throws(()=>resolveLocalRuntimes(f.options),{code:'CODEX_PATH_INVALID'});
});

test('wrapper ambiguity cannot be bypassed by the obsolete strictWrapper option',async t=>{
  const f=await fixture(t);await f.file('bin/codex.cmd');await f.file('bin/python.exe');
  await f.file('local/OpenAI/Codex/bin/0123456789abcdef/codex.exe');
  const options={...f.options,strictWrapper:false};
  assert.equal(detectLocalRuntimes(options).runtimes.codex.code,'CODEX_PATH_AMBIGUOUS');
  assert.throws(()=>resolveLocalRuntimes(options),error=>error.code==='CODEX_PATH_AMBIGUOUS'&&error.message.includes('BUILDX_CODEX_EXE'));
});

test('production client rejects ambiguous runtime before spawn or account access',async t=>{
  const f=await fixture(t);await f.file('bin/codex.cmd');await f.file('bin/python.exe');
  await f.file('local/OpenAI/Codex/bin/0123456789abcdef/codex.exe');
  let spawnCalls=0;
  const client=new CodexClient(process.cwd(),{}, {
    resolveRuntimes:()=>resolveLocalRuntimes(f.options),
    spawn:()=>{spawnCalls++;throw new Error('must not spawn');},
    readConfiguredNames:()=>[]
  });
  t.after(()=>client.close());
  await assert.rejects(client.start(),{code:'CODEX_PATH_AMBIGUOUS'});
  assert.equal(spawnCalls,0);
  assert.equal(client.state.ready,false);
});
