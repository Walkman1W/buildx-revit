using System;
using System.Collections.Generic;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
namespace Autodesk.Revit.DB {
 public enum BuiltInCategory { OST_TitleBlocks=-2000280, Other=-1 }
 public class ElementId { public long Value; public ElementId(long v){Value=v;} public ElementId(BuiltInCategory v){Value=(long)v;} }
 public class Category { public ElementId Id; }
 public class Element { public ElementId Id; public string Name; public bool Pinned; public bool IsValidObject=true; public Category Category; public ElementId OwnerViewId; public virtual ElementId GetTypeId(){return null;} }
 public class ElementType:Element {}
 public class FamilySymbol:ElementType {}
 public class FamilyInstance:Element { public ElementId TypeId; public override ElementId GetTypeId(){return TypeId;} }
 public class FilteredElementCollector:IDisposable { Document d; ElementId owner; BuiltInCategory category; public FilteredElementCollector(Document d){this.d=d;} public FilteredElementCollector OwnedByView(ElementId id){owner=id;return this;} public FilteredElementCollector OfCategory(BuiltInCategory c){category=c;return this;} public FilteredElementCollector WhereElementIsNotElementType(){return this;} public IList<Element> ToElements(){var result=new List<Element>();foreach(var e in d.Elements.Values)if(!(e is ElementType) && e.OwnerViewId!=null && e.OwnerViewId.Value==owner.Value && e.Category!=null && e.Category.Id.Value==(long)category)result.Add(e);return result;} public void Dispose(){} }
 public enum ViewFamily { FloorPlan, ThreeDimensional }
 public enum ViewType { FloorPlan, ThreeD }
 public class ViewFamilyType:ElementType { public ViewFamily ViewFamily; }
 public class Level:Element { public double ProjectElevation; public static Level Create(Document d,double n){throw new Exception("unused");} }
 public class View:Element { public bool IsTemplate; public ViewType ViewType; public ElementId TypeId; public override ElementId GetTypeId(){return TypeId;} }
 public class ViewPlan:View { public Level GenLevel; public static ViewPlan Create(Document d,ElementId t,ElementId l){d.Calls++; var v=new ViewPlan { Id=new ElementId(100), TypeId=t, GenLevel=(Level)d.GetElement(l), ViewType=ViewType.FloorPlan }; d.Elements[v.Id.Value]=v; return v;} }
 public class View3D:View { public bool IsPerspective; public static View3D CreateIsometric(Document d,ElementId t){d.Calls++; var v=new View3D { Id=new ElementId(101), TypeId=t, ViewType=ViewType.ThreeD }; d.Elements[v.Id.Value]=v; return v;} }
 public class ViewSheet:View { public string SheetNumber; public bool IsPlaceholder; public static ViewSheet CreatePlaceholder(Document d){d.Calls++;var s=new ViewSheet{Id=new ElementId(104),IsPlaceholder=true};d.Elements[104]=s;return s;} public static ViewSheet Create(Document d,ElementId type){d.Calls++;var s=new ViewSheet{Id=new ElementId(104)};d.Elements[104]=s;d.Elements[105]=new FamilyInstance{Id=new ElementId(105),OwnerViewId=s.Id,Category=new Category{Id=new ElementId(BuiltInCategory.OST_TitleBlocks)},TypeId=type};return s;} }
 public class XYZ { public double X,Y,Z; public XYZ(double x=0,double y=0,double z=0){X=x;Y=y;Z=z;} public double DistanceTo(XYZ p){return Math.Sqrt(Math.Pow(X-p.X,2)+Math.Pow(Y-p.Y,2)+Math.Pow(Z-p.Z,2));} }
 public class Line { public XYZ A,B; public bool IsBound=true; public static Line CreateBound(XYZ a,XYZ b){return new Line{A=a,B=b};} public XYZ GetEndPoint(int i){return i==0?A:B;} }
 public class LocationCurve { public object Curve; }
 public enum BuiltInParameter { RBS_CONDUIT_DIAMETER_PARAM, RBS_DUCT_SYSTEM_TYPE_PARAM } public enum StorageType { Double, ElementId }
 public class Parameter { public StorageType StorageType=StorageType.Double; public bool HasValue=true,IsReadOnly; public double Value; public ElementId IdValue; public ElementId AsElementId(){return IdValue;} public double AsDouble(){return Value;} public bool Set(double v){if(IsReadOnly)return false;Value=v;return true;} }
 public class Grid:Element { public object Curve; public static Grid Create(Document d,Line l){throw new Exception("unused");} }
 public class Document { public bool IsFamilyDocument; public bool ReverseConduit,FailDiameter,ReverseDuct; public Dictionary<long,Element> Elements=new Dictionary<long,Element>(); public int Calls; public Action<Document> OnCommit; public Element GetElement(ElementId id){Element e; return Elements.TryGetValue(id.Value,out e)?e:null;} public void Regenerate(){} }
 public enum TransactionStatus { Started, Committed, RolledBack }
 public class FailureHandlingOptions { public FailureHandlingOptions SetFailuresPreprocessor(object p){return this;} public FailureHandlingOptions SetClearAfterRollback(bool v){return this;} }
 public class Transaction:IDisposable { Document d; TransactionStatus s; public Transaction(Document d,string n){this.d=d;} public TransactionStatus Start(){return s=TransactionStatus.Started;} public FailureHandlingOptions GetFailureHandlingOptions(){return new FailureHandlingOptions();} public void SetFailureHandlingOptions(FailureHandlingOptions o){} public TransactionStatus Commit(){s=TransactionStatus.Committed;if(d.OnCommit!=null)d.OnCommit(d);return s;} public TransactionStatus GetStatus(){return s;} public void RollBack(){s=TransactionStatus.RolledBack;} public void Dispose(){} }
}
namespace Autodesk.Revit.DB.Electrical {
 using Autodesk.Revit.DB;
 public class ConduitType:ElementType {}
 public class Conduit:Element { public bool IsValidObject=true; public ElementId TypeId; public Level ReferenceLevel; public object Location; public Parameter Diameter=new Parameter(); public override ElementId GetTypeId(){return TypeId;} public Parameter get_Parameter(BuiltInParameter p){return Diameter;} public static Conduit Create(Document d,ElementId t,XYZ a,XYZ b,ElementId l){d.Calls++; var c=new Conduit{Id=new ElementId(102),TypeId=t,ReferenceLevel=(Level)d.GetElement(l),Location=new LocationCurve{Curve=Line.CreateBound(d.ReverseConduit?b:a,d.ReverseConduit?a:b)}};c.Diameter.IsReadOnly=d.FailDiameter;d.Elements[102]=c;return c;} }
}
namespace Autodesk.Revit.DB.Mechanical {
 using Autodesk.Revit.DB;
 public class DuctType:ElementType {} public class MechanicalSystemType:ElementType {}
 public class Duct:Element { public bool IsValidObject=true; public ElementId TypeId; public Level ReferenceLevel; public object Location; public Parameter SystemParameter; public override ElementId GetTypeId(){return TypeId;} public Parameter get_Parameter(BuiltInParameter p){return SystemParameter;} public static Duct Create(Document d,ElementId s,ElementId t,ElementId l,XYZ a,XYZ b){d.Calls++;var x=new Duct{Id=new ElementId(103),TypeId=t,ReferenceLevel=(Level)d.GetElement(l),SystemParameter=new Parameter{StorageType=StorageType.ElementId,IdValue=s},Location=new LocationCurve{Curve=Line.CreateBound(d.ReverseDuct?b:a,d.ReverseDuct?a:b)}};d.Elements[103]=x;return x;} }
}
namespace Autodesk.Revit.UI { public class UIDocument { public Document Document; } public class UIApplication { public UIDocument ActiveUIDocument; } }
namespace RevitLocalCodex {
 internal static class NativeModelQueries { internal static long ExactId(Dictionary<string,object> a,string k){object v=a[k];if(v==null || !(v is long) || (long)v<=0)throw new InvalidOperationException("invalid id");return (long)v;} }
 internal static partial class WorkbenchActions {
  class ParameterWriteExpectation {} class RejectErrors {}
  static object WriteTypeParameter(UIApplication u,Dictionary<string,object>a){throw new Exception("unused");}
  static object SetParameters(Document d,Dictionary<string,object>a,List<ParameterWriteExpectation> e,bool g){throw new Exception("unused");}
  static object TransformElements(Document d,string o,Dictionary<string,object>a){throw new Exception("unused");}
  static object CreateWall(UIApplication u,Dictionary<string,object>a){throw new Exception("unused");}
  static object CreatePipe(UIApplication u,Dictionary<string,object>a){throw new Exception("unused");}
  static void VerifyParameterWrites(Document d,List<ParameterWriteExpectation> e){}
  static void Fields(Dictionary<string,object>a,params string[] names){foreach(var k in a.Keys)if(Array.IndexOf(names,k)<0)throw new InvalidOperationException("unexpected field");}
  static object Required(Dictionary<string,object>a,string k){return a[k];}
  static string OptionalString(Dictionary<string,object>a,string k,string fallback){object v;return a.TryGetValue(k,out v)?(string)v:fallback;}
  static long ElementIdValue(object v,string k){return Convert.ToInt64(v);}
  static Element RequiredElement(Document d,long id){var e=d.GetElement(new ElementId(id));if(e==null)throw new InvalidOperationException("missing element");return e;}
  static object DescribedId(ElementId id){return id==null?null:(object)id.Value;}
  static double Feet(double v){return v/304.8;} static double Millimeters(double v){return v*304.8;}
  static double FiniteNumber(object v,string n){return Convert.ToDouble(v);} static double PositiveLength(object v,string n){double x=FiniteNumber(v,n);if(x<=0)throw new InvalidOperationException();return Feet(x);} static XYZ MillimeterPoint(object v,string n){var p=(double[])v;return new XYZ(Feet(p[0]),Feet(p[1]),Feet(p[2]));}
  static void CheckCurveLength(UIApplication u,XYZ a,XYZ b){} static object PointDto(XYZ p){return new double[]{Millimeters(p.X),Millimeters(p.Y),Millimeters(p.Z)};}
 }
 class Program {
  static void Assert(bool c,string m){if(!c)throw new Exception(m);}
  static object Prop(object x,string n){return x.GetType().GetProperty(n).GetValue(x,null);}
  static Document Doc(){var d=new Document();d.Elements[1]=new ViewFamilyType{Id=new ElementId(1),ViewFamily=ViewFamily.FloorPlan};d.Elements[2]=new ViewFamilyType{Id=new ElementId(2),ViewFamily=ViewFamily.ThreeDimensional};d.Elements[3]=new Level{Id=new ElementId(3)};d.Elements[4]=new ConduitType{Id=new ElementId(4)};d.Elements[5]=new DuctType{Id=new ElementId(5)};d.Elements[6]=new MechanicalSystemType{Id=new ElementId(6)};d.Elements[7]=new FamilySymbol{Id=new ElementId(7),Category=new Category{Id=new ElementId(BuiltInCategory.OST_TitleBlocks)}};d.Elements[8]=new FamilySymbol{Id=new ElementId(8),Category=new Category{Id=new ElementId(BuiltInCategory.Other)}};return d;}
  static object RunSheet(Document d,object titleblock,bool supplied){var a=new Dictionary<string,object>{{"name","Sheet name"},{"number","A101"}};if(supplied)a["titleblock_id"]=titleblock;return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_sheet",a);}
  static object Run(Document d,string op,long type){var a=new Dictionary<string,object>{{"name","Test view"},{"view_family_type_id",type}};if(op=="create_floor_plan_view")a["level_id"]=3L;return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},op,a);}
  static object RunConduit(Document d,long type,double length){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_conduit",new Dictionary<string,object>{{"conduit_type_id",type},{"level_id",3L},{"start_mm",new double[]{100,0,0}},{"end_mm",new double[]{100+length,0,0}},{"diameter_mm",25.0}});}
  static object RunDuct(Document d,long system){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_duct",new Dictionary<string,object>{{"duct_type_id",5L},{"system_type_id",system},{"level_id",3L},{"start_mm",new double[]{100,200,300}},{"end_mm",new double[]{1100,400,500}}});}
  static void ExpectFailure(Action a,string label){try{a();}catch(InvalidOperationException){Console.WriteLine("PASS "+label);return;}throw new Exception("Expected failure: "+label);}
  static void Main(){
   Console.WriteLine("Offline controlled peers only; no Revit or model lifecycle validation.");
   var sheetDoc=Doc();var sheet=RunSheet(sheetDoc,null,false);Assert((long)Prop(sheet,"element_id")==104 && (string)Prop(sheet,"name")=="Sheet name" && (string)Prop(sheet,"number")=="A101" && (bool)Prop(sheet,"is_placeholder") && Prop(sheet,"titleblock_id")==null,"placeholder sheet facts");Console.WriteLine("PASS placeholder sheet facts");
   sheetDoc=Doc();sheet=RunSheet(sheetDoc,7L,true);Assert((long)Prop(sheet,"element_id")==104 && (string)Prop(sheet,"name")=="Sheet name" && (string)Prop(sheet,"number")=="A101" && !(bool)Prop(sheet,"is_placeholder") && (long)Prop(sheet,"titleblock_id")==7,"real sheet facts");Console.WriteLine("PASS real sheet facts");
   sheetDoc=Doc();var invalidSheet=sheetDoc;ExpectFailure(()=>RunSheet(invalidSheet,8L,true),"sheet titleblock wrong category");Assert(sheetDoc.Calls==0,"wrong category created sheet");
   sheetDoc=Doc();invalidSheet=sheetDoc;ExpectFailure(()=>RunSheet(invalidSheet,999L,true),"sheet titleblock missing");Assert(sheetDoc.Calls==0,"missing titleblock created sheet");
   sheetDoc=Doc();invalidSheet=sheetDoc;ExpectFailure(()=>RunSheet(invalidSheet,0L,true),"sheet nonpositive titleblock");Assert(sheetDoc.Calls==0,"invalid id created sheet");
   sheetDoc=Doc();invalidSheet=sheetDoc;ExpectFailure(()=>RunSheet(invalidSheet,null,true),"sheet null titleblock");Assert(sheetDoc.Calls==0,"null id created sheet");
   sheetDoc=Doc();sheetDoc.OnCommit=x=>((ViewSheet)x.Elements[104]).SheetNumber="drift";invalidSheet=sheetDoc;ExpectFailure(()=>RunSheet(invalidSheet,7L,true),"sheet post-commit number drift");
   sheetDoc=Doc();sheetDoc.OnCommit=x=>((FamilyInstance)x.Elements[105]).TypeId=new ElementId(8);invalidSheet=sheetDoc;ExpectFailure(()=>RunSheet(invalidSheet,7L,true),"sheet post-commit titleblock drift");
   var d=Doc();var p=Run(d,"create_floor_plan_view",1);Assert((long)Prop(p,"element_id")==100 && (long)Prop(p,"view_family_type_id")==1 && (long)Prop(p,"level_id")==3 && (string)Prop(p,"name")=="Test view" && (string)Prop(p,"view_kind")=="floor_plan","floor facts");Console.WriteLine("PASS floor facts");
   d=Doc();var v=Run(d,"create_3d_view",2);Assert((long)Prop(v,"element_id")==101 && (long)Prop(v,"view_family_type_id")==2 && (string)Prop(v,"name")=="Test view" && (string)Prop(v,"view_kind")=="isometric_3d","3d facts");Console.WriteLine("PASS 3d facts");
   d=Doc();var bad=d;ExpectFailure(()=>Run(bad,"create_floor_plan_view",2),"wrong family");Assert(d.Calls==0,"wrong family created view");
   d=Doc();d.OnCommit=x=>x.Elements[100].Name="drift";var drift=d;ExpectFailure(()=>Run(drift,"create_floor_plan_view",1),"post-commit name drift");
   d=Doc();d.OnCommit=x=>((View3D)x.Elements[101]).IsPerspective=true;drift=d;ExpectFailure(()=>Run(drift,"create_3d_view",2),"post-commit perspective drift");
   d=Doc();d.ReverseConduit=true;var c=RunConduit(d,4,1000);Assert((long)Prop(c,"element_id")==102 && (long)Prop(c,"conduit_type_id")==4 && (long)Prop(c,"level_id")==3 && Math.Abs((double)Prop(c,"diameter_mm")-25)<0.001 && Math.Abs(((double[])Prop(c,"start_mm"))[0]-100)<0.001 && Math.Abs(((double[])Prop(c,"end_mm"))[0]-1100)<0.001,"conduit facts and caller endpoint order");Console.WriteLine("PASS conduit facts and caller endpoint order");
   d=Doc();d.OnCommit=x=>((Conduit)x.Elements[102]).Diameter.Value=0;drift=d;ExpectFailure(()=>RunConduit(drift,4,1000),"conduit post-commit diameter drift");
   d=Doc();d.FailDiameter=true;var fail=d;ExpectFailure(()=>RunConduit(fail,4,1000),"conduit diameter set failure");
   d=Doc();bad=d;ExpectFailure(()=>RunConduit(bad,1,1000),"conduit wrong type");Assert(d.Calls==0,"wrong type created conduit");
   d=Doc();bad=d;ExpectFailure(()=>RunConduit(bad,4,1),"conduit short geometry");Assert(d.Calls==0,"short geometry created conduit");
   d=Doc();d.ReverseDuct=true;var duct=RunDuct(d,6);var start=(double[])Prop(duct,"start_mm");var end=(double[])Prop(duct,"end_mm");Assert((long)Prop(duct,"element_id")==103 && (long)Prop(duct,"duct_type_id")==5 && (long)Prop(duct,"system_type_id")==6 && (long)Prop(duct,"level_id")==3 && Math.Abs(start[0]-100)<0.001 && Math.Abs(start[1]-200)<0.001 && Math.Abs(start[2]-300)<0.001 && Math.Abs(end[0]-1100)<0.001 && Math.Abs(end[1]-400)<0.001 && Math.Abs(end[2]-500)<0.001,"duct facts and caller endpoint order");Console.WriteLine("PASS duct facts and caller endpoint order");
   d=Doc();bad=d;ExpectFailure(()=>RunDuct(bad,4),"duct wrong system class");Assert(d.Calls==0,"wrong system created duct");
   d=Doc();d.OnCommit=x=>((Duct)x.Elements[103]).SystemParameter.IdValue=new ElementId(4);drift=d;ExpectFailure(()=>RunDuct(drift,6),"duct post-commit system drift");
   d=Doc();d.OnCommit=x=>((Line)((LocationCurve)((Duct)x.Elements[103]).Location).Curve).B=new XYZ(9,9,9);drift=d;ExpectFailure(()=>RunDuct(drift,6),"duct post-commit endpoint drift");
  }
 }
}
