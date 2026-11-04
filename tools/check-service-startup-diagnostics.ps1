param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\workbench\validation\20261028-live064\service-startup-diagnostics'))
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Preserve existing evidence directory.' }
New-Item -ItemType Directory -Path $output | Out-Null
$panelRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $panelRoot 'revit-addin\LocalCodexRevit.cs'
$original = [IO.File]::ReadAllText($sourcePath)
$before = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
$begin = '    // BEGIN SERVICE STARTUP DIAGNOSTIC'
$end = '    // END SERVICE STARTUP DIAGNOSTIC'
$from = $original.IndexOf($begin, [StringComparison]::Ordinal)
$to = $original.IndexOf($end, [StringComparison]::Ordinal)
if ($from -lt 0 -or $to -le $from -or $original.IndexOf($begin,$from+$begin.Length,[StringComparison]::Ordinal) -ge 0) { throw 'Producer extraction markers invalid.' }
$producer = $original.Substring($from,$to-$from)
$test = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'service-startup-diagnostic-checks.cs'))
$at = $test.IndexOf('    internal static class ServiceDiagnosticChecks',[StringComparison]::Ordinal)
if ($at -lt 0) { throw 'Test insertion point missing.' }
$generated = $test.Insert($at,$producer + [Environment]::NewLine)
$file = Join-Path $output 'checks.cs'
$exe = Join-Path $output 'checks.exe'
[IO.File]::WriteAllText($file,$generated,[Text.UTF8Encoding]::new($false))
$framework = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
& (Join-Path $framework 'csc.exe') /nologo /target:exe /platform:x64 /langversion:5 /utf8output ('/out:'+$exe) ('/reference:'+(Join-Path $framework 'System.Runtime.Serialization.dll')) ('/reference:'+(Join-Path $framework 'System.Core.dll')) $file 2>&1 | Tee-Object -FilePath (Join-Path $output 'compile.log')
if ($LASTEXITCODE -ne 0) { throw 'Compilation failed.' }
if ((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash -ne $before) { throw 'Producer changed during compilation.' }
& $exe 2>&1 | Tee-Object -FilePath (Join-Path $output 'results.log')
if ($LASTEXITCODE -ne 0) { throw 'Diagnostic checks failed.' }
Write-Output ('producerSha256=' + $before)
