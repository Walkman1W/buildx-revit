import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);

test('native visual owner preserves source, captures verified files, cancels with cleanup and retains failed restoration',async t=>{
  if(process.platform!=='win32'){t.skip('Controlled .NET Framework native owner peer requires existing Windows csc');return;}
  const directory=await mkdtemp(path.join(os.tmpdir(),'buildx-native-visual-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('buildx-native-visual-'));await rm(directory,{recursive:true,force:true});});
  const framework='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const output=path.join(directory,'visual-fixture.exe');
  const compile=await run(path.join(framework,'csc.exe'),['/nologo','/target:exe','/langversion:5','/out:'+output,
    '/r:'+path.join(framework,'System.dll'),'/r:'+path.join(framework,'System.Core.dll'),'/r:'+path.join(framework,'System.Drawing.dll'),
    '/r:'+path.join(framework,'System.Web.Extensions.dll'),path.resolve('revit-addin/VisualInspection.cs'),path.resolve('test-support/visual-inspection-native-fixture.cs')],{windowsHide:true});
  assert.equal(compile.stderr,'');
  const execution=await run(output,[path.join(directory,'owned-evidence')],{windowsHide:true});
  const result=JSON.parse(execution.stdout.trim());assert.equal(result.passed,true);assert.ok(result.assertions>=20);assert.match(result.scope,/not a live Revit/);
});
