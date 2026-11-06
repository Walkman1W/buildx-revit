// BuildX-owned Windows terminal launcher. Compile as x64 with the .NET Framework csc.
// The service grants work-directory access to a fresh, capability-free AppContainer.
// No interpreter may run until its token and membership in the private job are checked.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class BuildXTerminalWin32
{
    private const uint CreateSuspended = 4, CreateUnicodeEnvironment = 0x400;
    private const uint ExtendedStartupInfo = 0x80000, CreateNoWindow = 0x08000000;
    private const uint KillOnJobClose = 0x2000, HandleInherit = 1, UseStdHandles = 0x100;
    private const uint LabelSecurityInformation = 0x10, SeFileObject = 1;
    private const uint TokenQuery = 8, TokenIsAppContainer = 29, TokenCapabilities = 30, TokenAppContainerSid = 31;
    private const uint WaitObject0 = 0, InterruptedExit = 1223;
    private const int BasicAccounting = 1, ExtendedLimit = 9;
    private const int CleanupMilliseconds = 8000;
    private const string Protocol = "buildx-terminal-win32/1";
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityCapabilities
    {
        public IntPtr AppContainerSid, Capabilities;
        public int CapabilityCount, Reserved;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, Stdin, Stdout, Stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr Process, Thread; public int ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInfo
    {
        public long PerProcessUserTime, PerJobUserTime;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInfo
    {
        public BasicLimitInfo Limits;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct AccountingInfo
    {
        public long TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")]
    private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern int GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EqualSid(IntPtr one, IntPtr two);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(IntPtr token, uint infoClass, IntPtr output, uint size, out uint returned);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, [MarshalAs(UnmanagedType.Bool)] out bool present,
        out IntPtr sacl, [MarshalAs(UnmanagedType.Bool)] out bool defaulted);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint SetNamedSecurityInfo(string name, uint objectType, uint information,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr pointer);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(out IntPtr reader, out IntPtr writer, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, UIntPtr attribute,
        IntPtr value, UIntPtr length, IntPtr previousValue, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags,
        IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInfo information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out AccountingInfo information, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    private sealed class Fault : Exception
    {
        public readonly string Code;
        public readonly int? NativeCode;
        public Fault(string code, int? nativeCode) : base(code) { Code = code; NativeCode = nativeCode; }
    }
    private sealed class Result
    {
        public bool Started, AppContainer, JobObject, OutputComplete, ProfileRemoved;
        public bool ExitConfirmed = true;
        public bool InterpreterStaged, RuntimeStageCleaned;
        public int? ExitCode, ActiveProcesses, NativeCode;
        public string StopReason, Code;
        public object ToWire()
        {
            return new
            {
                schemaVersion = 1, protocol = Protocol, started = Started, exitConfirmed = ExitConfirmed,
                exitCode = ExitCode, stopReason = StopReason, code = Code, nativeCode = NativeCode,
                outputComplete = OutputComplete, profileRemoved = ProfileRemoved,
                interpreterStaged = InterpreterStaged, runtimeStageCleaned = RuntimeStageCleaned,
                containment = new { appContainer = AppContainer, zeroNetworkCapabilities = AppContainer,
                    jobObject = JobObject, activeProcesses = ActiveProcesses }
            };
        }
    }

    private static Fault Last(string code) { return new Fault(code, Marshal.GetLastWin32Error()); }
    private static void Require(bool ok, string code) { if (!ok) throw Last(code); }
    private static void Close(ref IntPtr handle)
    {
        if (handle == IntPtr.Zero) return;
        CloseHandle(handle);
        handle = IntPtr.Zero;
    }
    private static bool Inside(string parent, string child)
    {
        string normalized = parent.TrimEnd(Path.DirectorySeparatorChar);
        return String.Equals(normalized, child.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) ||
            child.StartsWith(normalized + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }
    private static string LocalPath(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length > 240 || value.Length < 4 ||
            !Char.IsLetter(value[0]) || value[1] != ':' || (value[2] != '\\' && value[2] != '/') ||
            value.IndexOf(':', 2) >= 0 || value.IndexOf('\0') >= 0)
            throw new Fault("invalid_local_path", null);
        return Path.GetFullPath(value);
    }
    private static void NoReparse(DirectoryInfo folder)
    {
        for (DirectoryInfo dir = folder; dir != null; dir = dir.Parent)
            if (!dir.Exists || (dir.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new Fault("invalid_sandbox_directory", null);
    }
    private static string Quote(string value)
    {
        if (value == null || value.IndexOf('\0') >= 0) throw new Fault("invalid_argument", null);
        var builder = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') builder.Append('\\', slashes * 2 + 1);
            else builder.Append('\\', slashes);
            builder.Append(character);
            slashes = 0;
        }
        return builder.Append('\\', slashes * 2).Append('"').ToString();
    }
    private static IntPtr EnvironmentFor(string cwd, string interpreter)
    {
        string systemRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var environment = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        environment.Add("SystemRoot", systemRoot);
        environment.Add("WINDIR", systemRoot);
        environment.Add("SystemDrive", Path.GetPathRoot(systemRoot).TrimEnd('\\'));
        environment.Add("PATH", Path.GetDirectoryName(interpreter) + ";" + Path.Combine(systemRoot, "System32"));
        environment.Add("PATHEXT", ".COM;.EXE;.BAT;.CMD");
        environment.Add("HOME", cwd);
        environment.Add("USERPROFILE", cwd);
        environment.Add("APPDATA", cwd);
        environment.Add("LOCALAPPDATA", cwd);
        environment.Add("TEMP", cwd);
        environment.Add("TMP", cwd);
        environment.Add("PYTHONIOENCODING", "utf-8");
        environment.Add("PYTHONUTF8", "1");
        environment.Add("PYTHONNOUSERSITE", "1");
        environment.Add("POWERSHELL_TELEMETRY_OPTOUT", "1");
        environment.Add("DOTNET_CLI_TELEMETRY_OPTOUT", "1");
        var block = new StringBuilder();
        foreach (KeyValuePair<string, string> entry in environment)
            block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }
    private static void GrantDirectory(string path, IntPtr sid, FileSystemRights rights)
    {
        var directory = new DirectoryInfo(path);
        var sidBytes = new byte[GetLengthSid(sid)];
        Marshal.Copy(sid, sidBytes, 0, sidBytes.Length);
        var security = directory.GetAccessControl(AccessControlSections.Access);
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sidBytes, 0), rights,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        directory.SetAccessControl(security);
    }

    private static void GrantWorkDirectory(string cwd, IntPtr sid)
    {
        GrantDirectory(cwd, sid, FileSystemRights.Modify);
        // A low integrity token needs an explicit low mandatory label as well
        // as its unique SID in the DACL. This is applied only to the owned cwd.
        IntPtr descriptor;
        uint size;
        Require(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)", 1, out descriptor, out size), "work_label_create_failed");
        try
        {
            bool present, defaulted;
            IntPtr sacl;
            Require(GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted) && present && sacl != IntPtr.Zero, "work_label_parse_failed");
            uint code = SetNamedSecurityInfo(cwd, SeFileObject, LabelSecurityInformation, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
            if (code != 0) throw new Fault("work_label_set_failed", (int)code);
        }
        finally { LocalFree(descriptor); }
    }
    private sealed class CopyBudget
    {
        public long Bytes;
        public int Files;
        public void Copy(FileInfo file, string destination)
        {
            if ((file.Attributes & FileAttributes.ReparsePoint) != 0 || ++Files > 12000)
                throw new Fault("python_runtime_copy_unverified", null);
            Bytes = checked(Bytes + file.Length);
            if (Bytes > 256L * 1024L * 1024L) throw new Fault("python_runtime_copy_budget_exceeded", null);
            file.CopyTo(destination, false);
        }
    }
    private static void CopyRuntimeDirectory(DirectoryInfo source, string destination, CopyBudget budget, int depth)
    {
        if (depth > 20 || (source.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new Fault("python_runtime_copy_unverified", null);
        Directory.CreateDirectory(destination);
        foreach (FileInfo file in source.EnumerateFiles())
            budget.Copy(file, Path.Combine(destination, file.Name));
        foreach (DirectoryInfo child in source.EnumerateDirectories())
        {
            if (String.Equals(child.Name, "site-packages", StringComparison.OrdinalIgnoreCase) ||
                String.Equals(child.Name, "__pycache__", StringComparison.OrdinalIgnoreCase)) continue;
            CopyRuntimeDirectory(child, Path.Combine(destination, child.Name), budget, depth + 1);
        }
    }
    private static string StagePython(string installed, string stage, IntPtr sid)
    {
        // The installed CPython directory may grant read only to Windows users.
        // Use its base executable, runtime DLLs and standard library from our
        // private copy. The AppContainer can read/execute the copy but cannot
        // alter it or any ACL on the user's installation.
        var source = new DirectoryInfo(Path.GetDirectoryName(installed));
        NoReparse(source);
        var budget = new CopyBudget();
        foreach (FileInfo file in source.EnumerateFiles())
        {
            if (String.Equals(file.Name, "python.exe", StringComparison.OrdinalIgnoreCase) ||
                Regex.IsMatch(file.Name, @"^(python[0-9]{0,4}|vcruntime[0-9]+(?:_[0-9]+)?)\.dll$", RegexOptions.IgnoreCase) ||
                Regex.IsMatch(file.Name, @"^python[0-9]{2,4}\.zip$", RegexOptions.IgnoreCase))
                budget.Copy(file, Path.Combine(stage, file.Name));
        }
        foreach (string name in new string[] { "Lib", "DLLs" })
        {
            var folder = new DirectoryInfo(Path.Combine(source.FullName, name));
            if (folder.Exists) CopyRuntimeDirectory(folder, Path.Combine(stage, name), budget, 0);
        }
        string executable = Path.Combine(stage, "python.exe");
        if (!File.Exists(executable) || !Directory.EnumerateFiles(stage, "python*.dll").GetEnumerator().MoveNext() ||
            !(Directory.Exists(Path.Combine(stage, "Lib", "encodings")) ||
              Directory.EnumerateFiles(stage, "python*.zip").GetEnumerator().MoveNext()))
            throw new Fault("python_runtime_layout_unavailable", null);
        GrantDirectory(stage, sid, FileSystemRights.ReadAndExecute);
        return executable;
    }
    private static bool RemoveStage(string stage, string parent)
    {
        try
        {
            string absolute = Path.GetFullPath(stage);
            if (!String.Equals(Path.GetDirectoryName(absolute), parent, StringComparison.OrdinalIgnoreCase) ||
                !Regex.IsMatch(Path.GetFileName(absolute), @"^\.buildx-engine-[a-f0-9]{32}$")) return false;
            if (!Directory.Exists(absolute)) return true;
            NoReparse(new DirectoryInfo(absolute));
            Directory.Delete(absolute, true);
            return true;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
        catch (Fault) { return false; }
    }
    private static IntPtr TokenInfo(IntPtr token, uint kind)
    {
        uint size;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out size);
        if (size == 0 || size > 65536) throw Last("sandbox_token_check_failed");
        IntPtr info = Marshal.AllocHGlobal((int)size);
        if (GetTokenInformation(token, kind, info, size, out size)) return info;
        Fault error = Last("sandbox_token_check_failed");
        Marshal.FreeHGlobal(info);
        throw error;
    }
    private static void VerifySandboxToken(IntPtr process, IntPtr expectedSid)
    {
        IntPtr token;
        Require(OpenProcessToken(process, TokenQuery, out token), "sandbox_token_open_failed");
        IntPtr app = IntPtr.Zero, sid = IntPtr.Zero, capabilities = IntPtr.Zero;
        try
        {
            app = TokenInfo(token, TokenIsAppContainer);
            sid = TokenInfo(token, TokenAppContainerSid);
            capabilities = TokenInfo(token, TokenCapabilities);
            if (Marshal.ReadInt32(app) != 1 || Marshal.ReadIntPtr(sid) == IntPtr.Zero ||
                !EqualSid(Marshal.ReadIntPtr(sid), expectedSid) || Marshal.ReadInt32(capabilities) != 0)
                throw new Fault("sandbox_token_unverified", null);
        }
        finally
        {
            if (app != IntPtr.Zero) Marshal.FreeHGlobal(app);
            if (sid != IntPtr.Zero) Marshal.FreeHGlobal(sid);
            if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
            Close(ref token);
        }
    }
    private static int ActiveProcesses(IntPtr job)
    {
        AccountingInfo accounting;
        Require(QueryInformationJobObject(job, BasicAccounting, out accounting, (uint)Marshal.SizeOf(typeof(AccountingInfo)), IntPtr.Zero),
            "job_accounting_failed");
        return checked((int)accounting.ActiveProcesses);
    }
    private static Thread Pump(IntPtr pipe, Stream output, Action failed)
    {
        var thread = new Thread(delegate()
        {
            try
            {
                using (var source = new FileStream(new SafeFileHandle(pipe, true), FileAccess.Read))
                {
                    var bytes = new byte[8192];
                    int length;
                    while ((length = source.Read(bytes, 0, bytes.Length)) > 0)
                    {
                        output.Write(bytes, 0, length);
                        output.Flush();
                    }
                }
            }
            catch (IOException) { failed(); }
            catch (ObjectDisposedException) { failed(); }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }
    private static void WatchStop(ManualResetEvent stop)
    {
        var control = new Thread(delegate()
        {
            try
            {
                // The control channel is not inherited by the interpreter.
                string line = Console.In.ReadLine();
                if (line == null || String.Equals(line, "stop", StringComparison.Ordinal)) stop.Set();
            }
            catch (IOException) { stop.Set(); }
        });
        control.IsBackground = true;
        control.Start();
    }
    private static bool CancelBeforeStart(WaitHandle stop, Result result)
    {
        if (!stop.WaitOne(0)) return false;
        result.StopReason = "cancelled";
        result.Code = "cancelled_before_start";
        return true;
    }
    private static void Settle(IntPtr job, IntPtr process, int timeout, WaitHandle stop, WaitHandle streamError, Result result)
    {
        var elapsed = Stopwatch.StartNew();
        long? stopAt = null;
        for (;;)
        {
            result.ActiveProcesses = ActiveProcesses(job);
            if (result.ActiveProcesses == 0)
            {
                uint code = 0;
                Require(WaitForSingleObject(process, 1000) == WaitObject0 && GetExitCodeProcess(process, out code),
                    "interpreter_exit_unverified");
                result.ExitCode = unchecked((int)code);
                result.ExitConfirmed = true;
                return;
            }
            if (!stopAt.HasValue)
            {
                if (stop.WaitOne(0)) result.StopReason = "cancelled";
                else if (streamError.WaitOne(0)) result.StopReason = "output_disconnected";
                else if (elapsed.ElapsedMilliseconds >= timeout) result.StopReason = "timeout";
                if (result.StopReason != null)
                {
                    stopAt = elapsed.ElapsedMilliseconds;
                    Require(TerminateJobObject(job, InterruptedExit), "job_termination_failed");
                }
            }
            else if (elapsed.ElapsedMilliseconds - stopAt.Value >= CleanupMilliseconds)
                throw new Fault("job_exit_unconfirmed", null);
            Thread.Sleep(30);
        }
    }
    private static void Run(string cwd, string interpreter, string[] arguments, int timeout, Result result)
    {
        IntPtr sid = IntPtr.Zero, job = IntPtr.Zero, list = IntPtr.Zero, cap = IntPtr.Zero;
        IntPtr handles = IntPtr.Zero, environment = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, inputWrite = IntPtr.Zero, outRead = IntPtr.Zero, stdout = IntPtr.Zero;
        IntPtr errRead = IntPtr.Zero, stderr = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo();
        bool profileCreated = false, listInitialized = false, assigned = false;
        string profileName = "BuildX.Terminal." + Guid.NewGuid().ToString("N");
        string stage = null, parent = Path.GetDirectoryName(cwd);
        var stop = new ManualResetEvent(false);
        var streamError = new ManualResetEvent(false);
        Thread outPump = null, errPump = null;
        try
        {
            WatchStop(stop);
            if (CancelBeforeStart(stop, result)) return;
            int hr = CreateAppContainerProfile(profileName, "BuildX Terminal", "Isolated BuildX terminal execution", IntPtr.Zero, 0, out sid);
            if (hr < 0 || sid == IntPtr.Zero) throw new Fault("sandbox_profile_create_failed", hr);
            profileCreated = true;
            GrantWorkDirectory(cwd, sid);
            if (String.Equals(Path.GetFileName(interpreter), "python.exe", StringComparison.OrdinalIgnoreCase))
            {
                stage = Path.Combine(parent, ".buildx-engine-" + Guid.NewGuid().ToString("N"));
                if (Directory.Exists(stage) || File.Exists(stage)) throw new Fault("python_runtime_stage_exists", null);
                Directory.CreateDirectory(stage);
                interpreter = StagePython(interpreter, stage, sid);
                result.InterpreterStaged = true;
            }
            if (CancelBeforeStart(stop, result)) return;
            job = CreateJobObject(IntPtr.Zero, null);
            Require(job != IntPtr.Zero, "job_create_failed");
            var limits = new ExtendedLimitInfo();
            limits.Limits.LimitFlags = KillOnJobClose;
            Require(SetInformationJobObject(job, ExtendedLimit, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimitInfo))), "job_limit_failed");

            var inherited = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
            Require(CreatePipe(out input, out inputWrite, ref inherited, 0), "stdin_pipe_failed");
            Close(ref inputWrite); // The interpreter always sees EOF, not the control channel.
            Require(CreatePipe(out outRead, out stdout, ref inherited, 0), "stdout_pipe_failed");
            Require(CreatePipe(out errRead, out stderr, ref inherited, 0), "stderr_pipe_failed");
            Require(SetHandleInformation(outRead, HandleInherit, 0) && SetHandleInformation(errRead, HandleInherit, 0), "pipe_inheritance_failed");

            UIntPtr length = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref length);
            if (length == UIntPtr.Zero) throw Last("sandbox_attributes_size_failed");
            list = Marshal.AllocHGlobal(checked((int)length.ToUInt64()));
            Require(InitializeProcThreadAttributeList(list, 2, 0, ref length), "sandbox_attributes_create_failed");
            listInitialized = true;
            cap = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));
            Marshal.StructureToPtr(new SecurityCapabilities { AppContainerSid = sid }, cap, false);
            Require(UpdateProcThreadAttribute(list, 0, new UIntPtr(0x00020009), cap,
                new UIntPtr((uint)Marshal.SizeOf(typeof(SecurityCapabilities))), IntPtr.Zero, IntPtr.Zero), "sandbox_attribute_failed");
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, input);
            Marshal.WriteIntPtr(handles, IntPtr.Size, stdout);
            Marshal.WriteIntPtr(handles, IntPtr.Size * 2, stderr);
            Require(UpdateProcThreadAttribute(list, 0, new UIntPtr(0x00020002), handles, new UIntPtr((uint)(IntPtr.Size * 3)),
                IntPtr.Zero, IntPtr.Zero), "sandbox_handles_failed");
            environment = EnvironmentFor(cwd, interpreter);
            var command = new StringBuilder(Quote(interpreter));
            foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
            if (command.Length > 30000) throw new Fault("argument_budget_exceeded", null);
            var startup = new StartupInfoEx { Attributes = list, Startup = new StartupInfo
            {
                Size = Marshal.SizeOf(typeof(StartupInfoEx)), Flags = UseStdHandles, Stdin = input, Stdout = stdout, Stderr = stderr
            } };
            Require(CreateProcess(interpreter, command, IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfo | CreateNoWindow, environment, cwd, ref startup, out process),
                "sandbox_interpreter_start_failed");
            result.ExitConfirmed = false;
            Close(ref input);
            Close(ref stdout);
            Close(ref stderr);
            VerifySandboxToken(process.Process, sid);
            result.AppContainer = true;
            Require(AssignProcessToJobObject(job, process.Process), "job_attach_failed");
            assigned = true;
            if (ActiveProcesses(job) != 1) throw new Fault("job_attach_unverified", null);
            result.JobObject = true;

            outPump = Pump(outRead, Console.OpenStandardOutput(), delegate { streamError.Set(); });
            outRead = IntPtr.Zero;
            errPump = Pump(errRead, Console.OpenStandardError(), delegate { streamError.Set(); });
            errRead = IntPtr.Zero;
            if (CancelBeforeStart(stop, result)) return;
            if (ResumeThread(process.Thread) != 1) throw Last("sandbox_resume_failed");
            result.Started = true;
            Settle(job, process.Process, timeout, stop, streamError, result);
            result.OutputComplete = outPump.Join(3000) && errPump.Join(3000) && !streamError.WaitOne(0);
        }
        finally
        {
            if (process.Process != IntPtr.Zero && !result.ExitConfirmed)
            {
                if (assigned) TerminateJobObject(job, InterruptedExit);
                else TerminateProcess(process.Process, InterruptedExit);
                if (!result.Started && WaitForSingleObject(process.Process, 1000) == WaitObject0)
                    result.ExitConfirmed = true;
            }
            Close(ref job); // Kill-on-close remains a fallback, never proof of exit.
            Close(ref process.Thread);
            Close(ref process.Process);
            Close(ref input);
            Close(ref inputWrite);
            Close(ref outRead);
            Close(ref stdout);
            Close(ref errRead);
            Close(ref stderr);
            if (listInitialized) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (cap != IntPtr.Zero) Marshal.FreeHGlobal(cap);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (sid != IntPtr.Zero) FreeSid(sid);
            if (profileCreated && result.ExitConfirmed) result.ProfileRemoved = DeleteAppContainerProfile(profileName) >= 0;
            if (stage != null && result.ExitConfirmed) result.RuntimeStageCleaned = RemoveStage(stage, parent);
        }
    }
    private static void WriteResult(string path, Result result)
    {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        var serializer = new JavaScriptSerializer();
        byte[] payload = Utf8.GetBytes(serializer.Serialize(result.ToWire()) + "\n");
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            stream.Write(payload, 0, payload.Length);
            stream.Flush(true);
        }
        File.Move(temporary, path);
    }
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--protocol") { Console.WriteLine(Protocol); return 0; }
        if (args.Length < 5 || args.Length > 133 || Environment.OSVersion.Platform != PlatformID.Win32NT || IntPtr.Size != 8) return 2;
        var result = new Result();
        string resultFile = null;
        try
        {
            string work = LocalPath(args[0]);
            string file = LocalPath(args[2]);
            string interpreter = LocalPath(args[3]);
            int timeout;
            if (!Int32.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out timeout) || timeout < 1 || timeout > 120000)
                throw new Fault("invalid_timeout", null);
            if (Inside(work, file) || Inside(Path.GetDirectoryName(file), work) || File.Exists(file))
                throw new Fault("invalid_control_file", null);
            NoReparse(new DirectoryInfo(work));
            NoReparse(new DirectoryInfo(Path.GetDirectoryName(file)));
            resultFile = file;
            string interpreterName = Path.GetFileName(interpreter).ToLowerInvariant();
            if (interpreterName != "powershell.exe" && interpreterName != "pwsh.exe" && interpreterName != "python.exe")
                throw new Fault("invalid_interpreter", null);
            if (!File.Exists(interpreter)) throw new Fault("interpreter_missing", null);
            var interpreterArguments = new string[args.Length - 4];
            Array.Copy(args, 4, interpreterArguments, 0, interpreterArguments.Length);
            Run(work, interpreter, interpreterArguments, timeout, result);
        }
        catch (Fault error) { result.Code = error.Code; result.NativeCode = error.NativeCode; }
        catch (UnauthorizedAccessException) { result.Code = "sandbox_access_denied"; }
        catch (IOException) { result.Code = "launcher_io_failed"; }
        catch (Exception) { result.Code = "launcher_failed"; }
        if (resultFile == null) return 2;
        try { WriteResult(resultFile, result); }
        catch (Exception) { return 3; }
        return result.Code == null ? 0 : 1;
    }
}
