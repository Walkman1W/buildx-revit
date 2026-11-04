using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    internal static class ScriptRunner
    {
        internal static readonly string Compiler = Path.Combine(WorkbenchHost.PrivateRuntimeRoot, "script-compiler", "csc.exe");
        internal static object Execute(UIApplication uiapp, string code, string requestId, IDictionary<string, object> parameters)
        {
            if (string.IsNullOrWhiteSpace(code) || Encoding.UTF8.GetByteCount(code) > 64000) throw new InvalidOperationException("C# body must contain 1 to 64000 UTF-8 bytes.");
            if (!File.Exists(Compiler)) throw new InvalidOperationException("The private BuildX script compiler has not been provisioned; no script was executed.");
            string directory = Path.Combine(WorkbenchHost.Root, "scripts", requestId);
            Directory.CreateDirectory(directory);
            string source = Path.Combine(directory, "Script.cs");
            string dll = Path.Combine(directory, "LocalCodexScript_" + requestId.Replace("-", "") + ".dll");
            string wrapper = "using System; using System.Linq; using System.Collections.Generic; using Autodesk.Revit.DB; using Autodesk.Revit.UI;\n" +
                "public static class LocalCodexScript { public static object Run(UIApplication uiapp" + (parameters == null ? "" : ", IDictionary<string, object> parameters") + ") { var uidoc=uiapp.ActiveUIDocument; var doc=uidoc.Document; var app=uiapp.Application;\n#line 1 \"user-script.cs\"\n" + code + "\n#line default\nreturn null; } }";
            File.WriteAllText(source, wrapper, new UTF8Encoding(false));
            string framework = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
            var rsp = new List<string> { "/nologo", "/target:library", "/platform:x64", "/langversion:14", "/optimize+", "/out:\"" + dll + "\"" };
            foreach (string item in new[] { Path.Combine(framework, "System.dll"), Path.Combine(framework, "System.Core.dll"), typeof(Document).Assembly.Location, typeof(UIApplication).Assembly.Location }) rsp.Add("/reference:\"" + item + "\"");
            rsp.Add("\"" + source + "\"");
            string responseFile = Path.Combine(directory, "compile.rsp");
            File.WriteAllLines(responseFile, rsp, new UTF8Encoding(false));
            using (Process compiler = new Process { StartInfo = new ProcessStartInfo(Compiler, "/noconfig @\"" + responseFile + "\"") { WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true } })
            {
                compiler.StartInfo.EnvironmentVariables["COMPlus_gcServer"] = "0";
                compiler.StartInfo.EnvironmentVariables["COMPlus_GCHeapCount"] = "2";
                compiler.Start();
                var output = compiler.StandardOutput.ReadToEndAsync();
                var errors = compiler.StandardError.ReadToEndAsync();
                if (!compiler.WaitForExit(30000)) { compiler.Kill(); throw new InvalidOperationException("C# compilation exceeded 30 seconds; code was not executed."); }
                string log = output.GetAwaiter().GetResult() + errors.GetAwaiter().GetResult();
                File.WriteAllText(Path.Combine(directory, "compile.log"), log);
                if (compiler.ExitCode != 0) throw new InvalidOperationException("C# compilation failed: " + log.Substring(0, Math.Min(log.Length, 8000)));
            }
            var assembly = Assembly.LoadFrom(dll);
            using (Transaction transaction = new Transaction(uiapp.ActiveUIDocument.Document, "Local Codex C#"))
            {
                transaction.Start();
                try
                {
                    object value = assembly.GetType("LocalCodexScript").GetMethod("Run").Invoke(null, parameters == null ? new object[] { uiapp } : new object[] { uiapp, parameters });
                    var options = transaction.GetFailureHandlingOptions().SetFailuresPreprocessor(new RejectErrors()).SetClearAfterRollback(true);
                    transaction.SetFailureHandlingOptions(options);
                    if (transaction.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Script transaction was rolled back due to Revit errors.");
                    return value;
                }
                catch { if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack(); throw; }
            }
        }
        private sealed class RejectErrors : IFailuresPreprocessor
        {
            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                foreach (FailureMessageAccessor failure in accessor.GetFailureMessages()) if (failure.GetSeverity() == FailureSeverity.Error) return FailureProcessingResult.ProceedWithRollBack;
                return FailureProcessingResult.Continue;
            }
        }
    }
}
