using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using Microsoft.Win32.SafeHandles;
using System.Web.Script.Serialization;

internal static class FreshNodeLoadExperiment
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

 static void RequireDigest(string image,string expected){if(HashPath(image)!=expected)throw new InvalidOperationException("digest mismatch");}
 static ProcessStartInfo StartInfo(string node,string peer,string image,string attacker,string marker,string[] externalArgs,bool clean)
 {
  if(externalArgs!=null&&externalArgs.Length!=0)throw new InvalidOperationException("External startup arguments are not allowed.");
  var start=new ProcessStartInfo{FileName=node,Arguments="\""+peer+"\" \""+image+"\"",UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,RedirectStandardInput=true};
  start.EnvironmentVariables["BUILDX_PRELOAD_MARKER"]=marker;
  // Test-injected hostile setting exists only on this child configuration.
  start.EnvironmentVariables["NODE_OPTIONS"]="--require=\""+attacker.Replace('\\','/')+"\"";
  if(clean){start.EnvironmentVariables.Remove("NODE_OPTIONS");start.EnvironmentVariables.Remove("NODE_PATH");}
  return start;
 }
 static void Main(string[] args){try{Run(args);}catch(Exception e){Console.Error.WriteLine("FAILED "+e.GetType().Name+" "+e.Message);Environment.Exit(1);}}
 static void Run(string[] args)
 {
  if(args.Length!=4)throw new ArgumentException("fixture, node, addon and peer required");
  string root=Path.GetFullPath(args[0]),node=args[1],dir=Path.Combine(root,"fresh"),image=Path.Combine(dir,"owner.node"),attack=Path.Combine(dir,"preload.cjs"),marker=Path.Combine(dir,"preloaded.txt");
  Directory.CreateDirectory(dir);File.Copy(args[2],image,false);File.WriteAllText(attack,"require('node:fs').writeFileSync(process.env.BUILDX_PRELOAD_MARKER,'executed');");string digest=HashPath(args[2]);
  using(var guard=new Guard(image)){
   bool wrongDigestRejected=false;try{RequireDigest(image,new string('0',64));}catch(InvalidOperationException){wrongDigestRejected=true;}Check(wrongDigestRejected,"incorrect digest rejected before process launch");
   RequireDigest(image,digest);Check(true,"guarded image matches independently captured fixture digest");
   using(var contaminated=Process.Start(StartInfo(node,args[3],image,attack,marker,null,false))){string line=contaminated.StandardOutput.ReadLine();if(line==null)throw new Exception("control failed: "+contaminated.StandardError.ReadToEnd());Check(File.Exists(marker),"injected NODE_OPTIONS preload executes in unclean control");contaminated.StandardInput.WriteLine("exit");contaminated.StandardInput.Flush();if(!contaminated.WaitForExit(5000)){contaminated.Kill();throw new Exception("control timeout");}}
   File.Delete(marker);
   bool rejected=false;try{StartInfo(node,args[3],image,attack,marker,new[]{"--require",attack},true);}catch(InvalidOperationException){rejected=true;}Check(rejected,"external --require startup arguments rejected before launch");
   using(var child=Process.Start(StartInfo(node,args[3],image,attack,marker,null,true))){
    string response=child.StandardOutput.ReadLine();if(response==null)throw new Exception("child did not report load");var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(response);
    Check((bool)data["cachedBefore"]==false,"new controlled process has no cached addon before first load");
    Check((string)data["digest"]==digest&&(bool)data["hasClose"]&&String.Equals((string)data["resolved"],image,StringComparison.OrdinalIgnoreCase),"first load uses expected guarded path and matching digest");
    Check(!File.Exists(marker),"clean child did not execute NODE_OPTIONS preload");
    bool visible=false;foreach(ProcessModule module in child.Modules){if(String.Equals(module.FileName,image,StringComparison.OrdinalIgnoreCase)){visible=true;break;}}
    Check(visible,"Windows process module list reports guarded addon path");
    Check(HashPath(image)==digest,"guarded bytes unchanged while module is loaded");
    child.StandardInput.WriteLine("exit");child.StandardInput.Flush();if(!child.WaitForExit(5000)){child.Kill();throw new Exception("fresh child timeout");}Check(child.ExitCode==0,"controlled child exits successfully");
   }
  }
  string moved=image+".after";File.Move(image,moved);Check(File.Exists(moved),"parent guard and child exit release rename restriction");
  Console.WriteLine("PASS total="+checks);
 }
}
