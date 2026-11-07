using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Diagnostics;

namespace RevitLocalCodex
{
    // Unregistered bridge state; all public entry points must be called from the
    // Revit UI thread. Host event adapter owns subscription and disposal.
    internal sealed class SnapshotLifecycle : IDisposable
    {
        private sealed class ReferenceComparer : IEqualityComparer<object>
        {
            public new bool Equals(object a, object b) { return Object.ReferenceEquals(a, b); }
            public int GetHashCode(object value) { return RuntimeHelpers.GetHashCode(value); }
        }
        private sealed class Slot { internal SnapshotChangeOwner Owner; internal bool Capturing, ChangedDuringCapture; }
        private readonly Dictionary<object, Slot> documents = new Dictionary<object, Slot>(new ReferenceComparer());
        private readonly string host;
        private readonly int threadId;
        private bool disposed;
        private long faultGeneration, acceptedGeneration;
        private readonly Func<long> clock; private readonly long frequency;
        internal SnapshotLifecycle(string hostSession) : this(hostSession, Stopwatch.GetTimestamp, Stopwatch.Frequency) { }
        internal SnapshotLifecycle(string hostSession, Func<long> monotonicClock, long clockFrequency)
        {
            if (String.IsNullOrWhiteSpace(hostSession) || monotonicClock == null || clockFrequency <= 0) throw new ArgumentException("hostSession or clock");
            host = hostSession; clock=monotonicClock; frequency=clockFrequency; threadId = System.Threading.Thread.CurrentThread.ManagedThreadId;
        }
        private void CheckThread()
        {
            if (disposed) throw new InvalidOperationException("Snapshot host is disposed.");
            if (System.Threading.Interlocked.Read(ref faultGeneration) != acceptedGeneration)
            {
                if (threadId == System.Threading.Thread.CurrentThread.ManagedThreadId)
                {
                    foreach (Slot slot in documents.Values) if (slot.Owner != null) slot.Owner.Expire("event_lifecycle_fault");
                    documents.Clear();
                }
                throw new InvalidOperationException("快照变更事件连续性已失效；请显式执行 action=start 重新建立完整基线，旧 token 不再有效。");
            }
            if (threadId != System.Threading.Thread.CurrentThread.ManagedThreadId) throw new InvalidOperationException("Snapshot lifecycle requires the owner UI thread.");
        }
        internal bool HasTrackedDocuments { get { CheckThread(); return documents.Count != 0; } }
        internal SnapshotChangeOwner Capture(object document, IEnumerable<SnapshotChangeOwner.Identity> completeEnumeration, int maxElements, int maxEvents)
        { return Capture(document, completeEnumeration, maxElements, maxEvents, new SnapshotBudget(clock, frequency, 1000)); }
        private SnapshotChangeOwner Capture(object document, IEnumerable<SnapshotChangeOwner.Identity> completeEnumeration, int maxElements, int maxEvents, SnapshotBudget budget)
        {
            CheckThread(); budget.Check();
            if (document == null || completeEnumeration == null) throw new InvalidOperationException("Document or enumeration missing.");
            Slot old;
            if (documents.TryGetValue(document, out old) && old.Capturing) { old.ChangedDuringCapture = true; throw new InvalidOperationException("Reentrant capture."); }
            if (old != null && old.Owner != null) old.Owner.Expire("baseline_replaced");
            var slot = new Slot { Capturing = true }; documents[document] = slot;
            SnapshotChangeOwner owner = null;
            try
            {
                owner = SnapshotChangeOwner.Capture(host, document, completeEnumeration, maxElements, maxEvents, budget);
                CheckThread();
                Slot current;
                if (slot.ChangedDuringCapture || !documents.TryGetValue(document, out current) || !Object.ReferenceEquals(current, slot))
                    throw new InvalidOperationException("Document changed during baseline enumeration.");
                slot.Owner = owner; return owner;
            }
            catch
            {
                if (owner != null) owner.Expire("baseline_capture_untrusted");
                Slot current; if (documents.TryGetValue(document, out current) && Object.ReferenceEquals(current, slot)) documents.Remove(document);
                throw;
            }
            finally { slot.Capturing = false; }
        }
        internal SnapshotChangeOwner Current(object document)
        {
            CheckThread(); Slot slot;
            if (document == null) throw new InvalidOperationException("Document missing.");
            if (!documents.TryGetValue(document, out slot)) return null;
            if (slot.Capturing) throw new InvalidOperationException("Baseline capture is in progress.");
            return slot.Owner;
        }
        internal SnapshotChangeOwner StartOrCurrent(object document, Func<IEnumerable<SnapshotChangeOwner.Identity>> completeEnumeration, int maxElements, int maxEvents)
        {
            if (disposed || threadId != System.Threading.Thread.CurrentThread.ManagedThreadId) throw new InvalidOperationException("Snapshot lifecycle requires the owner UI thread.");
            long observedFault = System.Threading.Interlocked.Read(ref faultGeneration);
            if (observedFault != acceptedGeneration)
            {
                foreach (Slot old in documents.Values) if (old.Owner != null) old.Owner.Expire("event_lifecycle_fault");
                documents.Clear(); acceptedGeneration = observedFault;
            }
            CheckThread(); Slot slot;
            if (document == null || completeEnumeration == null) throw new InvalidOperationException("Document or enumeration missing.");
            if (documents.TryGetValue(document, out slot))
            {
                if (slot.Capturing) { slot.ChangedDuringCapture = true; throw new InvalidOperationException("Reentrant capture."); }
                if (slot.Owner != null && slot.Owner.Expiry == null) return slot.Owner;
            }
            var budget = new SnapshotBudget(clock, frequency, 1000);
            var source = completeEnumeration(); budget.Check();
            return Capture(document, source, maxElements, maxEvents, budget);
        }
        internal void Observe(object document, Func<IEnumerable<SnapshotChangeOwner.Identity>> added, Func<IEnumerable<SnapshotChangeOwner.Identity>> modified, Func<IEnumerable<long>> deleted)
        {
            CheckThread(); Slot slot;
            if (document == null) { Poison(); return; }
            if (!documents.TryGetValue(document, out slot)) { if (documents.Count != 0) Poison(); return; }
            if (slot.Capturing) { slot.ChangedDuringCapture = true; return; }
            if (slot.Owner == null || slot.Owner.Expiry != null) return;
            try
            {
                if (added == null || modified == null || deleted == null) throw new InvalidOperationException("Event enumeration missing.");
                var budget = new SnapshotBudget(clock, frequency, 150);
                var addedValues = added(); budget.Check();
                var modifiedValues = modified(); budget.Check();
                var deletedValues = deleted(); budget.Check();
                slot.Owner.Observe(host, document, slot.Owner.BaselineToken, addedValues, modifiedValues, deletedValues, budget);
            }
            catch { slot.Owner.Expire("event_identity_unavailable"); }
        }
        internal SnapshotChangeOwner.Page Read(object document, string token, long version, int offset, int limit)
        {
            CheckThread(); Slot slot;
            if (document == null || !documents.TryGetValue(document, out slot) || slot.Capturing || slot.Owner == null) throw new InvalidOperationException("No complete current baseline.");
            return slot.Owner.Read(host, document, token, version, offset, limit);
        }
        internal void Poison() { System.Threading.Interlocked.Increment(ref faultGeneration); }
        internal void Close(object document)
        {
            CheckThread(); Slot slot;
            if (document == null) { Poison(); return; }
            if (!documents.TryGetValue(document, out slot)) { if (documents.Count != 0) Poison(); return; }
            slot.ChangedDuringCapture = true;
            if (slot.Owner != null) slot.Owner.Expire("document_closing");
            documents.Remove(document);
        }
        public void Dispose()
        {
            if (disposed) return;
            if (threadId != System.Threading.Thread.CurrentThread.ManagedThreadId) { Poison(); throw new InvalidOperationException("Snapshot disposal requires UI thread."); }
            foreach (Slot slot in documents.Values) if (slot.Owner != null) slot.Owner.Expire("host_stopped");
            documents.Clear(); disposed = true;
        }
    }
}
