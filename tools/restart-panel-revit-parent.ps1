[CmdletBinding()]
param([Parameter(Mandatory=$true)][int]$ExpectedServicePid,[Parameter(Mandatory=$true)][int]$ExpectedRevitPid)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
$panelRoot=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
# Import the existing verified ownership, readiness and graceful-stop routines.
. (Join-Path $panelRoot 'restart-panel.ps1') -Plan | Out-Null
$owned=Get-OwnedService
if(-not $owned -or $owned.ProcessId -ne $ExpectedServicePid -or $owned.Status.busy -or
   $owned.Status.cleanupPending -or $owned.Status.interruptionNotice) { throw 'The expected panel is no longer idle and ready for graceful restart.' }
$process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ExpectedServicePid)
if(-not $process -or [int]$process.ParentProcessId -ne $ExpectedRevitPid) { throw 'The existing service is no longer owned by the expected Revit process.' }
$revit=Get-Process -Id $ExpectedRevitPid -ErrorAction Stop
if($revit.ProcessName -ine 'Revit') { throw 'The expected Revit process changed.' }
$parentTime=$revit.StartTime.ToUniversalTime().ToFileTimeUtc()
$codexChildren=@(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$ExpectedServicePid) | Where-Object { $_.Name -ieq 'codex.exe' -and $_.ExecutablePath })
if($codexChildren.Count -ne 1 -or -not (Test-Path -LiteralPath $codexChildren[0].ExecutablePath -PathType Leaf)) { throw 'The existing Codex child could not be identified uniquely.' }
$codexExe=[IO.Path]::GetFullPath([string]$codexChildren[0].ExecutablePath)
$contract=Get-ExpectedPanelContract $owned.NodePath
$original=Open-OwnedPanelProcess $owned
$recordRoot=Join-Path $panelRoot ('runtime\manual-restarts\'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
[void](New-Item -ItemType Directory -Path $recordRoot)
$result=[ordered]@{startedUtc=[DateTime]::UtcNow.ToString('o');oldPid=$ExpectedServicePid;revitPid=$ExpectedRevitPid;stopRequested=$false;oldExitConfirmed=$false;newPid=$null;ready=$false;outcome='in_progress'}
function Save-Result { [IO.File]::WriteAllText((Join-Path $recordRoot 'result.json'),($result|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false))) }
Save-Result
try {
  $fresh=Get-OwnedService
  if(-not $fresh -or $fresh.ProcessId -ne $owned.ProcessId -or $fresh.CreatedUtc -ne $owned.CreatedUtc -or $fresh.RecordText -cne $owned.RecordText -or $fresh.Status.busy -or $fresh.Status.cleanupPending -or $fresh.Status.interruptionNotice) { throw 'Service identity or activity changed before shutdown.' }
  if((Get-Process -Id $ExpectedRevitPid -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc() -ne $parentTime) { throw 'Revit process identity changed before shutdown.' }
  $reply=Invoke-PanelHttp 'POST' '/api/stop-service' ([string]$fresh.Status.csrf)
  if($reply.ok -ne $true) { throw 'Graceful shutdown was not acknowledged.' }
  $result.stopRequested=$true;Save-Result
  Wait-OwnedPanelExit $original
  $result.oldExitConfirmed=$true;Save-Result
  if(@(Get-Listeners).Count -ne 0) { throw 'Port is not free; no replacement was launched.' }
  # Preserve the executable used by the verified old app-server for this child
  # only; this does not modify the user's global Codex configuration.
  $env:BUILDX_CODEX_EXE=$codexExe
  $startedJson=& (Join-Path $panelRoot 'tools\buildx-revit-parent-launch.ps1') -ParentPid $ExpectedRevitPid -ExpectedParentFileTime $parentTime -NodeExecutable $owned.NodePath -StartService
  $started=$startedJson | ConvertFrom-Json
  $result.newPid=[int]$started.childPid;Save-Result
  $watch=[Diagnostics.Stopwatch]::StartNew()
  do {
    $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$result.newPid) -ErrorAction SilentlyContinue
    if(-not $p) { throw 'Replacement service exited before readiness.' }
    if([int]$p.ParentProcessId -ne $ExpectedRevitPid) { throw 'Replacement service parent identity was not verified.' }
    $listeners=@(Get-Listeners)
    if($listeners.Count -gt 0){
      if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or [int]$listeners[0].OwningProcess -ne $result.newPid) { throw 'Unexpected listener appeared; no additional process was launched.' }
      try { $new=Get-OwnedService } catch { $new=$null }
      if($new -and $new.ProcessId -eq $result.newPid -and (Test-ExpectedPanelReadiness $new.Status $contract)) { $result.ready=$true;$result.outcome='ready_expected_tools';break }
    }
    if($watch.Elapsed.TotalSeconds -ge 60) { throw 'Replacement service did not establish expected readiness in time.' }
    Start-Sleep -Milliseconds 800
  } while($true)
  $result.finishedUtc=[DateTime]::UtcNow.ToString('o');Save-Result
  [ordered]@{outcome=$result.outcome;oldPid=$result.oldPid;newPid=$result.newPid;revitPid=$result.revitPid;ready=$result.ready;evidenceDirectory=$recordRoot}|ConvertTo-Json
} catch {
  $result.outcome='stopped_on_error';$result.error=$_.Exception.Message;$result.finishedUtc=[DateTime]::UtcNow.ToString('o');Save-Result
  throw
} finally { $original.Dispose() }
