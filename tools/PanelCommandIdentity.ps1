# Pure Windows command identity boundary. No process/listener queries or control.
# This covers direct invocations of the two fixed Node entry files only; it does
# not infer which modules arbitrary wrapper code loads at runtime.
if(-not ('BuildXPanelArgv' -as [type])){
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BuildXPanelArgv {
    [DllImport("shell32.dll", SetLastError=true)]
    private static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    public static string[] Parse(string command) {
        if(command==null || command.Length==0 || command.Length>32768 || command.IndexOf('\0')>=0) throw new ArgumentException();
        int count; IntPtr pointer=CommandLineToArgvW(command,out count);
        if(pointer==IntPtr.Zero) throw new InvalidOperationException();
        try {
            if(count<1 || count>256) throw new ArgumentException();
            string[] args=new string[count];
            for(int i=0;i<count;i++) args[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,i*IntPtr.Size));
            return args;
        } finally { LocalFree(pointer); }
    }
}
'@
}

function Get-PanelCommandIdentity {
    [CmdletBinding()]
    param([string]$Root,[string]$ExecutablePath,[string]$CommandLine)
    function Test-FullyQualifiedWindowsPath([string]$Value){
        # IsPathRooted also accepts C:foo and \foo, whose resolution depends on
        # a process cwd we have not observed. Neither establishes exact identity.
        return $Value -match '^[A-Za-z]:[\\/]' -or $Value -match '^\\\\[^\\/]+[\\/][^\\/]+'
    }
    try {
        if(-not(Test-FullyQualifiedWindowsPath $Root) -or -not(Test-FullyQualifiedWindowsPath $ExecutablePath)){throw 'unknown'}
        $fixedRoot=[IO.Path]::GetFullPath($Root)
        $executable=[IO.Path]::GetFullPath($ExecutablePath)
        if([IO.Path]::GetFileName($executable) -ine 'node.exe'){throw 'unknown'}
        $arguments=@([BuildXPanelArgv]::Parse($CommandLine))
        $profiles=@(
            [pscustomobject]@{Role='model';Entry=([IO.Path]::GetFullPath((Join-Path $fixedRoot 'server.mjs')))},
            [pscustomobject]@{Role='source';Entry=([IO.Path]::GetFullPath((Join-Path $fixedRoot 'source-panel.mjs')))}
        )
        $facts=New-Object Collections.Generic.List[object]
        foreach($profile in $profiles){
            $candidate=$false
            foreach($argument in $arguments){
                # A same-basename path from an unknown cwd or another root is
                # ambiguous, not absence. Normalize slash/dot syntax only here.
                try {$basename=[IO.Path]::GetFileName(([string]$argument).Replace('/','\'))}
                catch {throw 'unknown'}
                if([string]::Equals($basename,[IO.Path]::GetFileName($profile.Entry),[StringComparison]::OrdinalIgnoreCase)){$candidate=$true}
            }
            if(-not $candidate){continue}
            $exact=$false
            if($arguments.Count -eq 2 -and (Test-FullyQualifiedWindowsPath $arguments[0]) -and (Test-FullyQualifiedWindowsPath $arguments[1])){
                $argumentExecutable=[IO.Path]::GetFullPath($arguments[0])
                $argumentEntry=[IO.Path]::GetFullPath($arguments[1])
                $exact=[string]::Equals($argumentExecutable,$executable,[StringComparison]::OrdinalIgnoreCase) -and
                    [string]::Equals($argumentEntry,$profile.Entry,[StringComparison]::OrdinalIgnoreCase)
            }
            $facts.Add([pscustomobject]@{Role=$profile.Role;CommandMatches=[bool]$exact})
        }
        if($facts.Count -eq 0){
            # Eval/preload can hide runtime imports. Do not interpret its code,
            # or claim such an invocation proves the fixed entries are absent.
            foreach($argument in $arguments){
                if($argument -match '^-[epr]' -or $argument -match '^(?:--eval|--print|--require|--import|--loader|--experimental-loader)(?:=|$)'){throw 'unknown'}
            }
        }
        foreach($fact in $facts){Write-Output $fact}
    } catch {throw 'PANEL_COMMAND_IDENTITY_UNKNOWN'}
}
