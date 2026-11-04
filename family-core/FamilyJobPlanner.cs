using System;

namespace BuildX.FamilyCore
{
    public sealed class FamilyPlanningResult
    {
        public bool Ok { get; private set; }
        public string Code { get; private set; }
        // InitialProject is explicitly historical within this planning attempt.
        // Project is the last fresh check; it is null if that check threw.
        public ProjectDocumentSnapshot InitialProject { get; private set; }
        public ProjectDocumentSnapshot Project { get; private set; }
        public string ProjectCheckCode { get; private set; }
        public FamilyTemplateObservation Template { get; private set; }
        public FamilyJobSnapshot PreparedJob { get; private set; }
        public string JobCode { get; private set; }

        internal FamilyPlanningResult(bool ok, string code, ProjectDocumentSnapshot initialProject,
            ProjectDocumentSnapshot project, string projectCheckCode,
            FamilyTemplateObservation template, FamilyJobSnapshot preparedJob, string jobCode)
        {
            Ok = ok; Code = code; InitialProject = initialProject; Project = project;
            ProjectCheckCode = projectCheckCode; Template = template;
            PreparedJob = preparedJob; JobCode = jobCode;
        }
    }

    /// <summary>
    /// Reserves an unexecuted family job from fresh, fixed-owner observations.
    /// No document creation, closure, transaction, file write or model authority
    /// is granted. Every later execution phase still needs its own fresh checks.
    /// Repeating Prepare may reserve a different job; it is not execution replay.
    /// </summary>
    public sealed class FamilyJobPlanner
    {
        private readonly object gate = new object();
        private readonly string hostSession;
        private readonly int hostPid;
        private readonly ProjectDocumentRegistry projects;
        private readonly IFamilyTemplateSource templates;
        private readonly FamilyJobRegistry jobs;
        private bool busy;

        public FamilyJobPlanner(string hostSession, int hostPid,
            ProjectDocumentRegistry projects, IFamilyTemplateSource templates, FamilyJobRegistry jobs)
        {
            if (!FamilyJobBinding.ValidText(hostSession, 128) || hostPid <= 0 ||
                projects == null || templates == null || jobs == null)
                throw new ArgumentException("A fixed host and three trusted owners are required.");
            this.hostSession = hostSession; this.hostPid = hostPid;
            this.projects = projects; this.templates = templates; this.jobs = jobs;
        }

        public FamilyPlanningResult Prepare(string projectHandle, string templateId)
        {
            lock (gate)
            {
                if (busy) return Result(false, "FAMILY_PLAN_BUSY", null, null, null, null, null, null);
                if (!FamilyJobBinding.ValidText(projectHandle, 256) || !FamilyJobBinding.ValidText(templateId, 128))
                    return Result(false, "FAMILY_PLAN_INPUT_INVALID", null, null, null, null, null, null);
                busy = true;
            }
            ProjectDocumentSnapshot first = null, current = null;
            FamilyTemplateObservation template = null;
            string projectCode = null;
            try
            {
                ProjectDocumentResult check;
                try { check = projects.Check(projectHandle, hostSession, hostPid); }
                catch { return Result(false, "FAMILY_PLAN_PROJECT_CHECK_FAILED", null, null, "PROJECT_CHECK_FAILED", null, null, null); }
                current = check.Snapshot; first = current; projectCode = check.Code;
                string rejection = CheckProject(check, projectHandle);
                if (rejection != null) return Result(false, rejection, first, current, projectCode, null, null, null);

                // From this external boundary onward the first snapshot is
                // historical. A failing template observation cannot leave it
                // advertised as the current project verification.
                current = null; projectCode = "PROJECT_RECHECK_REQUIRED";
                try { template = templates.Inspect(templateId); }
                catch { return Result(false, "FAMILY_PLAN_TEMPLATE_FAILED", first, current, projectCode, null, null, null); }
                string templateRejection = CheckTemplate(template, templateId);
                if (templateRejection != null)
                    return Result(false, templateRejection, first, current, projectCode, template, null, null);

                FamilyJobBinding binding;
                try { binding = new FamilyJobBinding(hostSession, hostPid, projectHandle, first.PersistentFingerprint, template.Sha256); }
                catch (ArgumentException)
                { return Result(false, "FAMILY_PLAN_BINDING_INVALID", first, current, projectCode, template, null, null); }

                // Template collection can take time. Do not use the first
                // snapshot as the current project after that external call.
                current = null; projectCode = "PROJECT_CHECK_PENDING";
                try { check = projects.Check(projectHandle, hostSession, hostPid); }
                catch { return Result(false, "FAMILY_PLAN_PROJECT_CHECK_FAILED", first, null, "PROJECT_CHECK_FAILED", template, null, null); }
                current = check.Snapshot; projectCode = check.Code;
                rejection = CheckProject(check, projectHandle);
                if (rejection != null) return Result(false, rejection, first, current, projectCode, template, null, null);
                if (!String.Equals(first.PersistentFingerprint, current.PersistentFingerprint, StringComparison.Ordinal) ||
                    !String.Equals(first.CurrentFacts.PersistentFingerprint, current.CurrentFacts.PersistentFingerprint, StringComparison.Ordinal))
                    return Result(false, "FAMILY_PLAN_PROJECT_CHANGED", first, current, projectCode, template, null, null);

                FamilyJobResult prepared;
                try { prepared = jobs.Prepare(binding); }
                catch
                {
                    // No automatic retry: even reservation completion could be
                    // unknown after an unexpected owner exception.
                    return Result(false, "FAMILY_PLAN_RESERVATION_UNKNOWN", first, current, projectCode, template, null, "RESERVATION_UNKNOWN");
                }
                if (!prepared.Ok)
                    return Result(false, "FAMILY_PLAN_RESERVATION_FAILED", first, current, projectCode, template, prepared.Job, prepared.Code);
                return Result(true, "FAMILY_PLAN_PREPARED", first, current, projectCode, template, prepared.Job, prepared.Code);
            }
            finally { lock (gate) busy = false; }
        }

        // A standalone family job does not infer or borrow a project identity.
        // A later project load must separately capture and validate its target.
        public FamilyPlanningResult PrepareIndependent(string templateId)
        {
            lock (gate)
            {
                if (busy) return Result(false, "FAMILY_PLAN_BUSY", null, null, null, null, null, null);
                if (!FamilyJobBinding.ValidText(templateId, 128)) return Result(false, "FAMILY_PLAN_INPUT_INVALID", null, null, null, null, null, null);
                busy = true;
            }
            try
            {
                FamilyTemplateObservation template;
                try { template = templates.Inspect(templateId); }
                catch { return Result(false, "FAMILY_PLAN_TEMPLATE_FAILED", null, null, null, null, null, null); }
                string rejection = CheckTemplate(template, templateId);
                if (rejection != null) return Result(false, rejection, null, null, null, template, null, null);
                FamilyJobBinding binding;
                try { binding = FamilyJobBinding.Independent(hostSession, hostPid, template.Sha256); }
                catch (ArgumentException) { return Result(false, "FAMILY_PLAN_BINDING_INVALID", null, null, null, template, null, null); }
                FamilyJobResult prepared;
                try { prepared = jobs.Prepare(binding); }
                catch { return Result(false, "FAMILY_PLAN_RESERVATION_UNKNOWN", null, null, null, template, null, "RESERVATION_UNKNOWN"); }
                return prepared.Ok ? Result(true, "FAMILY_PLAN_PREPARED", null, null, null, template, prepared.Job, prepared.Code) :
                    Result(false, "FAMILY_PLAN_RESERVATION_FAILED", null, null, null, template, prepared.Job, prepared.Code);
            }
            finally { lock (gate) busy = false; }
        }

        private static string CheckTemplate(FamilyTemplateObservation template, string templateId)
        {
            if (template == null) return "FAMILY_PLAN_TEMPLATE_UNKNOWN";
            if (!String.Equals(template.TemplateId, templateId, StringComparison.Ordinal)) return "FAMILY_PLAN_TEMPLATE_ID_MISMATCH";
            if (template.State != FamilyTemplateState.BytesVerified || template.Issue != FamilyTemplateIssue.None) return "FAMILY_PLAN_TEMPLATE_NOT_VERIFIED";
            if (!FamilyJobBinding.ValidText(template.SourcePath, 32767) || !template.ByteLength.HasValue || template.ByteLength.Value <= 0)
                return "FAMILY_PLAN_TEMPLATE_FACTS_INVALID";
            return null;
        }

        private string CheckProject(ProjectDocumentResult check, string expectedHandle)
        {
            ProjectDocumentSnapshot snapshot = check.Snapshot;
            if (!check.Ok || snapshot == null) return "FAMILY_PLAN_PROJECT_UNAVAILABLE";
            ProjectDocumentFacts facts = snapshot.CurrentFacts;
            if (!String.Equals(snapshot.Handle, expectedHandle, StringComparison.Ordinal) ||
                !String.Equals(snapshot.HostSession, hostSession, StringComparison.Ordinal) || snapshot.HostPid != hostPid ||
                !snapshot.Retained || snapshot.Invalidated || snapshot.IdentityConflict ||
                snapshot.IdentityReadiness != ProjectIdentityReadiness.Ready || facts == null ||
                facts.IsValid != true || facts.IsFamilyDocument != false || facts.IsLinked != false ||
                !FamilyJobBinding.ValidText(snapshot.PersistentFingerprint, 1024) ||
                !String.Equals(snapshot.PersistentFingerprint, facts.PersistentFingerprint, StringComparison.Ordinal))
                return "FAMILY_PLAN_PROJECT_UNAVAILABLE";
            if (facts.IsReadOnly == true) return "FAMILY_PLAN_PROJECT_READ_ONLY";
            if (facts.IsReadOnly != false) return "FAMILY_PLAN_PROJECT_UNAVAILABLE";
            return null;
        }

        private static FamilyPlanningResult Result(bool ok, string code,
            ProjectDocumentSnapshot first, ProjectDocumentSnapshot current, string projectCode,
            FamilyTemplateObservation template, FamilyJobSnapshot preparedJob, string jobCode)
        { return new FamilyPlanningResult(ok, code, first, current, projectCode, template, preparedJob, jobCode); }
    }
}
