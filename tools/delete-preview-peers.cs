using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
namespace Autodesk.Revit.DB {
 public enum TransactionStatus { Started,Committed,RolledBack,Pending }
 public class ElementId { public long Value;public ElementId(long id){Value=id;} }
 public class Element { public ElementId Id;public string UniqueId;public bool IsValidObject=true; }
 public class ViewSheet:Element {}
 public class Document { public bool IsValidObject=true,IsFamilyDocument,IsLinked,IsReadOnly,FailDelete,RollbackUnknown,RestoreDrift,MissingIdentity,FailCommit;public string PathName="D:\\controlled\\demo.rvt",Title="demo";public Dictionary<long,Element> Elements=new Dictionary<long,Element>();public Dictionary<long,Element> Snapshot;
  public Element GetElement(ElementId id){Element e;return Elements.TryGetValue(id.Value,out e)?e:null;}public void Regenerate(){}
  public ICollection<ElementId> Delete(ElementId id){if(FailDelete)throw new InvalidOperationException("simulated delete error");Elements.Remove(3);Elements.Remove(15);return MissingIdentity?new[]{new ElementId(3),new ElementId(99)}:new[]{new ElementId(3),new ElementId(15)};}
 }
 public class FilteredElementCollector:IDisposable,IEnumerable<Element> {Document d;public FilteredElementCollector(Document d){this.d=d;}public IEnumerator<Element> GetEnumerator(){return d.Elements.Values.GetEnumerator();}IEnumerator IEnumerable.GetEnumerator(){return GetEnumerator();}public void Dispose(){} }
 public class Transaction:IDisposable {Document d;TransactionStatus status;public Transaction(Document d,string n){this.d=d;}public TransactionStatus Start(){return status=TransactionStatus.Started;}public TransactionStatus Commit(){return status=d.FailCommit?TransactionStatus.Pending:TransactionStatus.Committed;}public TransactionStatus GetStatus(){return status;}public void RollBack(){status=TransactionStatus.RolledBack;}public void Dispose(){} }
 public class TransactionGroup:IDisposable {Document d;TransactionStatus status;public TransactionGroup(Document d,string n){this.d=d;}public TransactionStatus Start(){d.Snapshot=new Dictionary<long,Element>(d.Elements);return status=TransactionStatus.Started;}public TransactionStatus RollBack(){if(d.RollbackUnknown)return status=TransactionStatus.Pending;d.Elements=new Dictionary<long,Element>(d.Snapshot);if(d.RestoreDrift)d.Elements.Remove(15);return status=TransactionStatus.RolledBack;}public TransactionStatus GetStatus(){return status;}public void Dispose(){} }
}
namespace RevitLocalCodex {
 class Program {
  static void Assert(bool b,string label){if(!b)throw new Exception(label);Console.WriteLine("PASS "+label);}
  static Document Doc(){var d=new Document();d.Elements[3]=new ViewSheet{Id=new ElementId(3),UniqueId="uid-3"};d.Elements[15]=new Element{Id=new ElementId(15),UniqueId="uid-15"};return d;}
  static DeleteRollbackPreview.Result Run(Document d){return DeleteRollbackPreview.Capture(d,d.PathName,3,"uid-3","3dd22134-29e8-4b12-a71a-c24503c99139",new string('a',32));}
  static void Reject(Action a,string label,bool unknown=false){try{a();}catch(DeleteRollbackPreview.RollbackUnknownException){if(!unknown)throw;Console.WriteLine("PASS "+label);return;}catch(InvalidOperationException){if(unknown)throw;Console.WriteLine("PASS "+label);return;}throw new Exception("Expected failure: "+label);}
  static void Main(){var d=Doc();var r=Run(d);Assert(r.Deleted.Length==2&&r.Deleted[0].Id==3&&r.Deleted[1].UniqueId=="uid-15"&&d.Elements.Count==2,"rollback restores exact cascade identities");
   d=Doc();d.FailDelete=true;Reject(()=>Run(d),"delete failure with confirmed rollback");Assert(d.Elements.Count==2,"failed delete keeps original elements");
   d=Doc();d.MissingIdentity=true;Reject(()=>Run(d),"unknown cascade identity rejected");Assert(d.Elements.Count==2,"unknown cascade rolled back");
   d=Doc();d.FailCommit=true;Reject(()=>Run(d),"inner transaction not committed");
   d=Doc();d.RollbackUnknown=true;Reject(()=>Run(d),"unconfirmed rollback does not produce facts",true);
   d=Doc();d.RestoreDrift=true;Reject(()=>Run(d),"rollback identity drift is unknown",true);
   d=Doc();Reject(()=>DeleteRollbackPreview.Capture(d,d.PathName,3,"wrong","3dd22134-29e8-4b12-a71a-c24503c99139",new string('a',32)),"target unique id mismatch");
   d=Doc();d.PathName="different";Reject(()=>DeleteRollbackPreview.Capture(d,"original",3,"uid-3","3dd22134-29e8-4b12-a71a-c24503c99139",new string('a',32)),"document path mismatch");
  }
 }
}
