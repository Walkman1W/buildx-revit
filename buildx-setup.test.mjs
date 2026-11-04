import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
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
