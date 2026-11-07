using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
namespace Autodesk.Revit.DB {
 public enum BuiltInCategory { OST_StructuralColumns=-2001330, Other=-1 }
 public enum BuiltInParameter { FAMILY_BASE_LEVEL_PARAM,FAMILY_TOP_LEVEL_PARAM,FAMILY_BASE_LEVEL_OFFSET_PARAM,FAMILY_TOP_LEVEL_OFFSET_PARAM }
 public enum StorageType { Double,ElementId }
 public enum FamilyPlacementType { TwoLevelsBased,OneLevelBasedHosted }
 public class ElementId { public long Value; public ElementId(long n){Value=n;} }
 public class XYZ { public double X,Y,Z; public XYZ(double x,double y,double z){X=x;Y=y;Z=z;} public double DistanceTo(XYZ b){return Math.Sqrt(Math.Pow(X-b.X,2)+Math.Pow(Y-b.Y,2)+Math.Pow(Z-b.Z,2));} }
 public class BoundingBoxXYZ { public XYZ Min,Max; }
 public class LocationPoint { public XYZ Point; }
 public class Element { public ElementId Id;public bool IsValidObject=true; }
 public class Level:Element { public double ProjectElevation; }
 public class Category { public ElementId Id; }
 public class Family { public FamilyPlacementType FamilyPlacementType; }
 public class FamilySymbol:Element { public Family Family;public Category Category;public bool IsActive;public void Activate(){IsActive=true;} }
 public class Parameter { public bool HasValue=true,IsReadOnly;public StorageType StorageType;public ElementId IdValue;public double Value; public ElementId AsElementId(){return IdValue;}public double AsDouble(){return Value;}public bool Set(ElementId value){IdValue=value;return true;}public bool Set(double value){Value=value;return true;} }
 public class FamilyInstance:Element { public FamilySymbol Symbol;public Element Host;public bool IsSlantedColumn;public StructuralType StructuralType;public ElementId LevelId;public object Location;public BoundingBoxXYZ Bounds;public Dictionary<BuiltInParameter,Parameter> P=new Dictionary<BuiltInParameter,Parameter>();public ElementId GetTypeId(){return Symbol.Id;}public Parameter get_Parameter(BuiltInParameter p){Parameter x;return P.TryGetValue(p,out x)?x:null;}public BoundingBoxXYZ get_BoundingBox(object v){return Bounds;} }
 public class Creator { Document doc; public Creator(Document d){doc=d;}public FamilyInstance NewFamilyInstance(XYZ pt,FamilySymbol symbol,Level level,StructuralType kind){doc.Calls++;var c=new FamilyInstance{Id=new ElementId(20),Symbol=symbol,LevelId=level.Id,StructuralType=kind,Location=new LocationPoint{Point=pt},Bounds=new BoundingBoxXYZ{Min=new XYZ(pt.X-1,pt.Y-1,0),Max=new XYZ(pt.X+1,pt.Y+1,10)}};c.P[BuiltInParameter.FAMILY_BASE_LEVEL_PARAM]=new Parameter{StorageType=StorageType.ElementId,IdValue=level.Id};c.P[BuiltInParameter.FAMILY_TOP_LEVEL_PARAM]=new Parameter{StorageType=StorageType.ElementId,IdValue=level.Id};c.P[BuiltInParameter.FAMILY_BASE_LEVEL_OFFSET_PARAM]=new Parameter{StorageType=StorageType.Double};c.P[BuiltInParameter.FAMILY_TOP_LEVEL_OFFSET_PARAM]=new Parameter{StorageType=StorageType.Double};doc.Elements[20]=c;return c;} }
 public class Document { public bool IsFamilyDocument;public int Calls;public Dictionary<long,Element> Elements=new Dictionary<long,Element>();public Creator Create {get{return new Creator(this);}} public Element GetElement(ElementId id){Element e;return Elements.TryGetValue(id.Value,out e)?e:null;}public void Regenerate(){} }
}
namespace Autodesk.Revit.DB.Structure { public enum StructuralType { Column,NonStructural } }
namespace RevitLocalCodex {
 internal static class NativeModelQueries { public static long ExactId(Dictionary<string,object> a,string key){return (long)a[key];} }
 internal static partial class WorkbenchActions {
  private sealed class BasicCreatedExpectation { internal ElementId Id; }
  private static void Fields(Dictionary<string,object> a,params string[] names){foreach(var k in a.Keys)if(!names.Contains(k))throw new InvalidOperationException();}
  private static Element RequiredElement(Document d,long id){var e=d.GetElement(new ElementId(id));if(e==null)throw new InvalidOperationException();return e;}
  private static object Required(Dictionary<string,object> a,string k){return a[k];}
  private static double Feet(double n){return n/304.8;}private static double Millimeters(double n){return n*304.8;}
  private static XYZ MillimeterPoint(object v,string k){var p=(Dictionary<string,object>)v;return new XYZ(Feet(Convert.ToDouble(p["x"])),Feet(Convert.ToDouble(p["y"])),Feet(Convert.ToDouble(p["z"])));}
  private static object PointDto(XYZ p){return new{x=Millimeters(p.X),y=Millimeters(p.Y),z=Millimeters(p.Z)};}
  private static object DescribedId(ElementId id){return id.Value;}
  public static object Run(Document d,Dictionary<string,object> a){return CreateColumn(d,a,new BasicCreatedExpectation());}
  public static object ReadAgain(Document d,Dictionary<string,object> a){return ReadColumn(d,a,new ElementId(20));}
 }
 class Program {
  static object Prop(object x,string n){return x.GetType().GetProperty(n).GetValue(x,null);}
  static void Assert(bool v,string n){if(!v)throw new Exception(n);Console.WriteLine("PASS "+n);}
  static void Fail(Action a,string n){try{a();}catch(InvalidOperationException){Console.WriteLine("PASS "+n);return;}throw new Exception("Expected rejection "+n);}
  static Document Doc(){var d=new Document();d.Elements[1]=new Level{Id=new ElementId(1),ProjectElevation=0};d.Elements[2]=new Level{Id=new ElementId(2),ProjectElevation=10};d.Elements[3]=new FamilySymbol{Id=new ElementId(3),Family=new Family{FamilyPlacementType=FamilyPlacementType.TwoLevelsBased},Category=new Category{Id=new ElementId((long)BuiltInCategory.OST_StructuralColumns)}};return d;}
  static Dictionary<string,object> Args(){return new Dictionary<string,object>{{"symbol_id",3L},{"base_level_id",1L},{"top_level_id",2L},{"point_mm",new Dictionary<string,object>{{"x",304.8},{"y",609.6},{"z",0.0}}}};}
  static void Main(){var d=Doc();var a=Args();var v=WorkbenchActions.Run(d,a);Assert((long)Prop(v,"symbol_id")==3 && (long)Prop(v,"top_level_id")==2 && (double)Prop(v,"height_mm")==3048 && d.Calls==1,"exact type levels and height");var c=(FamilyInstance)d.Elements[20];c.IsSlantedColumn=true;Fail(()=>WorkbenchActions.ReadAgain(d,a),"slanted readback rejected");c.IsSlantedColumn=false;c.Bounds.Max.Z=9;Fail(()=>WorkbenchActions.ReadAgain(d,a),"geometry drift rejected");c.Bounds.Max.Z=double.NaN;Fail(()=>WorkbenchActions.ReadAgain(d,a),"nonfinite geometry rejected");c.Bounds.Max.Z=10;c.P[BuiltInParameter.FAMILY_TOP_LEVEL_PARAM].IdValue=new ElementId(1);Fail(()=>WorkbenchActions.ReadAgain(d,a),"constraint drift rejected");d=Doc();((FamilySymbol)d.Elements[3]).Family.FamilyPlacementType=FamilyPlacementType.OneLevelBasedHosted;Fail(()=>WorkbenchActions.Run(d,a),"hosted family rejected");Assert(d.Calls==0,"invalid family before creation");d=Doc();((Level)d.Elements[2]).ProjectElevation=-1;Fail(()=>WorkbenchActions.Run(d,a),"top below base rejected");d=Doc();((Dictionary<string,object>)a["point_mm"])["z"]=5.0;Fail(()=>WorkbenchActions.Run(d,a),"point elevation mismatch rejected");}
 }
}
