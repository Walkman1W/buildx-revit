using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace RevitLocalCodex
{
    // Research primitive only. Not a user decision, persistent claim, or routed write.
    // The caller must obtain facts directly from the native producer and bind the
    // separately trusted panel decision before consuming a preparation.
    internal sealed class BatchFilterPreparationBook
    {
        private sealed class Entry { internal object Document; internal BatchFilterFactsGuard Guard; internal long Tick; internal string Mode; }
        private readonly Dictionary<string, Entry> entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        private readonly string host;
        private readonly Func<long> clock;
        private readonly long frequency;
        internal BatchFilterPreparationBook(string hostSession) : this(hostSession, Stopwatch.GetTimestamp, Stopwatch.Frequency) { }
        internal BatchFilterPreparationBook(string hostSession, Func<long> monotonicClock, long clockFrequency)
        {
            if (String.IsNullOrWhiteSpace(hostSession) || monotonicClock == null || clockFrequency <= 0) throw new ArgumentException("Host and monotonic clock required.");
            host = hostSession; clock = monotonicClock; frequency = clockFrequency;
        }
        private bool Expired(Entry entry, long now) { return now < entry.Tick || ((double)now - entry.Tick) / frequency >= 120.0; }
        internal string Issue(object document, object producerSnapshot, string storage, string unit, object value, string mode)
        {
            if (mode != "commit" && mode != "rollback") throw new InvalidOperationException("Explicit transaction mode required.");
            long now = clock(); var expired = new List<string>();
            foreach (var pair in entries) if (Expired(pair.Value, now)) expired.Add(pair.Key);
            foreach (string token in expired) entries.Remove(token);
            if (entries.Count >= 128) throw new InvalidOperationException("Preparation capacity exceeded.");
            var guard = BatchFilterFactsGuard.Create(host, document, producerSnapshot, storage, unit, value);
            string key = Guid.NewGuid().ToString("N");
            entries.Add(key, new Entry { Document = document, Guard = guard, Tick = now, Mode = mode });
            return key;
        }
        internal void Consume(string token, object document, object currentProducerSnapshot, string storage, string unit, object value, string mode)
        {
            Entry entry;
            if (String.IsNullOrEmpty(token) || !entries.TryGetValue(token, out entry)) throw new InvalidOperationException("Preparation missing or already consumed.");
            entries.Remove(token); // burn even on mismatch; never retry a disputed preparation
            if (Expired(entry, clock()) || !Object.ReferenceEquals(entry.Document, document) || entry.Mode != mode) throw new InvalidOperationException("Preparation expired or document changed.");
            entry.Guard.Compare(host, document, currentProducerSnapshot, storage, unit, value);
        }
    }
}
