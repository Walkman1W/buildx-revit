using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;

namespace RevitLocalCodex
{
    // Created on host startup before any baseline can be requested. This owner is
    // intentionally not exposed as an MCP operation until receipt and capability
    // ownership have been implemented and verified.
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
            catch { application.DocumentChanged -= OnChanged; application.DocumentClosing -= OnClosing; application.DocumentClosed -= OnClosed; lifecycle.Dispose(); throw; }
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
        internal SnapshotChangeOwner.Page Read(Document doc, string token, long version, int offset, int limit)
        {
            if (doc == null || !doc.IsValidObject) throw new InvalidOperationException("An open document is required.");
            return lifecycle.Read(doc, token, version, offset, limit);
        }
        private void OnChanged(object sender, DocumentChangedEventArgs e)
        {
            try
            {
                if (e == null || !e.IsValidObject) { lifecycle.Poison(); return; }
                Document doc = e.GetDocument();
                if (doc == null || !doc.IsValidObject) { lifecycle.Poison(); return; }
                lifecycle.Observe(doc, () => Resolve(doc, e.GetAddedElementIds()), () => Resolve(doc, e.GetModifiedElementIds()), () => Deleted(e.GetDeletedElementIds()));
            }
            catch { lifecycle.Poison(); }
        }
        private void OnClosing(object sender, DocumentClosingEventArgs e)
        {
            try { if (e == null || !e.IsValidObject || e.Document == null || !closing.Add(e.DocumentId)) { lifecycle.Poison(); return; } lifecycle.Close(e.Document); }
            catch { lifecycle.Poison(); }
        }
        private void OnClosed(object sender, DocumentClosedEventArgs e)
        {
            try { if (e == null || !e.IsValidObject || !closing.Remove(e.DocumentId)) lifecycle.Poison(); }
            catch { lifecycle.Poison(); }
        }
        public void Dispose()
        {
            if (disposed) return;
            application.DocumentChanged -= OnChanged; application.DocumentClosing -= OnClosing; application.DocumentClosed -= OnClosed;
            lifecycle.Dispose(); closing.Clear(); disposed = true;
        }
    }
}
