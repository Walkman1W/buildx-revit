using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;

namespace RevitLocalCodex
{
    // Application-owned access scope, not a Windows security boundary. Only a
    // request bound to the current UI-published policy may use its wider scope.
    internal static class AccessPolicy
    {
        internal sealed class Binding
        {
            internal string Id, AccountScope;
            internal int Revision;
            internal object Public { get { return new { id = Id, revision = Revision, accountScope = AccountScope }; } }
        }
        private sealed class Projection
        {
            internal Binding Binding;
            internal string Mode;
            internal string[] Roots;
        }
        internal sealed class Decision
        {
            internal bool Allowed;
            internal string Reason;
            internal object Policy;
            internal object Public { get { return new { schemaVersion = 1, policy = Policy, allowed = Allowed, reason = Reason }; } }
        }
        internal static Binding RequestBinding(Dictionary<string, object> request)
        {
            object raw;
            if (!request.TryGetValue("accessPolicy", out raw)) return null;
            return ParseBinding(raw as Dictionary<string, object>);
        }
        private static Binding ParseBinding(Dictionary<string, object> value)
        {
            if (value == null || value.Count != 3 || !value.ContainsKey("id") || !value.ContainsKey("revision") || !value.ContainsKey("accountScope"))
                throw new InvalidOperationException("Invalid access policy binding.");
            string id = Text(value, "id", 36), scope = Text(value, "accountScope", 512);
            Guid parsed;
            if (!Guid.TryParseExact(id, "D", out parsed)) throw new InvalidOperationException("Invalid access policy identity.");
            object revision = value["revision"];
            if (!(revision is int || revision is long || revision is decimal || revision is double)) throw new InvalidOperationException("Invalid access policy revision.");
            decimal number = Convert.ToDecimal(revision, CultureInfo.InvariantCulture);
            if (number < 0 || number > Int32.MaxValue || number != Decimal.Truncate(number)) throw new InvalidOperationException("Invalid access policy revision.");
            return new Binding { Id = id, Revision = (int)number, AccountScope = scope };
        }
        private static string Text(Dictionary<string, object> value, string key, int maximum)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || !(raw is string) || ((string)raw).Length < 1 || ((string)raw).Length > maximum || ((string)raw).Any(c => Char.IsControl(c)))
                throw new InvalidOperationException("Invalid access policy " + key + ".");
            return (string)raw;
        }
        private static Projection Read(string root, Binding binding)
        {
            string filename = Path.Combine(Path.GetFullPath(root), "access-policy.json");
            PlainPath(filename, false);
            if (new FileInfo(filename).Length > 256 * 1024) throw new InvalidOperationException("Access policy exceeds its byte budget.");
            var serializer = new JavaScriptSerializer { MaxJsonLength = 256 * 1024, RecursionLimit = 12 };
            var value = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(filename));
            if (value == null || value.Count != 6 || value.Keys.Any(key => !new[] { "schemaVersion", "id", "revision", "mode", "roots", "accountScope" }.Contains(key)))
                throw new InvalidOperationException("Invalid access policy projection.");
            if (!value.ContainsKey("schemaVersion") || !(value["schemaVersion"] is int) || (int)value["schemaVersion"] != 1)
                throw new InvalidOperationException("Unsupported access policy version.");
            var selected = ParseBinding(new Dictionary<string, object> { { "id", value["id"] }, { "revision", value["revision"] }, { "accountScope", value["accountScope"] } });
            if (selected.Id != binding.Id || selected.Revision != binding.Revision || selected.AccountScope != binding.AccountScope)
                throw new InvalidOperationException("Access policy changed; select the current access scope again.");
            string mode = Text(value, "mode", 32);
            if (!new[] { "read-only", "project-write", "full-access" }.Contains(mode)) throw new InvalidOperationException("Unknown access policy mode.");
            var roots = value["roots"] as IList;
            if (roots == null || roots.Count > 64 || mode == "project-write" && roots.Count == 0)
                throw new InvalidOperationException("Invalid access policy roots.");
            var paths = new List<string>();
            foreach (object entry in roots)
            {
                string path = entry as string;
                if (String.IsNullOrWhiteSpace(path) || path.Length > 32767 || !Path.IsPathRooted(path)) throw new InvalidOperationException("Invalid access policy root.");
                string full = Path.GetFullPath(path);
                PlainPath(full, true);
                if (paths.Any(item => String.Equals(item, full, StringComparison.OrdinalIgnoreCase))) throw new InvalidOperationException("Duplicate access policy root.");
                paths.Add(full);
            }
            return new Projection { Binding = selected, Mode = mode, Roots = paths.ToArray() };
        }
        private static void PlainPath(string path, bool directory)
        {
            if (String.IsNullOrWhiteSpace(path) || path.Length > 32767 || !Path.IsPathRooted(path) || path.StartsWith("\\\\?\\", StringComparison.Ordinal) || path.StartsWith("\\\\.\\", StringComparison.Ordinal))
                throw new InvalidOperationException("Access path cannot be resolved.");
            string full = Path.GetFullPath(path);
            string volume = Path.GetPathRoot(full).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            FileAttributes attributes = File.GetAttributes(full);
            if (directory != ((attributes & FileAttributes.Directory) != 0)) throw new InvalidOperationException("Access path has the wrong kind.");
            string current = full;
            while (!String.IsNullOrEmpty(current))
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Access paths cannot contain links or junctions.");
                if (String.Equals(current.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), volume, StringComparison.OrdinalIgnoreCase)) break;
                string parent = Path.GetDirectoryName(current);
                if (String.Equals(parent, current, StringComparison.OrdinalIgnoreCase)) break;
                current = parent;
            }
        }
        private static bool Contains(string root, string filename)
        {
            string directory = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string full = Path.GetFullPath(filename);
            return String.Equals(directory, full, StringComparison.OrdinalIgnoreCase) || full.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }
        internal static Decision Evaluate(string root, Binding binding, string documentPath, bool legacyAllowed,
            bool readOnly, bool familyDocument, bool linkedDocument, bool requireProjectScope = false)
        {
            var decision = new Decision { Allowed = false, Reason = "not_saved", Policy = null };
            if (String.IsNullOrWhiteSpace(documentPath)) return decision;
            if (binding == null)
            {
                if (requireProjectScope) { decision.Reason = "project_policy_required"; return decision; }
                decision.Allowed = legacyAllowed; decision.Reason = legacyAllowed ? "legacy_allowed" : "outside_legacy_allowlist";
            }
            else
            {
                try
                {
                    Projection projection = Read(root, binding);
                    decision.Policy = new { id = projection.Binding.Id, revision = projection.Binding.Revision,
                        accountScope = projection.Binding.AccountScope, mode = projection.Mode };
                    if (requireProjectScope && projection.Mode != "project-write") { decision.Reason = "project_policy_required"; return decision; }
                    if (projection.Mode == "read-only") { decision.Reason = "policy_read_only"; return decision; }
                    PlainPath(documentPath, false);
                    decision.Allowed = projection.Mode == "full-access" || projection.Roots.Any(path => Contains(path, documentPath));
                    decision.Reason = decision.Allowed ? "allowed" : "outside_project";
                }
                catch { decision.Reason = "invalid_policy"; return decision; }
            }
            if (readOnly) { decision.Allowed = false; decision.Reason = "document_read_only"; }
            else if (familyDocument) { decision.Allowed = false; decision.Reason = "family_document"; }
            else if (linkedDocument) { decision.Allowed = false; decision.Reason = "linked_document"; }
            return decision;
        }
        internal static void RequireEdit(string root, Binding binding, string documentPath, bool legacyAllowed,
            bool readOnly, bool familyDocument, bool linkedDocument, bool requireProjectScope = false)
        {
            Decision decision = Evaluate(root, binding, documentPath, legacyAllowed, readOnly, familyDocument, linkedDocument, requireProjectScope);
            if (!decision.Allowed) throw new InvalidOperationException("Current access scope does not permit editing this project: " + decision.Reason + ".");
        }
    }
}
