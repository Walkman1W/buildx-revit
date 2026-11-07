using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace BuildX.FamilyRevit {
 internal sealed class RevitProjectDocumentSource {
  private readonly int apiThreadId;
  // ACTUAL_NATIVE_DOCUMENT_IDENTITY
 }
}
namespace Autodesk.Revit.DB {
 internal static partial class SpecTypeId { internal static class Boolean { internal static readonly ForgeTypeId YesNo=new ForgeTypeId("yesno"); } }
 internal partial class ElementType { public string FamilyName="Controlled family"; }
 internal sealed partial class Parameter {
  internal Document PeerDocument;internal int SetCalls;internal string SetBehavior;
  private bool Store(object value) {
   SetCalls++;PeerDocument.SetCalls++;PeerDocument.Events.Add("Set");
   if(SetBehavior=="throws")throw new InvalidOperationException("Controlled Set exception.");
   if(SetBehavior!="trueNoChange"&&SetBehavior!="falseNoChange"){Value=value;HasValue=true;PeerDocument.IsModified=true;}
   TypeWritePeerControl.Mutate("set",PeerDocument);
   return SetBehavior!="falseApplied"&&SetBehavior!="falseNoChange";
  }
  public bool Set(double value){return Store(value);}public bool Set(int value){return Store(value);}public bool Set(string value){return Store(value);}
 }
 internal sealed partial class Document {
  public bool IsLinked,IsValidObject=true;internal string NativeKey=Guid.NewGuid().ToString("N");
  internal int SetCalls,InnerCommits,InnerRollbacks,GroupCommits,GroupRollbacks;internal List<string> Events=new List<string>();
  public override bool Equals(object value){var other=value as Document;return other!=null&&IsValidObject&&other.IsValidObject&&NativeKey==other.NativeKey;}
  public override int GetHashCode(){return NativeKey.GetHashCode();}
  public void Regenerate(){Events.Add("Regenerate");TypeWritePeerControl.Mutate("regenerate",this);}
 }
 internal enum TransactionStatus {Uninitialized,Started,Committed,RolledBack,Pending}
 internal enum FailureProcessingResult {Continue,ProceedWithRollBack}
 internal enum FailureSeverity {Warning,Error}
 internal interface IFailuresPreprocessor {FailureProcessingResult PreprocessFailures(FailuresAccessor a);}
 internal sealed class FailureMessageAccessor {public FailureSeverity GetSeverity(){return FailureSeverity.Error;}}
 internal sealed class FailuresAccessor {public IList<FailureMessageAccessor> GetFailureMessages(){return new List<FailureMessageAccessor>();}}
 internal sealed class FailureHandlingOptions {public FailureHandlingOptions SetFailuresPreprocessor(IFailuresPreprocessor p){return this;}public FailureHandlingOptions SetClearAfterRollback(bool b){return this;}}
 internal sealed class TypeWriteSnapshot {
  private readonly List<Element> elements;private readonly Dictionary<Element,List<Parameter>> lists;private readonly Dictionary<Element,ElementId> types;private readonly List<Tuple<Parameter,object,bool,bool,StorageType,ForgeTypeId,Element>> values;private readonly bool modified;
  internal TypeWriteSnapshot(Document doc){modified=doc.IsModified;elements=doc.Elements.ToList();types=elements.ToDictionary(e=>e,e=>e.TypeId);lists=elements.ToDictionary(e=>e,e=>e.Parameters.ToList());values=elements.SelectMany(e=>e.Parameters).Select(p=>Tuple.Create(p,p.Value,p.HasValue,p.IsReadOnly,p.StorageType,p.Definition.DataType,p.Element)).ToList();}
  internal void Restore(Document doc){doc.IsModified=modified;doc.Elements.Clear();doc.Elements.AddRange(elements);foreach(var pair in types)pair.Key.TypeId=pair.Value;foreach(var pair in lists){pair.Key.Parameters.Clear();pair.Key.Parameters.AddRange(pair.Value);}foreach(var s in values){s.Item1.Value=s.Item2;s.Item1.HasValue=s.Item3;s.Item1.IsReadOnly=s.Item4;s.Item1.StorageType=s.Item5;s.Item1.Definition.DataType=s.Item6;s.Item1.Element=s.Item7;}}
 }
 internal sealed class Transaction:IDisposable {
  private readonly Document doc;private readonly TypeWriteSnapshot snapshot;private TransactionStatus status;
  public Transaction(Document d,string name){doc=d;snapshot=new TypeWriteSnapshot(d);}
  public TransactionStatus Start(){TypeWritePeerControl.Mutate("start",doc);doc.Events.Add("InnerStart");return status=TransactionStatus.Started;}
  public FailureHandlingOptions GetFailureHandlingOptions(){return new FailureHandlingOptions();}public void SetFailureHandlingOptions(FailureHandlingOptions o){}
  public TransactionStatus Commit(){doc.InnerCommits++;doc.Events.Add("InnerCommit");string behavior=TypeWritePeerControl.Text("commitStatus","");if(behavior=="throws")throw new InvalidOperationException("Controlled Commit exception.");if(behavior=="pending")return status=TransactionStatus.Pending;if(behavior=="rollback"){snapshot.Restore(doc);return status=TransactionStatus.RolledBack;}status=TransactionStatus.Committed;TypeWritePeerControl.Mutate("commit",doc);return status;}
  public TransactionStatus RollBack(){doc.InnerRollbacks++;snapshot.Restore(doc);return status=TransactionStatus.RolledBack;}public TransactionStatus GetStatus(){return status;}public void Dispose(){if(status==TransactionStatus.Started)RollBack();}
 }
 internal sealed class TransactionGroup:IDisposable {
  private readonly Document doc;private readonly TypeWriteSnapshot snapshot;private TransactionStatus status;
  public TransactionGroup(Document d,string name){doc=d;snapshot=new TypeWriteSnapshot(d);}public TransactionStatus Start(){return status=TransactionStatus.Started;}
  public TransactionStatus Assimilate(){doc.GroupCommits++;return status=TransactionStatus.Committed;}
  public TransactionStatus RollBack(){doc.GroupRollbacks++;string behavior=TypeWritePeerControl.Text("rollbackStatus","");if(behavior=="throws"){status=TransactionStatus.Pending;throw new InvalidOperationException("Controlled outer rollback exception.");}if(behavior=="pending")return status=TransactionStatus.Pending;snapshot.Restore(doc);return status=TransactionStatus.RolledBack;}
  public TransactionStatus GetStatus(){return status;}public void Dispose(){if(status==TransactionStatus.Started)RollBack();}
 }
 internal static class TypeWritePeerControl {
  internal static Dictionary<string,object> Input;internal static long Tick;internal static int Captures;
  internal static object Get(string key,object fallback){object value;return Input.TryGetValue(key,out value)?value:fallback;}
  internal static string Text(string key,string fallback){return Convert.ToString(Get(key,fallback),CultureInfo.InvariantCulture);}
  internal static IEnumerable<Element> Enumerate(IEnumerable<Element> values){Captures++;foreach(var value in values)yield return value;}
  internal static void Mutate(string stage,Document doc){
   object raw;if(!Input.TryGetValue(stage,out raw)||!(raw is string))return;string action=(string)raw;
   if(action=="delay"||action.StartsWith("delay:",StringComparison.Ordinal)){Thread.Sleep(action=="delay"?5100:Int32.Parse(action.Substring(6),CultureInfo.InvariantCulture));return;}var type=doc.Elements.OfType<ElementType>().FirstOrDefault();if(type==null)return;Parameter p=type.Parameters.FirstOrDefault();
   if(action=="value")p.Value=p.StorageType==StorageType.String?(object)((string)p.Value+"-drift"):p.StorageType==StorageType.Integer?(object)(Convert.ToInt32(p.Value)+1):(object)(Convert.ToDouble(p.Value)+1);
   if(action=="storage")p.StorageType=p.StorageType==StorageType.Double?StorageType.Integer:StorageType.Double;
   if(action=="data_type")p.Definition.DataType=new ForgeTypeId("changed");
   if(action=="owner")p.Element=new Element {Id=type.Id,Document=doc};
   if(action=="ownerOtherDocument")p.Element=new ElementType {Id=type.Id,Document=new Document()};
   if(action=="ownerWrongId")p.Element=new ElementType {Id=new ElementId(2222),Document=doc};
   if(action=="hasValue")p.HasValue=false;
   if(action=="readonly")p.IsReadOnly=true;
   if(action=="add"||action=="501"){int count=action=="501"?501:1;for(int index=0;index<count;index++)doc.Add(new Element {Id=new ElementId(10000+index),TypeId=type.Id});}
   if(action=="remove"){Element item=doc.Elements.FirstOrDefault(e=>!(e is ElementType));if(item!=null)doc.Elements.Remove(item);}
   if(action=="retarget"){Element item=doc.Elements.FirstOrDefault(e=>!(e is ElementType));if(item!=null)item.TypeId=new ElementId(-1);}
   if(action=="swap"){Element item=doc.Elements.FirstOrDefault(e=>!(e is ElementType));if(item!=null){doc.Elements.Remove(item);doc.Add(new Element {Id=new ElementId(9999),TypeId=type.Id});}}
   if(action=="typeToInstance"){var replacement=new Element {Id=type.Id,Document=doc};replacement.Parameters.AddRange(type.Parameters);doc.Elements[doc.Elements.IndexOf(type)]=replacement;}
  }
 }
}
namespace RevitLocalCodex {
 internal static class AccessPolicy {internal sealed class Binding {}}
 internal static partial class WorkbenchActions {
  private sealed class MaterialAssignmentExpectation {}
  private static object SetElementMaterial(Document doc, Dictionary<string,object> args, out MaterialAssignmentExpectation expectation){expectation=null;throw new InvalidOperationException("Out of scope material assignment peer.");}
  private static void VerifyElementMaterial(Document doc, MaterialAssignmentExpectation expectation){throw new InvalidOperationException("Out of scope material assignment peer.");}

        // View-template writes are outside this parameter-write fixture.
        private static object ApplyViewTemplate(Document doc, Dictionary<string, object> args, out ElementId before) { before = null; throw new InvalidOperationException("Out of scope view-template peer."); }
        private static object VerifyViewTemplate(Document doc, Dictionary<string, object> args, ElementId before = null) { throw new InvalidOperationException("Out of scope view-template peer."); }
        // Window placement is outside this fixture; window producer tests exercise the real methods.
        private static object PlaceWindow(Document doc, Dictionary<string, object> args, BasicCreatedExpectation created) { throw new InvalidOperationException("Out of scope window-write peer."); }
        private static object ReadWindow(Document doc, Dictionary<string, object> args, ElementId id) { throw new InvalidOperationException("Out of scope window-write peer."); }

  internal static bool IsRead(string op){return NativeParameterQueries.IsRead(op)||NativeModelQueries.IsRead(op);}
  internal static object Read(UIApplication app,string op,Dictionary<string,object> args){return NativeParameterQueries.IsRead(op)?NativeParameterQueries.Read(app,op,args):NativeModelQueries.Read(app,op,args);}
  private sealed class BasicCreatedExpectation { internal ElementId Id; }
        // The parameter producer extracts the shared dispatcher; unrelated
        // operations fail closed here and are covered by dedicated fixtures.
        private sealed class SheetDuplicationExpectation {}
        private static SheetDuplicationExpectation DuplicateEmptySheet(Document d, Dictionary<string,object> a){throw new InvalidOperationException("Out of scope sheet duplicate peer.");}
        private static object VerifyDuplicatedSheet(Document d, Dictionary<string,object> a, SheetDuplicationExpectation e){throw new InvalidOperationException("Out of scope sheet duplicate peer.");}
        private sealed class SheetRenumberExpectation {}
        private static List<SheetRenumberExpectation> RenumberSheets(Document d, Dictionary<string,object> a){throw new InvalidOperationException("Out of scope sheet renumber peer.");}
        private static object VerifyRenumberSheets(Document d, List<SheetRenumberExpectation> e){throw new InvalidOperationException("Out of scope sheet renumber peer.");}
        private sealed class MirrorExpectation {}
        private static MirrorExpectation MirrorOne(Document d, Dictionary<string,object> a){throw new InvalidOperationException("Out of scope mirror peer.");}
        private static object VerifyMirror(Document d, Dictionary<string,object> a, MirrorExpectation e){throw new InvalidOperationException("Out of scope mirror peer.");}
        private sealed class TitleblockWriteExpectation {}
        private static TitleblockWriteExpectation PrepareTitleblockWrite(Document d, Dictionary<string,object> a){throw new InvalidOperationException("Out of scope titleblock peer.");}
        private static object WriteTitleblockParameters(Document d, Dictionary<string,object> a, TitleblockWriteExpectation e, List<ParameterWriteExpectation> w){throw new InvalidOperationException("Out of scope titleblock peer.");}
        private static void VerifyTitleblockOwner(Document d, TitleblockWriteExpectation e){throw new InvalidOperationException("Out of scope titleblock peer.");}
        private sealed class UngroupExpectation {}
        private static UngroupExpectation UngroupOne(Document d, Dictionary<string,object> a){throw new InvalidOperationException("Out of scope ungroup peer.");}
        private static object VerifyUngroup(Document d, UngroupExpectation e){throw new InvalidOperationException("Out of scope ungroup peer.");}
        private sealed class BeamCreationExpectation {} private sealed class TypeChangeExpectation {} private sealed class GroupCreationExpectation {} private sealed class RoofCreationExpectation {}
        private static BeamCreationExpectation CreateBeam(UIApplication u, Dictionary<string,object> a){throw new InvalidOperationException("Out of scope beam peer.");}
        private static object VerifyBeam(Document d, Dictionary<string,object> a, BeamCreationExpectation e){throw new InvalidOperationException("Out of scope beam peer.");}
        private static TypeChangeExpectation ChangeElementType(Document d, Dictionary<string,object> a){throw new InvalidOperationException("Out of scope type peer.");}
        private static object VerifyTypeChange(Document d, TypeChangeExpectation e){throw new InvalidOperationException("Out of scope type peer.");}
        private static GroupCreationExpectation CreateModelGroup(Document d, Dictionary<string,object> a){throw new InvalidOperationException("Out of scope group peer.");}
        private static object VerifyModelGroup(Document d, GroupCreationExpectation e){throw new InvalidOperationException("Out of scope group peer.");}
        private static RoofCreationExpectation CreateFlatRoof(UIApplication u, Dictionary<string,object> a){throw new InvalidOperationException("Out of scope roof peer.");}
        private static object VerifyFlatRoof(Document d, Dictionary<string,object> a, RoofCreationExpectation e){throw new InvalidOperationException("Out of scope roof peer.");}
        private static object CreateColumn(Document d, Dictionary<string,object> a, BasicCreatedExpectation e){throw new InvalidOperationException("Out of scope column peer.");}
        private static object ReadColumn(Document d, Dictionary<string,object> a, ElementId id){throw new InvalidOperationException("Out of scope column peer.");}
  private static object CreateFoundation(Document d, Dictionary<string,object> a, BasicCreatedExpectation c) { throw new InvalidOperationException("Foundation is covered by its dedicated peer fixture."); }
  private static object ReadFoundation(Document d, Dictionary<string,object> a, ElementId id) { throw new InvalidOperationException("Foundation is covered by its dedicated peer fixture."); }

  private static object BasicWrite(UIApplication app,string op,Dictionary<string,object> args,BasicCreatedExpectation created){throw new InvalidOperationException("Out of scope basic-write peer.");}
  private static void VerifyPinned(Document doc,Dictionary<string,object> args,bool desired){throw new InvalidOperationException("Out of scope basic-write peer.");}
  private static object ReadBasicCreated(Document doc,string op,Dictionary<string,object> args,ElementId id){throw new InvalidOperationException("Out of scope basic-write peer.");}
  private static object TransformElements(Document d,string op,Dictionary<string,object> a){throw new InvalidOperationException("Out of scope transform peer.");}private static object CreateWall(UIApplication app,Dictionary<string,object> a){throw new InvalidOperationException("Out of scope wall peer.");}private static object CreatePipe(UIApplication app,Dictionary<string,object> a){throw new InvalidOperationException("Out of scope pipe peer.");}
 }
 internal static class ScriptRunner {internal static object Execute(UIApplication app,string code,string id,IDictionary<string,object> p){throw new InvalidOperationException("Out of scope script peer.");}}
 internal static class ArgusTools {internal static object Annotate(UIApplication app,Dictionary<string,object> a){throw new InvalidOperationException("Out of scope annotation peer.");}internal static object Schematic(UIApplication app,Dictionary<string,object> a){throw new InvalidOperationException("Out of scope schematic peer.");}}
 internal static class SchematicRevitService {internal static object Export(UIApplication app,Dictionary<string,object> a){throw new InvalidOperationException("Out of scope export peer.");}}
 internal sealed class TypeWriteHostPeer {
  private readonly string session=TypeWritePeerControl.Text("hostSession","controlled-host");private TypeParameterWriteApproval typeParameterApprovals;
  private readonly JavaScriptSerializer json=new JavaScriptSerializer {MaxJsonLength=1024*1024,RecursionLimit=40};
  // ACTUAL_ATOMIC_OPERATIONS
  // ACTUAL_HOST_METHODS
  internal TypeWriteHostPeer(){var source=new BuildX.FamilyRevit.RevitProjectDocumentSource(Thread.CurrentThread.ManagedThreadId);typeParameterApprovals=new TypeParameterWriteApproval(session,source.SameOpenDocument,()=>TypeWritePeerControl.Tick,1000,()=>DateTime.UtcNow);}
  internal object Prepare(UIApplication app,Dictionary<string,object> proposal,bool privateProposal){var args=new Dictionary<string,object>{{"type_id",proposal["type_id"]},{"parameter_id",proposal["parameter_id"]},{"expected_document",proposal["expected_document"]}};if(privateProposal)args["type_write_proposal"]=proposal;return DispatchAtomicRead(app,"get_type_parameter_impact",args,"prepare",null);}
  internal object Write(UIApplication app,Dictionary<string,object> args){return Dispatch(app,"set_type_parameter",args,"write",null);}
  private object Dispatch(UIApplication uiapp,string operation,Dictionary<string,object> args,string id,AccessPolicy.Binding access){Document doc=uiapp.ActiveUIDocument.Document;
   // ACTUAL_READ_BRANCH
   // ACTUAL_WRITE_BRANCH
  }
  private object Status(Document doc,AccessPolicy.Binding access){return new {document=new {title=doc.Title,path=doc.PathName},hostVersion="0.8.8",hostSession=session,capabilities=new {atomicReadSnapshot=true,nativeParameterQueriesVersion=1,nativeParameterQueryOperations=new[]{"get_type_parameter_impact"},nativeTypeParameterWritesVersion=1,nativeTypeParameterWriteOperations=new[]{"set_type_parameter"}}};}
  private static string Text(Dictionary<string,object> args,string key,string fallback=""){object value;return args.TryGetValue(key,out value)?Convert.ToString(value):fallback;}
  private static void RequireProjectEdit(Document doc,string expected,AccessPolicy.Binding access){RequireDocument(doc,expected);if((bool)TypeWritePeerControl.Get("denyPermission",false)||doc.IsFamilyDocument||doc.IsLinked||doc.IsReadOnly)throw new InvalidOperationException("Controlled project-edit permission denied.");}
 }
 internal static class NativeTypeWritePeerProgram {
  private static object Facts(Document doc){return new {doc.IsModified,instance_total=doc.Elements.Count(e=>!(e is ElementType)),instances=doc.Elements.Where(e=>!(e is ElementType)).Take(1000).Select(e=>new {id=e.Id.Value.ToString(CultureInfo.InvariantCulture),type=e.TypeId.Value.ToString(CultureInfo.InvariantCulture)}).ToArray(),parameters=doc.Elements.SelectMany(e=>e.Parameters).Select(p=>new {p.HasValue,p.IsReadOnly,storage=p.StorageType.ToString(),data_type=p.Definition.DataType.TypeId,owner_type=p.Element is ElementType,value=p.Value is ElementId?(object)((ElementId)p.Value).Value.ToString(CultureInfo.InvariantCulture):p.Value}).ToArray()};}
  private static object Counters(Document doc){return new {doc.SetCalls,doc.InnerCommits,doc.InnerRollbacks,doc.GroupCommits,doc.GroupRollbacks,captures=TypeWritePeerControl.Captures,events=doc.Events.ToArray(),realRevitExecuted=false};}
  public static int Main(string[] cli){
   bool session=cli.Length==1&&cli[0]=="--session";
   Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);var json=new JavaScriptSerializer {MaxJsonLength=16*1024*1024,RecursionLimit=40};TypeWritePeerControl.Input=json.Deserialize<Dictionary<string,object>>(session?Console.ReadLine():Console.In.ReadToEnd());
   var doc=new Document {PathName=TypeWritePeerControl.Text("documentPath",@"D:\controlled\type-write.rvt"),Title="Type write fixture",IsModified=(bool)TypeWritePeerControl.Get("modifiedBefore",false),IsFamilyDocument=(bool)TypeWritePeerControl.Get("familyDocument",false),IsLinked=(bool)TypeWritePeerControl.Get("linkedDocument",false),IsReadOnly=(bool)TypeWritePeerControl.Get("readOnlyDocument",false),IsValidObject=!(bool)TypeWritePeerControl.Get("invalidDocument",false)};long typeId=Convert.ToInt64(TypeWritePeerControl.Get("typeId","1000"),CultureInfo.InvariantCulture),parameterId=Convert.ToInt64(TypeWritePeerControl.Get("parameterId","-123"),CultureInfo.InvariantCulture);
   var type=new ElementType {Id=new ElementId(typeId),Name="类型中文"};doc.Add(type);StorageType storage=(StorageType)Enum.Parse(typeof(StorageType),TypeWritePeerControl.Text("storage","Double"));object original=TypeWritePeerControl.Get("before",storage==StorageType.String?(object)"原值":(object)1);if(original!=null)original=storage==StorageType.Double?(object)Convert.ToDouble(original):storage==StorageType.Integer?(object)Convert.ToInt32(original):original;
   var p=new Parameter {Id=new ElementId(parameterId),Element=type,PeerDocument=doc,Definition=new Definition {Name="参数",DataType=new ForgeTypeId(TypeWritePeerControl.Text("dataType",storage==StorageType.Double?SpecTypeId.Length.TypeId:"text"))},StorageType=storage,HasValue=(bool)TypeWritePeerControl.Get("hasValue",original!=null),IsReadOnly=(bool)TypeWritePeerControl.Get("readOnly",false),Value=original,Display=TypeWritePeerControl.Text("display","304.8 mm"),SetBehavior=TypeWritePeerControl.Text("setBehavior","normal")};type.Parameters.Add(p);
   int count=Convert.ToInt32(TypeWritePeerControl.Get("instanceCount",2));for(int i=count-1;i>=0;i--)doc.Add(new Element {Id=new ElementId(100+i),TypeId=type.Id,Name="实例"});
   int unrelated=Convert.ToInt32(TypeWritePeerControl.Get("unrelatedCount",0));for(int i=0;i<unrelated;i++)doc.Add(new Element {Id=new ElementId(30000+i),TypeId=new ElementId(-1)});
   var state=new Dictionary<string,object>{{"storage_type",storage.ToString()},{"has_value",p.HasValue},{"value_internal",original},{"data_type",p.Definition.DataType.TypeId}};
   object desired=TypeWritePeerControl.Get("value",storage==StorageType.String?(object)"新值":(object)2);
   var args=new Dictionary<string,object>{{"expected_document",doc.PathName},{"type_id",typeId.ToString(CultureInfo.InvariantCulture)},{"parameter_id",parameterId.ToString(CultureInfo.InvariantCulture)},{"value",desired},{"expected_state",state},{"expected_instance_ids",Enumerable.Range(0,count).Select(i=>(object)(100+i).ToString(CultureInfo.InvariantCulture)).ToArray()}};if(storage==StorageType.Double)args["value_unit"]="internal";if(TypeWritePeerControl.Input.ContainsKey("mode"))args["mode"]=TypeWritePeerControl.Text("mode","rollback");
   object overrideArgs=TypeWritePeerControl.Get("args",null);if(overrideArgs!=null)args=(Dictionary<string,object>)overrideArgs;
   var app=new UIApplication {ActiveUIDocument=new UIDocument {Document=doc}};var host=new TypeWriteHostPeer();object before=Facts(doc),prepared=null,result=null,error=null,replay=null;string approvalMode=TypeWritePeerControl.Text("approvalMode","valid");
   if(session){
    string line;while((line=Console.ReadLine())!=null){result=null;error=null;before=Facts(doc);try{var command=json.Deserialize<Dictionary<string,object>>(line);string action=Convert.ToString(command["action"]);object supplied;var callArgs=command.TryGetValue("args",out supplied)?(Dictionary<string,object>)supplied:args;
     if(action=="prepare"||action=="read")result=host.Prepare(app,callArgs,action=="prepare");
     else if(action=="write")result=host.Write(app,callArgs);
     else if(action=="clock")TypeWritePeerControl.Tick=Convert.ToInt64(command["ticks"]);
     else if(action=="mutate"){TypeWritePeerControl.Input["external"]=command["kind"];TypeWritePeerControl.Mutate("external",doc);}
     else if(action=="configure"){foreach(var pair in (Dictionary<string,object>)command["values"])TypeWritePeerControl.Input[pair.Key]=pair.Value;}
     else if(action=="differentDocument"){var other=new Document {PathName=doc.PathName,Title=doc.Title};other.Elements.AddRange(doc.Elements);app.ActiveUIDocument.Document=other;}
     else if(action=="sameNativeWrapper"){var other=new Document {PathName=doc.PathName,Title=doc.Title,NativeKey=doc.NativeKey};other.Elements.AddRange(doc.Elements);foreach(var element in other.Elements)element.Document=other;app.ActiveUIDocument.Document=other;doc=other;}
     else if(action!="facts")throw new InvalidOperationException("Unknown controlled session action.");
    }catch(Exception e){error=new {type=e.GetType().Name,message=e.Message};}Console.WriteLine(json.Serialize(new {ok=error==null,result,error,before,after=Facts(doc),facts=Counters(doc)}));}return 0;
   }
   try {
    if(approvalMode!="missing"&&approvalMode!="forged"&&approvalMode!="malformed")prepared=host.Prepare(app,args,!(bool)TypeWritePeerControl.Get("normalRead",false));
    if((bool)TypeWritePeerControl.Get("prepareOnly",false)){result=prepared;}
    else{
     var wire=new Dictionary<string,object>(args);if(prepared!=null){var decoded=json.Deserialize<Dictionary<string,object>>(json.Serialize(prepared));wire["approved_type_write"]=decoded["type_write_preparation"];var preparation=(Dictionary<string,object>)wire["approved_type_write"];wire["approved_type_write"]=new Dictionary<string,object>{{"schema_version",1},{"token",preparation["token"]}};}
     if(approvalMode=="forged")wire["approved_type_write"]=new Dictionary<string,object>{{"schema_version",1},{"token",new string('0',32)}};
     if(approvalMode=="malformed")wire["approved_type_write"]=new Dictionary<string,object>{{"schema_version",1},{"token","bad"}};
     if(approvalMode=="expired")TypeWritePeerControl.Tick=120000;
     if(approvalMode=="differentDocument"){var other=new Document {PathName=doc.PathName,Title=doc.Title};other.Elements.AddRange(doc.Elements);app.ActiveUIDocument.Document=other;}
     if(approvalMode=="tampered")wire["value"]=storage==StorageType.String?(object)"tampered":(object)3;
     TypeWritePeerControl.Mutate("beforeWrite",doc);result=host.Write(app,wire);
     if(approvalMode=="replay")try{host.Write(app,wire);replay=new {ok=true};}catch(Exception e){replay=new {ok=false,message=e.Message};}
    }
   }catch(Exception e){error=new {type=e.GetType().Name,message=e.Message};}
   Console.WriteLine(json.Serialize(new {ok=error==null,result,error,preparation=prepared,replay,before,after=Facts(doc),facts=Counters(doc)}));return 0;
  }
 }
}
