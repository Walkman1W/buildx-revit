using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using RevitLocalCodex;

internal static class Program
{
    private static int assertions;
    private static void Check(bool value, string message) { assertions++; if (!value) throw new Exception(message); }
    private static Dictionary<string, object> Wire(string id, int revision, string account)
    { return new Dictionary<string, object> { { "id", id }, { "revision", revision }, { "accountScope", account } }; }
    private static AccessPolicy.Binding Binding(string id, int revision, string account)
    { return AccessPolicy.RequestBinding(new Dictionary<string, object> { { "accessPolicy", Wire(id, revision, account) } }); }
    private static void Write(string root, string id, int revision, string mode, string account, params string[] roots)
    { File.WriteAllText(Path.Combine(root, "access-policy.json"), new JavaScriptSerializer().Serialize(new { schemaVersion = 1, id, revision, mode, accountScope = account, roots })); }
    private static AccessPolicy.Decision Evaluate(string root, AccessPolicy.Binding binding, string file, bool legacy = false, bool readOnly = false, bool family = false, bool linked = false)
    { return AccessPolicy.Evaluate(root, binding, file, legacy, readOnly, family, linked); }
    public static void Main(string[] args)
    {
        string root = args[0], project = Path.Combine(root, "project"), sibling = Path.Combine(root, "project-other"), outside = Path.Combine(root, "outside");
        Directory.CreateDirectory(project); Directory.CreateDirectory(sibling); Directory.CreateDirectory(outside);
        string current = Path.Combine(project, "model.rvt"), foreign = Path.Combine(sibling, "model.rvt"), other = Path.Combine(outside, "other.rvt");
        File.WriteAllText(current, "owned test bytes"); File.WriteAllText(foreign, "foreign test bytes"); File.WriteAllText(other, "other bytes");
        string id = Guid.NewGuid().ToString("D"), account = "fixture-account";
        var binding = Binding(id, 1, account);
        Check(AccessPolicy.RequestBinding(new Dictionary<string, object>()) == null, "omission remains legacy");
        Check(Evaluate(root, null, current, true).Allowed, "legacy explicit file remains available");
        Check(!Evaluate(root, null, current).Allowed, "legacy missing allowlist remains denied");
        Write(root, id, 1, "read-only", account);
        Check(!Evaluate(root, binding, current, true).Allowed, "read-only overrides old allowlist");
        Check(Evaluate(root, binding, current).Reason == "policy_read_only", "read-only reason");
        Write(root, id, 1, "project-write", account, project);
        Check(Evaluate(root, binding, current).Allowed, "project document is authorized without legacy entry");
        Check(Evaluate(root, binding, current.ToUpperInvariant()).Allowed, "Windows path comparison is case-insensitive");
        Check(!Evaluate(root, binding, foreign).Allowed, "sibling prefix is outside");
        Check(!Evaluate(root, binding, Path.Combine(project, "..", "outside", "other.rvt")).Allowed, "parent traversal is outside");
        Check(Evaluate(root, binding, Path.Combine(project, ".", "model.rvt")).Allowed, "normalized in-scope input");
        Check(!Evaluate(root, binding, current, false, true).Allowed, "document read-only preserved");
        Check(!Evaluate(root, binding, current, false, false, true).Allowed, "family document not a project grant");
        Check(!Evaluate(root, binding, current, false, false, false, true).Allowed, "linked document not a writable project");
        Check(!Evaluate(root, binding, "").Allowed, "unsaved document not granted");
        Check(!Evaluate(root, Binding(id, 2, account), current).Allowed, "revision mismatch denied");
        Check(!Evaluate(root, Binding(id, 1, "different-account"), current).Allowed, "account mismatch denied");
        Check(!Evaluate(root, Binding(Guid.NewGuid().ToString("D"), 1, account), current).Allowed, "policy identity mismatch denied");
        Write(root, id, 1, "full-access", account);
        Check(Evaluate(root, binding, other).Allowed, "full access reaches a saved project outside old roots");
        Write(root, id, 2, "read-only", account);
        Check(!Evaluate(root, binding, current).Allowed, "revoked old binding cannot commit");
        Check(Evaluate(root, Binding(id, 2, account), current).Reason == "policy_read_only", "new read-only binding observed");
        Write(root, id, 1, "project-write", account);
        Check(!Evaluate(root, binding, current).Allowed, "empty project roots denied");
        File.WriteAllText(Path.Combine(root, "access-policy.json"), "malformed");
        Check(Evaluate(root, binding, current).Reason == "invalid_policy", "malformed record fails closed");
        File.WriteAllText(Path.Combine(root, "access-policy.json"), new string('x', 256 * 1024 + 1));
        Check(!Evaluate(root, binding, current).Allowed, "oversized record denied before parsing");
        string link = Path.Combine(root, "linked-project");
        if (Directory.Exists(link))
        {
            Write(root, id, 1, "project-write", account, link);
            Check(!Evaluate(root, binding, Path.Combine(link, "external.rvt")).Allowed, "junction root denied");
            Write(root, id, 1, "full-access", account);
            Check(!Evaluate(root, binding, Path.Combine(link, "external.rvt")).Allowed, "junction document denied even under full access");
        }
        Write(root, id, 1, "project-write", account, project);
        AccessPolicy.RequireEdit(root, binding, current, false, false, false, false);
        bool rejected = false;
        try { AccessPolicy.RequireEdit(root, binding, foreign, true, false, false, false); } catch (InvalidOperationException) { rejected = true; }
        Check(rejected, "new scope cannot fall back to legacy outside file");
        rejected = false;
        try { AccessPolicy.RequestBinding(new Dictionary<string, object> { { "accessPolicy", new Dictionary<string, object> { { "id", id }, { "revision", 1 }, { "accountScope", account }, { "mode", "full-access" } } } }); }
        catch (InvalidOperationException) { rejected = true; }
        Check(rejected, "model cannot include scope content in request header");
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { passed = true, assertions, scope = "Real AccessPolicy owner; filesystem fixtures, not live Revit" }));
    }
}
