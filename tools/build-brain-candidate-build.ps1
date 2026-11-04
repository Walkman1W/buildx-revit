param(
    [Parameter(Mandatory=$true)][string]$Candidate,
    [string]$RevitDirectory,
    [Parameter(Mandatory=$true)][string]$WebView2PackageDirectory
)
$ErrorActionPreference='Stop'
$Candidate=[IO.Path]::GetFullPath($Candidate)
$node=(Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'build-brain-candidate.mjs') verify $Candidate
if ($LASTEXITCODE -ne 0) { throw 'Source snapshot verification failed.' }
$sourceRoot=Join-Path $Candidate 'source'
$unifiedBuild=Join-Path $sourceRoot 'revit-addin\build.ps1'
if (-not (Test-Path -LiteralPath $unifiedBuild -PathType Leaf)) {
    throw 'This older review snapshot has no unified build entry. Recreate the complete source snapshot; do not compile a partial legacy whitelist.'
}
# Use the verified snapshot's one build owner. Do not retain a second compiler
# command or hard-coded SDK/Revit paths in this compatibility entry.
$arguments=@{OutputDirectory=(Join-Path $Candidate 'build');WebView2PackageDirectory=$WebView2PackageDirectory;IsolatedBuild=$true}
if ($RevitDirectory) { $arguments.RevitDirectory=$RevitDirectory }
& $unifiedBuild @arguments
if (-not $?) { throw 'Unified isolated compilation failed.' }
& $node (Join-Path $PSScriptRoot 'build-brain-candidate.mjs') verify $Candidate
if ($LASTEXITCODE -ne 0) { throw 'Source changed during compilation.' }
