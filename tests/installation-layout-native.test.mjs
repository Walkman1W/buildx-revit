import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadNativeInstallationProducer} from '../test-support/installation-layout-native-producer.mjs';

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
    assert.equal(result.panelPort,41873);assert.equal(result.panelAddress,'http://127.0.0.1:41873/');
  });
  await t.test('schema 2 binds owned program, data, queue and browser roots without creating state',async()=>{
    const dataRoot=path.join(produce.directory,'data'),marker=path.join(dataRoot,'buildx-data-owner.json');
    await fs.mkdir(dataRoot);await fs.writeFile(marker,JSON.stringify({schemaVersion:1,installationId:id}));
    const before=await fs.readFile(marker),result=await run({...config,schemaVersion:2,dataRoot});
    assert.equal(result.ok,true);assert.equal(result.root,produce.root);assert.equal(result.dataRoot,dataRoot);assert.equal(result.workbenchRoot,path.join(dataRoot,'workbench'));assert.equal(result.webViewUserDataFolder,path.join(dataRoot,'WebView2'));assert.equal(result.schemaVersion,2);
    assert.deepEqual(await fs.readdir(dataRoot),['buildx-data-owner.json']);assert.deepEqual(await fs.readFile(marker),before);assert.equal(result.nodeExecutable,config.nodeExecutable);assert.equal(result.pythonExecutable,config.pythonExecutable);assert.equal(result.codexExecutable,config.codexExecutable);
    assert.equal(result.panelPort,41873);assert.equal(result.panelAddress,'http://127.0.0.1:41873/');
  });
  await t.test('schema 2 accepts only bounded JSON integer ports and keeps one address owner',async()=>{
    const dataRoot=path.join(produce.directory,'data');
    for(const panelPort of [1024,41873,41874,65535]){
      const result=await run({...config,schemaVersion:2,dataRoot,panelPort});assert.equal(result.ok,true,JSON.stringify({panelPort,result}));assert.equal(result.panelPort,panelPort);assert.equal(result.panelAddress,`http://127.0.0.1:${panelPort}/`);
    }
    for(const numericLiteral of ['41874.0','41874e0']){
      const text=JSON.stringify({...config,schemaVersion:2,dataRoot,panelPort:41874}).replace('"panelPort":41874','"panelPort":'+numericLiteral),result=await produce({configurationText:text});assert.equal(result.ok,true,numericLiteral);assert.equal(result.panelPort,41874);
    }
    for(const panelPort of [null,'41874',true,false,0,-1,80,1023,65536,41874.25,{},[],9007199254740991]){
      const result=await run({...config,schemaVersion:2,dataRoot,panelPort});assert.equal(result.ok,false,JSON.stringify(panelPort));
    }
    for(const panelPort of [null,41873,41874,'41873'])assert.equal((await run({...config,panelPort})).ok,false,'schema1 '+JSON.stringify(panelPort));
    const duplicate=JSON.stringify({...config,schemaVersion:2,dataRoot,panelPort:41874}).replace('"panelPort":41874','"panelPort":41874,"panelPort":41873');assert.equal((await produce({configurationText:duplicate})).ok,false);
    assert.deepEqual(await fs.readdir(dataRoot),['buildx-data-owner.json']);
  });
  await t.test('configured navigation retains the exact loopback scheme, host, port and user-info boundary',async()=>{
    const dataRoot=path.join(produce.directory,'data'),navigation=['http://127.0.0.1:41874/','http://127.0.0.1:41874/path?x=1#section','http://127.0.0.1:41873/','http://127.0.0.1:41875/','https://127.0.0.1:41874/','http://localhost:41874/','http://127.0.0.2:41874/','http://[::1]:41874/','http://127.0.0.1.evil.invalid:41874/','http://user@127.0.0.1:41874/','http://user:password@127.0.0.1:41874/','file:///C:/test','//127.0.0.1:41874/','invalid',null];
    const result=await produce({configurationText:JSON.stringify({...config,schemaVersion:2,dataRoot,panelPort:41874}),navigation});assert.equal(result.ok,true);assert.deepEqual(result.navigation,[true,true,...navigation.slice(2).map(()=>false)]);
    const legacy=await produce({configurationText:JSON.stringify(config),navigation:['http://127.0.0.1:41873/','http://127.0.0.1:41874/']});assert.equal(legacy.ok,true);assert.deepEqual(legacy.navigation,[true,false]);
  });
  await t.test('missing, foreign and malformed data ownership never creates a queue or alters the marker',async()=>{
    const absentRoot=path.join(produce.directory,'absent-data');assert.equal((await run({...config,schemaVersion:2,dataRoot:absentRoot})).ok,false);await assert.rejects(fs.stat(absentRoot),{code:'ENOENT'});
    const dataRoot=path.join(produce.directory,'ownership-cases'),marker=path.join(dataRoot,'buildx-data-owner.json');await fs.mkdir(dataRoot);
    assert.equal((await run({...config,schemaVersion:2,dataRoot})).ok,false);assert.deepEqual(await fs.readdir(dataRoot),[]);
    const invalid=['', 'x'.repeat(4097), '{bad', JSON.stringify({schemaVersion:2,installationId:id}),JSON.stringify({schemaVersion:1,installationId:'ba159a01-0b21-4da8-95ab-8f2488a24ffe'}),JSON.stringify({schemaVersion:1}),JSON.stringify({schemaVersion:1,installationId:id,extra:true}),`{"schemaVersion":1,"schemaVersion":1,"installationId":"${id}"}`];
    for(const text of invalid){await fs.writeFile(marker,text);const before=await fs.readFile(marker);assert.equal((await run({...config,schemaVersion:2,dataRoot})).ok,false,text);assert.deepEqual(await fs.readFile(marker),before);await assert.rejects(fs.stat(path.join(dataRoot,'workbench')),{code:'ENOENT'});}
    await fs.unlink(marker);const target=path.join(produce.directory,'marker-link-target');await fs.mkdir(target);await fs.symlink(target,marker,'junction');
    assert.equal((await run({...config,schemaVersion:2,dataRoot})).ok,false);assert.deepEqual(await fs.readdir(target),[]);await assert.rejects(fs.stat(path.join(dataRoot,'workbench')),{code:'ENOENT'});
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
