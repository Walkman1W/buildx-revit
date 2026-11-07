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
 public class ControlledApplication { public bool FailClosingSubscribe,FailClosedRemove;private EventHandler<DocumentChangedEventArgs> changed;private EventHandler<DocumentClosingEventArgs> closing;private EventHandler<DocumentClosedEventArgs> closed;
 public event EventHandler<DocumentChangedEventArgs> DocumentChanged { add{changed+=value;} remove{changed-=value;} }
 public event EventHandler<DocumentClosingEventArgs> DocumentClosing { add{if(FailClosingSubscribe)throw new InvalidOperationException("subscription failure");closing+=value;} remove{closing-=value;} }
 public event EventHandler<DocumentClosedEventArgs> DocumentClosed { add{closed+=value;} remove{if(FailClosedRemove)throw new InvalidOperationException("unsubscribe failure");closed-=value;} }
public void Changed(DocumentChangedEventArgs e){if(changed!=null)changed(this,e);}public void Closing(DocumentClosingEventArgs e){if(closing!=null)closing(this,e);}public void Closed(DocumentClosedEventArgs e){if(closed!=null)closed(this,e);}public int Handlers{get{return (changed==null?0:changed.GetInvocationList().Length)+(closing==null?0:closing.GetInvocationList().Length)+(closed==null?0:closed.GetInvocationList().Length);}} }
}
namespace RevitLocalCodex {
 class SnapshotBridgePeerProgram {
  static int checks;static void Check(bool ok,string m){if(!ok)throw new Exception(m);checks++;Console.WriteLine("PASS " + m);}static void Reject(Action a,string m){try{a();}catch(InvalidOperationException){checks++;Console.WriteLine("PASS " + m);return;}throw new Exception(m);}
  static object Prop(object value,string name){return value.GetType().GetProperty(name).GetValue(value,null);}
  static Dictionary<string,object> Args(string action){return new Dictionary<string,object>{{"expected_document","fixture"},{"action",action}};}
  static Dictionary<string,object> PageArgs(string token,long version,int offset,int limit){return new Dictionary<string,object>{{"expected_document","fixture"},{"action","page"},{"baseline_token",token},{"expected_version",version},{"offset",offset},{"limit",limit}};}
  static Document Doc(string uid){var d=new Document();d.Elements.Add(new Element{Id=new ElementId(1),UniqueId=uid,Document=d});return d;}
  static void Main(){var badApp=new ControlledApplication{FailClosingSubscribe=true};Reject(()=>new SnapshotRevitBridge(badApp,"host-A"),"subscription failure rejected");Check(badApp.Handlers==0,"partial subscription cleaned up");var app=new ControlledApplication();var bridge=new SnapshotRevitBridge(app,"host-A");Check(app.Handlers==3,"all lifecycle events subscribed before capture");app.Changed(null);app.Closing(null);app.Closed(null);var a=Doc("a");var b=Doc("b");Check((string)Prop(bridge.Query(a,Args("status")),"state")=="none","no baseline status is explicit");var started=bridge.Query(a,Args("start"));Check((string)Prop(started,"state")=="active"&&(int?)Prop(started,"baseline_count")==1,"explicit start returns complete baseline");var oa=bridge.StartOrCurrent(a,8,8);var ob=bridge.StartOrCurrent(b,8,8);Check(Object.ReferenceEquals(oa,bridge.StartOrCurrent(a,8,8)) && oa.BaselineCount==1,"repeated start retains complete original baseline");
   a.Elements.Add(new Element{Id=new ElementId(2),UniqueId="new",Document=a});app.Changed(new DocumentChangedEventArgs{Document=a,Added=new[]{new ElementId(2)}});Check(bridge.Read(a,oa.BaselineToken,1,0,10).Total==1&&bridge.Read(b,ob.BaselineToken,0,0,10).Total==0,"changed event resolves and isolates tracked documents");Check(Object.ReferenceEquals(oa,bridge.StartOrCurrent(a,8,8)) && oa.Version==1,"repeated start preserves event version and token");
   var paged=bridge.Query(a,PageArgs(oa.BaselineToken,1,0,1));Check((int)Prop(paged,"total")==1&&(bool)Prop(paged,"has_more")==false,"page is bound to requested version");Reject(()=>bridge.Query(a,PageArgs(oa.BaselineToken,0,0,1)),"stale page version rejected");Reject(()=>bridge.Query(a,PageArgs(oa.BaselineToken,1,0,101)),"oversize page rejected");
   app.Closing(new DocumentClosingEventArgs{Document=a,DocumentId=9});app.Closed(new DocumentClosedEventArgs{DocumentId=9});Reject(()=>bridge.Read(a,oa.BaselineToken,1,0,1),"closing expires only original document");Check((string)Prop(bridge.Query(a,Args("status")),"state")=="none","closed owner has no page baseline");Check(bridge.Read(b,ob.BaselineToken,0,0,1).Total==0,"other tracked document remains available");
   var c=Doc("c");c.DuringEnumeration=()=>app.Changed(new DocumentChangedEventArgs{Document=c,Modified=new[]{new ElementId(1)}});Reject(()=>bridge.Capture(c,8,8),"event during baseline prevents publishing token");
   app.Changed(new DocumentChangedEventArgs{Document=b,Added=new[]{new ElementId(999)}});Reject(()=>bridge.Read(b,ob.BaselineToken,0,0,1),"missing changed identity expires baseline");
   var live=bridge.StartOrCurrent(b,8,8);Check(live.BaselineToken!=ob.BaselineToken && live.Version==0,"explicit start after expiry creates a new baseline token");bridge.Dispose();Check(live.Expiry=="host_stopped"&&app.Handlers==0,"dispose expires and unsubscribes events");
   var faultApp=new ControlledApplication();var faultBridge=new SnapshotRevitBridge(faultApp,"host-A");var tracked=Doc("tracked");var untracked=Doc("untracked");var initial=faultBridge.StartOrCurrent(tracked,8,8);faultApp.Changed(new DocumentChangedEventArgs{Document=untracked});
   bool explicitRecovery=false;try{faultBridge.Query(tracked,Args("status"));}catch(InvalidOperationException e){explicitRecovery=e.Message.Contains("action=start")&&e.Message.Contains("token");}Check(explicitRecovery,"faulted status explains explicit start and old token invalidation");
   var recovered=faultBridge.Query(tracked,Args("start"));Check((string)Prop(recovered,"state")=="active" && (string)Prop(recovered,"baseline_token")!=initial.BaselineToken,"explicit start rebuilds after unrelated document event");Reject(()=>faultBridge.Read(tracked,initial.BaselineToken,0,0,1),"bridge recovery rejects old token");faultBridge.Dispose();
   var failingDispose=new ControlledApplication{FailClosedRemove=true};var otherBridge=new SnapshotRevitBridge(failingDispose,"host-A");var otherDoc=Doc("x");var otherOwner=otherBridge.Capture(otherDoc,8,8);otherBridge.Dispose();Check(otherOwner.Expiry=="host_stopped","unsubscribe failure still expires baselines");failingDispose.Closed(null);Check(failingDispose.Handlers==1,"leftover callback is inert after dispose");Console.WriteLine("PASS total="+checks);
  }
 }
}
