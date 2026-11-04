using System;
using System.Threading;
using Autodesk.Revit.DB;
using BuildX.FamilyCore;

namespace BuildX.FamilyRevit
{
    /// <summary>
    /// Compile-only adapter prototype. Construct and call from a legal Revit
    /// API callback. A matching managed thread alone does not prove API context.
    /// No active-document lookup, creation, transaction, save, load or close.
    /// </summary>
    public sealed class RevitProjectDocuments
    {
        private readonly ProjectDocumentRegistry identities;

        public RevitProjectDocuments(string hostSession, int hostPid, int capacity = 16)
        {
            identities = new ProjectDocumentRegistry(hostSession, hostPid,
                new RevitProjectDocumentSource(Thread.CurrentThread.ManagedThreadId), capacity);
        }

        public ProjectDocumentResult Capture(Document document)
        { return identities.Capture(document); }

        public ProjectDocumentResult Check(string handle, string hostSession, int hostPid)
        { return identities.Check(handle, hostSession, hostPid); }

        // Releases only a verified-invalid registry record. It never closes a
        // user Document or performs any API cleanup of the underlying object.
        public ProjectDocumentResult ReleaseInvalid(string handle, string hostSession, int hostPid)
        { return identities.ReleaseInvalid(handle, hostSession, hostPid); }

        // Cached facts only; this method neither enters Revit nor authorizes a
        // mutation. It is distinct from a fresh Check.
        public ProjectDocumentResult Get(string handle, string hostSession, int hostPid)
        { return identities.Get(handle, hostSession, hostPid); }
    }

    internal sealed class RevitProjectDocumentSource : IProjectDocumentSource
    {
        private readonly int apiThreadId;
        internal RevitProjectDocumentSource(int apiThreadId) { this.apiThreadId = apiThreadId; }

        private void RequireCapturedThread()
        {
            if (Thread.CurrentThread.ManagedThreadId != apiThreadId)
                throw new InvalidOperationException("Project document access requires the captured API thread.");
        }

        public ProjectDocumentFacts Inspect(object value)
        {
            RequireCapturedThread();
            Document document = value as Document;
            if (document == null) throw new ArgumentException("A Revit Document is required.");
            return ProjectDocumentFactsReader.Read(
                delegate { return document.IsValidObject; },
                delegate { return document.IsFamilyDocument; },
                delegate { return document.IsLinked; },
                delegate { return document.IsReadOnly; },
                delegate
                {
                    ProjectInfo information = document.ProjectInformation;
                    return information != null && information.IsValidObject ? information.UniqueId : null;
                },
                // Diagnostic evidence only; failure cannot erase known flags
                // or make a complete project identity depend on a hash value.
                delegate { return document.GetHashCode(); });
        }

        public bool? SameOpenDocument(object left, object right)
        {
            RequireCapturedThread();
            Document leftDocument = left as Document;
            Document rightDocument = right as Document;
            if (leftDocument == null || rightDocument == null) return null;
            if (!leftDocument.IsValidObject || !rightDocument.IsValidObject) return null;
            // Revit 2024's documented Equals compares the current open native
            // document across wrapper instances. ReferenceEquals is not enough.
            return leftDocument.Equals(rightDocument);
        }
    }
}
