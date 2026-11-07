using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Windows.Threading;

namespace System.Windows.Threading {
    internal enum DispatcherPriority { Background }
    internal enum DispatcherOperationStatus { Pending, Executing, Completed, Aborted }
    internal sealed class DispatcherOperation {
        private readonly Action callback;
        public DispatcherOperationStatus Status=DispatcherOperationStatus.Pending;
        public bool AbortThrows,AbortReturnsFalse;
        public int AbortCalls;
        public event EventHandler Completed;
        public event EventHandler Aborted;
        public DispatcherOperation(Action action){callback=action;}
        public bool Abort(){AbortCalls++;if(AbortThrows)throw new IOException("Controlled abort failure");if(AbortReturnsFalse||Status!=DispatcherOperationStatus.Pending)return false;Status=DispatcherOperationStatus.Aborted;if(Aborted!=null)Aborted(this,EventArgs.Empty);return true;}
        // Forced delivery exercises a late/stale callback after cancellation.
        public void Deliver(){Status=DispatcherOperationStatus.Executing;callback();Status=DispatcherOperationStatus.Completed;if(Completed!=null)Completed(this,EventArgs.Empty);}
    }
    internal sealed class Dispatcher {
        public bool HasShutdownStarted,HasShutdownFinished,FailPost;
        public int Posts;
        public readonly List<DispatcherOperation> Operations=new List<DispatcherOperation>();
        public DispatcherOperation BeginInvoke(DispatcherPriority priority,Delegate action){Posts++;if(FailPost)throw new InvalidOperationException("Controlled dispatcher post failure");var operation=new DispatcherOperation((Action)action);Operations.Add(operation);return operation;}
    }
}

namespace BuildX.FamilyRevit {
    using Document = RevitLocalCodex.Document;
    // The production document owner's comparison is extracted separately so
    // these host checks cannot quietly invent another identity rule.
    internal sealed class RevitProjectDocumentSource {
        private readonly int apiThreadId;
        internal RevitProjectDocumentSource(int threadId) { apiThreadId=threadId; }
        // ORIGINAL_DOCUMENT_SOURCE_THREAD
        // ORIGINAL_DOCUMENT_SOURCE_IDENTITY
    }
}

namespace RevitLocalCodex {
    // ExternalEvent/UIApplication and business Dispatch are controlled peers.
    // Scheduler, request/access validation and document identity owners are
    // extracted verbatim; this harness does not load Autodesk assemblies.
    internal sealed class ElementId { public long Value; public ElementId(long value) { Value=value; } }
    internal sealed class View { public ElementId Id = new ElementId(12); }
    internal sealed class Document {
        private readonly object nativeIdentity;
        public string PathName="D:\\fixture.rvt", Title="Host fixture";
        public View ActiveView=new View();
        public bool IsValidObject=true;
        public bool IsReadOnly,IsFamilyDocument,IsLinked;
        public Document() : this(new object()) { }
        private Document(object identity) { nativeIdentity=identity; }
        public Document AnotherWrapper() { return new Document(nativeIdentity) {PathName=PathName,ActiveView=ActiveView,IsValidObject=IsValidObject}; }
        public override bool Equals(object value) { var other=value as Document;return other!=null && IsValidObject && other.IsValidObject && Object.ReferenceEquals(nativeIdentity,other.nativeIdentity); }
        public override int GetHashCode() { return nativeIdentity.GetHashCode(); }
    }
    internal sealed class UIDocument { public Document Document=new Document(); }
    internal sealed class UIApplication {
        public UIDocument ActiveUIDocument=new UIDocument();
        public IntPtr MainWindow;
        public bool ThrowMainWindow;
        public IntPtr MainWindowHandle { get { if(ThrowMainWindow)throw new IOException("Controlled main-window failure");return MainWindow; } }
    }
    internal sealed class IdlingEventArgs { public int FastRequests; public void SetRaiseWithoutDelay(){ FastRequests++; } }
    internal sealed class UIControlledApplication { public event EventHandler<IdlingEventArgs> Idling; }
    internal sealed class CadQueryException : Exception { public string Code { get { return "FIXTURE_CAD_ERROR"; } } }
    internal enum ExternalEventRequest { Accepted, Pending, Denied }
    // Family documents/approval observers are outside these scheduler checks.
    // No family workflow is constructed or reported as approved.
    internal sealed class FamilyApprovalPeer { public void DisposeApprovalObserver(){} }
    internal static class WorkbenchActions {
        // ORIGINAL_OPERATION_CLASSIFICATION
        internal static int BatchPreviewCalls;
        internal static object PreviewBatchParameterFilter(Document doc,string category,long? typeId,long? levelId,long parameterId){BatchPreviewCalls++;if(doc==null||category!="OST_Walls"||parameterId!=-100)throw new InvalidOperationException("Invalid batch preview facts");return new { complete=true,write_authorization="not_granted" };}
        // Type-write business behavior is tested by the separate actual
        // book/writer producer. Scheduler checks must never approve it here.
        internal sealed class TypeWritePlan { internal long TypeId,ParameterId; internal string ExpectedDocument; }
        internal sealed class ImpactPeer { internal object Dto(){throw new NotSupportedException("Type writing is outside scheduler checks.");} }
        internal sealed class TypeWritePreparation { internal TypeWritePlan Plan;internal ImpactPeer Impact; }
        internal static TypeWritePlan ParseTypeWriteArguments(Dictionary<string,object> args){throw new NotSupportedException("Type writing is outside scheduler checks.");}
        internal static TypeWritePreparation PrepareTypeParameterWrite(Document doc,Dictionary<string,object> args){throw new NotSupportedException("Type writing is outside scheduler checks.");}
    }
    internal static class NativeModelQueries {
        internal static void Fields(Dictionary<string,object> args,params string[] fields){foreach(string key in args.Keys)if(!fields.Contains(key))throw new InvalidOperationException("Unexpected field");}
        internal static long ExactId(Dictionary<string,object> args,string key){return Convert.ToInt64(args[key]);}
        internal static long ExactSignedId(Dictionary<string,object> args,string key){return Convert.ToInt64(args[key]);}
    }
    internal sealed class TypeParameterWriteApproval {
        internal const string PermitArgument="__native_type_write_permit";
        internal sealed class Permit { }
        internal TypeParameterWriteApproval(string session,Func<object,object,bool?> identity){ }
        internal object Issue(Document doc,WorkbenchActions.TypeWritePlan plan){throw new NotSupportedException("Type writing is outside scheduler checks.");}
        internal Permit Consume(Document doc,WorkbenchActions.TypeWritePlan plan,object provided){throw new NotSupportedException("Type writing is outside scheduler checks.");}
    }
    internal static class ProjectInstanceBindingPreparation {
        internal sealed class Snapshot { }
        internal static object Describe(Snapshot s,int offset,int limit,string expected,string session){throw new NotSupportedException();}
    }
    internal static class ProjectBindingCandidate {
        internal sealed class Plan { internal string Document,Scope; }
        internal static Plan Parse(Dictionary<string,object> args){throw new NotSupportedException();}
        internal static ProjectInstanceBindingPreparation.Snapshot Capture(Document d,Plan p){throw new NotSupportedException();}
    }
    internal sealed class ProjectBindingNativePreparation {
        internal ProjectBindingNativePreparation(string session,Func<object,object,bool?> identity){}
        internal object Issue(Document d,ProjectInstanceBindingPreparation.Snapshot s,string scope,string id){throw new NotSupportedException();}
    }
    internal sealed class ExternalEvent {
        public ExternalEventRequest Result = ExternalEventRequest.Accepted;
        public int Raises;
        public ExternalEventRequest Raise() { Raises++;return Result; }
        public void Dispose() { }
    }
    // Controlled I/O counters/faults around the exact original publication code.
    // Real local files still supply request/receipt evidence in the test root.
    internal static class File {
        public static int PublicationWrites,PublicationRenames;
        public static bool FailWrite,FailRename;
        public static void Reset() { PublicationWrites=0;PublicationRenames=0;FailWrite=false;FailRename=false; }
        public static bool Exists(string file) { return System.IO.File.Exists(file); }
        public static DateTime GetLastWriteTimeUtc(string file) { return System.IO.File.GetLastWriteTimeUtc(file); }
        public static FileAttributes GetAttributes(string file) { return System.IO.File.GetAttributes(file); }
        public static string ReadAllText(string file) { return System.IO.File.ReadAllText(file); }
        public static void WriteAllText(string file,string text) { System.IO.File.WriteAllText(file,text); }
        public static void WriteAllText(string file,string text,System.Text.Encoding encoding) { PublicationWrites++;if(FailWrite)throw new IOException("Controlled temporary write failure");System.IO.File.WriteAllText(file,text,encoding); }
        public static void Move(string source,string target) { if(Path.GetFileName(Path.GetDirectoryName(target))=="outbox"){PublicationRenames++;if(FailRename)throw new IOException("Controlled publication rename failure");}System.IO.File.Move(source,target); }
        public static void Replace(string source,string target,string backup) { PublicationRenames++;if(FailRename)throw new IOException("Controlled publication replace failure");System.IO.File.Replace(source,target,backup); }
    }
    internal sealed class SnapshotRevitBridge {
        public int Calls; public object Query(Document doc,Dictionary<string,object> args) { Calls++;if(doc==null||!args.ContainsKey("expected_document"))throw new InvalidOperationException("Missing identity");return new { schema_version=1,state="none",baseline_token=(string)null,version=(long?)null,baseline_count=(int?)null,reason=(string)null }; }
        public void Dispose() { }
    }
    internal sealed class WorkbenchHost {
        private sealed class UiPeer {
            public Thread Managed=Thread.CurrentThread;
            public uint NativeId=91,ProcessId=777,WindowProcessId=777;
            public uint? WindowThreadId;
            public IntPtr Active=new IntPtr(42),LastPostedWindow;
            public bool PostSucceeds=true,ThrowPost,ThrowManaged,ThrowNative;
            public bool WindowValid=true,ThrowActive,ThrowValidity,ThrowOwner,ThrowProcess,ChangeActive;
            public int Posts,ActiveReads;
            public Thread Current(){if(ThrowManaged)throw new IOException("Controlled managed thread failure");return Managed;}
            public uint Native(){if(ThrowNative)throw new IOException("Controlled native thread failure");return NativeId;}
            public uint Process(){if(ThrowProcess)throw new IOException("Controlled process failure");return ProcessId;}
            public IntPtr ActiveWindow(){ActiveReads++;if(ThrowActive)throw new IOException("Controlled active window failure");return ChangeActive&&ActiveReads%2==0?new IntPtr(43):Active;}
            public bool MainEnabled=true,MainIconic;
            public bool Valid(IntPtr window){if(ThrowValidity)throw new IOException("Controlled validity failure");return WindowValid&&window.ToInt64()>=42&&window.ToInt64()<=45;}
            public bool Enabled(IntPtr window){return MainEnabled;}
            public bool Iconic(IntPtr window){return MainIconic;}
            public CurrentUiWindowWake.WindowOwner Owner(IntPtr window){if(ThrowOwner)throw new IOException("Controlled owner failure");return new CurrentUiWindowWake.WindowOwner(WindowThreadId??NativeId,WindowProcessId);}
            public bool Post(IntPtr window){Posts++;LastPostedWindow=window;if(ThrowPost)throw new IOException("Controlled window post failure");return PostSucceeds;}
        }
        private readonly string queue;
        private readonly string session = new string('a',32);
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength=1024*1024, RecursionLimit=40 };
        private readonly object schedulingGate = new object();
        private readonly Dispatcher uiDispatcher=new Dispatcher();
        private readonly UiPeer uiPeer=new UiPeer();
        private readonly CurrentUiWindowWake activeWindowWake;
        private DispatcherOperation pendingWakeOperation;
        private SchedulerObservation pendingWakeObservation;
        private FileStream ownerLock;
        private Timer queueTimer;
        private UIControlledApplication controlledApplication;
        private SnapshotRevitBridge snapshotBridge;
        private FamilyApprovalPeer familyWorkflow;
        private TypeParameterWriteApproval typeParameterApprovals;
        private ProjectBindingNativePreparation projectBindingApprovals;
        private static readonly bool ProjectBindingCandidateEnabled = false;
        private ExternalEvent externalEvent = new ExternalEvent();
        private SchedulerObservation pendingObservation;
        private DateTime nextRaise = DateTime.MinValue;
        private int retryDelayMilliseconds = 500;
        private bool eventPending;
        private bool disposed;
        private bool busy;
        public int DispatchCalls;
        private bool dispatchFailure;
        private bool changeDocument;
        private bool preserveChangedDocumentPath;
        private bool replaceWrapper;
        private bool invalidateDocument;
        private bool changeView;
        private bool openAfterNull;
        private string selectedDocument;
        // ORIGINAL_ATOMIC_OPERATIONS
        private string Root { get { return queue; } }
        public WorkbenchHost(string directory) { queue=directory;activeWindowWake=new CurrentUiWindowWake(uiPeer.Current,uiPeer.Native,uiPeer.Process,uiPeer.ActiveWindow,uiPeer.Valid,uiPeer.Enabled,uiPeer.Iconic,uiPeer.Owner,uiPeer.Post); }
        private void InitializeFamilyApprovalObserver(UIApplication uiapp) { }
        private object Dispatch(UIApplication uiapp,string operation,Dictionary<string,object> args,string id,AccessPolicy.Binding access) {
            DispatchCalls++;Thread.Sleep(20);
            if(dispatchFailure)throw new InvalidOperationException("Controlled dispatch peer failed.");
            selectedDocument=Text(args,"expected_document");
            if(changeDocument&&uiapp!=null)uiapp.ActiveUIDocument.Document=new Document {PathName=preserveChangedDocumentPath?uiapp.ActiveUIDocument.Document.PathName:"D:\\changed.rvt"};
            if(replaceWrapper)uiapp.ActiveUIDocument.Document=uiapp.ActiveUIDocument.Document.AnotherWrapper();
            if(invalidateDocument)uiapp.ActiveUIDocument.Document.IsValidObject=false;
            if(changeView)uiapp.ActiveUIDocument.Document.ActiveView=new View {Id=new ElementId(13)};
            if(openAfterNull)uiapp.ActiveUIDocument=new UIDocument();
            return new {hostSession=session,operation,value="controlled; no Revit API"};
        }
        private string ExpectedDocument(Dictionary<string,object> args){return Text(args,"expected_document");}
        // ORIGINAL_DOCUMENT_VALIDATION
        private object Status(Document doc,AccessPolicy.Binding access){return new {hostSession=session,document=doc==null?null:new {path=doc.PathName,access=AccessPolicy.Evaluate(Root,access,doc.PathName,IsAllowed(doc.PathName),doc.IsReadOnly,doc.IsFamilyDocument,doc.IsLinked).Public},capabilities=new {atomicReadSnapshot=true}};}
        private object FreezeResult(object value){return json.DeserializeObject(json.Serialize(value));}
        private Assembly ResolvePrivateDependency(object sender,ResolveEventArgs args){return null;}
        // ORIGINAL_CURRENT_WINDOW_OWNER
        // ORIGINAL_TIMING_OWNER
        // ORIGINAL_IDLING
        // ORIGINAL_POLL_QUEUE
        // ORIGINAL_BACK_OFF
        // ORIGINAL_SCHEDULER_FAILURE
        // ORIGINAL_NEXT_REQUEST
        // ORIGINAL_EXECUTE
        // ORIGINAL_PROCESS_ONE
        // ORIGINAL_ATOMIC_READ
        // ORIGINAL_TEXT
        // ORIGINAL_WRITE_ATOMIC
        // ORIGINAL_DISPOSE
        private string AddRequest(string id,string expiry,bool wrongSession,bool wrongId,bool malformed) {
            var request=new { id=wrongId?Guid.NewGuid().ToString():id,targetSession=wrongSession?new string('b',32):session,operation="status",args=new {private_input="MUST_NOT_ENTER_TIMING"},createdUtc=DateTime.UtcNow.AddSeconds(-2).ToString("o"),expiresUtc=expiry };
            File.WriteAllText(Path.Combine(queue,"inbox",id+".json"),malformed?"{":json.Serialize(request));return id;
        }
        private static double Milliseconds(Dictionary<string,object> timing,string key) { double value=Convert.ToDouble(timing[key]);if(double.IsNaN(value)||double.IsInfinity(value)||value<0)throw new Exception("Invalid duration "+key);return value; }
        private static void Utc(Dictionary<string,object> timing,string key) { DateTime value;if(!(timing[key] is string)||!DateTime.TryParseExact((string)timing[key],"o",null,System.Globalization.DateTimeStyles.RoundtripKind,out value)||value.Kind!=DateTimeKind.Utc)throw new Exception("Invalid UTC "+key); }
        private object CheckPublication(string name) {
            foreach(string folder in new[]{"inbox","processing","outbox"})Directory.CreateDirectory(Path.Combine(queue,folder));
            string id=Guid.NewGuid().ToString(),expiry=DateTime.UtcNow.AddMinutes(1).ToString("o");AddRequest(id,expiry,false,false,false);
            var baseline=new {id,ok=true,result=new {hostSession=session,operation="status",value="controlled; no Revit API"},completedUtc=DateTime.UtcNow.ToString("o")};
            int baselineCharacters=json.Serialize(baseline).Length;
            json.MaxJsonLength=Math.Max(baselineCharacters,File.ReadAllText(Path.Combine(queue,"inbox",id+".json")).Length)+20;
            if(json.Serialize(baseline).Length>json.MaxJsonLength)throw new Exception("Baseline business envelope does not fit test budget");
            File.Reset();File.FailWrite=name=="publication-write-failure";File.FailRename=name=="publication-rename-failure";Execute(null);
            string outbox=Path.Combine(queue,"outbox",id+".json");
            if(DispatchCalls!=1||File.PublicationWrites!=1)throw new Exception("Business dispatch or publication write was repeated: "+name);
            if(name=="optional-timing-budget") {
                var response=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(outbox));
                if(!(bool)response["ok"]||response.ContainsKey("timing")||Convert.ToString(response["id"])!=id||File.PublicationRenames!=1)throw new Exception("Optional diagnostic changed original deliverability");
                return new {name,passed=true,dispatchCalls=DispatchCalls,budget=json.MaxJsonLength,baselineCharacters,publicationWrites=File.PublicationWrites,publicationRenames=File.PublicationRenames,response};
            }
            if(File.Exists(outbox)||File.PublicationRenames!=(File.FailWrite?0:1)||!File.Exists(Path.Combine(queue,"processing",id+".json")))throw new Exception("Unknown publication was retried or relabelled");
            bool retainedTemp=File.Exists(outbox+"."+session+".tmp");if(retainedTemp!=File.FailRename)throw new Exception("Original uncertain publication evidence changed");
            return new {name,passed=true,dispatchCalls=DispatchCalls,publicationWrites=File.PublicationWrites,publicationRenames=File.PublicationRenames,retainedTemp};
        }
        public object Check(string name) {
            if(name=="optional-timing-budget"||name=="publication-write-failure"||name=="publication-rename-failure")return CheckPublication(name);
            foreach(string folder in new[]{"inbox","processing","outbox"})Directory.CreateDirectory(Path.Combine(queue,folder));
            bool success=name=="matched-success"||name=="pending-result"||name=="different-next-request"||name=="unobserved-execute";
            bool dispatch=success||name=="dispatch-failure";
            string id=name=="different-next-request"?"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb":Guid.NewGuid().ToString();
            string expiry=name=="expired"?DateTime.UtcNow.AddMinutes(-1).ToString("o"):name=="invalid-deadline"?"not-a-deadline":DateTime.UtcNow.AddMinutes(1).ToString("o");
            AddRequest(id,expiry,name=="wrong-session",name=="wrong-id",name=="malformed-json");dispatchFailure=name=="dispatch-failure";
            if(name=="pending-result")externalEvent.Result=ExternalEventRequest.Pending;
            if(name!="unobserved-execute") { PollQueue(null);if(!eventPending||externalEvent.Raises!=1)throw new Exception("Event was not raised");Thread.Sleep(35); }
            string observedId=id;
            if(name=="different-next-request")AddRequest("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",expiry,false,false,false);
            Execute(null);
            var response=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(queue,"outbox",id+".json")));
            if((bool)response["ok"]!=success||Convert.ToString(response["id"])!=id||DispatchCalls!=(dispatch?1:0))throw new Exception("Original outcome/dispatch boundary changed: "+name);
            if(!success) {
                var execution=(Dictionary<string,object>)response["execution"];
                if((bool)execution["started"]!=dispatch||Convert.ToString(execution["phase"])!=(dispatch?"dispatch":"validation"))throw new Exception("Execution facts changed");
                var error=(Dictionary<string,object>)response["error"];
                if(name=="expired"&&(Convert.ToString(error["code"])!="WORKBENCH_REQUEST_EXPIRED"||Convert.ToString(execution["reason"])!="expired"))throw new Exception("Expired reason changed");
                if(name=="invalid-deadline"&&Convert.ToString(error["code"])!="WORKBENCH_REQUEST_INVALID_DEADLINE")throw new Exception("Deadline gate changed");
            }
            var timing=(Dictionary<string,object>)response["timing"];
            if(timing.Count!=18||Convert.ToInt32(timing["schemaVersion"])!=1||Convert.ToString(timing["requestId"])!=id||Convert.ToString(timing["hostSession"])!=session||json.Serialize(timing).Contains("MUST_NOT_ENTER_TIMING"))throw new Exception("Timing identity/bound failed");
            foreach(string key in new[]{"executeEnteredUtc","claimedUtc","responsePreparedUtc"})Utc(timing,key);
            double validation=Milliseconds(timing,"validationMs"),work=Milliseconds(timing,"hostWorkMs");
            if(work<validation)throw new Exception("Host work does not cover validation");
            if(dispatch) { Utc(timing,"dispatchStartedUtc");Utc(timing,"dispatchFinishedUtc");if(Milliseconds(timing,"dispatchMs")<10||work<validation+Milliseconds(timing,"dispatchMs"))throw new Exception("Dispatch segment missing"); }
            else foreach(string key in new[]{"dispatchStartedUtc","dispatchFinishedUtc","dispatchMs"})if(timing[key]!=null)throw new Exception("Invented Dispatch timing");
            bool matched=name!="unobserved-execute";
            if(Convert.ToString(timing["schedulerCorrelation"])!=(matched?"matched":"unmatched"))throw new Exception("Wrong scheduler correlation");
            if(matched) { Utc(timing,"observedUtc");Utc(timing,"raiseReturnedUtc");if(Milliseconds(timing,"observedToExecuteMs")<20||Convert.ToString(timing["raiseResult"])!=(name=="pending-result"?"Pending":"Accepted"))throw new Exception("Scheduler segment missing"); }
            else foreach(string key in new[]{"observedUtc","raiseReturnedUtc","observedToExecuteMs","raiseResult"})if(timing[key]!=null)throw new Exception("Borrowed scheduler facts");
            if(matched){var wake=(Dictionary<string,object>)timing["uiWake"];if(!(bool)wake["attempted"]||wake["postedUtc"]==null||wake["enteredUtc"]!=null)throw new Exception("Unverified UI entry was invented");}
            else if(timing["uiWake"]!=null)throw new Exception("Borrowed UI wake facts");
            if(matched){var idle=(Dictionary<string,object>)timing["uiIdle"];if(Convert.ToInt32(idle["afterRaiseCount"])!=0||Convert.ToInt32(idle["fastRequestCount"])!=0||idle["firstEnteredUtc"]!=null||idle["lastEnteredUtc"]!=null)throw new Exception("Unobserved Idling was invented");}
            else if(timing["uiIdle"]!=null)throw new Exception("Borrowed Idling facts");
            if(name=="different-next-request"&&(!File.Exists(Path.Combine(queue,"inbox","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json"))||File.Exists(Path.Combine(queue,"inbox",observedId+".json"))))throw new Exception("A later request replaced the accepted owner");
            if(eventPending||busy||pendingObservation!=null)throw new Exception("Scheduler owner not released");
            return new {name,passed=true,dispatchCalls=DispatchCalls,response};
        }
        public object CheckQueueOrder(string name) {
            File.Reset();
            foreach(string folder in new[]{"inbox","processing","outbox"})Directory.CreateDirectory(Path.Combine(queue,folder));
            string older="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",newer="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",valid="cccccccc-cccc-cccc-cccc-cccccccccccc";
            string expiry=DateTime.UtcNow.AddMinutes(1).ToString("o");
            DateTime stamp=new DateTime(2026,1,1,0,0,0,DateTimeKind.Utc);
            if(name=="queue-invalid-and-claimed-excluded") {
                File.WriteAllText(Path.Combine(queue,"inbox","not-a-guid.json"),"preserved-invalid-input");
                AddRequest(older,expiry,false,false,false);AddRequest(newer,expiry,false,false,false);AddRequest(valid,expiry,false,false,false);
                File.WriteAllText(Path.Combine(queue,"processing",older+".json"),"prior-claim");
                File.WriteAllText(Path.Combine(queue,"outbox",newer+".json"),"prior-receipt");
                if(NextRequest()!=Path.Combine(queue,"inbox",valid+".json"))throw new Exception("Preserved invalid or already-owned input blocked valid work");
                PollQueue(null);Execute(null);
                if(DispatchCalls!=1||NextRequest()!=null||File.ReadAllText(Path.Combine(queue,"processing",older+".json"))!="prior-claim"||File.ReadAllText(Path.Combine(queue,"outbox",newer+".json"))!="prior-receipt"||!File.Exists(Path.Combine(queue,"inbox","not-a-guid.json")))throw new Exception("A duplicate was executed, overwritten or discarded");
                return new {name,passed=true,dispatchCalls=DispatchCalls};
            }
            AddRequest(older,name=="queue-observed-expired"?DateTime.UtcNow.AddMinutes(-1).ToString("o"):expiry,false,false,false);
            System.IO.File.SetLastWriteTimeUtc(Path.Combine(queue,"inbox",older+".json"),stamp);
            string expected=older;
            bool beforeRaise=name=="queue-oldest-finalized-file"||name=="queue-time-tie";
            if(beforeRaise) {
                AddRequest(newer,expiry,false,false,false);
                System.IO.File.SetLastWriteTimeUtc(Path.Combine(queue,"inbox",newer+".json"),name=="queue-time-tie"?stamp:stamp.AddSeconds(1));
                expected=name=="queue-time-tie"?newer:older;
                if(NextRequest()!=Path.Combine(queue,"inbox",expected+".json"))throw new Exception("Finalized-file order or ordinal timestamp tie was not stable");
            }
            PollQueue(null);
            if(pendingObservation==null||pendingObservation.RequestId!=expected||externalEvent.Raises!=1)throw new Exception("Wrong request accepted");
            if(!beforeRaise) {
                AddRequest(newer,expiry,false,false,false);
                // Even a later file carrying an older timestamp cannot steal an
                // already-accepted callback. Timestamp order only selects new work.
                System.IO.File.SetLastWriteTimeUtc(Path.Combine(queue,"inbox",newer+".json"),stamp.AddSeconds(-1));
                if(NextRequest()!=Path.Combine(queue,"inbox",newer+".json"))throw new Exception("Fixture did not create a competing next request");
                if(name=="queue-observed-missing")System.IO.File.Delete(Path.Combine(queue,"inbox",older+".json"));
                if(name=="queue-observed-claimed")File.WriteAllText(Path.Combine(queue,"processing",older+".json"),"prior-claim");
                if(name=="queue-observed-receipt")File.WriteAllText(Path.Combine(queue,"outbox",older+".json"),"prior-receipt");
                if(name=="queue-observed-missing"||name=="queue-observed-claimed"||name=="queue-observed-receipt")expected=newer;
            }
            for(int i=0;i<100;i++)PollQueue(null);
            if(externalEvent.Raises!=1||DispatchCalls!=0)throw new Exception("Pending work was raised again or dispatched outside Execute");
            Execute(null);
            var response=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(queue,"outbox",expected+".json")));
            bool expired=name=="queue-observed-expired",matched=expected==(name=="queue-time-tie"?newer:older);
            var timing=(Dictionary<string,object>)response["timing"];
            if(Convert.ToString(response["id"])!=expected||(bool)response["ok"]==expired||DispatchCalls!=(expired?0:1)||Convert.ToString(timing["schedulerCorrelation"])!=(matched?"matched":"unmatched"))throw new Exception("Accepted identity, expiry or timing ownership changed");
            if(!matched&&(timing["observedUtc"]!=null||timing["raiseReturnedUtc"]!=null||timing["uiWake"]!=null||timing["uiIdle"]!=null))throw new Exception("A fallback request borrowed stale scheduler facts");
            if(expired) {
                var failure=(Dictionary<string,object>)response["error"];
                var execution=(Dictionary<string,object>)response["execution"];
                if(Convert.ToString(failure["code"])!="WORKBENCH_REQUEST_EXPIRED"||(bool)execution["started"]||!File.Exists(Path.Combine(queue,"inbox",newer+".json")))throw new Exception("Expiry gate was bypassed or next request was consumed");
            }
            if(name=="queue-observed-claimed"&&File.ReadAllText(Path.Combine(queue,"processing",older+".json"))!="prior-claim")throw new Exception("Prior claim was overwritten");
            if(name=="queue-observed-receipt"&&File.ReadAllText(Path.Combine(queue,"outbox",older+".json"))!="prior-receipt")throw new Exception("Prior receipt was overwritten");
            if(eventPending||busy||pendingObservation!=null||externalEvent.Raises!=1)throw new Exception("Callback owner remained pending or another event was raised");
            return new {name,passed=true,dispatchCalls=DispatchCalls,nativeRaises=externalEvent.Raises,executedRequest=expected,schedulerCorrelation=Convert.ToString(timing["schedulerCorrelation"])};
        }
        public object CheckAtomic(string name) {
            foreach(string folder in new[]{"inbox","processing","outbox"})Directory.CreateDirectory(Path.Combine(queue,folder));
            var uiapp=new UIApplication();var values=new Dictionary<string,object>();
            bool preparation=name.StartsWith("atomic-preparation-",StringComparison.Ordinal);
            if(name=="atomic-explicit-mismatch")values["expected_document"]="D:\\other.rvt";
            if(name=="atomic-null-status"||name=="atomic-null-health")uiapp.ActiveUIDocument=null;
            if(name=="atomic-native-document")values["element_id"]="9223372036854775807";
            if(name=="atomic-document-changed"||name=="atomic-preparation-document-changed")changeDocument=true;
            if(name=="atomic-equivalent-wrapper")replaceWrapper=true;
            if(name=="atomic-same-path-new-document"){changeDocument=true;preserveChangedDocumentPath=true;}
            if(name=="atomic-invalid-before")uiapp.ActiveUIDocument.Document.IsValidObject=false;
            if(name=="atomic-invalid-after")invalidateDocument=true;
            if(name=="atomic-view-changed"||name=="atomic-preparation-view-changed")changeView=true;
            if(name=="atomic-null-to-document"){uiapp.ActiveUIDocument=null;openAfterNull=true;}
            if(name=="atomic-project-binding-raw-queue") {
                foreach(bool explicitFalse in new[]{false,true}) {
                    string id=Guid.NewGuid().ToString();
                    var request=new Dictionary<string,object>{{"id",id},{"targetSession",session},{"operation","preview_project_parameter_binding"},{"args",new Dictionary<string,object>()},{"createdUtc",DateTime.UtcNow.AddSeconds(-1).ToString("o")},{"expiresUtc",DateTime.UtcNow.AddMinutes(1).ToString("o")}};
                    if(explicitFalse)request["atomicRead"]=false;
                    File.WriteAllText(Path.Combine(queue,"inbox",id+".json"),json.Serialize(request));
                    Execute(null);
                    var response=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(queue,"outbox",id+".json")));
                    if((bool)response["ok"] || DispatchCalls!=0)throw new Exception("Raw non-atomic project preview reached Dispatch");
                }
            } else if(name=="atomic-preparation-without-snapshot") {
                foreach(var request in new[]{new Dictionary<string,object>(),new Dictionary<string,object>{{"atomicRead",false}}}) {
                    bool rejected=false;try{AtomicReadRequested(request,"get_model_preparation");}catch(InvalidOperationException){rejected=true;}
                    if(!rejected||DispatchCalls!=0)throw new Exception("Model preparation admitted without an atomic snapshot");
                }
            } else if(name=="atomic-invalid-flag"||name=="atomic-write-refused") {
                var request=new Dictionary<string,object>{{"atomicRead",name=="atomic-invalid-flag"?(object)"true":true}};
                bool rejected=false;try{AtomicReadRequested(request,name=="atomic-write-refused"?"execute_csharp":"status");}catch(InvalidOperationException){rejected=true;}
                if(!rejected||DispatchCalls!=0)throw new Exception("Invalid atomic request admitted");
            } else if(name.StartsWith("idle-")) {
                var idle=new IdlingEventArgs();
                if(name!="idle-empty") { AddRequest(Guid.NewGuid().ToString(),DateTime.UtcNow.AddMinutes(1).ToString("o"),false,false,false);PollQueue(null); }
                if(name=="idle-bounded")pendingObservation=new SchedulerObservation(pendingObservation.RequestId,DateTime.UtcNow.AddSeconds(-3),Stopwatch.GetTimestamp()-Stopwatch.Frequency*3,DateTime.UtcNow,"Accepted");
                OnQueueIdling(null,idle);
                if(idle.FastRequests!=(name=="idle-empty"?0:1))throw new Exception("First UI idle did not receive the bounded wake-up");
                if(name=="idle-bounded") {
                    // Even if background observation was long ago, the window
                    // starts on UI entry; it must still expire and never replay.
                    if(!pendingObservation.UiIdleStartedTicks.HasValue||externalEvent.Raises!=1)throw new Exception("UI idle window did not own the accepted event");
                    pendingObservation.UiIdleStartedTicks=Stopwatch.GetTimestamp()-Stopwatch.Frequency*3;
                    var expired=new IdlingEventArgs();OnQueueIdling(null,expired);
                    if(expired.FastRequests!=0||externalEvent.Raises!=1||DispatchCalls!=0)throw new Exception("Expired idle window remained active or retried the event");
                    Execute(null);
                    var completed=new IdlingEventArgs();OnQueueIdling(null,completed);
                    if(completed.FastRequests!=0||eventPending||DispatchCalls!=1||externalEvent.Raises!=1)throw new Exception("Completed event retained fast idling or was replayed");
                }
            } else {
                bool rejected=false;object result=null;
                try{result=DispatchAtomicRead(uiapp,preparation?"get_model_preparation":name=="atomic-null-health"?"health":name=="atomic-native-document"?"get_element_geometry":name=="atomic-null-status"||name=="atomic-null-to-document"?"status":"get_selection",values,"fixture",null);}catch(InvalidOperationException){rejected=true;}
                bool expectedRejection=name=="atomic-explicit-mismatch"||name=="atomic-document-changed"||name=="atomic-same-path-new-document"||name=="atomic-invalid-before"||name=="atomic-invalid-after"||name=="atomic-view-changed"||name=="atomic-null-to-document"||name=="atomic-preparation-document-changed"||name=="atomic-preparation-view-changed";
                if(rejected!=expectedRejection)throw new Exception("Wrong atomic document outcome: "+name);
                if(name=="atomic-auto-bind"&&(selectedDocument!="D:\\fixture.rvt"||DispatchCalls!=1))throw new Exception("Missing single-dispatch document binding");
                if(name=="atomic-invalid-before"&&DispatchCalls!=0)throw new Exception("Invalid initial document reached Dispatch");
                if(name=="atomic-equivalent-wrapper"&&DispatchCalls!=1)throw new Exception("Equivalent native document was not read exactly once");
                if(preparation&&(DispatchCalls!=1||(rejected&&result!=null)))throw new Exception("Model preparation dispatched twice or leaked a partial result");
                if(!rejected) { var data=(Dictionary<string,object>)result;if(!(bool)data["atomicReadSnapshot"]||Convert.ToString(data["hostSession"])!=session)throw new Exception("Invalid atomic result identity"); }
            }
            return new {name,passed=true,dispatchCalls=DispatchCalls};
        }
        public object CheckSnapshotAtomic() {
            snapshotBridge=new SnapshotRevitBridge();var uiapp=new UIApplication();var args=new Dictionary<string,object>{{"action","status"}};
            bool rejected=false;try{AtomicReadRequested(new Dictionary<string,object>(),"get_snapshot_delta");}catch(InvalidOperationException){rejected=true;}
            if(!rejected||!AtomicReadRequested(new Dictionary<string,object>{{"atomicRead",true}},"get_snapshot_delta"))throw new Exception("Snapshot delta must require atomic read");
            var result=(Dictionary<string,object>)DispatchAtomicRead(uiapp,"get_snapshot_delta",args,"fixture",null);
            var value=(Dictionary<string,object>)result["value"];var doc=(Dictionary<string,object>)value["document"];
            if(snapshotBridge.Calls!=1 || (string)doc["path"]!="D:\\fixture.rvt" || (string)value["operation"]!="get_snapshot_delta" || (bool)value["modifiedByOperation"] || (string)result["hostSession"]!=session)throw new Exception("Snapshot atomic identity mismatch");
            bool mismatch=false;try{DispatchAtomicRead(uiapp,"get_snapshot_delta",new Dictionary<string,object>{{"action","status"},{"expected_document","D:\\other.rvt"}},"fixture",null);}catch(InvalidOperationException){mismatch=true;}
            if(!mismatch||snapshotBridge.Calls!=1)throw new Exception("Snapshot mismatched document dispatched");
            return new {name="snapshot-atomic",passed=true,dispatchCalls=snapshotBridge.Calls};
        }
        public object CheckBatchPreviewAtomic() {
            WorkbenchActions.BatchPreviewCalls=0;
            foreach(var request in new[]{new Dictionary<string,object>(),new Dictionary<string,object>{{"atomicRead",false}}}) {
                bool refused=false;try{AtomicReadRequested(request,"preview_batch_parameter_filter");}catch(InvalidOperationException){refused=true;}
                if(!refused||WorkbenchActions.BatchPreviewCalls!=0)throw new Exception("Batch preview admitted without atomic snapshot");
            }
            var args=new Dictionary<string,object>{{"category","OST_Walls"},{"parameter_id","-100"}};
            var result=(Dictionary<string,object>)DispatchAtomicRead(new UIApplication(),"preview_batch_parameter_filter",args,"fixture",null);
            var value=(Dictionary<string,object>)result["value"];var doc=(Dictionary<string,object>)value["document"];
            if(WorkbenchActions.BatchPreviewCalls!=1||(string)doc["path"]!="D:\\fixture.rvt"||(string)value["operation"]!="preview_batch_parameter_filter"||(bool)value["modifiedByOperation"]||(string)result["hostSession"]!=session)throw new Exception("Batch preview atomic identity mismatch");
            bool mismatch=false;try{DispatchAtomicRead(new UIApplication(),"preview_batch_parameter_filter",new Dictionary<string,object>{{"category","OST_Walls"},{"parameter_id","-100"},{"expected_document","D:\\other.rvt"}},"fixture",null);}catch(InvalidOperationException){mismatch=true;}
            if(!mismatch||WorkbenchActions.BatchPreviewCalls!=1)throw new Exception("Batch preview mismatched document dispatched");
            return new {name="batch-preview-atomic",passed=true,dispatchCalls=WorkbenchActions.BatchPreviewCalls};
        }
        public object CheckNamedRead(string operation) {
            var request = new Dictionary<string, object> { { "atomicRead", true } };
            if (!WorkbenchActions.IsRead(operation) || RequiresProjectEdit(operation) || !AtomicReadRequested(request, operation))
                throw new Exception("Named read did not enter the read-only atomic route: " + operation);
            if (operation == "preview_project_parameter_binding" || operation == "get_group_members" || operation == "calculate_material_quantities" || operation == "check_clashes") {
                bool rejected = false;
                try { AtomicReadRequested(new Dictionary<string, object>(), operation); }
                catch (InvalidOperationException) { rejected = true; }
                if (!rejected) throw new Exception("Named read was admitted without an atomic snapshot: " + operation);
            }
            var result = (Dictionary<string, object>)DispatchAtomicRead(new UIApplication(), operation,
                new Dictionary<string, object>(), "fixture", null);
            if (!(bool)result["atomicReadSnapshot"] || Convert.ToString(result["operation"]) != operation || DispatchCalls != 1 || selectedDocument != "D:\\fixture.rvt")
                throw new Exception("Named read did not bind its document and dispatch once: " + operation);
            return new {name=operation,passed=true,dispatchCalls=DispatchCalls};
        }
        public object CheckWake(string name) {
            File.Reset();
            CaptureApiThread(new UIApplication());
            foreach(string folder in new[]{"inbox","processing","outbox"})Directory.CreateDirectory(Path.Combine(queue,folder));
            string id=Guid.NewGuid().ToString();
            AddRequest(id,DateTime.UtcNow.AddMinutes(name=="wake-post-failure-expired"?-1:1).ToString("o"),false,false,false);
            if(name=="wake-raise-denied")externalEvent.Result=ExternalEventRequest.Denied;
            if(name=="wake-post-failure-expired")uiDispatcher.FailPost=true;
            if(name=="wake-shutdown")uiDispatcher.HasShutdownStarted=true;
            ExternalEvent originalEvent=externalEvent;
            PollQueue(null);
            if(File.Exists(Path.Combine(queue,"outbox",id+".json"))||DispatchCalls!=0)throw new Exception("Wake manufactured a business result");
            if(name=="wake-raise-denied") {
                if(eventPending||uiDispatcher.Posts!=0||pendingWakeOperation!=null)throw new Exception("Unaccepted event posted a wake");
            } else if(name=="wake-post-failure-expired") {
                if(!eventPending||pendingObservation.UiWakeState!="post_failed"||pendingObservation.UiWakeDiagnostic!="InvalidOperationException")throw new Exception("Post failure lost accepted native work");
                Execute(null);
                var failed=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(queue,"outbox",id+".json")));
                if((bool)failed["ok"]||DispatchCalls!=0||(bool)((Dictionary<string,object>)failed["execution"])["started"])throw new Exception("Expired work was forged successful after wake failure");
            } else if(name=="wake-shutdown") {
                if(uiDispatcher.Posts!=0||pendingObservation.UiWakeState!="unavailable")throw new Exception("Shutdown dispatcher admitted a post");
                Execute(null);if(DispatchCalls!=1)throw new Exception("Unavailable wake changed actual dispatch");
            } else {
                SchedulerObservation observation=pendingObservation;
                DispatcherOperation operation=pendingWakeOperation;
                if(operation==null||uiDispatcher.Posts!=1)throw new Exception("Accepted event did not own one wake");
                if(name=="wake-once-and-timing") {
                    PollQueue(null);PollQueue(null);operation.Deliver();PollQueue(null);
                    if(uiDispatcher.Posts!=1||originalEvent.Raises!=1||DispatchCalls!=0||!observation.UiWakeEnteredUtc.HasValue)throw new Exception("Wake repeated native work or entered without evidence");
                    Execute(null);
                    var receipt=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(queue,"outbox",id+".json")));
                    var timing=(Dictionary<string,object>)receipt["timing"];var wake=(Dictionary<string,object>)timing["uiWake"];
                    if(!(bool)receipt["ok"]||Convert.ToString(timing["requestId"])!=id||wake["enteredUtc"]==null||Convert.ToString(wake["state"])!="completed"||Convert.ToDouble(wake["postToEnteredMs"])<0||Convert.ToDouble(wake["enteredToExecuteMs"])<0)throw new Exception("Wake entry was not correlated to original Execute");
                } else if(name=="wake-stale-after-completion") {
                    operation.AbortReturnsFalse=true;Execute(null);
                    if(pendingWakeOperation!=operation)throw new Exception("Unconfirmed cancellation lost operation owner");
                    operation.Deliver();
                    if(observation.UiWakeEnteredUtc.HasValue||pendingWakeOperation!=null||DispatchCalls!=1||originalEvent.Raises!=1)throw new Exception("Late callback changed completed execution");
                } else if(name=="wake-stale-after-dispose"||name=="wake-abort-failure-retry") {
                    operation.AbortReturnsFalse=name=="wake-stale-after-dispose";operation.AbortThrows=name=="wake-abort-failure-retry";
                    bool cleanupPending=false;try{Dispose();}catch(InvalidOperationException){cleanupPending=true;}
                    if(!cleanupPending||pendingWakeOperation!=operation||!disposed||uiDispatcher.HasShutdownStarted||uiDispatcher.HasShutdownFinished)throw new Exception("Shutdown lost wake owner or shut down borrowed dispatcher");
                    if(name=="wake-abort-failure-retry") {if(observation.UiWakeCleanup!="failed")throw new Exception("Abort failure diagnostic missing");operation.AbortThrows=false;Dispose();}
                    operation.Deliver();Dispose();
                    if(observation.UiWakeEnteredUtc.HasValue||pendingWakeOperation!=null||DispatchCalls!=0||originalEvent.Raises!=1)throw new Exception("Stale callback escaped disposed owner");
                } else if(name=="wake-cleanup-blocks-next") {
                    operation.AbortReturnsFalse=true;Execute(null);
                    string next=Guid.NewGuid().ToString();AddRequest(next,DateTime.UtcNow.AddMinutes(1).ToString("o"),false,false,false);nextRaise=DateTime.MinValue;PollQueue(null);
                    SchedulerObservation nextObservation=pendingObservation;
                    if(uiDispatcher.Posts!=1||nextObservation.UiWakeState!="cleanup_pending"||nextObservation.UiWakePostedUtc.HasValue)throw new Exception("Outstanding wake accumulated another operation");
                    operation.Deliver();PollQueue(null);Execute(null);
                    if(uiDispatcher.Posts!=1||observation.UiWakeEnteredUtc.HasValue||nextObservation.UiWakeEnteredUtc.HasValue||pendingWakeOperation!=null||DispatchCalls!=2||originalEvent.Raises!=2)throw new Exception("Late old callback borrowed a new request identity");
                } else throw new Exception("Unknown wake check");
            }
            if(uiPeer.Posts!=(name=="wake-once-and-timing"?1:0))throw new Exception("Late, rejected or disposed wake posted a native message");
            return new {name,passed=true,dispatchCalls=DispatchCalls,posts=uiDispatcher.Posts,activeWindowMessagePosts=uiPeer.Posts,nativeRaises=originalEvent.Raises};
        }
        public object CheckThreadWake(string name) {
            File.Reset();
            foreach(string folder in new[]{"inbox","processing","outbox"})Directory.CreateDirectory(Path.Combine(queue,folder));
            UIApplication uiapp=new UIApplication();
            bool unbound=name=="thread-no-api-capture",executeCapture=name=="thread-execute-capture";
            Thread original=uiPeer.Managed;
            if(name=="thread-capture-null")uiPeer.Managed=null;
            if(name=="thread-capture-zero")uiPeer.NativeId=0;
            if(!unbound&&!executeCapture)CaptureApiThread(uiapp);
            if(name=="thread-different-managed")uiPeer.Managed=new Thread(delegate(){});
            if(name=="thread-different-native")uiPeer.NativeId=92;
            if(name=="thread-later-zero")uiPeer.NativeId=0;
            if(name=="thread-current-managed-error")uiPeer.ThrowManaged=true;
            if(name=="thread-current-native-error")uiPeer.ThrowNative=true;
            if(name=="thread-post-failure")uiPeer.PostSucceeds=false;
            if(name=="thread-post-exception")uiPeer.ThrowPost=true;
            if(name=="thread-recapture-clears") {uiPeer.Managed=null;CaptureApiThread(uiapp);uiPeer.Managed=original;}
            if(name=="thread-api-failure-clears") {uiPeer.ThrowNative=true;CaptureApiThread(uiapp);uiPeer.ThrowNative=false;}
            if(name=="thread-recapture-valid") {uiPeer.Managed=new Thread(delegate(){});uiPeer.NativeId=92;CaptureApiThread(uiapp);}
            if(name=="thread-pending-not-accepted")externalEvent.Result=ExternalEventRequest.Pending;
            string id=Guid.NewGuid().ToString();AddRequest(id,DateTime.UtcNow.AddMinutes(1).ToString("o"),false,false,false);
            PollQueue(null);
            if(executeCapture){
                // A legal Execute binds the current API thread for the next
                // event, even without an earlier Idling callback.
                Execute(uiapp);
                id=Guid.NewGuid().ToString();AddRequest(id,DateTime.UtcNow.AddMinutes(1).ToString("o"),false,false,false);PollQueue(null);
            }
            SchedulerObservation observation=pendingObservation;
            if(observation==null||pendingWakeOperation==null)throw new Exception("No original wake owner");
            pendingWakeOperation.Deliver();
            if(name=="thread-same-api-once"){EnterUiWake(observation);PollQueue(null);EnterUiWake(observation);}
            int expectedPosts=name=="thread-same-api-once"||executeCapture||name=="thread-recapture-valid"||name=="thread-post-failure"||name=="thread-post-exception"?1:0;
            string expectedState=name=="thread-same-api-once"||executeCapture||name=="thread-recapture-valid"?"posted":name=="thread-post-failure"?"post_failed":name=="thread-post-exception"||name=="thread-current-managed-error"||name=="thread-current-native-error"?"error_IOException":name=="thread-pending-not-accepted"?"not_attempted":"target_unverified";
            if(uiPeer.Posts!=expectedPosts||observation.ActiveWindowMessageState!=expectedState||observation.ActiveWindowMessageAttempted!=(expectedPosts==1)||expectedPosts==1&&uiPeer.LastPostedWindow!=uiPeer.Active||expectedState=="target_unverified"&&uiPeer.ActiveReads!=0)throw new Exception("Native message thread identity or diagnostics mismatch");
            if(DispatchCalls!=(executeCapture?1:0)||File.Exists(Path.Combine(queue,"outbox",id+".json")))throw new Exception("Message enqueue invented a business result");
            Execute(uiapp);
            var response=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(queue,"outbox",id+".json")));
            var timing=(Dictionary<string,object>)response["timing"];var message=(Dictionary<string,object>)((Dictionary<string,object>)timing["uiWake"])["activeWindowMessage"];
            if(!(bool)response["ok"]||Convert.ToString(message["kind"])!="WM_NULL"||Convert.ToString(message["state"])!=expectedState||(bool)message["attempted"]!=(expectedPosts==1)||uiPeer.Posts!=expectedPosts)throw new Exception("Message receipt or execution outcome changed");
            return new {name,passed=true,activeWindowMessagePosts=uiPeer.Posts,nativeRaises=externalEvent.Raises,dispatchCalls=DispatchCalls,message};
        }
        public object CheckActiveWindowWake(string name) {
            File.Reset();
            foreach(string folder in new[]{"inbox","processing","outbox"})Directory.CreateDirectory(Path.Combine(queue,folder));
            CaptureApiThread(new UIApplication());
            bool second=name=="active-reacquire-each-request"||name=="active-reused-foreign-window";
            if(name=="active-no-window")uiPeer.Active=IntPtr.Zero;
            if(name=="active-invalid-window")uiPeer.WindowValid=false;
            if(name=="active-other-process")uiPeer.WindowProcessId=778;
            if(name=="active-other-thread")uiPeer.WindowThreadId=92;
            if(name=="active-zero-owner") {uiPeer.WindowThreadId=0;uiPeer.WindowProcessId=0;}
            if(name=="active-changed-before-post")uiPeer.ChangeActive=true;
            if(name=="active-get-error")uiPeer.ThrowActive=true;
            if(name=="active-validity-error")uiPeer.ThrowValidity=true;
            if(name=="active-owner-error")uiPeer.ThrowOwner=true;
            if(name=="active-process-error")uiPeer.ThrowProcess=true;
            string id=Guid.NewGuid().ToString();AddRequest(id,DateTime.UtcNow.AddMinutes(1).ToString("o"),false,false,false);
            PollQueue(null);pendingWakeOperation.Deliver();
            if(second){
                if(uiPeer.Posts!=1||uiPeer.LastPostedWindow!=new IntPtr(42))throw new Exception("Initial current-window post missing");
                Execute(null);
                id=Guid.NewGuid().ToString();AddRequest(id,DateTime.UtcNow.AddMinutes(1).ToString("o"),false,false,false);
                if(name=="active-reacquire-each-request")uiPeer.Active=new IntPtr(43);
                else uiPeer.WindowProcessId=778;
                PollQueue(null);pendingWakeOperation.Deliver();
            }
            SchedulerObservation observation=pendingObservation;
            int expectedPosts=name=="active-reacquire-each-request"?2:name=="active-reused-foreign-window"?1:0;
            string expectedState=name=="active-no-window"?"no_active_window":name=="active-invalid-window"?"active_window_invalid":name=="active-other-process"||name=="active-other-thread"||name=="active-zero-owner"||name=="active-reused-foreign-window"?"active_window_unverified":name=="active-changed-before-post"?"active_window_changed":name=="active-reacquire-each-request"?"posted":"error_IOException";
            bool attempted=name=="active-reacquire-each-request";
            if(observation==null||uiPeer.Posts!=expectedPosts||observation.ActiveWindowMessageState!=expectedState||observation.ActiveWindowMessageAttempted!=attempted||name=="active-reacquire-each-request"&&(uiPeer.LastPostedWindow!=new IntPtr(43)||uiPeer.ActiveReads!=4))throw new Exception("Current-window ownership, freshness or diagnostics mismatch");
            if(DispatchCalls!=(second?1:0)||File.Exists(Path.Combine(queue,"outbox",id+".json")))throw new Exception("Window post invented a business result");
            Execute(null);
            var response=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(queue,"outbox",id+".json")));
            var timing=(Dictionary<string,object>)response["timing"];var message=(Dictionary<string,object>)((Dictionary<string,object>)timing["uiWake"])["activeWindowMessage"];
            if(!(bool)response["ok"]||Convert.ToString(message["kind"])!="WM_NULL"||Convert.ToString(message["state"])!=expectedState||(bool)message["attempted"]!=attempted||uiPeer.Posts!=expectedPosts||DispatchCalls!=(second?2:1))throw new Exception("Window message changed real execution or lost its receipt");
            return new {name,passed=true,activeWindowMessagePosts=uiPeer.Posts,nativeRaises=externalEvent.Raises,dispatchCalls=DispatchCalls,message};
        }
        public object CheckMainWindowWake(string name) {
            File.Reset();
            foreach(string folder in new[]{"inbox","processing","outbox"})Directory.CreateDirectory(Path.Combine(queue,folder));
            var uiapp=new UIApplication {MainWindow=new IntPtr(44)};
            CaptureApiThread(uiapp);
            uiPeer.Active=IntPtr.Zero;
            string expectedState="main_window_posted";
            IntPtr expectedTarget=uiapp.MainWindow;
            switch(name) {
                case "main-window-posted": break;
                case "main-window-active-preferred":
                    uiPeer.Active=expectedTarget=new IntPtr(42);expectedState="posted";break;
                case "main-window-active-appeared":
                    uiPeer.ChangeActive=true;expectedState="main_window_skipped_active";break;
                case "main-window-invalid":
                    uiPeer.WindowValid=false;expectedState="main_window_invalid";break;
                case "main-window-foreign-thread":
                    uiPeer.WindowThreadId=92;expectedState="main_window_unverified";break;
                case "main-window-foreign-process":
                    uiPeer.WindowProcessId=778;expectedState="main_window_unverified";break;
                case "main-window-disabled":
                    uiPeer.MainEnabled=false;expectedState="main_window_disabled";break;
                case "main-window-minimized":
                    uiPeer.MainIconic=true;expectedState="main_window_minimized";break;
                case "main-window-post-failure":
                    uiPeer.PostSucceeds=false;expectedState="main_window_post_failed";break;
                case "main-window-refreshed":
                    uiapp.MainWindow=expectedTarget=new IntPtr(45);CaptureApiThread(uiapp);break;
                case "main-window-recapture-error":
                    uiapp.ThrowMainWindow=true;CaptureApiThread(uiapp);expectedState="no_active_window";break;
                case "main-window-recapture-error-with-active":
                    uiapp.ThrowMainWindow=true;CaptureApiThread(uiapp);
                    uiPeer.Active=expectedTarget=new IntPtr(42);expectedState="posted";break;
                default: throw new Exception("Unknown main-window check");
            }
            bool attempted=expectedState=="main_window_posted"||expectedState=="main_window_post_failed"||expectedState=="posted";
            string id=Guid.NewGuid().ToString();
            string receiptFile=Path.Combine(queue,"outbox",id+".json");
            AddRequest(id,DateTime.UtcNow.AddMinutes(1).ToString("o"),false,false,false);
            PollQueue(null);
            SchedulerObservation observation=pendingObservation;
            pendingWakeOperation.Deliver();
            EnterUiWake(observation);
            PollQueue(null);
            if(uiPeer.Posts!=(attempted?1:0)||attempted&&uiPeer.LastPostedWindow!=expectedTarget||
                observation.ActiveWindowMessageState!=expectedState||observation.ActiveWindowMessageAttempted!=attempted)
                throw new Exception("Main-window fallback picked an invalid target, was repeated, or lost diagnostics");
            if(externalEvent.Raises!=1||DispatchCalls!=0||File.Exists(receiptFile))
                throw new Exception("Main-window fallback raised again or invented a business result");
            Execute(uiapp);
            var response=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(receiptFile));
            var timing=(Dictionary<string,object>)response["timing"];
            var message=(Dictionary<string,object>)((Dictionary<string,object>)timing["uiWake"])["activeWindowMessage"];
            if(!(bool)response["ok"]||Convert.ToString(message["state"])!=expectedState||(bool)message["attempted"]!=attempted||
                externalEvent.Raises!=1||DispatchCalls!=1)
                throw new Exception("Main-window fallback changed the original execution or receipt");
            return new {name,passed=true,activeWindowMessagePosts=uiPeer.Posts,nativeRaises=externalEvent.Raises,dispatchCalls=DispatchCalls,message};
        }
        public object CheckImmediateFollowUp() {
            File.Reset();
            foreach(string folder in new[]{"inbox","processing","outbox"})Directory.CreateDirectory(Path.Combine(queue,folder));
            string first=Guid.NewGuid().ToString(),second=Guid.NewGuid().ToString();
            AddRequest(first,DateTime.UtcNow.AddMinutes(1).ToString("o"),false,false,false);
            PollQueue(null);Execute(null);
            AddRequest(second,DateTime.UtcNow.AddMinutes(1).ToString("o"),false,false,false);
            var idle=new IdlingEventArgs();OnQueueIdling(null,idle);
            if(!eventPending||pendingObservation==null||pendingObservation.RequestId!=second||externalEvent.Raises!=2||idle.FastRequests!=1)
                throw new Exception("Successful completion suppressed the next available Revit Idling opportunity");
            Execute(null);
            if(DispatchCalls!=2||!File.Exists(Path.Combine(queue,"outbox",second+".json")))
                throw new Exception("Follow-up request did not retain its own execution and receipt");
            return new {name="idle-immediate-follow-up",passed=true,dispatchCalls=DispatchCalls,nativeRaises=externalEvent.Raises};
        }
        public object CheckIdleDiagnostics(string name) {
            File.Reset();
            foreach(string folder in new[]{"inbox","processing","outbox"})Directory.CreateDirectory(Path.Combine(queue,folder));
            bool initial=name=="idle-diagnostic-initial-raise",saturated=name=="idle-diagnostic-saturation",expired=name=="idle-diagnostic-expired",replaced=name=="idle-diagnostic-next-owner";
            string id=Guid.NewGuid().ToString();AddRequest(id,DateTime.UtcNow.AddMinutes(expired?-1:1).ToString("o"),false,false,false);
            if(initial){OnQueueIdling(null,new IdlingEventArgs());if(pendingObservation.UiIdleAfterRaiseCount!=0||pendingObservation.UiIdleFirstEnteredUtc.HasValue||pendingObservation.UiFastIdleRequestCount!=1)throw new Exception("Initial Raise callback counted as after-Raise idle");}
            else PollQueue(null);
            SchedulerObservation original=pendingObservation;
            if(saturated){original.UiIdleAfterRaiseCount=int.MaxValue;original.UiFastIdleRequestCount=int.MaxValue;}
            Thread.Sleep(3);OnQueueIdling(null,new IdlingEventArgs());
            if(!initial&&!saturated&&!expired&&!replaced){Thread.Sleep(3);OnQueueIdling(null,new IdlingEventArgs());}
            if(replaced){
                Execute(null);id=Guid.NewGuid().ToString();AddRequest(id,DateTime.UtcNow.AddMinutes(1).ToString("o"),false,false,false);nextRaise=DateTime.MinValue;PollQueue(null);
                if(Object.ReferenceEquals(original,pendingObservation)||pendingObservation.UiIdleAfterRaiseCount!=0||pendingObservation.UiIdleFirstEnteredUtc.HasValue||pendingObservation.UiFastIdleRequestCount!=0)throw new Exception("New request borrowed old Idling facts");
            }
            Execute(null);
            var response=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(queue,"outbox",id+".json")));
            var timing=(Dictionary<string,object>)response["timing"];var idle=(Dictionary<string,object>)timing["uiIdle"];
            int expected=saturated?int.MaxValue:replaced?0:initial||expired?1:2;
            if(Convert.ToInt32(idle["afterRaiseCount"])!=expected||(bool)idle["countsSaturated"]!=saturated||externalEvent.Raises!=(replaced?2:1)||DispatchCalls!=(expired?0:replaced?2:1)||(bool)response["ok"]==expired)throw new Exception("Idling diagnostic changed outcome/count/dispatch ownership");
            int fast=saturated?int.MaxValue:replaced?0:initial?2:expected;
            if(Convert.ToInt32(idle["fastRequestCount"])!=fast)throw new Exception("Fast-idle diagnostic changed strategy");
            if(replaced){foreach(string key in new[]{"firstEnteredUtc","lastEnteredUtc","observedToFirstMs","firstToExecuteMs","lastToExecuteMs"})if(idle[key]!=null)throw new Exception("Old idle timing escaped to new owner");}
            else{Utc(idle,"firstEnteredUtc");Utc(idle,"lastEnteredUtc");if(Milliseconds(idle,"observedToFirstMs")<0||Milliseconds(idle,"firstToExecuteMs")<Milliseconds(idle,"lastToExecuteMs"))throw new Exception("Idling timing order invalid");}
            return new {name,passed=true,dispatchCalls=DispatchCalls,nativeRaises=externalEvent.Raises,idle};
        }
        public static int Main(string[] args) {
            if(args.Length!=1)return 2;string root=Path.GetFullPath(args[0]);if(Directory.Exists(root))throw new Exception("Do not overwrite managed evidence");Directory.CreateDirectory(root);
            var results=new List<object>();string current=null;
            try {
                foreach(string name in new[]{"matched-success","dispatch-failure","expired","invalid-deadline","wrong-session","wrong-id","malformed-json","different-next-request","pending-result","unobserved-execute","optional-timing-budget","publication-write-failure","publication-rename-failure"}){current=name;results.Add(new WorkbenchHost(Path.Combine(root,name)).Check(name));}
                foreach(string name in new[]{"queue-oldest-finalized-file","queue-time-tie","queue-observed-retained","queue-observed-missing","queue-observed-claimed","queue-observed-receipt","queue-observed-expired","queue-invalid-and-claimed-excluded"}){current=name;results.Add(new WorkbenchHost(Path.Combine(root,name)).CheckQueueOrder(name));}
                foreach(string name in new[]{"atomic-project-binding-raw-queue","atomic-auto-bind","atomic-explicit-mismatch","atomic-document-changed","atomic-null-status","atomic-null-health","atomic-native-document","atomic-invalid-flag","atomic-write-refused","idle-empty","idle-pending","idle-bounded","atomic-equivalent-wrapper","atomic-same-path-new-document","atomic-invalid-before","atomic-invalid-after","atomic-view-changed","atomic-null-to-document"}){current=name;results.Add(new WorkbenchHost(Path.Combine(root,name)).CheckAtomic(name));}
                current="snapshot-atomic";results.Add(new WorkbenchHost(Path.Combine(root,current)).CheckSnapshotAtomic());
                current="batch-preview-atomic";results.Add(new WorkbenchHost(Path.Combine(root,current)).CheckBatchPreviewAtomic());
                foreach(string name in new[]{"atomic-preparation-success","atomic-preparation-document-changed","atomic-preparation-view-changed","atomic-preparation-without-snapshot"}){current=name;results.Add(new WorkbenchHost(Path.Combine(root,name)).CheckAtomic(name));}
                foreach(string operation in new[]{"preview_project_parameter_binding","get_warnings","get_rvt_links","get_link_instances","get_pipe_network","get_revision_sequences","get_schedule_data","get_group_members","calculate_material_quantities","check_clashes"}){current=operation;results.Add(new WorkbenchHost(Path.Combine(root,operation)).CheckNamedRead(operation));}
                foreach(string name in new[]{"wake-once-and-timing","wake-stale-after-completion","wake-stale-after-dispose","wake-abort-failure-retry","wake-post-failure-expired","wake-raise-denied","wake-shutdown","wake-cleanup-blocks-next"}){current=name;results.Add(new WorkbenchHost(Path.Combine(root,name)).CheckWake(name));}
                foreach(string name in new[]{"thread-no-api-capture","thread-same-api-once","thread-different-managed","thread-different-native","thread-capture-null","thread-capture-zero","thread-later-zero","thread-current-managed-error","thread-current-native-error","thread-post-failure","thread-post-exception","thread-pending-not-accepted","thread-recapture-clears","thread-api-failure-clears","thread-execute-capture","thread-recapture-valid"}){current=name;results.Add(new WorkbenchHost(Path.Combine(root,name)).CheckThreadWake(name));}
                foreach(string name in new[]{"active-no-window","active-invalid-window","active-other-process","active-other-thread","active-zero-owner","active-changed-before-post","active-get-error","active-validity-error","active-owner-error","active-process-error","active-reacquire-each-request","active-reused-foreign-window"}){current=name;results.Add(new WorkbenchHost(Path.Combine(root,name)).CheckActiveWindowWake(name));}
                foreach(string name in new[]{"main-window-posted","main-window-active-preferred","main-window-active-appeared","main-window-invalid","main-window-foreign-thread","main-window-foreign-process","main-window-disabled","main-window-minimized","main-window-post-failure","main-window-refreshed","main-window-recapture-error","main-window-recapture-error-with-active"}){current=name;results.Add(new WorkbenchHost(Path.Combine(root,name)).CheckMainWindowWake(name));}
                foreach(string name in new[]{"idle-diagnostic-initial-raise","idle-diagnostic-pending","idle-diagnostic-saturation","idle-diagnostic-next-owner","idle-diagnostic-expired"}){current=name;results.Add(new WorkbenchHost(Path.Combine(root,name)).CheckIdleDiagnostics(name));}
                current="idle-immediate-follow-up";results.Add(new WorkbenchHost(Path.Combine(root,current)).CheckImmediateFollowUp());
            } catch(Exception error) {
                results.Add(new {name=current,passed=false,diagnostic=error.GetType().Name,message=error.Message});
                Console.WriteLine(new JavaScriptSerializer().Serialize(new {checks=results.Count,results}));return 1;
            }
            Console.WriteLine(new JavaScriptSerializer().Serialize(new {scope="Original scheduler/claim/validation/receipt producer methods; controlled event and Dispatch peers; no Revit API",checks=results.Count,results}));return 0;
        }
    }
}
