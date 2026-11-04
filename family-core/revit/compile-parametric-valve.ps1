# Compile-only check against the installed Revit 2024 API. No Revit API method,
# family document, transaction, save/load or application process is executed.
$ErrorActionPreference = 'Stop'
$valveProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$valveRunId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$valveOutput = Join-Path $valveProjectRoot ('workbench\validation\20261024-parametric-valve\compile-' + $valveRunId)
New-Item -ItemType Directory -Path $valveOutput | Out-Null
$valveSource = Join-Path $PSScriptRoot 'ParametricValveBuilder.cs'
$valveApi = 'D:\Program Files\Autodesk\Revit 2024\RevitAPI.dll'
$valveXml = 'D:\Program Files\Autodesk\Revit 2024\RevitAPI.xml'
$valveCompiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$valveLibrary = Join-Path $valveOutput 'BuildX.ParametricValve.dll'
$valveWatch = [Diagnostics.Stopwatch]::StartNew()
$valveSummary = [ordered]@{
    schemaVersion = 1; kind = 'revit_parametric_valve_compile_only'; passed = $false; runId = $valveRunId
    evidenceDirectory = $valveOutput; compiler = $valveCompiler; compilerVersion = $null
    languageVersion = '5'; platform = 'x64'; libraryPath = $valveLibrary
    apiFileVersion = $null; apiAssemblyVersion = $null; inputs = $null; inputsAfter = $null; unchanged = $false
    apiContractsPath = (Join-Path $valveOutput 'api-contracts.json'); compilation = $null; artifact = $null
    revitApiExecuted = $false; instantiated = $false; transactionExecuted = $false; familyCreated = $false
    geometryValidated = $false; connectorValidated = $false; rfaSaved = $false; projectLoaded = $false
    installed = $false; serviceControl = $false; aiInvoked = $false; testsRun = 0
    wallTimeMs = $null; cpuTimeMs = $null; peakProcessFamilyBytes = $null; tokens = $null; comparisonBaseline = $null
    measurementScope = 'This compile invocation including API XML contract extraction. No runtime or Revit tests; CPU, process-family peak, tokens, cold/warm and before/after baseline were not measured.'
    failure = $null
}
function Get-ValveFacts {
    param([string[]]$Paths)
    return @($Paths | ForEach-Object {
        $valveItem = Get-Item -LiteralPath $_
        [ordered]@{ path = $valveItem.FullName; byteLength = $valveItem.Length; sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
}
try {
    foreach ($valvePath in @($valveSource, $valveApi, $valveXml, $valveCompiler)) {
        if (-not (Test-Path -LiteralPath $valvePath -PathType Leaf)) { throw 'An existing source, API or compiler input is unavailable; nothing was installed.' }
    }
    $valveSummary.compilerVersion = (Get-Item -LiteralPath $valveCompiler).VersionInfo.FileVersion
    $valveSummary.apiFileVersion = (Get-Item -LiteralPath $valveApi).VersionInfo.FileVersion
    $valveSummary.apiAssemblyVersion = [Reflection.AssemblyName]::GetAssemblyName($valveApi).Version.ToString()
    $valveSummary.inputs = Get-ValveFacts @($valveSource, $valveApi, $valveXml, $PSCommandPath)
    $valveMembers = @(
        'M:Autodesk.Revit.Creation.FamilyItemFactory.NewExtrusion(System.Boolean,Autodesk.Revit.DB.CurveArrArray,Autodesk.Revit.DB.SketchPlane,System.Double)',
        'M:Autodesk.Revit.Creation.FamilyItemFactory.NewDiameterDimension(Autodesk.Revit.DB.View,Autodesk.Revit.DB.Reference,Autodesk.Revit.DB.XYZ)',
        'P:Autodesk.Revit.DB.Dimension.FamilyLabel',
        'M:Autodesk.Revit.DB.FamilyManager.AddParameter(System.String,Autodesk.Revit.DB.ForgeTypeId,Autodesk.Revit.DB.ForgeTypeId,System.Boolean)',
        'M:Autodesk.Revit.DB.FamilyManager.AssociateElementParameterToFamilyParameter(Autodesk.Revit.DB.Parameter,Autodesk.Revit.DB.FamilyParameter)',
        'M:Autodesk.Revit.DB.FamilyManager.SetFormula(Autodesk.Revit.DB.FamilyParameter,System.String)',
        'M:Autodesk.Revit.DB.ConnectorElement.CreatePipeConnector(Autodesk.Revit.DB.Document,Autodesk.Revit.DB.Plumbing.PipeSystemType,Autodesk.Revit.DB.Reference)',
        'M:Autodesk.Revit.DB.ConnectorElement.SetLinkedConnectorElement(Autodesk.Revit.DB.ConnectorElement)',
        'P:Autodesk.Revit.DB.ConnectorElement.CoordinateSystem',
        'P:Autodesk.Revit.DB.Family.FamilyCategory'
    )
    $valveMatched = @{}
    $valveReader = [Xml.XmlReader]::Create($valveXml)
    try {
        while ($valveReader.Read()) {
            if ($valveReader.NodeType -eq [Xml.XmlNodeType]::Element -and $valveReader.Name -eq 'member') {
                $valveName = $valveReader.GetAttribute('name')
                if ($valveMembers -ccontains $valveName) {
                    if ($valveMatched.ContainsKey($valveName)) { throw 'An API member contract is ambiguous.' }
                    $valveMatched[$valveName] = $true
                }
            }
        }
    } finally { $valveReader.Dispose() }
    $valveContracts = @($valveMembers | ForEach-Object { [ordered]@{ member = $_; exactlyOneDefinition = $valveMatched.ContainsKey($_) } })
    $valveContracts | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $valveSummary.apiContractsPath -Encoding utf8
    if ($valveMatched.Count -ne $valveMembers.Count) { throw 'A required API contract was not found in the installed XML.' }
    $valveArguments = @('/nologo', '/noconfig', '/langversion:5', '/platform:x64', '/target:library', '/warn:4', ('/reference:' + $valveApi), ('/out:' + $valveLibrary), $valveSource)
    $valveCompileWatch = [Diagnostics.Stopwatch]::StartNew()
    & $valveCompiler @valveArguments *> (Join-Path $valveOutput 'compile.txt')
    $valveExit = $LASTEXITCODE
    $valveCompileWatch.Stop()
    $valveSummary.compilation = [ordered]@{ arguments = $valveArguments; exitCode = $valveExit; wallTimeMs = $valveCompileWatch.Elapsed.TotalMilliseconds; outputPath = (Join-Path $valveOutput 'compile.txt') }
    if ($valveExit -ne 0) { throw 'Parametric valve module compilation failed.' }
    $valveSummary.inputsAfter = Get-ValveFacts @($valveSource, $valveApi, $valveXml, $PSCommandPath)
    $valveSummary.unchanged = $true
    for ($valveIndex = 0; $valveIndex -lt $valveSummary.inputs.Count; $valveIndex++) {
        if ($valveSummary.inputs[$valveIndex].sha256 -ne $valveSummary.inputsAfter[$valveIndex].sha256) { $valveSummary.unchanged = $false }
    }
    $valveSummary.artifact = @(Get-ValveFacts @($valveLibrary))[0]
    $valveSummary.passed = $valveSummary.unchanged
    if (-not $valveSummary.passed) { throw 'A compilation input changed during this run.' }
} catch { $valveSummary.failure = $_.Exception.Message }
finally {
    $valveWatch.Stop(); $valveSummary.wallTimeMs = $valveWatch.Elapsed.TotalMilliseconds
    $valveSummary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $valveOutput 'summary.json') -Encoding utf8
}
$valveSummary | ConvertTo-Json -Depth 12
if (-not $valveSummary.passed) { throw ('Compile evidence retained at ' + $valveOutput) }
