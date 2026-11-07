using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
namespace RevitLocalCodex
{
    // Internal host adapter. Disabled until a build-time host route and native
    // UI acceptance are explicitly approved. Input IDs are facts, not approval.
    internal static class DeleteReviewHostAdapter
    {
        internal static object Run(Document capturedDocument, string claimedRequestId, string hostSession, DateTime requestExpiryUtc,
            Dictionary<string, object> args, Func<Document> activeDocument, Func<object, object, bool?> sameDocument,
            Action<Document, string> requireProjectEdit, Func<string, string, bool> cancelled)
        {
            Guid request;
            if (capturedDocument == null || args == null || args.Count != 5 || args.Keys.Any(k => !new[] { "expected_document", "mode", "target_kind", "target_id", "target_unique_id" }.Contains(k)) ||
                !Guid.TryParseExact(claimedRequestId, "D", out request) || claimedRequestId.Length != 36 || claimedRequestId[14] != '4' || "89abAB".IndexOf(claimedRequestId[19]) < 0 ||
                hostSession == null || hostSession.Length != 32 || hostSession.Any(c => !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) ||
                activeDocument == null || sameDocument == null || requireProjectEdit == null || cancelled == null || requestExpiryUtc.Kind != DateTimeKind.Utc)
                throw new InvalidOperationException("Delete candidate host context is invalid.");
            string path = args["expected_document"] as string, mode = args["mode"] as string, kind = args["target_kind"] as string, uniqueId = args["target_unique_id"] as string;
            if (String.IsNullOrWhiteSpace(path) || !(mode == "rollback" || mode == "commit") || !(kind == "sheet" || kind == "element") || String.IsNullOrWhiteSpace(uniqueId) || uniqueId.Length > 256)
                throw new InvalidOperationException("Delete candidate arguments are invalid.");
            long id = NativeModelQueries.ExactId(args, "target_id");
            Func<bool> current = () => {
                try {
                    if (DateTime.UtcNow >= requestExpiryUtc || cancelled(claimedRequestId, hostSession)) return false;
                    Document active = activeDocument();
                    if (active == null || sameDocument(capturedDocument, active) != true || sameDocument(capturedDocument, capturedDocument) != true) return false;
                    requireProjectEdit(active, path);
                    return true;
                } catch { return false; }
            };
            if (!current()) throw new InvalidOperationException("Delete candidate was cancelled or document/access changed before starting.");
            DeleteNativeReviewWorkflow.Result result = DeleteNativeReviewWorkflow.Execute(capturedDocument, path, id, uniqueId, claimedRequestId, hostSession, kind, mode, current);
            if (!current())
            {
                if (result.Status != "preview_declined") throw new DeleteRollbackPreview.RollbackUnknownException(new InvalidOperationException("Identity changed after the operation."));
                throw new InvalidOperationException("Delete review context changed before preview.");
            }
            var preview = result.Preview;
            return new { operation = "internal_delete_review_candidate", request_id = claimedRequestId, hostSession = hostSession,
                document = new { title = capturedDocument.Title, path = capturedDocument.PathName }, status = result.Status, mode,
                affected = preview == null ? null : preview.Deleted.Select(row => new { element_id = row.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), unique_id = row.UniqueId }).ToArray(),
                target_id = id.ToString(System.Globalization.CultureInfo.InvariantCulture), target_unique_id = uniqueId,
                target_kind = kind, preview_expires_utc = preview == null ? null : preview.ExpiresUtc };
        }
    }
}
