param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop';$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$out=[IO.Path]::GetFullPath($EvidenceDirectory)
if(!$out.StartsWith((Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)){throw 'Choose a new evidence directory under artifacts.'}
[IO.Directory]::CreateDirectory($out)|Out-Null;$exe=Join-Path $out 'nwc-stage-peers.exe';$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $csc /nologo /target:exe /define:BUILDX_TESTS /langversion:5 /codepage:65001 ('/out:'+$exe) (Join-Path $root 'revit-addin/UnregisteredNwcStagePrototype.cs') (Join-Path $PSScriptRoot 'nwc-stage-prototype-peers.cs')
if($LASTEXITCODE -ne 0){throw 'Peer compilation failed.'}; & $exe (Join-Path $out 'isolated') | Tee-Object -FilePath (Join-Path $out 'result.txt');if($LASTEXITCODE -ne 0){throw 'Peer execution failed.'}
