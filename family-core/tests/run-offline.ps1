# Compiles only the Revit-free family lifecycle core and its console acceptance
# suite with the existing Framework compiler. Every invocation has new evidence.
$ErrorActionPreference = 'Stop'
$taskProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskEvidenceRoot = Join-Path $taskProjectRoot 'workbench\validation\20261023-family-lifecycle'
$taskRunId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$taskRunRoot = Join-Path $taskEvidenceRoot $taskRunId
New-Item -ItemType Directory -Path $taskRunRoot | Out-Null
$taskCoreSource = Join-Path $taskProjectRoot 'family-core\FamilyJobRegistry.cs'
$taskTestSource = Join-Path $PSScriptRoot 'FamilyJobRegistryTests.cs'
$taskCompiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $taskCompiler -PathType Leaf)) {
    $taskCompiler = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
$taskLibrary = Join-Path $taskRunRoot 'BuildX.FamilyCore.dll'
$taskConsole = Join-Path $taskRunRoot 'BuildX.FamilyCore.OfflineTests.exe'
$taskTap = Join-Path $taskRunRoot 'tests.tap'
$taskSummaryPath = Join-Path $taskRunRoot 'summary.json'
$taskWatch = [Diagnostics.Stopwatch]::StartNew()
$taskSummary = [ordered]@{
    schemaVersion = 1; kind = 'offline_family_lifecycle'; runId = $taskRunId
    passed = $false; compiler = $taskCompiler; compilerVersion = $null; languageVersion = '5'
    evidenceDirectory = $taskRunRoot; libraryPath = $taskLibrary; consolePath = $taskConsole; tapPath = $taskTap
    inputs = $null; inputsAfter = $null; sourceUnchanged = $false; artifacts = $null
    libraryCompilation = $null; testCompilation = $null; execution = $null
    tests = $null; wallTimeMs = $null; cpuTimeMs = $null; peakProcessFamilyBytes = $null; tokens = $null; comparisonBaseline = $null
    measurementScope = 'One invocation: existing csc library compile, csc console compile and console tests. Wall time only; CPU, process-family peak, tokens and before/after performance baseline were not measured.'
    revitReferenced = $false; revitStarted = $false; rfaWritten = $false; serviceControl = $false; aiInvoked = $false
    failure = $null
}

function Get-TaskSourceFacts {
    param([string[]]$Paths)
    return @($Paths | ForEach-Object {
        $taskItem = Get-Item -LiteralPath $_
        [ordered]@{ path = $taskItem.FullName; byteLength = $taskItem.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant() }
    })
}

function Invoke-TaskNative {
    param([string]$Executable, [string[]]$Arguments, [string]$OutputPath)
    $taskNativeWatch = [Diagnostics.Stopwatch]::StartNew()
    $taskNativeExit = $null
    try { & $Executable @Arguments *> $OutputPath; $taskNativeExit = $LASTEXITCODE }
    catch { $taskNativeExit = if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { -1 } }
    $taskNativeWatch.Stop()
    return [ordered]@{ executable = $Executable; arguments = $Arguments; exitCode = $taskNativeExit; wallTimeMs = $taskNativeWatch.Elapsed.TotalMilliseconds; outputPath = $OutputPath }
}

try {
    if (-not (Test-Path -LiteralPath $taskCompiler -PathType Leaf)) { throw 'The existing Framework C# compiler is unavailable; nothing was installed.' }
    $taskSummary.compilerVersion = (Get-Item -LiteralPath $taskCompiler).VersionInfo.FileVersion
    $taskSummary.inputs = Get-TaskSourceFacts @($taskCoreSource, $taskTestSource)
    $taskSummary.libraryCompilation = Invoke-TaskNative -Executable $taskCompiler -Arguments @('/nologo', '/noconfig', '/langversion:5', '/target:library', '/warn:4', ('/out:' + $taskLibrary), $taskCoreSource) -OutputPath (Join-Path $taskRunRoot 'compile-library.txt')
    if ($taskSummary.libraryCompilation.exitCode -ne 0) { throw 'Family lifecycle library compilation failed.' }
    $taskSummary.testCompilation = Invoke-TaskNative -Executable $taskCompiler -Arguments @('/nologo', '/noconfig', '/langversion:5', '/target:exe', '/warn:4', ('/reference:' + $taskLibrary), ('/out:' + $taskConsole), $taskTestSource) -OutputPath (Join-Path $taskRunRoot 'compile-tests.txt')
    if ($taskSummary.testCompilation.exitCode -ne 0) { throw 'Family lifecycle acceptance console compilation failed.' }
    $taskSummary.execution = Invoke-TaskNative -Executable $taskConsole -Arguments @() -OutputPath $taskTap
    $taskLines = Get-Content -LiteralPath $taskTap
    $taskTotalMatch = [regex]::Match(($taskLines -join "`n"), '(?m)^# tests (\d+)\s*$')
    $taskPassMatch = [regex]::Match(($taskLines -join "`n"), '(?m)^# pass (\d+)\s*$')
    $taskFailMatch = [regex]::Match(($taskLines -join "`n"), '(?m)^# fail (\d+)\s*$')
    if (-not ($taskTotalMatch.Success -and $taskPassMatch.Success -and $taskFailMatch.Success)) { throw 'Acceptance console did not produce a complete test summary.' }
    $taskSummary.tests = [ordered]@{ total = [int]$taskTotalMatch.Groups[1].Value; passed = [int]$taskPassMatch.Groups[1].Value; failed = [int]$taskFailMatch.Groups[1].Value; skipped = 0 }
    $taskSummary.inputsAfter = Get-TaskSourceFacts @($taskCoreSource, $taskTestSource)
    $taskSummary.sourceUnchanged = ($taskSummary.inputs[0].sha256 -eq $taskSummary.inputsAfter[0].sha256 -and $taskSummary.inputs[1].sha256 -eq $taskSummary.inputsAfter[1].sha256)
    $taskSummary.passed = ($taskSummary.execution.exitCode -eq 0 -and $taskSummary.tests.total -gt 0 -and $taskSummary.tests.failed -eq 0 -and $taskSummary.tests.passed -eq $taskSummary.tests.total -and $taskSummary.sourceUnchanged)
    if (-not $taskSummary.passed) { throw 'Offline lifecycle checks failed or the compiled inputs changed during the run.' }
}
catch {
    $taskSummary.failure = $_.Exception.Message
    if (-not (Test-Path -LiteralPath $taskTap)) { Set-Content -LiteralPath $taskTap -Encoding utf8 -Value "TAP version 13`nBail out! Compilation or setup failed; inspect the retained compiler logs." }
}
finally {
    $taskWatch.Stop(); $taskSummary.wallTimeMs = $taskWatch.Elapsed.TotalMilliseconds
    $taskArtifacts = @($taskLibrary, $taskConsole, $taskTap) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    $taskSummary.artifacts = Get-TaskSourceFacts $taskArtifacts
    $taskSummary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskSummaryPath -Encoding utf8
}

$taskSummary | ConvertTo-Json -Depth 12
if (-not $taskSummary.passed) { throw ('Offline family lifecycle validation failed; evidence retained at ' + $taskSummaryPath) }
