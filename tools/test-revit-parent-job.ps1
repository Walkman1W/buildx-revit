[CmdletBinding()]
param([Parameter(Mandatory=$true)][int]$ParentPid,[Parameter(Mandatory=$true)][string]$NodeExecutable)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2
$jobSource=@'
using System;
using System.Runtime.InteropServices;
public static class BuildxFixtureJob {
 [StructLayout(LayoutKind.Sequential)] public struct BASIC { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] public struct EXTENDED { public BASIC BasicLimitInformation; public IO IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int infoClass,ref EXTENDED info,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
 public static IntPtr Create() { IntPtr job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); var info=new EXTENDED();info.BasicLimitInformation.LimitFlags=0x2000; if(!SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf(typeof(EXTENDED)))){CloseHandle(job);throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}return job; }
}
'@
Add-Type -TypeDefinition $jobSource
$root=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$parent=Get-Process -Id $ParentPid -ErrorAction Stop
$node=[IO.Path]::GetFullPath($NodeExecutable)
$dir=Join-Path ([IO.Path]::GetTempPath()) ('buildx-parent-job-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($dir)
$ready=Join-Path $dir 'ready';$go=Join-Path $dir 'go';$out=Join-Path $dir 'child.json';$script=Join-Path $root 'tools\buildx-revit-parent-launch.ps1'
# All interpolated paths are locally generated or fixed; encode arguments via JSON.
$code=@'
param($Ready,$Go,$Output,$Script,$ParentId,$ParentTime,$Node)
[IO.File]::WriteAllText($Ready,'ready')
for($i=0;$i -lt 200 -and -not (Test-Path -LiteralPath $Go);$i++){Start-Sleep -Milliseconds 50}
if(-not (Test-Path -LiteralPath $Go)){exit 7}
$result=& $Script -ParentPid ([int]$ParentId) -ExpectedParentFileTime ([long]$ParentTime) -NodeExecutable $Node -Fixture
[IO.File]::WriteAllText($Output,[string]$result)
Start-Sleep -Seconds 25
'@
$childScript=Join-Path $dir 'launcher.ps1';[IO.File]::WriteAllText($childScript,$code)
$args=@('-NoProfile','-NonInteractive','-File',('"'+$childScript+'"'),('"'+$ready+'"'),('"'+$go+'"'),('"'+$out+'"'),('"'+$script+'"'),$parent.Id,$parent.StartTime.ToUniversalTime().ToFileTimeUtc(),('"'+$node+'"'))
$job=[BuildxFixtureJob]::Create();$child=$null
try{
  $child=Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $args -WindowStyle Hidden -PassThru
  for($i=0;$i -lt 120 -and -not (Test-Path -LiteralPath $ready);$i++){Start-Sleep -Milliseconds 50}
  if(-not (Test-Path -LiteralPath $ready)){throw 'Owned test launcher did not become ready.'}
  if(-not [BuildxFixtureJob]::AssignProcessToJobObject($job,$child.Handle)){throw ('Cannot assign test job: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
  [IO.File]::WriteAllText($go,'go')
  for($i=0;$i -lt 200 -and -not (Test-Path -LiteralPath $out);$i++){Start-Sleep -Milliseconds 50}
  if(-not (Test-Path -LiteralPath $out)){throw 'Fixture was not started.'}
  $result=Get-Content -LiteralPath $out -Raw | ConvertFrom-Json
  $observed=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$result.childPid)
  if(-not $observed -or $observed.ParentProcessId -ne $parent.Id){throw 'Fixture parent could not be verified.'}
  [void][BuildxFixtureJob]::CloseHandle($job);$job=[IntPtr]::Zero
  if(-not $child.WaitForExit(5000)){throw 'Owned launcher did not stop when the test job closed.'}
  $fixture=Get-Process -Id $result.childPid -ErrorAction SilentlyContinue
  [pscustomobject]@{fixturePid=$result.childPid;observedParentPid=$observed.ParentProcessId;launcherExited=$child.HasExited;fixtureAliveAfterJobClose=($null -ne $fixture)} | ConvertTo-Json -Compress
} finally {
  if($job -ne [IntPtr]::Zero){[void][BuildxFixtureJob]::CloseHandle($job)}
  if($child){$child.Dispose()}
}
