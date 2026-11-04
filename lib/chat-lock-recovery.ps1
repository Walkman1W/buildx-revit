$ErrorActionPreference = 'Stop'
try {
    $requestText = [Environment]::GetEnvironmentVariable('BUILDX_CHAT_LOCK_RECOVERY_REQUEST')
    [Environment]::SetEnvironmentVariable('BUILDX_CHAT_LOCK_RECOVERY_REQUEST', $null)
    $request = $requestText | ConvertFrom-Json
    $source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static class BuildxChatLockRecovery {
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh,
            Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr info, uint size);
    static FileInfo Observe(SafeFileHandle handle) {
        FileInfo result;
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out result)) throw new IOException("open");
        return result;
    }
    static string Identity(FileInfo info) {
        ulong index = ((ulong)info.IndexHigh << 32) | info.IndexLow;
        long creation = (((long)info.CreationHigh << 32) | info.CreationLow) - 116444736000000000L;
        return info.Volume.ToString() + ":" + index.ToString() + ":" + checked(creation * 100).ToString();
    }
    public static bool Recover(string file, string archive, string[] directories, string[] ids, string fileId, string digest) {
        if (directories == null || ids == null || directories.Length != ids.Length || directories.Length < 1 || directories.Length > 65) return false;
        if (!String.Equals(Path.GetFileName(file), ".panel-chat.lock", StringComparison.Ordinal) ||
            !String.Equals(Path.GetDirectoryName(file), directories[directories.Length - 1], StringComparison.OrdinalIgnoreCase) ||
            !String.Equals(Path.GetDirectoryName(file), Path.GetDirectoryName(archive), StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(archive).StartsWith(".panel-chat.lock.recovered.", StringComparison.Ordinal)) return false;
        var opened = new SafeFileHandle[directories.Length];
        try {
            for (int i = 0; i < directories.Length; ++i) {
                // Exclude FILE_SHARE_DELETE so neither this directory nor any
                // ancestor can be renamed while recovery is in progress.
                opened[i] = CreateFile(directories[i], 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                var info = Observe(opened[i]);
                if ((info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0 || Identity(info) != ids[i]) return false;
            }
            // No sharing: an owner with its original lock handle still open
            // prevents us from acquiring this handle, irrespective of PID.
            using (var handle = CreateFile(file, 0x80010000, 0, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
                var info = Observe(handle);
                if ((info.Attributes & 0x410) != 0 || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > 1024 || Identity(info) != fileId) return false;
                using (var stream = new FileStream(handle, FileAccess.Read))
                using (var hash = SHA256.Create()) {
                    var bytes = hash.ComputeHash(stream);
                    var actual = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
                    if (!String.Equals(actual, digest, StringComparison.Ordinal)) return false;
                    var target = System.Text.Encoding.Unicode.GetBytes(archive);
                    int offset = IntPtr.Size == 8 ? 20 : 12;
                    IntPtr buffer = Marshal.AllocHGlobal(offset + target.Length + 2);
                    try {
                        for (int i = 0; i < offset + target.Length + 2; ++i) Marshal.WriteByte(buffer, i, 0);
                        Marshal.WriteInt32(buffer, IntPtr.Size == 8 ? 16 : 8, target.Length);
                        Marshal.Copy(target, 0, IntPtr.Add(buffer, offset), target.Length);
                        // FILE_RENAME_INFO with ReplaceIfExists false. The original
                        // handle remains exclusive until after this atomic rename.
                        return SetFileInformationByHandle(handle, 3, buffer, (uint)(offset + target.Length + 2));
                    } finally { Marshal.FreeHGlobal(buffer); }
                }
            }
        } catch { return false; }
        finally { for (int i = opened.Length - 1; i >= 0; --i) if (opened[i] != null) opened[i].Dispose(); }
    }
}
'@
    Add-Type -TypeDefinition $source
    $dirs = @($request.chain | ForEach-Object { [string]$_.path })
    $ids = @($request.chain | ForEach-Object { [string]$_.identity })
    $ok = [BuildxChatLockRecovery]::Recover([string]$request.file, [string]$request.archive,
        [string[]]$dirs, [string[]]$ids, [string]$request.fileIdentity, [string]$request.sha256)
    if ($ok) { exit 0 } else { exit 1 }
} catch {
    exit 1
}
