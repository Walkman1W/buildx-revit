using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
namespace Autodesk.Revit.DB {
 public class ElementId { public long Value; public ElementId(long v){Value=v;} }
 public class Element { public ElementId Id; public string Name; }
 public class Revision : Element { public string RevisionDate, Description; public int SequenceNumber; public bool Issued; }
 public class Document { public bool IsFamilyDocument, IsLinked, IsReadOnly; public List<Element> Elements = new List<Element>(); public Element GetElement(ElementId id){return Elements.FirstOrDefault(e=>e.Id.Value==id.Value);} }
 public class FilteredElementCollector : IEnumerable, IDisposable { Document d; Type t; public FilteredElementCollector(Document doc){d=doc;} public FilteredElementCollector OfClass(Type type){t=type;return this;} public IEnumerator GetEnumerator(){return d.Elements.Where(e=>t.IsInstanceOfType(e)).GetEnumerator();} public void Dispose(){} }
 public enum SectionType { Body }
 public class TableSectionData { public int NumberOfRows, NumberOfColumns, FirstRowNumber, FirstColumnNumber; }
 public class TableData { public TableSectionData Body; public TableSectionData GetSectionData(SectionType t){return Body;} }
 public class View : Element { public bool IsTemplate; public bool CanBePrinted; }
 public class View3D : View { }
 public class ViewSheet : View { public bool IsPlaceholder; }
 public static class OptionalFunctionalityUtils { public static bool Available=true, NwcAvailable=true, NwcThrows=false, IfcAvailable=true, IfcThrows=false; public static bool IsIFCAvailable(){if(IfcThrows)throw new InvalidOperationException("exporter failure");return IfcAvailable;} public static bool IsDWGExportAvailable(){return Available;} public static bool IsNavisworksExporterAvailable(){if(NwcThrows)throw new InvalidOperationException("exporter failure");return NwcAvailable;} }
 public static class BaseExportOptions { public static List<string> Names=new List<string>(); public static IList<string> GetPredefinedSetupNames(Document d){return Names;} }
 public class ViewSchedule : View { public TableData Data; public TableData GetTableData(){return Data;} public string GetCellText(SectionType t,int row,int col){return row+":"+col;} }
}
namespace RevitLocalCodex {
 internal static class NativeModelQueries {
  internal static void Fields(Dictionary<string,object> a,params string[] names){foreach(string k in a.Keys)if(!names.Contains(k))throw new InvalidOperationException("unknown");}
  internal static int Page(Dictionary<string,object> a,string k,int fallback,int min,int max){object v;if(!a.TryGetValue(k,out v))return fallback;if(!(v is int))throw new InvalidOperationException("integer required");int n=(int)v;if(n<min||n>max)throw new InvalidOperationException("bounds");return n;}
  internal static long ExactId(Dictionary<string,object> a,string k){object v; long n;if(!a.TryGetValue(k,out v) || !(v is string) || !Int64.TryParse((string)v,out n) || n<=0 || n.ToString()!=(string)v)throw new InvalidOperationException("invalid id");return n;}
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
   var q=new Dictionary<string,object>{{"view_id","10"}}; d.Elements.Add(new View{Id=new ElementId(10),CanBePrinted=true});
   result=AecDrawingQueries.Read(d,"preview_dwg_export",q);Check((string)P(result,"view_id")=="10" && (string)P(result,"view_status")=="printable" && (bool)P(result,"exporter_available") && P(result,"setup_name")==null && P(result,"setup_found")==null);
   BaseExportOptions.Names.Add("Exact");q["setup_name"]="Exact";result=AecDrawingQueries.Read(d,"preview_dwg_export",q);Check((bool)P(result,"setup_found"));q["setup_name"]="exact";result=AecDrawingQueries.Read(d,"preview_dwg_export",q);Check(!(bool)P(result,"setup_found"));
   d.Elements.Add(new View{Id=new ElementId(11),IsTemplate=true,CanBePrinted=true});d.Elements.Add(new ViewSheet{Id=new ElementId(12),IsPlaceholder=true,CanBePrinted=true});d.Elements.Add(new View{Id=new ElementId(13)});
   q.Remove("setup_name"); string[] ids={"11","12","13","999","9"};string[] statuses={"template","not_printable","not_printable","missing_or_not_view","missing_or_not_view"};for(int i=0;i<ids.Length;i++){q["view_id"]=ids[i];result=AecDrawingQueries.Read(d,"preview_dwg_export",q);Check((string)P(result,"view_status")==statuses[i]);}
   OptionalFunctionalityUtils.Available=false;result=AecDrawingQueries.Read(d,"preview_dwg_export",q);Check(!(bool)P(result,"exporter_available"));
   q["view_id"]="10";foreach(object bad in new object[]{null,"", " x", "x ","x\u0085","\ufeffx",new string('a',256),42}){q["setup_name"]=bad;rejected=false;try{AecDrawingQueries.Read(d,"preview_dwg_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);}q.Remove("setup_name");
   foreach(string bad in new[]{"0","-1","1.0","01"}){q["view_id"]=bad;rejected=false;try{AecDrawingQueries.Read(d,"preview_dwg_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);}q["view_id"]="10";q["unexpected"]=true;rejected=false;try{AecDrawingQueries.Read(d,"preview_dwg_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);q.Remove("unexpected");d.IsFamilyDocument=true;rejected=false;try{AecDrawingQueries.Read(d,"preview_dwg_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);
   d.IsFamilyDocument=false; d.Elements.Add(new View3D{Id=new ElementId(20),CanBePrinted=true});d.Elements.Add(new View3D{Id=new ElementId(21),IsTemplate=true,CanBePrinted=true});d.Elements.Add(new View3D{Id=new ElementId(22)});
   Check(AecDrawingQueries.IsRead("preview_nwc_export"));q.Clear();q["expected_document"]=new object();string[] nwcIds={"20","21","22","10","999","9"};string[] nwcStatuses={"printable_3d","template","not_printable","missing_or_not_3d_view","missing_or_not_3d_view","missing_or_not_3d_view"};
   for(int i=0;i<nwcIds.Length;i++){q["view_id"]=nwcIds[i];result=AecDrawingQueries.Read(d,"preview_nwc_export",q);Check((int)P(result,"schema_version")==1 && (string)P(result,"view_id")==nwcIds[i] && (string)P(result,"view_status")==nwcStatuses[i] && (bool)P(result,"exporter_available") && result.GetType().GetProperties().Length==4);}
   OptionalFunctionalityUtils.NwcAvailable=false;result=AecDrawingQueries.Read(d,"preview_nwc_export",q);Check(!(bool)P(result,"exporter_available"));OptionalFunctionalityUtils.NwcThrows=true;rejected=false;try{AecDrawingQueries.Read(d,"preview_nwc_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);OptionalFunctionalityUtils.NwcThrows=false;
   foreach(object bad in new object[]{null,0, "0","-1","1.0","01"," 20","9223372036854775808"}){q["view_id"]=bad;rejected=false;try{AecDrawingQueries.Read(d,"preview_nwc_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);}q.Remove("view_id");rejected=false;try{AecDrawingQueries.Read(d,"preview_nwc_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);
   q["view_id"]="20";q["setup_name"]="x";rejected=false;try{AecDrawingQueries.Read(d,"preview_nwc_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);q.Remove("setup_name");d.IsFamilyDocument=true;rejected=false;try{AecDrawingQueries.Read(d,"preview_nwc_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);
   d.IsFamilyDocument=false; Check(AecDrawingQueries.IsRead("preview_ifc_export")); q.Clear();q["expected_document"]=new object();
   string[] ifcIds={"10","11","12","13","999","9"}; string[] ifcStatuses={"non_template_view","template","non_template_view","non_template_view","missing_or_not_view","missing_or_not_view"};
   for(int i=0;i<ifcIds.Length;i++){q["view_id"]=ifcIds[i];result=AecDrawingQueries.Read(d,"preview_ifc_export",q);Check((int)P(result,"schema_version")==1 && (string)P(result,"view_id")==ifcIds[i] && (string)P(result,"view_status")==ifcStatuses[i] && (bool)P(result,"exporter_available") && !(bool)P(result,"document_read_only") && result.GetType().GetProperties().Length==5);}
   d.IsReadOnly=true;OptionalFunctionalityUtils.IfcAvailable=false;result=AecDrawingQueries.Read(d,"preview_ifc_export",q);Check((bool)P(result,"document_read_only") && !(bool)P(result,"exporter_available"));
   OptionalFunctionalityUtils.IfcThrows=true;rejected=false;try{AecDrawingQueries.Read(d,"preview_ifc_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);OptionalFunctionalityUtils.IfcThrows=false;
   foreach(object bad in new object[]{null,0,"0","-1","1.0","01"," 20","9223372036854775808"}){q["view_id"]=bad;rejected=false;try{AecDrawingQueries.Read(d,"preview_ifc_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);}q.Remove("view_id");rejected=false;try{AecDrawingQueries.Read(d,"preview_ifc_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);
   q["view_id"]="10";q["setup_name"]="x";rejected=false;try{AecDrawingQueries.Read(d,"preview_ifc_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);q.Remove("setup_name");
   d.IsFamilyDocument=true;rejected=false;try{AecDrawingQueries.Read(d,"preview_ifc_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);d.IsFamilyDocument=false;d.IsLinked=true;rejected=false;try{AecDrawingQueries.Read(d,"preview_ifc_export",q);}catch(InvalidOperationException){rejected=true;}Check(rejected);
   Console.WriteLine("drawing peer checks passed, including IFC preview");
  }
 }
}
