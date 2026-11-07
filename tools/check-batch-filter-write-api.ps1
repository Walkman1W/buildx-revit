param([Parameter(Mandatory=$true)][string]$EvidenceDirectory,[string]$RevitApi='D:\Program Files\Autodesk\Revit 2024\RevitAPI.dll')
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$out=[IO.Path]::GetFullPath($EvidenceDirectory);$prefix=(Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar
if (!$out.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)) {throw 'Choose a new evidence directory under artifacts.'}
if (!(Test-Path -LiteralPath $RevitApi -PathType Leaf)) {throw 'Revit API reference missing.'}
[IO.Directory]::CreateDirectory($out)|Out-Null
$framework=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$files=@('revit-addin/BatchFilterPreview.cs','revit-addin/BatchFilterWritePhases.cs','revit-addin/BatchFilterWriteCoordinator.cs','revit-addin/BatchFilterWriteCandidate.cs','tools/batch-filter-api-compile-peers.cs') | ForEach-Object {Join-Path $root $_}
& (Join-Path $framework 'csc.exe') /nologo /target:library /langversion:5 /codepage:65001 ('/out:'+(Join-Path $out 'candidate.dll')) ('/reference:'+(Join-Path $framework 'System.Web.Extensions.dll')) ('/reference:'+$RevitApi) $files 2>&1 | Tee-Object -FilePath (Join-Path $out 'compile.log')
if ($LASTEXITCODE -ne 0) {throw 'API reference compile failed.'}
