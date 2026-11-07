using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
namespace Autodesk.Revit.DB {
 public class ElementId { public long Value; public ElementId(long x){Value=x;} }
 public class Element { public ElementId Id; public string UniqueId; public bool IsValidObject=true; public Document Document; }
 public class ElementType:Element {}
 public class Document { public Dictionary<long,Element> Elements=new Dictionary<long,Element>(); public Element GetElement(string uid){return Elements.Values.FirstOrDefault(x=>x.UniqueId==uid);} }
}
namespace Autodesk.Revit.UI {
 public class Selection { public List<ElementId> Ids=new List<ElementId>(); public int Calls; public bool Drift; public ICollection<ElementId> GetElementIds(){return Ids;} public void SetElementIds(ICollection<ElementId> ids){Calls++;Ids=ids.ToList();if(Drift)Ids.Clear();} }
 public class UIDocument { public Document Document;public Selection Selection=new Selection(); }
 public class UIApplication { public UIDocument ActiveUIDocument; }
}
namespace RevitLocalCodex {
 internal static class NativeModelQueries { public static string SignedId(ElementId id){return id.Value.ToString();} }
 internal static partial class WorkbenchActions {
  static void Fields(Dictionary<string,object>a,params string[] keys){if(a.Keys.Any(k=>!keys.Contains(k)))throw new InvalidOperationException();}
  static IList RequiredList(Dictionary<string,object>a,string k,int min,int max){var v=a[k] as IList;if(v==null||v.Count<min||v.Count>max)throw new InvalidOperationException();return v;}
  static long ElementIdValue(object v,string key){if(!(v is int))throw new InvalidOperationException();int n=(int)v;if(n<=0)throw new InvalidOperationException();return n;}
  static Element RequiredElement(Document d,long id){Element e;if(!d.Elements.TryGetValue(id,out e))throw new InvalidOperationException();return e;}
 }
 class Program {
  static void Assert(bool v,string name){if(!v)throw new Exception(name);Console.WriteLine("PASS "+name);}
  static void Fail(Action a,string name){try{a();}catch(InvalidOperationException){Console.WriteLine("PASS "+name);return;}throw new Exception(name);}
  static Dictionary<string,object> Args(params int[] ids){return new Dictionary<string,object>{{"expected_document","fixture"},{"element_ids",ids}};}
  static Dictionary<string,object> Uids(params string[] ids){return new Dictionary<string,object>{{"expected_document","fixture"},{"element_uids",ids}};}
  static void Main(){var d=new Document();d.Elements[1]=new Element{Id=new ElementId(1),UniqueId="uid-a",Document=d};d.Elements[2]=new Element{Id=new ElementId(2),UniqueId="uid-b",Document=d};d.Elements[3]=new ElementType{Id=new ElementId(3),UniqueId="uid-type",Document=d};var ui=new UIApplication{ActiveUIDocument=new UIDocument{Document=d}};
   var result=WorkbenchActions.SetSelection(ui,Args(2,1));var selected=(long[])result.GetType().GetProperty("selected_ids").GetValue(result,null);Assert(selected.SequenceEqual(new long[]{1,2})&&ui.ActiveUIDocument.Selection.Calls==1,"selection exact sorted readback");
   result=WorkbenchActions.SetSelection(ui,Args());Assert(ui.ActiveUIDocument.Selection.Ids.Count==0,"selection clear");int calls=ui.ActiveUIDocument.Selection.Calls;
   Fail(()=>WorkbenchActions.SetSelection(ui,Args(1,1)),"duplicate rejected");Fail(()=>WorkbenchActions.SetSelection(ui,Args(3)),"element type rejected");Fail(()=>WorkbenchActions.SetSelection(ui,Args(9)),"missing element rejected");Assert(ui.ActiveUIDocument.Selection.Calls==calls,"invalid requests do not change selection");
   var unique=WorkbenchActions.SelectByUniqueIds(ui,Uids("uid-b","uid-a"));var rows=(Array)unique.GetType().GetProperty("selected").GetValue(unique,null);Assert(rows.Length==2 && (string)rows.GetValue(0).GetType().GetProperty("unique_id").GetValue(rows.GetValue(0),null)=="uid-a", "UniqueIds exact sorted mapping");
   calls=ui.ActiveUIDocument.Selection.Calls;Fail(()=>WorkbenchActions.SelectByUniqueIds(ui,Uids("uid-a","missing")),"missing UniqueId rejects whole request");Fail(()=>WorkbenchActions.SelectByUniqueIds(ui,Uids("uid-a","uid-a")),"duplicate UniqueId rejected");Fail(()=>WorkbenchActions.SelectByUniqueIds(ui,Uids("uid-type")),"UniqueId type rejected");Fail(()=>WorkbenchActions.SelectByUniqueIds(ui,Uids()),"empty UniqueIds rejected");Assert(ui.ActiveUIDocument.Selection.Calls==calls,"invalid UniqueIds do not change selection");
   ui.ActiveUIDocument.Selection.Drift=true;Fail(()=>WorkbenchActions.SelectByUniqueIds(ui,Uids("uid-a")),"UniqueId actual selection mismatch rejected");Fail(()=>WorkbenchActions.SetSelection(ui,Args(1)),"actual selection mismatch is rejected after effect");
  }
 }
}
