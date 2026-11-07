using System;
using System.Collections.Generic;
using System.Collections;
using System.Linq;
using Autodesk.Revit.DB.Architecture;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
namespace Autodesk.Revit.DB {
 public enum BuiltInCategory { OST_StructuralFraming=-2001320, OST_IOSModelGroups=-2000095, OST_TitleBlocks=-2000280, OST_Walls=-2000011, OST_Invalid=-2000000, OST_Rooms=-2000160, Other=-1 }
 public class ElementId { public static readonly ElementId InvalidElementId=new ElementId(-1); public long Value; public ElementId(long v){Value=v;} public ElementId(BuiltInCategory v){Value=(long)v;} }
 public class Category { public ElementId Id; public static Category GetCategory(Document d,BuiltInCategory c){return new Category{Id=new ElementId(c)};} }
 public class Element { public ElementId Id; public string Name; public bool Pinned; public bool IsValidObject=true; public Category Category; public ElementId OwnerViewId; public ElementId GroupId=ElementId.InvalidElementId; public string UniqueId="stable"; public bool ValidType=true,Replacement=false; public int TypeCalls; public virtual bool IsValidType(ElementId id){return ValidType;} public virtual ElementId ChangeTypeId(ElementId id){TypeCalls++;return Replacement?new ElementId(777):ElementId.InvalidElementId;} public virtual ElementId GetTypeId(){return null;} }
 public class ElementType:Element {}
 public class GroupType:ElementType {}
 public class Group:Element { public GroupType GroupType; public List<ElementId> Members=new List<ElementId>(); public ICollection<ElementId> GetMemberIds(){return Members;} }
 public class Creation : RoomCreator { Document d; public Creation(Document doc):base(doc){d=doc;} public Group NewGroup(ICollection<ElementId> ids){d.Calls++;var g=new Group{Id=new ElementId(110),GroupType=new GroupType(),Category=new Category{Id=new ElementId(BuiltInCategory.OST_IOSModelGroups)},UniqueId="group"};foreach(var id in ids){g.Members.Add(id);d.Elements[id.Value].GroupId=g.Id;}d.Elements[110]=g;return g;} }
 public enum FamilyPlacementType { CurveDrivenStructural, OneLevelBased }
 public class Family { public FamilyPlacementType FamilyPlacementType; }
 public class FamilySymbol:ElementType { public Family Family; public bool IsActive; public void Activate(){IsActive=true;} }
 public class FamilyInstance:Element { public Autodesk.Revit.DB.Structure.StructuralType StructuralType; public Element Host; public object Location; public Parameter Reference; public Parameter get_Parameter(BuiltInParameter p){return Reference;} public ElementId TypeId; public override ElementId GetTypeId(){return TypeId;} public override ElementId ChangeTypeId(ElementId id){var r=base.ChangeTypeId(id);TypeId=id;return r;} }
 public class FilteredElementCollector:IDisposable,IEnumerable<Element> { Document d; ElementId owner; BuiltInCategory category; Type cls; public FilteredElementCollector OfClass(Type t){cls=t;return this;} public FilteredElementCollector(Document d){this.d=d;} public FilteredElementCollector OwnedByView(ElementId id){owner=id;return this;} public FilteredElementCollector OfCategory(BuiltInCategory c){category=c;return this;} public FilteredElementCollector WhereElementIsNotElementType(){return this;} public IList<Element> ToElements(){var result=new List<Element>();foreach(var e in d.Elements.Values)if(cls!=null ? cls.IsInstanceOfType(e) : !(e is ElementType) && e.OwnerViewId!=null && e.OwnerViewId.Value==owner.Value && e.Category!=null && e.Category.Id.Value==(long)category)result.Add(e);return result;} public IEnumerator<Element> GetEnumerator(){return d.Elements.Values.Where(e=>category==BuiltInCategory.OST_Rooms && e is Room).GetEnumerator();} IEnumerator IEnumerable.GetEnumerator(){return GetEnumerator();} public void Dispose(){} }
 public class Color { public byte Red,Green,Blue; public Color(byte r,byte g,byte b){Red=r;Green=g;Blue=b;} }
 public class Material:Element { public Color Color; public int Transparency,Shininess,Smoothness; public static ElementId Create(Document d,string name){d.Calls++;var m=new Material{Id=new ElementId(109),Name=name};d.Elements[109]=m;return m.Id;} }
 public enum ViewFamily { FloorPlan, ThreeDimensional, Section }
 public enum ViewType { FloorPlan, ThreeD, Section }
 public class ViewFamilyType:ElementType { public ViewFamily ViewFamily; }
 public class Level:Element { public double ProjectElevation; public static Level Create(Document d,double n){throw new Exception("unused");} }
 public class View:Element { public BoundingBoxXYZ CropBox; public bool CropBoxActive; public bool IsTemplate; public bool Compatible=true; public int SetterCalls; private ElementId templateId=ElementId.InvalidElementId; public ElementId ViewTemplateId { get { return templateId; } set { SetterCalls++; templateId=value; } } public bool IsValidViewTemplate(ElementId id){return Compatible;} public ViewType ViewType; public ElementId TypeId; public override ElementId GetTypeId(){return TypeId;} }
 public class Transform { public XYZ Origin=XYZ.Zero,BasisX=new XYZ(1,0,0),BasisY=new XYZ(0,1,0),BasisZ=new XYZ(0,0,1); public static Transform Identity {get{return new Transform();}} public XYZ OfPoint(XYZ p){return Origin.Add(BasisX.Multiply(p.X)).Add(BasisY.Multiply(p.Y)).Add(BasisZ.Multiply(p.Z));} }
 public class BoundingBoxXYZ { public Transform Transform=Transform.Identity; public XYZ Min,Max; public void set_MinEnabled(int i,bool v){} public void set_MaxEnabled(int i,bool v){} }
 public class ViewCropRegionShapeManager:IDisposable { public bool ShapeSet,Split; public void Dispose(){} }
 public class ViewSection:View {
  public Parameter Far=new Parameter(),Clipping=new Parameter{StorageType=StorageType.Integer,Value=2};
  public ViewCropRegionShapeManager Region=new ViewCropRegionShapeManager();
  public ViewCropRegionShapeManager GetCropRegionShapeManager(){return Region;}
  public Parameter get_Parameter(BuiltInParameter p){return p==BuiltInParameter.VIEWER_BOUND_OFFSET_FAR?Far:p==BuiltInParameter.VIEWER_BOUND_FAR_CLIPPING?Clipping:null;}
  public static ViewSection CreateSection(Document d,ElementId t,BoundingBoxXYZ b){
   d.Calls++;d.SectionInput=b;var x=b.Transform.BasisX;var y=b.Transform.BasisY;var z=b.Transform.BasisZ;
   var tr=Transform.Identity;tr.BasisX=x.Multiply(-1);tr.BasisY=y;tr.BasisZ=z.Multiply(-1);
   tr.Origin=b.Transform.Origin.Add(x.Multiply(2)).Add(y.Multiply(3)).Add(z.Multiply(4));
   var v=new ViewSection{Id=new ElementId(108),TypeId=t,ViewType=ViewType.Section,CropBoxActive=true,CropBox=new BoundingBoxXYZ{
    Transform=tr,Min=new XYZ(2-b.Max.X,-3,4-b.Max.Z),Max=new XYZ(2-b.Min.X,-3+b.Max.Y,4)}};
   v.Far.Value=b.Max.Z;d.Elements[108]=v;return v;
  }
 }
 public class TextNoteType:ElementType {}
 public class TextNote:Element { public ElementId TypeId; public XYZ Coord; public string Text; public override ElementId GetTypeId(){return TypeId;} public static TextNote Create(Document d,ElementId view,XYZ point,string text,ElementId type){d.Calls++;var n=new TextNote{Id=new ElementId(107),OwnerViewId=view,Coord=point,Text=text,TypeId=type};d.Elements[107]=n;return n;} }
 public class ScheduleDefinition { public ElementId CategoryId; public int Count; public int GetFieldCount(){return Count;} }
 public class ViewSchedule:View { public ScheduleDefinition Definition; public static bool IsValidCategoryForSchedule(ElementId id){return id.Value==(long)BuiltInCategory.OST_Walls;} public static ViewSchedule CreateSchedule(Document d,ElementId id){d.Calls++;var v=new ViewSchedule{Id=new ElementId(109),Definition=new ScheduleDefinition{CategoryId=id}};d.Elements[109]=v;return v;} }
 public class ViewPlan:View { public Level GenLevel; public static ViewPlan Create(Document d,ElementId t,ElementId l){d.Calls++; var v=new ViewPlan { Id=new ElementId(100), TypeId=t, GenLevel=(Level)d.GetElement(l), ViewType=ViewType.FloorPlan }; d.Elements[v.Id.Value]=v; return v;} }
 public class View3D:View { public bool IsPerspective; public static View3D CreateIsometric(Document d,ElementId t){d.Calls++; var v=new View3D { Id=new ElementId(101), TypeId=t, ViewType=ViewType.ThreeD }; d.Elements[v.Id.Value]=v; return v;} }
 public class ViewSheet:View { public string SheetNumber; public bool IsPlaceholder; public static ViewSheet CreatePlaceholder(Document d){d.Calls++;var s=new ViewSheet{Id=new ElementId(104),IsPlaceholder=true};d.Elements[104]=s;return s;} public static ViewSheet Create(Document d,ElementId type){d.Calls++;var s=new ViewSheet{Id=new ElementId(104)};d.Elements[104]=s;d.Elements[105]=new FamilyInstance{Id=new ElementId(105),OwnerViewId=s.Id,Category=new Category{Id=new ElementId(BuiltInCategory.OST_TitleBlocks)},TypeId=type};return s;} }
 public class Viewport:Element { public ElementId SheetId,ViewId; public XYZ Center; public static bool CanAddViewToSheet(Document d,ElementId s,ElementId v){return d.CanAddViewport;} public static Viewport Create(Document d,ElementId s,ElementId v,XYZ p){d.Calls++;var x=new Viewport{Id=new ElementId(106),SheetId=s,ViewId=v,Center=p};d.Elements[106]=x;return x;} public XYZ GetBoxCenter(){return Center;} }
 public class XYZ { public static readonly XYZ Zero=new XYZ(); public static readonly XYZ BasisZ=new XYZ(0,0,1); public static bool IsWithinLengthLimits(XYZ p){return true;} public double X,Y,Z; public XYZ(double x=0,double y=0,double z=0){X=x;Y=y;Z=z;} public XYZ Negate(){return Multiply(-1);} public XYZ Add(XYZ p){return new XYZ(X+p.X,Y+p.Y,Z+p.Z);} public XYZ Multiply(double n){return new XYZ(X*n,Y*n,Z*n);} public XYZ CrossProduct(XYZ p){return new XYZ(Y*p.Z-Z*p.Y,Z*p.X-X*p.Z,X*p.Y-Y*p.X);} public double DistanceTo(XYZ p){return Math.Sqrt(Math.Pow(X-p.X,2)+Math.Pow(Y-p.Y,2)+Math.Pow(Z-p.Z,2));} }
 public class Line { public XYZ A,B; public bool IsBound=true; public static Line CreateBound(XYZ a,XYZ b){return new Line{A=a,B=b};} public XYZ GetEndPoint(int i){return i==0?A:B;} }
 public class LocationCurve { public object Curve; }
 public class UV { public double U,V; public UV(double u,double v){U=u;V=v;} } public class LocationPoint { public XYZ Point; } public class Phase:Element {}
 public enum BuiltInParameter { INSTANCE_REFERENCE_LEVEL_PARAM, ROOM_PHASE_ID, RBS_CONDUIT_DIAMETER_PARAM, RBS_DUCT_SYSTEM_TYPE_PARAM, VIEWER_BOUND_OFFSET_FAR, VIEWER_BOUND_FAR_CLIPPING } public enum StorageType { Double, ElementId, Integer }
 public class Parameter { public StorageType StorageType=StorageType.Double; public bool HasValue=true,IsReadOnly; public double Value; public ElementId IdValue; public ElementId AsElementId(){return IdValue;} public double AsDouble(){return Value;} public int AsInteger(){return (int)Value;} public bool Set(double v){if(IsReadOnly)return false;Value=v;return true;} }
 public class Grid:Element { public object Curve; public static Grid Create(Document d,Line l){throw new Exception("unused");} }
 public class RoomCreator { Document d; public RoomCreator(Document doc){d=doc;} public FamilyInstance NewFamilyInstance(Line line,FamilySymbol symbol,Level level,Autodesk.Revit.DB.Structure.StructuralType role){d.Calls++;var b=new FamilyInstance{Id=new ElementId(112),UniqueId="beam",TypeId=symbol.Id,StructuralType=role,Reference=new Parameter{StorageType=StorageType.ElementId,IdValue=level.Id},Location=new LocationCurve{Curve=line}};d.Elements[112]=b;return b;} public Room NewRoom(Level level,UV point){d.Calls++;var r=new Room { Id=new ElementId(109),LevelId=level.Id,Location=new LocationPoint {Point=new XYZ(point.U,point.V,level.ProjectElevation)},Name="Room",Number="1",Area=d.RoomArea,Volume=d.RoomVolume,PhaseId=d.RoomPhaseId };d.Elements[109]=r;return r;} }
 public class Document { public Creation Create {get{return new Creation(this);}} public double RoomArea=100,RoomVolume=0; public ElementId RoomPhaseId; public Room ExistingRoom; public Room GetRoomAtPoint(XYZ p){return ExistingRoom;} public bool IsFamilyDocument; public bool ReverseConduit,FailDiameter,ReverseDuct; public bool CanAddViewport=true; public Dictionary<long,Element> Elements=new Dictionary<long,Element>(); public int Calls; public BoundingBoxXYZ SectionInput; public Action<Document> OnCommit; public Element GetElement(ElementId id){Element e; return Elements.TryGetValue(id.Value,out e)?e:null;} public void Regenerate(){} }
 public enum TransactionStatus { Started, Committed, RolledBack }
 public class FailureHandlingOptions { public FailureHandlingOptions SetFailuresPreprocessor(object p){return this;} public FailureHandlingOptions SetClearAfterRollback(bool v){return this;} }
 public class Transaction:IDisposable { Document d; TransactionStatus s; public Transaction(Document d,string n){this.d=d;} public TransactionStatus Start(){return s=TransactionStatus.Started;} public FailureHandlingOptions GetFailureHandlingOptions(){return new FailureHandlingOptions();} public void SetFailureHandlingOptions(FailureHandlingOptions o){} public TransactionStatus Commit(){s=TransactionStatus.Committed;if(d.OnCommit!=null)d.OnCommit(d);return s;} public TransactionStatus GetStatus(){return s;} public void RollBack(){s=TransactionStatus.RolledBack;} public void Dispose(){} }
}
namespace Autodesk.Revit.DB.Architecture { using Autodesk.Revit.DB; public class Room:Element { public string Number; public ElementId LevelId,PhaseId; public object Location; public double Area,Volume; public Parameter get_Parameter(BuiltInParameter p){return PhaseId==null?null:new Parameter{StorageType=StorageType.ElementId,IdValue=PhaseId};} } }
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
namespace Autodesk.Revit.DB.Structure { public enum StructuralType { Beam } }
namespace Autodesk.Revit.UI { public class UIDocument { public Document Document; } public class UIApplication { public UIDocument ActiveUIDocument; } }
namespace RevitLocalCodex {
 internal static class NativeModelQueries { internal static long ExactId(Dictionary<string,object> a,string k){object v=a[k];if(v==null || !(v is long) || (long)v<=0)throw new InvalidOperationException("invalid id");return (long)v;} }
 internal static partial class WorkbenchActions {
  private static object CreateColumn(Document d, Dictionary<string,object> a, BasicCreatedExpectation c) { throw new InvalidOperationException("Column is covered by its dedicated peer fixture."); }
  private static object ReadColumn(Document d, Dictionary<string,object> a, ElementId id) { throw new InvalidOperationException("Column is covered by its dedicated peer fixture."); }

        // Window placement is outside this fixture; window producer tests exercise the real methods.
        private static object PlaceWindow(Document doc, Dictionary<string, object> args, BasicCreatedExpectation created) { throw new InvalidOperationException("Out of scope window-write peer."); }
        private static object ReadWindow(Document doc, Dictionary<string, object> args, ElementId id) { throw new InvalidOperationException("Out of scope window-write peer."); }

  class ParameterWriteExpectation {} class RejectErrors {}
  static object WriteTypeParameter(UIApplication u,Dictionary<string,object>a){throw new Exception("unused");}
  static object SetParameters(Document d,Dictionary<string,object>a,List<ParameterWriteExpectation> e,bool g){throw new Exception("unused");}
  static object TransformElements(Document d,string o,Dictionary<string,object>a){throw new Exception("unused");}
  static object CreateWall(UIApplication u,Dictionary<string,object>a){throw new Exception("unused");}
  static object CreatePipe(UIApplication u,Dictionary<string,object>a){throw new Exception("unused");}
  static void VerifyParameterWrites(Document d,List<ParameterWriteExpectation> e){}
  static void Fields(Dictionary<string,object>a,params string[] names){foreach(var k in a.Keys)if(Array.IndexOf(names,k)<0)throw new InvalidOperationException("unexpected field");}
  static object Required(Dictionary<string,object>a,string k){return a[k];}
  static System.Collections.IList RequiredList(Dictionary<string,object>a,string k,int min,int max){var v=a[k] as System.Collections.IList;if(v==null||v.Count<min||v.Count>max)throw new InvalidOperationException("invalid list");return v;}
  static string OptionalString(Dictionary<string,object>a,string k,string fallback){object v;return a.TryGetValue(k,out v)?(string)v:fallback;}
  static long ElementIdValue(object v,string k){return Convert.ToInt64(v);}
  static Element RequiredElement(Document d,long id){var e=d.GetElement(new ElementId(id));if(e==null)throw new InvalidOperationException("missing element");return e;}
  static object DescribedId(ElementId id){return id==null?null:(object)id.Value;}
  static double Feet(double v){return v/304.8;} static double Millimeters(double v){return v*304.8;}
  static double FiniteNumber(object v,string n){if (v==null || v is bool || v is string) throw new InvalidOperationException("invalid number"); double x=Convert.ToDouble(v);if(double.IsNaN(x)||double.IsInfinity(x))throw new InvalidOperationException("invalid number");return x;} static double PositiveLength(object v,string n){double x=FiniteNumber(v,n);if(x<=0)throw new InvalidOperationException();return Feet(x);}
  static void CheckCurveLength(UIApplication u,XYZ a,XYZ b){}
 }
 class Program {
  static void Assert(bool c,string m){if(!c)throw new Exception(m);}
  static object Prop(object x,string n){return x.GetType().GetProperty(n).GetValue(x,null);}
  static Dictionary<string,object> Point(double x,double y,double z){return new Dictionary<string,object>{{"x",x},{"y",y},{"z",z}};}
  static bool PointMatches(object value,double x,double y,double z){return Math.Abs((double)Prop(value,"x")-x)<0.001&&Math.Abs((double)Prop(value,"y")-y)<0.001&&Math.Abs((double)Prop(value,"z")-z)<0.001;}
  static Document Doc(){var d=new Document();d.Elements[1]=new ViewFamilyType{Id=new ElementId(1),ViewFamily=ViewFamily.FloorPlan};d.Elements[2]=new ViewFamilyType{Id=new ElementId(2),ViewFamily=ViewFamily.ThreeDimensional};d.Elements[3]=new Level{Id=new ElementId(3)};d.Elements[4]=new ConduitType{Id=new ElementId(4)};d.Elements[5]=new DuctType{Id=new ElementId(5)};d.Elements[6]=new MechanicalSystemType{Id=new ElementId(6)};d.Elements[7]=new FamilySymbol{Id=new ElementId(7),Category=new Category{Id=new ElementId(BuiltInCategory.OST_TitleBlocks)}};d.Elements[8]=new FamilySymbol{Id=new ElementId(8),Category=new Category{Id=new ElementId(BuiltInCategory.Other)}};d.Elements[9]=new ViewFamilyType{Id=new ElementId(9),ViewFamily=ViewFamily.Section};return d;}
  static Document BeamDoc(){var d=Doc();d.Elements[60]=new FamilySymbol{Id=new ElementId(60),Category=new Category{Id=new ElementId(BuiltInCategory.OST_StructuralFraming)},Family=new Family{FamilyPlacementType=FamilyPlacementType.CurveDrivenStructural}};return d;}
  static object RunBeam(Document d,object type= null){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_beam",new Dictionary<string,object>{{"expected_document","test"},{"mode","write"},{"symbol_id",type??60L},{"level_id",3L},{"start_mm",Point(304.8,609.6,914.4)},{"end_mm",Point(3048,609.6,1219.2)}});}
  static object RunTypeChange(Document d,long element,long type){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"change_element_type",new Dictionary<string,object>{{"expected_document","test"},{"mode","write"},{"element_id",element},{"target_type_id",type}});}
  static Document TypeDoc(){var d=Doc();d.Elements[50]=new FamilyInstance{Id=new ElementId(50),TypeId=new ElementId(7)};return d;}
  static object RunGroup(Document d,object[] ids,string name="Group A"){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_group",new Dictionary<string,object>{{"expected_document","test"},{"mode","write"},{"name",name},{"element_ids",ids}});}
  static Document GroupDoc(){var d=Doc();d.Elements[50]=new FamilyInstance{Id=new ElementId(50),UniqueId="member-50"};d.Elements[51]=new FamilyInstance{Id=new ElementId(51),UniqueId="member-51"};return d;}
  static object RunSchedule(Document d,string category,string name){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_schedule",new Dictionary<string,object>{{"expected_document","test"},{"mode","write"},{"name",name},{"category",category}});}
  static object RunSection(Document d,object type,double angle=37,double width=1200,double height=2400,double depth=1800){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_section_view",new Dictionary<string,object>{{"expected_document","test"},{"mode","write"},{"view_family_type_id",type},{"name","Section test"},{"origin_mm",Point(1524,-914.4,2133.6)},{"angle_degrees",angle},{"width_mm",width},{"height_mm",height},{"depth_mm",depth}});}
  static object RunSheet(Document d,object titleblock,bool supplied){var a=new Dictionary<string,object>{{"name","Sheet name"},{"number","A101"}};if(supplied)a["titleblock_id"]=titleblock;return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_sheet",a);}
  static object Run(Document d,string op,long type){var a=new Dictionary<string,object>{{"name","Test view"},{"view_family_type_id",type}};if(op=="create_floor_plan_view")a["level_id"]=3L;return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},op,a);}
  static object RunConduit(Document d,long type,double length){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_conduit",new Dictionary<string,object>{{"conduit_type_id",type},{"level_id",3L},{"start_mm",Point(100,0,0)},{"end_mm",Point(100+length,0,0)},{"diameter_mm",25.0}});}
  static object RunDuct(Document d,long system){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_duct",new Dictionary<string,object>{{"duct_type_id",5L},{"system_type_id",system},{"level_id",3L},{"start_mm",Point(100,200,300)},{"end_mm",Point(1100,400,500)}});}
  static object RunViewport(Document d,object sheet,object view,object x,object y){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"place_viewport_on_sheet",new Dictionary<string,object>{{"expected_document","test"},{"mode","write"},{"sheet_id",sheet},{"view_id",view},{"x_mm",x},{"y_mm",y}});}
  static Document ViewportDoc(){var d=Doc();d.Elements[20]=new ViewSheet{Id=new ElementId(20)};d.Elements[21]=new View{Id=new ElementId(21)};return d;}
  static object RunTemplate(Document d,object view,object template){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"apply_view_template",new Dictionary<string,object>{{"expected_document","test"},{"mode","write"},{"view_id",view},{"template_id",template}});}
  static Document TemplateDoc(){var d=Doc();d.Elements[30]=new View{Id=new ElementId(30)};d.Elements[31]=new View{Id=new ElementId(31),IsTemplate=true};return d;}
  static Document NoteDoc(){var d=Doc();d.Elements[40]=new View{Id=new ElementId(40)};d.Elements[41]=new TextNoteType{Id=new ElementId(41)};return d;}
  static object RunNote(Document d,object type,string text,double x=304.8){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_text_note",new Dictionary<string,object>{{"expected_document","test"},{"mode","write"},{"view_id",40L},{"text_type_id",type},{"point_mm",Point(x,-609.6,914.4)},{"text",text}});}
  static object RunMaterial(Document d,string name,int red=12,int transparency=25){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_material",new Dictionary<string,object>{{"expected_document","test"},{"mode","write"},{"name",name},{"red",red},{"green",34},{"blue",56},{"transparency",transparency}});}
  static object RunMaterialExtra(Document d,int shine,int smooth){return WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=d}},"create_material",new Dictionary<string,object>{{"expected_document","test"},{"mode","write"},{"name","Bounded material"},{"red",0},{"green",255},{"blue",0},{"transparency",100},{"shininess",shine},{"smoothness",smooth}});}
  static void ExpectFailure(Action a,string label){try{a();}catch(InvalidOperationException){Console.WriteLine("PASS "+label);return;}throw new Exception("Expected failure: "+label);}
  static void Main(){
   Console.WriteLine("Offline controlled peers only; no Revit or model lifecycle validation.");
   var bd=BeamDoc();var beam=RunBeam(bd);Assert((long)Prop(beam,"element_id")==112 && (long)Prop(beam,"symbol_id")==60 && (long)Prop(beam,"level_id")==3 && PointMatches(Prop(beam,"start_mm"),304.8,609.6,914.4) && PointMatches(Prop(beam,"end_mm"),3048,609.6,1219.2) && ((FamilySymbol)bd.Elements[60]).IsActive,"beam facts");Console.WriteLine("PASS beam creation and actual sloped centerline");
   bd=BeamDoc();var badBeam=bd;ExpectFailure(()=>RunBeam(badBeam,7L),"beam invalid symbol");Assert(bd.Calls==0,"bad symbol no create");
   bd=BeamDoc();((FamilySymbol)bd.Elements[60]).Family.FamilyPlacementType=FamilyPlacementType.OneLevelBased;badBeam=bd;ExpectFailure(()=>RunBeam(badBeam),"beam wrong placement");Assert(bd.Calls==0,"wrong placement no create");
   bd=BeamDoc();bd.OnCommit=x=>((FamilyInstance)x.Elements[112]).Reference.IdValue=new ElementId(99);badBeam=bd;ExpectFailure(()=>RunBeam(badBeam),"beam post commit level drift");
   bd=BeamDoc();bd.OnCommit=x=>((Line)((LocationCurve)((FamilyInstance)x.Elements[112]).Location).Curve).A=new XYZ(100,0,0);badBeam=bd;ExpectFailure(()=>RunBeam(badBeam),"beam post commit centerline drift");
   bd=BeamDoc();bd.OnCommit=x=>x.Elements[112].UniqueId="replacement";badBeam=bd;ExpectFailure(()=>RunBeam(badBeam),"beam post commit identity drift");
   var ct=TypeDoc();var changed=RunTypeChange(ct,50,8);Assert((long)Prop(changed,"element_id")==50 && (long)Prop(changed,"before_type_id")==7 && (long)Prop(changed,"target_type_id")==8 && (bool)Prop(changed,"changed"),"type change facts");Console.WriteLine("PASS type change identity and before/after readback");
   ct=TypeDoc();changed=RunTypeChange(ct,50,7);Assert(!(bool)Prop(changed,"changed") && ct.Elements[50].TypeCalls==0,"type no-op");Console.WriteLine("PASS type no-op avoids call");
   ct=TypeDoc();ct.Elements[50].GroupId=new ElementId(4);var badType=ct;ExpectFailure(()=>RunTypeChange(badType,50,8),"grouped target");Assert(ct.Elements[50].TypeCalls==0,"grouped no change");
   ct=TypeDoc();ct.Elements[50].ValidType=false;badType=ct;ExpectFailure(()=>RunTypeChange(badType,50,8),"incompatible target");Assert(ct.Elements[50].TypeCalls==0,"incompatible no change");
   ct=TypeDoc();badType=ct;ExpectFailure(()=>RunTypeChange(badType,7,8),"type is not an instance");
   ct=TypeDoc();ct.Elements[50].Replacement=true;badType=ct;ExpectFailure(()=>RunTypeChange(badType,50,8),"replacement rejected");
   ct=TypeDoc();ct.OnCommit=x=>x.Elements[50].UniqueId="different";badType=ct;ExpectFailure(()=>RunTypeChange(badType,50,8),"post-commit unique id drift");
   ct=TypeDoc();ct.OnCommit=x=>((FamilyInstance)x.Elements[50]).TypeId=new ElementId(7);badType=ct;ExpectFailure(()=>RunTypeChange(badType,50,8),"post-commit type drift");
   var gd=GroupDoc();var group=RunGroup(gd,new object[]{50L,51L});Assert((long)Prop(group,"element_id")==110 && (string)Prop(group,"name")=="Group A" && ((object[])Prop(group,"element_ids")).Length==2,"group facts");Console.WriteLine("PASS group direct members and identity");
   gd=GroupDoc();var badGroup=gd;ExpectFailure(()=>RunGroup(badGroup,new object[]{50L,50L}),"duplicate member");Assert(gd.Calls==0,"duplicate preflight");
   gd=GroupDoc();gd.Elements[50].GroupId=new ElementId(55);badGroup=gd;ExpectFailure(()=>RunGroup(badGroup,new object[]{50L,51L}),"grouped member");Assert(gd.Calls==0,"grouped preflight");
   gd=GroupDoc();badGroup=gd;ExpectFailure(()=>RunGroup(badGroup,new object[]{7L,51L}),"type member");Assert(gd.Calls==0,"type preflight");
   gd=GroupDoc();gd.Elements[50].UniqueId=null;badGroup=gd;ExpectFailure(()=>RunGroup(badGroup,new object[]{50L,51L}),"unstable member identity");Assert(gd.Calls==0,"identity preflight");
   gd=GroupDoc();gd.OnCommit=x=>x.Elements[50].UniqueId="replacement";badGroup=gd;ExpectFailure(()=>RunGroup(badGroup,new object[]{50L,51L}),"member identity drift");
   gd=GroupDoc();gd.OnCommit=x=>((Group)x.Elements[110]).Members.Add(new ElementId(52));badGroup=gd;ExpectFailure(()=>RunGroup(badGroup,new object[]{50L,51L}),"additional member drift");
   gd=GroupDoc();gd.OnCommit=x=>x.Elements[51].GroupId=ElementId.InvalidElementId;badGroup=gd;ExpectFailure(()=>RunGroup(badGroup,new object[]{50L,51L}),"group ownership drift");
   var scheduleDoc=Doc();var schedule=RunSchedule(scheduleDoc,"OST_Walls","Walls schedule");Assert((long)Prop(schedule,"element_id")==109 && (string)Prop(schedule,"category")=="OST_Walls" && (string)Prop(schedule,"name")=="Walls schedule" && (int)Prop(schedule,"field_count")==0,"schedule facts");Console.WriteLine("PASS schedule identity and zero configured fields");
   scheduleDoc=Doc();var badSchedule=scheduleDoc;ExpectFailure(()=>RunSchedule(badSchedule,"OST_Invalid","Walls"),"invalid schedule category");Assert(scheduleDoc.Calls==0,"invalid category must not create");
   scheduleDoc=Doc();badSchedule=scheduleDoc;ExpectFailure(()=>RunSchedule(badSchedule,"Walls","Walls"),"category must be exact enum");Assert(scheduleDoc.Calls==0,"unknown category must not create");
   scheduleDoc=Doc();badSchedule=scheduleDoc;ExpectFailure(()=>RunSchedule(badSchedule,"OST_Walls"," Bad"),"invalid schedule name");Assert(scheduleDoc.Calls==0,"invalid name must not create");
   scheduleDoc=Doc();scheduleDoc.OnCommit=x=>((ViewSchedule)x.Elements[109]).Definition.Count=1;badSchedule=scheduleDoc;ExpectFailure(()=>RunSchedule(badSchedule,"OST_Walls","Walls"),"schedule field drift after inner commit");
   var md=Doc();var material=RunMaterial(md,"Material test");Assert((long)Prop(material,"element_id")==109 && (string)Prop(material,"name")=="Material test" && (int)Prop(material,"red")==12 && (int)Prop(material,"green")==34 && (int)Prop(material,"blue")==56 && (int)Prop(material,"transparency")==25 && (int)Prop(material,"shininess")==50 && (int)Prop(material,"smoothness")==50,"material actual readback");Console.WriteLine("PASS material exact graphics readback");
   md=Doc();md.Elements[55]=new Material{Id=new ElementId(55),Name="MATERIAL TEST"};var badMaterial=md;ExpectFailure(()=>RunMaterial(badMaterial,"Material test"),"material duplicate name");Assert(md.Calls==0,"duplicate must not create");
   md=Doc();badMaterial=md;ExpectFailure(()=>RunMaterial(badMaterial,"Material test",256),"material out of range");Assert(md.Calls==0,"invalid color must not create");
   md=Doc();md.IsFamilyDocument=true;badMaterial=md;ExpectFailure(()=>RunMaterial(badMaterial,"Material test"),"material family document");Assert(md.Calls==0,"family document must not create");
   md=Doc();md.OnCommit=x=>((Material)x.Elements[109]).Transparency=26;badMaterial=md;ExpectFailure(()=>RunMaterial(badMaterial,"Material test"),"material post-commit drift");
   md=Doc();material=RunMaterialExtra(md,128,100);Assert((int)Prop(material,"shininess")==128 && (int)Prop(material,"smoothness")==100,"material upper bound readback");Console.WriteLine("PASS material explicit upper bounds");
   md=Doc();material=RunMaterialExtra(md,0,0);Assert((int)Prop(material,"shininess")==0 && (int)Prop(material,"smoothness")==0,"material lower bound readback");Console.WriteLine("PASS material explicit lower bounds");
   md=Doc();badMaterial=md;ExpectFailure(()=>RunMaterialExtra(badMaterial,129,50),"material shininess range");Assert(md.Calls==0,"invalid shininess must not create");
   md=Doc();badMaterial=md;ExpectFailure(()=>RunMaterialExtra(badMaterial,50,101),"material smoothness range");Assert(md.Calls==0,"invalid smoothness must not create");
   md=Doc();md.OnCommit=x=>((Material)x.Elements[109]).Shininess=51;badMaterial=md;ExpectFailure(()=>RunMaterial(badMaterial,"Material test"),"material post-commit shininess drift");
   md=Doc();md.OnCommit=x=>((Material)x.Elements[109]).Smoothness=51;badMaterial=md;ExpectFailure(()=>RunMaterial(badMaterial,"Material test"),"material post-commit smoothness drift");
   var rd=Doc();rd.Elements[50]=new Phase{Id=new ElementId(50)};rd.RoomPhaseId=new ElementId(50);
   var ra=new Dictionary<string,object>{{"level_id",3L},{"point_xy_mm",new Dictionary<string,object>{{"x",304.8},{"y",-609.6}}},{"name","Office"},{"number","101"}};
   var roomResult=WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=rd}},"create_room",ra);
   Assert((long)Prop(roomResult,"phase_id")==50 && (long)Prop(roomResult,"level_id")==3 && (double)Prop(roomResult,"area_internal")==100 && Prop(roomResult,"volume_internal")==null,"room actual phase and area");Console.WriteLine("PASS room exact phase, area and unknown volume");
   var noPhase=Doc();var unknown=WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=noPhase}},"create_room",ra);Assert(Prop(unknown,"phase_id")==null,"room missing phase explicitly null");Console.WriteLine("PASS room missing phase is null");
   var occupied=Doc();occupied.ExistingRoom=new Room();ExpectFailure(()=>WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=occupied}},"create_room",ra),"positive occupancy rejected");Assert(occupied.Calls==0,"occupancy checked before creation");
   var duplicate=Doc();duplicate.Elements[60]=new Room{Id=new ElementId(60),Number="101"};ExpectFailure(()=>WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=duplicate}},"create_room",ra),"duplicate number rejected");Assert(duplicate.Calls==0,"duplicate checked before creation");
   var unbounded=Doc();unbounded.RoomArea=0;ExpectFailure(()=>WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=unbounded}},"create_room",ra),"unbounded room rejected");
   var changedRoom=Doc();changedRoom.OnCommit=doc=>((Room)doc.Elements[109]).LevelId=new ElementId(4);ExpectFailure(()=>WorkbenchActions.Write(new UIApplication{ActiveUIDocument=new UIDocument{Document=changedRoom}},"create_room",ra),"room level drift rejected");

   var sd=Doc();var section=RunSection(sd,9L);var input=sd.SectionInput;double angle=37*Math.PI/180;Assert((long)Prop(section,"element_id")==108 && (long)Prop(section,"view_family_type_id")==9 && (string)Prop(section,"view_kind")=="section" && PointMatches(Prop(section,"origin_mm"),1524,-914.4,2133.6) && PointMatches(Prop(section,"look_direction"),Math.Cos(angle),Math.Sin(angle),0) && Math.Abs((double)Prop(section,"width_mm")-1200)<0.001 && Math.Abs((double)Prop(section,"height_mm")-2400)<0.001 && Math.Abs((double)Prop(section,"depth_mm")-1800)<0.001,"section readback facts");Assert(input.Transform.Origin.DistanceTo(new XYZ(5,-3,7))<1e-8 && input.Transform.BasisZ.DistanceTo(new XYZ(Math.Cos(angle),Math.Sin(angle),0))<1e-8 && input.Transform.BasisX.DistanceTo(new XYZ(-Math.Sin(angle),Math.Cos(angle),0))<1e-8 && input.Transform.BasisY.DistanceTo(new XYZ(0,0,1))<1e-8 && Math.Abs(input.Min.X+1200/609.6)<1e-8 && input.Min.Y==0 && input.Min.Z==0 && Math.Abs(input.Max.Z-1800/304.8)<1e-8,"section creation basis and extents");Console.WriteLine("PASS section nontrivial basis and independently transformed crop readback");
   sd=Doc();var badSection=sd;ExpectFailure(()=>RunSection(badSection,1L),"section wrong family");Assert(sd.Calls==0,"wrong section family created");
   sd=Doc();badSection=sd;ExpectFailure(()=>RunSection(badSection,3L),"section wrong type class");Assert(sd.Calls==0,"wrong section class created");
   sd=Doc();badSection=sd;ExpectFailure(()=>RunSection(badSection,9L,360),"section invalid angle");Assert(sd.Calls==0,"invalid angle created");
   sd=Doc();badSection=sd;ExpectFailure(()=>RunSection(badSection,9L,37,99),"section invalid width");Assert(sd.Calls==0,"invalid width created");
   sd=Doc();sd.OnCommit=x=>((ViewSection)x.Elements[108]).CropBox.Transform.Origin=new XYZ(99,99,99);badSection=sd;ExpectFailure(()=>RunSection(badSection,9L),"section post-commit origin drift");
   sd=Doc();sd.OnCommit=x=>((ViewSection)x.Elements[108]).CropBox.Max=new XYZ(99,99,99);badSection=sd;ExpectFailure(()=>RunSection(badSection,9L),"section post-commit crop drift");
   sd=Doc();sd.OnCommit=x=>((ViewSection)x.Elements[108]).Far.Value=99;badSection=sd;ExpectFailure(()=>RunSection(badSection,9L),"section post-commit depth drift");
   sd=Doc();sd.OnCommit=x=>((ViewSection)x.Elements[108]).Clipping.Value=0;badSection=sd;ExpectFailure(()=>RunSection(badSection,9L),"section post-commit far clip disabled");
   sd=Doc();sd.OnCommit=x=>((ViewSection)x.Elements[108]).Region.Split=true;badSection=sd;ExpectFailure(()=>RunSection(badSection,9L),"section post-commit split crop");
   var nd=NoteDoc();var note=RunNote(nd,41L,"中文 English\r\n第二行\rthird");var storedNote=(TextNote)nd.Elements[107];Assert((long)Prop(note,"element_id")==107 && (long)Prop(note,"view_id")==40 && (long)Prop(note,"text_type_id")==41 && (string)Prop(note,"text")=="中文 English\n第二行\nthird" && PointMatches(Prop(note,"point_mm"),304.8,-609.6,914.4) && storedNote.Text=="中文 English\r第二行\rthird" && storedNote.Coord.DistanceTo(new XYZ(1,-2,3))<0.0001,"text note facts");Console.WriteLine("PASS multilingual multiline text note and coordinates");
   nd=NoteDoc();var badNote=nd;ExpectFailure(()=>RunNote(badNote,1L,"valid"),"text note wrong type");Assert(nd.Calls==0,"wrong type created note");
   nd=NoteDoc();badNote=nd;ExpectFailure(()=>RunNote(badNote,41L,"   "),"text note blank");Assert(nd.Calls==0,"blank created note");
   nd=NoteDoc();badNote=nd;ExpectFailure(()=>RunNote(badNote,41L,new string('a',2001)),"text note too long");Assert(nd.Calls==0,"long text created note");
   nd=NoteDoc();badNote=nd;ExpectFailure(()=>RunNote(badNote,41L,"valid",16093441),"text note outside anchor radius");Assert(nd.Calls==0,"out of range anchor created note");
   nd=NoteDoc();nd.OnCommit=x=>((TextNote)x.Elements[107]).Text="drift";badNote=nd;ExpectFailure(()=>RunNote(badNote,41L,"valid"),"text note post-commit text drift");
   nd=NoteDoc();nd.OnCommit=x=>((TextNote)x.Elements[107]).Coord=new XYZ(2,0,0);badNote=nd;ExpectFailure(()=>RunNote(badNote,41L,"valid"),"text note post-commit coordinate drift");
   var td=TemplateDoc();var tv=(View)td.Elements[30];var tr=RunTemplate(td,30L,31L);Assert((long)Prop(tr,"element_id")==30 && Prop(tr,"before_template_id")==null && (long)Prop(tr,"template_id")==31 && (bool)Prop(tr,"changed") && tv.SetterCalls==1,"template change facts");Console.WriteLine("PASS template changed from invalid prior ID");
   tr=RunTemplate(td,30L,31L);Assert((long)Prop(tr,"before_template_id")==31 && !(bool)Prop(tr,"changed") && tv.SetterCalls==1,"template no-op facts");Console.WriteLine("PASS template no-op avoids setter");
   td=TemplateDoc();tv=(View)td.Elements[30];tv.ViewTemplateId=new ElementId(32);tr=RunTemplate(td,30L,31L);Assert((long)Prop(tr,"before_template_id")==32 && (bool)Prop(tr,"changed"),"prior template facts");Console.WriteLine("PASS template reports prior ID");
   td=TemplateDoc();((View)td.Elements[30]).Compatible=false;var invalidTemplate=td;ExpectFailure(()=>RunTemplate(invalidTemplate,30L,31L),"template incompatible");Assert(((View)td.Elements[30]).SetterCalls==0,"incompatible setter");
   td=TemplateDoc();((View)td.Elements[30]).IsTemplate=true;invalidTemplate=td;ExpectFailure(()=>RunTemplate(invalidTemplate,30L,31L),"template invalid target");Assert(((View)td.Elements[30]).SetterCalls==0,"invalid target setter");
   td=TemplateDoc();((View)td.Elements[31]).IsTemplate=false;invalidTemplate=td;ExpectFailure(()=>RunTemplate(invalidTemplate,30L,31L),"template invalid template");Assert(((View)td.Elements[30]).SetterCalls==0,"invalid template setter");
   td=TemplateDoc();invalidTemplate=td;ExpectFailure(()=>RunTemplate(invalidTemplate,30.5,31L),"template fractional view ID");Assert(((View)td.Elements[30]).SetterCalls==0,"fractional setter");
   td=TemplateDoc();td.OnCommit=x=>((View)x.Elements[30]).ViewTemplateId=new ElementId(99);invalidTemplate=td;ExpectFailure(()=>RunTemplate(invalidTemplate,30L,31L),"template post-commit drift");

   var vpdoc=ViewportDoc();var vp=RunViewport(vpdoc,20L,21L,-123.5,456.25);Assert((long)Prop(vp,"element_id")==106 && (long)Prop(vp,"sheet_id")==20 && (long)Prop(vp,"view_id")==21 && Math.Abs((double)Prop(vp,"x_mm")+123.5)<0.000001 && Math.Abs((double)Prop(vp,"y_mm")-456.25)<0.000001 && ((Viewport)vpdoc.Elements[106]).Center.Z==0,"viewport facts");Console.WriteLine("PASS viewport negative coordinates and facts");
   vpdoc=ViewportDoc();vpdoc.CanAddViewport=false;var invalidVp=vpdoc;ExpectFailure(()=>RunViewport(invalidVp,20L,21L,0.0,0.0),"viewport ineligible");Assert(vpdoc.Calls==0,"ineligible viewport created");
   vpdoc=ViewportDoc();((ViewSheet)vpdoc.Elements[20]).IsPlaceholder=true;invalidVp=vpdoc;ExpectFailure(()=>RunViewport(invalidVp,20L,21L,0.0,0.0),"viewport placeholder sheet");Assert(vpdoc.Calls==0,"placeholder viewport created");
   vpdoc=ViewportDoc();invalidVp=vpdoc;ExpectFailure(()=>RunViewport(invalidVp,20.5,21L,0.0,0.0),"viewport fractional id");Assert(vpdoc.Calls==0,"fractional id created");
   vpdoc=ViewportDoc();invalidVp=vpdoc;ExpectFailure(()=>RunViewport(invalidVp,20L,21L,double.NaN,0.0),"viewport nonfinite coordinate");Assert(vpdoc.Calls==0,"nonfinite viewport created");
   vpdoc=ViewportDoc();vpdoc.OnCommit=x=>((Viewport)x.Elements[106]).SheetId=new ElementId(99);invalidVp=vpdoc;ExpectFailure(()=>RunViewport(invalidVp,20L,21L,0.0,0.0),"viewport post-commit sheet drift");
   vpdoc=ViewportDoc();vpdoc.OnCommit=x=>((Viewport)x.Elements[106]).ViewId=new ElementId(99);invalidVp=vpdoc;ExpectFailure(()=>RunViewport(invalidVp,20L,21L,0.0,0.0),"viewport post-commit view drift");
   vpdoc=ViewportDoc();vpdoc.OnCommit=x=>((Viewport)x.Elements[106]).Center=new XYZ(0.001/304.8,0.001/304.8,0);invalidVp=vpdoc;ExpectFailure(()=>RunViewport(invalidVp,20L,21L,0.0,0.0),"viewport post-commit euclidean position drift");
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
   d=Doc();d.ReverseConduit=true;var c=RunConduit(d,4,1000);Assert((long)Prop(c,"element_id")==102 && (long)Prop(c,"conduit_type_id")==4 && (long)Prop(c,"level_id")==3 && Math.Abs((double)Prop(c,"diameter_mm")-25)<0.001 && PointMatches(Prop(c,"start_mm"),100,0,0) && PointMatches(Prop(c,"end_mm"),1100,0,0),"conduit facts and caller endpoint order");Console.WriteLine("PASS conduit facts and caller endpoint order");
   d=Doc();d.OnCommit=x=>((Conduit)x.Elements[102]).Diameter.Value=0;drift=d;ExpectFailure(()=>RunConduit(drift,4,1000),"conduit post-commit diameter drift");
   d=Doc();d.FailDiameter=true;var fail=d;ExpectFailure(()=>RunConduit(fail,4,1000),"conduit diameter set failure");
   d=Doc();bad=d;ExpectFailure(()=>RunConduit(bad,1,1000),"conduit wrong type");Assert(d.Calls==0,"wrong type created conduit");
   d=Doc();bad=d;ExpectFailure(()=>RunConduit(bad,4,1),"conduit short geometry");Assert(d.Calls==0,"short geometry created conduit");
   d=Doc();d.ReverseDuct=true;var duct=RunDuct(d,6);Assert((long)Prop(duct,"element_id")==103 && (long)Prop(duct,"duct_type_id")==5 && (long)Prop(duct,"system_type_id")==6 && (long)Prop(duct,"level_id")==3 && PointMatches(Prop(duct,"start_mm"),100,200,300) && PointMatches(Prop(duct,"end_mm"),1100,400,500),"duct facts and caller endpoint order");Console.WriteLine("PASS duct facts and caller endpoint order");
   d=Doc();bad=d;ExpectFailure(()=>RunDuct(bad,4),"duct wrong system class");Assert(d.Calls==0,"wrong system created duct");
   d=Doc();d.OnCommit=x=>((Duct)x.Elements[103]).SystemParameter.IdValue=new ElementId(4);drift=d;ExpectFailure(()=>RunDuct(drift,6),"duct post-commit system drift");
   d=Doc();d.OnCommit=x=>((Line)((LocationCurve)((Duct)x.Elements[103]).Location).Curve).B=new XYZ(9,9,9);drift=d;ExpectFailure(()=>RunDuct(drift,6),"duct post-commit endpoint drift");
  }
 }
}
