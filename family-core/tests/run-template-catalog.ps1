# Compiles and checks only the fixed-ID template byte source with local fixtures.
# It never starts Revit or opens an Autodesk template. Each invocation retains
# separate evidence and uses an independently owned temporary fixture directory.
$ErrorActionPreference = 'Stop'
$taskProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskRunId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$taskRunRoot = Join-Path $taskProjectRoot ('workbench\validation\20261023-family-planning\catalog-' + $taskRunId)
New-Item -ItemType Directory -Path $taskRunRoot | Out-Null
$taskFixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('BuildX-family-template-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($taskFixtureRoot) | Out-Null
$taskSources = @(
    (Join-Path $taskProjectRoot 'family-core\FamilyTemplateFacts.cs'),
    (Join-Path $taskProjectRoot 'family-core\FamilyTemplateCatalog.cs'),
    (Join-Path $PSScriptRoot 'FamilyTemplateCatalogTests.cs'),
    $PSCommandPath
)
$taskCompiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$taskLibrary = Join-Path $taskRunRoot 'BuildX.FamilyTemplateCatalog.dll'
$taskConsole = Join-Path $taskRunRoot 'BuildX.FamilyTemplateCatalog.Tests.exe'
$taskTap = Join-Path $taskRunRoot 'tests.tap'
$taskWatch = [Diagnostics.Stopwatch]::StartNew()
$taskSummary = [ordered]@{
    schemaVersion = 1; kind = 'offline_fixed_template_catalog'; runId = $taskRunId; passed = $false
    evidenceDirectory = $taskRunRoot; fixtureRoot = $taskFixtureRoot; compiler = $taskCompiler; compilerVersion = $null
    languageVersion = '5'; libraryPath = $taskLibrary; consolePath = $taskConsole; tapPath = $taskTap
    inputs = $null; inputsAfter = $null; sourceUnchanged = $false; artifacts = $null
    links = @(); fixtureCleanup = $null; libraryCompilation = $null; testCompilation = $null; execution = $null; tests = $null
    wallTimeMs = $null; cpuTimeMs = $null; peakProcessFamilyBytes = $null; tokens = $null; comparisonBaseline = $null
    measurementScope = 'One invocation: fixture setup, existing csc library and console compile, console checks and exact fixture cleanup. Wall only; CPU, process-family peak, tokens, cold/warm and before/after baseline were not measured.'
    changedDuringReadReproduced = $false; templateFormatValidated = $false; revitReferenced = $false
    revitStarted = $false; vendorTemplateRead = $false; modelChanged = $false; serviceControl = $false; aiInvoked = $false; failure = $null
}
function Get-TaskFileFacts {
    param([string[]]$Paths)
    return @($Paths | ForEach-Object {
        $taskItem = Get-Item -LiteralPath $_
        [ordered]@{ path = $taskItem.FullName; byteLength = $taskItem.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant() }
    })
}
function Invoke-TaskNative {
    param([string]$Executable, [string[]]$Arguments, [string]$OutputPath)
    $taskNativeWatch = [Diagnostics.Stopwatch]::StartNew()
    $taskExit = $null
    try { & $Executable @Arguments *> $OutputPath; $taskExit = $LASTEXITCODE }
    catch { $taskExit = if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { -1 } }
    $taskNativeWatch.Stop()
    return [ordered]@{ executable = $Executable; arguments = $Arguments; exitCode = $taskExit; wallTimeMs = $taskNativeWatch.Elapsed.TotalMilliseconds; outputPath = $OutputPath }
}
function New-TaskLink {
    param([string]$Name, [string]$ItemType, [string]$Target)
    $taskPath = Join-Path $taskFixtureRoot $Name
    try {
        New-Item -ItemType $ItemType -Path $taskPath -Target $Target -ErrorAction Stop | Out-Null
        return [ordered]@{ name = $Name; type = $ItemType; path = $taskPath; status = 'available'; failureType = $null }
    }
    catch { return [ordered]@{ name = $Name; type = $ItemType; path = $taskPath; status = ('fixture_creation_blocked_' + $_.Exception.GetType().Name); failureType = $_.Exception.GetType().Name } }
}
try {
    if (-not (Test-Path -LiteralPath $taskCompiler -PathType Leaf)) { throw 'Existing Framework compiler is unavailable; nothing was installed.' }
    $taskSummary.compilerVersion = (Get-Item -LiteralPath $taskCompiler).VersionInfo.FileVersion
    $taskSummary.inputs = Get-TaskFileFacts $taskSources
    $taskLinkTarget = Join-Path $taskFixtureRoot 'linked-target.rft'
    [IO.File]::WriteAllText($taskLinkTarget, 'fixed-link-fixture', [Text.UTF8Encoding]::new($false))
    $taskRealDir = Join-Path $taskFixtureRoot 'real-dir'
    [IO.Directory]::CreateDirectory($taskRealDir) | Out-Null
    [IO.File]::WriteAllText((Join-Path $taskRealDir 'inside.rft'), 'junction-target', [Text.UTF8Encoding]::new($false))
    $taskSummary.links = @(
        (New-TaskLink -Name 'symlink.rft' -ItemType SymbolicLink -Target $taskLinkTarget),
        (New-TaskLink -Name 'junction' -ItemType Junction -Target $taskRealDir),
        (New-TaskLink -Name 'hardlink.rft' -ItemType HardLink -Target $taskLinkTarget)
    )
    $taskSummary.libraryCompilation = Invoke-TaskNative $taskCompiler @('/nologo', '/noconfig', '/langversion:5', '/target:library', '/warn:4', ('/out:' + $taskLibrary), $taskSources[0], $taskSources[1]) (Join-Path $taskRunRoot 'compile-library.txt')
    if ($taskSummary.libraryCompilation.exitCode -ne 0) { throw 'Template catalog library compilation failed.' }
    $taskSummary.testCompilation = Invoke-TaskNative $taskCompiler @('/nologo', '/noconfig', '/langversion:5', '/target:exe', '/warn:4', ('/reference:' + $taskLibrary), ('/out:' + $taskConsole), $taskSources[2]) (Join-Path $taskRunRoot 'compile-tests.txt')
    if ($taskSummary.testCompilation.exitCode -ne 0) { throw 'Template catalog acceptance console compilation failed.' }
    $taskSummary.execution = Invoke-TaskNative $taskConsole @($taskFixtureRoot, $taskSummary.links[0].status, $taskSummary.links[1].status, $taskSummary.links[2].status, $taskSources[1]) $taskTap
    $taskText = Get-Content -LiteralPath $taskTap -Raw
    $taskCounts = [ordered]@{}
    foreach ($taskCount in @('tests', 'pass', 'fail', 'skip')) {
        $taskMatch = [regex]::Match($taskText, ('(?m)^# ' + $taskCount + ' (\d+)\s*$'))
        if (-not $taskMatch.Success) { throw 'Acceptance console did not emit a complete TAP summary.' }
        $taskCounts[$taskCount] = [int]$taskMatch.Groups[1].Value
    }
    $taskSummary.tests = [ordered]@{ total = $taskCounts.tests; passed = $taskCounts.pass; failed = $taskCounts.fail; skipped = $taskCounts.skip }
    $taskSummary.inputsAfter = Get-TaskFileFacts $taskSources
    $taskSummary.sourceUnchanged = $true
    for ($taskIndex = 0; $taskIndex -lt $taskSources.Count; $taskIndex++) {
        if ($taskSummary.inputs[$taskIndex].sha256 -ne $taskSummary.inputsAfter[$taskIndex].sha256) { $taskSummary.sourceUnchanged = $false }
    }
    $taskSummary.passed = ($taskSummary.execution.exitCode -eq 0 -and $taskCounts.fail -eq 0 -and $taskCounts.pass -gt 0 -and ($taskCounts.pass + $taskCounts.skip) -eq $taskCounts.tests -and $taskSummary.sourceUnchanged)
    if (-not $taskSummary.passed) { throw 'Template catalog acceptance failed or the compiled inputs changed.' }
}
catch {
    $taskSummary.failure = $_.Exception.Message
    if (-not (Test-Path -LiteralPath $taskTap)) { Set-Content -LiteralPath $taskTap -Encoding utf8 -Value "TAP version 13`nBail out! Setup or compilation failed; retained compiler logs have details." }
}
finally {
    $taskCleanupErrors = @()
    # Remove only explicitly owned fixture entries. Never recursively traverse a
    # junction or symlink, and never delete anything outside this new temp root.
    foreach ($taskLink in @('symlink.rft', 'hardlink.rft')) {
        try { [IO.File]::Delete((Join-Path $taskFixtureRoot $taskLink)) } catch { $taskCleanupErrors += $_.Exception.GetType().Name }
    }
    try {
        $taskJunction = Join-Path $taskFixtureRoot 'junction'
        if ([IO.Directory]::Exists($taskJunction)) { [IO.Directory]::Delete($taskJunction, $false) }
    } catch { $taskCleanupErrors += $_.Exception.GetType().Name }
    foreach ($taskLeaf in @('regular.rft', 'empty.rft', 'linked-target.rft', 'real-dir\inside.rft')) {
        try { [IO.File]::Delete((Join-Path $taskFixtureRoot $taskLeaf)) } catch { $taskCleanupErrors += $_.Exception.GetType().Name }
    }
    foreach ($taskDir in @('directory.rft', 'real-dir')) {
        try { $taskDirPath = Join-Path $taskFixtureRoot $taskDir; if ([IO.Directory]::Exists($taskDirPath)) { [IO.Directory]::Delete($taskDirPath, $false) } } catch { $taskCleanupErrors += $_.Exception.GetType().Name }
    }
    try { [IO.Directory]::Delete($taskFixtureRoot, $false) } catch { $taskCleanupErrors += $_.Exception.GetType().Name }
    $taskSummary.fixtureCleanup = [ordered]@{ removed = (-not [IO.Directory]::Exists($taskFixtureRoot)); errors = $taskCleanupErrors; root = $taskFixtureRoot }
    if ($taskCleanupErrors.Count -gt 0) { $taskSummary.passed = $false; if ($null -eq $taskSummary.failure) { $taskSummary.failure = 'Exact fixture cleanup failed; retained owned paths require inspection.' } }
    $taskWatch.Stop(); $taskSummary.wallTimeMs = $taskWatch.Elapsed.TotalMilliseconds
    $taskSummary.artifacts = Get-TaskFileFacts @(@($taskLibrary, $taskConsole, $taskTap) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    $taskSummary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $taskRunRoot 'summary.json') -Encoding utf8
}
$taskSummary | ConvertTo-Json -Depth 12
if (-not $taskSummary.passed) { throw ('Template catalog validation failed; evidence retained at ' + $taskRunRoot) }
