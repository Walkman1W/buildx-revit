// Built with the already installed .NET Framework compiler. No target execution,
// process inspection, PID heuristics, or shell commands are part of this helper.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

static class AccessLockRecovery {
    const uint ReadWrite = 0xC0000000, Delete = 0x10000, Attributes = 0x80;
    const uint OpenExisting = 3, OpenAlways = 4, OpenReparse = 0x200000, BackupSemantics = 0x2000000;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 12 };
    static readonly Regex Uuid = new Regex("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", RegexOptions.IgnoreCase);
    static readonly Regex Account = new Regex("^access-[a-f0-9]{32}$");
    [StructLayout(LayoutKind.Sequential)]
    struct Info { public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr info, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    static void Require(bool value) { if (!value) throw new InvalidDataException(); }
    static Info Observe(SafeFileHandle handle) { Info result = new Info(); Require(!handle.IsInvalid && GetFileInformationByHandle(handle, out result)); return result; }
    static string Identity(Info info) {
        ulong index = ((ulong)info.IndexHigh << 32) | info.IndexLow;
        long created = (((long)info.CreationHigh << 32) | info.CreationLow) - 116444736000000000L;
        return info.Volume + ":" + index + ":" + checked(created * 100);
    }
    static string FinalPath(SafeFileHandle handle) {
        var text = new StringBuilder(32768); uint count = GetFinalPathNameByHandle(handle, text, (uint)text.Capacity, 0);
        Require(count > 0 && count < text.Capacity); string value = text.ToString();
        Require(value.StartsWith(@"\\?\", StringComparison.Ordinal) && !value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase));
        return value.Substring(4);
    }
    static string LocalPath(string value) {
        Require(value != null && value.Length >= 3 && value.Length < 30000 && Regex.IsMatch(value, @"^[a-zA-Z]:\\"));
        Require(value.IndexOf(':', 2) < 0 && value.IndexOf('/') < 0 && value.IndexOf('\0') < 0);
        string full = Path.GetFullPath(value); Require(Same(value, full));
        foreach (string part in value.Substring(3).Split('\\')) if (part.Length > 0)
            Require(!part.EndsWith(".") && !part.EndsWith(" ") && !Regex.IsMatch(part, @"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", RegexOptions.IgnoreCase));
        return full;
    }
    static bool Same(string a, string b) { return String.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
    static Dictionary<string,object> Object(object value, string keys) {
        var result = value as Dictionary<string,object>; Require(result != null);
        var actual = new List<string>(result.Keys); actual.Sort(StringComparer.Ordinal); Require(String.Join(",", actual.ToArray()) == keys); return result;
    }
    static string Text(Dictionary<string,object> value, string key) { var result = value[key] as string; Require(result != null); return result; }
    static void Ordinary(Info info, uint maximum) { Require((info.Attributes & 0x410) == 0 && info.Links == 1 && (info.IndexHigh != 0 || info.IndexLow != 0) && info.SizeHigh == 0 && info.SizeLow <= maximum); }
    static string Digest(byte[] bytes) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static void PinChain(object raw, string end, List<SafeFileHandle> owned, Dictionary<string,string> pinned) {
        var chain = raw as object[]; Require(chain != null && chain.Length >= 1 && chain.Length <= 65);
        string prior = null;
        foreach (object item in chain) {
            var record = Object(item, "id,path"); string path = LocalPath(Text(record, "path")), id = Text(record, "id");
            Require(id.Length <= 160 && (prior == null ? Same(path, Path.GetPathRoot(end)) : Same(Path.GetDirectoryName(path), prior)));
            string old; if (pinned.TryGetValue(path, out old)) Require(old == id);
            else {
                // No FILE_SHARE_DELETE: pin every ordinary ancestor against moves.
                var handle = CreateFile(path, Attributes, 3, IntPtr.Zero, OpenExisting, OpenReparse | BackupSemantics, IntPtr.Zero); owned.Add(handle);
                Info info = Observe(handle); Require((info.Attributes & 0x400) == 0 && (info.Attributes & 0x10) != 0 && Identity(info) == id && Same(FinalPath(handle).TrimEnd('\\'), path.TrimEnd('\\')));
                pinned.Add(path, id);
            }
            prior = path;
        }
        Require(Same(prior, end));
    }
    static void Budget(string directory) {
        string[] names = Directory.GetFileSystemEntries(directory); Require(names.Length <= 258);
        int archives = 0, evidence = 0; long total = 0;
        foreach (string name in names) {
            string leaf = Path.GetFileName(name);
            bool archive = Regex.IsMatch(leaf, @"^owner-lock-[a-f0-9-]{36}\.bak$");
            bool record = Regex.IsMatch(leaf, @"^owner-lock-[a-f0-9-]{36}\.json$");
            Require(leaf == ".recovery.guard" || archive || record);
            // Metadata-only handles are compatible with the held exclusive guard.
            using (var handle = CreateFile(name, 0, 7, IntPtr.Zero, OpenExisting, OpenReparse, IntPtr.Zero)) {
                Info info = Observe(handle); Ordinary(info, 2048); total += info.SizeLow;
                if (leaf == ".recovery.guard") Require(info.SizeLow == 0);
            }
            if (archive) archives++; if (record) evidence++;
        }
        Require(archives < 128 && evidence < 128 && total <= 384 * 1024);
    }
    static bool Rename(SafeFileHandle handle, string destination) {
        byte[] target = Encoding.Unicode.GetBytes(destination); int offset = IntPtr.Size == 8 ? 20 : 12, size = offset + target.Length + 2;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
            Marshal.WriteInt32(buffer, IntPtr.Size == 8 ? 16 : 8, target.Length); Marshal.Copy(target, 0, IntPtr.Add(buffer, offset), target.Length);
            // FILE_RENAME_INFO, ReplaceIfExists=false. Rename the held object.
            return SetFileInformationByHandle(handle, 3, buffer, (uint)size);
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static object Recover(Dictionary<string,object> request) {
        string root = LocalPath(Text(request, "stateDirectory")), file = LocalPath(Text(request, "file"));
        string source = Path.GetDirectoryName(file), archiveDirectory = LocalPath(Text(request, "archiveDirectory"));
        string name = Text(request, "archiveName"), id = Text(request, "fileIdentity"), expected = Text(request, "sha256");
        Require(Path.GetFileName(file) == ".owner.lock" && Account.IsMatch(Path.GetFileName(source)) && Same(Path.GetDirectoryName(source), root));
        Require(Same(archiveDirectory, Path.Combine(root, "access-lock-recovery")) && Regex.IsMatch(expected, "^[a-f0-9]{64}$") && id.Length <= 160);
        Require(name.StartsWith("owner-lock-", StringComparison.Ordinal) && name.EndsWith(".bak", StringComparison.Ordinal) && Uuid.IsMatch(name.Substring(11, name.Length - 15)));
        string archive = Path.Combine(archiveDirectory, name), evidenceName = name.Substring(0, name.Length - 4) + ".json";
        var owned = new List<SafeFileHandle>(); var pinned = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        bool renamed = false;
        try {
            PinChain(request["sourceChain"], source, owned, pinned); PinChain(request["archiveChain"], archiveDirectory, owned, pinned);
            using (var guard = CreateFile(Path.Combine(archiveDirectory, ".recovery.guard"), ReadWrite, 0, IntPtr.Zero, OpenAlways, OpenReparse, IntPtr.Zero)) {
                Info guardInfo = Observe(guard); Ordinary(guardInfo, 0); Budget(archiveDirectory);
                // The first lease denies READ/WRITE sharing. Any legitimate Node
                // fs.open('wx') owner, including a legacy owner without PID, blocks it.
                using (var proof = CreateFile(file, ReadWrite, 4, IntPtr.Zero, OpenExisting, OpenReparse, IntPtr.Zero)) {
                    Info original = Observe(proof); Ordinary(original, 1024); Require(Identity(original) == id);
                    using (var stream = new FileStream(proof, FileAccess.ReadWrite))
                    // This second compatible handle denies DELETE sharing. An
                    // existing deletion handle blocks it; once obtained, no racer
                    // can move/delete the original between validation and rename.
                    using (var mutation = CreateFile(file, Delete | Attributes, 3, IntPtr.Zero, OpenExisting, OpenReparse, IntPtr.Zero)) {
                        Info mutationInfo = Observe(mutation); Ordinary(mutationInfo, 1024);
                        Require(Identity(mutationInfo) == id && Same(FinalPath(proof), file) && Same(FinalPath(mutation), file));
                        byte[] bytes = new byte[(int)original.SizeLow]; int used = 0;
                        while (used < bytes.Length) { int read = stream.Read(bytes, used, bytes.Length - used); Require(read > 0); used += read; }
                        Require(stream.ReadByte() == -1 && Digest(bytes) == expected);
                        string text = new UTF8Encoding(false, true).GetString(bytes);
                        var metadata = Object(Json.DeserializeObject(text), "owner,schema");
                        Require(metadata["schema"] is int && (int)metadata["schema"] == 1 && Uuid.IsMatch(Text(metadata, "owner")));
                        Info checkedInfo = Observe(proof); Ordinary(checkedInfo, 1024);
                        Require(text == "{\"schema\":1,\"owner\":\"" + Text(metadata, "owner") + "\"}" && Identity(checkedInfo) == id && checkedInfo.SizeLow == original.SizeLow);
                        Require(Rename(mutation, archive)); renamed = true;
                        Info archived = Observe(mutation); Ordinary(archived, 1024);
                        Require(Same(FinalPath(proof), archive) && Same(FinalPath(mutation), archive) && Identity(archived) == id && archived.SizeLow == original.SizeLow);
                        // Keep the exact original plus fixed rollback metadata.
                        var evidence = new Dictionary<string,object> { { "schema", 1 }, { "sourceName", ".owner.lock" }, { "archiveName", name }, { "fileIdentity", id }, { "sha256", expected }, { "archivedUtc", DateTime.UtcNow.ToString("o") }, { "mechanism", "windows-rw-delete-handles-v1" } };
                        byte[] encoded = Encoding.UTF8.GetBytes(Json.Serialize(evidence));
                        using (var output = new FileStream(Path.Combine(archiveDirectory, evidenceName), FileMode.CreateNew, FileAccess.Write, FileShare.None)) { output.Write(encoded, 0, encoded.Length); output.Flush(true); }
                        return new { ok = true, value = new { archiveName = name, evidenceName = evidenceName, sha256 = expected, fileIdentity = id } };
                    }
                }
            }
        } catch { return new { ok = false, error = new { code = renamed ? "ACCESS_LOCK_ARCHIVE_UNCONFIRMED" : "ACCESS_LOCK_NOT_RECOVERABLE" } }; }
        finally { for (int i = owned.Count - 1; i >= 0; i--) owned[i].Dispose(); }
    }
    static int Main() {
        object result;
        try {
            var buffer = new char[65537]; int used = 0, count;
            while (used < buffer.Length && (count = Console.In.Read(buffer, used, buffer.Length - used)) > 0) used += count;
            Require(used > 0 && used <= 65536);
            var request = Object(Json.DeserializeObject(new string(buffer, 0, used)), "archiveChain,archiveDirectory,archiveName,file,fileIdentity,sha256,sourceChain,stateDirectory");
            result = Recover(request);
        } catch { result = new { ok = false, error = new { code = "ACCESS_LOCK_REQUEST_INVALID" } }; }
        Console.Out.WriteLine(Json.Serialize(result)); return 0;
    }
}
