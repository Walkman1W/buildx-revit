[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][int]$ParentPid,
    [Parameter(Mandatory=$true)][string]$NodeExecutable,
    [Parameter(Mandatory=$true)][long]$ExpectedParentFileTime,
    [switch]$Fixture,
    [switch]$StartService
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
if ($Fixture -eq $StartService) { throw 'Choose exactly one of -Fixture and -StartService.' }
$root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$server = Join-Path $root 'server.mjs'
$node = [IO.Path]::GetFullPath($NodeExecutable)
if ([IO.Path]::GetFileName($node) -ine 'node.exe' -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'An existing node.exe is required.' }
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw 'The existing BuildX server is missing.' }
$parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ParentPid) -ErrorAction Stop
if (-not $parent -or [IO.Path]::GetFileName([string]$parent.ExecutablePath) -ine 'Revit.exe') { throw 'The requested parent is not a verified Revit process.' }
$parentProcess = Get-Process -Id $ParentPid -ErrorAction Stop
if ($parentProcess.StartTime.ToUniversalTime().ToFileTimeUtc() -ne $ExpectedParentFileTime) { throw 'The requested parent identity changed.' }

$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class BuildxRevitParentLaunch {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public short wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public int dwProcessId,dwThreadId; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr p,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returnSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFOEX startup,out PROCESS_INFORMATION info);
  public static int Launch(int parentPid,long expectedCreation,string node,string arguments,string directory) {
    IntPtr parent=IntPtr.Zero,list=IntPtr.Zero,slot=IntPtr.Zero; bool initialized=false;
    PROCESS_INFORMATION pi=new PROCESS_INFORMATION();
    try {
      parent=OpenProcess(0x1080,false,parentPid); if(parent==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
      long creation,exit,kernel,user; uint exitCode;
      if(!GetProcessTimes(parent,out creation,out exit,out kernel,out user)||creation!=expectedCreation||!GetExitCodeProcess(parent,out exitCode)||exitCode!=259)throw new InvalidOperationException("Parent process identity changed.");
      IntPtr length=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref length);
      if(length==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
      list=Marshal.AllocHGlobal(length); if(!InitializeProcThreadAttributeList(list,1,0,ref length))throw new Win32Exception(Marshal.GetLastWin32Error()); initialized=true;
      slot=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(slot,parent);
      if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x00020000),slot,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
      var si=new STARTUPINFOEX(); si.StartupInfo.cb=Marshal.SizeOf(typeof(STARTUPINFOEX)); si.lpAttributeList=list;
      var command=new StringBuilder("\""+node+"\" "+arguments);
      if(!CreateProcess(node,command,IntPtr.Zero,IntPtr.Zero,false,0x08080000,IntPtr.Zero,directory,ref si,out pi))throw new Win32Exception(Marshal.GetLastWin32Error());
      return pi.dwProcessId;
    } finally {
      if(pi.hThread!=IntPtr.Zero)CloseHandle(pi.hThread); if(pi.hProcess!=IntPtr.Zero)CloseHandle(pi.hProcess);
      if(initialized)DeleteProcThreadAttributeList(list); if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list); if(slot!=IntPtr.Zero)Marshal.FreeHGlobal(slot); if(parent!=IntPtr.Zero)CloseHandle(parent);
    }
  }
}
'@
Add-Type -TypeDefinition $source
$arguments = if ($Fixture) { '-e "setTimeout(()=>{},10000)"' } else { '"' + $server + '"' }
$childPid = [BuildxRevitParentLaunch]::Launch($ParentPid,$ExpectedParentFileTime,$node,$arguments,$root)
[pscustomobject]@{ childPid=$childPid; parentPid=$ParentPid; kind=$(if($Fixture){'fixture'}else{'service'}) } | ConvertTo-Json -Compress
