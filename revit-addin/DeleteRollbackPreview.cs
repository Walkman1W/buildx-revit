using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    // Internal only: not registered or dispatchable. A successful result is a
    // rollback observation, not a delete authorization or a native permit.
    internal static class DeleteRollbackPreview
    {
        internal sealed class RollbackUnknownException : InvalidOperationException
        {
            internal RollbackUnknownException(Exception cause) : base("Delete preview rollback is unconfirmed; retain and inspect the original request.", cause) { }
        }
        internal sealed class Identity { internal long Id; internal string UniqueId; }
        internal sealed class Result
        {
            internal string RequestId, HostSession, DocumentPath, DocumentTitle, TargetUniqueId, TargetKind, ExpiresUtc;
            internal long TargetId;
            internal Identity[] Deleted;
        }
        internal static Result Capture(Document doc, string documentPath, long targetId, string targetUniqueId, string requestId, string hostSession)
        {
            return Capture(doc, documentPath, targetId, targetUniqueId, requestId, hostSession, "sheet");
        }
        internal static Result Capture(Document doc, string documentPath, long targetId, string targetUniqueId, string requestId, string hostSession, string targetKind)
        {
            Guid parsed;
            if (doc == null || !doc.IsValidObject || doc.IsFamilyDocument || doc.IsLinked || doc.IsReadOnly || String.IsNullOrWhiteSpace(documentPath) ||
                !String.Equals(doc.PathName, documentPath, StringComparison.Ordinal) || targetId <= 0 || String.IsNullOrWhiteSpace(targetUniqueId) ||
                !Guid.TryParseExact(requestId, "D", out parsed) || requestId.Length != 36 || requestId[14] != '4' || "89abAB".IndexOf(requestId[19]) < 0 || hostSession == null || hostSession.Length != 32 || hostSession.Any(c => !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))))
                throw new InvalidOperationException("Delete preview document, target or request identity is invalid.");
            string originalTitle = doc.Title;
            if (String.IsNullOrWhiteSpace(originalTitle)) throw new InvalidOperationException("Delete preview document title is unavailable.");
            Element target = doc.GetElement(new ElementId(targetId));
            if (!(targetKind == "sheet" || targetKind == "element") || target == null || !target.IsValidObject || target is ElementType ||
                targetKind == "sheet" && !(target is ViewSheet) || !String.Equals(target.UniqueId, targetUniqueId, StringComparison.Ordinal))
                throw new InvalidOperationException("Delete preview target identity is invalid.");
            var before = new Dictionary<long, string>();
            using (var collector = new FilteredElementCollector(doc))
            {
                foreach (Element element in collector)
                {
                    if (before.Count >= 100000) throw new InvalidOperationException("Delete preview identity scan exceeded its complete 100000 element limit.");
                    if (element == null || !element.IsValidObject || element.Id == null || element.Id.Value <= 0 || String.IsNullOrWhiteSpace(element.UniqueId) || before.ContainsKey(element.Id.Value))
                        throw new InvalidOperationException("Delete preview identity scan is incomplete or ambiguous.");
                    before.Add(element.Id.Value, element.UniqueId);
                }
            }
            string original;
            if (!before.TryGetValue(targetId, out original) || !String.Equals(original, targetUniqueId, StringComparison.Ordinal))
                throw new InvalidOperationException("Delete preview target is absent from complete identity scan.");
            Identity[] deleted = null; Exception failure = null; bool rolledBack = false;
            using (var group = new TransactionGroup(doc, "BuildX delete impact preview"))
            {
                if (group.Start() != TransactionStatus.Started) throw new InvalidOperationException("Delete preview transaction group did not start.");
                try
                {
                    using (var transaction = new Transaction(doc, "BuildX delete impact preview"))
                    {
                        if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Delete preview transaction did not start.");
                        try
                        {
                            ICollection<ElementId> result = doc.Delete(new ElementId(targetId));
                            if (result == null || result.Count == 0 || result.Count > 500 || result.Any(x => x == null || x.Value <= 0) || result.Select(x => x.Value).Distinct().Count() != result.Count || !result.Any(x => x.Value == targetId))
                                throw new InvalidOperationException("Delete preview returned an incomplete or oversized cascade.");
                            var identities = new List<Identity>();
                            foreach (ElementId id in result)
                            {
                                string uniqueId;
                                if (!before.TryGetValue(id.Value, out uniqueId)) throw new InvalidOperationException("A deleted element has no captured original identity.");
                                identities.Add(new Identity { Id = id.Value, UniqueId = uniqueId });
                            }
                            deleted = identities.OrderBy(x => x.Id).ToArray();
                            doc.Regenerate();
                            if (transaction.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Delete preview transaction did not commit internally.");
                        }
                        catch { if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack(); throw; }
                    }
                }
                catch (Exception error) { failure = error; }
                try { rolledBack = group.RollBack() == TransactionStatus.RolledBack && group.GetStatus() == TransactionStatus.RolledBack; }
                catch (Exception rollbackError) { throw new RollbackUnknownException(rollbackError); }
                if (!rolledBack) throw new RollbackUnknownException(failure);
            }
            if (failure != null) throw new InvalidOperationException("Delete preview failed after confirmed rollback.", failure);
            if (!doc.IsValidObject || !String.Equals(doc.PathName, documentPath, StringComparison.Ordinal) || !String.Equals(doc.Title, originalTitle, StringComparison.Ordinal))
                throw new RollbackUnknownException(new InvalidOperationException("Document identity changed after rollback."));
            foreach (Identity item in deleted)
            {
                Element restored = doc.GetElement(new ElementId(item.Id));
                if (restored == null || !restored.IsValidObject || !String.Equals(restored.UniqueId, item.UniqueId, StringComparison.Ordinal))
                    throw new RollbackUnknownException(new InvalidOperationException("Rollback did not restore an original element identity."));
            }
            return new Result { RequestId = requestId, HostSession = hostSession, DocumentPath = doc.PathName, DocumentTitle = doc.Title,
                TargetId = targetId, TargetUniqueId = targetUniqueId, TargetKind = targetKind, Deleted = deleted,
                ExpiresUtc = DateTime.UtcNow.AddSeconds(120).ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture) };
        }
    }
}
