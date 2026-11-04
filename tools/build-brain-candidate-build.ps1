param([Parameter(Mandatory=$true)][string]$Candidate)
$ErrorActionPreference='Stop'
$Candidate=[IO.Path]::GetFullPath($Candidate)
$node=(Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'build-brain-candidate.mjs') verify $Candidate
if ($LASTEXITCODE -ne 0) { throw 'Source snapshot verification failed.' }
$manifest=Get-Content -Raw -LiteralPath (Join-Path $Candidate 'snapshot-manifest.json') | ConvertFrom-Json
$framework='C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
$wpf=Join-Path $framework 'WPF'
$revit='D:\Program Files\Autodesk\Revit 2024'
$web='C:\ProgramData\AECModelBridge\bin\2024'
$csc=Join-Path $framework 'csc.exe'
$references=@((Join-Path $framework 'System.dll'),(Join-Path $framework 'System.Core.dll'),(Join-Path $framework 'System.Web.Extensions.dll'),(Join-Path $framework 'System.Net.Http.dll'),(Join-Path $framework 'System.Runtime.Serialization.dll'),(Join-Path $framework 'System.Xaml.dll'),(Join-Path $framework 'System.Drawing.dll'),(Join-Path $wpf 'WindowsBase.dll'),(Join-Path $wpf 'PresentationCore.dll'),(Join-Path $wpf 'PresentationFramework.dll'),(Join-Path $revit 'RevitAPI.dll'),(Join-Path $revit 'RevitAPIUI.dll'),(Join-Path $web 'Microsoft.Web.WebView2.Core.dll'),(Join-Path $web 'Microsoft.Web.WebView2.Wpf.dll'))
$inputs=@($csc)+$references
foreach($input in $inputs) { if (-not (Test-Path -LiteralPath $input -PathType Leaf)) {throw ('Missing build dependency: '+[IO.Path]::GetFileName($input))} }
$deps=@($inputs | ForEach-Object { $item=Get-Item -LiteralPath $_; [ordered]@{name=$item.Name;version=$item.VersionInfo.FileVersion;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()} })
$buildDir=Join-Path $Candidate 'build'
New-Item -ItemType Directory -Path $buildDir -ErrorAction Stop | Out-Null
$sourceRoot=Join-Path $Candidate 'source'
$sources=@($manifest.files | Where-Object { $_.path -match '^(revit-addin|family-core)/.*\.cs$' } | ForEach-Object {Join-Path $sourceRoot $_.path})
if($sources.Count -lt 1) {throw 'No approved C# sources.'}
$dll=Join-Path $buildDir 'LocalCodexRevit.dll'
$args=@('/nologo','/target:library','/platform:x64','/langversion:5','/utf8output','/optimize+','/debug:pdbonly',('/out:'+$dll))
$args+=@($references | ForEach-Object {'/reference:'+$_})
$args+=('/resource:'+(Join-Path $sourceRoot 'public/bim-x-logo.png')+',RevitLocalCodex.BimXLogo')
$args+=$sources
& $csc @args 2>&1 | Tee-Object -FilePath (Join-Path $buildDir 'compile.log')
$exit=$LASTEXITCODE
if($exit -ne 0) {throw ('Compiler failed, exit '+$exit)}
& $node (Join-Path $PSScriptRoot 'build-brain-candidate.mjs') verify $Candidate
if ($LASTEXITCODE -ne 0) {throw 'Source changed during compilation.'}
$record=[ordered]@{schemaVersion=1;kind='isolated-compile-only';installed=$false;realRevitLoadVerified=$false;compilerExit=$exit;sourceManifestSha256=(Get-FileHash -LiteralPath (Join-Path $Candidate 'snapshot-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant();dllSha256=(Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant();sourceCount=$sources.Count;dependencies=$deps}
$record | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $buildDir 'build-record.json')
$record | ConvertTo-Json -Depth 5 -Compress
