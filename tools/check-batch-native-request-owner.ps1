param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$out=[IO.Path]::GetFullPath($EvidenceDirectory)
$prefix=(Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar
if (!$out.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)) { throw 'Choose a new evidence directory under artifacts.' }
[IO.Directory]::CreateDirectory($out) | Out-Null
$node=(Get-Command node -ErrorAction Stop).Source
$nodeVersion=(& $node -p 'process.versions.node').Trim();if($nodeVersion -ne '22.17.0'){throw 'This offline test requires the installed Node 22.17.0 import library.'}
$nodeLib=Join-Path $env:LOCALAPPDATA 'node-gyp/Cache/22.17.0/x64';$sysroot=(& rustc --print sysroot).Trim();$lld=Join-Path $sysroot 'lib/rustlib/x86_64-pc-windows-msvc/bin/rust-lld.exe'
if (!(Test-Path -LiteralPath (Join-Path $nodeLib 'node.lib')) -or !(Test-Path -LiteralPath $lld)) { throw 'Offline Rust linker or node.lib unavailable.' }
& rustc --edition 2024 --crate-type cdylib -C panic=abort ('-Clinker='+$lld) -C link-arg=/nodefaultlib -C link-arg=/noentry ('-Lnative='+$nodeLib) --out-dir $out (Join-Path $PSScriptRoot 'batch-native-request-owner.rs')
if ($LASTEXITCODE -ne 0) { throw 'Offline addon build failed.' }
$addon=Join-Path $out 'candidate.node';Copy-Item -LiteralPath (Join-Path $out 'batch_native_request_owner.dll') -Destination $addon
$env:BUILDX_OWNER_FIXTURE=$out;$env:BUILDX_OWNER_ADDON=$addon
& $node --test (Join-Path $PSScriptRoot 'batch-native-request-owner.test.mjs') | Tee-Object -FilePath (Join-Path $out 'result.txt')
if($LASTEXITCODE -ne 0){throw 'Candidate owner tests failed.'}
