import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';
test('Windows service and inert IPC skeleton compile; in-memory protocol rejects writes',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bx-service-build-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const compiler=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),source=path.resolve('research/scope-handle/ProtectedOwnerService.cs'),fixture=path.resolve('research/scope-handle/ServiceProtocolFixture.cs'),refs=['/nologo','/r:System.ServiceProcess.dll','/r:System.Web.Extensions.dll'];
 execFileSync(compiler,[...refs,'/target:exe','/out:'+path.join(dir,'service.exe'),source]);
 execFileSync(compiler,[...refs,'/main:ServiceProtocolFixture','/out:'+path.join(dir,'fixture.exe'),source,fixture]);const r=spawnSync(path.join(dir,'fixture.exe'),[],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'ok');
});
