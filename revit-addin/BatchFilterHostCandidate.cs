using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    // Unregistered host adapter candidate. The future WorkbenchHost integration
    // must supply these checks directly from its claimed-file, access-policy,
    // cancellation and deadline owners; they are never accepted from JSON.
    internal sealed class BatchFilterHostCandidate
    {
        private readonly string session;
        private readonly Func<string, bool> claimedAndCurrent, cancelled;
        private readonly Func<UIApplication, Document, bool> accessCurrent;
        private readonly HashSet<string> consumed = new HashSet<string>(StringComparer.Ordinal);
        private readonly int threadId;
        internal BatchFilterHostCandidate(string hostSession, Func<string, bool> claimedAndCurrent, Func<string, bool> cancelled, Func<UIApplication, Document, bool> accessCurrent)
        {
            if (hostSession == null || hostSession.Length != 32 || hostSession.Any(c => !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) || claimedAndCurrent == null || cancelled == null || accessCurrent == null)
                throw new InvalidOperationException("Host and trusted request owners are required.");
            session = hostSession; this.claimedAndCurrent = claimedAndCurrent; this.cancelled = cancelled; this.accessCurrent = accessCurrent;
            threadId = System.Threading.Thread.CurrentThread.ManagedThreadId;
        }
        internal object Run(UIApplication app, string requestId, string targetSession, Dictionary<string, object> args)
        {
            return RunCore(app, requestId, targetSession, args, WorkbenchActions.RunBatchFilterNativeReview);
        }
        // Injection is only for the isolated in-assembly peer; never expose this
        // entry, the delegates or any decision through an MCP/queue contract.
        internal object RunCore(UIApplication app, string requestId, string targetSession, Dictionary<string, object> args,
            Func<UIApplication, string, Dictionary<string, object>, Func<bool>, object> nativeWorkflow)
        {
            Guid parsed;
            if (System.Threading.Thread.CurrentThread.ManagedThreadId != threadId || !Guid.TryParseExact(requestId, "D", out parsed) || parsed.ToString("D") != requestId ||
                !String.Equals(targetSession, session, StringComparison.Ordinal) || app == null || app.ActiveUIDocument == null || app.ActiveUIDocument.Document == null || args == null || nativeWorkflow == null)
                throw new InvalidOperationException("Original claimed request or host identity is invalid.");
            Document document = app.ActiveUIDocument.Document; object path;
            if (!document.IsValidObject || !args.TryGetValue("expected_document", out path) || !(path is string) || String.IsNullOrWhiteSpace((string)path) || !String.Equals(document.PathName, (string)path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Original document identity is invalid.");
            if (consumed.Count >= 4096 || !consumed.Add(requestId)) throw new InvalidOperationException("Claim was already consumed or capacity exceeded.");
            Func<bool> stillCurrent = () => {
                try { return System.Threading.Thread.CurrentThread.ManagedThreadId == threadId && app.ActiveUIDocument != null && Object.ReferenceEquals(app.ActiveUIDocument.Document, document) && document.IsValidObject && claimedAndCurrent(requestId) && !cancelled(requestId) && accessCurrent(app, document); }
                catch { return false; }
            };
            if (!stillCurrent()) throw new InvalidOperationException("Request, cancellation, access or document binding changed before review.");
            object result = nativeWorkflow(app, session, args, stillCurrent);
            return new { operation = "batch_set_parameters_by_filter", request_id = requestId, hostSession = session, document = new { title = document.Title, path = document.PathName }, effect = "model_transaction", context_current_after = stillCurrent(), value = result };
        }
    }
}
