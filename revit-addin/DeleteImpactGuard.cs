using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
namespace RevitLocalCodex
{
    // Comparison only. This type does not authorize or execute deletion, and
    // must never accept wire/caller-created preview objects as trusted facts.
    internal static class DeleteImpactGuard
    {
        internal static void VerifyBefore(Document doc, DeleteRollbackPreview.Result preview, string expectedRequest, string hostSession)
        {
            DateTime expiry;
            if (doc == null || !doc.IsValidObject || preview == null || preview.RequestId != expectedRequest || preview.HostSession != hostSession ||
                doc.PathName != preview.DocumentPath || doc.Title != preview.DocumentTitle || !(preview.TargetKind == "sheet" || preview.TargetKind == "element") ||
                !DateTime.TryParseExact(preview.ExpiresUtc, "yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out expiry) || expiry <= DateTime.UtcNow || expiry > DateTime.UtcNow.AddSeconds(120))
                throw new InvalidOperationException("Delete preview binding or validity has changed.");
            var ids = new HashSet<long>(); var uids = new HashSet<string>(StringComparer.Ordinal);
            if (preview.Deleted == null || preview.Deleted.Length < 1 || preview.Deleted.Length > 500) throw new InvalidOperationException("Invalid reviewed delete impact.");
            foreach (DeleteRollbackPreview.Identity identity in preview.Deleted)
            {
                if (identity == null || identity.Id <= 0 || String.IsNullOrWhiteSpace(identity.UniqueId) || !ids.Add(identity.Id) || !uids.Add(identity.UniqueId)) throw new InvalidOperationException("Reviewed identities are invalid or duplicated.");
                Element current = doc.GetElement(new ElementId(identity.Id));
                if (current == null || !current.IsValidObject || !String.Equals(current.UniqueId, identity.UniqueId, StringComparison.Ordinal)) throw new InvalidOperationException("Reviewed element identity changed.");
            }
            Element target = doc.GetElement(new ElementId(preview.TargetId));
            if (target == null || target is ElementType || preview.TargetKind == "sheet" && !(target is ViewSheet) || target.UniqueId != preview.TargetUniqueId || !ids.Contains(preview.TargetId))
                throw new InvalidOperationException("Reviewed delete target changed.");
        }
        internal static void VerifyDeleteResult(DeleteRollbackPreview.Result preview, ICollection<ElementId> deleted)
        {
            if (preview == null || preview.Deleted == null || deleted == null || deleted.Count != preview.Deleted.Length || deleted.Any(id => id == null || id.Value <= 0)) throw new InvalidOperationException("Delete result differs from reviewed impact.");
            var actual = new HashSet<long>(deleted.Select(id => id.Value));
            if (actual.Count != deleted.Count || preview.Deleted.Any(item => item == null || item.Id <= 0) || preview.Deleted.Select(item => item.Id).Distinct().Count() != preview.Deleted.Length || preview.Deleted.Any(item => !actual.Contains(item.Id))) throw new InvalidOperationException("Delete result differs from reviewed impact.");
        }
        internal static void VerifyAbsent(Document doc, DeleteRollbackPreview.Result preview)
        {
            if (doc == null || preview == null || preview.Deleted == null) throw new InvalidOperationException("Delete verification unavailable.");
            foreach (DeleteRollbackPreview.Identity identity in preview.Deleted)
                if (identity == null || doc.GetElement(new ElementId(identity.Id)) != null) throw new InvalidOperationException("Reviewed deleted element still exists.");
        }
    }
}
