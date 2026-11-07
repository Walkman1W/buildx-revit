using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;

namespace RevitLocalCodex
{
    // This local queue is an application integration boundary, not a security sandbox.
    internal sealed class WorkbenchHost : IDisposable, IExternalEventHandler
    {
        private const string HostVersion = "0.8.9";
        private static readonly string[] NativeBasicWriteOperations = { "set_element_material", "create_material", "create_roof", "create_level", "create_grid", "pin_element", "unpin_element", "create_floor_plan_view", "create_3d_view", "create_section_view", "create_room", "create_column", "create_foundation", "create_beam", "create_schedule", "create_group", "populate_titleblock", "mirror_element", "ungroup", "change_element_type", "replace_family_type", "create_conduit", "create_duct", "create_sheet", "renumber_sheets", "duplicate_sheet", "place_viewport_on_sheet", "apply_view_template", "place_window", "create_text_note" };
        internal static readonly string Root = Path.GetFullPath(LocalService.WorkbenchDirectory);
        internal static readonly string PrivateRuntimeRoot = Path.GetFullPath(Path.Combine(LocalService.ServiceDirectory, "private-runtime"));
        private readonly string queue = Path.Combine(Root, "queue");
        private readonly string session = Guid.NewGuid().ToString("N");
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 40 };
        private readonly object schedulingGate = new object();
        // Borrow the existing pane's UI dispatcher. Only this host's queued
        // operation is owned here; the dispatcher itself is never shut down.
        private readonly Dispatcher uiDispatcher;
        private readonly CurrentUiWindowWake activeWindowWake = new CurrentUiWindowWake();
        private DispatcherOperation pendingWakeOperation;
        private SchedulerObservation pendingWakeObservation;
        private FileStream ownerLock;
        private ExternalEvent externalEvent;
        private Timer queueTimer;
        private DateTime nextRaise = DateTime.MinValue;
        private int retryDelayMilliseconds = 500;
        private bool eventPending;
        // At most one scheduler observation belongs to this outstanding event.
        // Execute prefers this accepted id. If it was removed or already claimed,
        // any replacement keeps its own identity and cannot borrow this timing.
        private SchedulerObservation pendingObservation;
        private bool disposed;
        private bool busy;
        private readonly object hostDescriptorGate = new object();
        private readonly DateTime hostStartedUtc = DateTime.UtcNow;
        private UIControlledApplication controlledApplication;
        // One owner per host session; family documents never enter the project script group.
        private BuildX.FamilyRevit.RevitFamilyWorkflow familyWorkflow;
        private TypeParameterWriteApproval typeParameterApprovals;
        private bool familyObserverInitializationAttempted;
        private VisualInspection visualInspection;
        private static readonly string[] FamilyOperations = { "family_templates", "family_create_valve", "family_create_cabinet", "family_inspect_job", "family_save_job", "family_save_cabinet", "family_load_job", "family_close_job", "family_close_cabinet" };
        private static readonly string[] AtomicReadOperations = { "status", "get_selection", "list_levels", "search_elements", "list_family_types", "describe_parameters", "capture_model_snapshot", "health", "get_document_info", "list_views", "get_element_parameters", "get_elements_by_type", "get_element_geometry", "get_model_preparation", "get_type_parameters", "get_parameter_value", "get_type_parameter_impact", "list_sheets", "get_sheet_info", "list_titleblocks", "get_categories", "get_worksets", "get_phases", "get_phase_filters", "get_design_options", "list_shared_parameters", "list_project_parameters", "get_warnings", "get_rvt_links", "get_link_instances", "get_pipe_network", "get_revision_sequences", "get_schedule_data", "get_group_members", "calculate_material_quantities", "check_clashes" };

        internal string SessionId { get { return session; } }

        // Capture the API thread and Revit's main window during a legal API
        // callback. Revalidate the target on that thread before posting.
        private sealed class CurrentUiWindowWake
        {
            internal struct WindowOwner
            {
                internal readonly uint ThreadId;
                internal readonly uint ProcessId;
                internal WindowOwner(uint threadId, uint processId) { ThreadId = threadId; ProcessId = processId; }
            }

            private readonly Func<Thread> currentThread;
            private readonly Func<uint> currentNativeId;
            private readonly Func<uint> currentProcessId;
            private readonly Func<IntPtr> activeWindow;
            private readonly Func<IntPtr, bool> isWindow;
            private readonly Func<IntPtr, bool> isWindowEnabled;
            private readonly Func<IntPtr, bool> isIconic;
            private readonly Func<IntPtr, WindowOwner> windowOwner;
            private readonly Func<IntPtr, bool> postMessage;
            private Thread apiThread;
            private uint apiNativeId;
            private IntPtr mainWindow;

            internal CurrentUiWindowWake()
                : this(delegate { return Thread.CurrentThread; }, GetCurrentThreadId,
                    GetCurrentProcessId, GetActiveWindow, IsWindow, IsWindowEnabled, IsIconic, ReadWindowOwner,
                    delegate(IntPtr window) { return PostMessage(window, 0, IntPtr.Zero, IntPtr.Zero); }) { }

            internal CurrentUiWindowWake(Func<Thread> managedThread, Func<uint> nativeId,
                Func<uint> processId, Func<IntPtr> active, Func<IntPtr, bool> valid,
                Func<IntPtr, bool> enabled, Func<IntPtr, bool> iconic, Func<IntPtr, WindowOwner> owner,
                Func<IntPtr, bool> post)
            {
                currentThread = managedThread; currentNativeId = nativeId; currentProcessId = processId;
                activeWindow = active; isWindow = valid; isWindowEnabled = enabled; isIconic = iconic;
                windowOwner = owner; postMessage = post;
            }

            internal void Capture(IntPtr revitMainWindow)
            {
                Clear();
                Thread thread = currentThread();
                uint nativeId = currentNativeId();
                if (thread != null && nativeId != 0)
                {
                    apiThread = thread;
                    apiNativeId = nativeId;
                    mainWindow = revitMainWindow;
                }
            }

            internal void Clear() { apiThread = null; apiNativeId = 0; mainWindow = IntPtr.Zero; }

            internal string TryPost(out bool attempted)
            {
                attempted = false;
                try
                {
                    if (apiThread == null || !Object.ReferenceEquals(apiThread, currentThread())
                        || apiNativeId == 0 || apiNativeId != currentNativeId()) return "target_unverified";
                    IntPtr window = activeWindow();
                    if (window == IntPtr.Zero) return TryPostMainWindow(out attempted);
                    if (!isWindow(window)) return "active_window_invalid";
                    if (!IsOwnedByApiThread(window)) return "active_window_unverified";
                    if (activeWindow() != window) return "active_window_changed";
                    attempted = true;
                    // This is the current active window of this same UI thread.
                    // No focus change, user input or Revit API call is performed.
                    // Enqueue success establishes neither idle nor API execution.
                    return postMessage(window) ? "posted" : "post_failed";
                }
                catch (Exception error) { return "error_" + error.GetType().Name; }
            }

            private bool IsOwnedByApiThread(IntPtr window)
            {
                WindowOwner owner = windowOwner(window);
                return owner.ThreadId == apiNativeId && owner.ProcessId != 0 && owner.ProcessId == currentProcessId();
            }

            private string TryPostMainWindow(out bool attempted)
            {
                attempted = false;
                IntPtr window = mainWindow;
                if (window == IntPtr.Zero) return "no_active_window";
                if (!isWindow(window)) return "main_window_invalid";
                if (!IsOwnedByApiThread(window)) return "main_window_unverified";
                if (!isWindowEnabled(window)) return "main_window_disabled";
                if (isIconic(window)) return "main_window_minimized";
                if (activeWindow() != IntPtr.Zero) return "main_window_skipped_active";
                // The background fallback posts the same no-input message once.
                attempted = true;
                return postMessage(window) ? "main_window_posted" : "main_window_post_failed";
            }

            [DllImport("kernel32.dll", ExactSpelling = true)]
            private static extern uint GetCurrentThreadId();
            [DllImport("kernel32.dll", ExactSpelling = true)]
            private static extern uint GetCurrentProcessId();
            [DllImport("user32.dll", ExactSpelling = true)]
            private static extern IntPtr GetActiveWindow();
            [DllImport("user32.dll", ExactSpelling = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            private static extern bool IsWindow(IntPtr window);
            [DllImport("user32.dll", ExactSpelling = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            private static extern bool IsWindowEnabled(IntPtr window);
            [DllImport("user32.dll", ExactSpelling = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            private static extern bool IsIconic(IntPtr window);
            [DllImport("user32.dll", ExactSpelling = true)]
            private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
            private static WindowOwner ReadWindowOwner(IntPtr window)
            {
                uint processId;
                uint threadId = GetWindowThreadProcessId(window, out processId);
                return new WindowOwner(threadId, processId);
            }
            [DllImport("user32.dll", EntryPoint = "PostMessageW", ExactSpelling = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        }

        private void CaptureApiThread(UIApplication uiapp)
        {
            if (uiapp == null) return;
            lock (schedulingGate)
            {
                if (disposed) return;
                IntPtr mainWindow = IntPtr.Zero;
                try { mainWindow = uiapp.MainWindowHandle; }
                catch { /* The existing active-window path remains available. */ }
                try { activeWindowWake.Capture(mainWindow); }
                catch { activeWindowWake.Clear(); }
            }
        }

        private sealed class SchedulerObservation
        {
            internal readonly string RequestId;
            internal readonly DateTime ObservedUtc;
            internal readonly long ObservedTicks;
            internal readonly DateTime RaiseReturnedUtc;
            internal readonly long RaiseReturnedTicks;
            internal readonly string RaiseResult;
            // The bounded fast-idle interval belongs to this accepted event
            // and begins only when Revit actually enters an eligible UI idle.
            internal long? UiIdleStartedTicks;
            // Only Idling callbacks entered after this accepted observation
            // existed count here. The callback that first calls Raise does not.
            internal int UiIdleAfterRaiseCount;
            internal DateTime? UiIdleFirstEnteredUtc;
            internal long UiIdleFirstEnteredTicks;
            internal DateTime? UiIdleLastEnteredUtc;
            internal long UiIdleLastEnteredTicks;
            internal int UiFastIdleRequestCount;
            internal bool UiWakeAttempted;
            internal DateTime? UiWakePostedUtc;
            internal long UiWakePostedTicks;
            internal DateTime? UiWakeEnteredUtc;
            internal long UiWakeEnteredTicks;
            internal string UiWakeState = "not_posted";
            internal string UiWakeDiagnostic;
            internal string UiWakeCleanup;
            internal bool ActiveWindowMessageHandled;
            internal bool ActiveWindowMessageAttempted;
            internal string ActiveWindowMessageState = "not_attempted";
            internal SchedulerObservation(string requestId, DateTime observedUtc, long observedTicks, DateTime raiseReturnedUtc, string raiseResult)
            {
                RequestId = requestId; ObservedUtc = observedUtc; ObservedTicks = observedTicks;
                RaiseReturnedUtc = raiseReturnedUtc; RaiseResult = raiseResult;
                // Constructed under schedulingGate after Raise returns. An idle
                // entry sampled before a concurrent Raise must not be counted.
                RaiseReturnedTicks = Stopwatch.GetTimestamp();
            }
        }

        private static double ElapsedMilliseconds(long start, long end)
        {
            return (end - start) * 1000.0 / Stopwatch.Frequency;
        }

        private object ReceiptTiming(string id, SchedulerObservation observation, DateTime executeEnteredUtc, long executeEnteredTicks,
            DateTime claimedUtc, long claimedTicks, DateTime? dispatchStartedUtc, long validationFinishedTicks,
            DateTime? dispatchFinishedUtc, long dispatchStartedTicks, long dispatchFinishedTicks)
        {
            // All elapsed values use this host's monotonic clock. UTC points are
            // correlation facts, not a duration across independent process clocks.
            bool matched = observation != null && string.Equals(observation.RequestId, id, StringComparison.Ordinal);
            DateTime responsePreparedUtc = DateTime.UtcNow;
            long responsePreparedTicks = Stopwatch.GetTimestamp();
            return new {
                schemaVersion = 1, requestId = id, hostSession = session,
                observedUtc = matched ? observation.ObservedUtc.ToString("o") : null,
                raiseReturnedUtc = matched ? observation.RaiseReturnedUtc.ToString("o") : null,
                executeEnteredUtc = executeEnteredUtc.ToString("o"), claimedUtc = claimedUtc.ToString("o"),
                dispatchStartedUtc = dispatchStartedUtc.HasValue ? dispatchStartedUtc.Value.ToString("o") : null,
                dispatchFinishedUtc = dispatchFinishedUtc.HasValue ? dispatchFinishedUtc.Value.ToString("o") : null,
                // This ends before outbox serialization/publication. It does not
                // claim that the response was written or received by the caller.
                responsePreparedUtc = responsePreparedUtc.ToString("o"),
                observedToExecuteMs = matched ? (double?)ElapsedMilliseconds(observation.ObservedTicks, executeEnteredTicks) : null,
                validationMs = ElapsedMilliseconds(claimedTicks, validationFinishedTicks),
                dispatchMs = dispatchStartedUtc.HasValue ? (double?)ElapsedMilliseconds(dispatchStartedTicks, dispatchFinishedTicks) : null,
                hostWorkMs = ElapsedMilliseconds(claimedTicks, responsePreparedTicks),
                schedulerCorrelation = matched ? "matched" : "unmatched", raiseResult = matched ? observation.RaiseResult : null,
                uiIdle = matched ? new {
                    afterRaiseCount = observation.UiIdleAfterRaiseCount,
                    firstEnteredUtc = observation.UiIdleFirstEnteredUtc.HasValue ? observation.UiIdleFirstEnteredUtc.Value.ToString("o") : null,
                    lastEnteredUtc = observation.UiIdleLastEnteredUtc.HasValue ? observation.UiIdleLastEnteredUtc.Value.ToString("o") : null,
                    observedToFirstMs = observation.UiIdleFirstEnteredUtc.HasValue ? (double?)ElapsedMilliseconds(observation.ObservedTicks, observation.UiIdleFirstEnteredTicks) : null,
                    firstToExecuteMs = observation.UiIdleFirstEnteredUtc.HasValue ? (double?)ElapsedMilliseconds(observation.UiIdleFirstEnteredTicks, executeEnteredTicks) : null,
                    lastToExecuteMs = observation.UiIdleLastEnteredUtc.HasValue ? (double?)ElapsedMilliseconds(observation.UiIdleLastEnteredTicks, executeEnteredTicks) : null,
                    // Includes a fast-idle request by the callback that raised
                    // the event, even though that entry is not an after-Raise idle.
                    fastRequestCount = observation.UiFastIdleRequestCount,
                    countsSaturated = observation.UiIdleAfterRaiseCount == int.MaxValue || observation.UiFastIdleRequestCount == int.MaxValue
                } : null,
                uiWake = matched ? new {
                    attempted = observation.UiWakeAttempted,
                    postedUtc = observation.UiWakePostedUtc.HasValue ? observation.UiWakePostedUtc.Value.ToString("o") : null,
                    enteredUtc = observation.UiWakeEnteredUtc.HasValue ? observation.UiWakeEnteredUtc.Value.ToString("o") : null,
                    postToEnteredMs = observation.UiWakeEnteredUtc.HasValue ? (double?)ElapsedMilliseconds(observation.UiWakePostedTicks, observation.UiWakeEnteredTicks) : null,
                    enteredToExecuteMs = observation.UiWakeEnteredUtc.HasValue ? (double?)ElapsedMilliseconds(observation.UiWakeEnteredTicks, executeEnteredTicks) : null,
                    state = observation.UiWakeState, diagnostic = observation.UiWakeDiagnostic, cleanup = observation.UiWakeCleanup,
                    activeWindowMessage = new { kind = "WM_NULL", attempted = observation.ActiveWindowMessageAttempted, state = observation.ActiveWindowMessageState }
                } : null
            };
        }

        internal WorkbenchHost(UIControlledApplication application, Dispatcher dispatcher)
        {
            if (dispatcher == null) throw new ArgumentNullException("dispatcher");
            uiDispatcher = dispatcher;
            Directory.CreateDirectory(queue);
            foreach (string child in new[] { "inbox", "processing", "outbox" }) Directory.CreateDirectory(Path.Combine(queue, child));
            try
            {
                ownerLock = new FileStream(Path.Combine(queue, "owner.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                // Constructed from IExternalApplication.OnStartup, in a Revit API context.
                externalEvent = ExternalEvent.Create(this);
                queueTimer = new Timer(PollQueue, null, Timeout.Infinite, Timeout.Infinite);
                AppDomain.CurrentDomain.AssemblyResolve += ResolvePrivateDependency;
                controlledApplication = application;
                controlledApplication.Idling += OnQueueIdling;
                PublishFamilyApprovalCapability(false);
                queueTimer.Change(250, 500);
            }
            catch { Dispose(); throw; }
        }

        private void PublishFamilyApprovalCapability(bool ready)
        {
            lock (hostDescriptorGate)
            {
                if (disposed && ready) throw new InvalidOperationException("Workbench host is stopping.");
                WriteAtomic(Path.Combine(queue, "host.json"), new { sessionId = session, pid = Process.GetCurrentProcess().Id,
                    startedUtc = hostStartedUtc.ToString("o"), version = HostVersion, dispatcher = "ExternalEvent", atomicReadSnapshot = true,
                    nativeModelQueriesVersion = 1, nativeModelQueryOperations = new[] { "health", "get_document_info", "list_views", "get_element_parameters", "get_elements_by_type", "get_element_geometry", "get_model_preparation", "get_pipe_network", "get_revision_sequences", "get_schedule_data" }.Concat(AecPilotQueries.Operations).ToArray(),
                    nativeParameterQueriesVersion = 1, nativeParameterQueryOperations = new[] { "get_type_parameters", "get_parameter_value", "get_type_parameter_impact" },
                    nativeParameterWritesVersion = 1, nativeParameterWriteOperations = new[] { "set_parameter_value" },
                    nativeTypeParameterWritesVersion = 1, nativeTypeParameterWriteOperations = new[] { "set_type_parameter" },
                    nativeSelectionWritesVersion = 1, nativeSelectionWriteOperations = new[] { "set_selection", "select_by_unique_ids" },
                    nativeBasicWritesVersion = 1, nativeBasicWriteOperations = NativeBasicWriteOperations,
                    parameterWriteTargetPolicyVersion = 1, parameterWriteTargetPolicy = "instance_only",
                    familyCabinetContractVersion = 1, familyLifecycleApprovalVersion = ready ? 1 : 0, visualInspectionVersion = 1, accessPolicyVersion = 1 });
            }
        }

        private void InitializeFamilyApprovalObserver(UIApplication uiapp)
        {
            if (disposed || uiapp == null || familyObserverInitializationAttempted) return;
            familyObserverInitializationAttempted = true;
            try
            {
                if (familyWorkflow == null) familyWorkflow = new BuildX.FamilyRevit.RevitFamilyWorkflow(session, Process.GetCurrentProcess().Id, Root, PublishFamilyApprovalCapability);
                familyWorkflow.InitializeApprovalObserver(uiapp);
            }
            catch { /* Status remains unavailable; native approval stays fail-closed. */ }
        }

        // Revit's default low-frequency idle mode can leave an accepted external
        // event waiting for unrelated input. Keep only an outstanding event's
        // short wake-up window active; an empty queue never requests fast idling.
        // Revit API access stays on this UI callback, never in the timer thread.
        private void OnQueueIdling(object sender, IdlingEventArgs args)
        {
            CaptureApiThread(sender as UIApplication);
            InitializeFamilyApprovalObserver(sender as UIApplication);
            long enteredTicks = Stopwatch.GetTimestamp();
            DateTime enteredUtc = DateTime.UtcNow;
            lock (schedulingGate)
            {
                SchedulerObservation observation = pendingObservation;
                if (!disposed && !busy && eventPending && observation != null && observation.RaiseReturnedTicks < enteredTicks)
                {
                    if (observation.UiIdleAfterRaiseCount < int.MaxValue) observation.UiIdleAfterRaiseCount++;
                    if (!observation.UiIdleFirstEnteredUtc.HasValue)
                    {
                        observation.UiIdleFirstEnteredUtc = enteredUtc;
                        observation.UiIdleFirstEnteredTicks = enteredTicks;
                    }
                    observation.UiIdleLastEnteredUtc = enteredUtc;
                    observation.UiIdleLastEnteredTicks = enteredTicks;
                }
            }
            PollQueue(null);
            lock (schedulingGate)
            {
                if (!disposed && !busy && eventPending && pendingObservation != null)
                {
                    long now = Stopwatch.GetTimestamp();
                    if (!pendingObservation.UiIdleStartedTicks.HasValue)
                        pendingObservation.UiIdleStartedTicks = now;
                    if (ElapsedMilliseconds(pendingObservation.UiIdleStartedTicks.Value, now) < 1500)
                    {
                        args.SetRaiseWithoutDelay();
                        if (pendingObservation.UiFastIdleRequestCount < int.MaxValue) pendingObservation.UiFastIdleRequestCount++;
                    }
                }
            }
        }

        private Assembly ResolvePrivateDependency(object sender, ResolveEventArgs args)
        {
            string name = new AssemblyName(args.Name).Name;
            bool ownsRequest = name == "ArgusLearning.Core" || (args.RequestingAssembly != null && args.RequestingAssembly.GetName().Name == "ArgusLearning.Core");
            if (!ownsRequest || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return null;
            string file = Path.Combine(PrivateRuntimeRoot, "argus", "2024", name + ".dll");
            if (!File.Exists(file)) return null;
            AssemblyName actual = AssemblyName.GetAssemblyName(file);
            // Do not redirect other addins or substitute incompatible assembly identities.
            if (!string.Equals(actual.FullName, new AssemblyName(args.Name).FullName, StringComparison.OrdinalIgnoreCase)) return null;
            return Assembly.LoadFrom(file);
        }

        // Timer threads only examine local queue paths and signal the external event.
        // They never inspect UIApplication, documents, views, elements or transactions.
        private void PollQueue(object state)
        {
            if (!Monitor.TryEnter(schedulingGate)) return;
            try
            {
                if (disposed || busy || eventPending || DateTime.UtcNow < nextRaise) return;
                string observedFile = NextRequest();
                if (observedFile == null) return;
                DateTime observedUtc = DateTime.UtcNow;
                long observedTicks = Stopwatch.GetTimestamp();
                ExternalEventRequest result = externalEvent.Raise();
                if (result == ExternalEventRequest.Accepted || result == ExternalEventRequest.Pending)
                {
                    pendingObservation = new SchedulerObservation(Path.GetFileNameWithoutExtension(observedFile), observedUtc, observedTicks, DateTime.UtcNow, result.ToString());
                    eventPending = true;
                    retryDelayMilliseconds = 500;
                    QueueUiWake(pendingObservation);
                }
                else
                {
                    BackOff();
                    RecordSchedulerFailure("ExternalEvent.Raise: " + result);
                }
            }
            catch (Exception error)
            {
                BackOff();
                RecordSchedulerFailure(error.GetType().Name + ": " + error.Message);
            }
            finally { Monitor.Exit(schedulingGate); }
        }

        // Called under schedulingGate, once for this accepted native event.
        // A WPF UI callback permits one no-input message to its active window
        // or its verified main window, owned by the same API thread and process. Whether this
        // makes Revit enter idle is measured, not assumed.
        // This callback never enters Revit, repeats Raise, or reads a model.
        private void QueueUiWake(SchedulerObservation observation)
        {
            if (observation.UiWakeAttempted) return;
            observation.UiWakeAttempted = true;
            if (pendingWakeOperation != null)
            {
                observation.UiWakeState = "cleanup_pending";
                return;
            }
            if (disposed || uiDispatcher.HasShutdownStarted || uiDispatcher.HasShutdownFinished)
            {
                observation.UiWakeState = "unavailable";
                return;
            }
            observation.UiWakePostedUtc = DateTime.UtcNow;
            observation.UiWakePostedTicks = Stopwatch.GetTimestamp();
            observation.UiWakeState = "queued";
            try
            {
                DispatcherOperation operation = uiDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(delegate { EnterUiWake(observation); }));
                pendingWakeObservation = observation;
                pendingWakeOperation = operation;
                operation.Completed += OnUiWakeFinished;
                operation.Aborted += OnUiWakeFinished;
                if (operation.Status == DispatcherOperationStatus.Completed || operation.Status == DispatcherOperationStatus.Aborted)
                    ReleaseUiWakeOperation(operation);
            }
            catch (Exception error)
            {
                observation.UiWakeState = "post_failed";
                observation.UiWakeDiagnostic = error.GetType().Name;
                // The accepted ExternalEvent and its original request remain
                // pending; a wake failure does not prove any business outcome.
                RecordSchedulerFailure("UI wake post failed: " + error.GetType().Name);
            }
        }

        private void EnterUiWake(SchedulerObservation observation)
        {
            lock (schedulingGate)
            {
                if (disposed || !eventPending || !Object.ReferenceEquals(pendingObservation, observation)) return;
                observation.UiWakeEnteredUtc = DateTime.UtcNow;
                observation.UiWakeEnteredTicks = Stopwatch.GetTimestamp();
                observation.UiWakeState = "entered";
                if (!observation.ActiveWindowMessageHandled && observation.RaiseResult == "Accepted")
                {
                    observation.ActiveWindowMessageHandled = true;
                    observation.ActiveWindowMessageState = activeWindowWake.TryPost(out observation.ActiveWindowMessageAttempted);
                }
            }
        }

        private void OnUiWakeFinished(object sender, EventArgs args)
        {
            lock (schedulingGate)
            {
                try { ReleaseUiWakeOperation(sender as DispatcherOperation); }
                catch (Exception error)
                {
                    if (pendingWakeObservation != null)
                    {
                        pendingWakeObservation.UiWakeCleanup = "failed";
                        pendingWakeObservation.UiWakeDiagnostic = error.GetType().Name;
                    }
                    RecordSchedulerFailure("UI wake cleanup failed: " + error.GetType().Name);
                }
            }
        }

        // A failed release retains the exact operation and its observation.
        // New events can still execute but cannot accumulate more UI wakes.
        private void ReleaseUiWakeOperation(DispatcherOperation operation)
        {
            if (operation == null || !Object.ReferenceEquals(pendingWakeOperation, operation)) return;
            DispatcherOperationStatus state = operation.Status;
            if (state != DispatcherOperationStatus.Completed && state != DispatcherOperationStatus.Aborted) return;
            operation.Completed -= OnUiWakeFinished;
            operation.Aborted -= OnUiWakeFinished;
            pendingWakeObservation.UiWakeState = state == DispatcherOperationStatus.Completed ? "completed" : "aborted";
            pendingWakeObservation.UiWakeCleanup = "released";
            pendingWakeOperation = null;
            pendingWakeObservation = null;
        }

        private bool CancelUiWake(SchedulerObservation observation)
        {
            if (pendingWakeOperation == null || !Object.ReferenceEquals(pendingWakeObservation, observation)) return true;
            DispatcherOperation operation = pendingWakeOperation;
            try
            {
                if (operation.Status == DispatcherOperationStatus.Pending) operation.Abort();
                ReleaseUiWakeOperation(operation);
                if (Object.ReferenceEquals(pendingWakeOperation, operation))
                {
                    observation.UiWakeCleanup = "pending";
                    return false;
                }
                return true;
            }
            catch (Exception error)
            {
                observation.UiWakeCleanup = "failed";
                observation.UiWakeDiagnostic = error.GetType().Name;
                RecordSchedulerFailure("UI wake cancellation failed: " + error.GetType().Name);
                return false;
            }
        }

        private void BackOff()
        {
            nextRaise = DateTime.UtcNow.AddMilliseconds(retryDelayMilliseconds);
            retryDelayMilliseconds = Math.Min(retryDelayMilliseconds * 2, 10000);
        }

        private void RecordSchedulerFailure(string message)
        {
            try { File.WriteAllText(Path.Combine(queue, "scheduler-error.txt"), DateTime.UtcNow.ToString("o") + " " + message); }
            catch (Exception error) { Trace.TraceError("Local Codex queue diagnostic failed: " + error.GetType().Name); }
        }

        private string NextRequest()
        {
            // Invalid names and already-claimed ids remain preserved but cannot block
            // valid work or replace an earlier operation's known/unknown outcome.
            // Writers finish a temporary body before atomically publishing it in
            // inbox. Its last-write timestamp survives rename and orders finalized
            // request files without parsing or trusting arbitrary request content.
            // Equal filesystem timestamps use the full ordinal path as a stable tie.
            return Directory.EnumerateFiles(Path.Combine(queue, "inbox"), "*.json")
                .Where(IsQueuedRequest)
                .Select(file => new { Path = file, WrittenUtc = File.GetLastWriteTimeUtc(file) })
                .OrderBy(item => item.WrittenUtc).ThenBy(item => item.Path, StringComparer.Ordinal)
                .Select(item => item.Path).FirstOrDefault();
        }

        private bool IsQueuedRequest(string file)
        {
            Guid id;
            return Guid.TryParse(Path.GetFileNameWithoutExtension(file), out id)
                && File.Exists(file)
                && !File.Exists(Path.Combine(queue, "processing", Path.GetFileName(file)))
                && !File.Exists(Path.Combine(queue, "outbox", Path.GetFileName(file)));
        }

        public string GetName() { return "Local Codex workbench request"; }

        public void Execute(UIApplication uiapp)
        {
            DateTime executeEnteredUtc = DateTime.UtcNow;
            long executeEnteredTicks = Stopwatch.GetTimestamp();
            CaptureApiThread(uiapp);
            SchedulerObservation observation;
            lock (schedulingGate)
            {
                observation = pendingObservation;
                pendingObservation = null;
                eventPending = false;
                CancelUiWake(observation);
                if (disposed || busy) return;
                busy = true;
            }
            bool completed = false;
            try { ProcessOne(uiapp, observation, executeEnteredUtc, executeEnteredTicks); completed = true; }
            catch (Exception error)
            {
                // Do not let an I/O failure escape and permanently deny this handler.
                // A claimed request remains in processing with an unknown outcome.
                RecordSchedulerFailure(error.GetType().Name + ": " + error.Message);
            }
            finally
            {
                lock (schedulingGate)
                {
                    busy = false;
                    // A successful callback is already in Revit's available API
                    // context. Do not suppress its next Idling opportunity: a
                    // timer-only Raise later may wait for unrelated user input.
                    if (completed) { nextRaise = DateTime.MinValue; retryDelayMilliseconds = 500; }
                    else BackOff();
                }
            }
        }

        // The transaction-group owner is the only producer of these facts.
        // Exception.Data and script-returned values never establish rollback.
        private sealed class ScriptExecutionFailure : Exception
        {
            public object TransactionReceipt { get; private set; }
            internal ScriptExecutionFailure(Exception cause, string mode, string path, string title, bool rolledBack)
                : base(cause.Message, cause)
            {
                TransactionReceipt = new {
                    schemaVersion = 1, operation = "execute_csharp", mode,
                    document = new { path, title }, scope = "transaction_group",
                    status = rolledBack ? "rolled_back" : "unknown", externalEffects = "unknown"
                };
            }
        }

        private static Dictionary<string, object> BoundedFailureError(string code, string message)
        {
            // ScriptRunner retains the complete compiler output in compile.log.
            // The receipt carries a bounded diagnostic alongside execution facts.
            message = message ?? "";
            var error = new Dictionary<string, object> { { "code", code }, { "message", message.Length > 4096 ? message.Substring(0, 4096) : message } };
            if (message.Length > 4096) { error["messageTruncated"] = true; error["messageCharacters"] = message.Length; }
            return error;
        }

        private void ProcessOne(UIApplication uiapp, SchedulerObservation observation, DateTime executeEnteredUtc, long executeEnteredTicks)
        {
            // Preserve the accepted request across the asynchronous Raise/Execute
            // gap; a later arrival must not steal this callback by sorting first.
            string observedFile = observation == null ? null : Path.Combine(queue, "inbox", observation.RequestId + ".json");
            string file = observedFile != null && IsQueuedRequest(observedFile) ? observedFile : NextRequest();
            if (file == null) return;
            string id = Path.GetFileNameWithoutExtension(file);
            string claimed = Path.Combine(queue, "processing", Path.GetFileName(file));
            // Keep claim failures outside operation error handling: an existing claim
            // must not be relabelled as failed or have its response overwritten.
            File.Move(file, claimed);
            DateTime claimedUtc = DateTime.UtcNow;
            long claimedTicks = Stopwatch.GetTimestamp();
            object result;
            bool dispatchStarted = false;
            DateTime? dispatchStartedUtc = null, dispatchFinishedUtc = null;
            long dispatchStartedTicks = 0, dispatchFinishedTicks = 0, validationFinishedTicks = claimedTicks;
            string rejectionCode = null;
            string rejectionReason = null;
            try
            {
                if (new FileInfo(claimed).Length > 128 * 1024) throw new InvalidOperationException("Request exceeds 128 KiB.");
                var request = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(claimed));
                if (Text(request, "id") != id) throw new InvalidOperationException("Request id mismatch.");
                if (Text(request, "targetSession") != session) throw new InvalidOperationException("Revit session changed; query status again.");
                DateTime expires;
                if (!DateTime.TryParse(Text(request, "expiresUtc"), null, System.Globalization.DateTimeStyles.AdjustToUniversal, out expires))
                {
                    rejectionCode = "WORKBENCH_REQUEST_INVALID_DEADLINE";
                    throw new InvalidOperationException("Request deadline is invalid; no operation was run.");
                }
                if (expires <= DateTime.UtcNow)
                {
                    rejectionCode = "WORKBENCH_REQUEST_EXPIRED";
                    rejectionReason = "expired";
                    throw new InvalidOperationException("Request expired before execution; no operation was run.");
                }
                string operation = Text(request, "operation");
                var args = request.ContainsKey("args") ? request["args"] as Dictionary<string, object> : null;
                bool atomicRead = AtomicReadRequested(request, operation);
                AccessPolicy.Binding access = AccessPolicy.RequestBinding(request);
                if (access != null && RequiresProjectEdit(operation))
                {
                    rejectionCode = "WORKBENCH_ACCESS_DENIED";
                    RequireProjectEdit(uiapp.ActiveUIDocument == null ? null : uiapp.ActiveUIDocument.Document, ExpectedDocument(args ?? new Dictionary<string, object>()), access);
                    rejectionCode = null;
                }
                // This proves an attempt entered Dispatch, not that a Revit API
                // query succeeded. Validation rejection never reaches this line.
                dispatchStartedUtc = DateTime.UtcNow;
                dispatchStartedTicks = Stopwatch.GetTimestamp();
                validationFinishedTicks = dispatchStartedTicks;
                dispatchStarted = true;
                try { result = atomicRead
                    ? DispatchAtomicRead(uiapp, operation, args ?? new Dictionary<string, object>(), id, access)
                    : Dispatch(uiapp, operation, args ?? new Dictionary<string, object>(), id, access); }
                finally { dispatchFinishedUtc = DateTime.UtcNow; dispatchFinishedTicks = Stopwatch.GetTimestamp(); }
            }
            catch (Exception error)
            {
                if (!dispatchStarted) validationFinishedTicks = Stopwatch.GetTimestamp();
                ScriptExecutionFailure scriptFailure = error as ScriptExecutionFailure;
                Exception cause = scriptFailure == null ? error : scriptFailure.InnerException;
                while (cause is TargetInvocationException && cause.InnerException != null) cause = cause.InnerException;
                var failure = new Dictionary<string, object> {
                    { "id", id }, { "ok", false }, { "hostSession", session },
                    { "error", BoundedFailureError(rejectionCode ?? (cause is CadQueryException ? ((CadQueryException)cause).Code : cause.GetType().Name), cause.Message) },
                    { "execution", new { started = dispatchStarted, phase = dispatchStarted ? "dispatch" : "validation", reason = rejectionReason } },
                    { "completedUtc", DateTime.UtcNow.ToString("o") }
                };
                if (scriptFailure != null) failure["transaction"] = scriptFailure.TransactionReceipt;
                var failureWithTiming = new Dictionary<string, object>(failure) {
                    { "timing", ReceiptTiming(id, observation, executeEnteredUtc, executeEnteredTicks, claimedUtc, claimedTicks, dispatchStartedUtc, validationFinishedTicks, dispatchFinishedUtc, dispatchStartedTicks, dispatchFinishedTicks) }
                };
                WriteAtomic(Path.Combine(queue, "outbox", id + ".json"), failure, failureWithTiming);
                return;
            }
            // A delivery failure after commit is an unknown response outcome, not a
            // failed model operation. Keep processing evidence; never emit ok=false.
            var success = new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", result }, { "completedUtc", DateTime.UtcNow.ToString("o") } };
            var successWithTiming = new Dictionary<string, object>(success) {
                { "timing", ReceiptTiming(id, observation, executeEnteredUtc, executeEnteredTicks, claimedUtc, claimedTicks, dispatchStartedUtc, validationFinishedTicks, dispatchFinishedUtc, dispatchStartedTicks, dispatchFinishedTicks) }
            };
            WriteAtomic(Path.Combine(queue, "outbox", id + ".json"), success, successWithTiming);
        }

        private static bool AtomicReadRequested(Dictionary<string, object> request, string operation)
        {
            object value;
            bool present = request.TryGetValue("atomicRead", out value);
            if (present && !(value is bool)) throw new InvalidOperationException("atomicRead must be a boolean.");
            if (!present || !(bool)value)
            {
                if (operation == "get_model_preparation")
                    throw new InvalidOperationException("Model preparation requires an atomic read snapshot.");
                if (operation == "get_pipe_network")
                    throw new InvalidOperationException("Pipe network query requires an atomic read snapshot.");
                if (operation == "get_group_members")
                    throw new InvalidOperationException("Group members query requires an atomic read snapshot.");
                if (operation == "calculate_material_quantities")
                    throw new InvalidOperationException("Material quantities require an atomic read snapshot.");
                if (operation == "check_clashes")
                    throw new InvalidOperationException("Clash candidates require an atomic read snapshot.");
                return false;
            }
            if (!AtomicReadOperations.Contains(operation))
                throw new InvalidOperationException("Atomic snapshots support only named read operations.");
            return true;
        }

        private static bool RequiresProjectEdit(string operation)
        {
            return WorkbenchActions.IsWrite(operation) || new[] { "set_selection", "select_by_unique_ids", "execute_csharp", "smart_annotate", "build_schematic", "export_schematic", "inspect_elements", "family_create_valve", "family_save_job", "family_load_job" }.Contains(operation);
        }

        private object DispatchAtomicRead(UIApplication uiapp, string operation, Dictionary<string, object> args, string id, AccessPolicy.Binding access)
        {
            if (!AtomicReadOperations.Contains(operation))
                throw new InvalidOperationException("Atomic snapshots support only named read operations.");
            Document doc = uiapp.ActiveUIDocument == null ? null : uiapp.ActiveUIDocument.Document;
            var documentSource = new BuildX.FamilyRevit.RevitProjectDocumentSource(Thread.CurrentThread.ManagedThreadId);
            if (doc != null && documentSource.SameOpenDocument(doc, doc) != true)
                throw new InvalidOperationException("Active document is no longer valid; snapshot was not published.");
            long? viewId = doc == null || doc.ActiveView == null ? (long?)null : doc.ActiveView.Id.Value;
            var boundArgs = new Dictionary<string, object>(args);
            object proposalWire;
            bool preparesTypeWrite = boundArgs.TryGetValue("type_write_proposal", out proposalWire);
            if (preparesTypeWrite) boundArgs.Remove("type_write_proposal");
            // Omission is resolved once, inside the same Revit callback that
            // consumes it. An explicit identity is never replaced or guessed.
            if (!boundArgs.ContainsKey("expected_document") && (operation != "health" || doc != null))
                boundArgs["expected_document"] = doc == null ? "" : doc.PathName;
            if ((operation != "status" && operation != "health") || args.ContainsKey("expected_document"))
                RequireDocument(doc, ExpectedDocument(boundArgs));
            object value;
            WorkbenchActions.TypeWritePreparation preparation = null;
            if (preparesTypeWrite)
            {
                if (operation != "get_type_parameter_impact") throw new InvalidOperationException("Type-write preparation requires the atomic type-impact operation.");
                foreach (string field in boundArgs.Keys)
                    if (field != "expected_document" && field != "type_id" && field != "parameter_id") throw new InvalidOperationException("Unknown type-impact argument: " + field);
                var proposal = proposalWire as Dictionary<string, object>;
                var plan = WorkbenchActions.ParseTypeWriteArguments(proposal);
                RequireProjectEdit(doc, plan.ExpectedDocument, access);
                if (doc == null || String.IsNullOrWhiteSpace(doc.PathName)) throw new InvalidOperationException("Type-write preparation requires a saved project.");
                if (plan.TypeId != NativeModelQueries.ExactId(boundArgs, "type_id") || plan.ParameterId != NativeModelQueries.ExactSignedId(boundArgs, "parameter_id"))
                    throw new InvalidOperationException("Type-write proposal differs from the reviewed type/parameter.");
                preparation = WorkbenchActions.PrepareTypeParameterWrite(doc, proposal);
                value = new { operation, hostSession = session, document = new { title = doc.Title, path = doc.PathName }, value = FreezeResult(preparation.Impact.Dto()), modifiedByOperation = false };
            }
            else value = Dispatch(uiapp, operation, boundArgs, id, access);
            Document after = uiapp.ActiveUIDocument == null ? null : uiapp.ActiveUIDocument.Document;
            // Revit can expose a new managed wrapper for the same open native
            // document. The existing document owner compares native identity,
            // and treats an invalid wrapper as unknown rather than aligned.
            bool sameDocument = doc == null ? after == null : documentSource.SameOpenDocument(doc, after) == true;
            if (!sameDocument)
                throw new InvalidOperationException("Active document changed or became invalid during the read; snapshot was not published.");
            long? afterViewId = after == null || after.ActiveView == null ? (long?)null : after.ActiveView.Id.Value;
            if (viewId != afterViewId)
                throw new InvalidOperationException("Active view changed during the read; snapshot was not published.");
            if (preparation != null)
                return FreezeResult(new { operation, hostSession = session, snapshot = Status(doc, access), value, atomicReadSnapshot = true,
                    type_write_preparation = TypeParameterApprovals().Issue(doc, preparation.Plan) });
            return FreezeResult(new { operation, hostSession = session, snapshot = Status(doc, access), value, atomicReadSnapshot = true });
        }

        private TypeParameterWriteApproval TypeParameterApprovals()
        {
            if (typeParameterApprovals == null)
            {
                var nativeDocuments = new BuildX.FamilyRevit.RevitProjectDocumentSource(Thread.CurrentThread.ManagedThreadId);
                typeParameterApprovals = new TypeParameterWriteApproval(session, nativeDocuments.SameOpenDocument);
            }
            return typeParameterApprovals;
        }

        private Dictionary<string, object> BindTypeWritePermit(Document doc, Dictionary<string, object> wire)
        {
            var args = new Dictionary<string, object>(wire, StringComparer.Ordinal); object approval;
            args.TryGetValue("approved_type_write", out approval); args.Remove("approved_type_write");
            WorkbenchActions.TypeWritePlan plan = WorkbenchActions.ParseTypeWriteArguments(args);
            var permit = TypeParameterApprovals().Consume(doc, plan, approval);
            args.Add(TypeParameterWriteApproval.PermitArgument, permit);
            return args;
        }

        private object Dispatch(UIApplication uiapp, string operation, Dictionary<string, object> args, string id, AccessPolicy.Binding access)
        {
            InitializeFamilyApprovalObserver(uiapp);
            Document doc = uiapp.ActiveUIDocument == null ? null : uiapp.ActiveUIDocument.Document;
            if (operation == "status") return Status(doc, access);
            if (VisualInspection.IsOperation(operation))
            {
                // Screenshot files and temporary inspection views have their own
                // lifecycle. Never nest this owner under the generic script group.
                if (operation == "capture_view" || operation == "restore_visual_session") RequireDocument(doc, ExpectedDocument(args));
                else RequireProjectEdit(doc, ExpectedDocument(args), access);
                if (visualInspection == null) visualInspection = new VisualInspection(session, Root);
                object visualValue = visualInspection.Execute(uiapp, operation, args, id);
                return FreezeResult(new { operation, hostSession = session,
                    document = new { title = doc.Title, path = doc.PathName }, value = visualValue });
            }
            if (visualInspection != null && visualInspection.CleanupPending)
                throw new InvalidOperationException("An owned visual inspection still requires restoration before other model operations.");
            if (FamilyOperations.Contains(operation))
            {
                if (operation == "family_create_valve" || operation == "family_save_job" || operation == "family_load_job")
                    RequireProjectEdit(doc, ExpectedDocument(args), access);
                try
                {
                    if (familyWorkflow == null) familyWorkflow = new BuildX.FamilyRevit.RevitFamilyWorkflow(session, Process.GetCurrentProcess().Id, Root, PublishFamilyApprovalCapability);
                    object familyValue = familyWorkflow.Execute(uiapp, operation, args);
                    return FreezeResult(new { operation, hostSession = session, value = familyValue });
                }
                catch (Exception error)
                {
                    // Creation/file save/load can have independent side effects. An
                    // unexpected error, including DTO serialization, proves no rollback.
                    return new { operation, hostSession = session, value = new { success = false,
                        outcome = "unknown", code = "FAMILY_OUTCOME_UNKNOWN", request_id = id,
                        diagnostic = error.GetType().Name,
                        note = "Inspect this request and the existing family job; do not replay creation/save/load automatically." } };
                }
            }
            if (CadGeometryQueries.IsRead(operation))
            {
                CadQueryArguments query = CadQueryArguments.Parse(operation, args);
                RequireDocument(doc, query.ExpectedDocument);
                object result = CadGeometryQueries.Read(doc, operation, query,
                    cadValue => new { operation, hostSession = session, document = new { title = doc.Title, path = doc.PathName }, value = cadValue, modifiedByOperation = false }, id);
                return FreezeResult(result);
            }
            if (operation == "preview_schematic")
            {
                RequireDocument(doc, ExpectedDocument(args));
                object drawing = FreezeResult(SchematicRevitService.Preview(uiapp, args));
                return new { operation, hostSession = session, document = new { title = doc.Title, path = doc.PathName }, value = drawing, modifiedByOperation = false };
            }
            if (WorkbenchActions.IsRead(operation))
            {
                if (operation != "health" || args.ContainsKey("expected_document")) RequireDocument(doc, ExpectedDocument(args));
                object readResult = FreezeResult(WorkbenchActions.Read(uiapp, operation, args));
                return new { operation, hostSession = session, document = doc == null ? null : new { title = doc.Title, path = doc.PathName }, value = readResult, modifiedByOperation = false };
            }
            if (operation == "set_selection" || operation == "select_by_unique_ids")
            {
                RequireProjectEdit(doc, ExpectedDocument(args), access);
                object selected = FreezeResult(operation == "set_selection" ? WorkbenchActions.SetSelection(uiapp, args) : WorkbenchActions.SelectByUniqueIds(uiapp, args));
                return new { operation, hostSession = session, document = new { title = doc.Title, path = doc.PathName }, value = selected, effect = "ui_selection" };
            }
            if (operation == "set_type_parameter")
            {
                RequireProjectEdit(doc, ExpectedDocument(args), access);
                args = BindTypeWritePermit(doc, args);
            }
            if (operation != "execute_csharp" && operation != "smart_annotate" && operation != "build_schematic" && operation != "export_schematic" && !WorkbenchActions.IsWrite(operation))
                throw new InvalidOperationException("Unknown workbench operation.");
            RequireProjectEdit(doc, ExpectedDocument(args), access);
            string mode = Text(args, "mode", "rollback");
            if (mode != "commit" && mode != "rollback") throw new InvalidOperationException("Mode must be commit or rollback.");
            string sourcePath = doc.PathName, sourceTitle = doc.Title;
            object value;
            using (TransactionGroup group = new TransactionGroup(doc, "Local Codex: " + operation))
            {
                group.Start();
                try
                {
                    if (operation == "execute_csharp") value = ScriptRunner.Execute(uiapp, Text(args, "code"), id, ScriptParameters(args));
                    else if (operation == "smart_annotate") value = ArgusTools.Annotate(uiapp, args);
                    else if (operation == "build_schematic") value = ArgusTools.Schematic(uiapp, args);
                    else if (operation == "export_schematic") value = SchematicRevitService.Export(uiapp, args);
                    else value = WorkbenchActions.Write(uiapp, operation, args);
                    // Reject unbounded/nonserializable live Revit objects before committing any changes.
                    value = FreezeResult(value);
                    // A user can revoke the UI-published scope while a long
                    // callback is running. Never commit under an obsolete grant.
                    if (mode == "commit") RequireProjectEdit(doc, ExpectedDocument(args), access);
                    TransactionStatus completion = mode == "commit" ? group.Assimilate() : group.RollBack();
                    if (completion != (mode == "commit" ? TransactionStatus.Committed : TransactionStatus.RolledBack)) throw new InvalidOperationException("Revit did not finish the transaction group: " + completion);
                }
                catch (Exception error)
                {
                    if (operation != "execute_csharp") { if (group.GetStatus() == TransactionStatus.Started) group.RollBack(); throw; }
                    bool rolledBack = false;
                    try
                    {
                        if (group.GetStatus() == TransactionStatus.Started) group.RollBack();
                        rolledBack = group.GetStatus() == TransactionStatus.RolledBack;
                    }
                    catch { /* Cleanup failure leaves model rollback explicitly unknown. */ }
                    throw new ScriptExecutionFailure(error, mode, sourcePath, sourceTitle, rolledBack);
                }
            }
            return new { operation, mode, committed = mode == "commit", document = doc.Title, value, note = mode == "rollback" ? "Model changes rolled back; returned temporary ids may no longer exist." : "Changes are in memory; model has not been saved." };
        }

        private object Status(Document doc, AccessPolicy.Binding access)
        {
            string core = Path.Combine(PrivateRuntimeRoot, "argus", "2024", "ArgusLearning.Core.dll");
            string inference = Path.Combine(PrivateRuntimeRoot, "argus", "Shared", "BIMLOGiQ.SmartAnnotation.inference.exe");
            return new {
                hostSession = session,
                hostVersion = HostVersion,
                dispatcher = "ExternalEvent",
                revitPid = Process.GetCurrentProcess().Id,
                document = doc == null ? null : new { title = doc.Title, path = doc.PathName,
                    activeViewId = doc.ActiveView == null ? null : (doc.ActiveView.Id.Value > 9007199254740991L ? (object)NativeModelQueries.SignedId(doc.ActiveView.Id) : doc.ActiveView.Id.Value),
                    activeViewType = doc.ActiveView == null ? null : doc.ActiveView.ViewType.ToString(), allowedSample = IsAllowed(doc.PathName), modified = doc.IsModified,
                    access = AccessPolicy.Evaluate(Root, access, doc.PathName, IsAllowed(doc.PathName), doc.IsReadOnly, doc.IsFamilyDocument, doc.IsLinked).Public },
                capabilities = new { script = File.Exists(ScriptRunner.Compiler), argusCorePresent = File.Exists(core), annotationInferencePresent = File.Exists(inference),
                    mode = "active-document-reads-scoped-writes", dispatcher = "ExternalEvent", runtimeValidated = false, atomicReadSnapshot = true, nativeModelQueriesVersion = 1,
                    nativeModelQueryOperations = new[] { "health", "get_document_info", "list_views", "get_element_parameters", "get_elements_by_type", "get_element_geometry", "get_model_preparation", "get_pipe_network", "get_revision_sequences", "get_schedule_data" }.Concat(AecPilotQueries.Operations).ToArray(),
                    nativeParameterQueriesVersion = 1, nativeParameterQueryOperations = new[] { "get_type_parameters", "get_parameter_value", "get_type_parameter_impact" },
                    nativeParameterWritesVersion = 1, nativeParameterWriteOperations = new[] { "set_parameter_value" },
                    nativeTypeParameterWritesVersion = 1, nativeTypeParameterWriteOperations = new[] { "set_type_parameter" },
                    nativeSelectionWritesVersion = 1, nativeSelectionWriteOperations = new[] { "set_selection", "select_by_unique_ids" },
                    nativeBasicWritesVersion = 1, nativeBasicWriteOperations = NativeBasicWriteOperations,
                    parameterWriteTargetPolicyVersion = 1, parameterWriteTargetPolicy = "instance_only",
                    structuredScriptParameters = true, familyLifecycleApprovalVersion = familyWorkflow != null && familyWorkflow.ApprovalObserverReady ? 1 : 0, visualInspectionVersion = 1, accessPolicyVersion = 1,
                    supportedOperations = new[] { "status", "execute_csharp", "smart_annotate", "build_schematic", "preview_schematic", "export_schematic", "list_cad_imports", "read_cad_geometry" }
                        .Concat(WorkbenchActions.ReadOperations).Concat(WorkbenchActions.WriteOperations).Concat(FamilyOperations).Concat(VisualInspection.Operations).ToArray() },
                executionNotice = "C# runs with Revit user privileges and is not sandboxed. Transactions undo model changes, not filesystem/network side effects. Do not automatically retry unknown outcomes."
            };
        }

        private object FreezeResult(object value)
        {
            string serialized = json.Serialize(value);
            if (serialized.Length > 250000) throw new InvalidOperationException("Result too large; request a smaller page or return a compact DTO with element ids.");
            // Materialize lazy sequences and property getters while the transaction
            // still owns valid Revit state. No later serialization may revisit them.
            return json.DeserializeObject(serialized);
        }

        private static IDictionary<string, object> ScriptParameters(Dictionary<string, object> args)
        {
            object value;
            if (!args.TryGetValue("parameters", out value)) return null;
            var parameters = value as Dictionary<string, object>;
            if (parameters == null || parameters.Count > 32) throw new InvalidOperationException("Invalid structured script parameters.");
            foreach (var entry in parameters)
            {
                if (String.IsNullOrEmpty(entry.Key) || entry.Key.Length > 64 || entry.Value == null ||
                    !(entry.Value is string || entry.Value is bool || entry.Value is int || entry.Value is long || entry.Value is double || entry.Value is decimal))
                    throw new InvalidOperationException("Invalid structured script parameter value.");
            }
            return new Dictionary<string, object>(parameters);
        }
        private static string ExpectedDocument(Dictionary<string, object> args)
        {
            object value;
            if (!args.TryGetValue("expected_document", out value) || !(value is string))
                throw new InvalidOperationException("expected_document must be a string from current workbench status.");
            return (string)value;
        }

        private static void RequireDocument(Document doc, string expected)
        {
            if (doc == null) throw new InvalidOperationException("Open a Revit document first.");
            string actual = doc.PathName;
            // Empty identity is allowed only for reads of the currently unsaved document.
            // The enclosing request still has to match this host's targetSession.
            if (actual.Length == 0 && expected.Length == 0) return;
            if (expected.Length == 0 || actual.Length == 0 || !Path.IsPathRooted(expected)
                || !string.Equals(Path.GetFullPath(expected), Path.GetFullPath(actual), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Active document does not match expected_document; query status again.");
        }

        private void RequireProjectEdit(Document doc, string expected, AccessPolicy.Binding access)
        {
            RequireDocument(doc, expected);
            if (string.IsNullOrWhiteSpace(expected)) throw new InvalidOperationException("Writes require a saved project document.");
            AccessPolicy.RequireEdit(Root, access, doc.PathName, IsAllowed(doc.PathName), doc.IsReadOnly, doc.IsFamilyDocument, doc.IsLinked);
        }

        private bool IsAllowed(string documentPath)
        {
            if (string.IsNullOrWhiteSpace(documentPath)) return false;
            string config = Path.Combine(Root, "workbench-config.json");
            if (!File.Exists(config)) return false;
            var settings = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(config));
            object paths;
            if (!settings.TryGetValue("allowedDocuments", out paths)) return false;
            var values = paths as System.Collections.IEnumerable;
            if (values == null) return false;
            string full = Path.GetFullPath(documentPath);
            foreach (object path in values) if (string.Equals(full, Path.GetFullPath(Convert.ToString(path)), StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        internal static string Text(Dictionary<string, object> args, string key, string fallback = "") { object value; return args.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : fallback; }
        private void WriteAtomic(string file, object value, object valueWithTiming = null)
        {
            string serialized;
            try { serialized = json.Serialize(valueWithTiming ?? value); }
            catch (InvalidOperationException)
            {
                if (valueWithTiming == null) throw;
                // Optional diagnostics must not make an otherwise serializable
                // business envelope exceed the original serializer budget.
                // This fallback happens before any I/O, never after an unknown
                // temporary write or publication/rename outcome.
                serialized = json.Serialize(value);
            }
            string temp = file + "." + session + ".tmp";
            File.WriteAllText(temp, serialized, new System.Text.UTF8Encoding(false));
            if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file);
        }
        public void Dispose()
        {
            lock (schedulingGate)
            {
                // Serialize shutdown with Raise; queued timer callbacks see disposed.
                // Timer.Dispose does not wait on callbacks, avoiding a UI/gate deadlock.
                disposed = true;
                pendingObservation = null;
                eventPending = false;
                activeWindowWake.Clear();
                if (familyWorkflow != null) { familyWorkflow.DisposeApprovalObserver(); familyWorkflow = null; }
                bool wakeReleased = CancelUiWake(pendingWakeObservation);
                if (controlledApplication != null) { controlledApplication.Idling -= OnQueueIdling; controlledApplication = null; }
                if (queueTimer != null) { queueTimer.Dispose(); queueTimer = null; }
                if (externalEvent != null) { externalEvent.Dispose(); externalEvent = null; }
                AppDomain.CurrentDomain.AssemblyResolve -= ResolvePrivateDependency;
                if (ownerLock != null) { ownerLock.Dispose(); ownerLock = null; }
                if (!wakeReleased) throw new InvalidOperationException("UI wake cleanup is pending; the original operation is retained.");
                // Keep any resource whose Dispose throws available for a cleanup retry.
            }
        }
    }
}
