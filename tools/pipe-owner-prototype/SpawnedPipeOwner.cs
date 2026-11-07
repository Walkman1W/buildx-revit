using System;using System.IO;using System.IO.Pipes;using System.Diagnostics;using System.Security.Cryptography;using System.Text;using System.Threading;
namespace BuildX.PipePrototype {
 // Experimental coordinator; executable and request file are trusted test inputs.
 // No attach operation exists. A timeout never starts another request.
 internal sealed class SpawnedPipeOwner {
  readonly string requestId; readonly Process child; readonly NamedPipeServerStream pipe; readonly FileStream original; readonly ProcessBoundReceiver receiver; readonly string identity,digest; readonly ManualResetEvent done=new ManualResetEvent(false); readonly object gate=new object(); string state="running"; byte[] result;
  internal SpawnedPipeOwner(string executable,string requestFile,string requestId) {
   Guid id;if(!Guid.TryParseExact(requestId,"D",out id)||id==Guid.Empty)throw new ArgumentException("Exact request ID required");this.requestId=requestId;
   original=new FileStream(requestFile,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Delete);
   if(original.Length<=0||original.Length>262144){original.Dispose();throw new InvalidDataException();}
   identity=ProcessBoundReceiver.FileIdentity(original.SafeFileHandle);using(var sha=SHA256.Create())digest=BitConverter.ToString(sha.ComputeHash(original)).Replace("-","").ToLowerInvariant();original.Position=0;
   string name=Guid.NewGuid().ToString("N");pipe=RestrictedPipe.Create(name);
   try {child=Process.Start(new ProcessStartInfo{FileName=executable,Arguments="child "+name+" \""+requestFile+"\"",UseShellExecute=false,CreateNoWindow=true});if(child==null)throw new InvalidOperationException("Child did not start");receiver=new ProcessBoundReceiver(child.SafeHandle);}catch{pipe.Dispose();original.Dispose();throw;}
   var thread=new Thread(Receive);thread.IsBackground=true;thread.Start();
   var monitor=new Thread(()=>{try{child.WaitForExit();if(!done.WaitOne(0))pipe.Dispose();}catch{}});monitor.IsBackground=true;monitor.Start();
  }
  void Receive(){try{pipe.WaitForConnection();var chars=new StringBuilder();for(int n=0;n<17;n++){int c=pipe.ReadByte();if(c==10)break;if(c==13)continue;if(c<0||!Uri.IsHexDigit((char)c))throw new InvalidDataException("Invalid handle frame");chars.Append((char)c);}if(chars.Length==0||chars.Length>16)throw new InvalidDataException("Invalid handle frame");long h=Convert.ToInt64(chars.ToString(),16);var data=receiver.Consume(pipe.SafePipeHandle,new IntPtr(h),requestId,digest,identity);lock(gate){result=data;state="observed";} }catch{lock(gate){state="unknown";}}finally{done.Set();try{pipe.Dispose();}catch{}try{original.Dispose();}catch{}try{child.Dispose();}catch{}}}
  internal string Wait(int timeoutMs,WaitHandle cancel){if(timeoutMs<0||cancel==null)throw new ArgumentException();int index=WaitHandle.WaitAny(new WaitHandle[]{done,cancel},timeoutMs);return index==0?Inspect():"unknown";}
  internal string Inspect(){lock(gate){return state=="observed"?"observed":"unknown";}}
  internal string OriginalRequestId {get{return requestId;}}
  internal bool IsFinished {get{return done.WaitOne(0);}}
  internal byte[] ObservedBytes {get{lock(gate){return result==null?null:(byte[])result.Clone();}}}
 }
}
