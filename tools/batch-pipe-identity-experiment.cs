using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;

internal static class PipeIdentityExperiment
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    private const uint WAIT_TIMEOUT = 0x102;
    private static int count;
    private static void Check(bool result, string description)
    { if (!result) throw new Exception("FAIL " + description); count++; Console.WriteLine("PASS " + description); }
    private static Process Start(string node, string peer, string mode, string pipe)
    {
        var start = new ProcessStartInfo { FileName = node, Arguments = "\"" + peer + "\" " + mode + " " + pipe,
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
        return Process.Start(start);
    }
    private static void Stop(Process process)
    {
        if (process == null) return;
        try { if (!process.HasExited) { process.Kill(); process.WaitForExit(5000); } }
        finally { process.Dispose(); }
    }
    // A caller cannot supply expected PID: identity comes from a retained Process
    // handle originally obtained from the actual child creation call.
    private static bool Matches(NamedPipeServerStream pipe, Process child)
    {
        if (child == null) return false;
        try
        {
            IntPtr processHandle = child.Handle;
            if (WaitForSingleObject(processHandle, 0) != WAIT_TIMEOUT) return false;
            uint actual, expected = GetProcessId(processHandle);
            if (expected == 0 || !GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out actual)) return false;
            return expected == actual && WaitForSingleObject(processHandle, 0) == WAIT_TIMEOUT;
        }
        catch { return false; }
    }
    private static void Main(string[] args)
    {
        if (args.Length != 2) throw new ArgumentException("Expected node executable and controlled peer path");
        string node=args[0], peer=args[1], name="buildx-pipe-test-"+Guid.NewGuid().ToString("N");
        using (var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
        {
            Process child=null;
            try
            {
                child=Start(node,peer,"connect",name);
                var waiting=pipe.BeginWaitForConnection(null,null);
                if(!waiting.AsyncWaitHandle.WaitOne(5000))throw new Exception("Peer connection timed out");
                pipe.EndWaitForConnection(waiting);
                using (var reader=new StreamReader(pipe,System.Text.Encoding.UTF8,false,1024,true))
                    Check(reader.ReadLine()=="{\"claimedPid\":1}","peer sent an explicitly false claimed PID");
                Check(Matches(pipe,child),"kernel pipe PID matches retained launched process despite false claim");
                Check(!Matches(pipe,null),"attached service without retained process rejected");
                child.Kill();child.WaitForExit(5000);
                Check(!Matches(pipe,child),"exited retained process rejected");
            }
            finally { Stop(child); }
        }
        name="buildx-pipe-test-"+Guid.NewGuid().ToString("N");
        using (var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
        {
            Process child=null,other=null;
            try
            {
                child=Start(node,peer,"idle",name);other=Start(node,peer,"connect",name);
                var waiting=pipe.BeginWaitForConnection(null,null);
                if(!waiting.AsyncWaitHandle.WaitOne(5000))throw new Exception("Peer connection timed out");
                pipe.EndWaitForConnection(waiting);
                Check(!Matches(pipe,child),"different live process rejected");
                Check(Matches(pipe,other),"actual other process identified by kernel");
            }
            finally { Stop(other);Stop(child); }
        }
        Console.WriteLine("PASS total="+count);
    }
}
