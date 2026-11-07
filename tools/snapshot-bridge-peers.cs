using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
namespace Autodesk.Revit.DB {
 public class ElementId { public long Value;public ElementId(long n){Value=n;} }
 public class Element { public ElementId Id;public string UniqueId;public bool IsValidObject=true;public Document Document; }
 public class Document { public bool IsValidObject=true;public List<Element> Elements=new List<Element>();public Action DuringEnumeration;public Element GetElement(ElementId id){return Elements.FirstOrDefault(x=>x.Id.Value==id.Value);} }
 public class ElementIsElementTypeFilter { public ElementIsElementTypeFilter(bool inverted){} }
 public class LogicalOrFilter { public LogicalOrFilter(ElementIsElementTypeFilter a,ElementIsElementTypeFilter b){} }
 public class FilteredElementCollector:IDisposable,IEnumerable<Element> { Document d;public FilteredElementCollector(Document doc){d=doc;}public FilteredElementCollector WherePasses(LogicalOrFilter x){return this;} public IEnumerator<Element> GetEnumerator(){foreach(var e in d.Elements){if(d.DuringEnumeration!=null){var act=d.DuringEnumeration;d.DuringEnumeration=null;act();}yield return e;}} IEnumerator IEnumerable.GetEnumerator(){return GetEnumerator();} public void Dispose(){} }
}
namespace Autodesk.Revit.DB.Events {
 public class DocumentChangedEventArgs:EventArgs { public bool IsValidObject=true;public Document Document;public ICollection<ElementId> Added=new List<ElementId>(),Modified=new List<ElementId>(),Deleted=new List<ElementId>();public Document GetDocument(){return Document;}public ICollection<ElementId> GetAddedElementIds(){return Added;}public ICollection<ElementId> GetModifiedElementIds(){return Modified;}public ICollection<ElementId> GetDeletedElementIds(){return Deleted;} }
 public class DocumentClosingEventArgs:EventArgs { public bool IsValidObject=true;public Document Document;public int DocumentId; }
 public class DocumentClosedEventArgs:EventArgs { public bool IsValidObject=true;public int DocumentId; }
}
namespace Autodesk.Revit.ApplicationServices {
 public class ControlledApplication { public event EventHandler<DocumentChangedEventArgs> DocumentChanged;public event EventHandler<DocumentClosingEventArgs> DocumentClosing;public event EventHandler<DocumentClosedEventArgs> DocumentClosed;public void Changed(DocumentChangedEventArgs e){if(DocumentChanged!=null)DocumentChanged(this,e);}public void Closing(DocumentClosingEventArgs e){if(DocumentClosing!=null)DocumentClosing(this,e);}public void Closed(DocumentClosedEventArgs e){if(DocumentClosed!=null)DocumentClosed(this,e);}public int Handlers{get{return (DocumentChanged==null?0:DocumentChanged.GetInvocationList().Length)+(DocumentClosing==null?0:DocumentClosing.GetInvocationList().Length)+(DocumentClosed==null?0:DocumentClosed.GetInvocationList().Length);}} }
}
namespace RevitLocalCodex {
 class SnapshotBridgePeerProgram {
  static int checks;static void Check(bool ok,string m){if(!ok)throw new Exception(m);checks++;Console.WriteLine("PASS " + m);}static void Reject(Action a,string m){try{a();}catch(InvalidOperationException){checks++;Console.WriteLine("PASS " + m);return;}throw new Exception(m);}
  static Document Doc(string uid){var d=new Document();d.Elements.Add(new Element{Id=new ElementId(1),UniqueId=uid,Document=d});return d;}
  static void Main(){var app=new ControlledApplication();var bridge=new SnapshotRevitBridge(app,"host-A");Check(app.Handlers==3,"all lifecycle events subscribed before capture");var a=Doc("a");var b=Doc("b");var oa=bridge.Capture(a,8,8);var ob=bridge.Capture(b,8,8);
   a.Elements.Add(new Element{Id=new ElementId(2),UniqueId="new",Document=a});app.Changed(new DocumentChangedEventArgs{Document=a,Added=new[]{new ElementId(2)}});Check(bridge.Read(a,oa.BaselineToken,1,0,10).Total==1&&bridge.Read(b,ob.BaselineToken,0,0,10).Total==0,"changed event resolves and isolates tracked documents");
   app.Closing(new DocumentClosingEventArgs{Document=a,DocumentId=9});app.Closed(new DocumentClosedEventArgs{DocumentId=9});Reject(()=>bridge.Read(a,oa.BaselineToken,1,0,1),"closing expires only original document");Check(bridge.Read(b,ob.BaselineToken,0,0,1).Total==0,"other tracked document remains available");
   var c=Doc("c");c.DuringEnumeration=()=>app.Changed(new DocumentChangedEventArgs{Document=c,Modified=new[]{new ElementId(1)}});Reject(()=>bridge.Capture(c,8,8),"event during baseline prevents publishing token");
   app.Changed(new DocumentChangedEventArgs{Document=b,Added=new[]{new ElementId(999)}});Reject(()=>bridge.Read(b,ob.BaselineToken,0,0,1),"missing changed identity expires baseline");
   var live=bridge.Capture(b,8,8);bridge.Dispose();Check(live.Expiry=="host_stopped"&&app.Handlers==0,"dispose expires and unsubscribes events");Console.WriteLine("PASS total="+checks);
  }
 }
}
