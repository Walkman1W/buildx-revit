param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop';$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'));$out=[IO.Path]::GetFullPath($EvidenceDirectory)
if(!$out.StartsWith((Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)){throw 'Choose a new evidence directory under artifacts.'}
[IO.Directory]::CreateDirectory($out)|Out-Null;$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe';$exe=Join-Path $out 'peer.exe'
& $csc /nologo /target:exe /langversion:5 /codepage:65001 ('/out:'+$exe) ('/reference:'+(Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/System.Web.Extensions.dll')) (Join-Path $PSScriptRoot 'ProcessBoundReceiver.cs') (Join-Path $PSScriptRoot 'RestrictedPipe.cs') (Join-Path $PSScriptRoot 'ReceiverPeer.cs')
if($LASTEXITCODE -ne 0){throw 'Compilation failed.'}; & $exe (Join-Path $out 'files') | Tee-Object -FilePath (Join-Path $out 'result.txt');if($LASTEXITCODE -ne 0){throw 'Peer failed.'}
