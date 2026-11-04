using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;

namespace BuildX.FamilyCore
{
    public enum ProjectIdentityReadiness { Unknown, Ready, NotReady }

    /// <summary>One trusted source observation, never a write capability.</summary>
    public sealed class ProjectDocumentFacts
    {
        public bool? IsValid { get; private set; }
        public bool? IsFamilyDocument { get; private set; }
        public bool? IsLinked { get; private set; }
        public bool? IsReadOnly { get; private set; }
        public string PersistentFingerprint { get; private set; }
        public int? NativeOpenHash { get; private set; }
        public ProjectDocumentFacts(bool? isValid, bool? isFamilyDocument, bool? isLinked,
            bool? isReadOnly, string persistentFingerprint, int? nativeOpenHash)
        {
            IsValid = isValid; IsFamilyDocument = isFamilyDocument; IsLinked = isLinked;
            IsReadOnly = isReadOnly; PersistentFingerprint = persistentFingerprint;
            NativeOpenHash = nativeOpenHash;
        }
    }

    /// <summary>
    /// Fixed trusted host adapter. Equality means the same currently open native
    /// document, including different managed wrappers. Hash/fingerprint/path/title
    /// are not substitutes. Callbacks must not mutate, save or close documents.
    /// </summary>
    public interface IProjectDocumentSource
    {
        ProjectDocumentFacts Inspect(object document);
        bool? SameOpenDocument(object first, object second);
    }

    public sealed class ProjectDocumentSnapshot
    {
        public string Handle { get; private set; }
        public string HostSession { get; private set; }
        public int HostPid { get; private set; }
        public string PersistentFingerprint { get; private set; }
        public ProjectDocumentFacts CurrentFacts { get; private set; }
        public string CurrentCode { get; private set; }
        public ProjectIdentityReadiness IdentityReadiness { get; private set; }
        public bool Invalidated { get; private set; }
        public bool IdentityConflict { get; private set; }
        public string IdentityConflictCode { get; private set; }
        public bool Retained { get; private set; }

        internal ProjectDocumentSnapshot(string handle, string hostSession, int hostPid,
            string fingerprint, ProjectDocumentFacts facts, string code,
            ProjectIdentityReadiness readiness, bool invalidated, bool identityConflict,
            string identityConflictCode, bool retained)
        {
            Handle = handle; HostSession = hostSession; HostPid = hostPid;
            PersistentFingerprint = fingerprint; CurrentFacts = facts; CurrentCode = code;
            IdentityReadiness = readiness; Invalidated = invalidated;
            IdentityConflict = identityConflict; IdentityConflictCode = identityConflictCode; Retained = retained;
        }
    }

    public sealed class ProjectDocumentResult
    {
        public bool Ok { get; private set; }
        public string Code { get; private set; }
        public ProjectDocumentSnapshot Snapshot { get; private set; }
        internal ProjectDocumentResult(bool ok, string code, ProjectDocumentSnapshot snapshot)
        { Ok = ok; Code = code; Snapshot = snapshot; }
    }

    /// <summary>
    /// Captures open-document identities only. Holds exact opaque resources but
    /// exposes immutable DTOs. No close/save/transaction/resolve API exists here.
    /// Sources are trusted callbacks, not an OS sandbox or physical identity proof.
    /// </summary>
    public sealed class ProjectDocumentRegistry
    {
        private sealed class Entry
        {
            internal string Handle;
            internal object Document;
            internal string Fingerprint;
            internal ProjectDocumentFacts CurrentFacts;
            internal string CurrentCode;
            internal ProjectIdentityReadiness Readiness;
            internal bool Invalidated;
            internal bool IdentityConflict;
            internal string IdentityConflictCode;
        }

        private readonly object gate = new object();
        private readonly string hostSession;
        private readonly int hostPid;
        private readonly IProjectDocumentSource source;
        private readonly int capacity;
        private readonly string handlePrefix;
        private readonly List<Entry> entries = new List<Entry>();
        private ulong nextHandleSequence;
        private bool busy;

        public ProjectDocumentRegistry(string hostSession, int hostPid,
            IProjectDocumentSource source, int capacity = 16)
        {
            if (!ValidText(hostSession, 128) || hostPid <= 0 || source == null || capacity < 1 || capacity > 64)
                throw new ArgumentException("A fixed host, trusted source and capacity from 1 to 64 are required.");
            this.hostSession = hostSession; this.hostPid = hostPid;
            this.source = source; this.capacity = capacity;
            handlePrefix = RandomPrefix();
        }

        public ProjectDocumentResult Capture(object document)
        {
            Entry[] candidates;
            lock (gate)
            {
                if (busy) return Failure("BUSY", null);
                if (document == null) return Failure("DOCUMENT_REQUIRED", null);
                busy = true; candidates = entries.ToArray();
                foreach (Entry candidate in candidates)
                    if (!candidate.Invalidated) MarkInspecting(candidate);
            }
            try
            {
                string incomingCode;
                ProjectDocumentFacts incoming = Inspect(document, out incomingCode);
                if (incomingCode != "IDENTITY_VERIFIED")
                {
                    // Reference identity is only used to attach a failed
                    // observation to the exact retained object, never to decide
                    // native document equality or merge wrappers.
                    foreach (Entry candidate in candidates)
                        if (Object.ReferenceEquals(candidate.Document, document))
                            ApplyObservation(candidate, incoming, incomingCode);
                    return Failure(incomingCode, null);
                }
                Entry matched = null;
                bool uncertain = false;
                foreach (Entry candidate in candidates)
                {
                    // Invalidated captures are terminal identities. A newly opened
                    // document must never reactivate their old handle.
                    if (candidate.Invalidated) continue;
                    string code;
                    ProjectDocumentFacts facts = Inspect(candidate.Document, out code);
                    ApplyObservation(candidate, facts, code);
                    if (candidate.Invalidated) continue;
                    if (candidate.Readiness != ProjectIdentityReadiness.Ready)
                    { uncertain = true; continue; }
                    bool? same;
                    try { same = source.SameOpenDocument(candidate.Document, document); }
                    catch { same = null; code = "EQUALITY_FAILED"; }
                    if (!same.HasValue)
                    {
                        lock (gate)
                        {
                            candidate.Readiness = ProjectIdentityReadiness.Unknown;
                            candidate.CurrentCode = code == "EQUALITY_FAILED" ? code : "EQUALITY_UNKNOWN";
                        }
                        uncertain = true; continue;
                    }
                    if (!same.Value) continue;
                    if (!String.Equals(candidate.Fingerprint, incoming.PersistentFingerprint, StringComparison.Ordinal))
                    {
                        lock (gate)
                        {
                            candidate.IdentityConflict = true;
                            candidate.IdentityConflictCode = "FINGERPRINT_CHANGED";
                            candidate.Readiness = ProjectIdentityReadiness.Unknown;
                            candidate.CurrentCode = "FINGERPRINT_CHANGED";
                        }
                        uncertain = true; continue;
                    }
                    if (matched != null && !Object.ReferenceEquals(matched, candidate))
                    {
                        lock (gate)
                        {
                            matched.IdentityConflict = true; candidate.IdentityConflict = true;
                            matched.IdentityConflictCode = candidate.IdentityConflictCode = "DUPLICATE_IDENTITY";
                            matched.Readiness = candidate.Readiness = ProjectIdentityReadiness.Unknown;
                            matched.CurrentCode = candidate.CurrentCode = "DUPLICATE_IDENTITY";
                        }
                        uncertain = true; continue;
                    }
                    matched = candidate;
                }
                if (uncertain) return Failure("CAPTURE_UNCERTAIN", matched);
                if (matched != null)
                {
                    ApplyObservation(matched, incoming, "IDENTITY_VERIFIED");
                    return Success("CAPTURED_EXISTING", matched);
                }
                lock (gate)
                {
                    if (entries.Count >= capacity) return Failure("CAPACITY", null);
                    if (nextHandleSequence == UInt64.MaxValue) return Failure("HANDLE_EXHAUSTED", null);
                    Entry created = new Entry { Handle = handlePrefix + (++nextHandleSequence).ToString("x16"), Document = document,
                        Fingerprint = incoming.PersistentFingerprint, CurrentFacts = incoming,
                        CurrentCode = "IDENTITY_VERIFIED", Readiness = ProjectIdentityReadiness.Ready };
                    entries.Add(created);
                    return Success("CAPTURED_NEW", created);
                }
            }
            finally
            {
                lock (gate)
                {
                    foreach (Entry candidate in candidates)
                        if (candidate.CurrentCode == "INSPECTING") candidate.CurrentCode = "NOT_RECHECKED";
                    busy = false;
                }
            }
        }

        public ProjectDocumentResult Check(string handle, string session, int pid)
        {
            Entry entry;
            ProjectDocumentResult guard = Begin(handle, session, pid, out entry);
            if (guard != null) return guard;
            try
            {
                string code;
                ProjectDocumentFacts facts = Inspect(entry.Document, out code);
                ApplyObservation(entry, facts, code);
                return entry.Readiness == ProjectIdentityReadiness.Ready ?
                    Success("IDENTITY_VERIFIED", entry) : Failure(entry.CurrentCode, entry);
            }
            finally { lock (gate) busy = false; }
        }

        public ProjectDocumentResult ReleaseInvalid(string handle, string session, int pid)
        {
            Entry entry;
            ProjectDocumentResult guard = Begin(handle, session, pid, out entry);
            if (guard != null) return guard;
            try
            {
                string code;
                ProjectDocumentFacts facts = Inspect(entry.Document, out code);
                ApplyObservation(entry, facts, code);
                if (facts == null || facts.IsValid != false)
                    return Failure("RELEASE_REQUIRES_INVALID", entry);
                lock (gate)
                {
                    entries.Remove(entry); entry.Document = null;
                    entry.CurrentCode = "RELEASED_INVALID";
                    return Success("RELEASED_INVALID", entry);
                }
            }
            finally { lock (gate) busy = false; }
        }

        /// <summary>Captured registry state only; no new host inspection.</summary>
        public ProjectDocumentResult Get(string handle, string session, int pid)
        {
            lock (gate)
            {
                if (!SameHost(session, pid)) return Failure("HOST_MISMATCH", null);
                Entry entry = Find(handle);
                return entry == null ? Failure("HANDLE_NOT_FOUND", null) : Success("SNAPSHOT", entry);
            }
        }

        private ProjectDocumentResult Begin(string handle, string session, int pid, out Entry entry)
        {
            lock (gate)
            {
                entry = null;
                if (!SameHost(session, pid)) return Failure("HOST_MISMATCH", null);
                if (busy) return Failure("BUSY", null);
                entry = Find(handle);
                if (entry == null) return Failure("HANDLE_NOT_FOUND", null);
                busy = true;
                // Do not expose previously Ready data as a current observation
                // while an external source call is still outstanding.
                MarkInspecting(entry);
                return null;
            }
        }

        private ProjectDocumentFacts Inspect(object document, out string code)
        {
            ProjectDocumentFacts facts;
            try { facts = source.Inspect(document); }
            catch { code = "INSPECTION_FAILED"; return null; }
            if (facts == null) { code = "INSPECTION_UNKNOWN"; return null; }
            if (facts.IsValid == false) { code = "DOCUMENT_INVALID"; return facts; }
            if (facts.IsValid != true) { code = "INSPECTION_INCOMPLETE"; return facts; }
            if (facts.IsFamilyDocument == true) { code = "NOT_PROJECT"; return facts; }
            if (facts.IsLinked == true) { code = "LINKED_DOCUMENT"; return facts; }
            if (facts.IsFamilyDocument != false || facts.IsLinked != false || !facts.IsReadOnly.HasValue ||
                !ValidText(facts.PersistentFingerprint, 1024))
            { code = "INSPECTION_INCOMPLETE"; return facts; }
            code = "IDENTITY_VERIFIED"; return facts;
        }

        private void ApplyObservation(Entry entry, ProjectDocumentFacts facts, string code)
        {
            lock (gate)
            {
                entry.CurrentFacts = facts; entry.CurrentCode = code;
                if (facts != null && facts.IsValid == false) entry.Invalidated = true;
                if (facts != null && facts.IsValid == true && ValidText(facts.PersistentFingerprint, 1024) &&
                    !String.Equals(entry.Fingerprint, facts.PersistentFingerprint, StringComparison.Ordinal))
                {
                    entry.IdentityConflict = true;
                    if (entry.IdentityConflictCode == null) entry.IdentityConflictCode = "FINGERPRINT_CHANGED";
                }
                if (entry.Invalidated)
                { entry.Readiness = ProjectIdentityReadiness.NotReady; if (code == "IDENTITY_VERIFIED") entry.CurrentCode = "DOCUMENT_INVALIDATED"; }
                else if (entry.IdentityConflict)
                { entry.Readiness = ProjectIdentityReadiness.Unknown; if (code == "IDENTITY_VERIFIED") entry.CurrentCode = "IDENTITY_CONFLICT"; }
                else if (code == "IDENTITY_VERIFIED") entry.Readiness = ProjectIdentityReadiness.Ready;
                else if (code == "NOT_PROJECT" || code == "LINKED_DOCUMENT") entry.Readiness = ProjectIdentityReadiness.NotReady;
                else entry.Readiness = ProjectIdentityReadiness.Unknown;
            }
        }

        private bool SameHost(string session, int pid)
        { return pid == hostPid && String.Equals(session, hostSession, StringComparison.Ordinal); }
        private static void MarkInspecting(Entry entry)
        {
            entry.Readiness = entry.Invalidated ? ProjectIdentityReadiness.NotReady : ProjectIdentityReadiness.Unknown;
            entry.CurrentFacts = null; entry.CurrentCode = "INSPECTING";
        }
        private Entry Find(string handle)
        {
            if (!ValidText(handle, 64)) return null;
            foreach (Entry entry in entries)
                if (String.Equals(entry.Handle, handle, StringComparison.Ordinal)) return entry;
            return null;
        }
        private ProjectDocumentResult Success(string code, Entry entry)
        { return new ProjectDocumentResult(true, code, Snapshot(entry)); }
        private ProjectDocumentResult Failure(string code, Entry entry)
        { return new ProjectDocumentResult(false, code, Snapshot(entry)); }
        private ProjectDocumentSnapshot Snapshot(Entry entry)
        {
            lock (gate)
            {
                return entry == null ? null : new ProjectDocumentSnapshot(entry.Handle, hostSession, hostPid,
                    entry.Fingerprint, entry.CurrentFacts, entry.CurrentCode, entry.Readiness,
                    entry.Invalidated, entry.IdentityConflict, entry.IdentityConflictCode, entry.Document != null);
            }
        }
        private static bool ValidText(string value, int maximum)
        { return !String.IsNullOrWhiteSpace(value) && value.Length <= maximum && value.IndexOf('\0') < 0; }
        private static string RandomPrefix()
        {
            byte[] bytes = new byte[24];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            StringBuilder text = new StringBuilder(48);
            foreach (byte value in bytes) text.Append(value.ToString("x2"));
            return text.ToString();
        }
    }
}
