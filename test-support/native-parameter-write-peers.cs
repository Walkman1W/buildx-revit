using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;

// Deterministic API peers only. No Autodesk assemblies, services or models load.
namespace Autodesk.Revit.UI {
    internal sealed class UIDocument { public Autodesk.Revit.DB.Document Document; }
    internal sealed class UIApplication { public UIDocument ActiveUIDocument; }
}
namespace Autodesk.Revit.DB {
    internal sealed class ElementId { public long Value; public ElementId(long value) { Value=value; } }
    internal sealed class ForgeTypeId {
        public string TypeId; public ForgeTypeId(string value) { TypeId=value; }
        public static bool operator ==(ForgeTypeId a,ForgeTypeId b) { return Object.ReferenceEquals(a,b)||!Object.ReferenceEquals(a,null)&&!Object.ReferenceEquals(b,null)&&a.TypeId==b.TypeId; }
        public static bool operator !=(ForgeTypeId a,ForgeTypeId b) { return !(a==b); }
        public override bool Equals(object value) { return this==value as ForgeTypeId; } public override int GetHashCode() { return TypeId.GetHashCode(); }
    }
    internal static class SpecTypeId { internal static class Boolean { internal static readonly ForgeTypeId YesNo=new ForgeTypeId("yesno"); } }
    internal enum StorageType { None,Integer,Double,String,ElementId }
    internal sealed class Definition { public string Name;public ForgeTypeId DataType; public ForgeTypeId GetDataType() { return DataType; } }
    internal sealed class Parameter {
        public ElementId Id; public Definition Definition; public StorageType StorageType; public bool IsReadOnly,HasValue;
        public object Value; public string Behavior; public Document Document; public Element Element;public int SetCalls,ReadCalls;
        private void BeforeRead() { ReadCalls++;if(Document.ReadsThrow)throw new InvalidOperationException("Controlled post-commit parameter read failure."); }
        public double AsDouble() { BeforeRead();return Convert.ToDouble(Value,CultureInfo.InvariantCulture); }
        public int AsInteger() { BeforeRead();return Convert.ToInt32(Value,CultureInfo.InvariantCulture); }
        public string AsString() { BeforeRead();return (string)Value; }
        public ElementId AsElementId() { BeforeRead();return (ElementId)Value; }
        private bool Store(object value) {
            SetCalls++;Document.Events.Add("Set:"+Id.Value);
            if(Behavior=="throws")throw new InvalidOperationException("Controlled Parameter.Set failure.");
            if(Behavior!="trueNoChange"&&Behavior!="falseNoChange") { Value=value;HasValue=true;Document.IsModified=true; }
            if(Behavior=="dataTypeDrift")Definition.DataType=new ForgeTypeId("changed-immediately");
            if(Behavior=="ownerDrift")Element=new ElementType { Id=Element.Id,Document=Document };
            return Behavior!="falseApplied"&&Behavior!="falseNoChange";
        }
        public bool Set(double value) { return Store(value); } public bool Set(int value) { return Store(value); } public bool Set(string value) { return Store(value); }
    }
    internal sealed class Category { public ElementId Id;public string Name; }
    internal class Element { public ElementId Id,LevelId=new ElementId(-1),TypeId=new ElementId(-1);public string Name="Controlled instance";public Category Category;public Document Document;public bool IsValidObject=true;public List<Parameter> Parameters=new List<Parameter>();public ElementId GetTypeId() { return TypeId; } }
    internal sealed class ElementType:Element { public string FamilyName="Controlled family"; }
    internal sealed class Document {
        public string Title="Parameter write fixture",PathName=@"D:\controlled\parameter-write.rvt",CommitBehavior="normal",RegenerateBehavior="normal",GroupBehavior="normal",StartBehavior="normal";
        public bool IsModified,IsReadOnly,IsLinked,IsFamilyDocument,ReadsThrow;public List<Element> Elements=new List<Element>();public List<string> Events=new List<string>();
        public int InnerStarts,InnerCommits,InnerRollbacks,Regenerates,GroupStarts,GroupCommits,GroupRollbacks;
        public Element GetElement(ElementId id) { return Elements.SingleOrDefault(element=>element.Id.Value==id.Value); }
        public void Drift() { foreach(Parameter p in Elements.SelectMany(element=>element.Parameters)) { if(p.StorageType==StorageType.Double)p.Value=Convert.ToDouble(p.Value)+1;else if(p.StorageType==StorageType.Integer)p.Value=Convert.ToInt32(p.Value)+1;else if(p.StorageType==StorageType.String)p.Value=(string)p.Value+"-drift"; } }
        public void Boundary(string behavior) {
            if(behavior=="drift")Drift();
            if(behavior=="removeElement")Elements.Clear();
            foreach(Element element in Elements) {
                if(behavior=="invalidElement")element.IsValidObject=false;
                if(behavior=="removeParameter")element.Parameters.Clear();
                foreach(Parameter p in element.Parameters) {
                    if(behavior=="storageChange")p.StorageType=p.StorageType==StorageType.Double?StorageType.Integer:StorageType.Double;if(behavior=="missingValue")p.HasValue=false;
                    if(behavior=="dataTypeDrift")p.Definition.DataType=new ForgeTypeId("changed-during-boundary");if(behavior=="dataTypeNull")p.Definition.DataType=null;
                    if(behavior=="ownerDrift")p.Element=new ElementType { Id=element.Id,Document=this };
                }
                if(behavior=="replaceParameter") {
                    var replacements=element.Parameters.Select(p=>new Parameter { Id=new ElementId(p.Id.Value),Definition=p.Definition,StorageType=p.StorageType,HasValue=p.HasValue,Value=p.StorageType==StorageType.Double?(object)(Convert.ToDouble(p.Value)+1):p.StorageType==StorageType.Integer?(object)(Convert.ToInt32(p.Value)+1):(object)((string)p.Value+"-replacement"),Behavior="normal",Document=this,Element=element }).ToList();
                    element.Parameters.Clear();element.Parameters.AddRange(replacements);
                }
            }
        }
        public void Regenerate() { Regenerates++;Events.Add("Regenerate");if(RegenerateBehavior=="throws")throw new InvalidOperationException("Controlled Regenerate failure.");Boundary(RegenerateBehavior); }
    }
    internal sealed class Snapshot {
        private sealed class State { internal Parameter Parameter;internal object Value;internal bool HasValue;internal StorageType Storage;internal ForgeTypeId DataType;internal Element Owner; }
        private readonly bool modified,readsThrow;private readonly List<Tuple<Element,List<Parameter>,bool>> elements;private readonly List<State> values;
        public Snapshot(Document doc) { modified=doc.IsModified;readsThrow=doc.ReadsThrow;elements=doc.Elements.Select(element=>Tuple.Create(element,element.Parameters.ToList(),element.IsValidObject)).ToList();values=doc.Elements.SelectMany(element=>element.Parameters).Select(p=>new State { Parameter=p,Value=p.Value,HasValue=p.HasValue,Storage=p.StorageType,DataType=p.Definition.DataType,Owner=p.Element }).ToList(); }
        public void Restore(Document doc) { doc.IsModified=modified;doc.ReadsThrow=readsThrow;doc.Elements.Clear();foreach(var element in elements){doc.Elements.Add(element.Item1);element.Item1.Parameters.Clear();element.Item1.Parameters.AddRange(element.Item2);element.Item1.IsValidObject=element.Item3;}foreach(var item in values){item.Parameter.Value=item.Value;item.Parameter.HasValue=item.HasValue;item.Parameter.StorageType=item.Storage;item.Parameter.Definition.DataType=item.DataType;item.Parameter.Element=item.Owner;} }
    }
    internal enum TransactionStatus { Uninitialized,Started,Committed,RolledBack,Pending,Error }
    internal enum FailureProcessingResult { Continue,ProceedWithRollBack }
    internal enum FailureSeverity { Warning,Error }
    internal interface IFailuresPreprocessor { FailureProcessingResult PreprocessFailures(FailuresAccessor accessor); }
    internal sealed class FailureMessageAccessor { public FailureSeverity GetSeverity() { return FailureSeverity.Error; } }
    internal sealed class FailuresAccessor { public IList<FailureMessageAccessor> GetFailureMessages() { return new List<FailureMessageAccessor>(); } }
    internal sealed class FailureHandlingOptions {
        public FailureHandlingOptions SetFailuresPreprocessor(IFailuresPreprocessor value) { return this; } public FailureHandlingOptions SetClearAfterRollback(bool value) { return this; }
    }
    internal sealed class Transaction:IDisposable {
        private readonly Document doc;private readonly Snapshot snapshot;private TransactionStatus status;
        public Transaction(Document document,string name) { doc=document;snapshot=new Snapshot(doc); }
        public TransactionStatus Start() { doc.InnerStarts++;doc.Events.Add("InnerStart");return status=doc.StartBehavior=="fail"?TransactionStatus.Error:TransactionStatus.Started; }
        public FailureHandlingOptions GetFailureHandlingOptions() { return new FailureHandlingOptions(); } public void SetFailureHandlingOptions(FailureHandlingOptions value) { }
        public TransactionStatus Commit() {
            doc.InnerCommits++;doc.Events.Add("InnerCommit");if(doc.CommitBehavior=="throws")throw new InvalidOperationException("Controlled Transaction.Commit failure.");
            if(doc.CommitBehavior=="rollback") { snapshot.Restore(doc);return status=TransactionStatus.RolledBack; }
            if(doc.CommitBehavior=="pending")return status=TransactionStatus.Pending;
            status=TransactionStatus.Committed;doc.Boundary(doc.CommitBehavior);if(doc.CommitBehavior=="readThrows")doc.ReadsThrow=true;return status;
        }
        public TransactionStatus RollBack() { doc.InnerRollbacks++;doc.Events.Add("InnerRollback");snapshot.Restore(doc);return status=TransactionStatus.RolledBack; }
        public TransactionStatus GetStatus() { return status; }
        public void Dispose() { if(status==TransactionStatus.Started)RollBack(); }
    }
    internal sealed class TransactionGroup:IDisposable {
        private readonly Document doc;private readonly Snapshot snapshot;private TransactionStatus status;
        public TransactionGroup(Document document,string name) { doc=document;snapshot=new Snapshot(doc); }
        public TransactionStatus Start() { doc.GroupStarts++;doc.Events.Add("GroupStart");return status=TransactionStatus.Started; }
        public TransactionStatus Assimilate() { doc.GroupCommits++;doc.Events.Add("GroupAssimilate");if(doc.GroupBehavior=="commitThrows")throw new InvalidOperationException("Controlled TransactionGroup.Assimilate failure.");return status=doc.GroupBehavior=="commitPending"?TransactionStatus.Pending:TransactionStatus.Committed; }
        public TransactionStatus RollBack() { doc.GroupRollbacks++;doc.Events.Add("GroupRollback");if(doc.GroupBehavior=="rollbackThrows"){status=TransactionStatus.Error;throw new InvalidOperationException("Controlled TransactionGroup.RollBack failure.");}if(doc.GroupBehavior=="rollbackPending")return status=TransactionStatus.Pending;snapshot.Restore(doc);return status=TransactionStatus.RolledBack; }
        public TransactionStatus GetStatus() { return status; } public void Dispose() { if(status==TransactionStatus.Started)RollBack(); }
    }
}
namespace RevitLocalCodex {
    using Autodesk.Revit.DB;
    using Autodesk.Revit.UI;
    internal static class NativeModelQueries {
        // PRODUCTION_EXACT_ID_METHODS
    }
    internal static class WorkbenchActions {
        // Exact production methods injected unchanged. Other operation bodies are
        // explicit unreachable peers because this suite only calls set_parameters.
        // PRODUCTION_ACTION_METHODS
        internal static object DescribeForPeer(Element element) { return DescribeElement(element); }
        private static object TransformElements(Document doc,string operation,Dictionary<string,object> args) { throw new InvalidOperationException("Out of scope transform peer."); }
        private static object CreateWall(UIApplication app,Dictionary<string,object> args) { throw new InvalidOperationException("Out of scope wall peer."); }
        private static object CreatePipe(UIApplication app,Dictionary<string,object> args) { throw new InvalidOperationException("Out of scope pipe peer."); }
    }
    internal static class ScriptRunner { internal static object Execute(UIApplication app,string code,string id,IDictionary<string,object> parameters) { throw new InvalidOperationException("Out of scope script peer."); } }
    internal static class ArgusTools { internal static object Annotate(UIApplication app,Dictionary<string,object> args) { throw new InvalidOperationException("Out of scope annotation peer."); }internal static object Schematic(UIApplication app,Dictionary<string,object> args) { throw new InvalidOperationException("Out of scope schematic peer."); } }
    internal static class SchematicRevitService { internal static object Export(UIApplication app,Dictionary<string,object> args) { throw new InvalidOperationException("Out of scope export peer."); } }
    internal sealed class Producer {
        private readonly JavaScriptSerializer json=new JavaScriptSerializer { MaxJsonLength=1024*1024,RecursionLimit=40 };
        // PRODUCTION_HOST_METHODS
        internal object Produce(UIApplication uiapp,string operation,Dictionary<string,object> args) {
            Document doc=uiapp.ActiveUIDocument==null?null:uiapp.ActiveUIDocument.Document;string id="controlled-parameter-write";object access=null;
            // PRODUCTION_HOST_WRITE_BRANCH
        }
        private static string Text(Dictionary<string,object> args,string key,string fallback="") { object value;return args.TryGetValue(key,out value)?Convert.ToString(value):fallback; }
        // The true access policy is covered independently. This peer preserves
        // exact production document identity checks, while granting this fixture.
        private static void RequireProjectEdit(Document doc,string expected,object access) { RequireDocument(doc,expected); }
    }
    internal static class NativeParameterWritePeerProgram {
        private static object Value(Dictionary<string,object> args,string key,object fallback) { object result;return args.TryGetValue(key,out result)?result:fallback; }
        private static string Text(Dictionary<string,object> args,string key,string fallback) { return Convert.ToString(Value(args,key,fallback),CultureInfo.InvariantCulture); }
        private static object Facts(Document doc) { return new { doc.IsModified,source_ids=doc.Elements.Select(element=>element.Id.Value.ToString(CultureInfo.InvariantCulture)).ToArray(),parameters=doc.Elements.SelectMany(element=>element.Parameters).Select(p=>new { parameter_id=p.Id.Value,id_exact=p.Id.Value.ToString(CultureInfo.InvariantCulture),storage_type=p.StorageType.ToString(),data_type=p.Definition.DataType==null?null:p.Definition.DataType.TypeId,owner_id=p.Element==null?null:p.Element.Id.Value.ToString(CultureInfo.InvariantCulture),owner_is_type=p.Element is ElementType,p.HasValue,value=p.Value is ElementId?(object)((ElementId)p.Value).Value:p.Value,p.SetCalls,p.ReadCalls }).ToArray() }; }
        public static int Main() {
            Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);var json=new JavaScriptSerializer { MaxJsonLength=1024*1024,RecursionLimit=40 };
            var input=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());var doc=new Document { CommitBehavior=Text(input,"commitBehavior","normal"),RegenerateBehavior=Text(input,"regenerateBehavior","normal"),GroupBehavior=Text(input,"groupBehavior","normal"),StartBehavior=Text(input,"startBehavior","normal"),IsModified=(bool)Value(input,"modifiedBefore",false) };
            Element element=(bool)Value(input,"sourceIsType",false)?new ElementType():new Element();element.Id=new ElementId(Convert.ToInt64(Value(input,"sourceId",100),CultureInfo.InvariantCulture));element.Document=doc;element.IsValidObject=!(bool)Value(input,"invalidElement",false);doc.Elements.Add(element);
            element.TypeId=new ElementId(Convert.ToInt64(Value(input,"typeId",-1),CultureInfo.InvariantCulture));element.LevelId=new ElementId(Convert.ToInt64(Value(input,"levelId",-1),CultureInfo.InvariantCulture));if(input.ContainsKey("categoryId"))element.Category=new Category { Id=new ElementId(Convert.ToInt64(input["categoryId"],CultureInfo.InvariantCulture)),Name="Controlled category" };
            var rawParameters=(IList)Value(input,"parameters",new object[0]);
            foreach(Dictionary<string,object> raw in rawParameters) {
                StorageType storage=(StorageType)Enum.Parse(typeof(StorageType),Text(raw,"storage","Double"));object value=Value(raw,"value",null);if(storage==StorageType.Double&&value!=null)value=Convert.ToDouble(value);if(storage==StorageType.Integer&&value!=null)value=Convert.ToInt32(value);if(storage==StorageType.ElementId&&value!=null)value=new ElementId(Convert.ToInt64(value));
                object dataType=Value(raw,"dataType",storage==StorageType.Double?"length":"text");string owner=Text(raw,"owner","instance");Element parameterOwner=owner=="null"?null:owner=="type"?new ElementType { Id=element.Id,Document=doc }:owner=="otherElement"?new Element { Id=new ElementId(999),Document=doc }:owner=="otherDocument"?new Element { Id=element.Id,Document=new Document() }:owner=="invalid"?new Element { Id=element.Id,Document=doc,IsValidObject=false }:element;
                element.Parameters.Add(new Parameter { Id=new ElementId(Convert.ToInt64(Value(raw,"id",1),CultureInfo.InvariantCulture)),StorageType=storage,Value=value,HasValue=(bool)Value(raw,"hasValue",value!=null),IsReadOnly=(bool)Value(raw,"readOnly",false),Behavior=Text(raw,"behavior","normal"),Definition=new Definition { Name=Text(raw,"name","同名参数"),DataType=dataType==null?null:new ForgeTypeId((string)dataType) },Document=doc,Element=parameterOwner });
            }
            var app=new UIApplication { ActiveUIDocument=new UIDocument { Document=doc } };var args=(Dictionary<string,object>)Value(input,"args",new Dictionary<string,object>());
            string operation=Text(input,"operation","set_parameters");
            if(!args.ContainsKey("expected_document"))args["expected_document"]=doc.PathName;if(!args.ContainsKey("mode")&&operation=="set_parameters")args["mode"]="commit";
            if(input.ContainsKey("parameterIdAsDouble"))((Dictionary<string,object>)((IList)args["changes"])[0])["parameter_id"]=Convert.ToDouble(((Dictionary<string,object>)((IList)args["changes"])[0])["parameter_id"],CultureInfo.InvariantCulture);
            if(input.ContainsKey("elementIdAsDouble"))((Dictionary<string,object>)((IList)args["changes"])[0])["element_id"]=Convert.ToDouble(((Dictionary<string,object>)((IList)args["changes"])[0])["element_id"],CultureInfo.InvariantCulture);
            // JSON cannot encode non-finite numbers; this controlled API input
            // injection exercises the unchanged production finite-number guard.
            string nonFinite=Text(input,"nonFiniteValue","");if(nonFinite!="")((Dictionary<string,object>)((IList)args["changes"])[0])["value"]=nonFinite=="nan"?Double.NaN:nonFinite=="negativeInfinity"?Double.NegativeInfinity:Double.PositiveInfinity;
            object before=Facts(doc),result=null,error=null;
            try { result=(bool)Value(input,"describeOnly",false)?WorkbenchActions.DescribeForPeer(element):(bool)Value(input,"innerOnly",false)?WorkbenchActions.Write(app,operation,args):new Producer().Produce(app,operation,args); }
            catch(Exception failure) { error=new { type=failure.GetType().Name,message=failure.Message }; }
            Console.WriteLine(json.Serialize(new { ok=error==null,result,result_json=(bool)Value(input,"describeOnly",false)?json.Serialize(result):null,error,before,after=Facts(doc),transactions=new { doc.InnerStarts,doc.InnerCommits,doc.InnerRollbacks,doc.Regenerates,doc.GroupStarts,doc.GroupCommits,doc.GroupRollbacks,events=doc.Events.ToArray() },scope="Controlled API peers executing actual production setter/transaction/Host group branch or DescribeElement; no real Revit/model" }));return 0;
        }
    }
}
