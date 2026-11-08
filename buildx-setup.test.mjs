import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
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
