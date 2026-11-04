import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {readInstallationConfiguration,resolveInstallationRuntimes} from './lib/installation-identity.mjs';
import {createPanelServerCore} from './lib/panel-server-core.mjs';
import {panelProfile} from './lib/panel-profile.mjs';

const id='be2781cb-1abf-448b-98fd-19be8045a72a';
const valid={schemaVersion:1,installationId:id,nodeExecutable:'C:\\tools\\node.exe',pythonExecutable:'C:\\tools\\python.exe',codexExecutable:'C:\\tools\\codex.exe'};
test('installation identity is explicit and malformed configuration never becomes legacy',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-identity-'));
  const file=path.join(root,'buildx-installation.json');
  try{
    assert.equal(await readInstallationConfiguration(root),null);
    await fs.writeFile(file,JSON.stringify(valid));
    assert.equal((await readInstallationConfiguration(root)).installationId,id);
    for(const bad of ['{bad',JSON.stringify({...valid,schemaVersion:2}),JSON.stringify({...valid,installationId:'INVALID'}),JSON.stringify({...valid,installationId:id.toUpperCase()}),JSON.stringify({...valid,nodeExecutable:'node.exe'}),JSON.stringify({...valid,pythonExecutable:null})]){
      await fs.writeFile(file,bad);
      await assert.rejects(readInstallationConfiguration(root),/configuration is invalid/);
    }
  }finally{await fs.unlink(file).catch(()=>{});await fs.rmdir(root);}
});

test('installed runtime selection uses the confirmed paths rather than inherited overrides',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-selected-runtime-'));
  const codex=path.join(root,'codex.exe'),python=path.join(root,'python.exe');
  try{
    await fs.writeFile(codex,'fixture');await fs.writeFile(python,'fixture');
    const result=resolveInstallationRuntimes({codexExecutable:codex,pythonExecutable:python},{BUILDX_CODEX_EXE:'wrong',BUILDX_PYTHON_EXE:'wrong'});
    assert.deepEqual(result,{codex,python});
  }finally{await fs.unlink(codex).catch(()=>{});await fs.unlink(python).catch(()=>{});await fs.rmdir(root);}
});

test('model status exposes only the configured installation identity',async()=>{
  class Codex extends EventEmitter{constructor(){super();this.state={service:'revit-local-codex',ready:true,mode:'document-workbench'};}async close(){return {closed:true};}}
  for(const expected of [id,null]){
    const app=createPanelServerCore({root:process.cwd(),codex:new Codex(),selection:panelProfile('model'),port:0,installationId:expected,invokeWorkbench:async()=>{throw new Error('no model access');}});
    try{
      const address=await app.listen();
      const response=await fetch(address.origin+'/api/status');
      const status=await response.json();
      assert.equal(status.service,'revit-local-codex');
      assert.equal(status.installationId,expected??undefined);
    }finally{await app.close();}
  }
});
