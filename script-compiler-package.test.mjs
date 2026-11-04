import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inspectScriptCompilerPackage,SCRIPT_COMPILER_PACKAGE_CONTRACT as contract} from './lib/script-compiler-package.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const actual=process.env.BUILDX_SCRIPT_COMPILER_DIR;
const script=fileURLToPath(new URL('./tools/provision-script-compiler.ps1',import.meta.url));
const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
function expectedStamp(){const license=contract.files.find(file=>file.sourceKind==='official-repository-license');return {schemaVersion:1,package:structuredClone(contract.package),selection:structuredClone(contract.selection),license:{path:license.path,sourceUrl:license.sourceUrl,sha256:license.sha256,bytes:license.bytes,sourceKind:license.sourceKind},files:contract.files.map(({path,sha256,bytes})=>({path,sha256,bytes}))};}
async function fixture(t,{copy=null,fake=false}={}){
  const stage=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-script-compiler-test-')),directory=path.join(stage,'compiler');
  t.after(async()=>{const target=path.resolve(stage);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('buildx-script-compiler-test-'));await fs.rm(target,{recursive:true,force:true});});
  if(copy)await fs.cp(copy,directory,{recursive:true});else await fs.mkdir(directory);
  if(fake){for(const file of contract.files)await fs.writeFile(path.join(directory,file.path),Buffer.alloc(file.bytes));await fs.writeFile(path.join(directory,contract.stampFile),JSON.stringify(expectedStamp()));}
  return {stage,directory};
}
function provision(nupkg,output,cwd){return spawnSync(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Nupkg',nupkg,'-OutputDirectory',output],{cwd,encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:1024*1024});}
async function invalid(directory,reason){const result=await inspectScriptCompilerPackage(directory);assert.equal(result.ok,false);assert.equal(result.error.code,'SCRIPT_COMPILER_PACKAGE_INVALID');if(reason)assert.equal(result.error.reason,reason);return result;}

test('fixed source contract pins the official package and a bounded C# x64 payload plus original notices',()=>{
  assert.equal(contract.package.version,'5.0.0');assert.equal(contract.package.sha256,'e3f0207e7a8caf2cf79ad8f276eb20b2b880b3a7bb0e8ad27b4d3183d0a81627');assert.equal(contract.package.licenseExpression,'MIT');assert.equal(contract.selection.internalCandidateOnly,true);assert.equal(contract.selection.longTermMsbuildReplacementSupported,false);
  assert.ok(Object.isFrozen(contract.files));assert.equal(contract.files.length,16);assert.equal(contract.files.filter(file=>file.packagePath?.startsWith('tasks/net472/')).length,13);
  assert.ok(contract.files.some(file=>file.path==='ThirdPartyNotices.rtf'&&file.sourceKind==='nuget-entry'&&file.bytes===2183));assert.ok(contract.files.some(file=>file.path==='Microsoft.Net.Compilers.Toolset.nuspec'));
  assert.equal(contract.files.some(file=>/VBCSCompiler|VisualBasic|Scripting|arm64|\.x86|csc\.rsp|vbc\.exe|csi\.exe/.test(file.path)),false);
  const license=contract.files.find(file=>file.path==='License.txt');assert.equal(sha(Buffer.from(contract.licenseText)),license.sha256);assert.equal(license.sourceKind,'official-repository-license');assert.match(license.sourceUrl,/\/6c4a46a31302167b425d5e0a31ea83c9a9aa1d09\/License\.txt$/);
});

test('missing directories, relative locations and empty packages never become accepted packages',async t=>{
  const f=await fixture(t);await invalid('relative');await invalid(path.join(f.stage,'missing'));await invalid(f.directory,'missing_file');
});

test('a genuine-looking stamp cannot authorize invented compiler bytes or an altered payload list',async t=>{
  const f=await fixture(t,{fake:true});await invalid(f.directory,'payload_hash');
  for(const mutate of [stamp=>{stamp.package.version='another';},stamp=>{stamp.files[0].path='../escape.exe';},stamp=>{stamp.files[0].sha256=sha(Buffer.alloc(contract.files[0].bytes));},stamp=>{stamp.files.push({path:'injected.dll',sha256:'0'.repeat(64),bytes:1});},stamp=>{stamp.releaseReady=true;}]){
    const stamp=expectedStamp();mutate(stamp);await fs.writeFile(path.join(f.directory,contract.stampFile),JSON.stringify(stamp));await invalid(f.directory,'stamp_mismatch');
  }
  await assert.rejects(fs.stat(path.join(f.stage,'escape.exe')),error=>error.code==='ENOENT');
});

test('extra files, directories, linked package roots and linked payloads fail before authorization',async t=>{
  const f=await fixture(t,{fake:true}),extra=path.join(f.directory,'unlisted.dll');await fs.writeFile(extra,'unlisted');await invalid(f.directory,'unexpected_entry');await fs.unlink(extra);
  const child=path.join(f.directory,'unlisted-folder');await fs.mkdir(child);await invalid(f.directory,'unexpected_entry');await fs.rmdir(child);
  const alias=path.join(f.stage,'compiler-alias');await fs.symlink(f.directory,alias,process.platform==='win32'?'junction':'dir');await invalid(alias,'directory_identity');
  const target=path.join(f.stage,'linked-csc.exe'),csc=path.join(f.directory,'csc.exe');await fs.copyFile(csc,target);await fs.unlink(csc);await fs.link(target,csc);await invalid(f.directory,'file_identity_or_size');await fs.unlink(csc);
  try{await fs.symlink(target,csc,'file');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.diagnostic('File symlink unavailable; hardlink and directory-junction refusal verified.');return;}throw error;}
  await invalid(f.directory,'unexpected_entry');
});

test('provision refuses existing outputs, untrusted packages and noncanonical or linked output paths',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),archive=path.join(f.stage,'fake.nupkg'),output=path.join(f.stage,'new-output');await fs.writeFile(archive,'not the pinned official package');await fs.writeFile(path.join(f.directory,'keep.txt'),'original');
  const exists=provision(archive,f.directory,f.stage);assert.notEqual(exists.status,0);assert.match(exists.stderr,/already exists/);assert.deepEqual(await fs.readdir(f.directory),['keep.txt']);
  const fake=provision(archive,output,f.stage);assert.notEqual(fake.status,0);assert.match(fake.stderr,/SHA-256/);await assert.rejects(fs.stat(output),error=>error.code==='ENOENT');
  const traversal=f.stage+path.sep+'unused'+path.sep+'..'+path.sep+'new-output',unsafe=provision(archive,traversal,f.stage);assert.notEqual(unsafe.status,0);assert.match(unsafe.stderr,/canonical absolute/);await assert.rejects(fs.stat(output),error=>error.code==='ENOENT');
  const alias=path.join(f.stage,'alias');await fs.symlink(f.directory,alias,'junction');const linked=provision(archive,path.join(alias,'new-output'),f.stage);assert.notEqual(linked.status,0);assert.match(linked.stderr,/reparse point/);assert.deepEqual(await fs.readdir(f.directory),['keep.txt']);
});

test('the opt-in official provision verifies exact bytes and detects corruption without trusting stamp claims',{skip:!actual},async t=>{
  assert.ok(path.isAbsolute(actual));const original=await inspectScriptCompilerPackage(actual);assert.equal(original.ok,true,JSON.stringify(original));assert.equal(original.value.files.length,17);assert.equal(original.value.scope,'internal-candidate');
  const stampFile=original.value.files.find(file=>file.path===contract.stampFile);assert.equal(stampFile.sha256,sha(await fs.readFile(path.join(actual,contract.stampFile))));assert.equal(JSON.stringify(original.value.stamp).includes(actual),false);
  for(const [name,mutate,reason] of [
    ['same-length compiler tamper',async directory=>{const file=path.join(directory,'csc.exe'),bytes=await fs.readFile(file);bytes[0]^=1;await fs.writeFile(file,bytes);},'payload_hash'],
    ['missing required dependency',directory=>fs.unlink(path.join(directory,'System.Memory.dll')),'missing_file'],
    ['missing original RTF notice',directory=>fs.unlink(path.join(directory,'ThirdPartyNotices.rtf')),'missing_file'],
    ['oversized payload',directory=>fs.appendFile(path.join(directory,'csc.exe'),Buffer.from([0])),'file_identity_or_size'],
    ['unknown payload',directory=>fs.writeFile(path.join(directory,'VBCSCompiler.exe'),'not selected'),'unexpected_entry'],
    ['self-authorized changed hash',async directory=>{const file=path.join(directory,'compiler-package.json'),stamp=JSON.parse(await fs.readFile(file,'utf8'));stamp.files[0].sha256='0'.repeat(64);await fs.writeFile(file,JSON.stringify(stamp));},'stamp_mismatch']
  ])await t.test(name,async child=>{const f=await fixture(child,{copy:actual});await mutate(f.directory);await invalid(f.directory,reason);});
});
