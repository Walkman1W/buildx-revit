using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class VerifiedImageLockExperiment
{
 [StructLayout(LayoutKind.Sequential)] struct Info { public uint attributes,creationLow,creationHigh,accessLow,accessHigh,writeLow,writeHigh,volume,sizeHigh,sizeLow,links,indexHigh,indexLow; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern SafeFileHandle CreateFileMappingW(SafeFileHandle file,IntPtr attributes,uint protection,uint high,uint low,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr MapViewOfFile(SafeFileHandle mapping,uint access,uint high,uint low,UIntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushViewOfFile(IntPtr address,UIntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UnmapViewOfFile(IntPtr address);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateHardLinkW(string link,string target,IntPtr security);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
 const uint Read=0x80000000,ReadAttributes=0x80,ShareRead=1,ShareWrite=2,OpenExisting=3,BackupSemantics=0x02000000,OpenReparsePoint=0x00200000,ReparsePoint=0x400;
 static int checks;
 static void Check(bool ok,string message){if(!ok)throw new Exception("FAIL "+message);checks++;Console.WriteLine("PASS "+message);}
 static SafeFileHandle Open(string name,uint access,uint share,uint flags){var h=CreateFileW(name,access,share,IntPtr.Zero,OpenExisting,flags,IntPtr.Zero);if(h.IsInvalid){int error=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(error);}Info info;if(!GetFileInformationByHandle(h,out info)||(info.attributes&ReparsePoint)!=0){h.Dispose();throw new Exception("reparse or identity unknown");}return h;}
 // A second FileStream must not own the guard handle. Hash a separately opened
 // read handle while the original denies all write/delete sharing.
 static string HashPath(string filename){using(var sha=SHA256.Create())using(var stream=new FileStream(filename,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
 sealed class Guard:IDisposable {
  readonly List<SafeFileHandle> handles=new List<SafeFileHandle>();
  public Guard(string filename){try{
   string full=Path.GetFullPath(filename),root=Path.GetPathRoot(full);if(root.Length!=3||root[1]!=':')throw new Exception("only local absolute test paths");
   string parent=Path.GetDirectoryName(full);var dirs=new Stack<string>();while(parent!=null){dirs.Push(parent);if(String.Equals(parent,root,StringComparison.OrdinalIgnoreCase))break;parent=Path.GetDirectoryName(parent);}if(dirs.Count==0||!String.Equals(dirs.Peek(),root,StringComparison.OrdinalIgnoreCase))throw new Exception("unanchored path");
   while(dirs.Count>0)handles.Add(Open(dirs.Pop(),ReadAttributes,ShareRead|ShareWrite,BackupSemantics|OpenReparsePoint));
   handles.Add(Open(full,Read,ShareRead,OpenReparsePoint));
  }catch{Dispose();throw;}}
  public void Dispose(){for(int i=handles.Count-1;i>=0;i--)handles[i].Dispose();handles.Clear();}
 }
 static bool CanGuard(string path){try{using(var guard=new Guard(path))return true;}catch{return false;}}
 static bool MoveFile(string a,string b){try{File.Move(a,b);return true;}catch(IOException){return false;}catch(UnauthorizedAccessException){return false;}}
 static bool MoveDirectory(string a,string b){try{Directory.Move(a,b);return true;}catch(IOException){return false;}catch(UnauthorizedAccessException){return false;}}
 static void Main(string[] args){try{Run(args);}catch(Exception e){Console.Error.WriteLine("FAILED "+e.GetType().Name+" "+e.Message);Environment.Exit(1);}}
 static void Run(string[] args){
  if(args.Length==2&&args[0]=="hold"){using(var guard=new Guard(args[1])){Console.WriteLine("ready");Console.Out.Flush();Thread.Sleep(15000);}return;}
  if(args.Length!=5)throw new ArgumentException("fixture directory, addon, node, second addon and peer script required");
  string root=Path.GetFullPath(args[0]),node=args[2],dir=Path.Combine(root,"anchored"),image=Path.Combine(dir,"owner.node");Directory.CreateDirectory(dir);File.Copy(args[1],image,false);string hash=HashPath(image);
  using(var writer=new FileStream(image,FileMode.Open,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete)){Check(!CanGuard(image),"pre-existing writer prevents guarded load");}
  Check(CanGuard(image),"guard succeeds after writer closes");
  string hardlink=Path.Combine(dir,"same-image-hardlink.node");if(!CreateHardLinkW(hardlink,image,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
  using(var aliasWriter=new FileStream(hardlink,FileMode.Open,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete)){Check(!CanGuard(image),"pre-existing hardlink writer prevents guarded load");}
  using(var guard=new Guard(image)){bool writeBlocked=false;try{using(var forbidden=new FileStream(hardlink,FileMode.Open,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete)){}}catch(IOException){writeBlocked=true;}catch(UnauthorizedAccessException){writeBlocked=true;}Check(writeBlocked,"hardlink alias cannot open a writer while image is guarded");}
  string junction=Path.Combine(root,"junction");
  using(var j=Process.Start(new ProcessStartInfo{FileName="cmd.exe",Arguments="/d /c mklink /J \""+junction+"\" \""+dir+"\"",UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true})){if(!j.WaitForExit(5000)){j.Kill();throw new Exception("junction creation timeout");}if(j.ExitCode!=0)throw new Exception("controlled junction creation failed");}
  Check(!CanGuard(Path.Combine(junction,"owner.node")),"reparse-point path is rejected before loading");
  string mapped=Path.Combine(dir,"mapped.node");File.Copy(image,mapped,false);
  using(var mapping=MemoryMappedFile.CreateFromFile(mapped,FileMode.Open,null,0,MemoryMappedFileAccess.ReadWrite))
  using(var view=mapping.CreateViewAccessor(0,1,MemoryMappedFileAccess.ReadWrite))
  {
   try {using(var guard=new Guard(mapped)){string before=HashPath(mapped);byte b=view.ReadByte(0);view.Write(0,(byte)(b^1));view.Flush();string after=HashPath(mapped);Check(before==after,"pre-existing writable mapping cannot change guarded image");}}
   catch(Win32Exception){Check(true,"pre-existing writable mapping prevents guarded load");}
  }

  string sectionPath=Path.Combine(dir,"section.node");File.Copy(image,sectionPath,false);
  using(var writeHandle=Open(sectionPath,Read|0x40000000,ShareRead|ShareWrite|4,OpenReparsePoint))
  using(var section=CreateFileMappingW(writeHandle,IntPtr.Zero,4,0,0,null))
  {
   if(section.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
   IntPtr view=MapViewOfFile(section,2,0,0,(UIntPtr)1);if(view==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
   try{
    writeHandle.Dispose();
    try {using(var guard=new Guard(sectionPath)){string before=HashPath(sectionPath);byte b=Marshal.ReadByte(view);Marshal.WriteByte(view,(byte)(b^1));if(!FlushViewOfFile(view,(UIntPtr)1))throw new Win32Exception(Marshal.GetLastWin32Error());string after=HashPath(sectionPath);if(before!=after)Console.WriteLine("COUNTEREXAMPLE writable mapped section modified image while guard held");Check(before==after,"closed-writer mapped section cannot change guarded image");}}
    catch(Win32Exception){Check(true,"closed-writer mapped section prevents guarded load");}
   }finally{UnmapViewOfFile(view);}
  }
  using(var guard=new Guard(image)){
   Check(HashPath(image)==hash,"guarded image digest matches selected fixture");
   Check(!MoveFile(image,image+".replaced"),"locked image cannot be replaced or renamed");
   Check(!MoveDirectory(dir,dir+".moved"),"locked ancestor cannot be renamed");
   var start=new ProcessStartInfo{FileName=node,Arguments="-e \"const b=require(process.argv[1]); if(typeof b.create!=='function')process.exit(3); console.log('loaded')\" \""+image+"\"",UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
   using(var child=Process.Start(start)){if(!child.WaitForExit(5000)){child.Kill();throw new Exception("loader peer timeout");}Check(child.ExitCode==0&&child.StandardOutput.ReadToEnd().Trim()=="loaded","Node loads guarded same-path addon");}
   Check(HashPath(image)==hash,"digest stays unchanged through load");
  }
  Check(MoveFile(image,image+".closed"),"closing guard releases file rename");File.Move(image+".closed",image);
  var holder=Process.Start(new ProcessStartInfo{FileName=Process.GetCurrentProcess().MainModule.FileName,Arguments="hold \""+image+"\"",UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true});
  try{Check(holder.StandardOutput.ReadLine()=="ready","independent guard process started");Check(!MoveFile(image,image+".afterexit"),"other process cannot rename while guard is alive");holder.Kill();holder.WaitForExit(5000);Check(MoveFile(image,image+".afterexit"),"process exit releases held image handles");}
  finally{if(!holder.HasExited){holder.Kill();holder.WaitForExit(5000);}holder.Dispose();}
  string cacheDir=Path.Combine(root,"cache"),cacheImage=Path.Combine(cacheDir,"cache.node");Directory.CreateDirectory(cacheDir);File.Copy(args[1],cacheImage,false);
  var cacheStart=new ProcessStartInfo{FileName=node,Arguments="\""+args[4]+"\" \""+cacheImage+"\" \""+args[3]+"\"",UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,RedirectStandardInput=true};
  using(var cachePeer=Process.Start(cacheStart)){
   string phase=cachePeer.StandardOutput.ReadLine();
   if(phase=="replaced"){
    using(var guard=new Guard(cacheImage)){string replacementHash=HashPath(cacheImage);cachePeer.StandardInput.WriteLine("load");cachePeer.StandardInput.Flush();string loaded=cachePeer.StandardOutput.ReadLine();if(loaded=="cached-original")Console.WriteLine("COUNTEREXAMPLE Node reused earlier cached addon while replacement image was guarded");Check(loaded=="cached-original"&&replacementHash!=hash,"preloaded addon cache survives same-path image replacement");}
   }else Check(phase!=null&&phase.StartsWith("replace-blocked:"),"OS blocks replacement of an already loaded image in this environment");
   if(!cachePeer.WaitForExit(5000)){cachePeer.Kill();throw new Exception("cache peer timeout");}if(cachePeer.ExitCode!=0)throw new Exception("cache peer failed");
  }
  Console.WriteLine("PASS total="+checks);
 }
}
