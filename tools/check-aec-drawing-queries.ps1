param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$out=[IO.Path]::GetFullPath($EvidenceDirectory)
$prefix=(Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar
if (!$out.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)) { throw 'Choose a new evidence directory under artifacts.' }
[IO.Directory]::CreateDirectory($out) | Out-Null
$exe=Join-Path $out 'drawing-peers.exe'
$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $csc /nologo /target:exe /langversion:5 /codepage:65001 ('/out:'+$exe) (Join-Path $root 'revit-addin/AecDrawingQueries.cs') (Join-Path $PSScriptRoot 'aec-drawing-query-peers.cs')
if ($LASTEXITCODE -ne 0) { throw 'Peer compile failed.' }
& $exe | Tee-Object -FilePath (Join-Path $out 'result.txt')
if ($LASTEXITCODE -ne 0) { throw 'Peer checks failed.' }
