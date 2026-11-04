using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using BuildX.FamilyCore;

internal static class FamilyTemplateCatalogTests
{
    private static int total, passed, failed, skipped;
    private static string root;
    private static string regular;
    private static byte[] bytes;

    private static int Main(string[] args)
    {
        if (args.Length != 5) return 2;
        root = args[0]; regular = Path.Combine(root, "regular.rft");
        bytes = new byte[160 * 1024 + 17];
        for (int i = 0; i < bytes.Length; i++) bytes[i] = (byte)((i * 19 + 7) % 251);
        File.WriteAllBytes(regular, bytes);
        Console.WriteLine("TAP version 13");

        Check("fixed catalog hashes a multi-buffer file with exact original length", delegate {
            FamilyTemplateObservation result = Catalog("valve", regular).Inspect("valve");
            Equal(FamilyTemplateState.BytesVerified, result.State); Equal(FamilyTemplateIssue.None, result.Issue);
            Equal((long)bytes.Length, result.ByteLength.Value); Equal(Digest(bytes), result.Sha256);
            Equal(regular, result.SourcePath); Equal("valve", result.TemplateId);
        });
        Check("ID lookup is ordinal and unknown IDs expose no path or bytes", delegate {
            var catalog = Catalog("Valve", regular);
            FamilyTemplateObservation result = catalog.Inspect("valve");
            Equal(FamilyTemplateState.Unknown, result.State); Equal(FamilyTemplateIssue.UnknownId, result.Issue);
            IsTrue(result.SourcePath == null && result.ByteLength == null && result.Sha256 == null);
            Equal(FamilyTemplateIssue.UnknownId, catalog.Inspect(null).Issue);
        });
        Check("configuration collection is captured once and cannot redirect a later lookup", delegate {
            var entries = new List<FamilyTemplateLocation> { new FamilyTemplateLocation("one", regular) };
            var catalog = new FamilyTemplateCatalog(entries);
            entries.Clear(); entries.Add(new FamilyTemplateLocation("one", Path.Combine(root, "absent.rft")));
            Equal(Digest(bytes), catalog.Inspect("one").Sha256);
            Equal(FamilyTemplateIssue.UnknownId, catalog.Inspect("other").Issue);
        });
        Check("missing file is explicit NotFound with known configured path", delegate {
            string path = Path.Combine(root, "absent.rft");
            FamilyTemplateObservation result = Catalog("missing", path).Inspect("missing");
            Equal(FamilyTemplateState.NotFound, result.State); Equal(FamilyTemplateIssue.MissingFile, result.Issue);
            Equal(path, result.SourcePath); IsTrue(result.ByteLength == null && result.Sha256 == null);
        });
        Check("missing ancestor is explicit NotFound", delegate {
            FamilyTemplateObservation result = Catalog("missing", Path.Combine(root, "absent-parent", "absent.rft")).Inspect("missing");
            Equal(FamilyTemplateState.NotFound, result.State); Equal(FamilyTemplateIssue.MissingFile, result.Issue);
        });
        Check("empty file is rejected with zero known length and no digest", delegate {
            string path = Path.Combine(root, "empty.rft"); File.WriteAllBytes(path, new byte[0]);
            FamilyTemplateObservation result = Catalog("empty", path).Inspect("empty");
            Equal(FamilyTemplateState.Rejected, result.State); Equal(FamilyTemplateIssue.EmptyFile, result.Issue);
            Equal(0L, result.ByteLength.Value); IsTrue(result.Sha256 == null);
        });
        Check("over-budget file is not hashed and preserves its observed size", delegate {
            var catalog = new FamilyTemplateCatalog(new[] { new FamilyTemplateLocation("large", regular) }, bytes.Length - 1);
            FamilyTemplateObservation result = catalog.Inspect("large");
            Equal(FamilyTemplateState.TooLarge, result.State); Equal(FamilyTemplateIssue.OverBudget, result.Issue);
            Equal((long)bytes.Length, result.ByteLength.Value); IsTrue(result.Sha256 == null);
        });
        Check("exact byte budget succeeds", delegate {
            var catalog = new FamilyTemplateCatalog(new[] { new FamilyTemplateLocation("exact", regular) }, bytes.Length);
            Equal(Digest(bytes), catalog.Inspect("exact").Sha256);
        });
        Check("sharing failure is unknown read failure rather than absence", delegate {
            using (var locked = new FileStream(regular, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                FamilyTemplateObservation result = Catalog("locked", regular).Inspect("locked");
                Equal(FamilyTemplateState.Unknown, result.State); Equal(FamilyTemplateIssue.ReadFailure, result.Issue);
                Equal((long)bytes.Length, result.ByteLength.Value); IsTrue(result.Sha256 == null);
            }
        });
        Check("unknown ID does not attempt to open a locked configured file", delegate {
            using (var locked = new FileStream(regular, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                Equal(FamilyTemplateIssue.UnknownId, Catalog("known", regular).Inspect("unknown").Issue);
        });
        Check("hashing releases its read handle before return", delegate {
            var catalog = Catalog("release", regular);
            Equal(FamilyTemplateState.BytesVerified, catalog.Inspect("release").State);
            Equal(0, catalog.PendingCleanupCount);
            using (var writable = new FileStream(regular, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                Equal((long)bytes.Length, writable.Length);
        });
        Check("rft directory leaf is rejected as non-regular", delegate {
            string path = Path.Combine(root, "directory.rft"); Directory.CreateDirectory(path);
            FamilyTemplateObservation result = Catalog("directory", path).Inspect("directory");
            Equal(FamilyTemplateState.Rejected, result.State); Equal(FamilyTemplateIssue.NonRegularFile, result.Issue);
        });
        Check("a file in the parent chain is rejected as non-regular", delegate {
            FamilyTemplateObservation result = Catalog("parent", Path.Combine(regular, "inside.rft")).Inspect("parent");
            Equal(FamilyTemplateState.Rejected, result.State); Equal(FamilyTemplateIssue.NonRegularFile, result.Issue);
        });
        Check("empty null duplicate and over-capacity catalogs fail during configuration", delegate {
            Throws(delegate { new FamilyTemplateCatalog(null); });
            Throws(delegate { new FamilyTemplateCatalog(new FamilyTemplateLocation[0]); });
            Throws(delegate { new FamilyTemplateCatalog(new FamilyTemplateLocation[] { null }); });
            Throws(delegate { new FamilyTemplateCatalog(new[] { new FamilyTemplateLocation("id", regular), new FamilyTemplateLocation("id", regular) }); });
            var entries = new List<FamilyTemplateLocation>();
            for (int i = 0; i < 17; i++) entries.Add(new FamilyTemplateLocation("id" + i, regular));
            Throws(delegate { new FamilyTemplateCatalog(entries); });
        });
        Check("invalid IDs and out-of-range budgets fail during configuration", delegate {
            Throws(delegate { Catalog("", regular); }); Throws(delegate { Catalog("bad\0id", regular); });
            Throws(delegate { Catalog(new string('x', 97), regular); });
            Throws(delegate { new FamilyTemplateCatalog(new[] { new FamilyTemplateLocation("x", regular) }, 0); });
            Throws(delegate { new FamilyTemplateCatalog(new[] { new FamilyTemplateLocation("x", regular) }, FamilyTemplateCatalog.MaximumMaxBytes + 1); });
        });
        Check("relative UNC device ADS and wrong-suffix paths fail before inspection", delegate {
            string[] paths = { "relative.rft", "\\relative.rft", "C:relative.rft", "\\\\server\\share\\x.rft", "//server/share/x.rft", "\\\\?\\C:\\x.rft", regular + ":stream.rft", Path.Combine(root, "wrong.rfa") };
            foreach (string path in paths) Throws(delegate { Catalog("invalid", path); });
        });
        Check("sixteen entries and case-distinct IDs remain distinct", delegate {
            var entries = new List<FamilyTemplateLocation>();
            for (int i = 0; i < 15; i++) entries.Add(new FamilyTemplateLocation("id" + i, regular));
            entries.Add(new FamilyTemplateLocation("ID0", regular));
            Equal(FamilyTemplateState.BytesVerified, new FamilyTemplateCatalog(entries).Inspect("ID0").State);
        });
        LinkCheck("symlink leaf is rejected before hashing", args[1], delegate {
            FamilyTemplateObservation result = Catalog("symlink", Path.Combine(root, "symlink.rft")).Inspect("symlink");
            Equal(FamilyTemplateState.Rejected, result.State); Equal(FamilyTemplateIssue.ReparsePoint, result.Issue); IsTrue(result.Sha256 == null);
        });
        LinkCheck("junction parent is rejected before hashing", args[2], delegate {
            FamilyTemplateObservation result = Catalog("junction", Path.Combine(root, "junction", "inside.rft")).Inspect("junction");
            Equal(FamilyTemplateState.Rejected, result.State); Equal(FamilyTemplateIssue.ReparsePoint, result.Issue); IsTrue(result.Sha256 == null);
        });
        LinkCheck("hardlink is read only at its explicitly configured authorized path", args[3], delegate {
            string path = Path.Combine(root, "hardlink.rft");
            FamilyTemplateObservation result = Catalog("hardlink", path).Inspect("hardlink");
            Equal(FamilyTemplateState.BytesVerified, result.State); Equal(path, result.SourcePath);
            Equal(Digest(Encoding.UTF8.GetBytes("fixed-link-fixture")), result.Sha256);
        });
        Check("production hashing uses bounded incremental reads and explicit EOF verification", delegate {
            string source = File.ReadAllText(args[4]);
            IsTrue(source.Contains("BufferBytes = 64 * 1024") && source.Contains("remaining -= count") && source.Contains("stream.ReadByte() != -1"));
            IsTrue(source.Contains("FileAccess.Read, FileShare.Read") && source.Contains("sha.TransformBlock"));
            IsTrue(!source.Contains("ReadAllBytes") && !source.Contains(".ComputeHash("));
        });
        Check("same production cleanup owner retains the precise failed resource and primary facts", delegate {
            var owner = new TemplateReadResourceOwner();
            var stream = new CleanupFixture(1); var sha = new CleanupFixture(0);
            owner.Track(stream); owner.Track(sha);
            var primary = new FamilyTemplateObservation("id", regular, FamilyTemplateState.Unknown,
                FamilyTemplateIssue.ReadFailure, bytes.Length, null);
            owner.RecordPrimary(primary);
            IsTrue(!owner.TryCleanup()); Equal(1, owner.PendingCount);
            IsTrue(Object.ReferenceEquals(primary, owner.PrimaryObservation));
            Equal(1, stream.Calls); Equal(1, sha.Calls);
            IsTrue(owner.TryCleanup()); Equal(0, owner.PendingCount);
            Equal(2, stream.Calls); Equal(1, sha.Calls);
            IsTrue(owner.TryCleanup()); Equal(2, stream.Calls); Equal(1, sha.Calls);
        });
        Check("mixed cleanup retries preserve both failures without redisposing a completed resource", delegate {
            var owner = new TemplateReadResourceOwner();
            var stream = new CleanupFixture(2); var sha = new CleanupFixture(1);
            owner.Track(stream); owner.Track(sha);
            IsTrue(!owner.TryCleanup()); Equal(2, owner.PendingCount);
            IsTrue(!owner.TryCleanup()); Equal(1, owner.PendingCount);
            IsTrue(owner.TryCleanup()); Equal(0, owner.PendingCount);
            Equal(3, stream.Calls); Equal(2, sha.Calls);
        });
        Check("cleanup reentry cannot duplicate disposal or report completion prematurely", delegate {
            var owner = new TemplateReadResourceOwner();
            var fixture = new CleanupFixture(0);
            fixture.Callback = delegate { IsTrue(!owner.TryCleanup()); Equal(1, owner.PendingCount); };
            owner.Track(fixture); IsTrue(owner.TryCleanup()); Equal(1, fixture.Calls); Equal(0, owner.PendingCount);
        });
        Check("cleanup owner rejects duplicate foreign capacity and post-cleanup acquisition", delegate {
            var owner = new TemplateReadResourceOwner(); var one = new CleanupFixture(0); var two = new CleanupFixture(0);
            owner.Track(one); ThrowsInvalid(delegate { owner.Track(one); }); owner.Track(two);
            ThrowsInvalid(delegate { owner.Track(new CleanupFixture(0)); }); IsTrue(owner.TryCleanup());
            ThrowsInvalid(delegate { owner.Track(new CleanupFixture(0)); }); Equal(1, one.Calls); Equal(1, two.Calls);
        });
        Console.WriteLine("1.." + total); Console.WriteLine("# tests " + total); Console.WriteLine("# pass " + passed);
        Console.WriteLine("# fail " + failed); Console.WriteLine("# skip " + skipped);
        return failed == 0 ? 0 : 1;
    }

    private static FamilyTemplateCatalog Catalog(string id, string path)
    { return new FamilyTemplateCatalog(new[] { new FamilyTemplateLocation(id, path) }); }
    private static string Digest(byte[] data)
    { using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(data)).Replace("-", "").ToLowerInvariant(); }
    private static void Equal<T>(T expected, T actual)
    { if (!Object.Equals(expected, actual)) throw new Exception("Expected " + expected + ", got " + actual); }
    private static void IsTrue(bool value) { if (!value) throw new Exception("Assertion failed"); }
    private static void Throws(Action action)
    { try { action(); } catch (ArgumentException) { return; } throw new Exception("Expected configuration rejection"); }
    private static void ThrowsInvalid(Action action)
    { try { action(); } catch (InvalidOperationException) { return; } throw new Exception("Expected ownership rejection"); }
    private sealed class CleanupFixture : IDisposable
    {
        internal int Calls; private int remainingFailures; internal Action Callback;
        internal CleanupFixture(int failures) { remainingFailures = failures; }
        public void Dispose()
        {
            Calls++; if (Callback != null) Callback();
            if (remainingFailures > 0) { remainingFailures--; throw new IOException("fixture cleanup failure"); }
        }
    }
    private static void Check(string name, Action action)
    {
        total++;
        try { action(); passed++; Console.WriteLine("ok " + total + " - " + name); }
        catch (Exception ex) { failed++; Console.WriteLine("not ok " + total + " - " + name); Console.WriteLine("# " + ex.GetType().Name + ": " + ex.Message.Replace("\n", " ").Replace("\r", " ")); }
    }
    private static void LinkCheck(string name, string availability, Action action)
    {
        if (availability == "available") { Check(name, action); return; }
        total++; skipped++; Console.WriteLine("ok " + total + " - " + name + " # SKIP " + availability);
    }
}
