import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {access,readdir,realpath} from 'node:fs/promises';
import {createManagedCodexRuntime} from './lib/managed-codex-runtime.mjs';

const options={model:'fixture',codexHome:os.tmpdir(),getCloudAuthorization:async()=>({token:'fixture',turnId:'turn'}),testOnly:{url:'http://127.0.0.1:1/v1/responses',fetch}};
test('each open owns an independent relay and close is idempotent',async()=>{
  const factory=createManagedCodexRuntime(options);assert.ok(Object.isFrozen(factory));
  const a=await factory.open(),b=await factory.open();
  try{
    assert.ok(Object.isFrozen(a));
    assert.notEqual(a.provider.describe().baseUrl,b.provider.describe().baseUrl);
    const launchHome=lease=>lease.provider.start({
      spawn:(_executable,_args,spawnOptions)=>spawnOptions.env.CODEX_HOME,
      executable:process.execPath,baseArgs:[],cwd:process.cwd(),env:{CODEX_HOME:options.codexHome}
    });
    const aHome=launchHome(a),bHome=launchHome(b);
    assert.notEqual(aHome,bHome);
    assert.equal(path.dirname(aHome),await realpath(options.codexHome));
    const first=a.close();
    assert.equal(a.close(),first);
    assert.deepEqual(await first,{closed:true});
    await assert.rejects(access(aHome),{code:'ENOENT'});
    await access(bHome);
    assert.deepEqual(await b.close(),{closed:true});
  }
  finally{await a.close();await b.close();}
});
test('provider errors and unconfigured remote fail closed',async()=>{
  await assert.rejects(createManagedCodexRuntime({...options,model:''}).open(),/Invalid managed provider/);
  await assert.rejects(createManagedCodexRuntime({...options,testOnly:null}).open(),{code:'MANAGED_GATEWAY_UNCONFIGURED'});
  await assert.rejects(createManagedCodexRuntime({...options,testOnly:{url:'http://example.com/v1/responses',fetch}}).open(),/loopback/);
});

test('pilot connections have separate empty workspaces and remove only their own lease',async()=>{
  const factory=createManagedCodexRuntime({...options,workbenchPilot:true});
  const a=await factory.open(),b=await factory.open();
  try{
    assert.notEqual(a.cwd,b.cwd);
    for(const lease of [a,b]){
      assert.deepEqual(await readdir(lease.cwd),[]);
      const launched=lease.provider.start({
        spawn:(_executable,_args,spawnOptions)=>spawnOptions,
        executable:process.execPath,baseArgs:[],cwd:lease.cwd,env:{}
      });
      assert.equal(launched.cwd,lease.cwd);
      assert.notEqual(launched.env.CODEX_HOME,lease.cwd);
      assert.equal(path.dirname(launched.env.CODEX_HOME),path.dirname(lease.cwd));
    }
    await a.close();
    await assert.rejects(access(a.cwd),{code:'ENOENT'});
    await access(b.cwd);
    await b.close();
    await assert.rejects(access(b.cwd),{code:'ENOENT'});
  }finally{await a.close();await b.close();}
});
