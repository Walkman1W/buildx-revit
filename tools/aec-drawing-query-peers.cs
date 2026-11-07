using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
namespace Autodesk.Revit.DB {
 public class ElementId { public long Value; public ElementId(long v){Value=v;} }
 public class Element { public ElementId Id; public string Name; }
 public class Revision : Element { public string RevisionDate, Description; public int SequenceNumber; public bool Issued; }
 public class Document { public List<Element> Elements = new List<Element>(); public Element GetElement(ElementId id){return Elements.FirstOrDefault(e=>e.Id.Value==id.Value);} }
 public class FilteredElementCollector : IEnumerable, IDisposable { Document d; Type t; public FilteredElementCollector(Document doc){d=doc;} public FilteredElementCollector OfClass(Type type){t=type;return this;} public IEnumerator GetEnumerator(){return d.Elements.Where(e=>t.IsInstanceOfType(e)).GetEnumerator();} public void Dispose(){} }
 public enum SectionType { Body }
 public class TableSectionData { public int NumberOfRows, NumberOfColumns, FirstRowNumber, FirstColumnNumber; }
 public class TableData { public TableSectionData Body; public TableSectionData GetSectionData(SectionType t){return Body;} }
 public class ViewSchedule : Element { public TableData Data; public TableData GetTableData(){return Data;} public string GetCellText(SectionType t,int row,int col){return row+":"+col;} }
}
namespace RevitLocalCodex {
 internal static class NativeModelQueries {
  internal static void Fields(Dictionary<string,object> a,params string[] names){foreach(string k in a.Keys)if(!names.Contains(k))throw new InvalidOperationException("unknown");}
  internal static int Page(Dictionary<string,object> a,string k,int fallback,int min,int max){object v;if(!a.TryGetValue(k,out v))return fallback;if(!(v is int))throw new InvalidOperationException("integer required");int n=(int)v;if(n<min||n>max)throw new InvalidOperationException("bounds");return n;}
  internal static long ExactId(Dictionary<string,object> a,string k){return Int64.Parse((string)a[k]);}
  internal static string SignedId(ElementId id){return id.Value.ToString();}
  internal class ReadBudget { internal int Scanned; internal void Scan(){Scanned++;} internal void Reserve(object o){} }
 }
 internal static class DrawingPeerProgram {
  static object P(object o,string k){return o.GetType().GetProperty(k).GetValue(o,null);} static void Check(bool ok){if(!ok)throw new Exception("assertion failed");}
  static void Main(){
   var d=new Document(); var s=new ViewSchedule{Id=new ElementId(7),Name="S",Data=new TableData{Body=new TableSectionData{NumberOfRows=120,NumberOfColumns=150,FirstRowNumber=2,FirstColumnNumber=4}}};d.Elements.Add(s);
   var a=new Dictionary<string,object>{{"schedule_id","7"},{"row_offset",3},{"row_limit",2},{"column_offset",100},{"column_limit",3}};
   object result=AecDrawingQueries.Read(d,"get_schedule_data",a);Check((int)P(result,"column_count")==150);Check((bool)P(result,"has_more_columns"));var rows=(object[])P(result,"rows");Check(rows.Length==2);Check((int)P(rows[0],"row_index")==5);var cells=(object[])P(rows[0],"cells");Check(cells.Length==3);Check((int)P(cells[0],"column_index")==104);Check((string)P(cells[0],"text")=="5:104");
   a["column_offset"]=150;result=AecDrawingQueries.Read(d,"get_schedule_data",a);Check(!(bool)P(result,"has_more_columns"));Check(((object[])P(((object[])P(result,"rows"))[0],"cells")).Length==0);
   a["column_offset"]=0;a["row_limit"]=100;a["column_limit"]=21;bool rejected=false;try{AecDrawingQueries.Read(d,"get_schedule_data",a);}catch(InvalidOperationException){rejected=true;}Check(rejected);
   a["column_limit"]=0;rejected=false;try{AecDrawingQueries.Read(d,"get_schedule_data",a);}catch(InvalidOperationException){rejected=true;}Check(rejected);
   d.Elements.Add(new Revision{Id=new ElementId(9),Name="R2",SequenceNumber=2,Issued=true});d.Elements.Add(new Revision{Id=new ElementId(8),Name="R1",SequenceNumber=1});result=AecDrawingQueries.Read(d,"get_revision_sequences",new Dictionary<string,object>{{"limit",1}});var revisions=(object[])P(result,"items");Check((string)P(revisions[0],"id")=="8");Check((bool)P(result,"has_more"));
   Console.WriteLine("drawing peer checks passed");
  }
 }
}
