$ErrorActionPreference = 'Stop'
$taskCompiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $taskCompiler -PathType Leaf)) { throw 'Existing .NET Framework compiler not found.' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskDirectory = Join-Path ([IO.Path]::GetTempPath()) ('buildx-cabinet-planning-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $taskDirectory) { throw 'Test output already exists.' }
[IO.Directory]::CreateDirectory($taskDirectory) | Out-Null
$taskExecutable = Join-Path $taskDirectory 'CabinetPlanTests.exe'
$taskSource = Join-Path $taskRoot 'family-core\CabinetPlan.cs'
$taskSourceHash = (Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash
& $taskCompiler /nologo /target:exe /langversion:5 ('/out:' + $taskExecutable) $taskSource (Join-Path $PSScriptRoot 'CabinetPlanTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Cabinet planning test compilation failed.' }
& $taskExecutable
if ($LASTEXITCODE -ne 0) { throw 'Cabinet planning tests failed.' }
if ((Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash -ne $taskSourceHash) { throw 'Cabinet plan source changed during testing.' }
[pscustomobject]@{scope='pure in-memory production planner; no Revit or file/model operations';testDirectory=$taskDirectory;sourceHash=$taskSourceHash} | ConvertTo-Json -Compress
