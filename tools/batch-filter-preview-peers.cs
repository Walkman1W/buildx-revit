using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
namespace Autodesk.Revit.DB {
 public enum BuiltInCategory { OST_Walls=-2000011, OST_Floors=-2000032 }
 public enum StorageType { Double,Integer,String,ElementId }
 public class ElementId { public long Value;public ElementId(long x){Value=x;} }
 public class Category { public ElementId Id;public static Category GetCategory(Document d,BuiltInCategory c){return new Category{Id=new ElementId((long)c)};} }
 public class Definition { public string DataType="text"; }
 public class Parameter { public ElementId Id;public Element Element;public bool IsReadOnly,HasValue=true;public StorageType StorageType;public object Value;public Definition Definition=new Definition(); }
 public class Element { public ElementId Id,LevelId,TypeId;public string UniqueId;public bool IsValidObject=true;public Document Document;public Category Category;public List<Parameter> Parameters=new List<Parameter>();public ElementId GetTypeId(){return TypeId;} }
 public class ElementType:Element {} public class Level:Element {}
 public class Document { public bool IsValidObject=true,IsFamilyDocument,IsLinked;public string PathName="D:\\fixture.rvt";public Dictionary<long,Element> Elements=new Dictionary<long,Element>(); }
 public class FilteredElementCollector:IDisposable,IEnumerable<Element> { Document d;BuiltInCategory category;public FilteredElementCollector(Document d){this.d=d;}public FilteredElementCollector OfCategory(BuiltInCategory c){category=c;return this;}public FilteredElementCollector WhereElementIsNotElementType(){return this;}public IEnumerator<Element> GetEnumerator(){return d.Elements.Values.Where(e=>!(e is ElementType)&&e.Category!=null&&e.Category.Id.Value==(long)category).GetEnumerator();}IEnumerator IEnumerable.GetEnumerator(){return GetEnumerator();}public void Dispose(){} }
}
namespace RevitLocalCodex {
 internal static class NativeModelQueries { internal class ReadBudget { public int Scanned;public ReadBudget(int max){}public void Scan(){if(++Scanned>20000)throw new InvalidOperationException("scan budget");}public void Reserve(object o){} }public static string SignedId(ElementId id){return id.Value.ToString();} }
 internal static partial class WorkbenchActions {
  static Element RequiredElement(Document d,long id){Element e;if(!d.Elements.TryGetValue(id,out e))throw new InvalidOperationException("missing");return e;}
  static Parameter ResolveInstanceParameter(Document d,long id,long pid,out Element owner){owner=RequiredElement(d,id);var matches=owner.Parameters.Where(x=>x.Id.Value==pid).ToArray();if(matches.Length!=1||matches[0].IsReadOnly||!Object.ReferenceEquals(matches[0].Element,owner))throw new InvalidOperationException("owner or parameter");return matches[0];}
  static object InternalValue(Parameter p){return p.HasValue?p.Value:null;}
  static string ParameterDataType(Parameter p){return p.Definition.DataType;}
 }
 class BatchFilterPreviewPeerProgram {
  static int checks;static void Check(bool ok,string label){if(!ok)throw new Exception(label);checks++;Console.WriteLine("PASS " + label);}static void Reject(Action f,string label){try{f();}catch(InvalidOperationException){checks++;Console.WriteLine("PASS " + label);return;}throw new Exception("Expected rejection: "+label);}
  static object Prop(object o,string key){return o.GetType().GetProperty(key).GetValue(o,null);}
  static Document Doc(int count=3){var d=new Document();var cat=Category.GetCategory(d,BuiltInCategory.OST_Walls);d.Elements[10]=new ElementType{Id=new ElementId(10),Category=cat,Document=d};d.Elements[20]=new Level{Id=new ElementId(20),Document=d};for(int i=0;i<count;i++){long id=100+i;var e=new Element{Id=new ElementId(id),UniqueId="uid-"+id,Category=cat,TypeId=new ElementId(10),LevelId=new ElementId(20),Document=d};e.Parameters.Add(new Parameter{Id=new ElementId(-100),Element=e,StorageType=StorageType.String,Value="old-"+id});d.Elements[id]=e;}return d;}
  static object Preview(Document d,long? type=10,long? level=20){return WorkbenchActions.PreviewBatchParameterFilter(d,"OST_Walls",type,level,-100);}
  static void Main(){var d=Doc();var value=Preview(d);var rows=(object[])Prop(value,"items");Check((bool)Prop(value,"complete")&&(int)Prop(value,"total")==3&&(int)Prop(value,"scanned")==3,"complete bounded instance preview");Check((string)Prop(rows[0],"element_id")=="100"&&(string)Prop(rows[2],"element_id")=="102"&&(string)Prop(rows[0],"value_internal")=="old-100","sorted exact identities and raw values");Check((string)Prop(value,"write_authorization")=="not_granted","preview grants no write authority");
   var guard=BatchFilterFactsGuard.Create("host",d,value,"String",null,"new");guard.Compare("host",d,Preview(d),"String",null,"new");Check(true,"actual preview accepted by guard");d.Elements[100].Parameters[0].Value="drift";Reject(()=>guard.Compare("host",d,Preview(d),"String",null,"new"),"actual preview raw state drift rejected");d=Doc();value=Preview(d);guard=BatchFilterFactsGuard.Create("host",d,value,"String",null,"new");d.Elements.Remove(102);Reject(()=>guard.Compare("host",d,Preview(d),"String",null,"new"),"actual complete membership drift rejected");
   d=Doc(51);Reject(()=>Preview(d),"over 50 matching elements rejects entire preview");d=Doc();d.Elements[100].Parameters[0].IsReadOnly=true;Reject(()=>Preview(d),"read-only target rejects all");d=Doc();d.Elements[100].Parameters.Clear();Reject(()=>Preview(d),"missing parameter rejects all");d=Doc();d.Elements[100].Parameters[0].Element=d.Elements[101];Reject(()=>Preview(d),"wrong owner rejects all");d=Doc();d.Elements[100].Parameters[0].StorageType=StorageType.ElementId;Reject(()=>Preview(d),"non-scalar parameter rejected");d=Doc();d.Elements[101].UniqueId=d.Elements[100].UniqueId;Reject(()=>Preview(d),"duplicate UniqueId rejected");d=Doc();Reject(()=>WorkbenchActions.PreviewBatchParameterFilter(d,"Walls",10,20,-100),"ambiguous display category rejected");Reject(()=>Preview(d,20,20),"wrong type identity rejected");Reject(()=>Preview(d,10,10),"wrong level identity rejected");d=Doc(0);Check((int)Prop(Preview(d),"total")==0,"empty complete match is explicit");Console.WriteLine("PASS total="+checks);
  }
 }
}
