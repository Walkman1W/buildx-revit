param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$out=[IO.Path]::GetFullPath($EvidenceDirectory)
$prefix=(Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar
if (!$out.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)) { throw 'Choose a new evidence directory under artifacts.' }
[IO.Directory]::CreateDirectory($out) | Out-Null
$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe';$exe=Join-Path $out 'native-review.exe'
& $csc /nologo /target:exe /langversion:5 /define:BUILDX_TESTS /codepage:65001 /main:RevitLocalCodex.NativeReviewTests ('/out:'+$exe) (Join-Path $root 'revit-addin/DeleteRollbackPreview.cs') (Join-Path $root 'revit-addin/DeleteImpactGuard.cs') (Join-Path $root 'revit-addin/DeleteNativeReviewWorkflow.cs') (Join-Path $PSScriptRoot 'delete-preview-peers.cs') (Join-Path $PSScriptRoot 'delete-native-review-peers.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native review peer compile failed.' }
& $exe | Tee-Object -FilePath (Join-Path $out 'result.txt')
if ($LASTEXITCODE -ne 0) { throw 'Native review peer checks failed.' }
