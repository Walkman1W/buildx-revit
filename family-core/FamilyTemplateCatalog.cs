using System;
using System.Collections.Generic;
using System.IO;
using System.Security;
using System.Security.Cryptography;

[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("BuildX.FamilyTemplateCatalog.Tests")]

namespace BuildX.FamilyCore
{
    // A trusted host supplies this small fixed catalog. Hashing proves only the
    // bytes observed at an authorized path, not Revit format/category validity.
    // Attribute checks and FileShare.Read are not an OS isolation boundary or
    // native file-identity proof against another same-permission process.
    public sealed class FamilyTemplateCatalog : IFamilyTemplateSource
    {
        public const long DefaultMaxBytes = 16L * 1024 * 1024;
        public const long MaximumMaxBytes = 64L * 1024 * 1024;
        private const int BufferBytes = 64 * 1024;
        private readonly Dictionary<string, string> paths;
        private readonly long maxBytes;
        private readonly object gate = new object();
        private bool busy;
        private TemplateReadResourceOwner pendingCleanup;

        public int PendingCleanupCount
        { get { lock (gate) return pendingCleanup == null ? 0 : pendingCleanup.PendingCount; } }

        public FamilyTemplateCatalog(IEnumerable<FamilyTemplateLocation> locations,
            long maxBytes = DefaultMaxBytes)
        {
            if (locations == null) throw new ArgumentNullException("locations");
            if (maxBytes <= 0 || maxBytes > MaximumMaxBytes)
                throw new ArgumentOutOfRangeException("maxBytes");
            var captured = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (FamilyTemplateLocation location in locations)
            {
                if (captured.Count == 16) throw new ArgumentException("At most sixteen template locations are supported.", "locations");
                if (location == null) throw new ArgumentException("A template location is required.", "locations");
                string id = location.Id;
                string path = location.Path;
                if (String.IsNullOrWhiteSpace(id) || id.Length > 96 || id.IndexOf('\0') >= 0)
                    throw new ArgumentException("A bounded template ID is required.", "locations");
                if (captured.ContainsKey(id)) throw new ArgumentException("Template IDs must be unique.", "locations");
                captured.Add(id, NormalizeLocalPath(path));
            }
            if (captured.Count == 0) throw new ArgumentException("At least one template location is required.", "locations");
            paths = captured;
            this.maxBytes = maxBytes;
        }

        public FamilyTemplateObservation Inspect(string templateId)
        {
            string path;
            if (templateId == null || !paths.TryGetValue(templateId, out path))
                return Observation(templateId, null, FamilyTemplateState.Unknown, FamilyTemplateIssue.UnknownId, null, null);
            lock (gate)
            {
                if (busy) return ReadFailure(templateId, path, null);
                busy = true;
            }
            TemplateReadResourceOwner created = null;
            FamilyTemplateObservation result = null;
            try
            {
                TemplateReadResourceOwner previous;
                lock (gate) previous = pendingCleanup;
                if (previous != null && !previous.TryCleanup())
                    result = Observation(templateId, path, FamilyTemplateState.Unknown, FamilyTemplateIssue.CleanupFailure, null, null);
                else
                {
                    created = new TemplateReadResourceOwner();
                    lock (gate) pendingCleanup = created;
                    result = InspectConfigured(templateId, path, created);
                    created.RecordPrimary(result);
                }
            }
            finally
            {
                // A complete digest is released to callers only after both exact
                // owned resources explicitly complete cleanup. Failed references
                // remain attached to this catalog and block another file open.
                if (created != null)
                {
                    if (created.TryCleanup()) { lock (gate) pendingCleanup = null; }
                    else result = Observation(templateId, path, FamilyTemplateState.Unknown, FamilyTemplateIssue.CleanupFailure,
                        result == null ? null : result.ByteLength, null);
                }
                lock (gate) busy = false;
            }
            return result;
        }

        private FamilyTemplateObservation InspectConfigured(string templateId, string path, TemplateReadResourceOwner resources)
        {
            long? knownLength = null;
            try
            {
                FamilyTemplateIssue issue = CheckPath(path);
                if (issue != FamilyTemplateIssue.None)
                    return Observation(templateId, path, FamilyTemplateState.Rejected, issue, knownLength, null);
                FileFacts before = ReadFacts(path);
                knownLength = before.Length;
                if (before.Length == 0)
                    return Observation(templateId, path, FamilyTemplateState.Rejected, FamilyTemplateIssue.EmptyFile, knownLength, null);
                if (before.Length > maxBytes)
                    return Observation(templateId, path, FamilyTemplateState.TooLarge, FamilyTemplateIssue.OverBudget, knownLength, null);

                var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, BufferBytes, FileOptions.SequentialScan);
                resources.Track(stream);
                var sha = SHA256.Create();
                if (sha == null) return ReadFailure(templateId, path, knownLength);
                resources.Track(sha);
                {
                    if (stream.Length != before.Length) return Changed(templateId, path, knownLength);
                    var buffer = new byte[BufferBytes];
                    long remaining = before.Length;
                    while (remaining > 0)
                    {
                        int count = stream.Read(buffer, 0, (int)Math.Min((long)buffer.Length, remaining));
                        if (count == 0) return Changed(templateId, path, knownLength);
                        sha.TransformBlock(buffer, 0, count, buffer, 0);
                        remaining -= count;
                    }
                    if (stream.ReadByte() != -1 || stream.Length != before.Length)
                        return Changed(templateId, path, knownLength);
                    sha.TransformFinalBlock(new byte[0], 0, 0);

                    // Do not publish a complete digest if path observations changed
                    // or became unavailable after the bytes were read.
                    try
                    {
                        if (CheckPath(path) != FamilyTemplateIssue.None || !before.SameAs(ReadFacts(path)))
                            return Changed(templateId, path, knownLength);
                    }
                    catch (IOException) { return ReadFailure(templateId, path, knownLength); }
                    catch (UnauthorizedAccessException) { return ReadFailure(templateId, path, knownLength); }
                    catch (SecurityException) { return ReadFailure(templateId, path, knownLength); }
                    return Observation(templateId, path, FamilyTemplateState.BytesVerified, FamilyTemplateIssue.None,
                        knownLength, BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant());
                }
            }
            catch (FileNotFoundException) { return MissingOrChanged(templateId, path, knownLength); }
            catch (DirectoryNotFoundException) { return MissingOrChanged(templateId, path, knownLength); }
            catch (IOException) { return ReadFailure(templateId, path, knownLength); }
            catch (UnauthorizedAccessException) { return ReadFailure(templateId, path, knownLength); }
            catch (SecurityException) { return ReadFailure(templateId, path, knownLength); }
            catch (CryptographicException) { return ReadFailure(templateId, path, knownLength); }
        }

        private static string NormalizeLocalPath(string path)
        {
            if (String.IsNullOrWhiteSpace(path) || path.IndexOf('\0') >= 0 || path.Length < 4 ||
                !Char.IsLetter(path[0]) || path[1] != ':' || (path[2] != '\\' && path[2] != '/') ||
                path.IndexOf(':', 2) >= 0)
                throw new ArgumentException("Template paths must be local absolute drive paths.", "locations");
            string normalized;
            try { normalized = Path.GetFullPath(path); }
            catch (ArgumentException) { throw new ArgumentException("A valid template path is required.", "locations"); }
            catch (NotSupportedException) { throw new ArgumentException("A valid template path is required.", "locations"); }
            catch (PathTooLongException) { throw new ArgumentException("A valid template path is required.", "locations"); }
            if (!String.Equals(Path.GetExtension(normalized), ".rft", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Template paths must have the .rft suffix.", "locations");
            DriveType driveType;
            try { driveType = new DriveInfo(Path.GetPathRoot(normalized)).DriveType; }
            catch (IOException) { throw new ArgumentException("A local template drive is required.", "locations"); }
            catch (UnauthorizedAccessException) { throw new ArgumentException("A local template drive is required.", "locations"); }
            catch (SecurityException) { throw new ArgumentException("A local template drive is required.", "locations"); }
            if (driveType != DriveType.Fixed && driveType != DriveType.Removable &&
                driveType != DriveType.Ram && driveType != DriveType.CDRom)
                throw new ArgumentException("A local template drive is required.", "locations");
            return normalized;
        }

        private static FamilyTemplateIssue CheckPath(string path)
        {
            var parents = new List<string>();
            string parent = Path.GetDirectoryName(path);
            while (!String.IsNullOrEmpty(parent))
            {
                parents.Add(parent);
                string next = Path.GetDirectoryName(parent);
                if (String.Equals(parent, next, StringComparison.OrdinalIgnoreCase)) break;
                parent = next;
            }
            for (int index = parents.Count - 1; index >= 0; index--)
            {
                FileAttributes attributes = File.GetAttributes(parents[index]);
                if ((attributes & FileAttributes.ReparsePoint) != 0) return FamilyTemplateIssue.ReparsePoint;
                if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.Device) != 0)
                    return FamilyTemplateIssue.NonRegularFile;
            }
            FileAttributes leaf = File.GetAttributes(path);
            if ((leaf & FileAttributes.ReparsePoint) != 0) return FamilyTemplateIssue.ReparsePoint;
            if ((leaf & (FileAttributes.Directory | FileAttributes.Device)) != 0) return FamilyTemplateIssue.NonRegularFile;
            return FamilyTemplateIssue.None;
        }

        private sealed class FileFacts
        {
            internal long Length;
            internal DateTime CreatedUtc, LastWriteUtc;
            internal FileAttributes Attributes;
            internal bool SameAs(FileFacts other)
            {
                return Length == other.Length && CreatedUtc == other.CreatedUtc &&
                    LastWriteUtc == other.LastWriteUtc && Attributes == other.Attributes;
            }
        }

        private static FileFacts ReadFacts(string path)
        {
            var info = new FileInfo(path);
            info.Refresh();
            return new FileFacts { Length = info.Length, CreatedUtc = info.CreationTimeUtc,
                LastWriteUtc = info.LastWriteTimeUtc, Attributes = info.Attributes };
        }

        private static FamilyTemplateObservation Changed(string id, string path, long? length)
        { return Observation(id, path, FamilyTemplateState.Changed, FamilyTemplateIssue.FileChanged, length, null); }
        private static FamilyTemplateObservation MissingOrChanged(string id, string path, long? length)
        { return length.HasValue ? Changed(id, path, length) : Observation(id, path, FamilyTemplateState.NotFound, FamilyTemplateIssue.MissingFile, null, null); }
        private static FamilyTemplateObservation ReadFailure(string id, string path, long? length)
        { return Observation(id, path, FamilyTemplateState.Unknown, FamilyTemplateIssue.ReadFailure, length, null); }
        private static FamilyTemplateObservation Observation(string id, string path, FamilyTemplateState state,
            FamilyTemplateIssue issue, long? length, string sha)
        { return new FamilyTemplateObservation(id, path, state, issue, length, sha); }
    }

    // The production catalog owns one instance for its exact FileStream/SHA.
    // The small internal owner is independently tested through the friend console
    // assembly; there is no public arbitrary stream/factory injection endpoint.
    internal sealed class TemplateReadResourceOwner
    {
        private sealed class Entry { internal IDisposable Resource; internal bool Released; }
        private readonly object gate = new object();
        private readonly List<Entry> entries = new List<Entry>();
        private bool cleanupStarted, cleaning;
        private FamilyTemplateObservation primary;

        internal int PendingCount
        {
            get { lock (gate) { int count = 0; foreach (Entry entry in entries) if (!entry.Released) count++; return count; } }
        }
        internal FamilyTemplateObservation PrimaryObservation { get { lock (gate) return primary; } }
        internal void RecordPrimary(FamilyTemplateObservation observation)
        { lock (gate) { if (primary != null) throw new InvalidOperationException("Primary observation is already recorded."); primary = observation; } }
        internal void Track(IDisposable resource)
        {
            if (resource == null) throw new ArgumentNullException("resource");
            lock (gate)
            {
                if (cleanupStarted || entries.Count == 2) throw new InvalidOperationException("The bounded read owner cannot accept another resource.");
                foreach (Entry entry in entries) if (Object.ReferenceEquals(entry.Resource, resource)) throw new InvalidOperationException("A resource is already tracked.");
                entries.Add(new Entry { Resource = resource });
            }
        }
        internal bool TryCleanup()
        {
            Entry[] captured;
            lock (gate)
            {
                if (cleaning) return false;
                cleaning = true; cleanupStarted = true; captured = entries.ToArray();
            }
            try
            {
                // SHA is acquired second and released first. A failure must not
                // prevent a separately owned stream from being closed.
                for (int index = captured.Length - 1; index >= 0; index--)
                {
                    Entry entry = captured[index];
                    lock (gate) { if (entry.Released) continue; }
                    try { entry.Resource.Dispose(); lock (gate) { entry.Released = true; entry.Resource = null; } }
                    catch (Exception ex)
                    {
                        if (ex is OutOfMemoryException || ex is StackOverflowException || ex is System.Threading.ThreadAbortException) throw;
                        // Retain the exact resource and the independent primary
                        // observation. Arbitrary exception text is never emitted.
                    }
                }
            }
            finally { lock (gate) cleaning = false; }
            return PendingCount == 0;
        }
    }
}
