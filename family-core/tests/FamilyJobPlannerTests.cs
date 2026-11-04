using System;
using System.Threading;
using BuildX.FamilyCore;

internal static class FamilyJobPlannerTests
{
    private const string Session = "planning-host";
    private const int Pid = 2468;
    private const string TemplateId = "metric-pipe-accessory";
    private const string Sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private sealed class Document
    {
        internal string OpenId, Fingerprint = "persistent-project";
        internal bool? Valid = true, Family = false, Linked = false, ReadOnly = false;
        internal bool ThrowInspect, NullInspect;
        internal Document(string openId) { OpenId = openId; }
    }
    private sealed class ProjectSource : IProjectDocumentSource
    {
        internal int Inspections;
        internal Action<Document> OnInspect;
        public ProjectDocumentFacts Inspect(object value)
        {
            Inspections++;
            Document document = (Document)value;
            if (OnInspect != null) OnInspect(document);
            if (document.ThrowInspect) throw new InvalidOperationException("PRIVATE project inspection payload");
            if (document.NullInspect) return null;
            return new ProjectDocumentFacts(document.Valid, document.Family, document.Linked,
                document.ReadOnly, document.Fingerprint, 99);
        }
        public bool? SameOpenDocument(object first, object second)
        { return String.Equals(((Document)first).OpenId, ((Document)second).OpenId, StringComparison.Ordinal); }
    }
    private sealed class TemplateSource : IFamilyTemplateSource
    {
        internal int Calls;
        internal bool Throw;
        internal Action OnInspect;
        internal FamilyTemplateObservation Observation = Verified();
        public FamilyTemplateObservation Inspect(string id)
        {
            Calls++;
            if (OnInspect != null) OnInspect();
            if (Throw) throw new InvalidOperationException("PRIVATE template read payload");
            return Observation;
        }
    }
    private sealed class Factory : IFamilyResourceFactory
    {
        internal int Calls;
        public FamilyCreationOutcome Create(FamilyCreationContext context)
        { Calls++; throw new InvalidOperationException("Planning must not create a document."); }
    }
    private sealed class Fixture
    {
        internal readonly ProjectSource Source = new ProjectSource();
        internal readonly TemplateSource Templates = new TemplateSource();
        internal readonly Factory Factory = new Factory();
        internal readonly Document Document = new Document("open-project");
        internal readonly ProjectDocumentRegistry Projects;
        internal readonly FamilyJobRegistry Jobs;
        internal readonly FamilyJobPlanner Planner;
        internal readonly string Handle;
        internal Fixture(int capacity = 8)
        {
            Projects = new ProjectDocumentRegistry(Session, Pid, Source);
            Jobs = new FamilyJobRegistry(Session, Pid, Factory, capacity);
            Planner = new FamilyJobPlanner(Session, Pid, Projects, Templates, Jobs);
            Handle = Projects.Capture(Document).Snapshot.Handle;
        }
        internal FamilyPlanningResult Prepare() { return Planner.Prepare(Handle, TemplateId); }
    }
    private static FamilyTemplateObservation Verified()
    { return new FamilyTemplateObservation(TemplateId, @"C:\fixed-templates\pipe-accessory.rft", FamilyTemplateState.BytesVerified, FamilyTemplateIssue.None, 8192, Sha); }
    private static FamilyTemplateObservation Observation(FamilyTemplateState state, FamilyTemplateIssue issue,
        string id = TemplateId, string path = @"C:\fixed-templates\pipe-accessory.rft", long? bytes = 8192, string sha = Sha)
    { return new FamilyTemplateObservation(id, path, state, issue, bytes, sha); }
    private static int count, passed, failed;
    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static void Equal(object expected, object actual)
    { Assert(Object.Equals(expected, actual), "Expected " + expected + ", received " + actual); }
    private static void Test(string name, Action action)
    {
        count++;
        try { action(); passed++; Console.WriteLine("ok " + count + " - " + name); }
        catch (Exception exception) { failed++; Console.WriteLine("not ok " + count + " - " + name); Console.WriteLine("# " + exception.Message.Replace('\r', ' ').Replace('\n', ' ')); }
    }
    private static void RejectArgument(Action action)
    {
        bool rejected = false;
        try { action(); } catch (ArgumentException) { rejected = true; }
        Assert(rejected, "Invalid constructor input accepted.");
    }
    private static void AssertUnexecuted(Fixture fixture, FamilyPlanningResult result)
    {
        Assert(result.Ok && result.PreparedJob != null, "Expected reservation: " + result.Code);
        Equal(FamilyJobStage.Prepared, result.PreparedJob.Stage);
        Equal(FamilyReadiness.Unknown, result.PreparedJob.Readiness);
        Assert(!result.PreparedJob.Owned && !result.PreparedJob.ResourceRetained, "Planning acquired a document resource.");
        Equal("FAMILY_NOT_ATTEMPTED", result.PreparedJob.CreationCode);
        Equal(0, fixture.Factory.Calls);
        FamilyJobResult query = fixture.Jobs.Get(result.PreparedJob.Handle, result.PreparedJob.Binding);
        Assert(query.Ok && query.Job.Stage == FamilyJobStage.Prepared, "Reservation missing from real job registry.");
    }
    private static void AssertNoReservationThenRecover(Fixture fixture, FamilyPlanningResult rejected)
    {
        Assert(!rejected.Ok && rejected.PreparedJob == null, "Rejected plan returned a reservation.");
        fixture.Templates.Throw = false; fixture.Templates.OnInspect = null; fixture.Templates.Observation = Verified();
        AssertUnexecuted(fixture, fixture.Prepare());
        Equal(0, fixture.Factory.Calls);
    }

    public static int Main()
    {
        Console.WriteLine("TAP version 13");
        Test("fixed host and all three trusted owners are required", delegate {
            Fixture fixture = new Fixture();
            RejectArgument(delegate { new FamilyJobPlanner("", Pid, fixture.Projects, fixture.Templates, fixture.Jobs); });
            RejectArgument(delegate { new FamilyJobPlanner(Session, 0, fixture.Projects, fixture.Templates, fixture.Jobs); });
            RejectArgument(delegate { new FamilyJobPlanner(Session, Pid, null, fixture.Templates, fixture.Jobs); });
            RejectArgument(delegate { new FamilyJobPlanner(Session, Pid, fixture.Projects, null, fixture.Jobs); });
            RejectArgument(delegate { new FamilyJobPlanner(Session, Pid, fixture.Projects, fixture.Templates, null); });
        });
        Test("planning performs two fresh production project checks and reserves without Create", delegate {
            Fixture fixture = new Fixture(); int before = fixture.Source.Inspections;
            FamilyPlanningResult result = fixture.Prepare(); AssertUnexecuted(fixture, result);
            Equal(before + 2, fixture.Source.Inspections); Equal(1, fixture.Templates.Calls);
            Equal(fixture.Handle, result.PreparedJob.Binding.ProjectDocumentHandle);
            Equal("persistent-project", result.PreparedJob.Binding.ProjectFingerprint);
            Equal(Sha, result.PreparedJob.Binding.TemplateSha256);
            Equal(ProjectIdentityReadiness.Ready, result.Project.IdentityReadiness);
            Equal(result.InitialProject.Handle, result.Project.Handle);
        });
        Test("standalone family reservation never borrows a project identity or creates a document", delegate {
            Fixture fixture = new Fixture(); int before = fixture.Source.Inspections;
            FamilyPlanningResult result = fixture.Planner.PrepareIndependent(TemplateId); AssertUnexecuted(fixture, result);
            Equal(before, fixture.Source.Inspections); Equal(null, result.Project); Equal(null, result.InitialProject);
            Assert(result.PreparedJob.Binding.IsIndependent, "Expected explicit standalone binding.");
            Equal(null, result.PreparedJob.Binding.ProjectDocumentHandle); Equal(null, result.PreparedJob.Binding.ProjectFingerprint);
            Equal(Sha, result.PreparedJob.Binding.TemplateSha256);
            FamilyJobBinding projectBinding = new FamilyJobBinding(Session, Pid, fixture.Handle, "persistent-project", Sha);
            Assert(!fixture.Jobs.Get(result.PreparedJob.Handle, projectBinding).Ok, "A project binding must not access a standalone job.");
        });
        Test("standalone reservation rejects unavailable template and invalid host inputs", delegate {
            Fixture fixture = new Fixture(1); fixture.Templates.Observation = Observation(FamilyTemplateState.NotFound, FamilyTemplateIssue.MissingFile, bytes: null, sha: null);
            FamilyPlanningResult result = fixture.Planner.PrepareIndependent(TemplateId);
            Equal("FAMILY_PLAN_TEMPLATE_NOT_VERIFIED", result.Code); Equal(null, result.PreparedJob); Equal(0, fixture.Factory.Calls);
            Equal("FAMILY_PLAN_INPUT_INVALID", fixture.Planner.PrepareIndependent("").Code);
            RejectArgument(delegate { FamilyJobBinding.Independent("", Pid, Sha); });
            RejectArgument(delegate { FamilyJobBinding.Independent(Session, Pid, "bad"); });
        });
        Test("standalone cabinet cannot reuse unapproved legacy save, load or discard paths", delegate {
            Equal("FAMILY_CABINET_SAVE_OPERATION_REQUIRED", FamilyJobOperationPolicy.Rejection(FamilyBuilderKind.Cabinet, "family_save_job"));
            Equal("FAMILY_CABINET_CLOSE_OPERATION_REQUIRED", FamilyJobOperationPolicy.Rejection(FamilyBuilderKind.Cabinet, "family_close_job"));
            Equal("FAMILY_CABINET_LOAD_NOT_AVAILABLE", FamilyJobOperationPolicy.Rejection(FamilyBuilderKind.Cabinet, "family_load_job"));
            Equal(null, FamilyJobOperationPolicy.Rejection(FamilyBuilderKind.Cabinet, "family_inspect_job"));
            Equal(null, FamilyJobOperationPolicy.Rejection(FamilyBuilderKind.Cabinet, "family_save_cabinet"));
            Equal(null, FamilyJobOperationPolicy.Rejection(FamilyBuilderKind.Cabinet, "family_close_cabinet"));
            Equal("FAMILY_OPERATION_UNKNOWN", FamilyJobOperationPolicy.Rejection(FamilyBuilderKind.Cabinet, "family_load_cabinet"));
            Equal("FAMILY_JOB_SCOPE_MISMATCH", FamilyJobOperationPolicy.Rejection((FamilyBuilderKind)999, "family_inspect_job"));
        });
        Test("legacy valve operations remain available and cannot impersonate cabinet job operations", delegate {
            Equal(null, FamilyJobOperationPolicy.Rejection(FamilyBuilderKind.Valve, "family_load_job"));
            Equal(null, FamilyJobOperationPolicy.Rejection(FamilyBuilderKind.Valve, "family_save_job"));
            Equal(null, FamilyJobOperationPolicy.Rejection(FamilyBuilderKind.Valve, "family_close_job"));
            Equal("FAMILY_VALVE_SAVE_OPERATION_REQUIRED", FamilyJobOperationPolicy.Rejection(FamilyBuilderKind.Valve, "family_save_cabinet"));
            Equal("FAMILY_VALVE_CLOSE_OPERATION_REQUIRED", FamilyJobOperationPolicy.Rejection(FamilyBuilderKind.Valve, "family_close_cabinet"));
        });
        Test("stale captured Ready cannot replace the first fresh readonly check", delegate {
            Fixture fixture = new Fixture(1); fixture.Document.ReadOnly = true;
            FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_PROJECT_READ_ONLY", result.Code);
            Equal(true, result.Project.CurrentFacts.IsReadOnly); Equal(0, fixture.Templates.Calls); Equal(null, result.PreparedJob);
            fixture.Document.ReadOnly = false; AssertUnexecuted(fixture, fixture.Prepare());
        });
        Test("invalid method inputs are rejected before source collection", delegate {
            Fixture fixture = new Fixture(); int inspections = fixture.Source.Inspections;
            Equal("FAMILY_PLAN_INPUT_INVALID", fixture.Planner.Prepare("", TemplateId).Code);
            Equal("FAMILY_PLAN_INPUT_INVALID", fixture.Planner.Prepare(fixture.Handle, "").Code);
            Equal("FAMILY_PLAN_INPUT_INVALID", fixture.Planner.Prepare(fixture.Handle, "bad\0id").Code);
            Equal(inspections, fixture.Source.Inspections); Equal(0, fixture.Templates.Calls); Equal(0, fixture.Factory.Calls);
        });
        Test("missing fixed template retains observation but no stale current project or reservation", delegate {
            Fixture fixture = new Fixture(1);
            fixture.Templates.Observation = Observation(FamilyTemplateState.NotFound, FamilyTemplateIssue.MissingFile, bytes: null, sha: null);
            FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_TEMPLATE_NOT_VERIFIED", result.Code);
            Equal(FamilyTemplateState.NotFound, result.Template.State); Equal(null, result.Project);
            Equal(ProjectIdentityReadiness.Ready, result.InitialProject.IdentityReadiness);
            Equal("PROJECT_RECHECK_REQUIRED", result.ProjectCheckCode); AssertNoReservationThenRecover(fixture, result);
        });
        Test("over-budget template is not treated as verified bytes", delegate {
            Fixture fixture = new Fixture(1);
            fixture.Templates.Observation = Observation(FamilyTemplateState.TooLarge, FamilyTemplateIssue.OverBudget, bytes: 100000000, sha: null);
            FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_TEMPLATE_NOT_VERIFIED", result.Code);
            Equal(100000000L, result.Template.ByteLength); AssertNoReservationThenRecover(fixture, result);
        });
        Test("verified bytes with cleanup failure retain evidence but cannot reserve a job", delegate {
            Fixture fixture = new Fixture(1);
            fixture.Templates.Observation = Observation(FamilyTemplateState.BytesVerified, FamilyTemplateIssue.CleanupFailure);
            FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_TEMPLATE_NOT_VERIFIED", result.Code);
            Equal(FamilyTemplateState.BytesVerified, result.Template.State); Equal(FamilyTemplateIssue.CleanupFailure, result.Template.Issue);
            Equal(TemplateId, result.Template.TemplateId); Equal(@"C:\fixed-templates\pipe-accessory.rft", result.Template.SourcePath);
            Equal(8192L, result.Template.ByteLength); Equal(Sha, result.Template.Sha256);
            Equal(null, result.Project); Equal(null, result.PreparedJob); Equal(0, fixture.Factory.Calls);
            AssertNoReservationThenRecover(fixture, result);
        });
        Test("unknown changed rejected and invalid enum states never reserve a job", delegate {
            Fixture fixture = new Fixture(1);
            foreach (FamilyTemplateState state in new FamilyTemplateState[] { FamilyTemplateState.Unknown, FamilyTemplateState.Changed, FamilyTemplateState.Rejected, (FamilyTemplateState)999 })
            {
                fixture.Templates.Observation = Observation(state, FamilyTemplateIssue.None);
                FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_TEMPLATE_NOT_VERIFIED", result.Code); Equal(null, result.PreparedJob);
            }
            fixture.Templates.Observation = Observation(FamilyTemplateState.BytesVerified, FamilyTemplateIssue.ReadFailure);
            Equal("FAMILY_PLAN_TEMPLATE_NOT_VERIFIED", fixture.Prepare().Code);
            fixture.Templates.Observation = Verified(); AssertUnexecuted(fixture, fixture.Prepare());
        });
        Test("null and thrown template sources use fixed failures and never reuse earlier observations", delegate {
            Fixture fixture = new Fixture(1); fixture.Templates.Observation = null;
            FamilyPlanningResult unknown = fixture.Prepare(); Equal("FAMILY_PLAN_TEMPLATE_UNKNOWN", unknown.Code); Equal(null, unknown.Project); Equal(null, unknown.Template);
            fixture.Templates.Observation = Verified(); fixture.Templates.Throw = true;
            FamilyPlanningResult thrown = fixture.Prepare(); Equal("FAMILY_PLAN_TEMPLATE_FAILED", thrown.Code); Equal(null, thrown.Project); Equal(null, thrown.Template);
            AssertNoReservationThenRecover(fixture, thrown);
        });
        Test("returned template id must exactly equal the selected id", delegate {
            Fixture fixture = new Fixture(1);
            fixture.Templates.Observation = Observation(FamilyTemplateState.BytesVerified, FamilyTemplateIssue.None, id: TemplateId.ToUpperInvariant());
            FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_TEMPLATE_ID_MISMATCH", result.Code);
            Equal(TemplateId.ToUpperInvariant(), result.Template.TemplateId); AssertNoReservationThenRecover(fixture, result);
        });
        Test("byte length and path must be explicit nonempty facts", delegate {
            Fixture fixture = new Fixture(1);
            foreach (long? bytes in new long?[] { null, 0, -1 })
            {
                fixture.Templates.Observation = Observation(FamilyTemplateState.BytesVerified, FamilyTemplateIssue.None, bytes: bytes);
                Equal("FAMILY_PLAN_TEMPLATE_FACTS_INVALID", fixture.Prepare().Code);
            }
            foreach (string path in new string[] { null, "", " ", "bad\0path" })
            {
                fixture.Templates.Observation = Observation(FamilyTemplateState.BytesVerified, FamilyTemplateIssue.None, path: path);
                Equal("FAMILY_PLAN_TEMPLATE_FACTS_INVALID", fixture.Prepare().Code);
            }
            fixture.Templates.Observation = Verified(); AssertUnexecuted(fixture, fixture.Prepare());
        });
        Test("existing binding parser rejects malformed SHA without duplicating checksum parsing", delegate {
            Fixture fixture = new Fixture(1);
            foreach (string sha in new string[] { null, "", "0123", new string('g', 64), new string('a', 63) })
            {
                fixture.Templates.Observation = Observation(FamilyTemplateState.BytesVerified, FamilyTemplateIssue.None, sha: sha);
                FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_BINDING_INVALID", result.Code); Equal(null, result.PreparedJob); Equal(sha, result.Template.Sha256);
            }
            fixture.Templates.Observation = Verified(); AssertUnexecuted(fixture, fixture.Prepare());
        });
        Test("binding normalization preserves original template evidence", delegate {
            Fixture fixture = new Fixture();
            fixture.Templates.Observation = Observation(FamilyTemplateState.BytesVerified, FamilyTemplateIssue.None, sha: Sha.ToUpperInvariant());
            FamilyPlanningResult result = fixture.Prepare(); AssertUnexecuted(fixture, result);
            Equal(Sha.ToUpperInvariant(), result.Template.Sha256); Equal(Sha, result.PreparedJob.Binding.TemplateSha256);
        });
        Test("project closing during template collection blocks reservation and preserves both observations", delegate {
            Fixture fixture = new Fixture(1); fixture.Templates.OnInspect = delegate { fixture.Document.Valid = false; };
            FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_PROJECT_UNAVAILABLE", result.Code);
            Equal(true, result.InitialProject.CurrentFacts.IsValid); Equal(false, result.Project.CurrentFacts.IsValid);
            Assert(result.Project.Invalidated && result.Template.State == FamilyTemplateState.BytesVerified && result.PreparedJob == null, "Lost partial facts or reserved for a closed project.");
            fixture.Templates.OnInspect = null; string next = fixture.Projects.Capture(new Document("reopened-project")).Snapshot.Handle;
            AssertUnexecuted(fixture, fixture.Planner.Prepare(next, TemplateId));
        });
        Test("project becoming readonly during template collection blocks reservation", delegate {
            Fixture fixture = new Fixture(1); fixture.Templates.OnInspect = delegate { fixture.Document.ReadOnly = true; };
            FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_PROJECT_READ_ONLY", result.Code);
            Equal(false, result.InitialProject.CurrentFacts.IsReadOnly); Equal(true, result.Project.CurrentFacts.IsReadOnly); Equal(null, result.PreparedJob);
            fixture.Document.ReadOnly = false; AssertNoReservationThenRecover(fixture, result);
        });
        Test("fingerprint drift during template collection remains a conflict and never reserves", delegate {
            Fixture fixture = new Fixture(1); fixture.Templates.OnInspect = delegate { fixture.Document.Fingerprint = "different-project"; };
            FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_PROJECT_UNAVAILABLE", result.Code);
            Assert(result.Project.IdentityConflict, "Real identity owner did not retain drift conflict.");
            Equal("persistent-project", result.InitialProject.PersistentFingerprint); Equal("different-project", result.Project.CurrentFacts.PersistentFingerprint);
            Equal(null, result.PreparedJob); Equal(0, fixture.Factory.Calls);
            fixture.Templates.OnInspect = null; fixture.Document.Valid = false;
            Assert(fixture.Projects.ReleaseInvalid(fixture.Handle, Session, Pid).Ok, "Invalid conflict metadata did not release.");
            string next = fixture.Projects.Capture(new Document("other-project")).Snapshot.Handle;
            AssertUnexecuted(fixture, fixture.Planner.Prepare(next, TemplateId));
        });
        Test("unknown project at first check prevents any template collection", delegate {
            Fixture fixture = new Fixture(1); fixture.Document.ReadOnly = null;
            FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_PROJECT_UNAVAILABLE", result.Code);
            Equal(null, result.Project.CurrentFacts.IsReadOnly); Equal(0, fixture.Templates.Calls); Equal(null, result.PreparedJob);
            fixture.Document.ReadOnly = false; AssertUnexecuted(fixture, fixture.Prepare());
        });
        Test("null project observation is not replaced by captured Ready and does not call templates", delegate {
            Fixture fixture = new Fixture(1); fixture.Document.NullInspect = true;
            FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_PROJECT_UNAVAILABLE", result.Code);
            Equal("INSPECTION_UNKNOWN", result.ProjectCheckCode); Equal(null, result.Project.CurrentFacts);
            Equal(ProjectIdentityReadiness.Unknown, result.Project.IdentityReadiness); Equal(0, fixture.Templates.Calls);
            fixture.Document.NullInspect = false; AssertUnexecuted(fixture, fixture.Prepare());
        });
        Test("second inspection exception clears current facts while retaining verified template and first snapshot", delegate {
            Fixture fixture = new Fixture(1); fixture.Templates.OnInspect = delegate { fixture.Document.ThrowInspect = true; };
            FamilyPlanningResult result = fixture.Prepare(); Equal("FAMILY_PLAN_PROJECT_UNAVAILABLE", result.Code);
            Equal("INSPECTION_FAILED", result.ProjectCheckCode); Equal(null, result.Project.CurrentFacts);
            Equal(ProjectIdentityReadiness.Unknown, result.Project.IdentityReadiness);
            Equal(ProjectIdentityReadiness.Ready, result.InitialProject.IdentityReadiness);
            Equal(FamilyTemplateState.BytesVerified, result.Template.State); Equal(null, result.PreparedJob);
            fixture.Document.ThrowInspect = false; AssertNoReservationThenRecover(fixture, result);
        });
        Test("released old handle and foreign host are rejected before templates", delegate {
            Fixture fixture = new Fixture(); fixture.Document.Valid = false;
            Assert(fixture.Projects.ReleaseInvalid(fixture.Handle, Session, Pid).Ok, "Could not release invalid metadata.");
            FamilyPlanningResult missing = fixture.Prepare(); Equal("HANDLE_NOT_FOUND", missing.ProjectCheckCode); Equal(0, fixture.Templates.Calls);
            FamilyJobPlanner foreign = new FamilyJobPlanner("other-host", Pid, fixture.Projects, fixture.Templates, fixture.Jobs);
            Equal("HOST_MISMATCH", foreign.Prepare(fixture.Handle, TemplateId).ProjectCheckCode); Equal(0, fixture.Templates.Calls);
        });
        Test("wrong job registry host fails reservation without invoking its factory", delegate {
            Fixture fixture = new Fixture(); Factory otherFactory = new Factory();
            FamilyJobRegistry otherJobs = new FamilyJobRegistry("other-host", Pid, otherFactory, 1);
            FamilyJobPlanner planner = new FamilyJobPlanner(Session, Pid, fixture.Projects, fixture.Templates, otherJobs);
            FamilyPlanningResult result = planner.Prepare(fixture.Handle, TemplateId);
            Equal("FAMILY_PLAN_RESERVATION_FAILED", result.Code); Equal("FAMILY_BINDING_MISMATCH", result.JobCode); Equal(null, result.PreparedJob); Equal(0, otherFactory.Calls);
        });
        Test("template source reentry returns busy while real project owner remains accessible", delegate {
            Fixture fixture = new Fixture(1); int calls = 0;
            fixture.Templates.OnInspect = delegate {
                calls++; Equal("FAMILY_PLAN_BUSY", fixture.Prepare().Code);
                Assert(fixture.Projects.Get(fixture.Handle, Session, Pid).Ok, "Planner held an external owner lock.");
            };
            AssertUnexecuted(fixture, fixture.Prepare()); Equal(1, calls); Equal(1, fixture.Templates.Calls);
        });
        Test("project source reentry is rejected while Check runs outside planner lock", delegate {
            Fixture fixture = new Fixture(1); int callbacks = 0;
            fixture.Source.OnInspect = delegate(Document document) {
                callbacks++; Equal("FAMILY_PLAN_BUSY", fixture.Prepare().Code);
                Equal(ProjectIdentityReadiness.Unknown, fixture.Projects.Get(fixture.Handle, Session, Pid).Snapshot.IdentityReadiness);
            };
            AssertUnexecuted(fixture, fixture.Prepare()); Equal(2, callbacks);
        });
        Test("cross-thread template pause rejects concurrent Prepare without holding planner lock", delegate {
            Fixture fixture = new Fixture(1);
            using (ManualResetEvent entered = new ManualResetEvent(false))
            using (ManualResetEvent resume = new ManualResetEvent(false))
            {
                fixture.Templates.OnInspect = delegate { entered.Set(); if (!resume.WaitOne(5000)) throw new TimeoutException(); };
                FamilyPlanningResult workerResult = null; Exception workerError = null;
                Thread worker = new Thread(delegate() { try { workerResult = fixture.Prepare(); } catch (Exception e) { workerError = e; } });
                worker.Start();
                try { Assert(entered.WaitOne(5000), "Template source did not enter."); Equal("FAMILY_PLAN_BUSY", fixture.Prepare().Code); }
                finally { resume.Set(); Assert(worker.Join(5000), "Planning thread did not finish."); }
                Assert(workerError == null, "Outer planning threw."); AssertUnexecuted(fixture, workerResult);
            }
        });
        Test("repeat planning creates separate reservations and capacity is owned by real registry", delegate {
            Fixture fixture = new Fixture(2); FamilyPlanningResult first = fixture.Prepare(), second = fixture.Prepare();
            AssertUnexecuted(fixture, first); AssertUnexecuted(fixture, second);
            Assert(first.PreparedJob.Handle != second.PreparedJob.Handle, "Repeated Prepare silently reused reservation.");
            FamilyPlanningResult full = fixture.Prepare(); Equal("FAMILY_PLAN_RESERVATION_FAILED", full.Code); Equal("FAMILY_CAPACITY", full.JobCode); Equal(null, full.PreparedJob); Equal(0, fixture.Factory.Calls);
        });
        Test("planning output has no model write authorization resource or public mutable setters", delegate {
            foreach (System.Reflection.PropertyInfo property in typeof(FamilyPlanningResult).GetProperties())
            {
                Assert(property.Name != "ModelWriteAuthorized" && property.PropertyType != typeof(object), "Authority or resource leaked.");
                Assert(property.GetSetMethod(false) == null, "Output has a public setter.");
            }
            foreach (System.Reflection.MethodInfo method in typeof(FamilyJobPlanner).GetMethods())
                Assert(method.Name != "Create" && method.Name != "Close" && method.Name != "Get" && method.Name != "Resolve", "Execution or extra plan store exposed.");
        });
        Console.WriteLine("1.." + count); Console.WriteLine("# tests " + count);
        Console.WriteLine("# pass " + passed); Console.WriteLine("# fail " + failed);
        return failed == 0 ? 0 : 1;
    }
}
