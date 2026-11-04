param(
    [string]$RevitDirectory = 'D:\Program Files\Autodesk\Revit 2024',
    [string]$WebView2SourceDirectory = 'C:\ProgramData\AECModelBridge\bin\2024',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'bin-workbench'),
    [switch]$IsolatedBuild
)

$ErrorActionPreference = 'Stop'
$outputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$framework = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
$wpf = Join-Path $framework 'WPF'
$inputs = @(
    (Join-Path $RevitDirectory 'RevitAPI.dll'),
    (Join-Path $RevitDirectory 'RevitAPIUI.dll'),
    (Join-Path $WebView2SourceDirectory 'Microsoft.Web.WebView2.Core.dll'),
    (Join-Path $WebView2SourceDirectory 'Microsoft.Web.WebView2.Wpf.dll'),
    (Join-Path $WebView2SourceDirectory 'runtimes\win-x64\native\WebView2Loader.dll'),
    $compiler
)
foreach ($inputPath in $inputs) {
    if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
        throw "Required existing component is missing: $inputPath"
    }
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$metadataDirectory = if ($IsolatedBuild) { $outputDirectory } else { $PSScriptRoot }
if (Test-Path -LiteralPath (Join-Path $outputDirectory 'LocalCodexRevit.dll')) {
    $backup = Join-Path $PSScriptRoot ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $outputDirectory 'LocalCodexRevit.dll') -Destination $backup
}
New-Item -ItemType Directory -Path (Join-Path $outputDirectory 'runtimes\win-x64\native') -Force | Out-Null
foreach ($name in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.Wpf.dll')) {
    Copy-Item -LiteralPath (Join-Path $WebView2SourceDirectory $name) -Destination (Join-Path $outputDirectory $name) -Force
}
Copy-Item -LiteralPath (Join-Path $WebView2SourceDirectory 'runtimes\win-x64\native\WebView2Loader.dll') `
    -Destination (Join-Path $outputDirectory 'runtimes\win-x64\native\WebView2Loader.dll') -Force

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
    '/utf8output', '/optimize+', '/debug:pdbonly',
    ('/out:' + (Join-Path $outputDirectory 'LocalCodexRevit.dll'))
)
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
    compiled_utc = [DateTime]::UtcNow.ToString('o')
    output = $assemblyPath
    output_sha256 = (Get-FileHash -LiteralPath $assemblyPath -Algorithm SHA256).Hash.ToLowerInvariant()
    dependencies = $dependencyRecords
    sources = $sourceRecords
    endpoint = 'http://127.0.0.1:41873/'
    navigation_policy = 'one automatic open after Revit UI readiness; existing pane preserves chat; retry only on failure'
    browser_user_data_folder = '%LOCALAPPDATA%\RevitLocalCodex\WebView2'
    installed = $false
    real_revit_load_verified = $false
}
$record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $metadataDirectory 'build-record.json') -Encoding utf8
$record | ConvertTo-Json -Depth 6 -Compress
