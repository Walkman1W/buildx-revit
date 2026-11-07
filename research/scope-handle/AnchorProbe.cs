using System;using System.IO;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
// Isolated identity probe; caller-provided identity is NOT inherently trusted.
class AnchorProbe {
 [StructLayout(LayoutKind.Sequential)] struct Info {public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr sec,uint d,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 static int Main(string[] args){if(Environment.GetEnvironmentVariable("BUILDX_UNSAFE_SCOPE_RESEARCH")!="1"||args.Length!=2)return 6;try{using(var root=CreateFile(Path.GetFullPath(args[0]),0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero)){Info i;if(root.IsInvalid||!GetFileInformationByHandle(root,out i)||(i.Attributes&0x410)!=0x10||(i.IndexHigh==0&&i.IndexLow==0))return 6;string id=i.Volume+":"+(((ulong)i.IndexHigh<<32)|i.IndexLow)+":"+(((ulong)i.CreationHigh<<32)|i.CreationLow);if(args[1]!="capture"&&args[1]!=id)return 6;Console.WriteLine(id);Console.Out.Flush();Console.ReadLine();return 0;}}catch{return 6;}}
}
