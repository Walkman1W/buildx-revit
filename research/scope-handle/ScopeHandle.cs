using System;using System.IO;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
// Isolated experiment. Never use for production or receipt verification.
class ScopeHandle {
 [StructLayout(LayoutKind.Sequential)] struct U {public ushort Length,MaximumLength;public IntPtr Buffer;}
 [StructLayout(LayoutKind.Sequential)] struct A {public int Length;public IntPtr Root,Name;public uint Attributes;public IntPtr Security,Qos;}
 [StructLayout(LayoutKind.Sequential)] struct IO {public IntPtr Status,Information;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr sec,uint d,uint f,IntPtr t);
 [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle h,uint access,ref A a,out IO io,IntPtr alloc,uint attrs,uint share,uint disposition,uint options,IntPtr ea,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int cls,ref byte value,uint size);
 static SafeFileHandle Relative(SafeFileHandle root,string name,uint disposition,out int status){IntPtr s=Marshal.StringToHGlobalUni(name),n=IntPtr.Zero;try{var u=new U{Length=(ushort)(name.Length*2),MaximumLength=(ushort)(name.Length*2),Buffer=s};n=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(U)));Marshal.StructureToPtr(u,n,false);var a=new A{Length=Marshal.SizeOf(typeof(A)),Root=root.DangerousGetHandle(),Name=n,Attributes=0x40};IO io;SafeFileHandle h;status=NtCreateFile(out h,0x00010080,ref a,out io,IntPtr.Zero,0,7,disposition,0x00200040,IntPtr.Zero,0);return h;}finally{if(n!=IntPtr.Zero)Marshal.FreeHGlobal(n);Marshal.FreeHGlobal(s);}}
 static int Main(string[] args){if(args.Length!=2 || (args[1]!="claim"&&args[1]!="claim-hold"&&args[1]!="release"))return 2;using(var root=CreateFile(Path.GetFullPath(args[0]),0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)){if(root.IsInvalid)return 3;Console.WriteLine("ROOT_OPEN");Console.Out.Flush();Console.ReadLine();int status;using(var h=Relative(root,"scope.lock",args[1].StartsWith("claim")?2u:1u,out status)){if(status<0){Console.WriteLine("STATUS "+status.ToString("X8"));return 4;}if(args[1]=="release"){Console.WriteLine("UNKNOWN: trusted anchor and original receipt unavailable");return 6;}Console.WriteLine("OK");Console.Out.Flush();if(args[1]=="claim-hold")Console.ReadLine();return 0;}}}
}


