import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveLocalRuntimes} from '../lib/local-runtimes.mjs';
async function fixture(){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-runtimes-'));
  const python=path.join(home,'selected-python','python.exe');
  await fs.mkdir(path.dirname(python),{recursive:true});await fs.writeFile(python,'test file, never executed');
  return {home,python,env:{Path:'',LOCALAPPDATA:path.join(home,'AppData','Local'),BUILDX_PYTHON_EXE:python}};
}
async function executable(file){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'test file, never executed');return file;}
test('runtime discovery follows the currently installed PATH executable and ignores retired paths',async()=>{
  const f=await fixture(),current=await executable(path.join(f.home,'current','codex.exe'));
  f.env.Path=[path.join(f.home,'missing'),path.dirname(current)].join(path.delimiter);
  assert.deepEqual(resolveLocalRuntimes(f),{codex:current,python:f.python});
});
test('one actual bundle can replace an expired PATH while obsolete empty directories are ignored',async()=>{
  const f=await fixture(),bundle=path.join(f.env.LOCALAPPDATA,'OpenAI','Codex','bin');
  await fs.mkdir(path.join(bundle,'0123456789abcdef'),{recursive:true});
  const current=await executable(path.join(bundle,'abcdef0123456789','codex.exe'));
  assert.equal(resolveLocalRuntimes(f).codex,current);
});
test('ambiguous installed bundles fail rather than selecting by hash or timestamp',async()=>{
  const f=await fixture(),bundle=path.join(f.env.LOCALAPPDATA,'OpenAI','Codex','bin');
  for(const name of ['0123456789abcdef','abcdef0123456789'])await executable(path.join(bundle,name,'codex.exe'));
  assert.throws(()=>resolveLocalRuntimes(f),/多个 Codex/);
});
test('explicit executable overrides are validated without changing or installing software',async()=>{
  const f=await fixture(),codex=await executable(path.join(f.home,'explicit','codex.exe')),python=await executable(path.join(f.home,'explicit','python.exe'));
  f.env.BUILDX_CODEX_EXE=codex;f.env.BUILDX_PYTHON_EXE=python;
  assert.deepEqual(resolveLocalRuntimes(f),{codex,python});
  for(const invalid of ['', 'codex.exe',path.join(f.home,'absent','codex.exe'),python]){
    assert.throws(()=>resolveLocalRuntimes({...f,env:{...f.env,BUILDX_CODEX_EXE:invalid}}),/BUILDX_CODEX_EXE/);
  }
});
test('missing Python and missing Codex retain distinct actionable errors',async()=>{
  const f=await fixture();assert.throws(()=>resolveLocalRuntimes(f),/没有找到已安装的 codex/);
  const codex=await executable(path.join(f.home,'current','codex.exe'));f.env.Path=path.dirname(codex);
  await fs.unlink(f.python);delete f.env.BUILDX_PYTHON_EXE;assert.throws(()=>resolveLocalRuntimes(f),/Python/);
});
test('a Codex private cache is never selected implicitly as the BuildX Python runtime',async t=>{
  const f=await fixture(),codex=await executable(path.join(f.home,'current','codex.exe'));
  const privatePython=await executable(path.join(f.home,'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe'));
  const env={Path:path.dirname(codex),LOCALAPPDATA:f.env.LOCALAPPDATA};
  assert.throws(()=>resolveLocalRuntimes({home:f.home,env}),{code:'PYTHON_NOT_FOUND'});
  assert.equal(resolveLocalRuntimes({home:f.home,env:{...env,BUILDX_PYTHON_EXE:privatePython}}).python,privatePython);
  t.after(async()=>{const target=path.resolve(f.home);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('buildx-runtimes-'));await fs.rm(target,{recursive:true,force:true});});
});
