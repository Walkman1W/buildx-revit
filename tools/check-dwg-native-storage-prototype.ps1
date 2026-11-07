param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop';$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$out=[IO.Path]::GetFullPath($EvidenceDirectory)
if(!$out.StartsWith((Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)){throw 'Choose a new evidence directory under artifacts.'}
[IO.Directory]::CreateDirectory($out)|Out-Null;$exe=Join-Path $out 'dwg-journal-native.exe';$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $csc /nologo /target:exe /langversion:5 /codepage:65001 ('/reference:'+(Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/System.Web.Extensions.dll')) ('/out:'+$exe) (Join-Path $root 'family-core/GuardedSingleArtifactPublisher.cs') (Join-Path $PSScriptRoot 'dwg-journal-native-prototype.cs')
if($LASTEXITCODE -ne 0){throw 'Native journal compile failed.'};$env:BUILDX_DWG_TEST_ROOT=$out;$env:BUILDX_DWG_TEST_EXE=$exe
try { node --test (Join-Path $root 'dwg-native-storage-prototype.test.mjs');if($LASTEXITCODE -ne 0){throw 'Native journal test failed.'} } finally {Remove-Item Env:BUILDX_DWG_TEST_ROOT,Env:BUILDX_DWG_TEST_EXE -ErrorAction SilentlyContinue}
