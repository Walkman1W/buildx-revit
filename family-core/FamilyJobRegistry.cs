using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Security.Cryptography;
using System.Text;

namespace BuildX.FamilyCore
{
    public enum FamilyJobStage
    {
        Prepared, Creating, Ready, Rejected, OutcomeUnknown, Closing, CleanupPending, Closed
    }

    public enum FamilyReadiness { Unknown, Ready, NotReady }
    public enum FamilyCloseOutcome { Unknown = 0, ConfirmedClosed = 1, NotClosed = 2 }
    internal enum CreationKind { CreatedTemporary, ExistingUserDocument, NotCreated, Unknown }
    internal enum ReferenceRegistration { TemporaryProof, UserObservation, KnownConflict }

    /// <summary>
    /// Trusted adapter-supplied identities. DocumentHandle distinguishes one open
    /// project Document from a later reopening of the same project fingerprint.
    /// No title/path normalization or template-file read is performed here.
    /// </summary>
    public sealed class FamilyJobBinding
    {
        public string HostSession { get; private set; }
        public int HostPid { get; private set; }
        public string ProjectDocumentHandle { get; private set; }
        public string ProjectFingerprint { get; private set; }
        public string TemplateSha256 { get; private set; }
        // A standalone job belongs to the host and the selected template,
        // not to any currently open project. It cannot grant project access.
        public bool IsIndependent { get; private set; }

        public FamilyJobBinding(string hostSession, int hostPid, string projectDocumentHandle,
            string projectFingerprint, string templateSha256)
        {
            if (!ValidText(hostSession, 128) || hostPid <= 0 || !ValidText(projectDocumentHandle, 256) ||
                !ValidText(projectFingerprint, 1024) || !IsSha256(templateSha256))
                throw new ArgumentException("Explicit host, open-project identity and template SHA256 are required.");
            HostSession = hostSession;
            HostPid = hostPid;
            ProjectDocumentHandle = projectDocumentHandle;
            ProjectFingerprint = projectFingerprint;
            TemplateSha256 = templateSha256.ToLowerInvariant();
        }

        public static FamilyJobBinding Independent(string hostSession, int hostPid, string templateSha256)
        {
            if (!ValidText(hostSession, 128) || hostPid <= 0 || !IsSha256(templateSha256))
                throw new ArgumentException("Explicit host identity and template SHA256 are required.");
            return new FamilyJobBinding { HostSession = hostSession, HostPid = hostPid,
                TemplateSha256 = templateSha256.ToLowerInvariant(), IsIndependent = true };
        }
        private FamilyJobBinding() { }

        internal static bool ValidText(string value, int maximum)
        {
            return !String.IsNullOrWhiteSpace(value) && value.Length <= maximum && value.IndexOf('\0') < 0;
        }

        private static bool IsSha256(string value)
        {
            if (value == null || value.Length != 64) return false;
            foreach (char c in value)
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
            return true;
        }

        internal bool SameAs(FamilyJobBinding other)
        {
            return other != null && HostPid == other.HostPid && IsIndependent == other.IsIndependent &&
                String.Equals(HostSession, other.HostSession, StringComparison.Ordinal) &&
                String.Equals(ProjectDocumentHandle, other.ProjectDocumentHandle, StringComparison.Ordinal) &&
                String.Equals(ProjectFingerprint, other.ProjectFingerprint, StringComparison.Ordinal) &&
                String.Equals(TemplateSha256, other.TemplateSha256, StringComparison.Ordinal);
        }
    }

    public sealed class FamilyResourceFacts
    {
        public bool? IsValid { get; private set; }
        public bool? IsFamilyDocument { get; private set; }
        public string JobId { get; private set; }
        public FamilyJobBinding Binding { get; private set; }

        public FamilyResourceFacts(bool? isValid, bool? isFamilyDocument, string jobId, FamilyJobBinding binding)
        {
            IsValid = isValid; IsFamilyDocument = isFamilyDocument; JobId = jobId; Binding = binding;
        }
    }

    public interface IFamilyJobResource
    {
        FamilyResourceFacts Inspect();
        // Only this explicit tag confirms cleanup. False/unknown/exception do not.
        FamilyCloseOutcome Close();
    }

    public interface IFamilyResourceFactory
    {
        // A trusted host adapter, captured by the registry constructor. It must
        // create at most one new temporary resource in one call, and publish it
        // through this call's context before performing work that can fail.
        FamilyCreationOutcome Create(FamilyCreationContext context);
    }

    public sealed class FamilyCreationOutcome
    {
        internal FamilyCreationContext Issuer { get; private set; }
        internal CreationKind Kind { get; private set; }
        internal FamilyCreationOutcome(FamilyCreationContext issuer, CreationKind kind)
        { Issuer = issuer; Kind = kind; }
    }

    /// <summary>
    /// One factory invocation's ownership issuer. External callers cannot create
    /// contexts or receipts. Ownership is registered synchronously when issued,
    /// independently of the eventual returned receipt and resource inspection.
    /// It is a trusted host contract, not proof that arbitrary host code is safe.
    /// </summary>
    public sealed class FamilyCreationContext
    {
        private readonly object gate;
        private readonly Action<IFamilyJobResource> publish;
        private readonly Action<IFamilyJobResource> ownershipConflict;
        private readonly Action<IFamilyJobResource> observeUser;
        private bool sealedContext;
        private bool temporaryIssued;
        private bool ownershipDisputed;
        private IFamilyJobResource issuedResource;
        private IFamilyJobResource observedUserResource;
        public string JobId { get; private set; }
        public FamilyJobBinding Binding { get; private set; }

        internal FamilyCreationContext(string jobId, FamilyJobBinding binding, object gate,
            Action<IFamilyJobResource> publish, Action<IFamilyJobResource> ownershipConflict,
            Action<IFamilyJobResource> observeUser)
        {
            JobId = jobId; Binding = binding; this.gate = gate;
            this.publish = publish; this.ownershipConflict = ownershipConflict; this.observeUser = observeUser;
        }

        public FamilyCreationOutcome CreatedTemporary(IFamilyJobResource resource)
        {
            lock (gate)
            {
                if (sealedContext) throw new InvalidOperationException("The factory invocation has ended.");
                if (resource == null) throw new ArgumentNullException("resource");
                if (ownershipDisputed) throw new InvalidOperationException("An ownership conflict cannot be replaced by a later temporary receipt.");
                if (Object.ReferenceEquals(resource, observedUserResource))
                {
                    // Once identified as a user document, this exact object
                    // cannot acquire a close capability via a later receipt.
                    ownershipDisputed = true;
                    ownershipConflict(resource);
                    throw new InvalidOperationException("A known user resource cannot become an owned temporary resource.");
                }
                if (temporaryIssued) throw new InvalidOperationException("Only one new temporary resource may be issued per factory invocation.");
                // Register before returning the receipt: a later factory throw,
                // null result or Unknown cannot make this resource disappear.
                publish(resource);
                temporaryIssued = true;
                issuedResource = resource;
                return new FamilyCreationOutcome(this, CreationKind.CreatedTemporary);
            }
        }

        public FamilyCreationOutcome ExistingUserDocument(IFamilyJobResource resource)
        {
            lock (gate)
            {
                if (sealedContext) throw new InvalidOperationException("The factory invocation has ended.");
                if (resource == null) throw new ArgumentNullException("resource");
                // The registry alone interprets whether an observed user object
                // is already retained by this or another job's temporary ledger.
                observeUser(resource);
                if (Object.ReferenceEquals(resource, issuedResource))
                    ownershipDisputed = true;
                if (observedUserResource != null && !Object.ReferenceEquals(observedUserResource, resource))
                    throw new InvalidOperationException("Only one observed user resource is accepted by this factory invocation.");
                observedUserResource = resource;
                // Observing a user resource never issues ownership or retains a
                // resource handle for Close. The adapter still owns that input.
                return new FamilyCreationOutcome(this, CreationKind.ExistingUserDocument);
            }
        }

        public FamilyCreationOutcome NotCreated() { return Report(CreationKind.NotCreated); }
        public FamilyCreationOutcome Unknown() { return Report(CreationKind.Unknown); }
        private FamilyCreationOutcome Report(CreationKind kind)
        {
            lock (gate)
            {
                if (sealedContext) throw new InvalidOperationException("The factory invocation has ended.");
                return new FamilyCreationOutcome(this, kind);
            }
        }
        internal void Seal() { lock (gate) { sealedContext = true; } }
    }

    public sealed class FamilyJobSnapshot
    {
        public string JobId { get; private set; }
        // Issued by Prepare for job access. This is not a Revit Document handle
        // and this offline prototype has no actual Document-instance mapping.
        public string Handle { get; private set; }
        public FamilyJobBinding Binding { get; private set; }
        public FamilyJobStage Stage { get; private set; }
        public bool Owned { get; private set; }
        public bool ResourceRetained { get; private set; }
        public bool OwnershipConflict { get; private set; }
        public string ResourceOwnerJobId { get; private set; }
        public FamilyReadiness Readiness { get; private set; }
        public bool CloseRequested { get; private set; }
        public string LastCode { get; private set; }
        public string CreationCode { get; private set; }
        public string InspectionCode { get; private set; }
        internal FamilyJobSnapshot(string jobId, string handle, FamilyJobBinding binding, FamilyJobStage stage,
            bool owned, bool resourceRetained, bool ownershipConflict, FamilyReadiness readiness, bool closeRequested, string lastCode,
            string creationCode, string inspectionCode, string resourceOwnerJobId)
        {
            JobId = jobId; Handle = handle; Binding = binding; Stage = stage; Owned = owned;
            ResourceRetained = resourceRetained; OwnershipConflict = ownershipConflict;
            ResourceOwnerJobId = resourceOwnerJobId;
            Readiness = readiness; CloseRequested = closeRequested; LastCode = lastCode;
            CreationCode = creationCode; InspectionCode = inspectionCode;
        }
    }

    public sealed class FamilyJobResult
    {
        public bool Ok { get; private set; }
        public string Code { get; private set; }
        public FamilyJobSnapshot Job { get; private set; }
        internal FamilyJobResult(bool ok, string code, FamilyJobSnapshot job) { Ok = ok; Code = code; Job = job; }
    }

    public sealed class FamilyCleanupResult
    {
        public bool Ok { get; private set; }
        public string Code { get; private set; }
        public ReadOnlyCollection<FamilyJobResult> Items { get; private set; }
        internal FamilyCleanupResult(bool ok, string code, IList<FamilyJobResult> items)
        { Ok = ok; Code = code; Items = new ReadOnlyCollection<FamilyJobResult>(new List<FamilyJobResult>(items)); }
    }

    /// <summary>
    /// Offline ownership/lifecycle prototype only. No Revit reference, geometry,
    /// transaction, template IO, Save/Load, script permissions or process control.
    /// External synchronous factories may publish a late result; close intent
    /// is recorded while they run. A hung factory is not forcibly interrupted.
    /// </summary>
    public sealed class FamilyJobRegistry
    {
        private sealed class JobRecord
        {
            internal string JobId;
            internal string Handle;
            internal FamilyJobBinding Binding;
            internal FamilyJobStage Stage;
            internal IFamilyJobResource Resource;
            internal bool TemporaryProofIssued;
            internal bool OwnershipConflict;
            internal string ResourceOwnerJobId;
            internal FamilyReadiness Readiness;
            internal bool CloseRequested;
            internal bool CreateAttempted;
            internal string LastCode;
            internal string CreationCode;
            internal string InspectionCode;
            internal long Ordinal;
        }
        private readonly object gate = new object();
        private readonly string hostSession;
        private readonly int hostPid;
        private readonly IFamilyResourceFactory factory;
        private readonly int capacity;
        private readonly Dictionary<string, JobRecord> jobs = new Dictionary<string, JobRecord>(StringComparer.Ordinal);
        private bool busy;
        private JobRecord activeJob;
        private string activeOperation;
        private long ordinal;

        public FamilyJobRegistry(string hostSession, int hostPid, IFamilyResourceFactory factory, int capacity = 8)
        {
            if (!FamilyJobBinding.ValidText(hostSession, 128) || hostPid <= 0 || factory == null || capacity < 1 || capacity > 64)
                throw new ArgumentException("A fixed host, trusted factory and capacity from 1 to 64 are required.");
            this.hostSession = hostSession; this.hostPid = hostPid; this.factory = factory; this.capacity = capacity;
        }

        private FamilyJobSnapshot Snapshot(JobRecord job)
        {
            return new FamilyJobSnapshot(job.JobId, job.Handle, job.Binding, job.Stage,
                job.Resource != null && job.TemporaryProofIssued, job.Resource != null, job.OwnershipConflict,
                job.Readiness, job.CloseRequested, job.LastCode, job.CreationCode, job.InspectionCode, job.ResourceOwnerJobId);
        }
        private FamilyJobResult Result(JobRecord job, bool ok, string code)
        { return new FamilyJobResult(ok, code, job == null ? null : Snapshot(job)); }
        private bool HostMatches(FamilyJobBinding binding)
        { return binding != null && binding.HostPid == hostPid && String.Equals(binding.HostSession, hostSession, StringComparison.Ordinal); }
        private FamilyJobResult Lookup(string handle, FamilyJobBinding binding, out JobRecord job)
        {
            job = null;
            if (String.IsNullOrEmpty(handle) || !jobs.TryGetValue(handle, out job))
                return Result(null, false, "FAMILY_JOB_NOT_FOUND");
            if (!HostMatches(binding) || !job.Binding.SameAs(binding))
            { job = null; return Result(null, false, "FAMILY_BINDING_MISMATCH"); }
            return null;
        }

        private static void MarkOwnershipConflict(JobRecord affected, JobRecord owner)
        {
            affected.OwnershipConflict = true;
            affected.ResourceOwnerJobId = owner.JobId;
            affected.Readiness = FamilyReadiness.NotReady;
            affected.Stage = FamilyJobStage.CleanupPending;
            affected.LastCode = "FAMILY_OWNERSHIP_CONFLICT";
        }

        // Called only while holding gate. This is the sole owner of resource
        // reference registration and current ownership-conflict propagation.
        // At most one job holds each exact reference. Other affected jobs keep
        // the owner's identity, not a second Close-capable resource reference.
        private void RegisterReference(JobRecord requester, IFamilyJobResource resource, ReferenceRegistration kind)
        {
            JobRecord owner = null;
            foreach (JobRecord held in jobs.Values)
                if (held.Resource != null && Object.ReferenceEquals(held.Resource, resource))
                { owner = held; break; }

            if (kind == ReferenceRegistration.UserObservation)
            {
                if (owner != null)
                {
                    MarkOwnershipConflict(owner, owner);
                    MarkOwnershipConflict(requester, owner);
                }
                return;
            }
            if (kind == ReferenceRegistration.KnownConflict)
            {
                if (owner == null)
                {
                    if (requester.Resource != null)
                        throw new InvalidOperationException("The current job already retains a different resource.");
                    requester.Resource = resource;
                    owner = requester;
                }
                MarkOwnershipConflict(owner, owner);
                MarkOwnershipConflict(requester, owner);
                return;
            }
            if (requester.OwnershipConflict)
                throw new InvalidOperationException("An ownership conflict cannot be replaced by a new temporary claim.");
            if (owner != null)
            {
                MarkOwnershipConflict(owner, owner);
                MarkOwnershipConflict(requester, owner);
                throw new InvalidOperationException("The exact resource reference is already held by a job.");
            }
            if (requester.Resource != null)
                throw new InvalidOperationException("The current job ledger already retains a resource.");
            requester.Resource = resource;
            requester.ResourceOwnerJobId = requester.JobId;
            requester.TemporaryProofIssued = true;
        }

        private static string NewHandle()
        {
            byte[] bytes = new byte[32];
            using (RNGCryptoServiceProvider random = new RNGCryptoServiceProvider()) { random.GetBytes(bytes); }
            StringBuilder result = new StringBuilder(64);
            foreach (byte item in bytes) result.Append(item.ToString("x2"));
            return result.ToString();
        }

        public FamilyJobResult Prepare(FamilyJobBinding binding)
        {
            lock (gate)
            {
                if (!HostMatches(binding)) return Result(null, false, "FAMILY_BINDING_MISMATCH");
                if (busy) return Result(null, false, "FAMILY_BUSY");
                if (jobs.Count >= capacity)
                {
                    // Only confirmed terminal, unowned records may be evicted.
                    JobRecord oldest = null;
                    foreach (JobRecord held in jobs.Values)
                        if (held.Stage == FamilyJobStage.Closed && held.Resource == null && !held.OwnershipConflict &&
                            (oldest == null || held.Ordinal < oldest.Ordinal)) oldest = held;
                    if (oldest == null) return Result(null, false, "FAMILY_CAPACITY");
                    jobs.Remove(oldest.Handle);
                }
                string handle;
                try { do { handle = NewHandle(); } while (jobs.ContainsKey(handle)); }
                catch (Exception) { return Result(null, false, "FAMILY_HANDLE_UNAVAILABLE"); }
                JobRecord job = new JobRecord { JobId = Guid.NewGuid().ToString("N"), Handle = handle,
                    Binding = binding, Stage = FamilyJobStage.Prepared, Readiness = FamilyReadiness.Unknown,
                    LastCode = "FAMILY_PREPARED", CreationCode = "FAMILY_NOT_ATTEMPTED",
                    InspectionCode = "FAMILY_NOT_INSPECTED", Ordinal = ++ordinal };
                jobs.Add(handle, job);
                return Result(job, true, job.LastCode);
            }
        }

        public FamilyJobResult Get(string handle, FamilyJobBinding binding)
        {
            lock (gate)
            {
                JobRecord job; FamilyJobResult rejected = Lookup(handle, binding, out job);
                return rejected ?? Result(job, true, job.LastCode);
            }
        }

        public FamilyJobResult Create(string handle, FamilyJobBinding binding)
        {
            JobRecord job;
            FamilyCreationContext context;
            lock (gate)
            {
                FamilyJobResult rejected = Lookup(handle, binding, out job);
                if (rejected != null) return rejected;
                if (busy) return Result(job, false, "FAMILY_BUSY");
                if (job.CreateAttempted || job.Stage != FamilyJobStage.Prepared)
                    return Result(job, false, "FAMILY_CREATE_NOT_REPLAYABLE");
                busy = true; activeJob = job; activeOperation = "create";
                job.CreateAttempted = true; job.Stage = FamilyJobStage.Creating; job.LastCode = "FAMILY_CREATING";
                job.CreationCode = "FAMILY_CREATING";
                context = new FamilyCreationContext(job.JobId, job.Binding, gate,
                    delegate(IFamilyJobResource resource)
                    { RegisterReference(job, resource, ReferenceRegistration.TemporaryProof); },
                    delegate(IFamilyJobResource resource)
                    { RegisterReference(job, resource, ReferenceRegistration.KnownConflict); },
                    delegate(IFamilyJobResource resource)
                    { RegisterReference(job, resource, ReferenceRegistration.UserObservation); });
            }
            try
            {
                FamilyCreationOutcome created = null;
                bool factoryThrew = false;
                try { created = factory.Create(context); }
                catch (Exception) { factoryThrew = true; }
                finally { context.Seal(); }
                bool inspect = false;
                lock (gate)
                {
                    if (job.OwnershipConflict)
                    {
                        job.Stage = FamilyJobStage.CleanupPending; job.Readiness = FamilyReadiness.NotReady;
                        job.LastCode = "FAMILY_OWNERSHIP_CONFLICT"; job.CreationCode = job.LastCode;
                    }
                    else if (factoryThrew || created == null || !Object.ReferenceEquals(created.Issuer, context) || created.Kind == CreationKind.Unknown)
                    {
                        job.Stage = FamilyJobStage.OutcomeUnknown; job.Readiness = FamilyReadiness.Unknown;
                        job.LastCode = "FAMILY_CREATE_OUTCOME_UNKNOWN";
                        job.CreationCode = job.LastCode;
                    }
                    else if (created.Kind == CreationKind.CreatedTemporary && job.Resource != null)
                    {
                        inspect = true;
                        job.CreationCode = "FAMILY_CREATED_TEMPORARY";
                    }
                    else
                    {
                        job.Stage = FamilyJobStage.Rejected; job.Readiness = FamilyReadiness.NotReady;
                        job.LastCode = job.Resource != null ? "FAMILY_CREATION_RECEIPT_MISMATCH" :
                            created.Kind == CreationKind.ExistingUserDocument ? "FAMILY_USER_DOCUMENT_REJECTED" : "FAMILY_NOT_CREATED";
                        job.CreationCode = job.LastCode;
                    }
                }
                if (inspect) InspectOwned(job);
                bool shouldClose;
                lock (gate)
                {
                    if (job.CloseRequested && job.Resource == null && !job.OwnershipConflict && job.Stage != FamilyJobStage.OutcomeUnknown)
                    {
                        // A deferred close can complete without a Close call
                        // only when the factory explicitly established that no
                        // owned temporary resource was created. Unknown must
                        // keep its reservation, even after cancellation.
                        job.Stage = FamilyJobStage.Closed;
                        job.Readiness = FamilyReadiness.NotReady;
                        job.LastCode = "FAMILY_CLOSED_NO_RESOURCE";
                    }
                    shouldClose = job.CloseRequested && job.Resource != null && !job.OwnershipConflict;
                    // Once the last deferred-intent check has finished, later
                    // requests are explicitly BUSY rather than acknowledged as
                    // deferred and then forgotten during finalization.
                    activeOperation = shouldClose ? "close" : "finalizing";
                }
                if (shouldClose) CloseOwned(job);
                lock (gate) { return Result(job, job.Stage == FamilyJobStage.Ready || job.Stage == FamilyJobStage.Closed, job.LastCode); }
            }
            finally
            {
                lock (gate) { busy = false; activeJob = null; activeOperation = null; }
            }
        }

        private void InspectOwned(JobRecord job)
        {
            FamilyResourceFacts facts = null;
            bool threw = false;
            try { facts = job.Resource.Inspect(); } catch (Exception) { threw = true; }
            lock (gate)
            {
                job.Stage = FamilyJobStage.Rejected;
                job.Readiness = FamilyReadiness.Unknown;
                if (threw) job.LastCode = "FAMILY_INSPECTION_FAILED";
                else if (facts == null || !facts.IsValid.HasValue || !facts.IsFamilyDocument.HasValue)
                    job.LastCode = "FAMILY_INSPECTION_UNKNOWN";
                else if (!String.Equals(facts.JobId, job.JobId, StringComparison.Ordinal) || !job.Binding.SameAs(facts.Binding))
                { job.Readiness = FamilyReadiness.NotReady; job.LastCode = "FAMILY_RESOURCE_BINDING_MISMATCH"; }
                else if (!facts.IsValid.Value)
                { job.Readiness = FamilyReadiness.NotReady; job.LastCode = "FAMILY_RESOURCE_INVALID"; }
                else if (!facts.IsFamilyDocument.Value)
                { job.Readiness = FamilyReadiness.NotReady; job.LastCode = "FAMILY_RESOURCE_NOT_FAMILY"; }
                else
                { job.Stage = FamilyJobStage.Ready; job.Readiness = FamilyReadiness.Ready; job.LastCode = "FAMILY_READY"; }
                job.InspectionCode = job.LastCode;
            }
        }

        private void CloseOwned(JobRecord job)
        {
            IFamilyJobResource owned;
            lock (gate)
            {
                if (job.OwnershipConflict)
                {
                    job.Stage = FamilyJobStage.CleanupPending; job.Readiness = FamilyReadiness.NotReady;
                    job.LastCode = "FAMILY_OWNERSHIP_CONFLICT";
                    return;
                }
                owned = job.Resource;
                job.CloseRequested = true; job.Stage = FamilyJobStage.Closing;
                job.Readiness = FamilyReadiness.NotReady;
                job.LastCode = "FAMILY_CLOSING"; activeOperation = "close";
            }
            FamilyCloseOutcome closed = FamilyCloseOutcome.Unknown;
            bool threw = false;
            try { closed = owned.Close(); } catch (Exception) { threw = true; }
            lock (gate)
            {
                if (!threw && closed == FamilyCloseOutcome.ConfirmedClosed)
                {
                    job.Resource = null; job.Stage = FamilyJobStage.Closed;
                    job.ResourceOwnerJobId = null;
                    job.Readiness = FamilyReadiness.NotReady; job.LastCode = "FAMILY_CLOSED";
                }
                else
                {
                    job.Stage = FamilyJobStage.CleanupPending;
                    job.LastCode = threw ? "FAMILY_CLOSE_FAILED" : closed == FamilyCloseOutcome.NotClosed ?
                        "FAMILY_NOT_CLOSED" : "FAMILY_CLOSE_UNKNOWN";
                }
            }
        }

        public FamilyJobResult RequestClose(string handle, FamilyJobBinding binding)
        {
            JobRecord job;
            lock (gate)
            {
                FamilyJobResult rejected = Lookup(handle, binding, out job);
                if (rejected != null) return rejected;
                if (busy)
                {
                    if (Object.ReferenceEquals(activeJob, job) && activeOperation == "create")
                    { job.CloseRequested = true; return Result(job, true, "FAMILY_CLOSE_DEFERRED"); }
                    return Result(job, false, "FAMILY_BUSY");
                }
                if (job.Stage == FamilyJobStage.Closed) return Result(job, true, "FAMILY_CLOSED");
                job.CloseRequested = true;
                if (job.OwnershipConflict)
                {
                    job.Stage = FamilyJobStage.CleanupPending; job.Readiness = FamilyReadiness.NotReady;
                    job.LastCode = "FAMILY_OWNERSHIP_CONFLICT";
                    return Result(job, false, job.LastCode);
                }
                if (job.Resource == null)
                {
                    if (job.Stage == FamilyJobStage.OutcomeUnknown)
                        return Result(job, false, "FAMILY_CREATE_OUTCOME_UNKNOWN");
                    job.Stage = FamilyJobStage.Closed; job.Readiness = FamilyReadiness.NotReady; job.LastCode = "FAMILY_CLOSED_NO_RESOURCE";
                    return Result(job, true, job.LastCode);
                }
                busy = true; activeJob = job; activeOperation = "close";
            }
            try { CloseOwned(job); lock (gate) { return Result(job, job.Stage == FamilyJobStage.Closed, job.LastCode); } }
            finally { lock (gate) { busy = false; activeJob = null; activeOperation = null; } }
        }

        public FamilyCleanupResult CleanupAll()
        {
            List<JobRecord> selected;
            lock (gate)
            {
                if (busy) return new FamilyCleanupResult(false, "FAMILY_BUSY", new List<FamilyJobResult>());
                busy = true; activeOperation = "cleanup";
                selected = new List<JobRecord>(jobs.Values);
            }
            List<FamilyJobResult> results = new List<FamilyJobResult>();
            bool complete = true;
            try
            {
                foreach (JobRecord job in selected)
                {
                    bool hasResource;
                    lock (gate) { activeJob = job; job.CloseRequested = true; hasResource = job.Resource != null; }
                    if (hasResource) CloseOwned(job);
                    lock (gate)
                    {
                        if (!hasResource && !job.OwnershipConflict && job.Stage != FamilyJobStage.OutcomeUnknown)
                        { job.Stage = FamilyJobStage.Closed; job.Readiness = FamilyReadiness.NotReady; job.LastCode = "FAMILY_CLOSED_NO_RESOURCE"; }
                        bool closed = job.Stage == FamilyJobStage.Closed;
                        complete = complete && closed;
                        results.Add(Result(job, closed, job.LastCode));
                    }
                }
                return new FamilyCleanupResult(complete, complete ? "FAMILY_CLEANUP_COMPLETE" : "FAMILY_CLEANUP_INCOMPLETE", results);
            }
            finally { lock (gate) { busy = false; activeJob = null; activeOperation = null; } }
        }
    }
}
