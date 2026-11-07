param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$out=[IO.Path]::GetFullPath($EvidenceDirectory)
if (!$out.StartsWith((Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)) { throw 'Choose a new evidence directory under this worktree artifacts.' }
New-Item -ItemType Directory -Path $out | Out-Null
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$core=Join-Path $PSScriptRoot 'shared-parameter-prototype\IsolatedSharedParameterPrototype.cs'
$peer=Join-Path $PSScriptRoot 'shared-parameter-prototype\SharedParameterRevitPeer.cs'
& $csc /nologo /target:exe /codepage:65001 ("/out:$out\peers.exe") $core (Join-Path $PSScriptRoot 'shared-parameter-prototype-peers.cs')
if ($LASTEXITCODE -ne 0) { throw 'Peer compile failed.' }
& "$out\peers.exe" $out
if ($LASTEXITCODE -ne 0) { throw 'Peer test failed.' }
& $csc /nologo /target:library /codepage:65001 ("/out:$out\candidate.dll") '/reference:D:\Program Files\Autodesk\Revit 2024\RevitAPI.dll' $core $peer
if ($LASTEXITCODE -ne 0) { throw 'Revit 2024 API compile failed.' }
Write-Output 'Revit 2024 API compile passed.'
