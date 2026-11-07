using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
namespace Autodesk.Revit.DB {
 public class ElementId { public long Value;public ElementId(long x){Value=x;} }
 public class Category { public ElementId Id;public string Name;public bool AllowsBoundParameters; }
 public class CategorySet:List<Category> {}
 public class Settings { public CategorySet Categories=new CategorySet(); }
 public class ForgeTypeId { public string TypeId; }
 public class InternalDefinition { public ElementId Id;public string Name,DataType;public ForgeTypeId GetDataType(){return new ForgeTypeId{TypeId=DataType};} }
 public class BindingMap { public bool Bound;public int InsertCalls;public bool Contains(InternalDefinition d){return Bound;} }
 public class Element { public ElementId Id;public Category Category;public Document Document;public bool IsValidObject=true,HasParameter;public string UniqueId;public object get_Parameter(Guid g){return HasParameter?new object():null;} }
 public class ElementType:Element {}
 public class Document { public bool IsFamilyDocument;public string Title="controlled",PathName="D:\\controlled.rvt";public Settings Settings=new Settings();public BindingMap ParameterBindings=new BindingMap();public SharedParameterElement Shared;public List<Element> Elements=new List<Element>(); }
 public class SharedParameterElement { public bool IsValidObject=true;public Document Document;public Guid GuidValue;public ElementId Id;public InternalDefinition Definition;public InternalDefinition GetDefinition(){return Definition;}public static SharedParameterElement Lookup(Document d,Guid g){return d.Shared!=null&&d.Shared.GuidValue==g?d.Shared:null;} }
 public class FilteredElementCollector:IDisposable,IEnumerable<Element> { readonly Document doc;long category;public FilteredElementCollector(Document d){doc=d;}public FilteredElementCollector OfCategoryId(ElementId id){category=id.Value;return this;}public FilteredElementCollector WhereElementIsNotElementType(){return this;}public IEnumerator<Element> GetEnumerator(){return doc.Elements.Where(e=>e.Category!=null&&e.Category.Id.Value==category&&!(e is ElementType)).GetEnumerator();}IEnumerator IEnumerable.GetEnumerator(){return GetEnumerator();}public void Dispose(){} }
}
namespace RevitLocalCodex {
 class Program {
  static void Check(bool ok,string message){if(!ok)throw new Exception(message);Console.WriteLine("PASS "+message);}
  static void Fail(Action a,string message){try{a();}catch(InvalidOperationException){Console.WriteLine("PASS "+message);return;}throw new Exception(message);}
  static object Prop(object x,string name){return x.GetType().GetProperty(name).GetValue(x,null);}
  static void Main(){var guid=Guid.Parse("f173029f-a81a-48c3-a5af-7c7b9a857b4a");var d=new Document();var walls=new Category{Id=new ElementId(-2000011),Name="Walls",AllowsBoundParameters=true};var floors=new Category{Id=new ElementId(-2000032),Name="Floors",AllowsBoundParameters=true};d.Settings.Categories.Add(walls);d.Settings.Categories.Add(floors);
   d.Shared=new SharedParameterElement{Document=d,GuidValue=guid,Id=new ElementId(100),Definition=new InternalDefinition{Id=new ElementId(100),Name="P",DataType="text"}};
   d.Elements.Add(new Element{Id=new ElementId(5),Document=d,Category=walls,UniqueId="element-5"});d.Elements.Add(new Element{Id=new ElementId(2),Document=d,Category=floors,UniqueId="element-2"});
   var snapshot=ProjectInstanceBindingPreparation.Capture(d,guid,100,"text",new long[]{walls.Id.Value,floors.Id.Value});var dto=ProjectInstanceBindingPreparation.Describe(snapshot);
   Check(snapshot.Instances.Length==2&&snapshot.Instances[0].Id==2&&snapshot.Instances[1].Id==5&&(string)Prop(dto,"authorization")=="not_granted"&&!(bool)Prop(dto,"binding_attempted")&&d.ParameterBindings.InsertCalls==0,"complete sorted impact grants no authority");
   ProjectInstanceBindingPreparation.Revalidate(d,snapshot);Check(true,"unchanged impact revalidated");
   d.Elements.Add(new Element{Id=new ElementId(7),Document=d,Category=walls,UniqueId="element-7"});Fail(()=>ProjectInstanceBindingPreparation.Revalidate(d,snapshot),"added instance drift refused");d.Elements.RemoveAt(2);
   d.Elements[0].UniqueId="replaced";Fail(()=>ProjectInstanceBindingPreparation.Revalidate(d,snapshot),"instance identity drift refused");d.Elements[0].UniqueId="element-5";
   d.Elements[0].HasParameter=true;Fail(()=>ProjectInstanceBindingPreparation.Capture(d,guid,100,"text",new long[]{walls.Id.Value}),"existing instance GUID conflict refused");d.Elements[0].HasParameter=false;
   d.ParameterBindings.Bound=true;Fail(()=>ProjectInstanceBindingPreparation.Capture(d,guid,100,"text",new long[]{walls.Id.Value}),"already bound refused");d.ParameterBindings.Bound=false;
   Fail(()=>ProjectInstanceBindingPreparation.Capture(d,guid,100,"wrong",new long[]{walls.Id.Value}),"definition data type drift refused");
   Fail(()=>ProjectInstanceBindingPreparation.Capture(d,guid,100,"text",new long[]{walls.Id.Value,walls.Id.Value}),"duplicate category refused");
   d.Elements[0].Document=new Document();Fail(()=>ProjectInstanceBindingPreparation.Capture(d,guid,100,"text",new long[]{walls.Id.Value}),"foreign instance refused");d.Elements[0].Document=d;
   for(int i=0;i<500;i++)d.Elements.Add(new Element{Id=new ElementId(1000+i),Document=d,Category=walls,UniqueId="bulk-"+i});Fail(()=>ProjectInstanceBindingPreparation.Capture(d,guid,100,"text",new long[]{walls.Id.Value}),"over-budget impact refused");
   Check(d.ParameterBindings.InsertCalls==0,"no binding write or external owner invoked");
  }
 }
}
