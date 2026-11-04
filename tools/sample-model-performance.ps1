[CmdletBinding(DefaultParameterSetName='Attach')]
param(
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$RevitProcessId,
    [Parameter(Mandatory=$true,ParameterSetName='Attach')][ValidateRange(1,2147483647)][int]$BenchmarkProcessId,
    [Parameter(Mandatory=$true,ParameterSetName='Launch')][switch]$LaunchBenchmark,
    [Parameter(ParameterSetName='Launch')][ValidateSet('after-064')][string]$Stage='after-064',
    [Parameter(ParameterSetName='Launch')][string]$NodeExecutable='C:\Users\LENOVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe',
    [ValidateRange(50,1000)][int]$IntervalMs=100,
    [ValidateRange(5,300)][int]$DurationSeconds=120,
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,63}$')][string]$EvidenceName='after-064-process-metrics'
)

# Read-only process observations. Only explicit -LaunchBenchmark starts the
# existing, fixed six-read benchmark. This script never stops a process,
# retries a request, changes Revit, or saves command lines/environment values.
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
$taskPanelRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskEvidenceRoot=[IO.Path]::GetFullPath((Join-Path $taskPanelRoot 'workbench\validation\20261028-workspace-update\metrics'))
if(-not $taskEvidenceRoot.StartsWith($taskPanelRoot+'\workbench\validation\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected evidence directory.'}
$taskCursor=$taskPanelRoot
foreach($taskSegment in @('workbench','validation','20261028-workspace-update','metrics')){
    $taskCursor=Join-Path $taskCursor $taskSegment
    if(Test-Path -LiteralPath $taskCursor){
        $taskItem=Get-Item -LiteralPath $taskCursor
        if(-not $taskItem.PSIsContainer -or ($taskItem.Attributes-band [IO.FileAttributes]::ReparsePoint)){throw 'Linked or non-directory evidence path rejected.'}
    }else{[IO.Directory]::CreateDirectory($taskCursor)|Out-Null}
}
$taskOutput=Join-Path $taskEvidenceRoot ($EvidenceName+'.json')
if(Test-Path -LiteralPath $taskOutput){throw 'Preserve the previous sample; choose another evidence name.'}
$taskRecords=[Collections.Generic.List[object]]::new()
$taskLive=[Collections.Generic.Dictionary[int,object]]::new()
$taskStartedUtc=[DateTime]::UtcNow
$taskMeasurementUtc=$null
$taskSampleCount=0
$taskPeakWorking=0L
$taskPeakPrivate=0L
$taskBaselineWorking=0L
$taskBaselinePrivate=0L
$taskMaxObservedGapMs=0.0
$taskPreviousSampleMs=$null
$taskDiscoveryFailures=0
$taskLateExisting=0
$taskCompletion='not_started'
$taskBenchmark=$null
$taskExitCode=$null
$taskFailureKind=$null
$taskCpuQueryFailures=0
$taskStdout=$null
$taskStderr=$null
$taskBenchmarkSourceHash=$null
$taskClock=[Diagnostics.Stopwatch]::StartNew()

function Add-ObservedProcess([Diagnostics.Process]$Observed,[string]$Role,[Nullable[int]]$ParentId,[string]$Admission){
    # Opening and retaining the Process handle ties later counters to this
    # process instance. PIDs or executable names alone are not reused as owners.
    $null=$Observed.Handle
    $taskBirth=$Observed.StartTime.ToUniversalTime()
    if($Observed.HasExited){throw 'Selected process exited before observation.'}
    $taskCurrentCpu=$Observed.TotalProcessorTime.TotalMilliseconds
    $taskRecord=[pscustomobject]@{
        process=$Observed;processId=$Observed.Id;role=$Role;parentProcessId=$ParentId
        startUtc=$taskBirth;firstObservedUtc=[DateTime]::UtcNow;admission=$Admission
        firstCpuMs=$taskCurrentCpu;baselineCpuMs=$taskCurrentCpu;lastCpuMs=$taskCurrentCpu
        lastWorkingSet=0L;lastPrivateBytes=0L;peakWorkingSet=0L;peakPrivateBytes=0L
        exited=$false;queryFailures=0;cpuCoverage='from measurement baseline'
    }
    if($null-ne $taskMeasurementUtc){
        if($taskBirth-ge $taskMeasurementUtc){$taskRecord.baselineCpuMs=0.0;$taskRecord.cpuCoverage='from process creation'}
        else{$script:taskLateExisting++;$taskRecord.cpuCoverage='from first observation; existing process admitted late'}
    }
    $taskRecords.Add($taskRecord)
    $taskLive[$Observed.Id]=$taskRecord
    return $taskRecord
}

function Read-ProcessSnapshot{
    if(-not ('BuildXMetricsProcessSnapshotV1' -as [type])){
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class BuildXMetricsProcessSnapshotV1 {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct Entry {
        internal uint Size, Usage, Id;
        internal UIntPtr Heap;
        internal uint Module, Threads, Parent;
        internal int Priority;
        internal uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] internal string Name;
    }
    public sealed class Item { public int ProcessId; public int ParentProcessId; }
    public sealed class Observation { public DateTime StartedUtc; public Item[] Items; }
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint process);
    [DllImport("kernel32.dll", EntryPoint="Process32FirstW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool First(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll", EntryPoint="Process32NextW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool Next(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
    public static Observation Read() {
        DateTime started=DateTime.UtcNow;
        IntPtr handle=CreateToolhelp32Snapshot(2,0);
        if(handle==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var items=new List<Item>();
            Entry entry=new Entry();entry.Size=(uint)Marshal.SizeOf(typeof(Entry));
            bool available=First(handle,ref entry);
            if(!available && Marshal.GetLastWin32Error()!=18)throw new Win32Exception(Marshal.GetLastWin32Error());
            while(available){
                if(items.Count>=16384)throw new InvalidOperationException("Process inventory limit reached.");
                if(entry.Id<=Int32.MaxValue && entry.Parent<=Int32.MaxValue)items.Add(new Item{ProcessId=(int)entry.Id,ParentProcessId=(int)entry.Parent});
                entry.Size=(uint)Marshal.SizeOf(typeof(Entry));available=Next(handle,ref entry);
                if(!available && Marshal.GetLastWin32Error()!=18)throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return new Observation{StartedUtc=started,Items=items.ToArray()};
        } finally { if(!CloseHandle(handle))throw new Win32Exception(Marshal.GetLastWin32Error()); }
    }
}
'@
    }
    return [BuildXMetricsProcessSnapshotV1]::Read()
}

function Find-ObservedChildren{
    try{$taskSnapshot=Read-ProcessSnapshot;$taskInventory=$taskSnapshot.Items}
    catch{$script:taskDiscoveryFailures++;return}
    # One inventory may contain multiple generations. Admit only children of a
    # still-live, retained parent handle. A child must have existed before the
    # snapshot began and remain alive after acquiring its handle, so a PID
    # reused after the snapshot cannot inherit its former parent's identity.
    for($taskPass=0;$taskPass-lt 8;$taskPass++){
        $taskAdded=0
        foreach($taskCandidate in $taskInventory){
            $taskChildId=[int]$taskCandidate.ProcessId
            $taskParentId=[int]$taskCandidate.ParentProcessId
            if($taskLive.ContainsKey($taskChildId)-or -not $taskLive.ContainsKey($taskParentId)){continue}
            $taskParent=$taskLive[$taskParentId]
            $taskChild=$null
            try{
                if($taskParent.process.HasExited){continue}
                $taskChild=[Diagnostics.Process]::GetProcessById($taskChildId)
                $null=$taskChild.Handle
                $taskChildBirth=$taskChild.StartTime.ToUniversalTime()
                if($taskChildBirth-lt $taskParent.startUtc -or $taskChildBirth-gt $taskSnapshot.StartedUtc -or $taskChild.HasExited -or $taskParent.process.HasExited){$taskChild.Dispose();continue}
                $null=Add-ObservedProcess $taskChild $taskParent.role $taskParentId 'live-parent-and-snapshot-birth-time'
                $taskAdded++
            }catch{if($null-ne $taskChild){$taskChild.Dispose()}}
        }
        if(-not $taskAdded){break}
    }
}

function Read-Counters{
    $taskWorking=0L;$taskPrivate=0L
    foreach($taskRecord in $taskRecords){
        if($taskRecord.exited){continue}
        try{
            $taskRecord.process.Refresh()
            # A retained handle may still provide final CPU after exit. If it
            # cannot, keep the last measured counter and report the gap.
            try{$taskRecord.lastCpuMs=[Math]::Max($taskRecord.lastCpuMs,$taskRecord.process.TotalProcessorTime.TotalMilliseconds)}
            catch{$script:taskCpuQueryFailures++}
            if($taskRecord.process.HasExited){
                $taskRecord.exited=$true;$null=$taskLive.Remove($taskRecord.processId);continue
            }
            $taskRecord.lastWorkingSet=[long]$taskRecord.process.WorkingSet64
            $taskRecord.lastPrivateBytes=[long]$taskRecord.process.PrivateMemorySize64
            $taskRecord.peakWorkingSet=[Math]::Max($taskRecord.peakWorkingSet,$taskRecord.lastWorkingSet)
            $taskRecord.peakPrivateBytes=[Math]::Max($taskRecord.peakPrivateBytes,$taskRecord.lastPrivateBytes)
            $taskWorking+=$taskRecord.lastWorkingSet;$taskPrivate+=$taskRecord.lastPrivateBytes
        }catch{$taskRecord.queryFailures++}
    }
    $taskNow=$taskClock.Elapsed.TotalMilliseconds
    if($null-ne $taskPreviousSampleMs){$script:taskMaxObservedGapMs=[Math]::Max($taskMaxObservedGapMs,$taskNow-$taskPreviousSampleMs)}
    $script:taskPreviousSampleMs=$taskNow
    $script:taskSampleCount++
    $script:taskPeakWorking=[Math]::Max($taskPeakWorking,$taskWorking)
    $script:taskPeakPrivate=[Math]::Max($taskPeakPrivate,$taskPrivate)
    return [pscustomobject]@{workingSetBytes=$taskWorking;privateBytes=$taskPrivate}
}

try{
    $taskRevit=[Diagnostics.Process]::GetProcessById($RevitProcessId)
    if($taskRevit.ProcessName-ne 'Revit'){throw 'Selected root is not Revit.'}
    $null=Add-ObservedProcess $taskRevit 'revit' $null 'explicit-live-root'
    if(-not $LaunchBenchmark){
        $taskBenchmark=[Diagnostics.Process]::GetProcessById($BenchmarkProcessId)
        if($taskBenchmark.ProcessName-ne 'node'){throw 'Selected benchmark root is not Node.'}
        $null=Add-ObservedProcess $taskBenchmark 'benchmark' $null 'explicit-live-root'
    }
    Find-ObservedChildren
    $taskFirst=Read-Counters
    $taskBaselineWorking=$taskFirst.workingSetBytes;$taskBaselinePrivate=$taskFirst.privateBytes
    $taskMeasurementUtc=[DateTime]::UtcNow
    foreach($taskRecord in $taskRecords){$taskRecord.baselineCpuMs=$taskRecord.lastCpuMs}
    if($LaunchBenchmark){
        $taskScript=Join-Path $taskPanelRoot 'tools\measure-model-command.mjs'
        $taskResult=Join-Path $taskPanelRoot ('workbench\validation\20261028-workspace-update\'+$Stage+'-performance.json')
        if(Test-Path -LiteralPath $taskResult){throw 'Benchmark result already exists; no model read was started.'}
        if(-not [IO.File]::Exists($NodeExecutable)-or -not [IO.File]::Exists($taskScript)){throw 'Pinned Node or benchmark script is missing.'}
        $taskBenchmarkSourceHash=(Get-FileHash -LiteralPath $taskScript -Algorithm SHA256).Hash.ToLowerInvariant()
        $taskStartInfo=[Diagnostics.ProcessStartInfo]::new()
        $taskStartInfo.FileName=[IO.Path]::GetFullPath($NodeExecutable)
        $taskStartInfo.ArgumentList.Add($taskScript);$taskStartInfo.ArgumentList.Add($Stage)
        $taskStartInfo.WorkingDirectory=$taskPanelRoot
        $taskStartInfo.UseShellExecute=$false;$taskStartInfo.CreateNoWindow=$true
        $taskStartInfo.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
        $taskStartInfo.RedirectStandardOutput=$true;$taskStartInfo.RedirectStandardError=$true
        $taskBenchmark=[Diagnostics.Process]::Start($taskStartInfo)
        # The fixed benchmark prints one bounded summary. Drain both pipes, but
        # save only byte counts, never exception bodies or inherited settings.
        $taskStdout=$taskBenchmark.StandardOutput.ReadToEndAsync()
        $taskStderr=$taskBenchmark.StandardError.ReadToEndAsync()
        $null=Add-ObservedProcess $taskBenchmark 'benchmark' $null 'started-fixed-benchmark'
    }
    $taskCompletion='sampling'
    $taskDeadline=$taskClock.Elapsed.TotalSeconds+$DurationSeconds
    $taskNextDiscovery=$taskClock.Elapsed.TotalSeconds+1.0
    do{
        $null=Read-Counters
        if($taskBenchmark.HasExited){$taskCompletion='benchmark_exited';$taskExitCode=$taskBenchmark.ExitCode;break}
        if($taskClock.Elapsed.TotalSeconds-ge $taskDeadline){$taskCompletion='sampler_deadline';break}
        if($taskClock.Elapsed.TotalSeconds-ge $taskNextDiscovery){Find-ObservedChildren;$taskNextDiscovery=$taskClock.Elapsed.TotalSeconds+1.0}
        Start-Sleep -Milliseconds $IntervalMs
    }while($true)
    $null=Read-Counters
}catch{
    $taskCompletion='sampler_error'
    $taskFailureKind=$_.Exception.GetType().Name
}finally{
    $taskClock.Stop()
    $taskProcesses=@($taskRecords|ForEach-Object{
        [ordered]@{processId=$_.processId;role=$_.role;parentProcessId=$_.parentProcessId;startUtc=$_.startUtc.ToString('o');firstObservedUtc=$_.firstObservedUtc.ToString('o');admission=$_.admission;
            cpuMs=[Math]::Max(0.0,$_.lastCpuMs-$_.baselineCpuMs);cpuCoverage=$_.cpuCoverage;peakWorkingSetBytes=$_.peakWorkingSet;peakPrivateBytes=$_.peakPrivateBytes;exited=$_.exited;counterQueryFailures=$_.queryFailures}
    })
    $taskFamily=@($taskProcesses|Group-Object role|ForEach-Object{[ordered]@{role=$_.Name;processCount=$_.Count;cpuMs=($_.Group|Measure-Object -Property cpuMs -Sum).Sum}})
    $taskOutBytes=$null;$taskErrBytes=$null
    if($null-ne $taskStdout-and $taskStdout.IsCompletedSuccessfully){$taskOutBytes=[Text.Encoding]::UTF8.GetByteCount($taskStdout.Result)}
    if($null-ne $taskStderr-and $taskStderr.IsCompletedSuccessfully){$taskErrBytes=[Text.Encoding]::UTF8.GetByteCount($taskStderr.Result)}
    $taskSummary=[ordered]@{
        schemaVersion=1;startedUtc=$taskStartedUtc.ToString('o');measurementBaselineUtc=if($null-ne $taskMeasurementUtc){$taskMeasurementUtc.ToString('o')}else{$null};finishedUtc=[DateTime]::UtcNow.ToString('o');scope='sampled Revit and benchmark Node process families; no AI workflow';completion=$taskCompletion;
        benchmarkStartedBySampler=[bool]$LaunchBenchmark;benchmarkProcessId=if($null-ne $taskBenchmark){$taskBenchmark.Id}else{$null};benchmarkExitCode=$taskExitCode;benchmarkSourceSha256=$taskBenchmarkSourceHash;
        elapsedMs=$taskClock.Elapsed.TotalMilliseconds;intervalTargetMs=$IntervalMs;samples=$taskSampleCount;maxObservedSampleGapMs=$taskMaxObservedGapMs;
        baselineWorkingSetBytes=$taskBaselineWorking;baselinePrivateBytes=$taskBaselinePrivate;sampledPeakFamilyWorkingSetBytes=$taskPeakWorking;sampledPeakFamilyPrivateBytes=$taskPeakPrivate;
        families=$taskFamily;processes=$taskProcesses;discoveryFailures=$taskDiscoveryFailures;lateExistingProcesses=$taskLateExisting;finalCpuQueryFailures=$taskCpuQueryFailures;failureKind=$taskFailureKind;
        stdoutBytes=$taskOutBytes;stderrBytes=$taskErrBytes;rawStreamsStored=$false;processesStopped=0;
        limitations=@('Sampling gives an observed peak, not a kernel high-water mark.','Summed working sets include shared-page double counting; private bytes are reported separately.','Children born and exited between discovery observations may be missed; inaccessible processes are not inferred absent.','Existing server/AI processes outside the selected Revit and benchmark families are excluded.','CPU includes other activity in these selected processes during the measurement; Windows file cache is uncontrolled.','At the sampler deadline the benchmark is left running and is never killed or retried.')
    }
    $taskJson=$taskSummary|ConvertTo-Json -Depth 12
    $taskFile=[IO.File]::Open($taskOutput,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$taskBytes=[Text.Encoding]::UTF8.GetBytes($taskJson+"`n");$taskFile.Write($taskBytes,0,$taskBytes.Length);$taskFile.Flush($true)}finally{$taskFile.Dispose()}
    foreach($taskRecord in $taskRecords){$taskRecord.process.Dispose()}
    Write-Output ([ordered]@{output=$taskOutput;completion=$taskCompletion;benchmarkExitCode=$taskExitCode;samples=$taskSampleCount;elapsedMs=$taskClock.Elapsed.TotalMilliseconds;sampledPeakFamilyWorkingSetBytes=$taskPeakWorking;sampledPeakFamilyPrivateBytes=$taskPeakPrivate}|ConvertTo-Json -Compress)
}
if($taskCompletion-ne 'benchmark_exited'-or $taskExitCode-ne 0){exit 2}
