using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;

namespace RevitLocalCodex
{
    // Created on host startup before any baseline can be requested. The named
    // query requires the host's atomic read and dedicated capability checks.
    internal sealed class SnapshotRevitBridge : IDisposable
    {
        private readonly ControlledApplication application;
        private readonly SnapshotLifecycle lifecycle;
        private readonly HashSet<int> closing = new HashSet<int>();
        private bool disposed;
        internal SnapshotRevitBridge(ControlledApplication app, string hostSession)
        {
            if (app == null) throw new ArgumentNullException("app");
            application = app; lifecycle = new SnapshotLifecycle(hostSession);
            try { application.DocumentChanged += OnChanged; application.DocumentClosing += OnClosing; application.DocumentClosed += OnClosed; }
            catch
            {
                disposed = true;
                try { application.DocumentChanged -= OnChanged; } catch { }
                try { application.DocumentClosing -= OnClosing; } catch { }
                try { application.DocumentClosed -= OnClosed; } catch { }
                try { lifecycle.Dispose(); } catch { }
                throw;
            }
        }
        private static IEnumerable<SnapshotChangeOwner.Identity> FullEnumeration(Document doc)
        {
            using (var collector = new FilteredElementCollector(doc).WherePasses(new LogicalOrFilter(new ElementIsElementTypeFilter(false), new ElementIsElementTypeFilter(true))))
                foreach (Element element in collector)
                {
                    if (element == null || !element.IsValidObject || element.Document == null || !element.Document.Equals(doc) || element.Id == null)
                        throw new InvalidOperationException("An element identity could not be established during baseline enumeration.");
                    yield return new SnapshotChangeOwner.Identity(element.Id.Value, element.UniqueId);
                }
        }
        private static IEnumerable<SnapshotChangeOwner.Identity> Resolve(Document doc, ICollection<ElementId> ids)
        {
            if (ids == null) throw new InvalidOperationException("Event IDs unavailable.");
            foreach (ElementId id in ids)
            {
                if (id == null) throw new InvalidOperationException("Event ID unavailable.");
                Element element = doc.GetElement(id);
                if (element == null || !element.IsValidObject || element.Id == null || element.Id.Value != id.Value || element.Document == null || !element.Document.Equals(doc))
                    throw new InvalidOperationException("Event element identity unavailable.");
                yield return new SnapshotChangeOwner.Identity(id.Value, element.UniqueId);
            }
        }
        private static IEnumerable<long> Deleted(ICollection<ElementId> ids)
        {
            if (ids == null) throw new InvalidOperationException("Deleted event IDs unavailable.");
            foreach (ElementId id in ids) { if (id == null) throw new InvalidOperationException("Deleted event ID unavailable."); yield return id.Value; }
        }
        internal SnapshotChangeOwner Capture(Document doc, int maxElements, int maxEvents)
        {
            if (doc == null || !doc.IsValidObject) throw new InvalidOperationException("An open document is required.");
            return lifecycle.Capture(doc, FullEnumeration(doc), maxElements, maxEvents);
        }
        internal SnapshotChangeOwner StartOrCurrent(Document doc, int maxElements, int maxEvents)
        {
            if (doc == null || !doc.IsValidObject) throw new InvalidOperationException("An open document is required.");
            return lifecycle.StartOrCurrent(doc, () => FullEnumeration(doc), maxElements, maxEvents);
        }
        internal SnapshotChangeOwner.Page Read(Document doc, string token, long version, int offset, int limit)
        {
            if (doc == null || !doc.IsValidObject) throw new InvalidOperationException("An open document is required.");
            return lifecycle.Read(doc, token, version, offset, limit);
        }
        // Called only from the host's dedicated atomic-read candidate route.
        internal object Query(Document doc, Dictionary<string, object> args)
        {
            if (args == null || args.Keys.Any(k => k != "expected_document" && k != "action" && k != "baseline_token" && k != "expected_version" && k != "offset" && k != "limit"))
                throw new InvalidOperationException("Invalid snapshot query fields.");
            object raw; if (!args.TryGetValue("action", out raw) || !(raw is string)) throw new InvalidOperationException("Snapshot action required.");
            string action = (string)raw;
            if (action == "status" || action == "start")
            {
                if (args.Count != 2 || !args.ContainsKey("expected_document")) throw new InvalidOperationException("Status and start do not accept pagination arguments.");
                SnapshotChangeOwner owner = action == "start" ? StartOrCurrent(doc, 50000, 5000) : lifecycle.Current(doc);
                return new { schema_version = 1, state = owner == null ? "none" : owner.Expiry == null ? "active" : "expired", baseline_token = owner == null ? null : owner.BaselineToken, version = owner == null ? (long?)null : owner.Version, baseline_count = owner == null ? (int?)null : owner.BaselineCount, reason = owner == null ? null : owner.Expiry };
            }
            if (action != "page" || args.Count != 6 || !args.ContainsKey("expected_document")) throw new InvalidOperationException("Snapshot page requires a token, version, offset and limit.");
            string token = args.ContainsKey("baseline_token") ? args["baseline_token"] as string : null;
            Guid parsed; if (!Guid.TryParseExact(token, "N", out parsed) || token != token.ToLowerInvariant()) throw new InvalidOperationException("Invalid baseline token.");
            long version = ExactPageNumber(args, "expected_version", 0, 9007199254740991L);
            int offset = (int)ExactPageNumber(args, "offset", 0, 5000), limit = (int)ExactPageNumber(args, "limit", 1, 100);
            SnapshotChangeOwner.Page page = Read(doc, token, version, offset, limit);
            return new { schema_version = 1, state = "active", baseline_token = page.BaselineToken, version = page.Version, offset = page.Offset, limit = limit, total = page.Total, has_more = page.HasMore,
                items = page.Items.Select(item => new { version = item.Version, kind = item.Kind, element_id = item.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), unique_id = item.UniqueId }).ToArray() };
        }
        private static long ExactPageNumber(Dictionary<string, object> args, string key, long min, long max)
        {
            object value; if (!args.TryGetValue(key, out value) || !(value is int || value is long || value is double || value is decimal)) throw new InvalidOperationException("Invalid snapshot page number.");
            decimal number = Convert.ToDecimal(value, System.Globalization.CultureInfo.InvariantCulture);
            if (number < min || number > max || Decimal.Truncate(number) != number) throw new InvalidOperationException("Invalid snapshot page bounds.");
            return (long)number;
        }
        private void OnChanged(object sender, DocumentChangedEventArgs e)
        {
            if (disposed) return;
            try
            {
                if (!lifecycle.HasTrackedDocuments) return;
                if (e == null || !e.IsValidObject) { lifecycle.Poison(); return; }
                Document doc = e.GetDocument();
                if (doc == null || !doc.IsValidObject) { lifecycle.Poison(); return; }
                lifecycle.Observe(doc, () => Resolve(doc, e.GetAddedElementIds()), () => Resolve(doc, e.GetModifiedElementIds()), () => Deleted(e.GetDeletedElementIds()));
            }
            catch { lifecycle.Poison(); }
        }
        private void OnClosing(object sender, DocumentClosingEventArgs e)
        {
            if (disposed) return;
            try { if (!lifecycle.HasTrackedDocuments) return; if (e == null || !e.IsValidObject || e.Document == null || !closing.Add(e.DocumentId)) { lifecycle.Poison(); return; } lifecycle.Close(e.Document); }
            catch { lifecycle.Poison(); }
        }
        private void OnClosed(object sender, DocumentClosedEventArgs e)
        {
            if (disposed) return;
            try { if (closing.Count == 0 && !lifecycle.HasTrackedDocuments) return; if (e == null || !e.IsValidObject || !closing.Remove(e.DocumentId)) lifecycle.Poison(); }
            catch { lifecycle.Poison(); }
        }
        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            try { application.DocumentChanged -= OnChanged; } catch { }
            try { application.DocumentClosing -= OnClosing; } catch { }
            try { application.DocumentClosed -= OnClosed; } catch { }
            try { lifecycle.Dispose(); } catch { lifecycle.Poison(); }
            closing.Clear();
        }
    }
}
