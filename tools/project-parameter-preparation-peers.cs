using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
namespace Autodesk.Revit.DB {
 public class ElementId { public long Value; public ElementId(long x){Value=x;} }
 public class Category { public ElementId Id; public string Name; public bool AllowsBoundParameters; }
 public class CategorySet:List<Category> {}
 public class Settings { public CategorySet Categories=new CategorySet(); }
 public class ForgeTypeId { public string TypeId; }
 public class InternalDefinition { public ElementId Id; public string Name; public ForgeTypeId GetDataType(){return new ForgeTypeId{TypeId="text"};} }
 public class ElementBinding { public CategorySet Categories; }
 public class InstanceBinding:ElementBinding {} public class TypeBinding:ElementBinding {}
 public class BindingMap { public bool Bound; public ElementBinding Binding; public bool Contains(InternalDefinition d){return Bound;} public ElementBinding get_Item(InternalDefinition d){return Binding;} }
 public class Document { public bool IsFamilyDocument; public Settings Settings=new Settings(); public BindingMap ParameterBindings=new BindingMap(); public SharedParameterElement Shared; }
 public class SharedParameterElement { public bool IsValidObject=true; public Document Document; public Guid GuidValue; public ElementId Id; public InternalDefinition Definition; public InternalDefinition GetDefinition(){return Definition;} public static SharedParameterElement Lookup(Document d,Guid g){return d.Shared!=null&&d.Shared.GuidValue==g?d.Shared:null;} }
}
namespace RevitLocalCodex {
 class Program {
  static object Prop(object x,string p){return x.GetType().GetProperty(p).GetValue(x,null);}
  static void Check(bool ok,string message){if(!ok)throw new Exception(message);Console.WriteLine("PASS "+message);}
  static void Fail(Action action,string message){try{action();}catch(InvalidOperationException){Console.WriteLine("PASS "+message);return;}throw new Exception(message);}
  static void Main(){var guid=Guid.Parse("f173029f-a81a-48c3-a5af-7c7b9a857b4a");var d=new Document();var walls=new Category{Id=new ElementId(-2000011),Name="Walls",AllowsBoundParameters=true};d.Settings.Categories.Add(walls);
   var result=ProjectParameterPreparation.Inspect(d,guid,new long[]{-2000011});Check((string)Prop(result,"state")=="absent" && (string)Prop(result,"write_authorization")=="not_granted" && !(bool)Prop(result,"external_definition_verified"),"absent is not permission");
   d.Shared=new SharedParameterElement{Document=d,Id=new ElementId(100),GuidValue=guid,Definition=new InternalDefinition{Id=new ElementId(100),Name="P"}};
   result=ProjectParameterPreparation.Inspect(d,guid,new long[]{-2000011});Check((string)Prop(result,"state")=="present_unbound" && Prop(result,"binding_kind")==null,"present but unbound");
   d.ParameterBindings.Bound=true;d.ParameterBindings.Binding=new InstanceBinding{Categories=new CategorySet{walls}};result=ProjectParameterPreparation.Inspect(d,guid,new long[]{-2000011});Check((string)Prop(result,"state")=="bound" && (string)Prop(result,"binding_kind")=="instance" && ((string[])Prop(result,"bound_category_ids"))[0]=="-2000011","instance binding facts");
   d.ParameterBindings.Binding=new TypeBinding{Categories=new CategorySet{walls}};result=ProjectParameterPreparation.Inspect(d,guid,new long[]{-2000011});Check((string)Prop(result,"binding_kind")=="type","type binding facts");
   Fail(()=>ProjectParameterPreparation.Inspect(d,guid,new long[]{-2000011,-2000011}),"duplicate categories refused");walls.AllowsBoundParameters=false;Fail(()=>ProjectParameterPreparation.Inspect(d,guid,new long[]{-2000011}),"unavailable category refused");walls.AllowsBoundParameters=true;
   d.ParameterBindings.Binding.Categories.Add(walls);Fail(()=>ProjectParameterPreparation.Inspect(d,guid,new long[]{-2000011}),"ambiguous binding refused");
   d.ParameterBindings.Binding.Categories.RemoveAt(1);d.Shared.Document=new Document();Fail(()=>ProjectParameterPreparation.Inspect(d,guid,new long[]{-2000011}),"foreign definition refused");
  }
 }
}
