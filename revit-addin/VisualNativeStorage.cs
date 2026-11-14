using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace RevitLocalCodex {
 internal static class VisualNativeStorage {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct FindData {
   public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write; public uint sizeHigh,sizeLow,reserved0,reserved1;
   [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
   [MarshalAs(UnmanagedType.ByValTStr, SizeConst=14)] public string alternate;
  }
  sealed class FindHandle : SafeHandleZeroOrMinusOneIsInvalid { private FindHandle():base(true) {} protected override bool ReleaseHandle() { return FindClose(handle); } }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFileAttributesW(string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern FindHandle FindFirstFileW(string path, out FindData data);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool FindNextFileW(FindHandle handle, out FindData data);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FindClose(IntPtr handle);
  internal sealed class Entry { internal string Name; internal int Attributes; internal long Length; }
  static string Extended(string path) { if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) throw new InvalidOperationException("Unexpected extended path"); if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path.Substring(2); if (path.Length < 3 || path[1] != ':' || path[2] != '\\') throw new InvalidOperationException("Absolute path required"); return @"\\?\" + path; }
  internal static int Attributes(string path) { uint a=GetFileAttributesW(Extended(path)); if(a!=0xffffffff) return unchecked((int)a); int e=Marshal.GetLastWin32Error(); if(e==2 || e==3) return -1; throw new Win32Exception(e); }
  internal static int AttributesRequired(string path) { int a=Attributes(path); if(a==-1) throw new InvalidOperationException("Evidence path disappeared"); return a; }
  internal static IEnumerable<Entry> Enumerate(string path) {
   FindData d; using (FindHandle h=FindFirstFileW(Extended(path)+@"\*", out d)) {
    if(h.IsInvalid) { int e=Marshal.GetLastWin32Error(); if(e==2) yield break; throw new Win32Exception(e); }
    do { if(d.name != "." && d.name != "..") { ulong n=((ulong)d.sizeHigh << 32) | d.sizeLow; if(n>long.MaxValue) throw new InvalidOperationException("File too large"); yield return new Entry { Name=d.name, Attributes=unchecked((int)d.attributes), Length=(long)n }; } } while(FindNextFileW(h,out d));
    int last=Marshal.GetLastWin32Error(); if(last!=18) throw new Win32Exception(last);
   }
  }
 }
}
