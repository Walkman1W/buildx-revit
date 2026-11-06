param([string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$panelRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(-not $EvidenceDirectory){$EvidenceDirectory=Join-Path $panelRoot ('artifacts\native-model-query-host\managed-'+[Guid]::NewGuid().ToString('N').Substring(0,8))}
$evidence=[IO.Path]::GetFullPath($EvidenceDirectory)
if(-not $evidence.StartsWith((Join-Path $panelRoot 'workbench\validation')+'\',[StringComparison]::OrdinalIgnoreCase) -and -not $evidence.StartsWith((Join-Path $panelRoot 'artifacts')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Evidence must stay under this project artifacts or validation directory.'}
if(Test-Path -LiteralPath $evidence){throw 'Do not overwrite managed evidence.'}
[IO.Directory]::CreateDirectory($evidence)|Out-Null
$hostPath=Join-Path $panelRoot 'revit-addin\WorkbenchHost.cs'
$source=[IO.File]::ReadAllText($hostPath)
$documentSourcePath=Join-Path $panelRoot 'family-core\revit\RevitProjectDocuments.cs'
$documentSource=[IO.File]::ReadAllText($documentSourcePath)
$accessPolicyPath=Join-Path $panelRoot 'revit-addin\AccessPolicy.cs'
$actionsSourcePath=Join-Path $panelRoot 'revit-addin\WorkbenchActions.cs'
$actionsSource=[IO.File]::ReadAllText($actionsSourcePath)
function Read-Producer([string]$start,[string]$end,[string]$producer=$source){
 $begin=$producer.IndexOf($start,[StringComparison]::Ordinal);if($begin -lt 0){throw ('Missing producer '+$start)}
 $finish=$producer.IndexOf($end,$begin,[StringComparison]::Ordinal)
 if($finish -le $begin -or $producer.IndexOf($start,$begin+$start.Length,[StringComparison]::Ordinal)-ge 0){throw 'Ambiguous producer boundaries.'}
 return $producer.Substring($begin,$finish-$begin).Trim()
}
function Read-FinalProducer([string]$start,[string]$producer){
 $begin=$producer.IndexOf($start,[StringComparison]::Ordinal)
 if($begin-lt 0 -or $producer.IndexOf($start,$begin+1,[StringComparison]::Ordinal)-ge 0){throw 'Ambiguous final producer.'}
 # Final methods end before the enclosing class's four-space closing brace.
 # Method braces are eight-space; preserve the original producer source.
 $classEnd=[regex]::Match($producer.Substring($begin),'(?m)^    \}\r?$')
 if(-not $classEnd.Success){throw 'Missing final producer owner boundary.'}
 return $producer.Substring($begin,$classEnd.Index).Trim()
}
$documentIdentity=Read-FinalProducer 'public bool? SameOpenDocument(' $documentSource
$methods=[ordered]@{
 ORIGINAL_DOCUMENT_SOURCE_THREAD=(Read-Producer 'private void RequireCapturedThread()' 'public ProjectDocumentFacts Inspect(' $documentSource)
 ORIGINAL_DOCUMENT_SOURCE_IDENTITY=$documentIdentity
 ORIGINAL_ATOMIC_OPERATIONS=(Read-Producer 'private static readonly string[] AtomicReadOperations' 'internal string SessionId')
 ORIGINAL_OPERATION_CLASSIFICATION=(Read-Producer 'internal static readonly string[] ReadOperations' 'internal static object Read(' $actionsSource)
 ORIGINAL_DOCUMENT_VALIDATION=(Read-Producer 'private static void RequireDocument(' 'internal static string Text(')
 ORIGINAL_TIMING_OWNER=(Read-Producer 'private sealed class SchedulerObservation' 'internal WorkbenchHost(')
 ORIGINAL_CURRENT_WINDOW_OWNER=(Read-Producer 'private sealed class CurrentUiWindowWake' 'private sealed class SchedulerObservation')
 ORIGINAL_IDLING=(Read-Producer 'private void OnQueueIdling(' 'private Assembly ResolvePrivateDependency(')
 ORIGINAL_POLL_QUEUE=(Read-Producer 'private void PollQueue(object state)' 'private void BackOff()')
 ORIGINAL_BACK_OFF=(Read-Producer 'private void BackOff()' 'private void RecordSchedulerFailure(')
 ORIGINAL_SCHEDULER_FAILURE=(Read-Producer 'private void RecordSchedulerFailure(' 'private string NextRequest()')
 ORIGINAL_NEXT_REQUEST=(Read-Producer 'private string NextRequest()' 'public string GetName()')
 ORIGINAL_EXECUTE=(Read-Producer 'public void Execute(UIApplication uiapp)' 'private void ProcessOne(')
 ORIGINAL_PROCESS_ONE=(Read-Producer 'private void ProcessOne(' 'private static bool AtomicReadRequested(')
 ORIGINAL_ATOMIC_READ=(Read-Producer 'private static bool AtomicReadRequested(' 'private object Dispatch(')
 ORIGINAL_TEXT=(Read-Producer 'internal static string Text(' 'private void WriteAtomic(')
 ORIGINAL_WRITE_ATOMIC=(Read-Producer 'private void WriteAtomic(' 'public void Dispose()')
 ORIGINAL_DISPOSE=(Read-FinalProducer 'public void Dispose()' $source)
}
$template=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'workspace-host-checks.template.cs'))
foreach($entry in $methods.GetEnumerator()){$template=$template.Replace('// '+$entry.Key,$entry.Value)}
$generated=Join-Path $evidence 'host.generated.cs';[IO.File]::WriteAllText($generated,$template,[Text.UTF8Encoding]::new($false))
$framework='C:\Windows\Microsoft.NET\Framework64\v4.0.30319';$program=Join-Path $evidence 'host-check.exe'
& (Join-Path $framework 'csc.exe') /nologo /target:exe /platform:x64 /langversion:5 /utf8output ('/out:'+$program) ('/reference:'+(Join-Path $framework 'System.Web.Extensions.dll')) ('/reference:'+(Join-Path $framework 'System.Core.dll')) $generated $accessPolicyPath 2>&1 | Tee-Object -FilePath (Join-Path $evidence 'compile.log')
if($LASTEXITCODE-ne 0){throw 'Managed verifier compilation failed.'}
& $program (Join-Path $evidence 'receipts') | Set-Content -LiteralPath (Join-Path $evidence 'results.json') -Encoding utf8
if($LASTEXITCODE-ne 0){throw 'Managed verification failed.'}
$result=Get-Content -LiteralPath (Join-Path $evidence 'results.json') -Raw|ConvertFrom-Json
if($result.checks-ne 102 -or @($result.results|Where-Object {-not $_.passed}).Count){throw 'Managed checks are incomplete.'}
[ordered]@{source=$hostPath;sourceSha256=(Get-FileHash -LiteralPath $hostPath -Algorithm SHA256).Hash.ToLowerInvariant();documentIdentitySource=$documentSourcePath;documentIdentitySha256=(Get-FileHash -LiteralPath $documentSourcePath -Algorithm SHA256).Hash.ToLowerInvariant();accessPolicySource=$accessPolicyPath;accessPolicySha256=(Get-FileHash -LiteralPath $accessPolicyPath -Algorithm SHA256).Hash.ToLowerInvariant();operationClassificationSource=$actionsSourcePath;operationClassificationSha256=(Get-FileHash -LiteralPath $actionsSourcePath -Algorithm SHA256).Hash.ToLowerInvariant();checks=$result.checks;scope='Exact scheduler, request/access validation and native document identity owners with controlled Revit/business peers; not a real Revit run.';methods=@($methods.Keys)}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $evidence 'source-proof.json') -Encoding utf8
Write-Output ('Managed checks passed: '+$result.checks+'; evidence: '+$evidence)
