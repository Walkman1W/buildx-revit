param([Parameter(Mandatory=$true)][string]$EvidenceDirectory,[Parameter(Mandatory=$true)][string]$RevitDirectory)
$ErrorActionPreference='Stop';$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$out=[IO.Path]::GetFullPath($EvidenceDirectory)
if(!$out.StartsWith((Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)){throw 'Choose a new evidence directory under artifacts.'}
[IO.Directory]::CreateDirectory($out)|Out-Null;$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $csc /nologo /target:library /define:BUILDX_EXPERIMENTAL_NWC_EXPORT /langversion:5 /codepage:65001 ('/out:'+(Join-Path $out 'nwc-api.dll')) ('/reference:'+(Join-Path $RevitDirectory 'RevitAPI.dll')) ('/reference:'+(Join-Path $RevitDirectory 'RevitAPIUI.dll')) (Join-Path $root 'revit-addin/UnregisteredNwcStagePrototype.cs') (Join-Path $root 'revit-addin/UnregisteredNwcHostLease.cs') (Join-Path $root 'family-core/GuardedSingleArtifactPublisher.cs')
if($LASTEXITCODE -ne 0){throw 'NWC experimental Revit API compilation failed.'}
