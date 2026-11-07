param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop';$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$out=[IO.Path]::GetFullPath($EvidenceDirectory)
if(!$out.StartsWith((Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)){throw 'Choose a new evidence directory under artifacts.'}
[IO.Directory]::CreateDirectory($out)|Out-Null;$exe=Join-Path $out 'dwg-publish.exe';$framework=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319';$csc=Join-Path $framework 'csc.exe'
& $csc /nologo /target:exe /define:BUILDX_TESTS /langversion:5 /codepage:65001 ('/reference:'+(Join-Path $framework 'System.Web.Extensions.dll')) ('/out:'+$exe) (Join-Path $root 'family-core/GuardedSingleArtifactPublisher.cs') (Join-Path $root 'family-core/UnregisteredDwgPublishOwner.cs') (Join-Path $PSScriptRoot 'dwg-publish-owner-peers.cs')
if($LASTEXITCODE -ne 0){throw 'Controlled peer compilation failed.'}; & $exe (Join-Path $out 'isolated') | Tee-Object -FilePath (Join-Path $out 'result.txt');if($LASTEXITCODE -ne 0){throw 'Controlled peer execution failed.'}

$junction=Join-Path $out 'destination-junction';$target=Join-Path $out 'isolated/destination'
New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
& $exe (Join-Path $out 'isolated/stage/drawing.dwg') $junction 'verify-junction' | Tee-Object -FilePath (Join-Path $out 'junction-result.txt')
if($LASTEXITCODE -ne 0){throw 'Reparse point check failed.'}
