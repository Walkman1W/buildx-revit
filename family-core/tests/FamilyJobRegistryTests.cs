using System;
using System.Collections.Generic;
using System.Threading;
using BuildX.FamilyCore;

namespace BuildX.FamilyCore.OfflineTests
{
    internal sealed class DelegateFactory : IFamilyResourceFactory
    {
        private readonly Func<FamilyCreationContext, FamilyCreationOutcome> callback;
        public int Calls;
        public DelegateFactory(Func<FamilyCreationContext, FamilyCreationOutcome> callback) { this.callback = callback; }
        public FamilyCreationOutcome Create(FamilyCreationContext context) { Calls++; return callback(context); }
    }

    internal sealed class FakeResource : IFamilyJobResource
    {
        private readonly FamilyCreationContext context;
        public int InspectCalls;
        public int CloseCalls;
        public Func<FamilyResourceFacts> InspectHandler;
        public Func<FamilyCloseOutcome> CloseHandler;
        public FakeResource(FamilyCreationContext context) { this.context = context; }
        public FamilyResourceFacts Inspect()
        {
            InspectCalls++;
            return InspectHandler != null ? InspectHandler() : new FamilyResourceFacts(true, true, context.JobId, context.Binding);
        }
        public FamilyCloseOutcome Close()
        {
            CloseCalls++;
            return CloseHandler != null ? CloseHandler() : FamilyCloseOutcome.ConfirmedClosed;
        }
    }

    internal static class Program
    {
        private const string Host = "offline-host-session";
        private const int HostPid = 17;
        private static int total;
        private static int passed;
        private static readonly string HashA = new string('a', 64);
        private static readonly string HashB = new string('b', 64);

        private static FamilyJobBinding Binding(string session = Host, int pid = HostPid,
            string documentHandle = "project-document-instance-1", string fingerprint = "project-fingerprint-1", string hash = null)
        {
            return new FamilyJobBinding(session, pid, documentHandle, fingerprint, hash ?? HashA);
        }
        private static FamilyJobRegistry Registry(DelegateFactory factory, int capacity = 8)
        {
            return new FamilyJobRegistry(Host, HostPid, factory, capacity);
        }
        private static void True(bool condition, string message) { if (!condition) throw new Exception(message); }
        private static void Equal<T>(T expected, T actual, string message)
        {
            if (!Object.Equals(expected, actual)) throw new Exception(message + ": expected " + expected + ", actual " + actual);
        }
        private static void NotOk(FamilyJobResult result, string message)
        {
            True(result != null && !result.Ok && !String.IsNullOrEmpty(result.Code), message);
        }
        private static FamilyJobResult Ok(FamilyJobResult result, string message)
        {
            True(result != null && result.Ok && result.Job != null, message + (result == null ? " (null)" : " (" + result.Code + ")"));
            return result;
        }
        private static void Stage(FamilyJobResult result, string expected, string message)
        {
            True(result != null && result.Job != null, message + " requires a retained job summary");
            Equal(expected, result.Job.Stage.ToString(), message);
        }
        private static void ThrowsArgument(Action action, string message)
        {
            try { action(); } catch (ArgumentException) { return; }
            throw new Exception(message);
        }
        private static void Run(string name, Action test)
        {
            total++;
            try { test(); passed++; Console.WriteLine("ok " + total + " - " + name); }
            catch (Exception error)
            {
                Console.WriteLine("not ok " + total + " - " + name);
                Console.WriteLine("# failure: " + error.GetType().Name + ": " + error.Message.Replace("\r", " ").Replace("\n", " "));
            }
        }

        private static void Configuration()
        {
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) { return c.NotCreated(); });
            ThrowsArgument(delegate { new FamilyJobRegistry("", HostPid, factory, 2); }, "empty host must fail");
            ThrowsArgument(delegate { new FamilyJobRegistry(Host, 0, factory, 2); }, "invalid process binding must fail");
            ThrowsArgument(delegate { new FamilyJobRegistry(Host, HostPid, null, 2); }, "missing factory must fail");
            ThrowsArgument(delegate { new FamilyJobRegistry(Host, HostPid, factory, 0); }, "zero capacity must fail");
            ThrowsArgument(delegate { new FamilyJobBinding(Host, HostPid, "", "fingerprint", HashA); }, "missing document instance must fail");
            ThrowsArgument(delegate { new FamilyJobBinding(Host, HostPid, "document", "", HashA); }, "missing project fingerprint must fail");
            ThrowsArgument(delegate { new FamilyJobBinding(Host, HostPid, "document", "fingerprint", "not-sha256"); }, "invalid template digest must fail");
            Equal(HashA, Binding(hash: HashA.ToUpperInvariant()).TemplateSha256, "SHA case is normalized once");
            Equal(0, factory.Calls, "configuration must not execute a factory");
        }

        private static void HostBinding()
        {
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) { return c.NotCreated(); });
            FamilyJobRegistry registry = Registry(factory);
            NotOk(registry.Prepare(Binding(session: Host.ToUpperInvariant())), "host session is ordinal");
            NotOk(registry.Prepare(Binding(pid: HostPid + 1)), "process must match the registry host");
            Ok(registry.Prepare(Binding()), "matching host may reserve a job");
            Equal(0, factory.Calls, "prepare is a reservation, not document creation");
        }

        private static void AllBindingFields()
        {
            FakeResource resource = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) { resource = new FakeResource(c); return c.CreatedTemporary(resource); });
            FamilyJobRegistry registry = Registry(factory); FamilyJobBinding binding = Binding();
            FamilyJobResult prepared = Ok(registry.Prepare(binding), "prepare"); string handle = prepared.Job.Handle;
            FamilyJobBinding[] mismatches = new FamilyJobBinding[] {
                Binding(session: Host.ToUpperInvariant()), Binding(pid: HostPid + 1),
                Binding(documentHandle: "project-document-instance-2"),
                Binding(documentHandle: "PROJECT-DOCUMENT-INSTANCE-1"),
                Binding(fingerprint: "PROJECT-FINGERPRINT-1"), Binding(hash: HashB)
            };
            foreach (FamilyJobBinding other in mismatches)
            {
                NotOk(registry.Get(handle, other), "foreign binding cannot inspect this job");
                NotOk(registry.Create(handle, other), "foreign binding cannot execute this job");
                NotOk(registry.RequestClose(handle, other), "foreign binding cannot close this job");
            }
            Equal(0, factory.Calls, "binding refusals happen before any factory");
            Ok(registry.Create(handle, binding), "the exact original binding still works");
            Equal(1, factory.Calls, "one authorized factory call");
            Ok(registry.Get(handle, Binding(hash: HashA.ToUpperInvariant())), "canonical digest still identifies the same template");
            Ok(registry.RequestClose(handle, binding), "exact owner cleanup"); Equal(1, resource.CloseCalls, "one exact close");
        }

        private static void OpaqueHandles()
        {
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) { return c.NotCreated(); });
            FamilyJobRegistry first = Registry(factory), second = Registry(factory); FamilyJobBinding binding = Binding();
            FamilyJobResult issued = Ok(first.Prepare(binding), "prepare owner");
            string[] foreign = new string[] { null, "", Guid.NewGuid().ToString("N"), "forged-" + issued.Job.Handle };
            foreach (string handle in foreign)
            {
                NotOk(first.Get(handle, binding), "unissued handle cannot select a job");
                NotOk(first.Create(handle, binding), "unissued handle cannot create");
                NotOk(first.RequestClose(handle, binding), "unissued handle cannot close");
            }
            NotOk(second.Get(issued.Job.Handle, binding), "a handle is scoped to its issuing registry");
            Equal(0, factory.Calls, "guessed or foreign handles never execute");
            Ok(first.RequestClose(issued.Job.Handle, binding), "the owner can close its prepared reservation");
        }

        private static void HappyOwnedLifecycle()
        {
            FakeResource resource = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) { resource = new FakeResource(c); return c.CreatedTemporary(resource); });
            FamilyJobRegistry registry = Registry(factory); FamilyJobBinding binding = Binding();
            FamilyJobResult prepared = Ok(registry.Prepare(binding), "prepare");
            Stage(prepared, "Prepared", "initial stage"); True(!prepared.Job.Owned, "reservation owns no document");
            FamilyJobResult created = Ok(registry.Create(prepared.Job.Handle, binding), "create");
            Stage(created, "Ready", "valid exact temporary resource becomes ready");
            True(created.Job.Owned, "created resource is owned"); Equal("Ready", created.Job.Readiness.ToString(), "readiness is separate from ownership");
            Equal(prepared.Job.JobId, created.Job.JobId, "audit job identity is retained");
            Equal(1, resource.InspectCalls, "the resource was actually inspected"); Equal(0, resource.CloseCalls, "readiness does not close the resource");
            FamilyJobResult closed = Ok(registry.RequestClose(prepared.Job.Handle, binding), "close");
            Stage(closed, "Closed", "confirmed closure is terminal"); True(!closed.Job.Owned, "confirmed resource ownership ends");
            Equal(1, resource.CloseCalls, "exact resource close observed");
        }

        private static void UserDocumentNeverClosed()
        {
            FakeResource resource = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) { resource = new FakeResource(c); return c.ExistingUserDocument(resource); });
            FamilyJobRegistry registry = Registry(factory); FamilyJobBinding binding = Binding();
            FamilyJobResult prepared = Ok(registry.Prepare(binding), "prepare");
            FamilyJobResult result = registry.Create(prepared.Job.Handle, binding);
            True(result.Job != null && !result.Job.Owned, "user document is never adopted as an owned temporary document");
            registry.RequestClose(prepared.Job.Handle, binding); registry.CleanupAll(); registry.CleanupAll();
            Equal(0, resource.CloseCalls, "no cleanup path may close an existing user document");
        }

        private static void InvalidOwnedFactsStillCleanable()
        {
            bool?[,] values = new bool?[,] { { false, true }, { true, false }, { null, true }, { true, null } };
            for (int index = 0; index < values.GetLength(0); index++)
            {
                bool? valid = values[index, 0], family = values[index, 1]; FakeResource resource = null;
                DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                    resource = new FakeResource(c); resource.InspectHandler = delegate { return new FamilyResourceFacts(valid, family, c.JobId, c.Binding); };
                    return c.CreatedTemporary(resource);
                });
                FamilyJobRegistry registry = Registry(factory); FamilyJobBinding binding = Binding();
                string handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
                FamilyJobResult inspected = registry.Create(handle, binding);
                True(inspected.Job != null && inspected.Job.Owned, "invalid or unknown validity does not erase ownership");
                True(inspected.Job.Readiness.ToString() != "Ready", "uncertain or invalid facts are not ready");
                FamilyJobResult closed = registry.RequestClose(handle, binding);
                Stage(closed, "Closed", "owned invalid resource remains closable");
                Equal(1, resource.CloseCalls, "owned invalid exact resource was cleaned"); True(!closed.Job.Owned, "cleanup released it");
            }
        }

        private static void InspectThrowStillOwned()
        {
            FakeResource resource = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                resource = new FakeResource(c); resource.InspectHandler = delegate { throw new Exception("Synthetic inspect failure"); };
                return c.CreatedTemporary(resource);
            });
            FamilyJobRegistry registry = Registry(factory); FamilyJobBinding binding = Binding();
            string handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
            FamilyJobResult result = registry.Create(handle, binding);
            NotOk(result, "inspect failure cannot become success"); True(result.Job.Owned, "inspection failure preserves exact owner");
            Stage(registry.RequestClose(handle, binding), "Closed", "cleanup does not require re-proving validity");
            Equal(1, resource.CloseCalls, "inspection failure does not leak the temporary resource");
        }

        private static void MismatchedFactsStillOwned()
        {
            FakeResource resource = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                resource = new FakeResource(c); resource.InspectHandler = delegate { return new FamilyResourceFacts(true, true, c.JobId, Binding(documentHandle: "another-open-document")); };
                return c.CreatedTemporary(resource);
            });
            FamilyJobRegistry registry = Registry(factory); FamilyJobBinding binding = Binding(); string handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
            FamilyJobResult result = registry.Create(handle, binding); NotOk(result, "mismatched resource facts cannot become ready");
            True(result.Job.Owned, "the proof owner survives mismatched facts");
            Stage(registry.RequestClose(handle, binding), "Closed", "the owner can clean its exact temporary resource"); Equal(1, resource.CloseCalls, "one cleanup");
        }

        private static void CloseRetry(FamilyCloseOutcome firstOutcome, bool throws)
        {
            FakeResource resource = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                resource = new FakeResource(c); resource.CloseHandler = delegate {
                    if (resource.CloseCalls == 1) { if (throws) throw new Exception("Synthetic close failure"); return firstOutcome; }
                    return FamilyCloseOutcome.ConfirmedClosed;
                }; return c.CreatedTemporary(resource);
            });
            FamilyJobRegistry registry = Registry(factory); FamilyJobBinding binding = Binding(); string handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
            FamilyJobResult ready = Ok(registry.Create(handle, binding), "create");
            string inspectionHistory = ready.Job.InspectionCode;
            True(!String.IsNullOrEmpty(inspectionHistory), "ready inspection has a captured historical code");
            FamilyJobResult failed = registry.RequestClose(handle, binding); NotOk(failed, "unconfirmed close is not success");
            Stage(failed, "CleanupPending", "failed close retains cleanup stage"); True(failed.Job.Owned, "failed close preserves ownership");
            True(failed.Job.Readiness.ToString() != "Ready", "unconfirmed close does not inherit readiness from before closing");
            Equal(inspectionHistory, failed.Job.InspectionCode, "cleanup outcome does not erase inspection history");
            True(registry.Get(handle, binding).Job.Owned, "query retains the issued handle"); Equal(1, resource.CloseCalls, "query does not automatically retry close");
            FamilyJobResult retried = Ok(registry.RequestClose(handle, binding), "explicit cleanup retry"); Stage(retried, "Closed", "confirmed retry is terminal");
            True(!retried.Job.Owned, "confirmed retry releases ownership"); Equal(2, resource.CloseCalls, "the exact resource is retried once");
        }

        private static void ClosingRevokesReadiness()
        {
            FamilyJobRegistry registry = null; FamilyJobBinding binding = Binding(); string handle = null; FakeResource resource = null;
            FamilyJobResult observedDuringClose = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                resource = new FakeResource(c); resource.CloseHandler = delegate {
                    observedDuringClose = registry.Get(handle, binding);
                    return resource.CloseCalls == 1 ? FamilyCloseOutcome.Unknown : FamilyCloseOutcome.ConfirmedClosed;
                }; return c.CreatedTemporary(resource);
            });
            registry = Registry(factory); handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
            FamilyJobResult ready = Ok(registry.Create(handle, binding), "create");
            Equal("Ready", ready.Job.Readiness.ToString(), "initial inspected resource is ready");
            string history = ready.Job.InspectionCode;
            True(!String.IsNullOrEmpty(history), "inspection history exists before cleanup");
            FamilyJobResult failed = registry.RequestClose(handle, binding);
            Stage(observedDuringClose, "Closing", "external close sees a closing stage");
            True(observedDuringClose.Job.Readiness.ToString() != "Ready", "readiness is revoked before the external close call");
            Equal(history, observedDuringClose.Job.InspectionCode, "the closing snapshot preserves historical inspection facts");
            Stage(failed, "CleanupPending", "unknown cleanup remains pending");
            True(failed.Job.Readiness.ToString() != "Ready", "pending cleanup does not advertise usable readiness");
            Equal(history, failed.Job.InspectionCode, "failed cleanup preserves history");
            FamilyJobResult closed = registry.RequestClose(handle, binding);
            Stage(closed, "Closed", "explicit retry completes cleanup"); Equal(history, closed.Job.InspectionCode, "terminal cleanup retains the inspection history");
            Equal(1, resource.InspectCalls, "cleanup did not replace readiness by re-inspecting a closing resource");
        }

        private static void ConflictingUserAndTemporaryClaims()
        {
            foreach (bool userFirst in new bool[] { true, false })
            {
                FakeResource resource = null;
                DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                    resource = new FakeResource(c);
                    if (userFirst) { c.ExistingUserDocument(resource); return c.CreatedTemporary(resource); }
                    c.CreatedTemporary(resource); return c.ExistingUserDocument(resource);
                });
                FamilyJobRegistry registry = Registry(factory, 1); FamilyJobBinding binding = Binding();
                string handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
                FamilyJobResult conflict = registry.Create(handle, binding);
                NotOk(conflict, "conflicting user/temporary classification is not successful creation");
                Stage(conflict, "CleanupPending", "conflicting ownership stays pending for a decision");
                True(conflict.Job.OwnershipConflict && conflict.Job.ResourceRetained, "the ambiguous exact resource remains retained with explicit conflict");
                Equal(!userFirst, conflict.Job.Owned, "Owned reports whether the temporary proof was actually issued");
                True(conflict.Job.Readiness.ToString() != "Ready", "an ownership conflict cannot be used as a ready family job");
                True(conflict.Job.CreationCode.Contains("OWNERSHIP_CONFLICT"), "creation history names the ownership conflict");
                FamilyJobResult closing = registry.RequestClose(handle, binding);
                NotOk(closing, "cleanup cannot infer authority to close a potential user document");
                Stage(closing, "CleanupPending", "unresolved conflict is not a terminal closed result");
                True(!registry.CleanupAll().Ok, "batch cleanup also reports the unresolved conflict");
                Equal(0, resource.CloseCalls, "neither order may close a potentially user-owned document");
                FamilyJobResult retained = registry.Get(handle, binding);
                True(retained != null && retained.Job != null, "retained conflict remains queryable by its exact handle");
                True(retained.Job.OwnershipConflict && retained.Job.ResourceRetained, "explicit retry does not erase unresolved evidence");
                NotOk(registry.Prepare(binding), "a retained conflict cannot be evicted to free capacity");
            }
        }

        private static void SharedResourceConflictHasOneRetainingJob()
        {
            FamilyJobRegistry registry = null; FamilyJobBinding binding = Binding();
            FakeResource shared = null; string secondHandle = null; FamilyJobResult deferred = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                if (shared == null) { shared = new FakeResource(c); return c.CreatedTemporary(shared); }
                deferred = registry.RequestClose(secondHandle, binding);
                c.ExistingUserDocument(shared);
                return c.CreatedTemporary(shared);
            });
            registry = Registry(factory, 2);
            string firstHandle = Ok(registry.Prepare(binding), "prepare original owner").Job.Handle;
            FamilyJobResult originalReady = Ok(registry.Create(firstHandle, binding), "create the original ready owner");
            string originalJobId = originalReady.Job.JobId, inspectionHistory = originalReady.Job.InspectionCode;
            Equal("Ready", originalReady.Job.Readiness.ToString(), "first job is ready before the later conflicting claim");
            secondHandle = Ok(registry.Prepare(binding), "prepare the second job").Job.Handle;
            FamilyJobResult second = registry.Create(secondHandle, binding);
            Stage(deferred, "Creating", "second job accepted a deferred close while creating");
            True(deferred.Job.CloseRequested, "second job close intent was recorded before its conflicting outcome");
            NotOk(second, "a conflicting late claim cannot be successful creation");
            FamilyJobResult first = registry.Get(firstHandle, binding);
            Stage(first, "CleanupPending", "the original owner is also made unsafe by the user-document conflict");
            Stage(second, "CleanupPending", "deferred close cannot fake-close a conflict without a local resource reference");
            True(first.Job.OwnershipConflict && second.Job.OwnershipConflict, "the conflict is propagated to both affected jobs");
            True(first.Job.Readiness.ToString() != "Ready" && second.Job.Readiness.ToString() != "Ready", "neither affected job remains usable");
            Equal(inspectionHistory, first.Job.InspectionCode, "the original ready inspection remains historical evidence");
            True(first.Job.ResourceRetained && first.Job.Owned, "the original proof owner uniquely retains the exact resource");
            True(!second.Job.ResourceRetained && !second.Job.Owned, "the second job retains a conflict link rather than a duplicate document owner");
            Equal(originalJobId, second.Job.ResourceOwnerJobId, "the conflict explicitly points to the existing retaining job");
            Equal(1, (first.Job.ResourceRetained ? 1 : 0) + (second.Job.ResourceRetained ? 1 : 0), "only one job holds the shared resource reference");
            NotOk(registry.RequestClose(firstHandle, binding), "the original job cannot close a potentially user-owned resource");
            FamilyJobResult secondClose = registry.RequestClose(secondHandle, binding);
            NotOk(secondClose, "the linked conflict job cannot report successful cleanup");
            Stage(secondClose, "CleanupPending", "no-reference conflict is not a no-resource terminal success");
            FamilyCleanupResult all = registry.CleanupAll();
            True(!all.Ok && all.Items != null && all.Items.Count == 2, "batch cleanup reports both bounded unresolved jobs");
            Equal(0, shared.CloseCalls, "no cleanup path closes the potential user document");
            FamilyJobResult firstAfter = registry.Get(firstHandle, binding), secondAfter = registry.Get(secondHandle, binding);
            True(firstAfter.Job.ResourceRetained && !secondAfter.Job.ResourceRetained, "batch cleanup does not duplicate or drop the unique reference");
            Stage(firstAfter, "CleanupPending", "original conflict stays pending"); Stage(secondAfter, "CleanupPending", "linked conflict stays pending");
            NotOk(registry.Prepare(binding), "both unresolved jobs continue to consume their capacity reservations");
            Equal(2, factory.Calls, "conflict handling does not replay either factory");
        }

        private static void LateFactoryCloseIntent()
        {
            FamilyJobRegistry registry = null; FamilyJobBinding binding = Binding(); string handle = null; FakeResource resource = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                FamilyJobResult intent = registry.RequestClose(handle, binding); Stage(intent, "Creating", "close during factory only records intent");
                True(intent.Job.CloseRequested, "intent survives while creation is unresolved");
                resource = new FakeResource(c); return c.CreatedTemporary(resource);
            });
            registry = Registry(factory); handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
            FamilyJobResult late = registry.Create(handle, binding); Stage(late, "Closed", "late owned result is closed before final completion");
            True(!late.Job.Owned, "late temporary resource is not leaked"); Equal(1, resource.CloseCalls, "late result closed exactly once");
            Equal(1, factory.Calls, "cancel intent never replays factory");
        }

        private static void CrossThreadLateFactoryCloseIntent()
        {
            ManualResetEvent factoryEntered = new ManualResetEvent(false), releaseFactory = new ManualResetEvent(false), closeReturned = new ManualResetEvent(false);
            FamilyJobRegistry registry = null; FamilyJobBinding binding = Binding(); FakeResource resource = null;
            FamilyJobResult created = null, intent = null; Exception createError = null, closeError = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                factoryEntered.Set();
                if (!releaseFactory.WaitOne(5000)) throw new Exception("Test factory release barrier timed out");
                resource = new FakeResource(c); return c.CreatedTemporary(resource);
            });
            registry = Registry(factory); string handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
            Thread creator = new Thread(delegate() { try { created = registry.Create(handle, binding); } catch (Exception e) { createError = e; } });
            Thread closer = new Thread(delegate() { try { intent = registry.RequestClose(handle, binding); } catch (Exception e) { closeError = e; } finally { closeReturned.Set(); } });
            creator.IsBackground = true; closer.IsBackground = true;
            bool entered = false, deferredBeforeRelease = false, creatorFinished = false, closerFinished = false;
            try {
                creator.Start(); entered = factoryEntered.WaitOne(5000);
                if (entered) { closer.Start(); deferredBeforeRelease = closeReturned.WaitOne(5000); }
            }
            finally {
                releaseFactory.Set(); creatorFinished = creator.Join(5000);
                if (entered) closerFinished = closer.Join(5000);
                factoryEntered.Close(); releaseFactory.Close(); closeReturned.Close();
            }
            True(entered && creatorFinished && closerFinished, "both external calls finish within bounded barriers");
            True(deferredBeforeRelease, "close intent returns while the factory is still blocked outside registry locks");
            True(createError == null && closeError == null, "no public call leaked an exception across the thread boundary");
            Stage(intent, "Creating", "concurrent close records a creation-stage intent"); True(intent.Job.CloseRequested, "concurrent intent is retained");
            Stage(created, "Closed", "late factory result is cleaned before completion");
            True(!created.Job.Owned, "no late resource remains owned after confirmed cleanup");
            Equal(1, resource.CloseCalls, "cross-thread cancellation closes exactly once"); Equal(1, factory.Calls, "no creation replay");
        }

        private static void DeferredCloseKnownNoResource()
        {
            foreach (bool existingUser in new bool[] { false, true })
            {
                FamilyJobRegistry registry = null; FamilyJobBinding binding = Binding(); string handle = null; FakeResource user = null;
                DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                    FamilyJobResult intent = registry.RequestClose(handle, binding);
                    Stage(intent, "Creating", "close intent is accepted before definitive no-resource factory return");
                    True(intent.Job.CloseRequested, "deferred close intent is recorded");
                    if (!existingUser) return c.NotCreated();
                    user = new FakeResource(c); return c.ExistingUserDocument(user);
                });
                registry = Registry(factory); handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
                FamilyJobResult result = registry.Create(handle, binding);
                Stage(result, "Closed", "a definitive nonowned result fulfills deferred close without another request");
                True(!result.Job.Owned, "no user or nonexistent document is adopted");
                if (user != null) Equal(0, user.CloseCalls, "fulfilling a deferred intent never closes a user document");
                Equal(1, factory.Calls, "no second creation is used to finish the job");
            }
        }

        private static void CleanupReentryBusy()
        {
            FamilyJobRegistry registry = null; FamilyJobBinding binding = Binding(); string handle = null; FakeResource resource = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                resource = new FakeResource(c); resource.CloseHandler = delegate {
                    FamilyJobResult again = registry.RequestClose(handle, binding); NotOk(again, "recursive close is refused"); True(again.Code.Contains("BUSY"), "recursive close reports busy");
                    FamilyCleanupResult nested = registry.CleanupAll(); True(!nested.Ok && nested.Code.Contains("BUSY"), "cleanup cannot recursively enumerate owned resources");
                    FamilyJobResult prepared = registry.Prepare(binding); NotOk(prepared, "cleanup cannot mutate the registry by preparation"); True(prepared.Code.Contains("BUSY"), "preparation reports busy during cleanup");
                    return FamilyCloseOutcome.ConfirmedClosed;
                }; return c.CreatedTemporary(resource);
            });
            registry = Registry(factory); handle = Ok(registry.Prepare(binding), "prepare").Job.Handle; Ok(registry.Create(handle, binding), "create");
            Stage(registry.RequestClose(handle, binding), "Closed", "outer close completes");
            Equal(1, resource.CloseCalls, "no recursive close reached the resource"); Equal(1, factory.Calls, "no nested factory executed");
        }

        private static void MixedCleanupContinues()
        {
            List<FakeResource> resources = new List<FakeResource>();
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                int index = resources.Count; FakeResource resource = new FakeResource(c); resources.Add(resource);
                resource.CloseHandler = delegate {
                    if (resource.CloseCalls > 1 || index == 0) return FamilyCloseOutcome.ConfirmedClosed;
                    if (index == 1) return FamilyCloseOutcome.NotClosed;
                    if (index == 2) return FamilyCloseOutcome.Unknown;
                    throw new Exception("Synthetic mixed close failure");
                }; return c.CreatedTemporary(resource);
            });
            FamilyJobRegistry registry = Registry(factory); FamilyJobBinding binding = Binding(); List<string> handles = new List<string>();
            for (int index = 0; index < 4; index++) { string handle = Ok(registry.Prepare(binding), "prepare batch").Job.Handle; handles.Add(handle); Ok(registry.Create(handle, binding), "create batch"); }
            FamilyCleanupResult first = registry.CleanupAll(); True(!first.Ok, "mixed outcomes cannot claim all cleanup complete");
            True(first.Items != null && first.Items.Count >= 4, "summary preserves each attempted job outcome");
            foreach (FakeResource resource in resources) Equal(1, resource.CloseCalls, "one failure does not skip other owned resources");
            Stage(registry.Get(handles[0], binding), "Closed", "successful close is terminal");
            for (int index = 1; index < 4; index++) True(registry.Get(handles[index], binding).Job.Owned, "each failed resource remains independently owned");
            True(registry.CleanupAll().Ok, "explicit cleanup retry processes retained failures");
            Equal(1, resources[0].CloseCalls, "confirmed closed resource is never closed twice");
            for (int index = 1; index < 4; index++) Equal(2, resources[index].CloseCalls, "only failed exact resources retry");
            True(registry.CleanupAll().Ok, "terminal cleanup is idempotent");
            for (int index = 1; index < 4; index++) Equal(2, resources[index].CloseCalls, "terminal retry does not repeat document calls");
        }

        private static void ReceiptBeforeThrow()
        {
            FakeResource resource = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                resource = new FakeResource(c); c.CreatedTemporary(resource); throw new Exception("Synthetic factory failed after delivering its resource");
            });
            FamilyJobRegistry registry = Registry(factory); FamilyJobBinding binding = Binding(); string handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
            FamilyJobResult result = registry.Create(handle, binding); NotOk(result, "factory throw cannot become success");
            True(result.Job.Owned, "delivered proof is retained even if the factory throws later"); Equal(0, resource.CloseCalls, "retained resource awaits explicit cleanup");
            Stage(registry.RequestClose(handle, binding), "Closed", "delivered owner can still be cleaned"); Equal(1, resource.CloseCalls, "exact proof resource was closed");
        }

        private static void ReceiptBeforeUnknown()
        {
            FakeResource resource = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) {
                resource = new FakeResource(c); c.CreatedTemporary(resource); return c.Unknown();
            });
            FamilyJobRegistry registry = Registry(factory); FamilyJobBinding binding = Binding(); string handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
            FamilyJobResult result = registry.Create(handle, binding); NotOk(result, "unknown final outcome is not successful creation");
            True(result.Job.Owned, "issued temporary proof survives unknown factory outcome");
            Stage(registry.RequestClose(handle, binding), "Closed", "unknown validity does not prevent owned cleanup"); Equal(1, resource.CloseCalls, "one exact cleanup");
        }

        private static void UndeliveredUnknown(bool throws)
        {
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) { if (throws) throw new Exception("Synthetic factory outcome unknown"); return c.Unknown(); });
            FamilyJobRegistry registry = Registry(factory, 1); FamilyJobBinding binding = Binding(); string handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
            FamilyJobResult result = registry.Create(handle, binding); NotOk(result, "unknown creation has no success proof"); Stage(result, "OutcomeUnknown", "undelivered outcome remains explicitly unknown");
            True(!result.Job.Owned, "no resource was delivered to authorize document cleanup");
            NotOk(registry.Create(handle, binding), "unknown creation must not replay"); Equal(1, factory.Calls, "factory never automatically re-executes");
            FamilyJobResult closing = registry.RequestClose(handle, binding);
            True(closing.Job != null && closing.Job.Stage.ToString() != "Closed", "cleanup must not pretend unknown creation had no effects");
            True(!registry.CleanupAll().Ok, "cleanup summary remains incomplete for an unresolved creation");
            NotOk(registry.Prepare(binding), "unresolved outcome retains its bounded capacity reservation");
        }

        private static void ForeignReceipt()
        {
            FamilyCreationOutcome issued = null; FakeResource resource = null;
            DelegateFactory ownerFactory = new DelegateFactory(delegate(FamilyCreationContext c) { resource = new FakeResource(c); issued = c.CreatedTemporary(resource); return issued; });
            FamilyJobBinding binding = Binding(); FamilyJobRegistry owner = Registry(ownerFactory);
            string ownHandle = Ok(owner.Prepare(binding), "prepare owner").Job.Handle; Ok(owner.Create(ownHandle, binding), "create owner");
            DelegateFactory foreignFactory = new DelegateFactory(delegate(FamilyCreationContext c) { return issued; });
            FamilyJobRegistry foreign = Registry(foreignFactory); string foreignHandle = Ok(foreign.Prepare(binding), "prepare foreign").Job.Handle;
            FamilyJobResult rejected = foreign.Create(foreignHandle, binding); NotOk(rejected, "a receipt issued by a different factory context cannot establish ownership");
            True(rejected.Job != null && !rejected.Job.Owned, "foreign context did not adopt the original document");
            foreign.RequestClose(foreignHandle, binding); foreign.CleanupAll(); Equal(0, resource.CloseCalls, "foreign registry never closes the owner's resource");
            owner.RequestClose(ownHandle, binding); Equal(1, resource.CloseCalls, "only the original proof owner closes it");
        }

        private static void CapacityAndKnownNoResource()
        {
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) { return c.NotCreated(); });
            FamilyJobRegistry registry = Registry(factory, 2); FamilyJobBinding binding = Binding();
            string first = Ok(registry.Prepare(binding), "first reservation").Job.Handle;
            string second = Ok(registry.Prepare(binding), "second reservation").Job.Handle;
            NotOk(registry.Prepare(binding), "capacity includes prepared jobs before resources exist"); Equal(0, factory.Calls, "capacity denial performs no creation");
            Stage(registry.RequestClose(first, binding), "Closed", "a merely prepared reservation has no creation side effects");
            Ok(registry.Prepare(binding), "confirmed terminal slot may be reused");
            FamilyJobResult noResource = registry.Create(second, binding); True(!noResource.Job.Owned, "explicit NotCreated has no resource owner");
            Stage(registry.RequestClose(second, binding), "Closed", "known noncreation can terminate honestly");
            Ok(registry.Prepare(binding), "known noncreation releases capacity"); Equal(1, factory.Calls, "one explicit factory attempt");
        }

        private static void TerminalIdempotence()
        {
            FakeResource resource = null;
            DelegateFactory factory = new DelegateFactory(delegate(FamilyCreationContext c) { resource = new FakeResource(c); return c.CreatedTemporary(resource); });
            FamilyJobRegistry registry = Registry(factory); FamilyJobBinding binding = Binding(); string handle = Ok(registry.Prepare(binding), "prepare").Job.Handle;
            Ok(registry.Create(handle, binding), "create");
            Stage(registry.RequestClose(handle, binding), "Closed", "first close");
            Stage(registry.RequestClose(handle, binding), "Closed", "repeated explicit close returns terminal fact");
            NotOk(registry.Create(handle, binding), "terminal job cannot be replayed");
            True(registry.CleanupAll().Ok, "terminal all-cleanup remains complete");
            Equal(1, resource.CloseCalls, "document close never repeats after confirmation"); Equal(1, factory.Calls, "creation never repeats after terminal state");
        }

        public static int Main()
        {
            Console.WriteLine("TAP version 13");
            Run("configuration rejects invalid identity and capacity without creating resources", Configuration);
            Run("prepare is bound to the exact host session and process", HostBinding);
            Run("every handle operation requires exact project instance fingerprint and template binding", AllBindingFields);
            Run("unissued and other-registry handles cannot select or mutate jobs", OpaqueHandles);
            Run("owned temporary creation inspection and confirmed cleanup produce observable facts", HappyOwnedLifecycle);
            Run("existing user documents are never closed by explicit or batch cleanup", UserDocumentNeverClosed);
            Run("owned invalid or unknown family validity still permits exact-resource cleanup", InvalidOwnedFactsStillCleanable);
            Run("inspection exceptions preserve ownership and do not block cleanup", InspectThrowStillOwned);
            Run("mismatched readiness facts do not erase the issued resource owner", MismatchedFactsStillOwned);
            Run("NotClosed retains owner until an explicit successful retry", delegate { CloseRetry(FamilyCloseOutcome.NotClosed, false); });
            Run("Unknown close retains owner until an explicit successful retry", delegate { CloseRetry(FamilyCloseOutcome.Unknown, false); });
            Run("throwing close retains owner until an explicit successful retry", delegate { CloseRetry(FamilyCloseOutcome.Unknown, true); });
            Run("Closing and cleanup-pending revoke readiness while preserving captured inspection history", ClosingRevokesReadiness);
            Run("conflicting same-resource user and temporary claims retain evidence and never close the potential user document", ConflictingUserAndTemporaryClaims);
            Run("cross-job conflict propagates to the unique reference owner and deferred linked cleanup cannot fake closure", SharedResourceConflictHasOneRetainingJob);
            Run("close intent during creation cleans its late owned factory result", LateFactoryCloseIntent);
            Run("cross-thread close intent returns before a blocked factory delivers its late resource", CrossThreadLateFactoryCloseIntent);
            Run("deferred close completes definitive noncreation or user-document outcomes without closing a user document", DeferredCloseKnownNoResource);
            Run("cleanup rejects recursive close cleanup and preparation without duplicate resource calls", CleanupReentryBusy);
            Run("mixed cleanup processes every resource and retries only retained failures", MixedCleanupContinues);
            Run("a delivered temporary receipt survives a subsequent factory throw", ReceiptBeforeThrow);
            Run("a delivered temporary receipt survives an unknown final factory result", ReceiptBeforeUnknown);
            Run("undelivered Unknown creation cannot replay fake closure or release capacity", delegate { UndeliveredUnknown(false); });
            Run("undelivered throwing creation cannot replay or masquerade as cleanup success", delegate { UndeliveredUnknown(true); });
            Run("foreign creation receipts cannot authorize cleanup of another context's document", ForeignReceipt);
            Run("capacity counts reservations and reuses only confirmed terminal slots", CapacityAndKnownNoResource);
            Run("confirmed terminal close and cleanup are idempotent and never recreate", TerminalIdempotence);
            Console.WriteLine("1.." + total);
            Console.WriteLine("# tests " + total);
            Console.WriteLine("# pass " + passed);
            Console.WriteLine("# fail " + (total - passed));
            Console.WriteLine("# skipped 0");
            return total == passed ? 0 : 1;
        }
    }
}
