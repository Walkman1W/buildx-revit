using System;
using System.Collections.Generic;
using System.Threading;
using BuildX.FamilyCore;

internal static class ProjectDocumentRegistryTests
{
    private sealed class Document
    {
        internal string OpenId;
        internal string Fingerprint = "project-a";
        internal bool? Valid = true, Family = false, Linked = false, ReadOnly = false;
        internal int? Hash = 7;
        internal bool ThrowInspect;
        internal bool NullInspect;
        internal Document(string openId) { OpenId = openId; }
    }

    private sealed class Source : IProjectDocumentSource
    {
        internal int Inspections, Comparisons;
        internal bool UnknownEquality, ThrowEquality;
        internal Action<Document> OnInspect;
        internal Action OnCompare;
        public ProjectDocumentFacts Inspect(object value)
        {
            Inspections++;
            Document document = (Document)value;
            if (OnInspect != null) OnInspect(document);
            if (document.ThrowInspect) throw new InvalidOperationException("PRIVATE source failure payload");
            if (document.NullInspect) return null;
            return new ProjectDocumentFacts(document.Valid, document.Family, document.Linked,
                document.ReadOnly, document.Fingerprint, document.Hash);
        }
        public bool? SameOpenDocument(object first, object second)
        {
            Comparisons++;
            if (OnCompare != null) OnCompare();
            if (ThrowEquality) throw new InvalidOperationException("PRIVATE equality payload");
            if (UnknownEquality) return null;
            return String.Equals(((Document)first).OpenId, ((Document)second).OpenId, StringComparison.Ordinal);
        }
    }

    private sealed class GetterSource : IProjectDocumentSource
    {
        internal Func<bool> Valid = delegate { return true; };
        internal Func<bool> Family = delegate { return false; };
        internal Func<bool> Linked = delegate { return false; };
        internal Func<bool> ReadOnly = delegate { return false; };
        internal Func<string> Fingerprint = delegate { return "getter-project"; };
        internal Func<int> Hash = delegate { return 17; };
        public ProjectDocumentFacts Inspect(object document)
        { return ProjectDocumentFactsReader.Read(Valid, Family, Linked, ReadOnly, Fingerprint, Hash); }
        public bool? SameOpenDocument(object first, object second)
        { throw new InvalidOperationException("This getter test source does not implement native equality."); }
    }

    private static int total, passed, failed;
    private static void Assert(bool condition, string message)
    { if (!condition) throw new Exception(message); }
    private static void Equal(object expected, object actual)
    { Assert(Object.Equals(expected, actual), "Expected " + expected + ", received " + actual); }
    private static ProjectDocumentRegistry Registry(Source source, int capacity = 16)
    { return new ProjectDocumentRegistry("host-session", 1234, source, capacity); }
    private static string Capture(ProjectDocumentRegistry registry, Document document)
    {
        ProjectDocumentResult result = registry.Capture(document);
        Assert(result.Ok && result.Snapshot != null, "Capture failed: " + result.Code);
        return result.Snapshot.Handle;
    }
    private static ProjectDocumentResult Check(ProjectDocumentRegistry registry, string handle)
    { return registry.Check(handle, "host-session", 1234); }
    private static ProjectDocumentResult Get(ProjectDocumentRegistry registry, string handle)
    { return registry.Get(handle, "host-session", 1234); }
    private static ProjectDocumentResult Release(ProjectDocumentRegistry registry, string handle)
    { return registry.ReleaseInvalid(handle, "host-session", 1234); }
    private static void Test(string name, Action action)
    {
        total++;
        try { action(); passed++; Console.WriteLine("ok " + total + " - " + name); }
        catch (Exception exception)
        { failed++; Console.WriteLine("not ok " + total + " - " + name); Console.WriteLine("# " + exception.Message.Replace('\r', ' ').Replace('\n', ' ')); }
    }
    private static void RejectArgument(Action action)
    {
        bool rejected = false;
        try { action(); } catch (ArgumentException) { rejected = true; }
        Assert(rejected, "Invalid configuration accepted.");
    }

    public static int Main()
    {
        Console.WriteLine("TAP version 13");
        Test("fixed host and bounded capacity are required", delegate {
            Source source = new Source();
            RejectArgument(delegate { new ProjectDocumentRegistry("", 1234, source); });
            RejectArgument(delegate { new ProjectDocumentRegistry("host", 0, source); });
            RejectArgument(delegate { new ProjectDocumentRegistry("host", 1, null); });
            RejectArgument(delegate { new ProjectDocumentRegistry("host", 1, source, 0); });
            RejectArgument(delegate { new ProjectDocumentRegistry("host", 1, source, 65); });
        });
        Test("same wrapper uses trusted native equality and retains one handle", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document document = new Document("open-a"); string handle = Capture(registry, document);
            Equal(handle, Capture(registry, document)); Assert(source.Comparisons > 0, "Equality source bypassed.");
        });
        Test("different wrappers of same open document share a handle", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            string handle = Capture(registry, new Document("open-a"));
            Equal(handle, Capture(registry, new Document("open-a")));
        });
        Test("different open documents keep distinct handles despite fingerprint and hash collisions", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            string first = Capture(registry, new Document("open-a"));
            string second = Capture(registry, new Document("open-b"));
            Assert(first != second, "Persistent identity or hash was used as open identity.");
        });
        Test("native hash is auxiliary and does not override true equality", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            string handle = Capture(registry, new Document("open-a"));
            Document alias = new Document("open-a"); alias.Hash = 901;
            Equal(handle, Capture(registry, alias)); Equal(901, Get(registry, handle).Snapshot.CurrentFacts.NativeOpenHash);
        });
        Test("read-only state changes facts but not open identity or write permission", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document document = new Document("open-a"); string handle = Capture(registry, document);
            document.ReadOnly = true; ProjectDocumentResult check = Check(registry, handle);
            Assert(check.Ok && check.Snapshot.CurrentFacts.IsReadOnly == true, "Dynamic read-only fact missing.");
            Equal(handle, Capture(registry, document)); Equal(ProjectIdentityReadiness.Ready, check.Snapshot.IdentityReadiness);
        });
        Test("incomplete current facts revoke Ready and can be refreshed explicitly", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document document = new Document("open-a"); string handle = Capture(registry, document);
            document.ReadOnly = null; ProjectDocumentResult result = Check(registry, handle);
            Assert(!result.Ok && result.Snapshot.CurrentFacts.IsReadOnly == null, "Old facts survived unknown read-only.");
            Equal(ProjectIdentityReadiness.Unknown, result.Snapshot.IdentityReadiness);
            document.ReadOnly = false; Assert(Check(registry, handle).Ok, "Fresh known facts could not restore nonterminal readiness.");
        });
        Test("explicit invalidation permanently revokes old handle even after reopening", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document document = new Document("open-a"); string oldHandle = Capture(registry, document);
            document.Valid = false; Assert(!Check(registry, oldHandle).Ok, "Closed document remained ready.");
            document.Valid = true; ProjectDocumentResult old = Check(registry, oldHandle);
            Assert(!old.Ok && old.Snapshot.Invalidated, "Old identity revived.");
            string newHandle = Capture(registry, new Document("open-reopened")); Assert(newHandle != oldHandle, "Reopened document reused handle.");
            Equal("RELEASE_REQUIRES_INVALID", Release(registry, oldHandle).Code);
        });
        Test("only freshly confirmed invalid metadata releases capacity without reusing handle", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source, 1);
            Document document = new Document("open-a"); string oldHandle = Capture(registry, document);
            Equal("RELEASE_REQUIRES_INVALID", Release(registry, oldHandle).Code);
            document.Valid = false; ProjectDocumentResult released = Release(registry, oldHandle);
            Assert(released.Ok && !released.Snapshot.Retained && released.Snapshot.Invalidated, "Invalid record not released.");
            Equal("HANDLE_NOT_FOUND", Get(registry, oldHandle).Code);
            Assert(Capture(registry, new Document("open-b")) != oldHandle, "Released handle reused.");
        });
        Test("unknown retained validity consumes capacity and blocks ambiguous new identity", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source, 1);
            Document document = new Document("open-a"); string handle = Capture(registry, document);
            document.Valid = null; Equal("CAPTURE_UNCERTAIN", registry.Capture(new Document("open-b")).Code);
            Equal("RELEASE_REQUIRES_INVALID", Release(registry, handle).Code);
            Assert(Get(registry, handle).Snapshot.Retained, "Uncertain resource was discarded.");
            document.Valid = true; Assert(Check(registry, handle).Ok, "Valid refresh failed.");
            Equal("CAPACITY", registry.Capture(new Document("open-b")).Code);
        });
        Test("inspection exception clears current facts while preserving initial fingerprint", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document document = new Document("open-a"); string handle = Capture(registry, document);
            document.ThrowInspect = true; ProjectDocumentResult result = Check(registry, handle);
            Equal("INSPECTION_FAILED", result.Code); Equal(null, result.Snapshot.CurrentFacts);
            Equal("project-a", result.Snapshot.PersistentFingerprint);
            Equal(ProjectIdentityReadiness.Unknown, result.Snapshot.IdentityReadiness);
            Assert(result.Snapshot.Retained, "Exception dropped identity ownership.");
        });
        Test("unknown native equality issues no potentially duplicate handle", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source, 1);
            string handle = Capture(registry, new Document("open-a")); source.UnknownEquality = true;
            Equal("CAPTURE_UNCERTAIN", registry.Capture(new Document("open-a")).Code);
            Equal("EQUALITY_UNKNOWN", Get(registry, handle).Snapshot.CurrentCode);
            source.UnknownEquality = false; Equal(handle, Capture(registry, new Document("open-a")));
        });
        Test("equality exception is a fixed failure without leaking source payload", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            string handle = Capture(registry, new Document("open-a")); source.ThrowEquality = true;
            ProjectDocumentResult result = registry.Capture(new Document("open-b"));
            Equal("CAPTURE_UNCERTAIN", result.Code); Equal("EQUALITY_FAILED", Get(registry, handle).Snapshot.CurrentCode);
        });
        Test("invalid candidates are never compared and cannot merge reopening", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document old = new Document("same-native-value"); string handle = Capture(registry, old); old.Valid = false;
            string reopened = Capture(registry, new Document("same-native-value"));
            Assert(reopened != handle, "Invalid capture was compared or revived."); Equal(0, source.Comparisons);
            Assert(Get(registry, handle).Snapshot.Invalidated, "Implicit candidate check did not invalidate.");
        });
        Test("persistent fingerprint drift is retained as an identity conflict", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document document = new Document("open-a"); string handle = Capture(registry, document);
            document.Fingerprint = "changed"; ProjectDocumentResult result = Check(registry, handle);
            Assert(!result.Ok && result.Snapshot.IdentityConflict, "Fingerprint drift was accepted.");
            Equal("FINGERPRINT_CHANGED", result.Snapshot.IdentityConflictCode);
            Equal("project-a", result.Snapshot.PersistentFingerprint); Equal("changed", result.Snapshot.CurrentFacts.PersistentFingerprint);
            document.Fingerprint = "project-a"; Assert(!Check(registry, handle).Ok, "Conflict auto-repaired without trusted reconciliation.");
            document.ThrowInspect = true; ProjectDocumentResult failedCheck = Check(registry, handle);
            Equal("INSPECTION_FAILED", failedCheck.Snapshot.CurrentCode); Equal(null, failedCheck.Snapshot.CurrentFacts);
            Equal("FINGERPRINT_CHANGED", failedCheck.Snapshot.IdentityConflictCode); document.ThrowInspect = false;
            document.Valid = false; Assert(Release(registry, handle).Ok, "Physically invalid conflict could not release metadata.");
        });
        Test("host mismatch and unknown handles reject before any source callback", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            string handle = Capture(registry, new Document("open-a")); int inspections = source.Inspections;
            Equal("HOST_MISMATCH", registry.Check(handle, "other-session", 1234).Code);
            Equal("HOST_MISMATCH", registry.ReleaseInvalid(handle, "host-session", 9999).Code);
            Equal("HANDLE_NOT_FOUND", registry.Check("foreign", "host-session", 1234).Code);
            Equal(inspections, source.Inspections);
        });
        Test("Get is immutable captured state and performs no fresh source inspection", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document document = new Document("open-a"); string handle = Capture(registry, document);
            ProjectDocumentSnapshot first = Get(registry, handle).Snapshot; int count = source.Inspections;
            document.ReadOnly = true; Equal(false, Get(registry, handle).Snapshot.CurrentFacts.IsReadOnly); Equal(count, source.Inspections);
            Check(registry, handle); Equal(false, first.CurrentFacts.IsReadOnly); Equal(true, Get(registry, handle).Snapshot.CurrentFacts.IsReadOnly);
        });
        Test("family linked invalid and incomplete input documents are not captured", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document family = new Document("family"); family.Family = true; Equal("NOT_PROJECT", registry.Capture(family).Code);
            Document linked = new Document("linked"); linked.Linked = true; Equal("LINKED_DOCUMENT", registry.Capture(linked).Code);
            Document invalid = new Document("invalid"); invalid.Valid = false; Equal("DOCUMENT_INVALID", registry.Capture(invalid).Code);
            Document incomplete = new Document("unknown"); incomplete.Fingerprint = null; Equal("INSPECTION_INCOMPLETE", registry.Capture(incomplete).Code);
            Equal("DOCUMENT_REQUIRED", registry.Capture(null).Code);
        });
        Test("source callback reentry returns busy while Get remains available outside callback lock", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document document = new Document("open-a"); string handle = Capture(registry, document);
            source.OnInspect = delegate(Document inspected) {
                Equal("BUSY", registry.Capture(new Document("other")).Code);
                Equal("BUSY", Check(registry, handle).Code); Equal("BUSY", Release(registry, handle).Code);
                ProjectDocumentSnapshot snapshot = Get(registry, handle).Snapshot;
                Equal(ProjectIdentityReadiness.Unknown, snapshot.IdentityReadiness); Equal(null, snapshot.CurrentFacts);
            };
            Assert(Check(registry, handle).Ok, "Outer inspection failed.");
        });
        Test("cross-thread source pause keeps mutations busy without holding the registry lock", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document document = new Document("open-a"); string handle = Capture(registry, document);
            using (ManualResetEvent entered = new ManualResetEvent(false))
            using (ManualResetEvent resume = new ManualResetEvent(false))
            {
                ProjectDocumentResult workerResult = null; Exception workerError = null;
                source.OnInspect = delegate(Document inspected) { entered.Set(); if (!resume.WaitOne(5000)) throw new TimeoutException(); };
                Thread worker = new Thread(delegate() { try { workerResult = Check(registry, handle); } catch (Exception e) { workerError = e; } });
                worker.Start();
                try {
                    Assert(entered.WaitOne(5000), "Source did not enter.");
                    Equal("BUSY", registry.Capture(new Document("other")).Code);
                    Equal(ProjectIdentityReadiness.Unknown, Get(registry, handle).Snapshot.IdentityReadiness);
                }
                finally { resume.Set(); Assert(worker.Join(5000), "Worker did not finish."); }
                Assert(workerError == null && workerResult != null && workerResult.Ok, "Concurrent inspection failed.");
            }
        });
        Test("mixed candidate failures preserve invalid and unknown records without new handle", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document first = new Document("open-a"), second = new Document("open-b");
            string firstHandle = Capture(registry, first), secondHandle = Capture(registry, second);
            first.Valid = false; second.ThrowInspect = true;
            Equal("CAPTURE_UNCERTAIN", registry.Capture(new Document("open-c")).Code);
            Assert(Get(registry, firstHandle).Snapshot.Invalidated, "Known invalid fact lost.");
            Equal("INSPECTION_FAILED", Get(registry, secondHandle).Snapshot.CurrentCode);
            Assert(Get(registry, secondHandle).Snapshot.Retained, "Unknown candidate disappeared.");
        });
        Test("failed Capture observation cannot leave exact retained object Ready", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            Document document = new Document("open-a"); string handle = Capture(registry, document);
            document.NullInspect = true; Equal("INSPECTION_UNKNOWN", registry.Capture(document).Code);
            ProjectDocumentSnapshot snapshot = Get(registry, handle).Snapshot;
            Equal(null, snapshot.CurrentFacts); Equal("INSPECTION_UNKNOWN", snapshot.CurrentCode);
            Equal(ProjectIdentityReadiness.Unknown, snapshot.IdentityReadiness);
        });
        Test("aborted Capture marks unexamined retained records rather than leaving inspection in progress", delegate {
            Source source = new Source(); ProjectDocumentRegistry registry = Registry(source);
            string handle = Capture(registry, new Document("open-a"));
            Document input = new Document("unknown-input"); input.NullInspect = true;
            Equal("INSPECTION_UNKNOWN", registry.Capture(input).Code);
            ProjectDocumentSnapshot snapshot = Get(registry, handle).Snapshot;
            Equal("NOT_RECHECKED", snapshot.CurrentCode); Equal(null, snapshot.CurrentFacts);
            Equal(ProjectIdentityReadiness.Unknown, snapshot.IdentityReadiness);
            Assert(Check(registry, handle).Ok, "Owner remained busy after an aborted capture.");
        });
        Test("returned DTO contains no resource resolver or mutable public setters", delegate {
            foreach (Type type in new Type[] { typeof(ProjectDocumentSnapshot), typeof(ProjectDocumentFacts), typeof(ProjectDocumentResult) })
                foreach (System.Reflection.PropertyInfo property in type.GetProperties())
                {
                    Assert(property.PropertyType != typeof(object), "Opaque resource leaked through DTO.");
                    Assert(property.GetSetMethod(false) == null, "Mutable public DTO setter exposed.");
                }
            foreach (System.Reflection.MethodInfo method in typeof(ProjectDocumentRegistry).GetMethods())
                Assert(method.Name != "Close" && method.Name != "Resolve" && method.Name != "Save", "Document-control surface introduced.");
        });
        Test("production facts reader preserves required identity when auxiliary hash throws", delegate {
            GetterSource source = new GetterSource();
            source.Hash = delegate { throw new InvalidOperationException("PRIVATE diagnostic hash failure"); };
            ProjectDocumentRegistry registry = new ProjectDocumentRegistry("host-session", 1234, source);
            ProjectDocumentResult result = registry.Capture(new object());
            Assert(result.Ok, "Auxiliary hash failure revoked otherwise complete identity.");
            Equal(null, result.Snapshot.CurrentFacts.NativeOpenHash);
            Equal(true, result.Snapshot.CurrentFacts.IsValid); Equal(false, result.Snapshot.CurrentFacts.IsFamilyDocument);
            Equal(ProjectIdentityReadiness.Ready, result.Snapshot.IdentityReadiness);
        });
        Test("production facts reader keeps known flags after fingerprint getter failure", delegate {
            GetterSource source = new GetterSource();
            ProjectDocumentRegistry registry = new ProjectDocumentRegistry("host-session", 1234, source);
            string handle = registry.Capture(new object()).Snapshot.Handle;
            source.Fingerprint = delegate { throw new InvalidOperationException("PRIVATE fingerprint failure"); };
            ProjectDocumentResult result = Check(registry, handle);
            Assert(!result.Ok, "Missing required fingerprint accepted.");
            Equal("INSPECTION_INCOMPLETE", result.Snapshot.CurrentCode);
            Equal("getter-project", result.Snapshot.PersistentFingerprint);
            Equal(true, result.Snapshot.CurrentFacts.IsValid); Equal(false, result.Snapshot.CurrentFacts.IsFamilyDocument);
            Equal(false, result.Snapshot.CurrentFacts.IsLinked); Equal(false, result.Snapshot.CurrentFacts.IsReadOnly);
            Equal(null, result.Snapshot.CurrentFacts.PersistentFingerprint);
            Equal(ProjectIdentityReadiness.Unknown, result.Snapshot.IdentityReadiness);
        });
        Test("production facts reader stops after unknown or explicitly invalid validity", delegate {
            int otherCalls = 0;
            Func<bool> other = delegate { otherCalls++; return false; };
            Func<string> fingerprint = delegate { otherCalls++; return "should-not-read"; };
            Func<int> hash = delegate { otherCalls++; return 1; };
            ProjectDocumentFacts unknown = ProjectDocumentFactsReader.Read(
                delegate { throw new InvalidOperationException("PRIVATE validity failure"); }, other, other, other, fingerprint, hash);
            Equal(null, unknown.IsValid); Equal(null, unknown.IsFamilyDocument); Equal(0, otherCalls);
            ProjectDocumentFacts invalid = ProjectDocumentFactsReader.Read(delegate { return false; }, other, other, other, fingerprint, hash);
            Equal(false, invalid.IsValid); Equal(null, invalid.PersistentFingerprint); Equal(0, otherCalls);
        });
        Test("production facts reader preserves family and linked rejection without irrelevant identity getters", delegate {
            int irrelevantCalls = 0;
            Func<string> fingerprint = delegate { irrelevantCalls++; throw new InvalidOperationException("PRIVATE irrelevant getter"); };
            Func<int> hash = delegate { irrelevantCalls++; throw new InvalidOperationException("PRIVATE irrelevant hash"); };
            GetterSource family = new GetterSource(); family.Family = delegate { return true; }; family.Fingerprint = fingerprint; family.Hash = hash;
            ProjectDocumentRegistry familyRegistry = new ProjectDocumentRegistry("host-session", 1234, family);
            Equal("NOT_PROJECT", familyRegistry.Capture(new object()).Code);
            GetterSource linked = new GetterSource(); linked.Linked = delegate { return true; }; linked.Fingerprint = fingerprint; linked.Hash = hash;
            ProjectDocumentRegistry linkedRegistry = new ProjectDocumentRegistry("host-session", 1234, linked);
            Equal("LINKED_DOCUMENT", linkedRegistry.Capture(new object()).Code); Equal(0, irrelevantCalls);
        });
        Console.WriteLine("1.." + total); Console.WriteLine("# tests " + total);
        Console.WriteLine("# pass " + passed); Console.WriteLine("# fail " + failed);
        return failed == 0 ? 0 : 1;
    }
}
