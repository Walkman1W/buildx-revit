import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadNativeInstallationProducer} from './test-support/installation-layout-native-producer.mjs';

test('actual C# installation owner separates configured data and rejects ambiguous layouts',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeInstallationProducer(t),id='aa159a01-0b21-4da8-95ab-8f2488a24ffe';
  t.diagnostic(JSON.stringify(produce.sourceEvidence));
  const config={schemaVersion:1,installationId:id,nodeExecutable:'C:\\selected\\node.exe',pythonExecutable:'C:\\selected\\python.exe',codexExecutable:'C:\\selected\\codex.exe'};
  const run=value=>produce({configurationText:JSON.stringify(value)});
  await t.test('missing configuration has no development-directory exception',async()=>{
    assert.deepEqual(await produce({}),{ok:false,error:'BuildXInstallationException'});
  });
  await t.test('schema 1 retains original data and exact service identity',async()=>{
    const result=await run(config);assert.equal(result.ok,true);assert.equal(result.root,produce.root);assert.equal(result.dataRoot,produce.root);assert.equal(result.workbenchRoot,path.join(produce.root,'workbench'));
    assert.equal(result.schemaVersion,1);assert.equal(result.developmentMode,false);assert.equal(result.matchesSelf,true);assert.equal(result.matchesMissing,false);assert.equal(result.matchesOther,false);
    assert.equal(result.webViewUserDataFolder,path.join(process.env.LOCALAPPDATA,'RevitLocalCodex','WebView2'));
  });
  await t.test('schema 2 binds program, data, queue and browser roots without creating state',async()=>{
    const dataRoot=path.join(produce.directory,'data'),result=await run({...config,schemaVersion:2,dataRoot});
    assert.equal(result.ok,true);assert.equal(result.root,produce.root);assert.equal(result.dataRoot,dataRoot);assert.equal(result.workbenchRoot,path.join(dataRoot,'workbench'));assert.equal(result.webViewUserDataFolder,path.join(dataRoot,'WebView2'));assert.equal(result.schemaVersion,2);
    await assert.rejects(fs.stat(dataRoot),{code:'ENOENT'});assert.equal(result.nodeExecutable,config.nodeExecutable);assert.equal(result.pythonExecutable,config.pythonExecutable);assert.equal(result.codexExecutable,config.codexExecutable);
  });
  await t.test('overlap, aliases, root paths and malformed identities remain rejected',async()=>{
    const dataRoot=path.join(produce.directory,'data');
    const invalid=[undefined,produce.root,path.join(produce.root,'data'),produce.directory,path.dirname(produce.directory),produce.root.toUpperCase(),'C:\\','C:relative','relative','\\\\server\\share\\data',dataRoot+'\\',dataRoot+'\\..\\data',dataRoot+'\\.\\inside',dataRoot+'\\bad.','C:\\data|bad','C:\\data:stream'];
    for(const value of invalid)assert.equal((await run({...config,schemaVersion:2,dataRoot:value})).ok,false,String(value));
    for(const value of [{...config,schemaVersion:3},{...config,dataRoot},{...config,installationId:id.toUpperCase()},{...config,nodeExecutable:'node.exe'}])assert.equal((await run(value)).ok,false);
    const duplicate=JSON.stringify({...config,schemaVersion:2,dataRoot}).replace('"schemaVersion":2','"schemaVersion":2,"schemaVersion":1');
    assert.equal((await produce({configurationText:duplicate})).ok,false);
  });
  await t.test('a configured data path cannot redirect through a junction or a regular file',async()=>{
    const target=path.join(produce.directory,'target'),junction=path.join(produce.directory,'junction'),ordinary=path.join(produce.directory,'ordinary');
    await fs.mkdir(target);await fs.symlink(target,junction,'junction');await fs.writeFile(ordinary,'fixture');
    assert.equal((await run({...config,schemaVersion:2,dataRoot:path.join(junction,'child')})).ok,false);
    assert.equal((await run({...config,schemaVersion:2,dataRoot:ordinary})).ok,false);
  });
});
