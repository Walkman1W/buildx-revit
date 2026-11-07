param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$out=[IO.Path]::GetFullPath($EvidenceDirectory)
$prefix=(Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar
if (!$out.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)) { throw 'Choose a new evidence directory under artifacts.' }
[IO.Directory]::CreateDirectory($out) | Out-Null
$s=Get-Content -Raw (Join-Path $root 'revit-addin/WorkbenchActions.cs')
$a=$s.IndexOf('        private static void SetColumnParameter(');$b=$s.IndexOf('        private sealed class BasicCreatedExpectation', $a)
if ($a -lt 0 -or $b -le $a) { throw 'Column method extraction markers missing.' }
$extracted='using System; using System.Linq; using System.Collections.Generic; using Autodesk.Revit.DB; namespace RevitLocalCodex { internal static partial class WorkbenchActions {' + "`n" + $s.Substring($a,$b-$a) + "`n}}"
$source=Join-Path $out 'extracted.cs';[IO.File]::WriteAllText($source,$extracted,[Text.UTF8Encoding]::new($false))
$exe=Join-Path $out 'column-peers.exe';$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $csc /nologo /target:exe /langversion:5 /codepage:65001 ('/out:'+$exe) $source (Join-Path $PSScriptRoot 'aec-column-write-peers.cs')
if ($LASTEXITCODE -ne 0) { throw 'Peer compile failed.' }
& $exe | Tee-Object -FilePath (Join-Path $out 'result.txt')
if ($LASTEXITCODE -ne 0) { throw 'Peer checks failed.' }
