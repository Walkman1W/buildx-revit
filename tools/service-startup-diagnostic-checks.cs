using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace RevitLocalCodex
{
    internal static class ServiceDiagnosticChecks
    {
        private const string Valid = "{\"service\":\"revit-local-codex\",\"error_code\":\"CHAT_STORE_LOCKED\"}";
        private static string executable;

        private static ServiceStartupProcess Child(string mode)
        {
            return ServiceStartupProcess.Start(new ProcessStartInfo {
                FileName = executable, Arguments = "--child " + mode,
                UseShellExecute = false, CreateNoWindow = true
            });
        }

        private static async Task WaitExited(ServiceStartupProcess child)
        {
            for (int i = 0; i < 100; i++)
            {
                if (child.HasExited) return;
                await Task.Delay(50);
            }
            throw new Exception("Child did not exit within bounded test time");
        }

        private static async Task Check(string mode, bool expected)
        {
            using (ServiceStartupProcess child = Child(mode))
            {
                await WaitExited(child);
                if ((await child.HasChatStoreLockFailureAsync()) != expected)
                    throw new Exception("Unexpected classification: " + mode);
            }
            Console.WriteLine("PASS " + mode);
        }

        private static async Task Run()
        {
            foreach (string mode in new[] { "valid", "eof", "long-followed", "crlf" }) await Check(mode, true);
            foreach (string mode in new[] { "success", "wrong-service", "wrong-code", "malformed", "long-only", "ordinary" }) await Check(mode, false);
            using (ServiceStartupProcess child = Child("delayed"))
            {
                await Task.Delay(200);
                if (await child.HasChatStoreLockFailureAsync()) throw new Exception("Live process classified as exited");
                await WaitExited(child);
                if (!await child.HasChatStoreLockFailureAsync()) throw new Exception("Exited process did not retain its own diagnostic");
            }
            Console.WriteLine("PASS delayed-exit");
            using (ServiceStartupProcess first = Child("valid"))
            using (ServiceStartupProcess second = Child("ordinary"))
            {
                await WaitExited(first); await WaitExited(second);
                if (!await first.HasChatStoreLockFailureAsync() || await second.HasChatStoreLockFailureAsync())
                    throw new Exception("Diagnostic leaked between process owners");
            }
            Console.WriteLine("PASS separate-process-ownership");
            using (ServiceStartupProcess child = Child("inherited-eof"))
            {
                await WaitExited(child);
                var watch = Stopwatch.StartNew();
                if (await child.HasChatStoreLockFailureAsync()) throw new Exception("Incomplete stream was classified");
                if (watch.ElapsedMilliseconds > 2200) throw new Exception("Incomplete stream exceeded bounded wait");
            }
            Console.WriteLine("PASS inherited-pipe-timeout");
        }

        private static int ChildMain(string mode)
        {
            if (mode == "valid") Console.Error.WriteLine(Valid);
            else if (mode == "eof") Console.Error.Write(Valid);
            else if (mode == "crlf") Console.Error.Write(Valid + "\r\n");
            else if (mode == "long-followed") { Console.Error.WriteLine(new string('x', 50000)); Console.Error.WriteLine(Valid); }
            else if (mode == "long-only") Console.Error.WriteLine(new string('x', 50000) + Valid);
            else if (mode == "wrong-service") Console.Error.WriteLine(Valid.Replace("revit-local-codex", "other"));
            else if (mode == "wrong-code") Console.Error.WriteLine(Valid.Replace("CHAT_STORE_LOCKED", "OTHER"));
            else if (mode == "malformed") Console.Error.WriteLine("{this is not json}");
            else if (mode == "success") { Console.Error.WriteLine(Valid); return 0; }
            else if (mode == "delayed") { Console.Error.WriteLine(Valid); Console.Error.Flush(); Thread.Sleep(1400); }
            else if (mode == "inherited-eof")
            {
                Console.Error.WriteLine(Valid); Console.Error.Flush();
                Process.Start(new ProcessStartInfo { FileName = System.Reflection.Assembly.GetExecutingAssembly().Location,
                    Arguments = "--child hold-open", UseShellExecute = false, CreateNoWindow = true }).Dispose();
            }
            else if (mode == "hold-open") Thread.Sleep(2500);
            else Console.Error.WriteLine("ordinary error");
            Console.Error.Flush();
            return 1;
        }

        private static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "--child") return ChildMain(args[1]);
            executable = System.Reflection.Assembly.GetExecutingAssembly().Location;
            try { Run().GetAwaiter().GetResult(); return 0; }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        }
    }
}
