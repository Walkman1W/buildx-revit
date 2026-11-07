using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;

internal static class PipeFileExperiment
{
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process,uint ms);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr handle,byte[] buffer,uint length,out uint read,IntPtr overlapped);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(IntPtr file,long distance,out long position,uint method);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FileInformation information);
    [StructLayout(LayoutKind.Sequential)] struct FileInformation { public uint attributes,creationLow,creationHigh,accessLow,accessHigh,writeLow,writeHigh,volume,sizeHigh,sizeLow,links,indexHigh,indexLow; }
    const uint GenericRead=0x80000000,ShareReadDelete=5,OpenExisting=3,DuplicateSameAccess=2,WaitTimeout=0x102;
    static readonly IntPtr Invalid=new IntPtr(-1);static int checks;
    static void Check(bool ok,string message){if(!ok)throw new Exception("FAIL "+message);checks++;Console.WriteLine("PASS "+message);}
    static IntPtr Open(string path){var h=CreateFile(path,GenericRead,ShareReadDelete,IntPtr.Zero,OpenExisting,0,IntPtr.Zero);if(h==Invalid)throw new System.ComponentModel.Win32Exception();return h;}
    static bool SameFile(IntPtr a,IntPtr b){FileInformation x,y;if(!GetFileInformationByHandle(a,out x)||!GetFileInformationByHandle(b,out y))throw new System.ComponentModel.Win32Exception();return x.volume==y.volume&&x.indexHigh==y.indexHigh&&x.indexLow==y.indexLow;}
    static bool Auth(NamedPipeServerStream pipe,Process child){try{if(child==null||WaitForSingleObject(child.Handle,0)!=WaitTimeout)return false;uint p;return GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out p)&&p==GetProcessId(child.Handle)&&WaitForSingleObject(child.Handle,0)==WaitTimeout;}catch{return false;}}
    static Process Start(string mode,string name,string file){return Process.Start(new ProcessStartInfo{FileName=Process.GetCurrentProcess().MainModule.FileName,Arguments=mode+" "+name+" \""+file+"\"",UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden});}
    static void Stop(Process p){if(p==null)return;try{if(!p.HasExited){p.Kill();p.WaitForExit(5000);}}finally{p.Dispose();}}
    static void Peer(string name,string file)
    {
        IntPtr fileHandle=Open(file);
        try{using(var pipe=new NamedPipeClientStream(".",name,PipeDirection.InOut)){
            pipe.Connect(5000);var writer=new StreamWriter(pipe,Encoding.UTF8,1024,true){AutoFlush=true};var reader=new StreamReader(pipe,Encoding.UTF8,true,1024,true);
            writer.WriteLine(fileHandle.ToInt64().ToString("X"));if(reader.ReadLine()!="position")throw new Exception("bad command");
            long position;if(!SetFilePointerEx(fileHandle,0,out position,1))throw new System.ComponentModel.Win32Exception();writer.WriteLine(position);reader.ReadLine();
        }}finally{CloseHandle(fileHandle);}
    }
    static void Main(string[] args)
    {
        if(args.Length==3&&args[0]=="idle"){System.Threading.Thread.Sleep(10000);return;}
        if(args.Length==3&&args[0]=="peer"){Peer(args[1],args[2]);return;}
        if(args.Length!=1)throw new ArgumentException("Expected isolated evidence directory");
        string file=Path.Combine(Path.GetFullPath(args[0]),"controlled-request.bin"), displaced=file+".original";
        byte[] payload=Encoding.UTF8.GetBytes("identical controlled request");File.WriteAllBytes(file,payload);
        string name="buildx-file-pipe-"+Guid.NewGuid().ToString("N");Process child=null,other=null;IntPtr copy=IntPtr.Zero;
        using(var pipe=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous))try{
            child=Start("peer",name,file);var pending=pipe.BeginWaitForConnection(null,null);if(!pending.AsyncWaitHandle.WaitOne(5000))throw new Exception("connect timeout");pipe.EndWaitForConnection(pending);
            var reader=new StreamReader(pipe,Encoding.UTF8,true,1024,true);
            long remote=Convert.ToInt64(reader.ReadLine(),16);var writer=new StreamWriter(pipe,new UTF8Encoding(false),1024,true){AutoFlush=true};
            other=Start("idle",name,file);Check(!Auth(pipe,other),"other process rejected before duplication");Stop(other);other=null;
            Check(Auth(pipe,child),"file peer authenticated by kernel PID and retained process");
            if(!DuplicateHandle(child.Handle,new IntPtr(remote),GetCurrentProcess(),out copy,0,false,DuplicateSameAccess))throw new System.ComponentModel.Win32Exception();
            byte[] readBuffer=new byte[payload.Length];uint count;if(!ReadFile(copy,readBuffer,(uint)readBuffer.Length,out count,IntPtr.Zero))throw new System.ComponentModel.Win32Exception();
            Check(count==payload.Length&&Encoding.UTF8.GetString(readBuffer)==Encoding.UTF8.GetString(payload),"duplicated handle reads original file object");
            writer.WriteLine("position");Check(reader.ReadLine()==payload.Length.ToString(),"duplicated handles share current file pointer");
            File.Move(file,displaced);File.WriteAllBytes(file,payload);IntPtr replacement=Open(file);
            try{Check(!SameFile(copy,replacement),"same-content pathname replacement has a different file identity");long pos;if(!SetFilePointerEx(copy,0,out pos,0)||!ReadFile(copy,readBuffer,(uint)readBuffer.Length,out count,IntPtr.Zero))throw new System.ComponentModel.Win32Exception();Check(Encoding.UTF8.GetString(readBuffer)==Encoding.UTF8.GetString(payload),"duplicate remains bound to original after path replacement");}finally{CloseHandle(replacement);}
            child.Kill();child.WaitForExit(5000);Check(!Auth(pipe,child),"peer exit makes authority unknown despite retained file handle");
        }finally{if(copy!=IntPtr.Zero)CloseHandle(copy);Stop(other);Stop(child);}
        Console.WriteLine("PASS total="+checks);
    }
}
