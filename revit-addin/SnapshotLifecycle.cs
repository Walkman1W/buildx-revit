using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

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
        private int poisoned;
        internal SnapshotLifecycle(string hostSession)
        {
            if (String.IsNullOrWhiteSpace(hostSession)) throw new ArgumentException("hostSession");
            host = hostSession; threadId = System.Threading.Thread.CurrentThread.ManagedThreadId;
        }
        private void CheckThread()
        {
            if (disposed) throw new InvalidOperationException("Snapshot host is disposed.");
            if (System.Threading.Interlocked.CompareExchange(ref poisoned, 0, 0) != 0)
            {
                if (threadId == System.Threading.Thread.CurrentThread.ManagedThreadId)
                {
                    foreach (Slot slot in documents.Values) if (slot.Owner != null) slot.Owner.Expire("event_lifecycle_fault");
                    documents.Clear();
                }
                throw new InvalidOperationException("Snapshot event lifecycle is untrusted.");
            }
            if (threadId != System.Threading.Thread.CurrentThread.ManagedThreadId) throw new InvalidOperationException("Snapshot lifecycle requires the owner UI thread.");
        }
        internal bool HasTrackedDocuments { get { CheckThread(); return documents.Count != 0; } }
        internal SnapshotChangeOwner Capture(object document, IEnumerable<SnapshotChangeOwner.Identity> completeEnumeration, int maxElements, int maxEvents)
        {
            CheckThread();
            if (document == null || completeEnumeration == null) throw new InvalidOperationException("Document or enumeration missing.");
            Slot old;
            if (documents.TryGetValue(document, out old) && old.Capturing) { old.ChangedDuringCapture = true; throw new InvalidOperationException("Reentrant capture."); }
            if (old != null && old.Owner != null) old.Owner.Expire("baseline_replaced");
            var slot = new Slot { Capturing = true }; documents[document] = slot;
            SnapshotChangeOwner owner = null;
            try
            {
                owner = SnapshotChangeOwner.Capture(host, document, completeEnumeration, maxElements, maxEvents);
                CheckThread();
                Slot current;
                if (slot.ChangedDuringCapture || !documents.TryGetValue(document, out current) || !Object.ReferenceEquals(current, slot))
                    throw new InvalidOperationException("Document changed during baseline enumeration.");
                slot.Owner = owner; return owner;
            }
            catch { if (owner != null) owner.Expire("baseline_capture_untrusted"); documents.Remove(document); throw; }
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
            CheckThread(); Slot slot;
            if (document == null || completeEnumeration == null) throw new InvalidOperationException("Document or enumeration missing.");
            if (documents.TryGetValue(document, out slot))
            {
                if (slot.Capturing) { slot.ChangedDuringCapture = true; throw new InvalidOperationException("Reentrant capture."); }
                if (slot.Owner != null && slot.Owner.Expiry == null) return slot.Owner;
            }
            return Capture(document, completeEnumeration(), maxElements, maxEvents);
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
                slot.Owner.Observe(host, document, slot.Owner.BaselineToken, added(), modified(), deleted());
            }
            catch { slot.Owner.Expire("event_identity_unavailable"); }
        }
        internal SnapshotChangeOwner.Page Read(object document, string token, long version, int offset, int limit)
        {
            CheckThread(); Slot slot;
            if (document == null || !documents.TryGetValue(document, out slot) || slot.Capturing || slot.Owner == null) throw new InvalidOperationException("No complete current baseline.");
            return slot.Owner.Read(host, document, token, version, offset, limit);
        }
        internal void Poison() { System.Threading.Interlocked.Exchange(ref poisoned, 1); }
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
