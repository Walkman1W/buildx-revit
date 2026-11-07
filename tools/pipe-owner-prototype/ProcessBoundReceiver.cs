using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
namespace BuildX.PipePrototype {
 // Internal experiment only: caller must establish first-instance/current-user/
 // local-only pipe and own a process handle returned by its own spawn. This class
 // does not establish those facts and therefore must never be registered.
 internal sealed class ProcessBoundReceiver {
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe,out uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(SafeProcessHandle process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(SafeProcessHandle process,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(SafeProcessHandle source,IntPtr handle,IntPtr target,out SafeFileHandle duplicate,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(SafeFileHandle handle);
  readonly SafeProcessHandle process; readonly uint pid; int consumed;
  internal ProcessBoundReceiver(SafeProcessHandle ownedProcess) { if(ownedProcess==null||ownedProcess.IsInvalid||ownedProcess.IsClosed)throw new ArgumentException("Owned process handle required");process=ownedProcess;pid=GetProcessId(process);if(pid==0||WaitForSingleObject(process,0)!=258)throw new InvalidOperationException("Process unavailable"); }
  internal byte[] Consume(SafePipeHandle pipe,IntPtr clientFileHandle,string requestId,string expectedSha256) {
   if(Interlocked.CompareExchange(ref consumed,1,0)!=0)throw new InvalidOperationException("Already consumed");
   Guid request; if(pipe==null||pipe.IsInvalid||pipe.IsClosed||!Guid.TryParseExact(requestId,"D",out request)||request==Guid.Empty||expectedSha256==null||expectedSha256.Length!=64)throw new InvalidOperationException("Invalid owner inputs");
   uint actual;if(WaitForSingleObject(process,0)!=258||!GetNamedPipeClientProcessId(pipe,out actual)||actual!=pid)throw new InvalidOperationException("Client identity mismatch");
   SafeFileHandle file;if(!DuplicateHandle(process,clientFileHandle,GetCurrentProcess(),out file,0,false,2))throw new InvalidOperationException("Cannot duplicate file handle");
   using(file) {if(file.IsInvalid||GetFileType(file)!=1||WaitForSingleObject(process,0)!=258)throw new InvalidOperationException("File or process unavailable");
    using(var stream=new FileStream(file,FileAccess.Read)) {if(!stream.CanSeek||stream.Length<=0||stream.Length>262144)throw new InvalidDataException("File length outside bounds");stream.Position=0;var bytes=new byte[(int)stream.Length];int offset=0;while(offset<bytes.Length){int n=stream.Read(bytes,offset,bytes.Length-offset);if(n<=0)throw new EndOfStreamException();offset+=n;}if(stream.ReadByte()!=-1||WaitForSingleObject(process,0)!=258)throw new InvalidOperationException("Unstable file or process");
     string sha;using(var hash=SHA256.Create())sha=BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();if(!String.Equals(sha,expectedSha256,StringComparison.Ordinal))throw new InvalidDataException("Digest mismatch");
     var json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=16}.DeserializeObject(new UTF8Encoding(false,true).GetString(bytes)) as System.Collections.Generic.Dictionary<string,object>;object value;if(json==null||!json.TryGetValue("request_id",out value)||!(value is string)||(string)value!=requestId)throw new InvalidDataException("Request identity mismatch");return bytes;
    }
   }
  }
 }
}
