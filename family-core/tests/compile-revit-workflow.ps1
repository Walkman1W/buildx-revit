$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskRun = 'workflow-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$taskEvidence = Join-Path $taskRoot ('workbench\validation\20261024-family-workflow\' + $taskRun)
New-Item -ItemType Directory -Path $taskEvidence | Out-Null
$taskCompiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$taskFramework = [IO.Path]::GetDirectoryName($taskCompiler)
$taskSources = @((Get-ChildItem -LiteralPath (Join-Path $taskRoot 'family-core') -Filter '*.cs' -File).FullName) + @((Get-ChildItem -LiteralPath (Join-Path $taskRoot 'family-core\revit') -Filter '*.cs' -File).FullName)
$taskReferences = @((Join-Path $taskFramework 'System.dll'), (Join-Path $taskFramework 'System.Core.dll'), (Join-Path $taskFramework 'System.Web.Extensions.dll'), 'D:\Program Files\Autodesk\Revit 2024\RevitAPI.dll', 'D:\Program Files\Autodesk\Revit 2024\RevitAPIUI.dll')
$taskOutput = Join-Path $taskEvidence 'BuildX.FamilyWorkflow.dll'
$taskLog = Join-Path $taskEvidence 'compile.txt'
function Get-TaskFacts([string[]]$paths) {
    @($paths | ForEach-Object { $item = Get-Item -LiteralPath $_; [ordered]@{ path = $item.FullName; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() } })
}
$taskSummary = [ordered]@{ kind = 'revit_family_workflow_actual_api_compile'; runId = $taskRun; passed = $false; inputs = (Get-TaskFacts ($taskSources + $taskReferences + @($PSCommandPath))); inputsAfter = $null; unchanged = $false; output = $taskOutput; outputFacts = $null; compiler = $taskCompiler; log = $taskLog; exitCode = $null; wallMs = $null; cpuMs = $null; processFamilyPeakBytes = $null; tokens = $null; actualRevitExecuted = $false; testsExecuted = $false; serviceControl = $false; installed = $false }
$taskArgs = @('/nologo', '/noconfig', '/langversion:5', '/target:library', '/platform:x64', '/utf8output', '/warn:4', ('/out:' + $taskOutput)) + @($taskReferences | ForEach-Object { '/reference:' + $_ }) + $taskSources
$taskWatch = [Diagnostics.Stopwatch]::StartNew()
& $taskCompiler @taskArgs *> $taskLog
$taskSummary.exitCode = $LASTEXITCODE
$taskWatch.Stop(); $taskSummary.wallMs = $taskWatch.Elapsed.TotalMilliseconds
$taskSummary.inputsAfter = Get-TaskFacts ($taskSources + $taskReferences + @($PSCommandPath))
$taskSummary.unchanged = (@(Compare-Object $taskSummary.inputs.sha256 $taskSummary.inputsAfter.sha256).Count -eq 0)
if (Test-Path -LiteralPath $taskOutput -PathType Leaf) { $taskSummary.outputFacts = Get-TaskFacts @($taskOutput) }
$taskSummary.passed = ($taskSummary.exitCode -eq 0 -and $taskSummary.unchanged)
$taskSummary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $taskEvidence 'summary.json') -Encoding utf8
Get-Content -LiteralPath $taskLog
$taskSummary | ConvertTo-Json -Depth 10
if (-not $taskSummary.passed) { throw ('Compile failed; retained evidence: ' + $taskEvidence) }
