param([Parameter(Mandatory=$true)][string]$EvidenceDirectory,[Parameter(Mandatory=$true)][string]$RevitDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$out=[IO.Path]::GetFullPath($EvidenceDirectory)
if(!$out.StartsWith((Join-Path $root 'artifacts')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)){throw 'Choose a new evidence directory under artifacts.'}
[IO.Directory]::CreateDirectory($out)|Out-Null
$stub=Join-Path $out 'query-signatures.cs'
@"
using System; using System.Collections.Generic;
namespace RevitLocalCodex { internal static class NativeModelQueries { internal static void Fields(Dictionary<string,object> a,params string[] x) {} internal static long ExactId(Dictionary<string,object> a,string k){throw new NotImplementedException();} internal static long ExactSignedId(Dictionary<string,object> a,string k){throw new NotImplementedException();} internal static int Page(Dictionary<string,object> a,string k,int f,int min,int max){throw new NotImplementedException();} } }
"@ | Set-Content -LiteralPath $stub -Encoding utf8
$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $csc /nologo /target:library /langversion:5 /define:BUILDX_EXPERIMENTAL_PROJECT_BINDING /codepage:65001 ('/out:'+(Join-Path $out 'binding-compile.dll')) ('/reference:'+(Join-Path $RevitDirectory 'RevitAPI.dll')) ('/reference:'+(Join-Path $RevitDirectory 'RevitAPIUI.dll')) $stub (Join-Path $root 'revit-addin/ProjectInstanceBindingPreparation.cs') (Join-Path $root 'revit-addin/ProjectInstanceBindingReadback.cs') (Join-Path $root 'revit-addin/ProjectInstanceBindingWorkflow.cs') (Join-Path $root 'revit-addin/ProjectInstanceBindingHostAdapter.cs')
if($LASTEXITCODE -ne 0){throw 'Experimental Revit API reference compilation failed.'}
