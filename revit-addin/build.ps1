param(
    [string]$RevitDirectory,
    [Parameter(Mandatory=$true)][string]$WebView2PackageDirectory,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'bin-workbench'),
    [switch]$IsolatedBuild,
    [switch]$NativeReadonlyTest
)

$ErrorActionPreference = 'Stop'
function Resolve-RevitDirectory([string]$Selected) {
    if ($Selected) {
        $resolved = [IO.Path]::GetFullPath($Selected)
        foreach ($name in @('RevitAPI.dll','RevitAPIUI.dll')) {
            if (-not (Test-Path -LiteralPath (Join-Path $resolved $name) -PathType Leaf)) { throw 'The selected Revit 2024 API directory is incomplete.' }
        }
        return $resolved
    }
    $candidates = @(@($env:ProgramW6432,$env:ProgramFiles) | Where-Object { $_ } | ForEach-Object { Join-Path $_ 'Autodesk\Revit 2024' } | Select-Object -Unique | Where-Object {
        (Test-Path -LiteralPath (Join-Path $_ 'RevitAPI.dll') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $_ 'RevitAPIUI.dll') -PathType Leaf)
    })
    if ($candidates.Count -ne 1) { throw 'Select -RevitDirectory explicitly; no unique standard Revit 2024 API installation was found.' }
    return [IO.Path]::GetFullPath($candidates[0])
}
$RevitDirectory = Resolve-RevitDirectory $RevitDirectory
foreach ($name in @('RevitAPI.dll','RevitAPIUI.dll')) {
    if ((Get-Item -LiteralPath (Join-Path $RevitDirectory $name)).VersionInfo.FileMajorPart -ne 24) { throw 'The selected API assemblies must be from Revit 2024.' }
}
$WebView2PackageDirectory = [IO.Path]::GetFullPath($WebView2PackageDirectory)
$nuspecFile = Join-Path $WebView2PackageDirectory 'microsoft.web.webview2.nuspec'
if (-not (Test-Path -LiteralPath $nuspecFile -PathType Leaf)) { throw 'A restored official Microsoft.Web.WebView2 NuGet SDK package is required.' }
[xml]$nuspec = Get-Content -LiteralPath $nuspecFile -Raw
$metadata = $nuspec.SelectSingleNode('/*[local-name()="package"]/*[local-name()="metadata"]')
$sdkId = $metadata.SelectSingleNode('*[local-name()="id"]').InnerText
$sdkVersion = $metadata.SelectSingleNode('*[local-name()="version"]').InnerText
if ($sdkId -ne 'Microsoft.Web.WebView2' -or $sdkVersion -ne '1.0.2478.35') { throw 'This candidate pins Microsoft.Web.WebView2 SDK 1.0.2478.35.' }
$packageFile = Join-Path $WebView2PackageDirectory ('microsoft.web.webview2.'+$sdkVersion+'.nupkg')
$packageMetadataFile = Join-Path $WebView2PackageDirectory '.nupkg.metadata'
$packageMetadata = Get-Content -LiteralPath $packageMetadataFile -Raw | ConvertFrom-Json
if ($packageMetadata.source -ne 'https://api.nuget.org/v3/index.json') { throw 'The restored SDK package source is not the expected official NuGet feed.' }
$webCore = Join-Path $WebView2PackageDirectory 'lib\net45\Microsoft.Web.WebView2.Core.dll'
$webWpf = Join-Path $WebView2PackageDirectory 'lib\net45\Microsoft.Web.WebView2.Wpf.dll'
$webLoader = Join-Path $WebView2PackageDirectory 'runtimes\win-x64\native\WebView2Loader.dll'
$license = Join-Path $WebView2PackageDirectory 'LICENSE.txt'
$notice = Join-Path $WebView2PackageDirectory 'NOTICE.txt'
$outputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$wpf = Join-Path $framework 'WPF'
$inputs = @(
    (Join-Path $RevitDirectory 'RevitAPI.dll'),
    (Join-Path $RevitDirectory 'RevitAPIUI.dll'),
    $webCore,$webWpf,$webLoader,$license,$notice,$packageFile,$nuspecFile,$packageMetadataFile,
    $compiler
)
foreach ($inputPath in $inputs) {
    if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
        throw "Required existing component is missing: $inputPath"
    }
}
$packageSha256 = (Get-FileHash -LiteralPath $packageFile -Algorithm SHA256).Hash.ToLowerInvariant()
if ($packageSha256 -ne 'b1df2d7fe955a3378603735f910b126647e43033213b5cc071b8d6f0168a3b96') { throw 'The pinned official WebView2 SDK package hash does not match.' }
# Verify restored payload bytes against the pinned package before copying SDK
# files. NuGet metadata alone is not proof that an extracted file is unchanged.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($packageFile)
try {
    $payload = @{'lib/net45/Microsoft.Web.WebView2.Core.dll'=$webCore;'lib/net45/Microsoft.Web.WebView2.Wpf.dll'=$webWpf;'runtimes/win-x64/native/WebView2Loader.dll'=$webLoader;'LICENSE.txt'=$license;'NOTICE.txt'=$notice}
    foreach ($entryName in $payload.Keys) {
        $entry = $archive.GetEntry($entryName)
        if ($null -eq $entry) { throw 'The pinned SDK package does not contain a required payload.' }
        $stream = $entry.Open(); $algorithm = [Security.Cryptography.SHA256]::Create()
        try { $entryHash = ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
        finally { $algorithm.Dispose(); $stream.Dispose() }
        if ($entryHash -ne (Get-FileHash -LiteralPath $payload[$entryName] -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'A restored WebView2 SDK payload differs from the pinned package.' }
    }
} finally { $archive.Dispose() }

if (Test-Path -LiteralPath $outputDirectory) { throw 'Build output must be a new directory; existing candidates are never overwritten.' }
if (-not (Test-Path -LiteralPath (Split-Path -Parent $outputDirectory) -PathType Container)) { throw 'The build output parent directory must already exist.' }
New-Item -ItemType Directory -Path $outputDirectory -ErrorAction Stop | Out-Null
$metadataDirectory = $outputDirectory
New-Item -ItemType Directory -Path (Join-Path $outputDirectory 'runtimes\win-x64\native') -Force | Out-Null
Copy-Item -LiteralPath $webCore -Destination (Join-Path $outputDirectory 'Microsoft.Web.WebView2.Core.dll')
Copy-Item -LiteralPath $webWpf -Destination (Join-Path $outputDirectory 'Microsoft.Web.WebView2.Wpf.dll')
Copy-Item -LiteralPath $webLoader -Destination (Join-Path $outputDirectory 'runtimes\win-x64\native\WebView2Loader.dll')
New-Item -ItemType Directory -Path (Join-Path $outputDirectory 'licenses\webview2') -Force | Out-Null
Copy-Item -LiteralPath $license -Destination (Join-Path $outputDirectory 'licenses\webview2\LICENSE.txt')
Copy-Item -LiteralPath $notice -Destination (Join-Path $outputDirectory 'licenses\webview2\NOTICE.txt')

$references = @(
    (Join-Path $framework 'System.dll'),
    (Join-Path $framework 'System.Core.dll'),
    (Join-Path $framework 'System.Web.Extensions.dll'),
    (Join-Path $framework 'System.Net.Http.dll'),
    (Join-Path $framework 'System.Runtime.Serialization.dll'),
    (Join-Path $framework 'System.Xaml.dll'),
    (Join-Path $framework 'System.Drawing.dll'),
    (Join-Path $wpf 'WindowsBase.dll'),
    (Join-Path $wpf 'PresentationCore.dll'),
    (Join-Path $wpf 'PresentationFramework.dll'),
    (Join-Path $RevitDirectory 'RevitAPI.dll'),
    (Join-Path $RevitDirectory 'RevitAPIUI.dll'),
    (Join-Path $outputDirectory 'Microsoft.Web.WebView2.Core.dll'),
    (Join-Path $outputDirectory 'Microsoft.Web.WebView2.Wpf.dll')
)
$compileArguments = @(
    '/nologo', '/target:library', '/platform:x64', '/langversion:5',
    '/utf8output', '/optimize+', '/debug-',
    ('/out:' + (Join-Path $outputDirectory 'LocalCodexRevit.dll'))
)
$recordedCompilerOptions = @('/target:library','/platform:x64','/langversion:5','/optimize+','/debug-')
if ($NativeReadonlyTest) {
    if (-not $IsolatedBuild) { throw 'NativeReadonlyTest requires IsolatedBuild.' }
    $compileArguments += '/define:BUILDX_NATIVE_READONLY_TEST'
    $recordedCompilerOptions += '/define:BUILDX_NATIVE_READONLY_TEST'
}
$compileArguments += @($references | ForEach-Object { '/reference:' + $_ })
$compileArguments += '/resource:' + (Join-Path $PSScriptRoot '..\public\bim-x-logo.png') + ',RevitLocalCodex.BimXLogo'
$familyCoreDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\family-core'))
# Compile a single assembly identity; never mix the earlier standalone test DLLs.
$sourceFiles = @(
    Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' -File
    Get-ChildItem -LiteralPath $familyCoreDirectory -Filter '*.cs' -File
    Get-ChildItem -LiteralPath (Join-Path $familyCoreDirectory 'revit') -Filter '*.cs' -File
) | Sort-Object FullName
$sourceRecords = @($sourceFiles | ForEach-Object { [ordered]@{path=$_.FullName;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} })
$compileArguments += @($sourceFiles | ForEach-Object FullName)
$buildLog = Join-Path $metadataDirectory 'build.log'
[IO.File]::WriteAllText($buildLog, '')
& $compiler @compileArguments 2>&1 | Tee-Object -FilePath $buildLog -Append
$compilerExit = $LASTEXITCODE
Add-Content -LiteralPath $buildLog -Value ('csc exit code: ' + $compilerExit) -Encoding utf8
if ($compilerExit -ne 0) { throw "C# compiler exited with $compilerExit" }
foreach ($sourceRecord in $sourceRecords) {
    if ((Get-FileHash -LiteralPath $sourceRecord.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceRecord.sha256) { throw 'A source changed during compilation; candidate not confirmed. Compile again after edits finish.' }
}

$assemblyPath = Join-Path $outputDirectory 'LocalCodexRevit.dll'
$escapedAssemblyPath = [Security.SecurityElement]::Escape($assemblyPath)
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>BuildX</Name>
    <Assembly>$escapedAssemblyPath</Assembly>
    <AddInId>62680901-6718-4cbc-a115-9383f35b782c</AddInId>
    <FullClassName>RevitLocalCodex.App</FullClassName>
    <VendorId>LCLX</VendorId>
    <VendorDescription>Independent local Codex panel</VendorDescription>
  </AddIn>
</RevitAddIns>
"@
$manifest | Set-Content -LiteralPath (Join-Path $metadataDirectory 'LocalCodexRevit.addin') -Encoding utf8

$dependencyRecords = @($inputs | ForEach-Object {
    $item = Get-Item -LiteralPath $_
    [ordered]@{
        path = $item.FullName
        file_version = $item.VersionInfo.FileVersion
        sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
})
$record = [ordered]@{
    compiler_exit_code = $compilerExit
    compiler_options = $recordedCompilerOptions
    compiled_utc = [DateTime]::UtcNow.ToString('o')
    output = $assemblyPath
    output_sha256 = (Get-FileHash -LiteralPath $assemblyPath -Algorithm SHA256).Hash.ToLowerInvariant()
    dependencies = $dependencyRecords
    webview2_sdk = [ordered]@{package_id=$sdkId;version=$sdkVersion;source=$packageMetadata.source;package_sha256=$packageSha256;payload_verified_against_package=$true;runtime_bundled=$false}
    sources = $sourceRecords
    endpoint = 'http://127.0.0.1:41873/'
    navigation_policy = 'one automatic open after Revit UI readiness; existing pane preserves chat; retry only on failure'
    browser_user_data_folder = 'Resolved by the installation data layout; never copied from the build machine'
    installed = $false
    real_revit_load_verified = $false
}
$record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $metadataDirectory 'build-record.json') -Encoding utf8
$record | ConvertTo-Json -Depth 6 -Compress
