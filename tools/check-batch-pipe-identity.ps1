param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$out=[IO.Path]::GetFullPath($EvidenceDirectory)
$prefix=(Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar
if (!$out.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)) { throw 'Choose a new evidence directory under artifacts.' }
[IO.Directory]::CreateDirectory($out) | Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$exe=Join-Path $out 'pipe-identity-experiment.exe'
$node=(Get-Command node -ErrorAction Stop).Source
& $compiler /nologo /target:exe /langversion:5 /codepage:65001 ('/out:'+$exe) (Join-Path $PSScriptRoot 'batch-pipe-identity-experiment.cs')
if ($LASTEXITCODE -ne 0) { throw 'Experiment compilation failed.' }
& $exe $node (Join-Path $PSScriptRoot 'batch-pipe-identity-peer.mjs') | Tee-Object -FilePath (Join-Path $out 'result.txt')
if ($LASTEXITCODE -ne 0) { throw 'Experiment failed.' }

$fileExe=Join-Path $out 'pipe-file-experiment.exe'
& $compiler /nologo /target:exe /langversion:5 /codepage:65001 ('/out:'+$fileExe) (Join-Path $PSScriptRoot 'batch-pipe-file-experiment.cs')
if ($LASTEXITCODE -ne 0) { throw 'File experiment compilation failed.' }
& $fileExe $out | Tee-Object -FilePath (Join-Path $out 'file-result.txt')
if ($LASTEXITCODE -ne 0) { throw 'File experiment failed.' }
