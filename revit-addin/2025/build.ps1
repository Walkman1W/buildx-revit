param(
  [Parameter(Mandatory=$true)][string]$RevitDirectory,
  [Parameter(Mandatory=$true)][string]$WebView2PackageDirectory,
  [Parameter(Mandatory=$true)][string]$DotnetPath,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
$RevitDirectory=[IO.Path]::GetFullPath($RevitDirectory)
$WebView2PackageDirectory=[IO.Path]::GetFullPath($WebView2PackageDirectory)
$DotnetPath=[IO.Path]::GetFullPath($DotnetPath)
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output directory must not already exist.' }
if (-not (Test-Path -LiteralPath (Split-Path -Parent $OutputDirectory) -PathType Container)) { throw 'Output parent must already exist.' }
$api=Join-Path $RevitDirectory 'RevitAPI.dll'; $ui=Join-Path $RevitDirectory 'RevitAPIUI.dll'
$package=Join-Path $WebView2PackageDirectory 'microsoft.web.webview2.1.0.2478.35.nupkg'
$files=@($api,$ui,$DotnetPath,$package)
foreach($f in $files) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "Missing input: $f" } }
$apiVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($api)
$uiVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($ui)
foreach ($file in @($api,$ui)) {
  $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($file)
  $signature=Get-AuthenticodeSignature -LiteralPath $file
  if ($v.FileVersion -ne '25.0.2.419' -or $v.ProductVersion -ne '20240307_1300(x64)') { throw 'Only exact Revit 2025.0.2.419 API inputs are supported for this candidate.' }
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne 'E4ECCB2795087B938D0C85DAACDCFA46E51C3076') { throw 'Expected the verified Autodesk signed API assembly.' }
}
$sdkVersion=(& $DotnetPath --version).Trim()
if ($LASTEXITCODE -ne 0 -or $sdkVersion -ne '8.0.427') { throw 'Expected .NET SDK 8.0.427.' }
if ((Get-FileHash $package -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'b1df2d7fe955a3378603735f910b126647e43033213b5cc071b8d6f0168a3b96') { throw 'Pinned WebView2 package mismatch.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($package)
$payload=@{'lib/netcoreapp3.0/Microsoft.Web.WebView2.Core.dll'='Microsoft.Web.WebView2.Core.dll';'lib/netcoreapp3.0/Microsoft.Web.WebView2.Wpf.dll'='Microsoft.Web.WebView2.Wpf.dll';'runtimes/win-x64/native/WebView2Loader.dll'='runtimes/win-x64/native/WebView2Loader.dll';'LICENSE.txt'='licenses/webview2/LICENSE.txt';'NOTICE.txt'='licenses/webview2/NOTICE.txt'}
try {
 foreach($entryName in $payload.Keys) {
  $entry=$archive.GetEntry($entryName); $source=Join-Path $WebView2PackageDirectory $entryName
  if (-not $entry -or -not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing SDK payload: $entryName" }
  $stream=$entry.Open(); $hash=[Security.Cryptography.SHA256]::Create()
  try {$expected=([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()} finally {$hash.Dispose();$stream.Dispose()}
  if ($expected -ne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()) { throw "SDK payload mismatch: $entryName" }
 }
} finally {$archive.Dispose()}
$sources=@(Get-ChildItem $PSScriptRoot -Filter '*.cs' -File; Get-ChildItem (Split-Path $PSScriptRoot) -Filter '*.cs' -File; Get-ChildItem (Join-Path $PSScriptRoot '..\..\family-core') -Filter '*.cs' -File; Get-ChildItem (Join-Path $PSScriptRoot '..\..\family-core\revit') -Filter '*.cs' -File; Get-Item (Join-Path $PSScriptRoot 'LocalCodexRevit2025.csproj')) | Sort-Object FullName
$sourceRecords=@($sources | ForEach-Object { @{path=$_.FullName;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} })
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
$env:DOTNET_CLI_HOME=Join-Path $OutputDirectory 'dotnet-home'
& $DotnetPath build (Join-Path $PSScriptRoot 'LocalCodexRevit2025.csproj') -c Release -o $OutputDirectory "-p:RevitDirectory=$RevitDirectory" "-p:WebView2PackageDirectory=$WebView2PackageDirectory" "-p:BaseIntermediateOutputPath=$OutputDirectory\obj\" 2>&1 | Tee-Object -FilePath (Join-Path $OutputDirectory 'build.log')
$exit=$LASTEXITCODE
if ($exit -ne 0) { throw "dotnet build failed: $exit" }
foreach($s in $sourceRecords) { if ((Get-FileHash -LiteralPath $s.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $s.sha256) { throw 'Source changed during build.' } }
foreach($entryName in $payload.Keys) { $dest=Join-Path $OutputDirectory $payload[$entryName]; New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null; Copy-Item -LiteralPath (Join-Path $WebView2PackageDirectory $entryName) -Destination $dest -Force }
$dll=Join-Path $OutputDirectory 'LocalCodexRevit.dll'
$record=[ordered]@{compiler_exit_code=$exit;compiler_options=@('BUILDX_NATIVE_READONLY_TEST','net8.0-windows','x64');compiled_utc=[DateTime]::UtcNow.ToString('o');output=$dll;output_sha256=(Get-FileHash $dll -Algorithm SHA256).Hash.ToLowerInvariant();revit_api_file_version=$apiVersion.FileVersion;revit_api_ui_file_version=$uiVersion.FileVersion;revit_api_product_version=$apiVersion.ProductVersion;revit_api_signature_status='Valid';revit_api_signer_thumbprint='E4ECCB2795087B938D0C85DAACDCFA46E51C3076';dotnet_sdk_version=$sdkVersion;dependencies=@($files | ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()}});webview2_sdk=@{package_id='Microsoft.Web.WebView2';version='1.0.2478.35';source='pinned package SHA256';package_sha256=(Get-FileHash $package -Algorithm SHA256).Hash.ToLowerInvariant();payload_verified_against_package=$true;runtime_bundled=$false};sources=$sourceRecords;installed=$false;real_revit_load_verified=$false}
$record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'build-record.json') -Encoding utf8
