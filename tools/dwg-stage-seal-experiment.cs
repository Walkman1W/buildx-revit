using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

class StageSealExperiment
{
 const uint Open=3, Backup=0x02000000, OpenReparse=0x00200000, Attributes=0x80;
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateHardLink(string newName,string existing,IntPtr security);
 static void Check(bool ok,string msg){if(!ok)throw new Exception(msg);Console.WriteLine("PASS "+msg);}
 static string Digest(string file){using(var h=SHA256.Create())using(var f=File.OpenRead(file))return BitConverter.ToString(h.ComputeHash(f)).Replace("-","").ToLowerInvariant();}
 static string[] Manifest(string dir){return Directory.GetFiles(dir).Select(p=>Path.GetFileName(p)+":"+Digest(p)).OrderBy(x=>x,StringComparer.Ordinal).ToArray();}
 static SafeFileHandle Hold(string dir,uint share){var h=CreateFile(dir,Attributes,share,IntPtr.Zero,Open,Backup|OpenReparse,IntPtr.Zero);if(h.IsInvalid)throw new IOException("Directory handle unavailable: "+Marshal.GetLastWin32Error());return h;}
 static void Main(string[] args)
 {
  if(args.Length!=1)throw new Exception("A new isolated test directory is required.");string root=Path.GetFullPath(args[0]);if(Directory.Exists(root))throw new Exception("Test directory already exists.");Directory.CreateDirectory(root);string stage=Path.Combine(root,"stage");Directory.CreateDirectory(stage);string source=Path.Combine(stage,"drawing.dwg");File.WriteAllText(source,"synthetic original");
  foreach(uint share in new uint[]{0,3,7})
  {
   string append=Path.Combine(stage,"append-"+share+".tmp"),hardlink=Path.Combine(stage,"hardlink-"+share+".tmp"),moved=stage+"-moved-"+share;
   bool created=false,linked=false,movedDir=false,sourceReplaced=false;int linkError=0;var before=Manifest(stage);
   using(var held=Hold(stage,share))
   {
    var start=new ManualResetEvent(false);
    Thread child=new Thread(()=>{start.WaitOne();try{using(var f=new FileStream(append,FileMode.CreateNew,FileAccess.Write,FileShare.None)){f.WriteByte(65);}created=true;}catch(IOException){}catch(UnauthorizedAccessException){} });
    Thread hard=new Thread(()=>{start.WaitOne();linked=CreateHardLink(hardlink,source,IntPtr.Zero);if(!linked)linkError=Marshal.GetLastWin32Error();});
    Thread rename=new Thread(()=>{start.WaitOne();try{Directory.Move(stage,moved);movedDir=true;Directory.Move(moved,stage);}catch(IOException){}catch(UnauthorizedAccessException){} });
    child.Start();hard.Start();rename.Start();start.Set();child.Join();hard.Join();rename.Join();
    try{File.Move(source,source+".old");File.WriteAllText(source,"replacement");sourceReplaced=true;}catch(IOException){}catch(UnauthorizedAccessException){}
   }
   // Preserve evidence in the isolated directory. Restore the input only after
   // recording outcomes, without touching anything outside the test root.
   var after=Manifest(stage);bool unchanged=before.SequenceEqual(after);Console.WriteLine("RESULT share="+share+" append="+created+" hardlink="+linked+" hardlink_error="+linkError+" directory_moved="+movedDir+" source_replaced="+sourceReplaced+" manifest_unchanged="+unchanged);
   Check(created||linked||sourceReplaced,"held directory handle does not establish frozen child manifest (share="+share+")");
   if(sourceReplaced){File.Delete(source);File.Move(source+".old",source);}
   if(created)File.Delete(append);if(linked)File.Delete(hardlink);
  }
  string extra=Path.Combine(stage,"while-source-locked.tmp");bool appended=false,replaced=false,linkedWhileLocked=false;var sealedManifest=Manifest(stage);
  using(var heldDirectory=Hold(stage,0))
  using(var heldFile=CreateFile(source,0x80000000,0,IntPtr.Zero,Open,OpenReparse,IntPtr.Zero))
  {
   if(heldFile.IsInvalid)throw new IOException("Source handle unavailable: "+Marshal.GetLastWin32Error());
   var start=new ManualResetEvent(false);var task=new Thread(()=>{start.WaitOne();try{using(var f=new FileStream(extra,FileMode.CreateNew,FileAccess.Write,FileShare.None))f.WriteByte(7);appended=true;}catch(IOException){}catch(UnauthorizedAccessException){}});task.Start();start.Set();task.Join();
   try{File.Move(source,source+".moved");replaced=true;}catch(IOException){}catch(UnauthorizedAccessException){}
   linkedWhileLocked=CreateHardLink(Path.Combine(stage,"while-source-locked-link.tmp"),source,IntPtr.Zero);
  }
  Console.WriteLine("RESULT locked-source append="+appended+" source_replaced="+replaced+" hardlink="+linkedWhileLocked+" manifest_unchanged="+sealedManifest.SequenceEqual(Manifest(stage)));
  Check(appended,"exclusive source and directory handles still allow extra child creation");
  if(replaced){File.Move(source+".moved",source);}if(linkedWhileLocked)File.Delete(Path.Combine(stage,"while-source-locked-link.tmp"));if(appended)File.Delete(extra);
  Check(Directory.Exists(stage)&&File.ReadAllText(source)=="synthetic original","synthetic stage restored under isolated root");
 }
}
