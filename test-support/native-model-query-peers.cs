using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Web.Script.Serialization;

// Controlled API peers for executing the unchanged production query service.
// The real Revit API is compiled separately; these peers do not load Revit.
namespace Autodesk.Revit.UI {
    internal sealed class UIDocument { public Autodesk.Revit.DB.Document Document; }
    internal sealed class UIApplication { public UIDocument ActiveUIDocument; }
}
namespace Autodesk.Revit.DB {
    internal sealed class ElementId { public long Value; public ElementId(long value){Value=value;} }
    internal sealed class ForgeTypeId {
        public string TypeId; public ForgeTypeId(string value){TypeId=value;}
        public static bool operator ==(ForgeTypeId a,ForgeTypeId b){return Object.ReferenceEquals(a,b)||!Object.ReferenceEquals(a,null)&&!Object.ReferenceEquals(b,null)&&a.TypeId==b.TypeId;}
        public static bool operator !=(ForgeTypeId a,ForgeTypeId b){return !(a==b);}
        public override bool Equals(object value){return this==(value as ForgeTypeId);}public override int GetHashCode(){return TypeId.GetHashCode();}
    }
    internal static class SpecTypeId {public static readonly ForgeTypeId Length=new ForgeTypeId("length"),Area=new ForgeTypeId("area"),Volume=new ForgeTypeId("volume");}
    internal static class UnitTypeId {public static readonly ForgeTypeId Millimeters=new ForgeTypeId("mm"),SquareMeters=new ForgeTypeId("m2"),CubicMeters=new ForgeTypeId("m3");}
    internal static class UnitUtils {
        public static double ConvertFromInternalUnits(double value,ForgeTypeId unit){return value*(unit==UnitTypeId.Millimeters?304.8:unit==UnitTypeId.SquareMeters?0.09290304:0.028316846592);}
        public static bool IsMeasurableSpec(ForgeTypeId spec){return spec==SpecTypeId.Length||spec==SpecTypeId.Area||spec==SpecTypeId.Volume;}
    }
    internal enum BuiltInCategory {OST_Walls=-2000011,OST_Doors=-2000023,OST_Windows=-2000014,OST_Floors=-2000032,OST_Roofs=-2000035,OST_Ceilings=-2000038,OST_Columns=-2000100,OST_StructuralColumns=-2001330,OST_StructuralFraming=-2001320,OST_PipeCurves=-2008044,OST_PipeFitting=-2008049,OST_PipeAccessory=-2008055,OST_DuctCurves=-2008000,OST_DuctFitting=-2008010,OST_DuctAccessory=-2008016,OST_MechanicalEquipment=-2001140,OST_PlumbingFixtures=-2001160,OST_Furniture=-2000080,OST_GenericModel=-2000151}
    internal enum BuiltInParameter {CURVE_ELEM_LENGTH,HOST_AREA_COMPUTED,HOST_VOLUME_COMPUTED}
    internal enum StorageType {None,Integer,Double,String,ElementId}
    internal enum ViewType {FloorPlan,ThreeD}
    internal sealed class Category {public ElementId Id;public string Name;}
    internal sealed class Definition {public string Name;public ForgeTypeId DataType=new ForgeTypeId("text");public ForgeTypeId GetDataType(){return DataType;}}
    internal sealed class Parameter {
        public ElementId Id;public Element Element;public Definition Definition;public StorageType StorageType;public bool IsReadOnly,HasValue;public object Value;public string Display;
        public ForgeTypeId GetUnitTypeId(){return Definition.DataType;}
        public string AsString(){return Value as string;}public string AsValueString(){return Display;}
        public double AsDouble(){return Convert.ToDouble(Value,CultureInfo.InvariantCulture);}public int AsInteger(){return Convert.ToInt32(Value,CultureInfo.InvariantCulture);}public ElementId AsElementId(){return (ElementId)Value;}
    }
    internal sealed class XYZ {public double X,Y,Z;public XYZ(double x,double y,double z){X=x;Y=y;Z=z;}}
    internal sealed class Transform {public XYZ OfPoint(XYZ point){return new XYZ(10-point.Y,20+point.X,30+point.Z);}}
    internal sealed class BoundingBoxXYZ {public XYZ Min,Max;public Transform Transform=new Transform();}
    internal class Location {}
    internal sealed class LocationPoint:Location {public XYZ Point;}
    internal sealed class Curve {public bool IsBound=true;public XYZ Start,End;public XYZ GetEndPoint(int index){return index==0?Start:End;}}
    internal sealed class LocationCurve:Location {public Curve Curve;}
    internal class Element {
        public ElementId Id,LevelId=new ElementId(-1),TypeId=new ElementId(-1);public string Name;public Category Category;public Document Document;public bool IsValidObject=true;public Location Location;public BoundingBoxXYZ Box;
        public List<Parameter> Parameters=new List<Parameter>();public Dictionary<BuiltInParameter,Parameter> Measures=new Dictionary<BuiltInParameter,Parameter>();
        public ElementId GetTypeId(){return TypeId;}public BoundingBoxXYZ get_BoundingBox(View view){return Box;}
        public Parameter get_Parameter(BuiltInParameter builtIn){Parameter parameter;return Measures.TryGetValue(builtIn,out parameter)?parameter:null;}
    }
    internal class ElementType:Element {}
    internal sealed class View:Element {public ViewType ViewType;public bool IsTemplate;}
    internal sealed class Level:Element {}
    internal sealed class Document {
        public List<Element> Elements=new List<Element>();public View ActiveView;public string Title="Query fixture",PathName="D:\\fixture.rvt";public bool IsFamilyDocument,IsReadOnly,IsModified;
        public Element GetElement(ElementId id){return Elements.FirstOrDefault(element=>element.Id.Value==id.Value);}
        public void Add(Element element){element.Document=this;Elements.Add(element);}
    }
    internal sealed class FilteredElementCollector:IEnumerable<Element>,IDisposable {
        private IEnumerable<Element> values;public FilteredElementCollector(Document doc){values=doc.Elements;}
        public FilteredElementCollector OfClass(Type type){values=values.Where(element=>type.IsInstanceOfType(element));return this;}
        public FilteredElementCollector WhereElementIsNotElementType(){values=values.Where(element=>!(element is ElementType));return this;}
        public FilteredElementCollector OfCategory(BuiltInCategory category){values=values.Where(element=>element.Category!=null&&element.Category.Id.Value==(long)category);return this;}
        public IEnumerator<Element> GetEnumerator(){return values.GetEnumerator();}IEnumerator IEnumerable.GetEnumerator(){return GetEnumerator();}public void Dispose(){}
    }
}
namespace RevitLocalCodex {
    using Autodesk.Revit.DB;
    using Autodesk.Revit.UI;
    internal static class WorkbenchActions {
        // ORIGINAL_DESCRIBE_PARAMETER
        // ORIGINAL_INTERNAL_VALUE
    }
    internal static class NativeQueryPeerProgram {
        private static Parameter Parameter(long id,string name,StorageType storage,object value,string display,ForgeTypeId dataType){return new Parameter{Id=new ElementId(id),Definition=new Definition{Name=name,DataType=dataType},StorageType=storage,HasValue=value!=null,Value=value,Display=display};}
        private static Document Fixture(bool duplicateLevel,bool overflow) {
            var doc=new Document();var walls=new Category{Id=new ElementId((long)BuiltInCategory.OST_Walls),Name="墙"};var doors=new Category{Id=new ElementId((long)BuiltInCategory.OST_Doors),Name="门"};
            doc.Add(new Level{Id=new ElementId(1),Name="L1"});doc.Add(new Level{Id=new ElementId(2),Name=duplicateLevel?"L1":"L2"});doc.Add(new ElementType{Id=new ElementId(100),Name="Wall type"});doc.Add(new ElementType{Id=new ElementId(101),Name="Door type"});
            int count=overflow?100001:650;
            for(int i=count-1;i>=0;i--)doc.Add(new Element{Id=new ElementId(10000+i),Name="Wall "+i,Category=walls,LevelId=new ElementId(i%2+1),TypeId=new ElementId(100)});
            for(int i=0;i<65&&!overflow;i++)doc.Add(new Element{Id=new ElementId(20000+i),Name="Door "+i,Category=doors,LevelId=new ElementId(1),TypeId=new ElementId(101)});
            for(int i=0;i<20;i++)doc.Add(new View{Id=new ElementId(2000+i),Name="View "+i,ViewType=ViewType.FloorPlan,IsTemplate=i==0});
            doc.ActiveView=(View)doc.GetElement(new ElementId(2001));
            var geometry=new Element{Id=new ElementId(9007199254740993),Name="Precise geometry",Category=walls,LevelId=new ElementId(1),Location=new LocationPoint{Point=new XYZ(1,2,3)},Box=new BoundingBoxXYZ{Min=new XYZ(1,2,3),Max=new XYZ(4,6,8)}};
            geometry.Parameters.Add(Parameter(-123,"Length",StorageType.Double,2.0,"609.6 mm",SpecTypeId.Length));geometry.Measures[BuiltInParameter.CURVE_ELEM_LENGTH]=geometry.Parameters[0];
            geometry.Parameters.Add(Parameter(9223372036854775807,"Reference",StorageType.ElementId,new ElementId(9007199254740995),"Reference",new ForgeTypeId("reference")));
            geometry.Parameters.Add(Parameter(200,"Missing",StorageType.String,null,null,new ForgeTypeId("text")));
            geometry.Measures[BuiltInParameter.HOST_AREA_COMPUTED]=Parameter(-124,"Area",StorageType.Double,10.0,"area",SpecTypeId.Area);
            geometry.Measures[BuiltInParameter.HOST_VOLUME_COMPUTED]=Parameter(-125,"Volume",StorageType.Double,100.0,"volume",SpecTypeId.Volume);
            doc.Add(geometry);return doc;
        }
        public static int Main() {
            Console.InputEncoding=new System.Text.UTF8Encoding(false);Console.OutputEncoding=new System.Text.UTF8Encoding(false);var json=new JavaScriptSerializer{MaxJsonLength=1024*1024,RecursionLimit=40};
            var input=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());
            bool duplicate=input.ContainsKey("duplicateLevel")&&(bool)input["duplicateLevel"],overflow=input.ContainsKey("scanOverflow")&&(bool)input["scanOverflow"];
            var app=new UIApplication{ActiveUIDocument=input.ContainsKey("noDocument")&&(bool)input["noDocument"]?null:new UIDocument{Document=Fixture(duplicate,overflow)}};
            var arguments=input.ContainsKey("args")?(Dictionary<string,object>)input["args"]:new Dictionary<string,object>();
            try{object result=NativeModelQueries.Read(app,(string)input["operation"],arguments);Console.WriteLine(json.Serialize(new{ok=true,value=result}));}
            catch(Exception error){Console.WriteLine(json.Serialize(new{ok=false,error=error.Message}));}return 0;
        }
    }
}
