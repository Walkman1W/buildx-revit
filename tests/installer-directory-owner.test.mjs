import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {applyInstall} from '../tools/buildx-installer.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
  const stage=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-install-dir-owner-')),packageRoot=path.join(stage,'package'),addinDirectory=path.join(stage,'Addins'),runtime=path.join(stage,'runtimes'),sentinel=path.join(stage,'sentinel');
  for(const directory of [packageRoot,addinDirectory,runtime,sentinel])await fs.mkdir(directory);
  await fs.writeFile(path.join(sentinel,'keep.txt'),'another directory owner');
  const files=[];
  for(const relative of ['server.mjs','workbench-mcp.mjs','package.json','revit-addin/bin/LocalCodexRevit.dll','revit-addin/bin/Microsoft.Web.WebView2.Core.dll','revit-addin/bin/Microsoft.Web.WebView2.Wpf.dll','revit-addin/bin/runtimes/win-x64/native/WebView2Loader.dll']){
    const file=path.join(packageRoot,...relative.split('/')),bytes=Buffer.from('Controlled package '+relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);files.push({path:relative,sha256:sha(bytes)});
  }
  await fs.writeFile(path.join(packageRoot,'buildx-package.json'),JSON.stringify({schemaVersion:1,stage:'test_fixture',releaseReady:false,files,missing:[]}));
  for(const filename of ['node.exe','python.exe','codex.exe'])await fs.writeFile(path.join(runtime,filename),'Not an executable; runtime probes are controlled.');
  const options={packageRoot,installRoot:path.join(stage,'installed'),dataRoot:path.join(stage,'data'),addinDirectory,nodeExecutable:path.join(runtime,'node.exe'),pythonExecutable:path.join(runtime,'python.exe'),codexExecutable:path.join(runtime,'codex.exe'),allowTestFixture:true,checkRevit:async()=>false,probeRuntimes:async()=>({node:'v22.17.0',python:'3.11.0',codex:'1.0.0'})};
  const moves=[];
  async function replaceWithJunction(directory){
    const source=path.resolve(directory),backup=path.join(stage,path.basename(source)+'-original'),relative=path.relative(path.resolve(stage),source),backupRelative=path.relative(path.resolve(stage),path.resolve(backup));
    assert.ok(relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative));assert.ok(backupRelative&&backupRelative!=='..'&&!backupRelative.startsWith('..'+path.sep)&&!path.isAbsolute(backupRelative));
    await fs.rename(source,backup);moves.push({source,backup});await fs.symlink(sentinel,source,process.platform==='win32'?'junction':'dir');return backup;
  }
  t.after(async()=>{const target=path.resolve(stage);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('buildx-install-dir-owner-'));await fs.rm(target,{recursive:true,force:true});});
  async function assertPreserved(){
    assert.deepEqual(await fs.readdir(sentinel),['keep.txt']);assert.equal(await fs.readFile(path.join(sentinel,'keep.txt'),'utf8'),'another directory owner');
    await assert.rejects(fs.stat(path.join(addinDirectory,'BuildX.addin')),error=>error.code==='ENOENT');
    for(const move of moves){assert.ok((await fs.lstat(move.source)).isSymbolicLink());assert.ok((await fs.lstat(move.backup)).isDirectory());}
  }
  return {stage,sentinel,options,replaceWithJunction,assertPreserved,moves};
}

test('install-root replacement during source reading aborts before writing into a junction target',async t=>{
  const f=await fixture(t),original=fs.readFile;let swapped=false;
  fs.readFile=async function(filename,...args){
    const data=await original.call(this,filename,...args);
    if(!swapped&&path.resolve(filename)===path.join(f.options.packageRoot,'server.mjs')){
      let created=false;try{created=(await fs.lstat(f.options.installRoot)).isDirectory();}catch(error){if(error.code!=='ENOENT')throw error;}
      if(created){swapped=true;await f.replaceWithJunction(f.options.installRoot);}
    }
    return data;
  };
  try{await assert.rejects(applyInstall(f.options),error=>error.code==='INSTALL_DIRECTORY_CHANGED'&&error.manifestPublished===false&&error.retainedInstallRoot===f.options.installRoot);}finally{fs.readFile=original;}
  assert.equal(swapped,true);await f.assertPreserved();assert.deepEqual(await fs.readdir(f.moves[0].backup),[]);
});

test('install-root replacement immediately after mkdir is refused before package writes',async t=>{
  const f=await fixture(t),original=fs.mkdir;let swapped=false;
  fs.mkdir=async function(directory,...args){const result=await original.call(this,directory,...args);if(!swapped&&path.resolve(directory)===f.options.installRoot){swapped=true;await f.replaceWithJunction(f.options.installRoot);}return result;};
  try{await assert.rejects(applyInstall(f.options),error=>error.code==='INSTALL_DIRECTORY_CHANGED'&&error.manifestPublished===false);}finally{fs.mkdir=original;}
  assert.equal(swapped,true);await f.assertPreserved();assert.deepEqual(await fs.readdir(f.moves[0].backup),[]);
});

test('data-root replacement immediately after mkdir writes neither owner record nor plugin registration',async t=>{
  const f=await fixture(t),original=fs.mkdir;let swapped=false;
  fs.mkdir=async function(directory,...args){const result=await original.call(this,directory,...args);if(!swapped&&path.resolve(directory)===f.options.dataRoot){swapped=true;await f.replaceWithJunction(f.options.dataRoot);}return result;};
  try{await assert.rejects(applyInstall(f.options),error=>error.code==='INSTALL_DIRECTORY_CHANGED'&&error.manifestPublished===false&&error.retainedDataRoot===f.options.dataRoot);}finally{fs.mkdir=original;}
  assert.equal(swapped,true);await f.assertPreserved();assert.deepEqual(await fs.readdir(f.moves[0].backup),[]);
  assert.equal(await fs.readFile(path.join(f.options.installRoot,'server.mjs'),'utf8'),'Controlled package server.mjs');await assert.rejects(fs.stat(path.join(f.options.installRoot,'buildx-installation.json')),error=>error.code==='ENOENT');
});
