$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskRun = 'terminal-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$taskEvidence = Join-Path $taskRoot ('workbench\validation\20261024-family-workflow\' + $taskRun)
New-Item -ItemType Directory -Path $taskEvidence | Out-Null
$taskCompiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$taskSources = @((Join-Path $taskRoot 'family-core\FamilyTerminalOutcome.cs'), (Join-Path $PSScriptRoot 'FamilyTerminalOutcomeTests.cs'), $PSCommandPath)
function Get-TaskFacts([string[]]$paths) { @($paths | ForEach-Object { $item = Get-Item -LiteralPath $_; [ordered]@{ path = $item.FullName; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() } }) }
$taskConsole = Join-Path $taskEvidence 'BuildX.TerminalOutcome.Tests.exe'
$taskSummary = [ordered]@{ kind = 'pure_terminal_outcome_checks'; runId = $taskRun; passed = $false; inputs = (Get-TaskFacts $taskSources); inputsAfter = $null; compileExit = $null; testExit = $null; tests = $null; console = $taskConsole; wallMs = $null; cpuMs = $null; processFamilyPeakBytes = $null; tokens = $null; revitReferenced = $false; revitExecuted = $false; oldSuitesExecuted = $false }
$taskWatch = [Diagnostics.Stopwatch]::StartNew()
& $taskCompiler '/nologo' '/noconfig' '/langversion:5' '/target:exe' ('/out:' + $taskConsole) $taskSources[0] $taskSources[1] *> (Join-Path $taskEvidence 'compile.txt')
$taskSummary.compileExit = $LASTEXITCODE
if ($taskSummary.compileExit -eq 0) {
    & $taskConsole *> (Join-Path $taskEvidence 'tests.tap')
    $taskSummary.testExit = $LASTEXITCODE
    $taskTap = Get-Content -LiteralPath (Join-Path $taskEvidence 'tests.tap') -Raw
    $taskTotal = [regex]::Match($taskTap, '(?m)^# tests (\d+)\s*$')
    $taskPass = [regex]::Match($taskTap, '(?m)^# pass (\d+)\s*$')
    $taskFail = [regex]::Match($taskTap, '(?m)^# fail (\d+)\s*$')
    if ($taskTotal.Success -and $taskPass.Success -and $taskFail.Success) { $taskSummary.tests = @{ total = [int]$taskTotal.Groups[1].Value; passed = [int]$taskPass.Groups[1].Value; failed = [int]$taskFail.Groups[1].Value; skipped = 0 } }
}
$taskWatch.Stop(); $taskSummary.wallMs = $taskWatch.Elapsed.TotalMilliseconds
$taskSummary.inputsAfter = Get-TaskFacts $taskSources
$taskSummary.passed = ($taskSummary.compileExit -eq 0 -and $taskSummary.testExit -eq 0 -and $null -ne $taskSummary.tests -and $taskSummary.tests.total -gt 0 -and $taskSummary.tests.failed -eq 0 -and $taskSummary.tests.passed -eq $taskSummary.tests.total -and @(Compare-Object $taskSummary.inputs.sha256 $taskSummary.inputsAfter.sha256).Count -eq 0)
$taskSummary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskEvidence 'summary.json') -Encoding utf8
$taskSummary | ConvertTo-Json -Depth 8
if (-not $taskSummary.passed) { throw ('Terminal outcome checks failed: ' + $taskEvidence) }
