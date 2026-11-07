using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
// Research probe only: no writes, lock, recovery, or security guarantees.
internal static class RelativeDirectoryProbe {
 [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length,MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public int Length; public IntPtr RootDirectory,ObjectName; public uint Attributes; public IntPtr SecurityDescriptor,SecurityQualityOfService; }
 [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status,Information; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle h,uint access,ref ObjectAttributes attr,out IoStatus io,IntPtr allocation,uint fileAttributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder path,uint capacity,uint flags);
 static int Main(string[] args){ if(args.Length!=2 || args[1].IndexOfAny(new[]{'\\','/',':'})>=0 || args[1]=="." || args[1]=="..") return 2;
  using(var root=CreateFile(Path.GetFullPath(args[0]),0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) { if(root.IsInvalid) return 3;
   Console.WriteLine("ROOT_OPEN"); Console.Out.Flush(); Console.ReadLine();
   IntPtr chars=Marshal.StringToHGlobalUni(args[1]),name=IntPtr.Zero;
   try { var u=new UnicodeString{Length=(ushort)(args[1].Length*2),MaximumLength=(ushort)(args[1].Length*2),Buffer=chars};name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));Marshal.StructureToPtr(u,name,false);
    var a=new ObjectAttributes{Length=Marshal.SizeOf(typeof(ObjectAttributes)),RootDirectory=root.DangerousGetHandle(),ObjectName=name,Attributes=0x40};IoStatus io;SafeFileHandle child;int status=NtCreateFile(out child,0x80,ref a,out io,IntPtr.Zero,0,7,1,0x00200001,IntPtr.Zero,0);
    if(status<0){Console.Error.WriteLine("NTSTATUS 0x"+status.ToString("X8"));return 4;}using(child){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(child,b,(uint)b.Capacity,0);if(n==0||n>=b.Capacity)return 5;Console.WriteLine(b.ToString());return 0;}
   }finally{if(name!=IntPtr.Zero)Marshal.FreeHGlobal(name);Marshal.FreeHGlobal(chars);}
  }
 }
}
