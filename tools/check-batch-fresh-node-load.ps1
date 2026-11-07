param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$out=[IO.Path]::GetFullPath($EvidenceDirectory);$prefix=(Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar
if(!$out.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)){throw 'Choose a new evidence directory under artifacts.'}
[IO.Directory]::CreateDirectory($out)|Out-Null
$node=(Get-Command node -ErrorAction Stop).Source;if((& $node -p 'process.versions.node').Trim() -ne '22.17.0'){throw 'Offline test requires Node 22.17.0.'}
$lib=Join-Path $env:LOCALAPPDATA 'node-gyp/Cache/22.17.0/x64';$sysroot=(& rustc --print sysroot).Trim();$lld=Join-Path $sysroot 'lib/rustlib/x86_64-pc-windows-msvc/bin/rust-lld.exe';if(!(Test-Path -LiteralPath (Join-Path $lib 'node.lib')) -or !(Test-Path -LiteralPath $lld)){throw 'Offline compiler prerequisites unavailable.'}
& rustc --edition 2024 --crate-type cdylib -C panic=abort ('-Clinker='+$lld) -C link-arg=/nodefaultlib -C link-arg=/noentry ('-Lnative='+$lib) --out-dir $out (Join-Path $PSScriptRoot 'batch-native-request-owner.rs')
if($LASTEXITCODE -ne 0){throw 'Offline addon build failed.'}
$framework=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319';$compiler=Join-Path $framework 'csc.exe';$exe=Join-Path $out 'fresh-node-load.exe'
& $compiler /nologo /target:exe /langversion:5 /codepage:65001 ('/out:'+$exe) ('/reference:'+(Join-Path $framework 'System.Web.Extensions.dll')) (Join-Path $PSScriptRoot 'batch-fresh-node-load-experiment.cs')
if($LASTEXITCODE -ne 0){throw 'Fresh load experiment compile failed.'}
$fixture=Join-Path $out 'fixture';[IO.Directory]::CreateDirectory($fixture)|Out-Null
& $exe $fixture $node (Join-Path $out 'batch_native_request_owner.dll') (Join-Path $PSScriptRoot 'batch-fresh-node-load-peer.mjs') | Tee-Object -FilePath (Join-Path $out 'result.txt')
if($LASTEXITCODE -ne 0){throw 'Fresh load experiment failed.'}
