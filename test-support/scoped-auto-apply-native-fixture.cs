using System;
using System.Collections.Generic;
using RevitLocalCodex;

internal static class ScopedAutoApplyNativeFixture
{
    private static readonly Dictionary<string, object> Automatic = new Dictionary<string, object> { { "scopedAutoApply", true } };
    private static readonly Dictionary<string, object> Commit = new Dictionary<string, object> { { "mode", "commit" } };

    private static void Check(bool valid)
    {
        if (!valid) throw new Exception("Scoped auto apply assertion failed.");
    }

    private static void Reject(Action run)
    {
        try { run(); }
        catch (InvalidOperationException) { return; }
        throw new Exception("An ineligible request gained auto apply.");
    }

    private static void Main()
    {
        Check(ScopedAutoApply.Version == 1);
        Check(ScopedAutoApply.Operations.Length == 2);
        Check(ScopedAutoApply.Requested(Automatic, "set_parameter_value", Commit, true, false));
        Check(ScopedAutoApply.Requested(Automatic, "create_group", Commit, true, false));
        Check(!ScopedAutoApply.Requested(new Dictionary<string, object>(), "set_parameter_value", Commit, true, false));
        Check(!ScopedAutoApply.Requested(new Dictionary<string, object> { { "scopedAutoApply", false } }, "set_parameter_value", Commit, true, false));
        Check(!ScopedAutoApply.Requested(new Dictionary<string, object>(), "set_parameter_value",
            new Dictionary<string, object> { { "mode", "commit" }, { "scopedAutoApply", true } }, true, false));
        Reject(() => ScopedAutoApply.Requested(Automatic, "set_type_parameter", Commit, true, false));
        Reject(() => ScopedAutoApply.Requested(Automatic, "create_wall", Commit, true, false));
        Reject(() => ScopedAutoApply.Requested(Automatic, "set_parameter_value", Commit, false, false));
        Reject(() => ScopedAutoApply.Requested(Automatic, "set_parameter_value", Commit, true, true));
        Reject(() => ScopedAutoApply.Requested(Automatic, "create_group", null, true, false));
        Reject(() => ScopedAutoApply.Requested(Automatic, "create_group", new Dictionary<string, object> { { "mode", "rollback" } }, true, false));
        Reject(() => ScopedAutoApply.Requested(new Dictionary<string, object> { { "scopedAutoApply", "true" } }, "set_parameter_value", Commit, true, false));
        Console.WriteLine("Scoped auto apply admission passed.");
    }
}
