import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);

test('host auto apply admits only project-bound ordinary commits outside model arguments',async t=>{
  if(process.platform!=='win32'){t.skip('Requires existing Windows .NET Framework csc');return;}
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-scoped-auto-native-'));
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('buildx-scoped-auto-native-'));await rm(root,{recursive:true,force:true});});
  const framework=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319'),output=path.join(root,'auto-fixture.exe');
  const compiled=await run(path.join(framework,'csc.exe'),['/nologo','/target:exe','/langversion:5','/define:BUILDX_SCOPED_AUTO_APPLY','/out:'+output,
    path.resolve('revit-addin/ScopedAutoApply.cs'),path.resolve('test-support/scoped-auto-apply-native-fixture.cs')],{windowsHide:true});
  assert.equal(compiled.stderr,'');
  const execution=await run(output,[],{windowsHide:true});
  assert.equal(execution.stdout.trim(),'Scoped auto apply admission passed.');
});
