using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Web.Script.Serialization;
using BuildX.FamilyRevit;

namespace BuildX.DiagnosticsChecks
{
    internal static class FamilyWorkflowDiagnosticsTests
    {
        private sealed class NativeFailure : Exception
        {
            internal NativeFailure(string message) : base(message) { HResult = unchecked((int)0x80131509); }
        }
        private sealed class BadMessageFailure : Exception
        { public override string Message { get { throw new InvalidOperationException("Message getter is unavailable."); } } }
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        private static int total, passed;
        private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
        private static Dictionary<string, object> Roundtrip(object value)
        { return (Dictionary<string, object>)Json.DeserializeObject(Json.Serialize(value)); }
        private static Dictionary<string, object> First(Dictionary<string, object> result)
        { return (Dictionary<string, object>)((object[])result["exception_chain"])[0]; }
        private static void Test(string name, Action action)
        {
            total++;
            try { action(); passed++; Console.WriteLine("ok " + total + " - " + name); }
            catch (Exception error) { Console.WriteLine("not ok " + total + " - " + name); Console.WriteLine("# " + error.Message); }
        }
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void DeepThrow(int depth)
        { if (depth == 0) throw new NativeFailure("Bounded native failure"); DeepThrow(depth - 1); }
        public static int Main()
        {
            Console.WriteLine("TAP version 13");
            Test("original type HRESULT and message survive without exception Data", delegate {
                var error = new NativeFailure("Original diagnostic text"); error.Data["private"] = "DATA_SENTINEL_NOT_TO_RETURN";
                var result = Roundtrip(FamilyWorkflowDiagnostics.Capture("builder.extrusion", error)); var first = First(result);
                Assert((string)first["exception_type"] == error.GetType().FullName && (int)first["hresult"] == error.HResult, "Original exception identity lost.");
                Assert((string)first["message"] == error.Message, "Original message changed.");
                Assert(!Json.Serialize(result).Contains("DATA_SENTINEL_NOT_TO_RETURN"), "Exception Data leaked.");
            });
            Test("message and stage bounds are explicit and avoid splitting a surrogate pair", delegate {
                string message = new string('x', 1023) + "\ud83d\ude00" + "tail";
                var result = Roundtrip(FamilyWorkflowDiagnostics.Capture(new string('s', 200), new Exception(message)));
                var first = First(result);
                Assert(((string)result["stage"]).Length == 96 && ((string)first["message"]).Length == 1023, "Bound not applied safely.");
                Assert((bool)first["message_truncated"], "Truncation was hidden.");
            });
            Test("inner chain is capped at three original exceptions", delegate {
                var result = Roundtrip(FamilyWorkflowDiagnostics.Capture("builder.call", new Exception("one", new Exception("two", new Exception("three", new Exception("four"))))));
                Assert(((object[])result["exception_chain"]).Length == 3 && (bool)result["inner_chain_truncated"], "Unbounded exception chain.");
            });
            Test("a failing Message getter cannot replace the operation error", delegate {
                var first = First(Roundtrip(FamilyWorkflowDiagnostics.Capture("builder.call", new BadMessageFailure())));
                Assert((bool)first["message_unavailable"] && first["message"] == null, "Diagnostic capture threw or fabricated a message.");
            });
            Test("code frames contain bounded code identity without file paths or arguments", delegate {
                Exception captured = null; try { DeepThrow(20); } catch (Exception error) { captured = error; }
                var first = First(Roundtrip(FamilyWorkflowDiagnostics.Capture("builder.call", captured)));
                object[] frames = (object[])first["code_frames"];
                Assert(frames.Length > 0 && frames.Length <= 8, "Code frames absent or unbounded.");
                foreach (Dictionary<string, object> frame in frames)
                    Assert(frame.Count == 3 && frame.ContainsKey("type") && frame.ContainsKey("method") && frame.ContainsKey("il_offset"), "Unexpected stack data returned.");
            });
            Test("native failure descriptions are bounded without native API calls", delegate {
                var result = FamilyWorkflowDiagnostics.RevitFailure("family.transaction.commit", "Error", "00000000-0000-0000-0000-000000000001", new string('m', 2000));
                Assert((string)result["source"] == "revit_failure" && ((string)result["message"]).Length == 1024 && (bool)result["message_truncated"], "Native description not bounded.");
            });
            Test("message control characters remain diagnostic data in a valid JSON roundtrip", delegate {
                string message = "line1\nline2\t\0";
                var first = First(Roundtrip(FamilyWorkflowDiagnostics.Capture("builder.call", new Exception(message))));
                Assert((string)first["message"] == message, "Original short diagnostic text was reinterpreted.");
            });
            Test("pure diagnostic checks did not load Revit assemblies", delegate {
                foreach (System.Reflection.Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
                    Assert(!assembly.GetName().Name.StartsWith("RevitAPI", StringComparison.OrdinalIgnoreCase), "Native API assembly loaded during pure checks.");
            });
            Console.WriteLine("1.." + total); Console.WriteLine("# tests " + total); Console.WriteLine("# pass " + passed); Console.WriteLine("# fail " + (total - passed));
            return total == passed ? 0 : 1;
        }
    }
}
