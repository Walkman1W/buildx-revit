import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const setup=path.join(root,'tools','buildx-setup.ps1');

for(const [name,arg] of [
  ['path validation and argument handling','-SelfTest'],
  ['WPF control construction, detection mapping, and stale plan handling','-UiSelfTest'],
  ['WPF first-show detection and real read-only detection process','-DetectUiSelfTest'],
]){
  test(name,{skip:process.platform!=='win32',timeout:30000},()=>{
    const output=execFileSync(powershell,['-NoLogo','-NoProfile','-STA','-File',setup,arg],{encoding:'utf8',windowsHide:true});
    assert.match(output,/self-test passed|process test passed/i);
  });
}

test('wizard skips old and 32-bit Node executables before a supported runtime', {skip:process.platform!=='win32',timeout:30000}, async t=>{
  const compiler=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  try{await fs.access(compiler);}catch{t.skip('Windows C# compiler is unavailable');return;}
  const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-node-discovery-'));
  const candidates=[
    {folder:path.join(fixture,'old'),runtime:{version:'16.13.2',arch:'x64'}},
    {folder:path.join(fixture,'x86'),runtime:{version:'24.19.0',arch:'ia32'}},
  ];
  t.after(async()=>{
    for(const candidate of candidates){
      await fs.unlink(path.join(candidate.folder,'node.exe')).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await fs.unlink(path.join(candidate.folder,'fixture.cs')).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await fs.rmdir(candidate.folder).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
    await fs.rmdir(fixture);
  });
  for(const candidate of candidates){
    await fs.mkdir(candidate.folder);
    const json=JSON.stringify(candidate.runtime).replaceAll('"','""');
    const source='class Program { static void Main() { System.Console.WriteLine(@"'+json+'"); } }';
    const sourceFile=path.join(candidate.folder,'fixture.cs');
    const executable=path.join(candidate.folder,'node.exe');
    await fs.writeFile(sourceFile,source);
    execFileSync(compiler,['/nologo','/target:exe','/out:'+executable,sourceFile],{encoding:'utf8',windowsHide:true});
  }
  const env={...process.env};
  delete env.PATH;
  env.Path=[...candidates.map(candidate=>candidate.folder),path.dirname(process.execPath),process.env.Path||process.env.PATH||''].join(';');
  const output=execFileSync(powershell,['-NoLogo','-NoProfile','-STA','-File',setup,'-DetectUiSelfTest'],{encoding:'utf8',windowsHide:true,env});
  assert.match(output,/process test passed/i);
});

test('bundle chooses separate Revit paths and omits a mismatched 2025 runtime', {skip:process.platform!=='win32',timeout:30000}, async t=>{
  const bundle=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-dual-wizard-'));
  const packages=path.join(bundle,'packages'), folders=['2024','2025-net8'].map(year=>path.join(packages,year));
  const names=['buildx-package.json','buildx-confirmed-write.json'];
  t.after(async()=>{
    for(const folder of folders){
      for(const name of names)await fs.unlink(path.join(folder,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await fs.rmdir(folder).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
    await fs.rmdir(packages).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await fs.rmdir(bundle);
  });
  await fs.mkdir(packages);
  for(const folder of folders){
    await fs.mkdir(folder);
    for(const name of names)await fs.writeFile(path.join(folder,name),'{}',{flag:'wx'});
  }
  const output=execFileSync(powershell,['-NoLogo','-NoProfile','-STA','-File',setup,'-BundleUiSelfTest','-BundleRoot',bundle],{encoding:'utf8',windowsHide:true});
  assert.match(output,/bundle target mapping self-test passed/);
});
