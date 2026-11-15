import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MODEL_SERVER_PROFILE,panelProfile} from '../lib/panel-profile.mjs';
import {createCodexSessionProfile} from '../lib/codex-profile.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),evidence=path.join(root,'workbench/validation/20261027-load-readiness');
const quote=text=>"'"+text.replaceAll("'","''")+"'";

test('the actual restart helper consumes the server selection and rejects wrong/malformed tool readiness without running service controls',async()=>{
  await fs.mkdir(evidence,{recursive:true});const folder=await fs.mkdtemp(path.join(evidence,'contract-')),file=path.join(folder,'check.ps1');
  const body=`$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
$panelRoot=${quote(root)}
$expectedService='revit-local-codex'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $panelRoot 'restart-panel.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PowerShell parse failed'}
foreach($name in @('Get-ExpectedPanelContract','Test-ExpectedPanelReadiness')){
 $nodes=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
 if($nodes.Count -ne 1){throw 'Ambiguous producer function'}
 Invoke-Expression $nodes[0].Extent.Text
}
$contract=Get-ExpectedPanelContract ${quote(process.execPath)}
$good=@{service=$expectedService;ready=$true;toolCount=@($contract.toolNames).Count;mode='document-workbench';workspace=@{kind='model';supportsModelContext=$true};toolCatalog=@($contract.catalogNames|ForEach-Object{@{name=$_;readOnly=$contract.toolReadOnly.PSObject.Properties[$_].Value}})}
$rows=@()
function Check($label,$data,$expected){$actual=Test-ExpectedPanelReadiness ($data|ConvertTo-Json -Depth 10|ConvertFrom-Json) $contract;if($actual -ne $expected){throw ('Wrong readiness: '+$label)};$script:rows+=@{name=$label;passed=$true}}
Check 'exact selected named catalog' $good $true
foreach($change in @(@{toolCount=(@($contract.toolNames).Count+1)},@{toolCount=6},@{toolCount=0},@{ready='true'},@{mode='source-development'},@{service='foreign'},@{toolCount=([string]@($contract.toolNames).Count)},@{workspace=@{kind='customer-chat';supportsModelContext=$false}})){
 $copy=$good.Clone();foreach($key in $change.Keys){$copy[$key]=$change[$key]};Check ('wrong '+($change.Keys -join ',')) $copy $false
}
$copy=$good.Clone();$copy.toolCatalog=@(@{name='foreign_tool';readOnly=$true})+$good.toolCatalog[1..($good.toolCatalog.Count-1)];Check 'same count foreign name' $copy $false
$copy=$good.Clone();$copy.toolCatalog=@($good.toolCatalog[0])+$good.toolCatalog[0..($good.toolCatalog.Count-2)];Check 'duplicate name' $copy $false
$copy=$good.Clone();$copy.toolCatalog=@(@{name=$good.toolCatalog[0].name;readOnly=(-not $good.toolCatalog[0].readOnly)})+$good.toolCatalog[1..($good.toolCatalog.Count-1)];Check 'changed authority' $copy $false
$copy=$good.Clone();$copy.Remove('workspace');Check 'omitted workspace' $copy $false
$copy=$good.Clone();$copy.toolCatalog=@(@{name='REVIT_WORKBENCH_STATUS';readOnly=$true})+$good.toolCatalog[1..($good.toolCatalog.Count-1)];Check 'wrong case' $copy $false
@{contract=$contract;checks=$rows;nativeProcessesStarted=0;serviceMutations=0}|ConvertTo-Json -Depth 10
`;await fs.writeFile(file,body);const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',file],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:256*1024});await fs.writeFile(path.join(folder,'stdout.txt'),result.stdout);await fs.writeFile(path.join(folder,'stderr.txt'),result.stderr);assert.equal(result.status,0,result.stderr);const data=JSON.parse(result.stdout);assert.equal(data.contract.profile,MODEL_SERVER_PROFILE);assert.deepEqual(data.contract.toolNames,createCodexSessionProfile(root,{profile:MODEL_SERVER_PROFILE}).toolNames);assert.deepEqual([...data.contract.catalogNames].sort(),panelProfile(MODEL_SERVER_PROFILE).catalog.map(value=>value.name).sort());assert.equal(data.checks.length,14);assert.ok(data.checks.every(row=>row.passed));await fs.writeFile(path.join(folder,'result.json'),JSON.stringify(data,null,2)+'\n');
});

test('restart waits for the retained original process as well as a free port, and rejects a mismatched creation time',async()=>{
  await fs.mkdir(evidence,{recursive:true});
  const folder=await fs.mkdtemp(path.join(evidence,'process-exit-')),file=path.join(folder,'check.ps1'),child=path.join(folder,'short-lived.mjs');
  // This process opens no socket and exits on its own, even if an assertion fails.
  await fs.writeFile(child,'setTimeout(() => process.exit(0), 4000);\n');
  const body=`$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path.join(root,'restart-panel.ps1'))},[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PowerShell parse failed'}
foreach($name in @('Open-OwnedPanelProcess','Wait-OwnedPanelExit')){
 $nodes=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
 if($nodes.Count -ne 1){throw 'Ambiguous process gate function'}
 Invoke-Expression $nodes[0].Extent.Text
}
$script:testListeners=@()
function Get-Listeners { @($script:testListeners) }
$childProcess=$null;$held=$null
try {
 $childProcess=Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ('"'+${quote(child)}+'"') -WindowStyle Hidden -PassThru
 $identity=Get-CimInstance Win32_Process -Filter ('ProcessId='+$childProcess.Id)
 if(-not $identity -or -not $identity.CreationDate){throw 'Test child identity unavailable'}
 $owned=[pscustomobject]@{ProcessId=$childProcess.Id;CreatedUtc=([DateTime]$identity.CreationDate).ToUniversalTime()}
 $wrong=[pscustomobject]@{ProcessId=$owned.ProcessId;CreatedUtc=$owned.CreatedUtc.AddSeconds(-1)}
 $mismatchRejected=$false
 try { $unexpected=Open-OwnedPanelProcess $wrong; $unexpected.Dispose() } catch { $mismatchRejected=$true }
 if(-not $mismatchRejected -or $childProcess.HasExited){throw 'Creation mismatch did not fail without affecting the child'}
 $held=Open-OwnedPanelProcess $owned
 $runningRejected=$false
 try { Wait-OwnedPanelExit $held 20 } catch { $runningRejected=$_.Exception.Message -like 'The original Node process has not exited*' }
 if(-not $runningRejected -or $held.HasExited){throw 'A free port was incorrectly accepted while the original process was alive'}
 if(-not $held.WaitForExit(10000)){throw 'Test child did not exit on its own'}
 $script:testListeners=@([pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=1})
 $occupiedRejected=$false
 try { Wait-OwnedPanelExit $held 20 } catch { $occupiedRejected=$_.Exception.Message -like 'Port is still occupied*' }
 if(-not $occupiedRejected){throw 'A listener was ignored after the original process exited'}
 $script:testListeners=@()
 Wait-OwnedPanelExit $held 20
 @{creationMismatchRejected=$mismatchRejected;freePortWhileAliveRejected=$runningRejected;occupiedPortAfterExitRejected=$occupiedRejected;originalProcessExitConfirmed=$held.HasExited;serviceRequests=0;revitOperations=0}|ConvertTo-Json
} finally {
 if($held){$held.Dispose()}
 if($childProcess){$childProcess.Dispose()}
}
`;
  await fs.writeFile(file,body);
  const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',file],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:256*1024});
  await fs.writeFile(path.join(folder,'stdout.txt'),result.stdout);await fs.writeFile(path.join(folder,'stderr.txt'),result.stderr);
  assert.equal(result.status,0,result.stderr);
  const data=JSON.parse(result.stdout);
  for(const key of ['creationMismatchRejected','freePortWhileAliveRejected','occupiedPortAfterExitRejected','originalProcessExitConfirmed'])assert.equal(data[key],true,key);
  assert.equal(data.serviceRequests,0);assert.equal(data.revitOperations,0);
  await fs.writeFile(path.join(folder,'result.json'),JSON.stringify(data,null,2)+'\n');
});
