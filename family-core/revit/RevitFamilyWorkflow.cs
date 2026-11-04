using System;
using System.Collections.Generic;
using System.Globalization;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Threading;
using System.Web.Script.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using BuildX.FamilyCore;

namespace BuildX.FamilyRevit
{
    // BEGIN REVIT CONFIGURED TEMPLATE SOURCE
    // The Revit API owns the directory selection. This source never infers a
    // language folder or substitutes another template when that setting is
    // absent, invalid, or changes during a job.
    internal sealed class RevitConfiguredTemplateSource : IFamilyTemplateSource
    {
        private readonly Func<string> configuredDirectory;
        private FamilyTemplateCatalog catalog;
        private string catalogDirectory;

        internal RevitConfiguredTemplateSource(Func<string> configuredDirectory)
        {
            if (configuredDirectory == null) throw new ArgumentNullException("configuredDirectory");
            this.configuredDirectory = configuredDirectory;
        }

        public FamilyTemplateObservation Inspect(string templateId)
        {
            if (templateId != "metric-generic-model" && templateId != "metric-mechanical-equipment")
                return Unknown(templateId, FamilyTemplateIssue.UnknownId);
            string directory;
            try
            {
                string configured = configuredDirectory();
                if (String.IsNullOrWhiteSpace(configured) || configured.Length < 3 ||
                    !Char.IsLetter(configured[0]) || configured[1] != ':' ||
                    (configured[2] != '\\' && configured[2] != '/'))
                    return UnknownDirectory(templateId);
                directory = Path.GetFullPath(configured);
            }
            catch (Exception) { return UnknownDirectory(templateId); }

            if (catalog != null && !String.Equals(directory, catalogDirectory, StringComparison.OrdinalIgnoreCase))
            {
                // Never discard an owner retaining failed cleanup. Retrying an
                // inspection gives that exact owner its existing cleanup path.
                if (catalog.PendingCleanupCount != 0)
                {
                    catalog.Inspect(templateId);
                    if (catalog.PendingCleanupCount != 0)
                        return Unknown(templateId, FamilyTemplateIssue.CleanupFailure);
                }
                catalog = null;
                catalogDirectory = null;
            }
            if (catalog == null)
            {
                try
                {
                    catalog = new FamilyTemplateCatalog(new[] {
                        new FamilyTemplateLocation("metric-generic-model", Path.Combine(directory, "公制常规模型.rft")),
                        new FamilyTemplateLocation("metric-mechanical-equipment", Path.Combine(directory, "公制机械设备.rft"))
                    });
                    catalogDirectory = directory;
                }
                catch (Exception) { return Unknown(templateId, FamilyTemplateIssue.ReadFailure); }
            }
            return catalog.Inspect(templateId);
        }

        private static FamilyTemplateObservation Unknown(string templateId, FamilyTemplateIssue issue)
        { return new FamilyTemplateObservation(templateId, null, FamilyTemplateState.Unknown, issue, null, null); }

        private FamilyTemplateObservation UnknownDirectory(string templateId)
        {
            // A failed settings read must not hide an earlier retained handle.
            if (catalog != null && catalog.PendingCleanupCount != 0)
            {
                catalog.Inspect(templateId);
                if (catalog.PendingCleanupCount != 0)
                    return Unknown(templateId, FamilyTemplateIssue.CleanupFailure);
            }
            return Unknown(templateId, FamilyTemplateIssue.ReadFailure);
        }
    }
    // END REVIT CONFIGURED TEMPLATE SOURCE

    // Pure, bounded diagnostics. This owner never reads exception Data, argument
    // values, document contents, environment, source paths or a full ToString.
    public static class FamilyWorkflowDiagnostics
    {
        public const int MessageLimit = 1024;
        public const int FrameLimit = 8;
        public static Dictionary<string, object> Capture(string stage, Exception error)
        {
            var result = new Dictionary<string, object> { { "source", "exception" }, { "stage", Bound(stage, 96) } };
            if (error == null) { result["capture_failed"] = true; return result; }
            var chain = new List<object>();
            Exception current = error;
            for (int depth = 0; depth < 3 && current != null; depth++)
            {
                string message = null; bool readable = true;
                try { message = current.Message; } catch { readable = false; }
                var frames = new List<object>();
                try
                {
                    var trace = new StackTrace(current, false);
                    for (int index = 0; index < Math.Min(trace.FrameCount, 48) && frames.Count < FrameLimit; index++)
                    {
                        StackFrame frame = trace.GetFrame(index);
                        System.Reflection.MethodBase method = frame == null ? null : frame.GetMethod();
                        string type = method == null || method.DeclaringType == null ? null : method.DeclaringType.FullName;
                        if (type == null || (!type.StartsWith("BuildX.", StringComparison.Ordinal) && !type.StartsWith("Autodesk.Revit.", StringComparison.Ordinal))) continue;
                        frames.Add(new { type = Bound(type, 256), method = Bound(method.Name, 128), il_offset = frame.GetILOffset() });
                    }
                }
                catch { /* Diagnostic stack access must not replace the cause. */ }
                chain.Add(new { exception_type = Bound(current.GetType().FullName, 256), hresult = current.HResult,
                    message = Bound(message, MessageLimit), message_truncated = message != null && message.Length > MessageLimit,
                    message_unavailable = !readable, code_frames = frames });
                current = current.InnerException;
            }
            result["exception_chain"] = chain;
            result["inner_chain_truncated"] = current != null;
            return result;
        }
        public static Dictionary<string, object> RevitFailure(string stage, string severity, string definitionId, string description)
        {
            return new Dictionary<string, object> { { "source", "revit_failure" }, { "stage", Bound(stage, 96) },
                { "severity", Bound(severity, 32) }, { "failure_definition_id", Bound(definitionId, 64) },
                { "message", Bound(description, MessageLimit) }, { "message_truncated", description != null && description.Length > MessageLimit } };
        }
        private static string Bound(string value, int limit)
        {
            if (value == null || value.Length <= limit) return value;
            int end = limit;
            if (end > 0 && Char.IsHighSurrogate(value[end - 1]) && Char.IsLowSurrogate(value[end])) end--;
            return value.Substring(0, end);
        }
    }

    /// <summary>
    /// Trusted ExternalEvent/API-callback composition. This is an independent
    /// family lifecycle, never an extension of the project script transaction.
    /// Only newly created/reopened owned family documents may be closed here.
    /// </summary>
    public sealed class RevitFamilyWorkflow
    {
        private const string GenericTemplate = "metric-generic-model";
        private const long ArtifactLimit = 64L * 1024 * 1024;
        private readonly string session, root, sample, artifacts;
        private readonly int pid, apiThread;
        private readonly object gate = new object();
        private readonly ProjectDocumentRegistry projects;
        private readonly IFamilyTemplateSource templates;
        private readonly FamilyJobRegistry jobs;
        private readonly FamilyJobPlanner planner;
        private readonly Dictionary<string, Record> records = new Dictionary<string, Record>(StringComparer.Ordinal);
        private readonly List<string> recordOrder = new List<string>();
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 512 * 1024, RecursionLimit = 40 };
        private readonly string[] templateIds = { GenericTemplate, "metric-mechanical-equipment" };
        private bool busy;
        private UIApplication currentApp;
        private Record creating;
        private readonly FamilyLifecycleApprovalBook lifecycleApprovals = new FamilyLifecycleApprovalBook();
        private Autodesk.Revit.ApplicationServices.Application approvalApplication;
        private UIApplication approvalUiApplication;
        private bool approvalEventsFailed;
        private readonly Action<bool> publishApprovalCapability;
        public bool ApprovalObserverReady { get { return !approvalEventsFailed && approvalApplication != null && approvalUiApplication != null && lifecycleApprovals.Healthy; } }

        private sealed class Record
        {
            internal FamilyJobSnapshot Job;
            internal FamilyTemplateObservation Template;
            internal string TemplateId;
            internal Document Project; // Borrowed target; never closed.
            internal FamilyResource Resource;
            internal bool CreationAttempted, Created, BuildAttempted, BuildComplete, SaveAttempted, SavedVerified;
            internal string BuildState = "not_started", SaveState = "not_started", SavedPath, SavedSha;
            internal long? SavedBytes;
            internal object Geometry, BuildValidation, ReopenedGeometry;
            internal double LengthMm, DiameterMm;
            internal FamilyBuilderKind BuilderKind = FamilyBuilderKind.Valve;
            internal double WidthMm, DepthMm, HeightMm, ThicknessMm;
            internal int ShelfCount;
            internal Document VerificationDocument;
            internal Document[] VerificationBefore;
            internal bool VerificationOwnershipConfirmed;
            internal Transaction FamilyTransaction, ProjectTransaction;
            internal SubTransaction ValidationTransaction;
            internal TransactionGroup ProjectGroup;
            internal string FamilyNativeStatus, ProjectNativeStatus, GroupNativeStatus, ValidationNativeStatus;
            internal FileStream HashStream;
            internal SHA256 HashAlgorithm;
            internal Dictionary<string, object> LastLoad;
            internal string LastCode = "FAMILY_PREPARED";
            internal string DiagnosticStage = "family.prepared";
            internal object TemplateBaseline;
            internal readonly List<Dictionary<string, object>> Diagnostics = new List<Dictionary<string, object>>();
            internal int DiagnosticsOmitted;
            internal object ApprovalValidation;
        }
        private sealed class Failure : Exception
        {
            internal readonly string Code, Outcome;
            internal Failure(string code, string outcome = "failed") { Code = code; Outcome = outcome; }
        }
        private sealed class CreationFactory : IFamilyResourceFactory
        {
            private readonly RevitFamilyWorkflow owner;
            internal CreationFactory(RevitFamilyWorkflow owner) { this.owner = owner; }
            public FamilyCreationOutcome Create(FamilyCreationContext context)
            {
                Record record = owner.creating;
                if (record == null || record.Job.JobId != context.JobId || owner.currentApp == null)
                    return context.NotCreated();
                try { owner.RequireJobProject(owner.currentApp, record, owner.sample); owner.RequireTemplate(record); }
                catch (Exception error) { Capture(record, error); record.LastCode = "FAMILY_PRECREATE_CHECK_FAILED"; return context.NotCreated(); }
                record.CreationAttempted = true;
                record.DiagnosticStage = "family.document.new";
                Document document;
                try { document = owner.currentApp.Application.NewFamilyDocument(record.Template.SourcePath); }
                catch (Exception error) { Capture(record, error); throw; }
                if (document == null) return context.Unknown();
                // No further API work occurs between receipt registration and
                // retaining this exact newly created resource for diagnostics.
                var resource = new FamilyResource(owner, record, document, context.JobId, context.Binding);
                record.Resource = resource; record.Created = true;
                return context.CreatedTemporary(resource);
            }
        }
        private sealed class FamilyResource : IFamilyJobResource
        {
            private readonly RevitFamilyWorkflow owner;
            private readonly Record record;
            private readonly string jobId;
            private readonly FamilyJobBinding binding;
            internal Document Document;
            internal FamilyResource(RevitFamilyWorkflow owner, Record record, Document document, string jobId, FamilyJobBinding binding)
            { this.owner = owner; this.record = record; Document = document; this.jobId = jobId; this.binding = binding; }
            public FamilyResourceFacts Inspect()
            {
                try
                {
                    owner.RequireThread();
                    if (Document == null) return new FamilyResourceFacts(false, null, jobId, binding);
                    bool valid = Document.IsValidObject;
                    return new FamilyResourceFacts(valid, valid ? (bool?)Document.IsFamilyDocument : null, jobId, binding);
                }
                catch (Exception error) { CaptureAt(record, "family.resource.inspect", error); throw; }
            }
            public FamilyCloseOutcome Close()
            {
                try
                {
                    owner.RequireThread();
                    if (!owner.FinishFamilyTransaction(record)) return FamilyCloseOutcome.Unknown;
                    if (Document == null) return FamilyCloseOutcome.ConfirmedClosed;
                    if (!Document.IsValidObject) { Document = null; return FamilyCloseOutcome.ConfirmedClosed; }
                    if (!Document.IsFamilyDocument || Document.IsModifiable || owner.IsActive(Document))
                        return FamilyCloseOutcome.NotClosed;
                    bool closed = Document.Close(false);
                    if (closed) { Document = null; return FamilyCloseOutcome.ConfirmedClosed; }
                    return FamilyCloseOutcome.NotClosed;
                }
                catch (Exception error) { CaptureAt(record, "family.resource.close", error); throw; }
            }
        }
        private sealed class RejectReplacement : IFamilyLoadOptions
        {
            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues)
            { overwriteParameterValues = false; return false; }
            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            { source = FamilySource.Project; overwriteParameterValues = false; return false; }
        }
        private sealed class RollBackErrors : IFailuresPreprocessor
        {
            private readonly Record record;
            internal RollBackErrors(Record record) { this.record = record; }
            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                bool error = false;
                foreach (FailureMessageAccessor failure in accessor.GetFailureMessages())
                    if (failure.GetSeverity() == FailureSeverity.Warning) accessor.DeleteWarning(failure);
                    else if (failure.GetSeverity() >= FailureSeverity.Error)
                    {
                        error = true;
                        try { AddDiagnostic(record, FamilyWorkflowDiagnostics.RevitFailure(record.DiagnosticStage, failure.GetSeverity().ToString(), failure.GetFailureDefinitionId().Guid.ToString(), failure.GetDescriptionText())); }
                        catch { /* Failure processing retains its rollback decision. */ }
                    }
                return error ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
            }
        }

        public RevitFamilyWorkflow(string hostSession, int hostPid, string workbenchRoot, Action<bool> publishCapability = null)
        {
            if (String.IsNullOrWhiteSpace(hostSession) || hostPid <= 0 || String.IsNullOrWhiteSpace(workbenchRoot))
                throw new ArgumentException("Trusted host identity and workbench root are required.");
            session = hostSession; pid = hostPid; root = Path.GetFullPath(workbenchRoot);
            publishApprovalCapability = publishCapability;
            sample = Path.GetFullPath(Path.Combine(root, "samples", "Argus-Codex-Plumbing-Sample.rvt"));
            artifacts = Path.GetFullPath(Path.Combine(root, "family-artifacts"));
            apiThread = Thread.CurrentThread.ManagedThreadId;
            projects = new ProjectDocumentRegistry(session, pid, new RevitProjectDocumentSource(apiThread));
            templates = new RevitConfiguredTemplateSource(delegate {
                return currentApp == null ? null : currentApp.Application.FamilyTemplatePath;
            });
            jobs = new FamilyJobRegistry(session, pid, new CreationFactory(this));
            planner = new FamilyJobPlanner(session, pid, projects, templates, jobs);
        }

        public object Execute(UIApplication app, string operation, Dictionary<string, object> args)
        {
            Record record = null;
            lock (gate)
            {
                if (busy) return Response(operation, false, "FAMILY_WORKFLOW_BUSY", "not_started", null, null);
                busy = true;
            }
            try
            {
                RequireThread();
                if (app == null || args == null) throw new Failure("FAMILY_ARGUMENTS_REQUIRED");
                currentApp = app;
                if (operation == "family_templates")
                    return Response(operation, true, "FAMILY_TEMPLATES_OBSERVED", "read_only", null,
                        new Dictionary<string, object> { { "templates", templateIds.Select(id => TemplateDto(templates.Inspect(id))).ToArray() }, { "bytes_only_not_native_format", true } });
                if (operation == "family_create_valve") return CreateValve(app, args, out record);
                if (operation == "family_create_cabinet") return CreateCabinet(app, args, out record);
                string handle = Text(args, "job_handle");
                if (operation == "family_inspect_job" && handle.Length == 0)
                    return Response(operation, true, "FAMILY_HOST_HISTORY", "historical_metadata_only", null,
                        new { jobs = recordOrder.AsEnumerable().Reverse().Take(8).Select(id => {
                            Record item = records[id];
                            return new { job_handle = item.Job.Handle, job_id = item.Job.JobId, stage = item.Job.Stage.ToString(), build_state = item.BuildState, save_state = item.SaveState, artifact = item.SavedPath, last_code = item.LastCode };
                        }).ToArray(), returned = Math.Min(records.Count, 8), retained = records.Count, incomplete_history = records.Count > 8, live_documents_inspected = false });
                if (!records.TryGetValue(handle, out record)) throw new Failure("FAMILY_JOB_NOT_FOUND_IN_THIS_HOST");
                string operationRejection = FamilyJobOperationPolicy.Rejection(record.BuilderKind, operation);
                if (operationRejection != null) throw new Failure(operationRejection);
                if (operation == "family_inspect_job")
                {
                    record.DiagnosticStage = "family.inspect.read";
                    object detail = null;
                    if (record.Resource != null && record.Resource.Document != null && record.Resource.Document.IsValidObject)
                        detail = Freeze(record.BuilderKind == FamilyBuilderKind.Cabinet ? ParametricCabinetBuilder.Inspect(record.Resource.Document) : ParametricValveBuilder.Inspect(record.Resource.Document));
                    object approval = null;
                    object requestedApproval;
                    if (args.TryGetValue("request_lifecycle_approval", out requestedApproval) && requestedApproval is bool && (bool)requestedApproval) try
                    {
                        EnsureApprovalEvents(app);
                        object review = LifecycleReview(app, record, detail);
                        string snapshot = json.Serialize(review);
                        if (snapshot.Length > 200000) throw new Failure("FAMILY_APPROVAL_REVIEW_TOO_LARGE");
                        approval = lifecycleApprovals.Issue(record.Job.Handle, snapshot, review, DateTime.UtcNow);
                    }
                    catch { /* Inspection remains read-only; unavailable approval is never a grant. */ }
                    return Response(operation, true, "FAMILY_JOB_INSPECTED", "read_only", record, detail, approval);
                }
                if (operation == "family_save_job" || operation == "family_close_job")
                    RequireLifecycleApproval(app, operation, args, record);
                if (operation == "family_close_job" || operation == "family_close_cabinet")
                {
                    record.DiagnosticStage = "family.close.cleanup";
                    bool projectClean = FinishProjectResources(record);
                    bool verificationClean = CloseVerification(record);
                    bool hashClean = FinishHashResources(record);
                    bool sideResources = projectClean && verificationClean && hashClean;
                    if (!sideResources) return Response(operation, false, "FAMILY_CLEANUP_PENDING", "unknown", record, null);
                    FamilyJobResult closed = jobs.RequestClose(record.Job.Handle, record.Job.Binding);
                    if (closed.Job != null) record.Job = closed.Job;
                    return Response(operation, closed.Ok, closed.Code, closed.Ok ? "closed" : "cleanup_pending", record, null);
                }
                if (operation == "family_save_job" || operation == "family_save_cabinet") return Save(app, args, record);
                // The legacy load operation has no independent per-call human
                // approval owner. Never let a cabinet job reuse it to bypass
                // the required separate load authorization.
                if (operation == "family_load_job") return Load(app, args, record);
                throw new Failure("FAMILY_OPERATION_UNKNOWN");
            }
            catch (Failure failure)
            { if (record != null) record.LastCode = failure.Code; return Response(operation, false, failure.Code, failure.Outcome, record, null); }
            catch (Exception error)
            {
                // Never turn an exception after creation/save/load into a
                // missing job or advice to replay the original model operation.
                if (record != null) { Capture(record, error); record.LastCode = "FAMILY_OPERATION_OUTCOME_UNKNOWN"; }
                return Response(operation, false, "FAMILY_OPERATION_OUTCOME_UNKNOWN", "unknown", record, null);
            }
            finally { if (record != null) record.ApprovalValidation = null; currentApp = null; creating = null; lock (gate) busy = false; }
        }

        private void EnsureApprovalEvents(UIApplication app)
        {
            RequireThread();
            if (approvalEventsFailed || !lifecycleApprovals.Healthy) throw new Failure("FAMILY_APPROVAL_OBSERVER_UNAVAILABLE");
            if (approvalApplication != null && approvalUiApplication != null)
            {
                // Revit can supply a new managed UIApplication wrapper for a
                // callback. The original event source stays owned for this
                // process/session; document identity is rechecked separately.
                return;
            }
            try
            {
                // Retain the exact event source before adding the handler: if
                // subscription reports an error after partially succeeding,
                // shutdown still owns the corresponding removal attempt.
                approvalApplication = app.Application;
                approvalUiApplication = app;
                approvalApplication.DocumentChanged += OnApprovalDocumentChanged;
                approvalUiApplication.ViewActivated += OnApprovalViewActivated;
                if (publishApprovalCapability != null) publishApprovalCapability(true);
            }
            catch { DisableApprovalObserver(); throw new Failure("FAMILY_APPROVAL_OBSERVER_UNAVAILABLE"); }
        }

        public void InitializeApprovalObserver(UIApplication app)
        {
            if (app == null) throw new ArgumentNullException("app");
            EnsureApprovalEvents(app);
        }

        private void DisableApprovalObserver()
        {
            approvalEventsFailed = true; lifecycleApprovals.Disable();
            try { if (publishApprovalCapability != null) publishApprovalCapability(false); } catch { /* Native writes remain blocked. */ }
        }

        private void OnApprovalDocumentChanged(object sender, Autodesk.Revit.DB.Events.DocumentChangedEventArgs args)
        {
            // Revit raises this for transaction commit, undo and redo. Invalidate
            // conservatively for every document, including unrelated projects.
            try
            {
                if (Thread.CurrentThread.ManagedThreadId != apiThread) { DisableApprovalObserver(); return; }
                lifecycleApprovals.Changed();
                if (!lifecycleApprovals.Healthy) DisableApprovalObserver();
            }
            catch { DisableApprovalObserver(); }
        }

        private void OnApprovalViewActivated(object sender, Autodesk.Revit.UI.Events.ViewActivatedEventArgs args)
        {
            // A view/document switch also invalidates prior approvals, even
            // when the user later returns to the same project.
            try
            {
                if (Thread.CurrentThread.ManagedThreadId != apiThread) { DisableApprovalObserver(); return; }
                lifecycleApprovals.Changed();
                if (!lifecycleApprovals.Healthy) DisableApprovalObserver();
            }
            catch { DisableApprovalObserver(); }
        }

        public void DisposeApprovalObserver()
        {
            RequireThread();
            DisableApprovalObserver();
            if (approvalApplication == null && approvalUiApplication == null) return;
            // Keep the original application/event owner if unsubscription fails.
            if (approvalApplication != null) { approvalApplication.DocumentChanged -= OnApprovalDocumentChanged; approvalApplication = null; }
            if (approvalUiApplication != null) { approvalUiApplication.ViewActivated -= OnApprovalViewActivated; approvalUiApplication = null; }
        }

        private object LifecycleReview(UIApplication app, Record record, object detail)
        {
            RequireThread();
            if (!ApprovalObserverReady || record.BuilderKind != FamilyBuilderKind.Valve)
                throw new Failure("FAMILY_APPROVAL_OBSERVER_UNAVAILABLE");
            RequireJobProject(app, record, sample);
            FamilyJobResult current = jobs.Get(record.Job.Handle, record.Job.Binding);
            if (!current.Ok || current.Job == null) throw new Failure("FAMILY_APPROVAL_JOB_UNAVAILABLE");
            record.Job = current.Job;
            Document family = record.Resource == null ? null : record.Resource.Document;
            bool live = family != null && family.IsValidObject;
            if (live && (!family.IsFamilyDocument || family.IsModifiable)) throw new Failure("FAMILY_APPROVAL_DOCUMENT_BUSY");
            bool cleanup = record.FamilyTransaction != null || record.ProjectTransaction != null || record.ValidationTransaction != null || record.ProjectGroup != null || record.VerificationDocument != null || record.HashStream != null || record.HashAlgorithm != null;
            return new { host_session = session, revit_pid = pid, job_handle = record.Job.Handle,
                project_handle = record.Job.Binding.ProjectDocumentHandle, project_fingerprint = record.Job.Binding.ProjectFingerprint,
                template_id = record.TemplateId, template_sha256 = record.Job.Binding.TemplateSha256, template_current_verified = (bool?)null,
                stage = record.Job.Stage.ToString(), build_state = record.BuildState, build_complete = record.BuildComplete,
                family_transaction = record.FamilyNativeStatus, owned = record.Job.Owned, resource_retained = record.Job.ResourceRetained,
                ownership_conflict = record.Job.OwnershipConflict, family_document_live = live,
                family_document_modified = live ? (bool?)family.IsModified : null, family_content = detail,
                save = new { attempted = record.SaveAttempted, state = record.SaveState, path = record.SavedPath, sha256 = record.SavedSha, independently_reopened_verified = record.SavedVerified },
                cleanup_pending = cleanup };
        }

        private void RequireLifecycleApproval(UIApplication app, string operation, Dictionary<string, object> args, Record record)
        {
            object raw; Dictionary<string, object> provided = null; string token = null;
            if (args.TryGetValue("approved_lifecycle", out raw)) provided = raw as Dictionary<string, object>;
            if (provided != null) token = Text(provided, "approval_token");
            record.ApprovalValidation = new { schema_version = 1, operation, approval_token = token, verified = false };
            object schema;
            if (provided == null || provided.Count != 3 || !provided.TryGetValue("schema_version", out schema) || !(schema is int) || (int)schema != 1 ||
                Text(provided, "operation") != operation || token == null || token.Length != 32 || token.Any(c => !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))))
                throw new Failure("FAMILY_APPROVAL_STALE", "not_started");
            try
            {
                EnsureApprovalEvents(app);
                object detail = null;
                if (record.Resource != null && record.Resource.Document != null && record.Resource.Document.IsValidObject)
                    detail = Freeze(ParametricValveBuilder.Inspect(record.Resource.Document));
                object review = LifecycleReview(app, record, detail);
                string snapshot = json.Serialize(review);
                if (snapshot.Length > 200000 || !lifecycleApprovals.Consume(record.Job.Handle, snapshot, operation, token, DateTime.UtcNow))
                    throw new Failure("FAMILY_APPROVAL_STALE", "not_started");
            }
            catch { throw new Failure("FAMILY_APPROVAL_STALE", "not_started"); }
            record.ApprovalValidation = new { schema_version = 1, operation, approval_token = token, verified = true };
        }

        private object CreateValve(UIApplication app, Dictionary<string, object> args, out Record record)
        { return CreateFamily(app, args, false, out record); }

        private object CreateCabinet(UIApplication app, Dictionary<string, object> args, out Record record)
        { return CreateFamily(app, args, true, out record); }

        private object CreateFamily(UIApplication app, Dictionary<string, object> args, bool cabinet, out Record record)
        {
            record = null;
            if (records.Count >= 32) throw new Failure("FAMILY_WORKFLOW_CAPACITY");
            string expected = Text(args, "expected_document");
            Document project = cabinet ? null : RequireSample(app, expected);
            string templateId = Text(args, "template_id", GenericTemplate);
            if (templateId != GenericTemplate) throw new Failure(cabinet ? "FAMILY_CABINET_REQUIRES_GENERIC_TEMPLATE" : "FAMILY_VALVE_REQUIRES_GENERIC_TEMPLATE");
            double length = cabinet ? 0 : Number(args, "length_mm", 300), diameter = cabinet ? 0 : Number(args, "diameter_mm", 100);
            double width = cabinet ? Number(args, "width_mm", 1200) : 0, depth = cabinet ? Number(args, "depth_mm", 600) : 0;
            double height = cabinet ? Number(args, "height_mm", 2200) : 0, thickness = cabinet ? Number(args, "thickness_mm", 18) : 0;
            double shelfValue = cabinet ? Number(args, "shelf_count", 3) : 0;
            if (!cabinet && (length < 50 || length > 2000 || diameter < 10 || diameter > 500) ||
                cabinet && (shelfValue < 0 || shelfValue > 8 || Math.Truncate(shelfValue) != shelfValue))
                throw new Failure("FAMILY_DIMENSIONS_OUT_OF_RANGE");
            int shelves = (int)shelfValue;
            if (cabinet && !CabinetPlanner.CreateSupported(new CabinetSpec(width, depth, height, thickness, shelves)).Ok)
                throw new Failure("FAMILY_CABINET_GEOMETRY_INVALID");
            FamilyPlanningResult plan;
            if (cabinet) plan = planner.PrepareIndependent(templateId);
            else
            {
                ProjectDocumentResult captured = projects.Capture(project);
                if (!captured.Ok) throw new Failure("FAMILY_PROJECT_CAPTURE_FAILED");
                plan = planner.Prepare(captured.Snapshot.Handle, templateId);
            }
            if (!plan.Ok || plan.PreparedJob == null) throw new Failure(plan.Code);
            record = new Record { Job = plan.PreparedJob, Template = plan.Template, TemplateId = templateId, Project = project, LengthMm = length, DiameterMm = diameter,
                BuilderKind = cabinet ? FamilyBuilderKind.Cabinet : FamilyBuilderKind.Valve, WidthMm = width, DepthMm = depth, HeightMm = height, ThicknessMm = thickness, ShelfCount = shelves };
            records.Add(record.Job.Handle, record);
            recordOrder.Add(record.Job.Handle);
            RequireJobProject(app, record, expected); RequireTemplate(record);
            creating = record;
            FamilyJobResult created = jobs.Create(record.Job.Handle, record.Job.Binding);
            if (created.Job != null) record.Job = created.Job;
            if (!created.Ok || record.Resource == null || record.Resource.Document == null)
                return Response(cabinet ? "family_create_cabinet" : "family_create_valve", false, created.Code, record.Created ? "unknown" : "not_created_or_unknown", record, null);
            RequireJobProject(app, record, expected); RequireTemplate(record);
            Document family = RequireFamily(record);
            record.DiagnosticStage = "family.template.inspect";
            try { record.TemplateBaseline = Freeze(cabinet ? ParametricCabinetBuilder.Inspect(family) : ParametricValveBuilder.InspectTemplate(family)); }
            catch (Exception error) { Capture(record, error); }
            record.BuildAttempted = true; record.BuildState = "started";
            record.DiagnosticStage = "family.transaction.construct";
            record.FamilyTransaction = new Transaction(family, cabinet ? "BuildX parameterized cabinet" : "BuildX parameterized valve demonstration");
            try
            {
                record.DiagnosticStage = "family.transaction.start";
                if (record.FamilyTransaction.Start() != TransactionStatus.Started) throw new Failure("FAMILY_TRANSACTION_START_FAILED", "unknown");
                record.DiagnosticStage = "family.transaction.configure_failures";
                ConfigureFailures(record.FamilyTransaction, record);
                record.DiagnosticStage = "builder.call";
                Record buildingRecord = record;
                Dictionary<string, object> built = cabinet ? ParametricCabinetBuilder.Build(family, width, depth, height, thickness, shelves, stage => SetBuilderStage(buildingRecord, stage)) :
                    ParametricValveBuilder.Build(family, length, diameter, stage => SetBuilderStage(buildingRecord, stage));
                record.DiagnosticStage = "family.build_result.freeze";
                record.BuildValidation = Freeze(built);
                record.DiagnosticStage = "family.transaction.commit";
                TransactionStatus completion = record.FamilyTransaction.Commit();
                record.FamilyNativeStatus = completion.ToString();
                if (completion != TransactionStatus.Committed) throw new Failure("FAMILY_TRANSACTION_NOT_COMMITTED", "unknown");
                record.BuildComplete = true; record.BuildState = "committed";
            }
            catch (Exception error)
            {
                Capture(record, error);
                bool cleaned = FinishFamilyTransaction(record);
                string outcome = FamilyTerminalOutcome.OnFailure(record.FamilyNativeStatus);
                record.BuildState = outcome + (cleaned ? "" : "_cleanup_pending");
                throw new Failure("FAMILY_BUILD_NOT_COMPLETED", outcome);
            }
            if (!FinishFamilyTransaction(record) || FamilyTerminalOutcome.FromStatus(record.FamilyNativeStatus) != "committed")
                throw new Failure("FAMILY_TRANSACTION_TERMINAL_OR_CLEANUP_UNKNOWN", "unknown");
            record.DiagnosticStage = "family.committed.inspect";
            record.Geometry = Freeze(cabinet ? ParametricCabinetBuilder.Inspect(family) : ParametricValveBuilder.Inspect(family));
            RequireJobProject(app, record, expected); RequireTemplate(record);
            record.LastCode = cabinet ? "FAMILY_CABINET_CREATED" : "FAMILY_VALVE_CREATED";
            return Response(cabinet ? "family_create_cabinet" : "family_create_valve", true, record.LastCode, "created_in_owned_family_document", record, record.Geometry);
        }

        private object Save(UIApplication app, Dictionary<string, object> args, Record record)
        {
            record.DiagnosticStage = "family.save.preflight";
            string operation = record.BuilderKind == FamilyBuilderKind.Cabinet ? "family_save_cabinet" : "family_save_job";
            RequireJobProject(app, record, Text(args, "expected_document")); RequireTemplate(record);
            if (record.SaveAttempted) return Response(operation, false, "FAMILY_SAVE_NOT_REPLAYABLE", record.SaveState, record, null);
            if (!record.BuildComplete || FamilyTerminalOutcome.FromStatus(record.FamilyNativeStatus) != "committed") throw new Failure("FAMILY_GEOMETRY_NOT_CONFIRMED");
            Document family = RequireFamily(record);
            if (!FinishFamilyTransaction(record) || !FinishHashResources(record)) throw new Failure("FAMILY_CLEANUP_PENDING", "unknown");
            EnsureDirectory(artifacts);
            string directory = Path.Combine(artifacts, record.Job.JobId);
            EnsureDirectory(directory);
            string path = Path.GetFullPath(Path.Combine(directory, (record.BuilderKind == FamilyBuilderKind.Cabinet ? "BuildX-Cabinet-" : "BuildX-Valve-") + Guid.NewGuid().ToString("N") + ".rfa"));
            RequireArtifactPath(path);
            if (File.Exists(path) || Directory.Exists(path)) throw new Failure("FAMILY_ARTIFACT_ALREADY_EXISTS");
            record.SaveAttempted = true; record.SavedPath = path; record.SaveState = "save_outcome_unknown";
            record.DiagnosticStage = "family.save.save_as";
            using (var options = new SaveAsOptions { OverwriteExistingFile = false, MaximumBackups = 1 }) family.SaveAs(path, options);
            record.SaveState = "saved_not_reopened";
            record.DiagnosticStage = "family.save.hash";
            record.SavedSha = HashArtifact(record);
            record.DiagnosticStage = "family.save.close_original";
            FamilyJobResult closed = jobs.RequestClose(record.Job.Handle, record.Job.Binding);
            if (closed.Job != null) record.Job = closed.Job;
            if (!closed.Ok) throw new Failure("FAMILY_SAVED_ORIGINAL_CLOSE_PENDING", "unknown");
            // Do not adopt a user-open document as a verification resource.
            var before = app.Application.Documents.Cast<Document>().ToArray();
            if (before.Any(doc => doc.IsValidObject && SamePath(doc.PathName, path))) throw new Failure("FAMILY_ARTIFACT_ALREADY_OPEN", "unknown");
            record.DiagnosticStage = "family.save.reopen";
            Document reopened = app.Application.OpenDocumentFile(path);
            if (reopened == null) throw new Failure("FAMILY_ARTIFACT_REOPEN_UNKNOWN", "unknown");
            record.VerificationDocument = reopened;
            record.VerificationBefore = before;
            if (!ConfirmVerificationOwnership(record)) throw new Failure("FAMILY_REOPEN_OWNERSHIP_UNKNOWN", "unknown");
            try
            {
                if (!reopened.IsValidObject || !reopened.IsFamilyDocument || reopened.IsModifiable)
                    throw new Failure("FAMILY_REOPEN_NOT_VALID_FAMILY", "unknown");
                record.DiagnosticStage = "family.save.reopen_inspect";
                record.ReopenedGeometry = Freeze(record.BuilderKind == FamilyBuilderKind.Cabinet ? ParametricCabinetBuilder.Inspect(reopened) : ParametricValveBuilder.Inspect(reopened));
                record.DiagnosticStage = "family.save.reopen_validate";
                ValidateReopened(record, reopened);
            }
            finally { if (!CloseVerification(record)) record.SaveState = "reopen_cleanup_pending"; }
            if (record.VerificationDocument != null) throw new Failure("FAMILY_REOPEN_CLEANUP_PENDING", "unknown");
            string after = HashArtifact(record);
            if (!String.Equals(after, record.SavedSha, StringComparison.Ordinal)) throw new Failure("FAMILY_ARTIFACT_CHANGED", "unknown");
            RequireJobProject(app, record, Text(args, "expected_document"));
            record.SavedVerified = true; record.SaveState = "saved_reopened_verified_closed";
            return Response(operation, true, "FAMILY_RFA_VERIFIED", "file_persists_independently", record, record.ReopenedGeometry);
        }

        private object Load(UIApplication app, Dictionary<string, object> args, Record record)
        {
            record.DiagnosticStage = "family.load.preflight";
            RequireProject(app, record, Text(args, "expected_document")); RequireTemplate(record);
            if (!record.SavedVerified || String.IsNullOrEmpty(record.SavedPath)) throw new Failure("FAMILY_SAVED_VERIFIED_ARTIFACT_REQUIRED");
            if (record.ProjectGroup != null || record.ProjectTransaction != null || record.VerificationDocument != null)
                throw new Failure("FAMILY_PREVIOUS_RESOURCES_REQUIRE_CLEANUP", "unknown");
            string mode = Text(args, "mode", "rollback");
            if (mode != "rollback" && mode != "commit") throw new Failure("FAMILY_MODE_INVALID");
            if (record.LastLoad != null && Text(record.LastLoad, "outcome") == "unknown") throw new Failure("FAMILY_LOAD_UNKNOWN_NOT_REPLAYABLE", "unknown");
            if (!String.Equals(HashArtifact(record), record.SavedSha, StringComparison.Ordinal)) throw new Failure("FAMILY_ARTIFACT_CHANGED");
            Document target = record.Project;
            string expectedName = Path.GetFileNameWithoutExtension(record.SavedPath);
            if (new FilteredElementCollector(target).OfClass(typeof(Family)).Cast<Family>().Any(family => String.Equals(family.Name, expectedName, StringComparison.OrdinalIgnoreCase)))
                throw new Failure("FAMILY_EXISTING_NAME_CONFLICT");
            int before = FamilyCount(target);
            var loadedIds = new List<long>();
            record.LastLoad = new Dictionary<string, object> { { "mode", mode }, { "outcome", "unknown" }, { "family_count_before", before }, { "project_saved", false }, { "temporary_instances_rolled_back", false } };
            record.ProjectNativeStatus = record.GroupNativeStatus = record.ValidationNativeStatus = null;
            record.ProjectGroup = new TransactionGroup(target, "BuildX independent family validation");
            record.ProjectTransaction = new Transaction(target, "BuildX load demonstration family");
            try
            {
                record.DiagnosticStage = "family.load.transaction_start";
                if (record.ProjectGroup.Start() != TransactionStatus.Started || record.ProjectTransaction.Start() != TransactionStatus.Started)
                    throw new Failure("FAMILY_PROJECT_TRANSACTION_START_FAILED", "unknown");
                ConfigureFailures(record.ProjectTransaction, record);
                Family loaded;
                record.DiagnosticStage = "family.load.load_family";
                bool success = target.LoadFamily(record.SavedPath, new RejectReplacement(), out loaded);
                if (!success || loaded == null || !loaded.IsValidObject) throw new Failure("FAMILY_LOAD_NOT_CONFIRMED");
                loadedIds.Add(loaded.Id.Value);
                record.LastLoad["loaded_family_id"] = loaded.Id.Value;
                record.LastLoad["loaded_family_name"] = loaded.Name;
                record.DiagnosticStage = "family.load.validate_types_and_instances";
                record.LastLoad["type_validation"] = ValidateLoaded(record, target, loaded, loadedIds);
                record.LastLoad["temporary_instances_rolled_back"] = true;
                record.DiagnosticStage = "family.load.transaction_commit";
                TransactionStatus projectCompletion = record.ProjectTransaction.Commit();
                record.ProjectNativeStatus = projectCompletion.ToString();
                if (projectCompletion != TransactionStatus.Committed) throw new Failure("FAMILY_LOAD_TRANSACTION_NOT_COMMITTED", "unknown");
                if (!FinishProjectTransaction(record)) throw new Failure("FAMILY_LOAD_TRANSACTION_CLEANUP_PENDING", "unknown");
                record.DiagnosticStage = "family.load.group_complete";
                TransactionStatus completion = mode == "commit" ? record.ProjectGroup.Assimilate() : record.ProjectGroup.RollBack();
                record.GroupNativeStatus = completion.ToString();
                if (completion != (mode == "commit" ? TransactionStatus.Committed : TransactionStatus.RolledBack))
                    throw new Failure("FAMILY_LOAD_GROUP_OUTCOME_UNKNOWN", "unknown");
                if (!FinishProjectResources(record)) throw new Failure("FAMILY_LOAD_GROUP_CLEANUP_PENDING", "unknown");
                record.LastLoad["outcome"] = FamilyTerminalOutcome.FromStatus(record.GroupNativeStatus);
                if (Text(record.LastLoad, "outcome") != (mode == "commit" ? "committed" : "rolled_back"))
                    throw new Failure("FAMILY_LOAD_GROUP_TERMINAL_NOT_VERIFIED", "unknown");
            }
            catch (Exception error)
            {
                Capture(record, error);
                bool cleaned = FinishProjectResources(record);
                string outcome = FamilyTerminalOutcome.OnFailure(record.GroupNativeStatus);
                record.LastLoad["outcome"] = outcome;
                record.LastLoad["group_native_status"] = record.GroupNativeStatus;
                record.LastLoad["transaction_native_status"] = record.ProjectNativeStatus;
                record.LastLoad["cleanup_complete"] = cleaned;
                throw new Failure("FAMILY_LOAD_NOT_COMPLETED", outcome);
            }
            record.DiagnosticStage = "family.load.independent_readback";
            int after = FamilyCount(target);
            var presence = loadedIds.Select(id => new Dictionary<string, object> { { "id", id }, { "exists", target.GetElement(new ElementId(id)) != null } }).ToArray();
            record.LastLoad["family_count_after"] = after;
            record.LastLoad["independent_id_readback"] = presence;
            bool checkedRollback = mode != "rollback" || (before == after && presence.All(value => !(bool)value["exists"]));
            record.LastLoad["rollback_independently_verified"] = mode == "rollback" ? (object)checkedRollback : null;
            if (!checkedRollback) throw new Failure("FAMILY_ROLLBACK_READBACK_MISMATCH", "unknown");
            RequireProject(app, record, Text(args, "expected_document"));
            return Response("family_load_job", true, "FAMILY_LOADED_AND_READ_BACK", mode == "rollback" ? "rolled_back_verified" : "family_committed_in_memory_not_saved", record, record.LastLoad);
        }

        private object ValidateLoaded(Record record, Document document, Family family, List<long> ids)
        {
            var symbols = family.GetFamilySymbolIds().Select(id => document.GetElement(id) as FamilySymbol).Where(symbol => symbol != null).ToArray();
            foreach (FamilySymbol symbol in symbols) ids.Add(symbol.Id.Value);
            var expected = new[] { ParametricValveBuilder.FirstTypeName, ParametricValveBuilder.SecondTypeName };
            if (!expected.All(name => symbols.Any(symbol => symbol.Name == name))) throw new Failure("FAMILY_LOADED_TYPES_MISSING");
            if (family.FamilyCategory == null || family.FamilyCategory.Id.Value != (long)BuiltInCategory.OST_PipeAccessory)
                throw new Failure("FAMILY_LOADED_CATEGORY_INVALID");
            Parameter part = family.get_Parameter(BuiltInParameter.FAMILY_CONTENT_PART_TYPE);
            if (part == null || part.StorageType != StorageType.Integer || part.AsInteger() != (int)PartType.ValveNormal)
                throw new Failure("FAMILY_LOADED_PART_TYPE_INVALID");
            var readback = new List<object>();
            record.ValidationTransaction = new SubTransaction(document);
            try
            {
                if (record.ValidationTransaction.Start() != TransactionStatus.Started) throw new Failure("FAMILY_INSTANCE_VALIDATION_START_FAILED");
                for (int index = 0; index < expected.Length; index++)
                {
                        FamilySymbol symbol = symbols.Single(value => value.Name == expected[index]);
                        double expectedLength = record.LengthMm * (index == 0 ? 1 : 1.25);
                        double expectedDiameter = record.DiameterMm * (index == 0 ? 1 : 1.5);
                        Near(ParameterMm(symbol, "Length"), expectedLength, "FAMILY_LOADED_LENGTH_MISMATCH");
                        Near(ParameterMm(symbol, "Diameter"), expectedDiameter, "FAMILY_LOADED_DIAMETER_MISMATCH");
                        if (!symbol.IsActive) symbol.Activate();
                        document.Regenerate();
                        FamilyInstance instance = document.Create.NewFamilyInstance(new XYZ(index * 20, 0, 0), symbol, StructuralType.NonStructural);
                        document.Regenerate();
                        var connectors = new List<object>();
                        var nativeConnectors = new List<Connector>();
                        if (instance.MEPModel == null || instance.MEPModel.ConnectorManager == null) throw new Failure("FAMILY_LOADED_CONNECTORS_MISSING");
                        foreach (Connector connector in instance.MEPModel.ConnectorManager.Connectors)
                        {
                            if (connector.Domain != Domain.DomainPiping || connector.Shape != ConnectorProfileType.Round)
                                throw new Failure("FAMILY_LOADED_CONNECTOR_TYPE_INVALID");
                            Near(connector.Radius * 2 * 304.8, expectedDiameter, "FAMILY_LOADED_CONNECTOR_SIZE_MISMATCH");
                            nativeConnectors.Add(connector);
                            connectors.Add(new { radius_mm = connector.Radius * 304.8, origin_mm = Point(connector.Origin), direction = Point(connector.CoordinateSystem.BasisZ, 1) });
                        }
                        if (connectors.Count != 2) throw new Failure("FAMILY_LOADED_CONNECTOR_COUNT_INVALID");
                        Near(nativeConnectors[0].Origin.DistanceTo(nativeConnectors[1].Origin) * 304.8, expectedLength, "FAMILY_LOADED_CONNECTOR_DISTANCE_MISMATCH");
                        if (nativeConnectors[0].CoordinateSystem.BasisZ.Normalize().DotProduct(nativeConnectors[1].CoordinateSystem.BasisZ.Normalize()) > -0.9999)
                            throw new Failure("FAMILY_LOADED_CONNECTOR_DIRECTION_MISMATCH");
                        readback.Add(new { type_name = symbol.Name, type_id = symbol.Id.Value, length_mm = ParameterMm(symbol, "Length"), diameter_mm = ParameterMm(symbol, "Diameter"), connector_count = connectors.Count, connectors });
                        ids.Add(instance.Id.Value);
                }
            }
            finally
            {
                if (!FinishValidationTransaction(record) || FamilyTerminalOutcome.FromStatus(record.ValidationNativeStatus) != "rolled_back")
                    throw new Failure("FAMILY_INSTANCE_ROLLBACK_UNKNOWN", "unknown");
            }
            return Freeze(readback);
        }

        private static void ValidateReopened(Record record, Document document)
        {
            if (record.BuilderKind == FamilyBuilderKind.Cabinet)
            {
                try { ParametricCabinetBuilder.VerifyReopened(document, new CabinetSpec(record.WidthMm, record.DepthMm, record.HeightMm, record.ThicknessMm, record.ShelfCount)); }
                catch { throw new Failure("FAMILY_CABINET_REOPEN_VALIDATION_FAILED", "unknown"); }
                return;
            }
            FamilyManager manager = document.FamilyManager;
            FamilyParameter length = manager.get_Parameter("Length"), diameter = manager.get_Parameter("Diameter");
            if (length == null || diameter == null || document.OwnerFamily.FamilyCategory.Id.Value != (long)BuiltInCategory.OST_PipeAccessory)
                throw new Failure("FAMILY_REOPEN_PARAMETERS_OR_CATEGORY_MISSING", "unknown");
            Parameter part = document.OwnerFamily.get_Parameter(BuiltInParameter.FAMILY_CONTENT_PART_TYPE);
            if (part == null || part.AsInteger() != (int)PartType.ValveNormal) throw new Failure("FAMILY_REOPEN_PART_TYPE_INVALID", "unknown");
            var types = manager.Types.Cast<FamilyType>().ToArray();
            string[] names = { ParametricValveBuilder.FirstTypeName, ParametricValveBuilder.SecondTypeName };
            for (int index = 0; index < names.Length; index++)
            {
                FamilyType type = types.SingleOrDefault(value => value.Name == names[index]);
                if (type == null) throw new Failure("FAMILY_REOPEN_TYPES_MISSING", "unknown");
                Near(type.AsDouble(length).Value * 304.8, record.LengthMm * (index == 0 ? 1 : 1.25), "FAMILY_REOPEN_LENGTH_MISMATCH");
                Near(type.AsDouble(diameter).Value * 304.8, record.DiameterMm * (index == 0 ? 1 : 1.5), "FAMILY_REOPEN_DIAMETER_MISMATCH");
            }
            var connectors = new FilteredElementCollector(document).OfClass(typeof(ConnectorElement)).Cast<ConnectorElement>().ToArray();
            if (connectors.Length != 2 || manager.CurrentType == null || manager.CurrentType.Name != names[0]) throw new Failure("FAMILY_REOPEN_CURRENT_GEOMETRY_UNKNOWN", "unknown");
            foreach (ConnectorElement connector in connectors)
            {
                if (connector.Domain != Domain.DomainPiping || connector.Shape != ConnectorProfileType.Round) throw new Failure("FAMILY_REOPEN_CONNECTOR_TYPE_INVALID", "unknown");
                Parameter size = connector.get_Parameter(BuiltInParameter.CONNECTOR_RADIUS);
                FamilyParameter associated = size == null ? null : manager.GetAssociatedFamilyParameter(size);
                if (associated == null) { size = connector.get_Parameter(BuiltInParameter.CONNECTOR_DIAMETER); associated = size == null ? null : manager.GetAssociatedFamilyParameter(size); }
                if (associated == null || (associated.Definition.Name != "Diameter" && associated.Definition.Name != "ConnectorRadius")) throw new Failure("FAMILY_REOPEN_CONNECTOR_ASSOCIATION_MISSING", "unknown");
                Near(connector.Radius * 2 * 304.8, record.DiameterMm, "FAMILY_REOPEN_CONNECTOR_SIZE_MISMATCH");
            }
            Near(connectors[0].Origin.DistanceTo(connectors[1].Origin) * 304.8, record.LengthMm, "FAMILY_REOPEN_CONNECTOR_DISTANCE_MISMATCH");
            if (connectors[0].CoordinateSystem.BasisZ.Normalize().DotProduct(connectors[1].CoordinateSystem.BasisZ.Normalize()) > -0.9999)
                throw new Failure("FAMILY_REOPEN_CONNECTOR_DIRECTION_MISMATCH", "unknown");
        }

        private static void Near(double actual, double expected, string code)
        { if (Double.IsNaN(actual) || Double.IsInfinity(actual) || Math.Abs(actual - expected) > 0.05) throw new Failure(code, "unknown"); }

        private Document RequireSample(UIApplication app, string expected)
        {
            Document document = app.ActiveUIDocument == null ? null : app.ActiveUIDocument.Document;
            if (document == null || !document.IsValidObject || document.IsFamilyDocument || document.IsReadOnly || document.IsLinked || document.IsModifiable)
                throw new Failure("FAMILY_WRITABLE_PROJECT_SAMPLE_REQUIRED");
            if (!SamePath(expected, sample) || !SamePath(document.PathName, sample)) throw new Failure("FAMILY_EXACT_SAMPLE_REQUIRED");
            string config = Path.Combine(root, "workbench-config.json");
            if (!File.Exists(config) || new FileInfo(config).Length > 64 * 1024) throw new Failure("FAMILY_SAMPLE_CONFIG_UNAVAILABLE");
            var settings = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(config));
            object value; bool allowed = false;
            if (settings.TryGetValue("allowedDocuments", out value) && value is System.Collections.IEnumerable && !(value is string))
                foreach (object path in (System.Collections.IEnumerable)value) if (path is string && SamePath((string)path, sample)) allowed = true;
            if (!allowed) throw new Failure("FAMILY_SAMPLE_NOT_ALLOWLISTED");
            return document;
        }
        private void RequireProject(UIApplication app, Record record, string expected)
        {
            Document active = RequireSample(app, expected);
            ProjectDocumentResult captured = projects.Capture(active);
            if (!captured.Ok || captured.Snapshot.Handle != record.Job.Binding.ProjectDocumentHandle)
                throw new Failure("FAMILY_PROJECT_OPEN_INSTANCE_CHANGED");
            ProjectDocumentResult check = projects.Check(record.Job.Binding.ProjectDocumentHandle, session, pid);
            if (!check.Ok || check.Snapshot.CurrentFacts == null || check.Snapshot.CurrentFacts.IsReadOnly != false ||
                check.Snapshot.PersistentFingerprint != record.Job.Binding.ProjectFingerprint || !record.Project.IsValidObject || !record.Project.Equals(active))
                throw new Failure("FAMILY_PROJECT_BINDING_NOT_CURRENT");
        }
        private void RequireJobProject(UIApplication app, Record record, string expected)
        {
            if (record.Job.Binding.IsIndependent)
            {
                if (record.BuilderKind != FamilyBuilderKind.Cabinet) throw new Failure("FAMILY_JOB_SCOPE_MISMATCH");
                return;
            }
            RequireProject(app, record, expected);
        }
        private void RequireTemplate(Record record)
        {
            FamilyTemplateObservation observation = templates.Inspect(record.TemplateId);
            if (observation == null || observation.State != FamilyTemplateState.BytesVerified || observation.Issue != FamilyTemplateIssue.None ||
                observation.Sha256 != record.Job.Binding.TemplateSha256 || observation.SourcePath != record.Template.SourcePath)
                throw new Failure("FAMILY_TEMPLATE_BINDING_CHANGED_OR_UNKNOWN");
        }
        private Document RequireFamily(Record record)
        {
            if (record.Resource == null || record.Resource.Document == null || !record.Resource.Document.IsValidObject ||
                !record.Resource.Document.IsFamilyDocument || record.Resource.Document.IsReadOnly || record.Resource.Document.IsModifiable ||
                record.Job.OwnershipConflict || !record.Job.ResourceRetained)
                throw new Failure("FAMILY_OWNED_DOCUMENT_NOT_READY");
            return record.Resource.Document;
        }
        private bool FinishFamilyTransaction(Record record)
        { return FinishTransaction(ref record.FamilyTransaction, ref record.FamilyNativeStatus, record, "cleanup.family_transaction"); }
        private bool FinishProjectTransaction(Record record)
        { return FinishTransaction(ref record.ProjectTransaction, ref record.ProjectNativeStatus, record, "cleanup.project_transaction"); }
        private static bool FinishTransaction(ref Transaction transaction, ref string observedStatus, Record record, string stage)
        {
            if (transaction == null) return true;
            bool finalRead = false;
            try
            {
                TransactionStatus status = transaction.GetStatus();
                observedStatus = status.ToString();
                if (status == TransactionStatus.Started) transaction.RollBack();
                status = transaction.GetStatus(); observedStatus = status.ToString(); finalRead = true;
                if (status != TransactionStatus.Committed && status != TransactionStatus.RolledBack && status != TransactionStatus.Uninitialized) return false;
                transaction.Dispose(); transaction = null; return true;
            }
            catch (Exception error) { CaptureAt(record, stage, error); if (!finalRead) observedStatus = "Unknown"; return false; }
        }
        private bool FinishProjectResources(Record record)
        {
            if (!FinishValidationTransaction(record)) return false;
            if (!FinishProjectTransaction(record)) return false;
            if (record.ProjectGroup == null) return true;
            bool finalRead = false;
            try
            {
                TransactionStatus status = record.ProjectGroup.GetStatus();
                record.GroupNativeStatus = status.ToString();
                if (status == TransactionStatus.Started) record.ProjectGroup.RollBack();
                status = record.ProjectGroup.GetStatus(); record.GroupNativeStatus = status.ToString(); finalRead = true;
                if (status != TransactionStatus.Committed && status != TransactionStatus.RolledBack && status != TransactionStatus.Uninitialized) return false;
                record.ProjectGroup.Dispose(); record.ProjectGroup = null; return true;
            }
            catch (Exception error) { CaptureAt(record, "cleanup.project_group", error); if (!finalRead) record.GroupNativeStatus = "Unknown"; return false; }
        }
        private static bool FinishValidationTransaction(Record record)
        {
            if (record.ValidationTransaction == null) return true;
            bool finalRead = false;
            try
            {
                TransactionStatus status = record.ValidationTransaction.GetStatus();
                record.ValidationNativeStatus = status.ToString();
                if (status == TransactionStatus.Started) record.ValidationTransaction.RollBack();
                status = record.ValidationTransaction.GetStatus(); record.ValidationNativeStatus = status.ToString(); finalRead = true;
                if (status != TransactionStatus.Committed && status != TransactionStatus.RolledBack && status != TransactionStatus.Uninitialized) return false;
                record.ValidationTransaction.Dispose(); record.ValidationTransaction = null; return true;
            }
            catch (Exception error) { CaptureAt(record, "cleanup.validation_subtransaction", error); if (!finalRead) record.ValidationNativeStatus = "Unknown"; return false; }
        }
        private static void ConfigureFailures(Transaction transaction, Record record)
        {
            FailureHandlingOptions options = transaction.GetFailureHandlingOptions();
            options.SetFailuresPreprocessor(new RollBackErrors(record)); options.SetClearAfterRollback(true);
            transaction.SetFailureHandlingOptions(options);
        }
        private bool CloseVerification(Record record)
        {
            if (record.VerificationDocument == null) return true;
            try
            {
                if (!record.VerificationOwnershipConfirmed && !ConfirmVerificationOwnership(record)) return false;
                if (!record.VerificationDocument.IsValidObject) { record.VerificationDocument = null; return true; }
                if (!record.VerificationDocument.IsFamilyDocument || record.VerificationDocument.IsModifiable || IsActive(record.VerificationDocument)) return false;
                if (!record.VerificationDocument.Close(false)) return false;
                record.VerificationDocument = null; record.VerificationBefore = null; return true;
            }
            catch { return false; }
        }
        private static bool ConfirmVerificationOwnership(Record record)
        {
            if (record.VerificationOwnershipConfirmed) return true;
            if (record.VerificationDocument == null || record.VerificationBefore == null) return false;
            try
            {
                foreach (Document existing in record.VerificationBefore)
                    if (existing.IsValidObject && existing.Equals(record.VerificationDocument))
                    {
                        // A returned pre-existing user document is not retained
                        // as an owned close capability.
                        record.SaveState = "reopen_returned_existing_document";
                        record.VerificationDocument = null; record.VerificationBefore = null;
                        return false;
                    }
                record.VerificationOwnershipConfirmed = true; record.VerificationBefore = null; return true;
            }
            catch { return false; }
        }
        private string HashArtifact(Record record)
        {
            RequireArtifactPath(record.SavedPath);
            if (!FinishHashResources(record)) throw new Failure("FAMILY_ARTIFACT_HASH_CLEANUP_PENDING", "unknown");
            var before = new FileInfo(record.SavedPath);
            long length = before.Length; DateTime modified = before.LastWriteTimeUtc;
            if (length <= 0 || length > ArtifactLimit) throw new Failure("FAMILY_ARTIFACT_SIZE_INVALID");
            string digest = null;
            try
            {
                record.HashStream = new FileStream(record.SavedPath, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.SequentialScan);
                record.HashAlgorithm = SHA256.Create();
                byte[] bytes = new byte[64 * 1024]; long remaining = length;
                while (remaining > 0)
                {
                    int read = record.HashStream.Read(bytes, 0, (int)Math.Min(remaining, bytes.Length));
                    if (read <= 0) throw new Failure("FAMILY_ARTIFACT_CHANGED", "unknown");
                    record.HashAlgorithm.TransformBlock(bytes, 0, read, bytes, 0); remaining -= read;
                }
                if (record.HashStream.ReadByte() != -1) throw new Failure("FAMILY_ARTIFACT_CHANGED", "unknown");
                record.HashAlgorithm.TransformFinalBlock(new byte[0], 0, 0);
                var after = new FileInfo(record.SavedPath);
                if (after.Length != length || after.LastWriteTimeUtc != modified) throw new Failure("FAMILY_ARTIFACT_CHANGED", "unknown");
                digest = BitConverter.ToString(record.HashAlgorithm.Hash).Replace("-", "").ToLowerInvariant();
                record.SavedBytes = length;
            }
            finally { if (!FinishHashResources(record)) digest = null; }
            if (digest == null) throw new Failure("FAMILY_ARTIFACT_HASH_CLEANUP_PENDING", "unknown");
            return digest;
        }
        private static bool FinishHashResources(Record record)
        {
            bool clean = true;
            if (record.HashAlgorithm != null) try { record.HashAlgorithm.Dispose(); record.HashAlgorithm = null; } catch { clean = false; }
            if (record.HashStream != null) try { record.HashStream.Dispose(); record.HashStream = null; } catch { clean = false; }
            return clean;
        }
        private void EnsureDirectory(string directory)
        {
            string full = Path.GetFullPath(directory);
            if (!SamePath(full, artifacts) && !full.StartsWith(artifacts + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Failure("FAMILY_ARTIFACT_PATH_OUTSIDE_ROOT");
            if (!Directory.Exists(full)) { EnsureParentsNoReparse(Path.GetDirectoryName(full)); Directory.CreateDirectory(full); }
            EnsureParentsNoReparse(full);
        }
        private void RequireArtifactPath(string path)
        {
            if (String.IsNullOrWhiteSpace(path)) throw new Failure("FAMILY_ARTIFACT_PATH_REQUIRED");
            string full = Path.GetFullPath(path);
            if (!full.StartsWith(artifacts + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !String.Equals(Path.GetExtension(full), ".rfa", StringComparison.OrdinalIgnoreCase))
                throw new Failure("FAMILY_ARTIFACT_PATH_OUTSIDE_ROOT");
            EnsureParentsNoReparse(Path.GetDirectoryName(full));
            if (File.Exists(full) && (File.GetAttributes(full) & (FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Device)) != 0)
                throw new Failure("FAMILY_ARTIFACT_NOT_REGULAR");
        }
        private static void EnsureParentsNoReparse(string directory)
        {
            while (!String.IsNullOrEmpty(directory))
            {
                FileAttributes attributes = File.GetAttributes(directory);
                if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) throw new Failure("FAMILY_ARTIFACT_PARENT_NOT_REGULAR");
                string parent = Path.GetDirectoryName(directory);
                if (String.Equals(parent, directory, StringComparison.OrdinalIgnoreCase)) break;
                directory = parent;
            }
        }
        private bool IsActive(Document document)
        { return currentApp == null || (currentApp.ActiveUIDocument != null && currentApp.ActiveUIDocument.Document.Equals(document)); }
        private void RequireThread()
        { if (Thread.CurrentThread.ManagedThreadId != apiThread) throw new Failure("FAMILY_API_THREAD_REQUIRED"); }
        private static bool SamePath(string first, string second)
        {
            if (String.IsNullOrWhiteSpace(first) || String.IsNullOrWhiteSpace(second) || !Path.IsPathRooted(first) || !Path.IsPathRooted(second)) return false;
            return String.Equals(Path.GetFullPath(first), Path.GetFullPath(second), StringComparison.OrdinalIgnoreCase);
        }
        private static string Text(Dictionary<string, object> args, string key, string fallback = "")
        { object value; return args.TryGetValue(key, out value) && value is string ? (string)value : fallback; }
        private static double Number(Dictionary<string, object> args, string key, double fallback)
        {
            object value; if (!args.TryGetValue(key, out value)) return fallback;
            if (!(value is double || value is float || value is int || value is long || value is decimal)) throw new Failure("FAMILY_NUMBER_REQUIRED");
            double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            if (Double.IsNaN(number) || Double.IsInfinity(number)) throw new Failure("FAMILY_NUMBER_INVALID");
            return number;
        }
        private object Freeze(object value)
        {
            string serialized = json.Serialize(value);
            if (serialized.Length > 200000) throw new Failure("FAMILY_RESULT_TOO_LARGE");
            return json.DeserializeObject(serialized);
        }
        private static int FamilyCount(Document document)
        { return new FilteredElementCollector(document).OfClass(typeof(Family)).GetElementCount(); }
        private static double ParameterMm(FamilySymbol symbol, string name)
        {
            Parameter parameter = symbol.LookupParameter(name);
            if (parameter == null || parameter.StorageType != StorageType.Double) throw new Failure("FAMILY_LOADED_PARAMETER_MISSING");
            return parameter.AsDouble() * 304.8;
        }
        private static double[] Point(XYZ value, double scale = 304.8)
        { return new[] { value.X * scale, value.Y * scale, value.Z * scale }; }
        private static object TemplateDto(FamilyTemplateObservation value)
        { return value == null ? null : new { template_id = value.TemplateId, path = value.SourcePath, state = value.State.ToString(), issue = value.Issue.ToString(), bytes = value.ByteLength, sha256 = value.Sha256, native_format_validated = false }; }
        private object Response(string operation, bool success, string code, string outcome, Record record, object value, object approval = null)
        {
            bool coreCurrent = false;
            if (record != null)
            {
                FamilyJobResult current = jobs.Get(record.Job.Handle, record.Job.Binding);
                if (current.Ok && current.Job != null) { record.Job = current.Job; coreCurrent = true; }
            }
            return new {
                operation, host_session = session, revit_pid = pid, success, code, outcome,
                approval, approval_validation = record == null || operation == "family_inspect_job" ? null : record.ApprovalValidation,
                job_handle = record == null ? null : record.Job.Handle,
                job_id = record == null ? null : record.Job.JobId,
                stage = record == null ? null : record.Job.Stage.ToString(),
                project_handle = record == null ? null : record.Job.Binding.ProjectDocumentHandle,
                project_fingerprint = record == null ? null : record.Job.Binding.ProjectFingerprint,
                job_scope = record == null ? null : record.Job.Binding.IsIndependent ? "independent_family" : "bound_project",
                job = record == null ? null : Freeze(record.Job), core_registry_current = coreCurrent,
                template = record == null ? null : TemplateDto(record.Template),
                build_state = record == null ? null : record.BuildState,
                native_status = record == null ? null : new { family_transaction = record.FamilyNativeStatus, project_transaction = record.ProjectNativeStatus, project_group = record.GroupNativeStatus, validation_subtransaction = record.ValidationNativeStatus },
                build_validation = record == null ? null : record.BuildValidation,
                diagnostics = record == null ? null : new { last_stage = record.DiagnosticStage, errors = record.Diagnostics.ToArray(), omitted = record.DiagnosticsOmitted, template_baseline = record.TemplateBaseline, source_is_diagnostic_data = true },
                save = record == null ? null : new { attempted = record.SaveAttempted, state = record.SaveState, path = record.SavedPath, sha256 = record.SavedSha, bytes = record.SavedBytes, independently_reopened_verified = record.SavedVerified },
                cleanup_pending = record != null && (record.FamilyTransaction != null || record.ProjectTransaction != null || record.ValidationTransaction != null || record.ProjectGroup != null || record.VerificationDocument != null || record.HashStream != null || record.HashAlgorithm != null),
                effects = record == null ? null : new { family_creation_attempted = record.CreationAttempted, owned_family_created = record.Created, family_geometry_committed = FamilyTerminalOutcome.FromStatus(record.FamilyNativeStatus) == "unknown" ? (bool?)null : FamilyTerminalOutcome.FromStatus(record.FamilyNativeStatus) == "committed", saved_file_may_persist = record.SaveAttempted, project_saved = false, project_load = record.LastLoad },
                value,
                notice = "Family documents, saved files and project transactions have independent outcomes. A saved RFA persists after project rollback. Do not replay an unknown result. Core Ready is resource validity, not geometry or modeling acceptance."
            };
        }
        private static void SetBuilderStage(Record record, string stage)
        {
            string[] known = { "preflight", "find_view", "category", "parameters", "extrusion", "diameter_dimension", "connectors", "planes", "panels", "validate_A", "validate_B", "restore_A", "inspect_result", "complete" };
            record.DiagnosticStage = known.Contains(stage) ? "builder." + stage : "builder.unknown_stage";
        }
        private static void Capture(Record record, Exception error)
        {
            CaptureAt(record, record == null ? null : record.DiagnosticStage, error);
        }
        private static void CaptureAt(Record record, string stage, Exception error)
        {
            if (record == null || error is Failure) return;
            try { AddDiagnostic(record, FamilyWorkflowDiagnostics.Capture(stage, error)); }
            catch { /* Diagnostics cannot change outcome/ownership/cleanup. */ }
        }
        private static void AddDiagnostic(Record record, Dictionary<string, object> diagnostic)
        {
            if (record == null) return;
            if (record.Diagnostics.Count < 3) record.Diagnostics.Add(diagnostic);
            else if (record.DiagnosticsOmitted < 1000000) record.DiagnosticsOmitted++;
        }
    }
}
