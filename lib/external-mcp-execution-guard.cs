// Isolated Windows executor prototype. Not a sandbox, not a production entrypoint.
// It owns the executable lock, a suspended child, and a kill-on-close job.
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class BuildxMcpExecutionGuard {
    static string stage="bootstrap";
    [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public int Size; public string Reserved, Desktop, Title; public int X,Y,XSize,YSize,XCount,YCount,Fill,Flags; public short ShowWindow,Reserved2; public IntPtr Reserved2Ptr,StdIn,StdOut,StdErr;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public int ProcessId,ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting { public long TotalUserTime,TotalKernelTime,PeriodUserTime,PeriodKernelTime; public uint PageFaults,TotalProcesses,ActiveProcesses,TerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorking,MaxWorking; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInfo info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out SafeFileHandle read,out SafeFileHandle write,ref SecurityAttributes attrs,int size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(SafeFileHandle handle,uint mask,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr processAttrs,IntPtr threadAttrs,bool inherit,uint flags,IntPtr env,string cwd,ref StartupInfoEx startup,out ProcessInfo info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returnSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateJobObject(IntPtr attrs,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(SafeFileHandle job,int kind,ref ExtendedLimits info,int length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,SafeFileHandle job,out bool result);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(SafeFileHandle job,uint exitCode);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(SafeFileHandle job,int kind,out Accounting info,int length,IntPtr returnedLength);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint exitCode);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    static string Identity(FileInfo info) {
        ulong index=((ulong)info.IndexHigh<<32)|info.IndexLow;
        long created=(((long)info.CreationHigh<<32)|info.CreationLow)-116444736000000000L;
        return info.Volume+":"+index+":"+checked(created*100);
    }
    static FileInfo Observe(SafeFileHandle handle) { FileInfo info;if(handle==null||handle.IsInvalid||!GetFileInformationByHandle(handle,out info))throw new IOException("open");return info; }
    static string Text(Dictionary<string,object> value,string key) { object raw;string result;if(!value.TryGetValue(key,out raw)||(result=raw as string)==null||result.Length==0||result.Length>32768||result.IndexOf('\0')>=0)throw new ArgumentException("input");return result; }
    static string Quote(string s) {
        if(s==null||s.IndexOf('\0')>=0)throw new ArgumentException("argument");
        var b=new StringBuilder("\"");int slash=0;
        foreach(char c in s){if(c=='\\'){slash++;continue;}if(c=='\"'){b.Append('\\',slash*2+1);b.Append(c);slash=0;continue;}b.Append('\\',slash);slash=0;b.Append(c);}
        b.Append('\\',slash*2);b.Append('"');return b.ToString();
    }
    static void HoldChain(object raw,string target,List<SafeFileHandle> owned) {
        var rows=raw as System.Collections.IList;if(rows==null||rows.Count<1||rows.Count>65)throw new ArgumentException("chain");
        string last=null;
        foreach(var row in rows){var item=row as Dictionary<string,object>;if(item==null)throw new ArgumentException("chain");string p=Text(item,"path"), expected=Text(item,"identity");
            if(!Path.IsPathRooted(p)||!String.Equals(Path.GetFullPath(p),p,StringComparison.OrdinalIgnoreCase))throw new ArgumentException("path");
            if(last!=null&&!String.Equals(Path.GetDirectoryName(p),last.TrimEnd(Path.DirectorySeparatorChar),StringComparison.OrdinalIgnoreCase)&&!String.Equals(Path.GetDirectoryName(p),last,StringComparison.OrdinalIgnoreCase))throw new ArgumentException("parent");
            var h=CreateFile(p,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);owned.Add(h);var info=Observe(h);
            if((info.Attributes&0x400)!=0||(info.Attributes&0x10)==0||Identity(info)!=expected)throw new IOException("identity");last=p;
        }
        if(!String.Equals(last.TrimEnd(Path.DirectorySeparatorChar),target.TrimEnd(Path.DirectorySeparatorChar),StringComparison.OrdinalIgnoreCase))throw new IOException("target");
    }
    static IntPtr EnvironmentBlock() {
        string system=Environment.GetEnvironmentVariable("SystemRoot");if(String.IsNullOrEmpty(system)||!Path.IsPathRooted(system))throw new IOException("system");
        return Marshal.StringToHGlobalUni("SYSTEMROOT="+system+"\0WINDIR="+system+"\0\0");
    }
    static void Pump(Stream source,Stream destination) {
        var buffer=new byte[16384];int n;
        while((n=source.Read(buffer,0,buffer.Length))>0){destination.Write(buffer,0,n);destination.Flush();}
    }
    static int Execute(Dictionary<string,object> request) {
        string command=Text(request,"command"),cwd=Text(request,"cwd"),id=Text(request,"executableIdentity"),expected=Text(request,"executableSha256");
        if(!Path.IsPathRooted(command)||!Path.IsPathRooted(cwd)||!String.Equals(Path.GetFullPath(command),command,StringComparison.OrdinalIgnoreCase)||!String.Equals(Path.GetFullPath(cwd),cwd,StringComparison.OrdinalIgnoreCase)||!String.Equals(Path.GetExtension(command),".exe",StringComparison.OrdinalIgnoreCase))throw new ArgumentException("path");
        if(expected.Length!=64||expected.Any(c=>!((c>='0'&&c<='9')||(c>='a'&&c<='f'))))throw new ArgumentException("hash");
        object rawArgs;System.Collections.IList args;if(!request.TryGetValue("args",out rawArgs)||(args=rawArgs as System.Collections.IList)==null||args.Count>32)throw new ArgumentException("args");
        var commandLine=new StringBuilder(Quote(command));foreach(var a in args){var s=a as string;if(s==null)throw new ArgumentException("arg");commandLine.Append(' ').Append(Quote(s));}
        if(commandLine.Length>30000)throw new ArgumentException("command line");
        var dirs=new List<SafeFileHandle>();SafeFileHandle target=null,stdinRead=null,stdinWrite=null,stdoutRead=null,stdoutWrite=null,err=null,job=null;IntPtr env=IntPtr.Zero,security=IntPtr.Zero,attributes=IntPtr.Zero,handleList=IntPtr.Zero,jobList=IntPtr.Zero;ProcessInfo info=new ProcessInfo();bool spawned=false,resumed=false,attributesReady=false;
        try {
            stage="directories";HoldChain(request["executableChain"],Path.GetDirectoryName(command),dirs);HoldChain(request["cwdChain"],cwd,dirs);
            stage="executable";
            target=CreateFile(command,0x80000000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);var f=Observe(target);
            if((f.Attributes&0x410)!=0||f.Links!=1||Identity(f)!=id||f.SizeHigh!=0||f.SizeLow==0||f.SizeLow>268435456)throw new IOException("executable");
            using(var input=new FileStream(target,FileAccess.Read)){
                using(var sha=SHA256.Create()){string actual=BitConverter.ToString(sha.ComputeHash(input)).Replace("-","").ToLowerInvariant();if(actual!=expected)throw new IOException("digest");}
                stage="pipes";var attrs=new SecurityAttributes{Length=Marshal.SizeOf(typeof(SecurityAttributes)),Inherit=1};
                if(!CreatePipe(out stdinRead,out stdinWrite,ref attrs,0)||!CreatePipe(out stdoutRead,out stdoutWrite,ref attrs,0)||!SetHandleInformation(stdinWrite,1,0)||!SetHandleInformation(stdoutRead,1,0))throw new IOException("pipe");
                security=Marshal.AllocHGlobal(attrs.Length);Marshal.StructureToPtr(attrs,security,false);
                err=CreateFile("NUL",0x40000000,3,security,3,0,IntPtr.Zero);if(err.IsInvalid)throw new IOException("stderr");
                // Only the exact three selected pipe handles may be inherited;
                // target stderr cannot spoof the guard's own readiness message.
                stage="job";job=CreateJobObject(IntPtr.Zero,null);if(job.IsInvalid)throw new IOException("job");var limits=new ExtendedLimits();limits.Basic.Flags=0x2000;
                if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimits))))throw new IOException("job");
                stage="attributes";IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
                if(size==IntPtr.Zero)throw new IOException("attributes");attributes=Marshal.AllocHGlobal(size);
                if(!InitializeProcThreadAttributeList(attributes,2,0,ref size))throw new IOException("attributes");attributesReady=true;
                handleList=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handleList,0,stdinRead.DangerousGetHandle());Marshal.WriteIntPtr(handleList,IntPtr.Size,stdoutWrite.DangerousGetHandle());Marshal.WriteIntPtr(handleList,IntPtr.Size*2,err.DangerousGetHandle());
                if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero))throw new IOException("handle list");
                // Windows 10+ atomically assigns the suspended child to this
                // kill-on-close job inside CreateProcess. A helper crash can
                // never strand an unassigned suspended target process.
                jobList=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobList,job.DangerousGetHandle());
                if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero))throw new IOException("job list");
                var si=new StartupInfoEx{Startup=new StartupInfo{Size=Marshal.SizeOf(typeof(StartupInfoEx)),Flags=0x100,StdIn=stdinRead.DangerousGetHandle(),StdOut=stdoutWrite.DangerousGetHandle(),StdErr=err.DangerousGetHandle()},Attributes=attributes};
                stage="spawn";env=EnvironmentBlock();
                if(!CreateProcess(command,commandLine,IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,cwd,ref si,out info))throw new IOException("spawn");spawned=true;
                stage="job_verify";bool inJob;if(!IsProcessInJob(info.Process,job,out inJob)||!inJob)throw new IOException("assign");
                stdinRead.Dispose();stdinRead=null;stdoutWrite.Dispose();stdoutWrite=null;
                if(ResumeThread(info.Thread)==0xffffffff)throw new IOException("resume");resumed=true;
                Console.Error.WriteLine("BUILDX_GUARD_STARTED");Console.Error.Flush();
                var toChild=new FileStream(stdinWrite,FileAccess.Write);stdinWrite=null;var fromChild=new FileStream(stdoutRead,FileAccess.Read);stdoutRead=null;
                Task.Run(()=>{try{Pump(Console.OpenStandardInput(),toChild);}catch{}finally{try{toChild.Dispose();}catch{}}});
                var output=Task.Run(()=>{try{Pump(fromChild,Console.OpenStandardOutput());}finally{fromChild.Dispose();}});
                if(WaitForSingleObject(info.Process,0xffffffff)!=0)throw new IOException("wait");uint result;if(!GetExitCodeProcess(info.Process,out result))throw new IOException("exit");
                // Root exit alone does not establish descendant cleanup.
                // Explicitly terminate the owned job, then confirm zero active
                // processes before issuing the closed marker.
                if(!TerminateJobObject(job,0))throw new IOException("job termination");
                bool empty=false;for(int i=0;i<100;i++){Accounting accounting;if(!QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new IOException("job accounting");if(accounting.ActiveProcesses==0){empty=true;break;}System.Threading.Thread.Sleep(50);}
                if(!empty)throw new IOException("job cleanup pending");
                if(!output.Wait(5000))throw new IOException("output pending");
                Console.Error.WriteLine("BUILDX_GUARD_CLOSED");Console.Error.Flush();
                return result==0?0:1;
            }
        } finally {
            if(spawned&&!resumed&&info.Process!=IntPtr.Zero)TerminateProcess(info.Process,1);
            if(job!=null)job.Dispose();
            if(info.Thread!=IntPtr.Zero)CloseHandle(info.Thread);if(info.Process!=IntPtr.Zero)CloseHandle(info.Process);
            if(attributesReady)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(handleList!=IntPtr.Zero)Marshal.FreeHGlobal(handleList);if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList);if(security!=IntPtr.Zero)Marshal.FreeHGlobal(security);
            if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);if(err!=null)err.Dispose();if(stdinRead!=null)stdinRead.Dispose();if(stdinWrite!=null)stdinWrite.Dispose();if(stdoutRead!=null)stdoutRead.Dispose();if(stdoutWrite!=null)stdoutWrite.Dispose();if(target!=null)target.Dispose();
            for(int i=dirs.Count-1;i>=0;i--)dirs[i].Dispose();
        }
    }
    static int Main() {
        try { string text=Environment.GetEnvironmentVariable("BUILDX_MCP_GUARD_BOOTSTRAP");Environment.SetEnvironmentVariable("BUILDX_MCP_GUARD_BOOTSTRAP",null);
            if(String.IsNullOrEmpty(text)||text.Length>65536)throw new ArgumentException("bootstrap");var json=new JavaScriptSerializer{MaxJsonLength=65536,RecursionLimit=40};var request=json.Deserialize<Dictionary<string,object>>(text);return Execute(request);
        } catch { Console.Error.WriteLine("BUILDX_GUARD_FAILED "+stage+" "+Marshal.GetLastWin32Error()); return 1; }
    }
}
