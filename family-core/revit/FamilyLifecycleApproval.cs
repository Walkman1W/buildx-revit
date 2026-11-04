using System;
using System.Collections.Generic;
using System.Globalization;
using System.Diagnostics;

namespace BuildX.FamilyRevit
{
    // Lives only in one native host process. It issues distinct, single-use
    // operation capabilities for one observed state. No input from the model
    // or HTTP client can create an entry in this book.
    internal sealed class FamilyLifecycleApprovalBook
    {
        private sealed class Entry
        {
            internal string Snapshot, SaveToken, CloseToken;
            internal long Version;
            internal DateTime ExpiresUtc;
            internal long IssuedTick;
        }
        private readonly Dictionary<string, Entry> entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        private readonly Func<long> monotonicNow;
        private readonly long monotonicFrequency;
        internal FamilyLifecycleApprovalBook() : this(Stopwatch.GetTimestamp, Stopwatch.Frequency) { }
        internal FamilyLifecycleApprovalBook(Func<long> clock, long frequency)
        { if (clock == null || frequency <= 0) throw new ArgumentException("A monotonic clock is required."); monotonicNow = clock; monotonicFrequency = frequency; }
        private bool Expired(Entry entry, long tick)
        { return tick < entry.IssuedTick || ((double)tick - entry.IssuedTick) / monotonicFrequency >= 90.0; }
        private long version;
        private bool healthy = true;
        internal string Version { get { return version.ToString(CultureInfo.InvariantCulture); } }
        internal bool Healthy { get { return healthy; } }
        internal void Changed()
        {
            entries.Clear();
            if (version == Int64.MaxValue) { healthy = false; return; }
            version++;
        }
        internal void Disable() { healthy = false; entries.Clear(); }
        internal object Issue(string job, string snapshot, object review, DateTime now)
        {
            if (!healthy || String.IsNullOrEmpty(job) || String.IsNullOrEmpty(snapshot) || now.Kind != DateTimeKind.Utc) return null;
            long tick = monotonicNow();
            Entry entry;
            if (!entries.TryGetValue(job, out entry) || entry.Version != version || entry.Snapshot != snapshot || Expired(entry, tick))
            {
                entry = new Entry { Snapshot = snapshot, Version = version, ExpiresUtc = now.AddSeconds(90), IssuedTick = tick,
                    SaveToken = Guid.NewGuid().ToString("N"), CloseToken = Guid.NewGuid().ToString("N") };
                entries[job] = entry;
            }
            return new { schema_version = 1, change_version = Version, expires_utc = entry.ExpiresUtc.ToString("o", CultureInfo.InvariantCulture),
                save_token = entry.SaveToken, close_token = entry.CloseToken, review };
        }
        internal bool Consume(string job, string snapshot, string operation, string token, DateTime now)
        {
            Entry entry;
            if (!healthy || now.Kind != DateTimeKind.Utc || !entries.TryGetValue(job, out entry)) return false;
            string expected = operation == "family_save_job" ? entry.SaveToken : operation == "family_close_job" ? entry.CloseToken : null;
            bool match = expected != null && token == expected && !Expired(entry, monotonicNow()) && entry.Version == version && entry.Snapshot == snapshot;
            // A stale or mismatched request never keeps the old confirmation
            // usable. A valid request consumes both operation tokens once.
            entries.Remove(job);
            return match;
        }
    }
}
