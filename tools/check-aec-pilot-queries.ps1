param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)
$artifacts = (Join-Path $root 'artifacts') + [IO.Path]::DirectorySeparatorChar
if (-not $evidence.StartsWith($artifacts, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $evidence)) {
    throw 'Choose a new evidence directory under this source tree artifacts directory.'
}
[IO.Directory]::CreateDirectory($evidence) | Out-Null

$actions = [IO.File]::ReadAllText((Join-Path $root 'revit-addin/WorkbenchActions.cs'))
function Read-Method([string]$start, [string]$end) {
    $begin = $actions.IndexOf($start, [StringComparison]::Ordinal)
    $finish = $actions.IndexOf($end, $begin + 1, [StringComparison]::Ordinal)
    if ($begin -lt 0 -or $finish -le $begin) { throw "Missing source boundary for $start" }
    return $actions.Substring($begin, $finish - $begin).Trim()
}
$sharedPeers = [IO.File]::ReadAllText((Join-Path $root 'test-support/native-model-query-peers.cs'))
$sharedPeers = $sharedPeers.Replace('// ORIGINAL_DESCRIBE_PARAMETER', (Read-Method 'internal static object DescribeParameter(' 'private static object InternalValue('))
$sharedPeers = $sharedPeers.Replace('// ORIGINAL_INTERNAL_VALUE', (Read-Method 'private static object InternalValue(' 'private static T RequiredType<T>('))
$peerPath = Join-Path $evidence 'shared-peers.generated.cs'
[IO.File]::WriteAllText($peerPath, $sharedPeers, [Text.UTF8Encoding]::new($false))
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$program = Join-Path $evidence 'aec-pilot-queries.exe'
$sources = @(
    (Join-Path $root 'revit-addin/NativeModelQueries.cs'),
    (Join-Path $root 'revit-addin/AecPilotQueries.cs'),
    (Join-Path $PSScriptRoot 'aec-pilot-query-peers.cs'),
    $peerPath
)
& (Join-Path $framework 'csc.exe') /nologo /target:exe /platform:x64 /langversion:5 /codepage:65001 /utf8output /main:RevitLocalCodex.AecPilotPeerProgram ('/out:' + $program) ('/reference:' + (Join-Path $framework 'System.Web.Extensions.dll')) @sources 2>&1 |
    Tee-Object -FilePath (Join-Path $evidence 'compile.log')
if ($LASTEXITCODE -ne 0) { throw 'The controlled C# pilot compilation failed.' }
$results = & $program
if ($LASTEXITCODE -ne 0) { throw 'The controlled C# pilot checks failed.' }
$resultsPath = Join-Path $evidence 'results.json'
$results | Set-Content -LiteralPath $resultsPath -Encoding utf8
$validate = @'
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const [resultPath, contractPath] = process.argv.slice(1);
const {AEC_PILOT_QUERY_NAMES, assertNativeModelQueryResult} = await import(pathToFileURL(contractPath));
const {fixture_results, ...metrics} = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, ''));
for (const name of AEC_PILOT_QUERY_NAMES) {
  assertNativeModelQueryResult(name, fixture_results[name.slice(6)], name === 'revit_get_sheet_info' ? {sheet_id:'9007199254740994'} : name === 'revit_get_group_members' ? {group_id:'9007199254740993'} : {});
}
console.log(JSON.stringify({...metrics, node_contract_checks:AEC_PILOT_QUERY_NAMES.length}));
'@
& node --input-type=module -e $validate $resultsPath (Join-Path $root 'lib/native-model-queries.mjs') | Tee-Object -FilePath (Join-Path $evidence 'summary.json')
if ($LASTEXITCODE -ne 0) { throw 'The production C# DTOs did not match the BuildX contracts.' }
