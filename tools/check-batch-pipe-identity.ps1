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

$nodeLib=Join-Path $env:LOCALAPPDATA 'node-gyp/Cache/22.17.0/x64'
$sysroot=(& rustc --print sysroot).Trim()
$lld=Join-Path $sysroot 'lib/rustlib/x86_64-pc-windows-msvc/bin/rust-lld.exe'
if (!(Test-Path -LiteralPath (Join-Path $nodeLib 'node.lib')) -or !(Test-Path -LiteralPath $lld)) { throw 'Offline Rust linker or exact Node 22.17.0 import library is unavailable.' }
& rustc --edition 2024 --crate-type cdylib -C panic=abort ('-Clinker='+$lld) -C link-arg=/nodefaultlib -C link-arg=/noentry ('-Lnative='+$nodeLib) --out-dir $out (Join-Path $PSScriptRoot 'batch-file-napi-experiment.rs')
if ($LASTEXITCODE -ne 0) { throw 'Offline Node addon build failed.' }
$addon=Join-Path $out 'batch_file_napi_experiment.node'
Copy-Item -LiteralPath (Join-Path $out 'batch_file_napi_experiment.dll') -Destination $addon
$nodeExe=Join-Path $out 'pipe-node-file-experiment.exe'
& $compiler /nologo /target:exe /langversion:5 /codepage:65001 ('/out:'+$nodeExe) (Join-Path $PSScriptRoot 'batch-pipe-node-file-experiment.cs')
if ($LASTEXITCODE -ne 0) { throw 'Node file experiment compilation failed.' }
$nodeOut=Join-Path $out 'node-peer'; [IO.Directory]::CreateDirectory($nodeOut) | Out-Null
& $nodeExe $nodeOut $node (Join-Path $PSScriptRoot 'batch-file-napi-peer.mjs') $addon | Tee-Object -FilePath (Join-Path $out 'node-file-result.txt')
if ($LASTEXITCODE -ne 0) { throw 'Node file experiment failed.' }
& $node (Join-Path $PSScriptRoot 'batch-file-napi-partial-test.mjs') $addon (Join-Path $out 'controlled-partial.bin') | Tee-Object -FilePath (Join-Path $out 'partial-result.txt')
if ($LASTEXITCODE -ne 0) { throw 'Node partial file experiment failed.' }
