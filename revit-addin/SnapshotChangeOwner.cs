using System;
using System.Collections.Generic;
using System.Linq;
using System.Diagnostics;

namespace RevitLocalCodex
{
    internal sealed class SnapshotBudget
    {
        internal readonly Func<long> Clock; internal readonly long Frequency; private readonly long start; private readonly int milliseconds;
        internal SnapshotBudget(Func<long> clock, long frequency, int milliseconds)
        { if (clock == null || frequency <= 0 || milliseconds <= 0) throw new ArgumentException("Invalid snapshot budget."); Clock=clock; Frequency=frequency; this.milliseconds=milliseconds; start=clock(); }
        internal void Check() { long now=Clock(); if (now < start || ((double)now-start)*1000.0/Frequency >= milliseconds) throw new InvalidOperationException("Snapshot time budget exceeded."); }
    }
    // Unregistered, in-memory primitive. Its caller must own the Revit document
    // event lifecycle and call Expire on close, missed events, or host shutdown.
    // Pages describe observed events, not net semantic model changes.
    internal sealed class SnapshotChangeOwner
    {
        internal sealed class Identity
        {
            internal readonly long Id;
            internal readonly string UniqueId;
            internal Identity(long id, string uniqueId) { Id = id; UniqueId = uniqueId; }
        }
        internal sealed class Entry
        {
            internal readonly long Version;
            internal readonly string Kind;
            internal readonly long Id;
            internal readonly string UniqueId;
            internal Entry(long version, string kind, long id, string uid) { Version = version; Kind = kind; Id = id; UniqueId = uid; }
        }
        internal sealed class Page
        {
            internal readonly string BaselineToken;
            internal readonly long Version;
            internal readonly int Offset, Total;
            internal readonly Entry[] Items;
            internal bool HasMore { get { return Offset + Items.Length < Total; } }
            internal Page(string token, long version, int offset, int total, Entry[] items) { BaselineToken = token; Version = version; Offset = offset; Total = total; Items = items; }
        }
        private readonly object document;
        private readonly string hostSession, baselineToken;
        private readonly int maxElements, maxEvents;
        private Dictionary<long, string> elements;
        private readonly List<Entry> events = new List<Entry>();
        private readonly int baselineCount;
        private readonly Func<long> clock; private readonly long frequency;
        private long version;
        private string expiry;
        internal string BaselineToken { get { return baselineToken; } }
        internal long Version { get { return version; } }
        internal int BaselineCount { get { return baselineCount; } }
        internal string Expiry { get { return expiry; } }

        private SnapshotChangeOwner(string host, object doc, int elementLimit, int eventLimit, Dictionary<long, string> baseline, Func<long> clock, long frequency)
        {
            hostSession = host; document = doc; maxElements = elementLimit; maxEvents = eventLimit; elements = baseline; this.clock=clock; this.frequency=frequency;
            baselineToken = Guid.NewGuid().ToString("N"); baselineCount = baseline.Count;
        }
        private static bool Valid(Identity item)
        {
            return item != null && item.Id > 0 && !String.IsNullOrWhiteSpace(item.UniqueId) && item.UniqueId.Length <= 256 &&
                String.Equals(item.UniqueId, item.UniqueId.Trim(), StringComparison.Ordinal) && !item.UniqueId.Any(Char.IsControl);
        }
        // Enumeration must complete without exceptions and within budget; no
        // partial baseline object escapes on enumeration or identity failure.
        internal static SnapshotChangeOwner Capture(string host, object doc, IEnumerable<Identity> source, int maxElements, int maxEvents)
        {
            return Capture(host, doc, source, maxElements, maxEvents, new SnapshotBudget(Stopwatch.GetTimestamp, Stopwatch.Frequency, 1000));
        }
        internal static SnapshotChangeOwner Capture(string host, object doc, IEnumerable<Identity> source, int maxElements, int maxEvents, SnapshotBudget budget)
        {
            if (String.IsNullOrWhiteSpace(host) || doc == null || source == null || maxElements < 1 || maxElements > 100000 || maxEvents < 1 || maxEvents > 100000 || budget == null)
                throw new InvalidOperationException("Invalid baseline identity or bounds.");
            budget.Check();
            var baseline = new Dictionary<long, string>(); var uids = new HashSet<string>(StringComparer.Ordinal);
            foreach (Identity item in source)
            {
                budget.Check();
                if (baseline.Count >= maxElements || !Valid(item) || baseline.ContainsKey(item.Id) || !uids.Add(item.UniqueId))
                    throw new InvalidOperationException("Baseline incomplete, duplicate or over budget.");
                baseline.Add(item.Id, item.UniqueId);
            }
            budget.Check();
            return new SnapshotChangeOwner(host, doc, maxElements, maxEvents, baseline, budget.Clock, budget.Frequency);
        }
        private void Require(string host, object doc, string token)
        {
            if (expiry != null) throw new InvalidOperationException("Baseline expired: " + expiry);
            if (!String.Equals(hostSession, host, StringComparison.Ordinal) || !Object.ReferenceEquals(document, doc) || !String.Equals(baselineToken, token, StringComparison.Ordinal))
                throw new InvalidOperationException("Baseline identity mismatch.");
        }
        internal void Expire(string reason)
        {
            if (expiry == null) expiry = String.IsNullOrWhiteSpace(reason) ? "unknown" : reason;
            elements.Clear(); events.Clear();
        }
        // Batches are prepared without mutating the live owner. Any incomplete,
        // conflicting or over-budget batch invalidates the whole baseline.
        internal void Observe(string host, object doc, string token, IEnumerable<Identity> added, IEnumerable<Identity> modified, IEnumerable<long> deleted)
        {
            Observe(host, doc, token, added, modified, deleted, new SnapshotBudget(clock, frequency, 150));
        }
        internal void Observe(string host, object doc, string token, IEnumerable<Identity> added, IEnumerable<Identity> modified, IEnumerable<long> deleted, SnapshotBudget budget)
        {
            Require(host, doc, token);
            try
            {
                if (budget == null) throw new InvalidOperationException("Event budget unavailable.");
                budget.Check();
                if (added == null || modified == null || deleted == null) throw new InvalidOperationException("Event unavailable.");
                var next = new Dictionary<long, string>(elements); var uidSet = new HashSet<string>(next.Values, StringComparer.Ordinal);
                budget.Check();
                var seen = new HashSet<long>(); var batch = new List<Entry>();
                if (version >= 9007199254740991L) throw new InvalidOperationException("Version budget exceeded.");
                long nextVersion = checked(version + 1);
                foreach (long id in deleted)
                {
                    budget.Check();
                    string uid;
                    if (id <= 0 || !seen.Add(id) || !next.TryGetValue(id, out uid)) throw new InvalidOperationException("Unknown or duplicate deleted identity.");
                    next.Remove(id); uidSet.Remove(uid); batch.Add(new Entry(nextVersion, "deleted", id, uid));
                    if (batch.Count > maxEvents - events.Count) throw new InvalidOperationException("Event budget exceeded.");
                }
                foreach (Identity item in added)
                {
                    budget.Check();
                    if (!Valid(item) || !seen.Add(item.Id) || next.ContainsKey(item.Id) || !uidSet.Add(item.UniqueId) || next.Count >= maxElements) throw new InvalidOperationException("Invalid or duplicate added identity.");
                    next.Add(item.Id, item.UniqueId); batch.Add(new Entry(nextVersion, "added", item.Id, item.UniqueId));
                    if (batch.Count > maxEvents - events.Count) throw new InvalidOperationException("Event budget exceeded.");
                }
                foreach (Identity item in modified)
                {
                    budget.Check();
                    string uid;
                    if (!Valid(item) || !seen.Add(item.Id) || !next.TryGetValue(item.Id, out uid) || !String.Equals(uid, item.UniqueId, StringComparison.Ordinal)) throw new InvalidOperationException("Invalid or changed modified identity.");
                    batch.Add(new Entry(nextVersion, "modified", item.Id, item.UniqueId));
                    if (batch.Count > maxEvents - events.Count) throw new InvalidOperationException("Event budget exceeded.");
                }
                budget.Check();
                elements = next; events.AddRange(batch); version = nextVersion;
            }
            catch { Expire("event_incomplete_or_overflow"); throw; }
        }
        // A page belongs to one exact retained version; a concurrent observed
        // transaction invalidates continuation instead of mixing revisions.
        internal Page Read(string host, object doc, string token, long expectedVersion, int offset, int limit)
        {
            Require(host, doc, token);
            if (expectedVersion != version) throw new InvalidOperationException("Snapshot version changed; restart pagination.");
            if (offset < 0 || offset > events.Count || limit < 1 || limit > 100) throw new InvalidOperationException("Invalid page bounds.");
            return new Page(baselineToken, version, offset, events.Count, events.Skip(offset).Take(limit).ToArray());
        }
    }
}
