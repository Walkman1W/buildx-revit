import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {compileScriptRunnerOffline,loadScriptCompilerPreparationProducer} from './test-support/script-compiler-offline.mjs';

test('production ScriptRunner preflight rejects absent compilers and invalid UTF-8 body budgets before creating script state',{skip:process.platform!=='win32'},async t=>{
  const prepare=await loadScriptCompilerPreparationProducer(t),outputRoot=path.join(prepare.directory,'workbench');
  const selected={compilerExecutable:path.join(prepare.directory,'missing','csc.exe'),revitApi:path.join(prepare.directory,'RevitAPI.dll'),revitApiUi:path.join(prepare.directory,'RevitAPIUI.dll'),outputRoot,parameters:false,requestId:randomUUID()};
  const missing=await prepare({...selected,code:'return "中文测试";'});assert.equal(missing.ok,false);assert.match(missing.message,/private BuildX script compiler has not been provisioned/);
  for(const code of ['', '字'.repeat(22000)]){const invalid=await prepare({...selected,code});assert.equal(invalid.ok,false);assert.match(invalid.message,/1 to 64000 UTF-8 bytes/);}
  await assert.rejects(fs.stat(outputRoot),{code:'ENOENT'});
  t.diagnostic(JSON.stringify(prepare.sourceEvidence));
});

test('actual production preparation keeps structured parameters, Unicode and explicit references without loading an assembly',{skip:process.platform!=='win32'},async t=>{
  const prepare=await loadScriptCompilerPreparationProducer(t),compilerExecutable=path.join(prepare.directory,'csc.exe');await fs.writeFile(compilerExecutable,'not executed by this preparation-only test');
  const selected={compilerExecutable,revitApi:path.join(prepare.directory,'RevitAPI.dll'),revitApiUi:path.join(prepare.directory,'RevitAPIUI.dll'),outputRoot:path.join(prepare.directory,'owned-workbench'),code:'return new { 文本 = "中文 ✓", 值 = parameters["名称"] };',parameters:true,requestId:randomUUID()};
  const result=await prepare(selected);assert.equal(result.ok,true,result.message);
  const source=await fs.readFile(result.result.source,'utf8'),rsp=await fs.readFile(result.result.responseFile,'utf8');
  assert.ok(source.includes('IDictionary<string, object> parameters'));assert.ok(source.includes(selected.code));assert.ok(source.includes('#line 1 "user-script.cs"'));
  assert.ok(rsp.includes('/langversion:14'));assert.ok(rsp.includes('/reference:"'+selected.revitApi+'"'));assert.ok(rsp.includes('/reference:"'+selected.revitApiUi+'"'));
  await assert.rejects(fs.stat(result.result.dll),{code:'ENOENT'});assert.equal(prepare.fragments.timeoutMs,30000);
});

const selected=process.env.BUILDX_SCRIPT_COMPILER&&process.env.BUILDX_REVIT_API_DIR;
test('explicit private compiler compiles four fixed templates, door facing, parameters and Chinese C#14 against Revit 2024 without execution',
  {skip:process.platform!=='win32'?'Requires Windows':!selected?'Set both BUILDX_SCRIPT_COMPILER and BUILDX_REVIT_API_DIR explicitly; no compiler/API acceptance was run.':false},async t=>{
    const outputDirectory=process.env.BUILDX_SCRIPT_COMPILER_OUTPUT||path.join(await fs.mkdtemp(path.join(os.tmpdir(),'buildx-offline-script-')),'evidence');
    const summary=await compileScriptRunnerOffline({compilerExecutable:process.env.BUILDX_SCRIPT_COMPILER,revitDirectory:process.env.BUILDX_REVIT_API_DIR,outputDirectory});
    t.diagnostic('Offline compiler evidence: '+path.join(outputDirectory,'summary.json'));
    assert.equal(summary.passed,true,JSON.stringify(summary.entries.map(entry=>({name:entry.name,variant:entry.variant,exitCode:entry.exitCode,failure:entry.failure}))));
    assert.equal(summary.entries.length,7);assert.equal(summary.inputsUnchanged,true);assert.equal(summary.generatedAssembliesLoaded,false);assert.equal(summary.uiApplicationInstantiated,false);assert.equal(summary.executedInRevit,false);assert.equal(summary.modelModified,false);
  });
