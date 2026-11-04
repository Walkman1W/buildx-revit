import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveBuildxPaths,normalizeInstallationConfiguration,readBuildxInstallation} from './lib/buildx-paths.mjs';

const base={schemaVersion:1,installationId:'6ab8f6cf-0bad-4149-9184-e19b2031da4d',nodeExecutable:'C:\\fixture-runtime\\node.exe',pythonExecutable:'C:\\fixture-runtime\\python.exe',codexExecutable:'C:\\existing-codex\\codex.exe'};
async function fixture(t){
  const stage=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-path-owner-')),programRoot=path.join(stage,'program'),dataRoot=path.join(stage,'data');
  await fs.mkdir(programRoot);await fs.mkdir(dataRoot);
  t.after(async()=>{const target=path.resolve(stage);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('buildx-path-owner-'));await fs.rm(target,{recursive:true,force:true});});
  return {stage,programRoot,dataRoot,file:path.join(programRoot,'buildx-installation.json')};
}

test('unconfigured source and schema1 retain their exact legacy data roots without moving history',async t=>{
  const f=await fixture(t),history=path.join(f.programRoot,'runtime-history','retained.txt');
  await fs.mkdir(path.dirname(history));await fs.writeFile(history,'original history remains here');
  const source=resolveBuildxPaths(f.programRoot);assert.equal(source.mode,'source');assert.equal(source.dataRoot,f.programRoot);assert.equal(source.workbenchRoot,path.join(f.programRoot,'workbench'));
  await fs.writeFile(f.file,JSON.stringify(base));const legacy=resolveBuildxPaths(f.programRoot);
  assert.equal(legacy.mode,'legacy-installed');assert.equal(legacy.historyDirectory,path.dirname(history));assert.equal(legacy.dataRoot,f.programRoot);assert.ok(Object.isFrozen(legacy));
  assert.equal(await fs.readFile(history,'utf8'),'original history remains here');assert.deepEqual(await fs.readdir(f.dataRoot),[]);
});

test('schema2 places mutable data outside program resources and private runtimes',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),config={...base,schemaVersion:2,dataRoot:f.dataRoot};await fs.writeFile(f.file,JSON.stringify(config));
  await fs.writeFile(path.join(f.dataRoot,'buildx-data-owner.json'),JSON.stringify({schemaVersion:1,installationId:base.installationId}));
  const paths=resolveBuildxPaths(f.programRoot),normalized=normalizeInstallationConfiguration(config,{programRoot:f.programRoot});
  assert.equal(paths.mode,'installed');assert.equal(paths.programRoot,f.programRoot);assert.equal(paths.dataRoot,f.dataRoot);
  for(const [key,relative] of Object.entries({workbenchRoot:'workbench',runtimeDirectory:'runtime',historyDirectory:'runtime-history',projectHistoryDirectory:'project-history',webViewDirectory:'WebView2'}))assert.equal(paths[key],path.join(f.dataRoot,relative));
  assert.equal(paths.privateRuntimeDirectory,path.join(f.programRoot,'private-runtime'));assert.ok(Object.isFrozen(normalized));assert.deepEqual(readBuildxInstallation(f.programRoot),normalized);
  assert.deepEqual(await fs.readdir(f.dataRoot),['buildx-data-owner.json'],'resolving layout must not create state');
});

test('a schema2 missing data directory fails startup without creating or falling back',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),selected=path.join(f.stage,'not-created','owned-data');await fs.writeFile(f.file,JSON.stringify({...base,schemaVersion:2,dataRoot:selected}));
  const planned=normalizeInstallationConfiguration({...base,schemaVersion:2,dataRoot:selected},{programRoot:f.programRoot});assert.equal(planned.dataRoot,selected);
  assert.throws(()=>resolveBuildxPaths(f.programRoot),/configuration is invalid/);
  await assert.rejects(fs.stat(selected),error=>error.code==='ENOENT');assert.deepEqual(await fs.readdir(f.programRoot),['buildx-installation.json']);
});

test('invalid configuration is never interpreted as an absent source configuration',async t=>{
  const f=await fixture(t);
  const invalid=['{broken','null',JSON.stringify({...base,schemaVersion:3}),JSON.stringify({...base,schemaVersion:2}),JSON.stringify({...base,unexpected:'ignored?'}),JSON.stringify({...base,nodeExecutable:'node.exe'}),JSON.stringify({...base,installationId:base.installationId.toUpperCase()}),Buffer.from([0xff,0xfe,0xfa]),'x'.repeat(4097)];
  for(const value of invalid){await fs.writeFile(f.file,value);assert.throws(()=>readBuildxInstallation(f.programRoot),/configuration is invalid/);assert.throws(()=>resolveBuildxPaths(f.programRoot),/configuration is invalid/);}
  assert.throws(()=>normalizeInstallationConfiguration({...base,dataRoot:f.dataRoot},{programRoot:f.programRoot}),/configuration is invalid/,'schema1 cannot silently accept a new data-root field');
});

test('duplicate configuration keys, including escaped names, are rejected like the C# reader',async t=>{
  const f=await fixture(t),canonical=JSON.stringify(base);
  for(const duplicate of ['"schemaVersion":1,','"schema\\u0056ersion":1,']){
    await fs.writeFile(f.file,'{'+duplicate+canonical.slice(1));
    assert.throws(()=>readBuildxInstallation(f.programRoot),/configuration is invalid/);
  }
});

test('schema2 verifies data ownership before any queue or history can be selected',async t=>{
  const f=await fixture(t),ownerFile=path.join(f.dataRoot,'buildx-data-owner.json');
  await fs.writeFile(f.file,JSON.stringify({...base,schemaVersion:2,dataRoot:f.dataRoot}));
  assert.throws(()=>readBuildxInstallation(f.programRoot),/configuration is invalid/,'missing owner');
  const correct={schemaVersion:1,installationId:base.installationId};
  for(const value of [null,{...correct,schemaVersion:2},{...correct,installationId:'another-installation'},{...correct,extra:true}]){
    await fs.writeFile(ownerFile,JSON.stringify(value));assert.throws(()=>resolveBuildxPaths(f.programRoot),/configuration is invalid/);
  }
  for(const bytes of ['{bad','{"schemaVersion":1,"schemaVersion":1,"installationId":"'+base.installationId+'"}',Buffer.from([0xff]),'x'.repeat(4097)]){
    await fs.writeFile(ownerFile,bytes);assert.throws(()=>readBuildxInstallation(f.programRoot),/configuration is invalid/);
  }
  await fs.writeFile(ownerFile,JSON.stringify(correct));assert.equal(readBuildxInstallation(f.programRoot).dataRoot,f.dataRoot);
  for(const selected of [f.programRoot,f.dataRoot])for(const child of ['workbench','runtime-history'])await assert.rejects(fs.stat(path.join(selected,child)),error=>error.code==='ENOENT');
  await fs.unlink(ownerFile);await fs.mkdir(ownerFile);assert.throws(()=>readBuildxInstallation(f.programRoot),/configuration is invalid/);
});

test('configuration disappearing after observation never becomes an unconfigured source checkout',async t=>{
  const f=await fixture(t);await fs.writeFile(f.file,JSON.stringify(base));
  const original=fsSync.openSync;
  fsSync.openSync=(file,...args)=>{if(file===f.file){const error=new Error('simulated disappearance');error.code='ENOENT';throw error;}return original(file,...args);};
  try{assert.throws(()=>readBuildxInstallation(f.programRoot),/configuration is invalid/);}
  finally{fsSync.openSync=original;}
});

test('schema2 rejects missing, overlapping, relative, root-volume and noncanonical data locations',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);
  for(const dataRoot of [undefined,null,'','relative-data',path.parse(f.stage).root,f.programRoot,f.programRoot.toUpperCase(),path.join(f.programRoot,'state'),f.stage,path.join(f.dataRoot,'..','data')+'\\',f.dataRoot+'\\',f.dataRoot+'\\..\\data',f.dataRoot+'.',f.dataRoot+' ',path.join(f.dataRoot,'folder.'),path.join(f.dataRoot,'folder ')])assert.throws(()=>normalizeInstallationConfiguration({...base,schemaVersion:2,dataRoot},{programRoot:f.programRoot}),/configuration is invalid/,String(dataRoot));
});

test('configuration files and data ancestors reject symbolic links or junctions',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),configTarget=path.join(f.stage,'config-source.json');await fs.writeFile(configTarget,JSON.stringify(base));
  const alias=path.join(f.stage,'data-alias');await fs.symlink(f.dataRoot,alias,'junction');
  for(const dataRoot of [alias,path.join(alias,'nested-state')])assert.throws(()=>normalizeInstallationConfiguration({...base,schemaVersion:2,dataRoot},{programRoot:f.programRoot}),/configuration is invalid/);
  try{await fs.symlink(configTarget,f.file,'file');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.diagnostic('File symlink creation unavailable; data junction rejection verified.');return;}throw error;}
  assert.throws(()=>readBuildxInstallation(f.programRoot),/configuration is invalid/);
});
