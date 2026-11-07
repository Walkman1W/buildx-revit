using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    // Internal, unregistered admission primitive. The trusted approval verifier
    // must be supplied by a future restricted panel-host channel. A random token
    // is a bearer capability and does not authenticate the channel by itself.
    internal sealed class DeletePreviewAdmission
    {
        // In-process only: a deserialized JSON object cannot become this type.
        // Construction alone is not authority; the injected verifier must also
        // consume a trusted decision bound to the exact scope.
        internal sealed class TrustedDecision { internal TrustedDecision() { } }
        internal sealed class Scope
        {
            internal readonly string RequestId, HostSession, DocumentPath, TargetUniqueId, RequestedMode;
            internal readonly long TargetId;
            internal Scope(string requestId, string hostSession, string path, long id, string uniqueId, string mode)
            { RequestId = requestId; HostSession = hostSession; DocumentPath = path; TargetId = id; TargetUniqueId = uniqueId; RequestedMode = mode; }
        }
        private sealed class Entry { internal Document Document; internal Scope Scope; internal long Tick; }
        private readonly string session;
        private readonly Func<object, object, bool?> sameDocument;
        private readonly Func<object, Scope, bool> verifyTrustedDecision;
        private readonly Func<long> clock;
        private readonly long frequency;
        private readonly Dictionary<string, Entry> entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        internal DeletePreviewAdmission(string hostSession, Func<object, object, bool?> identity, Func<object, Scope, bool> decisionVerifier)
            : this(hostSession, identity, decisionVerifier, Stopwatch.GetTimestamp, Stopwatch.Frequency) { }
        internal DeletePreviewAdmission(string hostSession, Func<object, object, bool?> identity, Func<object, Scope, bool> decisionVerifier, Func<long> monotonicClock, long clockFrequency)
        {
            if (!ValidSession(hostSession) || identity == null || decisionVerifier == null || monotonicClock == null || clockFrequency <= 0)
                throw new ArgumentException("Delete preview admission requires a host, identity owner, trusted decision verifier and monotonic clock.");
            session = hostSession; sameDocument = identity; verifyTrustedDecision = decisionVerifier; clock = monotonicClock; frequency = clockFrequency;
        }
        private static bool ValidSession(string value) { return value != null && value.Length == 32 && value.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')); }
        private bool Expired(Entry entry) { long now = clock(); return now < entry.Tick || ((double)now - entry.Tick) / frequency >= 30.0; }
        private void Validate(Document doc, Scope scope)
        {
            Guid parsed;
            if (doc == null || !doc.IsValidObject || doc.IsFamilyDocument || doc.IsLinked || doc.IsReadOnly || sameDocument(doc, doc) != true ||
                scope == null || scope.HostSession != session || String.IsNullOrWhiteSpace(scope.DocumentPath) || doc.PathName != scope.DocumentPath ||
                scope.TargetId <= 0 || String.IsNullOrWhiteSpace(scope.TargetUniqueId) || scope.TargetUniqueId.Length > 1024 ||
                !(scope.RequestedMode == "rollback" || scope.RequestedMode == "commit") ||
                !Guid.TryParseExact(scope.RequestId, "D", out parsed) || scope.RequestId.Length != 36 || scope.RequestId[14] != '4' || "89abAB".IndexOf(scope.RequestId[19]) < 0)
                throw new InvalidOperationException("Delete preview admission scope is invalid.");
            ViewSheet sheet = doc.GetElement(new ElementId(scope.TargetId)) as ViewSheet;
            if (sheet == null || !sheet.IsValidObject || sheet.UniqueId != scope.TargetUniqueId) throw new InvalidOperationException("Delete preview target changed.");
        }
        private static bool SameScope(Scope a, Scope b)
        {
            return a != null && b != null && a.RequestId == b.RequestId && a.HostSession == b.HostSession && a.DocumentPath == b.DocumentPath &&
                a.TargetId == b.TargetId && a.TargetUniqueId == b.TargetUniqueId && a.RequestedMode == b.RequestedMode;
        }
        internal string Issue(Document doc, Scope scope, object trustedDecision)
        {
            Validate(doc, scope);
            // The verifier must prove a specific current panel decision, not a
            // boolean, HTTP field, caller-supplied session, or queue JSON value.
            if (!(trustedDecision is TrustedDecision) || verifyTrustedDecision(trustedDecision, scope) != true) throw new InvalidOperationException("A trusted one-use panel decision is required.");
            Validate(doc, scope); // verifier may yield or allow the document to change
            foreach (string key in entries.Where(pair => Expired(pair.Value)).Select(pair => pair.Key).ToArray()) entries.Remove(key);
            if (entries.Count >= 128) throw new InvalidOperationException("Delete preview admission capacity exceeded.");
            string token = Guid.NewGuid().ToString("N"); entries.Add(token, new Entry { Document = doc, Scope = scope, Tick = clock() }); return token;
        }
        internal void Claim(Document doc, Scope scope, string token)
        {
            if (token == null || token.Length != 32 || token.Any(c => !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))))
                throw new InvalidOperationException("Delete preview admission is invalid.");
            Entry entry;
            if (!entries.TryGetValue(token, out entry)) throw new InvalidOperationException("Delete preview admission is missing or already consumed.");
            entries.Remove(token); // mismatched or expired attempts also burn the capability
            Validate(doc, scope);
            if (Expired(entry) || sameDocument(entry.Document, doc) != true || !SameScope(entry.Scope, scope))
                throw new InvalidOperationException("Delete preview admission expired or changed scope.");
        }
    }
}
