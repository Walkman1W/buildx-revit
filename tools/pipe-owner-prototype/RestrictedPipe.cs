using System;using System.IO.Pipes;using System.Runtime.InteropServices;using System.Security.Principal;using Microsoft.Win32.SafeHandles;
namespace BuildX.PipePrototype {
 internal static class RestrictedPipe {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {public int length;public IntPtr descriptor;public bool inherit;}
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateNamedPipe(string name,uint openMode,uint pipeMode,uint maxInstances,uint outBuffer,uint inBuffer,uint timeout,ref SecurityAttributes security);
  internal static NamedPipeServerStream Create(string name) {Guid id;if(!Guid.TryParseExact(name,"N",out id)||id==Guid.Empty)throw new ArgumentException("Random pipe identity required");IntPtr descriptor;uint size;string sid=WindowsIdentity.GetCurrent().User.Value;if(!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;"+sid+")",1,out descriptor,out size))throw new System.ComponentModel.Win32Exception();try {var a=new SecurityAttributes{length=Marshal.SizeOf(typeof(SecurityAttributes)),descriptor=descriptor,inherit=false};IntPtr h=CreateNamedPipe(@"\\.\pipe\buildx-owner-"+name,0x80000|3,8,1,4096,4096,0,ref a);if(h==new IntPtr(-1))throw new System.ComponentModel.Win32Exception();return new NamedPipeServerStream(PipeDirection.InOut,false,false,new SafePipeHandle(h,true));}finally{LocalFree(descriptor);}}
 }
}
