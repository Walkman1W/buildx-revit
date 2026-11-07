using System;
using System.Collections.Generic;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
namespace Autodesk.Revit.DB {
 public enum BuiltInCategory { OST_TitleBlocks=-2000280, OST_Windows=-2000014, Other=-1 }
 public class ElementId { public static readonly ElementId InvalidElementId=new ElementId(-1); public long Value; public ElementId(long v){Value=v;} public ElementId(BuiltInCategory v){Value=(long)v;} }
 public class Category { public ElementId Id; }
 public class Element { public ElementId Id; public string Name; public bool Pinned; public bool IsValidObject=true; public Category Category; public ElementId OwnerViewId; public virtual ElementId GetTypeId(){return null;} }
 public class ElementType:Element {}
 public enum FamilyPlacementType { OneLevelBasedHosted, Other } public class Family { public FamilyPlacementType FamilyPlacementType; } public class FamilySymbol:ElementType { public Family Family; public bool IsActive=true; public void Activate(){IsActive=true;} public Parameter get_Parameter(BuiltInParameter p){return null;} }
 public class FamilyInstance:Element { public FamilySymbol Symbol; public Element Host; public ElementId LevelId; public object Location; public XYZ FacingOrientation=new XYZ(0,1,0); public bool FacingFlipped,CanFlipFacing=true; public bool flipFacing(){FacingOrientation=FacingOrientation * -1;FacingFlipped=!FacingFlipped;return true;} public Parameter get_Parameter(BuiltInParameter p){return null;} public ElementId TypeId; public override ElementId GetTypeId(){return TypeId;} }
 public class FilteredElementCollector:IDisposable { Document d; ElementId owner; BuiltInCategory category; public FilteredElementCollector(Document d){this.d=d;} public FilteredElementCollector OwnedByView(ElementId id){owner=id;return this;} public FilteredElementCollector OfCategory(BuiltInCategory c){category=c;return this;} public FilteredElementCollector WhereElementIsNotElementType(){return this;} public IList<Element> ToElements(){var result=new List<Element>();foreach(var e in d.Elements.Values)if(!(e is ElementType) && e.OwnerViewId!=null && e.OwnerViewId.Value==owner.Value && e.Category!=null && e.Category.Id.Value==(long)category)result.Add(e);return result;} public void Dispose(){} }
 public enum ViewFamily { FloorPlan, ThreeDimensional }
 public enum ViewType { FloorPlan, ThreeD }
 public class ViewFamilyType:ElementType { public ViewFamily ViewFamily; }
 public class Level:Element { public double ProjectElevation; public static Level Create(Document d,double n){throw new Exception("unused");} }
 public class View:Element { public bool IsTemplate; public bool Compatible=true; public int SetterCalls; private ElementId templateId=ElementId.InvalidElementId; public ElementId ViewTemplateId { get { return templateId; } set { SetterCalls++; templateId=value; } } public bool IsValidViewTemplate(ElementId id){return Compatible;} public ViewType ViewType; public ElementId TypeId; public override ElementId GetTypeId(){return TypeId;} }
 // Text notes are outside the window producer fixture.
 public class TextNoteType:ElementType {} public class TextNote:Element { public string Text; public XYZ Coord; public static TextNote Create(Document d,ElementId view,XYZ p,string text,ElementId type){throw new InvalidOperationException("Out of scope text-note peer.");} }
 public class ViewSchedule:View {}
 public class ViewPlan:View { public Level GenLevel; public static ViewPlan Create(Document d,ElementId t,ElementId l){d.Calls++; var v=new ViewPlan { Id=new ElementId(100), TypeId=t, GenLevel=(Level)d.GetElement(l), ViewType=ViewType.FloorPlan }; d.Elements[v.Id.Value]=v; return v;} }
 public class View3D:View { public bool IsPerspective; public static View3D CreateIsometric(Document d,ElementId t){d.Calls++; var v=new View3D { Id=new ElementId(101), TypeId=t, ViewType=ViewType.ThreeD }; d.Elements[v.Id.Value]=v; return v;} }
 public class ViewSheet:View { public string SheetNumber; public bool IsPlaceholder; public static ViewSheet CreatePlaceholder(Document d){d.Calls++;var s=new ViewSheet{Id=new ElementId(104),IsPlaceholder=true};d.Elements[104]=s;return s;} public static ViewSheet Create(Document d,ElementId type){d.Calls++;var s=new ViewSheet{Id=new ElementId(104)};d.Elements[104]=s;d.Elements[105]=new FamilyInstance{Id=new ElementId(105),OwnerViewId=s.Id,Category=new Category{Id=new ElementId(BuiltInCategory.OST_TitleBlocks)},TypeId=type};return s;} }
 public class Viewport:Element { public ElementId SheetId,ViewId; public XYZ Center; public static bool CanAddViewToSheet(Document d,ElementId s,ElementId v){return d.CanAddViewport;} public static Viewport Create(Document d,ElementId s,ElementId v,XYZ p){d.Calls++;var x=new Viewport{Id=new ElementId(106),SheetId=s,ViewId=v,Center=p};d.Elements[106]=x;return x;} public XYZ GetBoxCenter(){return Center;} }
 public class XYZ { public static XYZ Zero=new XYZ(0,0,0); public static XYZ BasisZ=new XYZ(0,0,1); public static XYZ operator +(XYZ a,XYZ b){return new XYZ(a.X+b.X,a.Y+b.Y,a.Z+b.Z);} public static XYZ operator -(XYZ a,XYZ b){return new XYZ(a.X-b.X,a.Y-b.Y,a.Z-b.Z);} public static XYZ operator *(XYZ a,double n){return new XYZ(a.X*n,a.Y*n,a.Z*n);} public double GetLength(){return Math.Sqrt(X*X+Y*Y+Z*Z);} public XYZ Normalize(){return this*(1/GetLength());} public double DotProduct(XYZ b){return X*b.X+Y*b.Y+Z*b.Z;} public XYZ CrossProduct(XYZ b){return new XYZ(Y*b.Z-Z*b.Y,Z*b.X-X*b.Z,X*b.Y-Y*b.X);} public double X,Y,Z; public XYZ(double x=0,double y=0,double z=0){X=x;Y=y;Z=z;} public double DistanceTo(XYZ p){return Math.Sqrt(Math.Pow(X-p.X,2)+Math.Pow(Y-p.Y,2)+Math.Pow(Z-p.Z,2));} }
 public class Line { public double Length {get{return A.DistanceTo(B);}} public XYZ A,B; public bool IsBound=true; public static Line CreateBound(XYZ a,XYZ b){return new Line{A=a,B=b};} public XYZ GetEndPoint(int i){return i==0?A:B;} }
 public class LocationCurve { public object Curve; }
 public enum BuiltInParameter { RBS_CONDUIT_DIAMETER_PARAM, RBS_DUCT_SYSTEM_TYPE_PARAM, INSTANCE_SILL_HEIGHT_PARAM, WINDOW_WIDTH, WINDOW_HEIGHT } public enum StorageType { Double, ElementId }
 public class Parameter { public StorageType StorageType=StorageType.Double; public bool HasValue=true,IsReadOnly; public double Value; public ElementId IdValue; public ElementId AsElementId(){return IdValue;} public double AsDouble(){return Value;} public bool Set(double v){if(IsReadOnly)return false;Value=v;return true;} }
 public class Grid:Element { public object Curve; public static Grid Create(Document d,Line l){throw new Exception("unused");} }
 public enum WallKind { Basic, Other } public enum WallCrossSection { Vertical, Other } public class WallType { public WallKind Kind; } public class BoundingBoxXYZ { public XYZ Min,Max; } public class LocationPoint { public XYZ Point; } public class Wall:Element { public WallType WallType=new WallType(); public WallCrossSection CrossSection; public ElementId GroupId=ElementId.InvalidElementId; public object Location; public BoundingBoxXYZ Bounds; public BoundingBoxXYZ get_BoundingBox(object x){return Bounds;} public override ElementId GetTypeId(){return new ElementId(9);} }
 public class Creator { Document d; public Creator(Document d){this.d=d;} public FamilyInstance NewFamilyInstance(XYZ p,FamilySymbol s,Wall w,Level l,Autodesk.Revit.DB.Structure.StructuralType t){d.Calls++;var x=new FamilyInstance{Id=new ElementId(100),Symbol=s,TypeId=s.Id,Host=w,LevelId=l.Id,Location=new LocationPoint{Point=p}};d.Elements[100]=x;return x;} }
 public class Document { public Creator Create {get{return new Creator(this);}} public bool IsFamilyDocument; public bool ReverseConduit,FailDiameter,ReverseDuct; public bool CanAddViewport=true; public Dictionary<long,Element> Elements=new Dictionary<long,Element>(); public int Calls; public Action<Document> OnCommit; public Element GetElement(ElementId id){Element e; return Elements.TryGetValue(id.Value,out e)?e:null;} public void Regenerate(){} }
 public enum TransactionStatus { Started, Committed, RolledBack }
 public class FailureHandlingOptions { public FailureHandlingOptions SetFailuresPreprocessor(object p){return this;} public FailureHandlingOptions SetClearAfterRollback(bool v){return this;} }
 public class Transaction:IDisposable { Document d; TransactionStatus s; public Transaction(Document d,string n){this.d=d;} public TransactionStatus Start(){return s=TransactionStatus.Started;} public FailureHandlingOptions GetFailureHandlingOptions(){return new FailureHandlingOptions();} public void SetFailureHandlingOptions(FailureHandlingOptions o){} public TransactionStatus Commit(){s=TransactionStatus.Committed;if(d.OnCommit!=null)d.OnCommit(d);return s;} public TransactionStatus GetStatus(){return s;} public void RollBack(){s=TransactionStatus.RolledBack;} public void Dispose(){} }
}
namespace Autodesk.Revit.DB.Structure { public enum StructuralType { NonStructural } }
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
  private sealed class MaterialAssignmentExpectation {}
  private static object SetElementMaterial(Document doc, Dictionary<string,object> args, out MaterialAssignmentExpectation expectation){expectation=null;throw new InvalidOperationException("Out of scope material assignment peer.");}
  private static void VerifyElementMaterial(Document doc, MaterialAssignmentExpectation expectation){throw new InvalidOperationException("Out of scope material assignment peer.");}

  // Only window and the shared transaction dispatcher are under test here.
  // Other operations are deliberately fail-closed, and have dedicated peers.
  private sealed class BasicCreatedExpectation { internal ElementId Id; }
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
        private static List<TypeChangeExpectation> ReplaceFamilyTypes(Document d, Dictionary<string,object> a){throw new InvalidOperationException("Out of scope family type peer.");}
        private static object VerifyFamilyTypeChanges(Document d, Dictionary<string,object> a, List<TypeChangeExpectation> e){throw new InvalidOperationException("Out of scope family type peer.");}
        private sealed class SheetBatchExpectation {}
        private static List<SheetBatchExpectation> CreateSheetBatch(UIApplication u, Dictionary<string,object> a){throw new InvalidOperationException("Out of scope sheet batch peer.");}
        private static object VerifySheetBatch(Document d, List<SheetBatchExpectation> e){throw new InvalidOperationException("Out of scope sheet batch peer.");}
        private sealed class UngroupExpectation {}
        private static UngroupExpectation UngroupOne(Document d, Dictionary<string,object> a){throw new InvalidOperationException("Out of scope ungroup peer.");}
        private static object VerifyUngroup(Document d, UngroupExpectation e){throw new InvalidOperationException("Out of scope ungroup peer.");}
        private sealed class BeamCreationExpectation {} private sealed class TypeChangeExpectation {} private sealed class GroupCreationExpectation {} private sealed class RoofCreationExpectation {}
  static BeamCreationExpectation CreateBeam(UIApplication u,Dictionary<string,object> a){throw new InvalidOperationException("out of scope");}
  static object VerifyBeam(Document d,Dictionary<string,object> a,BeamCreationExpectation x){throw new InvalidOperationException("out of scope");}
  static TypeChangeExpectation ChangeElementType(Document d,Dictionary<string,object> a){throw new InvalidOperationException("out of scope");}
  static object VerifyTypeChange(Document d,TypeChangeExpectation x){throw new InvalidOperationException("out of scope");}
  static GroupCreationExpectation CreateModelGroup(Document d,Dictionary<string,object> a){throw new InvalidOperationException("out of scope");}
  static object VerifyModelGroup(Document d,GroupCreationExpectation x){throw new InvalidOperationException("out of scope");}
  static RoofCreationExpectation CreateFlatRoof(UIApplication u,Dictionary<string,object> a){throw new InvalidOperationException("out of scope");}
  static object VerifyFlatRoof(Document d,Dictionary<string,object> a,RoofCreationExpectation x){throw new InvalidOperationException("out of scope");}
  static object ApplyViewTemplate(Document d,Dictionary<string,object> a,out ElementId id){id=null;throw new InvalidOperationException("out of scope");}
  static object VerifyViewTemplate(Document d,Dictionary<string,object> a,ElementId id=null){throw new InvalidOperationException("out of scope");}
  static object CreateFoundation(Document d,Dictionary<string,object> a,BasicCreatedExpectation x){throw new InvalidOperationException("out of scope");}
  static object ReadFoundation(Document d,Dictionary<string,object> a,ElementId id){throw new InvalidOperationException("out of scope");}
  static object CreateColumn(Document d,Dictionary<string,object> a,BasicCreatedExpectation x){throw new InvalidOperationException("out of scope");}
  static object ReadColumn(Document d,Dictionary<string,object> a,ElementId id){throw new InvalidOperationException("out of scope");}
  static object BasicWrite(UIApplication u,string op,Dictionary<string,object> a,BasicCreatedExpectation x){throw new InvalidOperationException("out of scope");}
  static object ReadBasicCreated(Document d,string op,Dictionary<string,object> a,ElementId id){throw new InvalidOperationException("out of scope");}
  static void VerifyPinned(Document d,Dictionary<string,object> a,bool pin){throw new InvalidOperationException("out of scope");}
  class ParameterWriteExpectation {} class RejectErrors {}
  static string TextNoteInput(Dictionary<string,object> args){throw new InvalidOperationException("Out of scope text-note peer.");} static string NormalizeTextNote(string value){throw new InvalidOperationException("Out of scope text-note peer.");}
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
  static double FiniteNumber(object v,string n){if (v==null || v is bool || v is string) throw new InvalidOperationException("invalid number"); double x=Convert.ToDouble(v);if(double.IsNaN(x)||double.IsInfinity(x))throw new InvalidOperationException("invalid number");return x;} static double PositiveLength(object v,string n){double x=FiniteNumber(v,n);if(x<=0)throw new InvalidOperationException();return Feet(x);} static XYZ MillimeterPoint(object v,string n){var p=(double[])v;return new XYZ(Feet(p[0]),Feet(p[1]),Feet(p[2]));}
  static void CheckCurveLength(UIApplication u,XYZ a,XYZ b){} static object PointDto(XYZ p){return new double[]{Millimeters(p.X),Millimeters(p.Y),Millimeters(p.Z)};}
 }
 class Program { static int count; static void Check(bool x,string m){if(!x)throw new Exception(m);count++;} static Document Doc(){var d=new Document();d.Elements[1]=new FamilySymbol{Id=new ElementId(1),Category=new Category{Id=new ElementId(BuiltInCategory.OST_Windows)},Family=new Family{FamilyPlacementType=FamilyPlacementType.OneLevelBasedHosted}};d.Elements[2]=new Wall{Id=new ElementId(2),Location=new LocationCurve{Curve=Line.CreateBound(new XYZ(0,0,0),new XYZ(10,0,0))},Bounds=new BoundingBoxXYZ{Min=new XYZ(0,0,0),Max=new XYZ(10,1,10)}};d.Elements[3]=new Level{Id=new ElementId(3)};return d;} static Dictionary<string,object> Args(){return new Dictionary<string,object>{{"symbol_id",1L},{"wall_id",2L},{"level_id",3L},{"point_mm",new double[]{304.8,0,304.8}}};} static object Run(Document d,Dictionary<string,object>a){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"place_window",a);} static void Reject(Document d,Dictionary<string,object>a,string reason){try{Run(d,a);throw new Exception("accepted "+reason);}catch(InvalidOperationException){Check(d.Calls==0,reason);}} static void Main(){var d=Doc();var result=Run(d,Args());Check(d.Calls==1,"created");Check((long)result.GetType().GetProperty("element_id").GetValue(result,null)==100,"readback");d=Doc();((FamilySymbol)d.Elements[1]).Category.Id=new ElementId(BuiltInCategory.Other);Reject(d,Args(),"category");d=Doc();((FamilySymbol)d.Elements[1]).Family.FamilyPlacementType=FamilyPlacementType.Other;Reject(d,Args(),"placement");d=Doc();((Wall)d.Elements[2]).GroupId=new ElementId(8);Reject(d,Args(),"group");d=Doc();var a=Args();a["point_mm"]=new double[]{304.8,10,304.8};Reject(d,a,"off wall");d=Doc();a=Args();a["point_mm"]=new double[]{304.8,0,4000};Reject(d,a,"height");d=Doc();a=Args();a["facing_direction"]=new Dictionary<string,object>{{"x",1.0},{"y",0.0},{"z",0.0}};Reject(d,a,"direction");d=Doc();d.OnCommit=x=>((FamilyInstance)x.Elements[100]).TypeId=new ElementId(9);try{Run(d,Args());throw new Exception("accepted post commit drift");}catch(InvalidOperationException){Check(true,"post commit");} Console.WriteLine("window producer checks: "+count); } } }
