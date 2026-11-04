import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);

test('native access owner binds exact policy, scopes directory paths and observes revocation without granting a live model',async t=>{
  if(process.platform!=='win32'){t.skip('Requires existing Windows .NET Framework csc');return;}
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-native-access-')),outside=await mkdtemp(path.join(os.tmpdir(),'buildx-native-access-outside-'));
  t.after(async()=>{for(const dir of [root,outside]){assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('buildx-native-access-'));await rm(dir,{recursive:true,force:true});}});
  await writeFile(path.join(outside,'external.rvt'),'not a Revit file');
  await symlink(outside,path.join(root,'linked-project'),'junction');
  const framework='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319',output=path.join(root,'access-fixture.exe');
  const compiled=await run(path.join(framework,'csc.exe'),['/nologo','/target:exe','/langversion:5','/out:'+output,'/r:'+path.join(framework,'System.dll'),'/r:'+path.join(framework,'System.Core.dll'),'/r:'+path.join(framework,'System.Web.Extensions.dll'),path.resolve('revit-addin/AccessPolicy.cs'),path.resolve('test-support/access-policy-native-fixture.cs')],{windowsHide:true});
  assert.equal(compiled.stderr,'');
  const execution=await run(output,[root],{windowsHide:true});const result=JSON.parse(execution.stdout.trim());assert.equal(result.passed,true);assert.ok(result.assertions>=25);assert.match(result.scope,/not live Revit/);
});
