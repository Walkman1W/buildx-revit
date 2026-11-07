using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
namespace RevitLocalCodex {
 internal static class NativeModelQueries { internal static long ExactId(Dictionary<string,object> args,string key){long n=Convert.ToInt64(args[key]);if(n<=0)throw new InvalidOperationException();return n;} }
 class HostAdapterTests {
  static string id="3dd22134-29e8-4b12-a71a-c24503c99139",session=new string('a',32),queue;
  static Document Doc(){var d=new Document();d.Elements[3]=new ViewSheet{Id=new ElementId(3),UniqueId="uid-3"};d.Elements[15]=new Element{Id=new ElementId(15),UniqueId="uid-15"};return d;}
  static void Assert(bool b,string s){if(!b)throw new Exception(s);Console.WriteLine("PASS "+s);}
  static void Fail(Action a,string s){try{a();}catch(InvalidOperationException){Console.WriteLine("PASS "+s);return;}throw new Exception(s);}
  static Dictionary<string,object> Args(Document d){return new Dictionary<string,object>{{"expected_document",d.PathName},{"mode","commit"},{"target_kind","sheet"},{"target_id",3L},{"target_unique_id","uid-3"}};}
  static void Reset(){TaskDialog.Shown.Clear();TaskDialog.Replies.Clear();TaskDialog.OnShow=null;}
  static object Run(Document d,Func<Document> active,Action<Document,string> access,Func<string,string,bool> cancelled){return DeleteReviewHostAdapter.Run(d,id,session,DateTime.UtcNow.AddSeconds(90),Args(d),active,(a,b)=>Object.ReferenceEquals(a,b),access,cancelled);}
  static string Receipt(Document d){
   string original=Path.Combine(queue,"inbox",id+".json"),claimed=Path.Combine(queue,"processing",id+".json"),outbox=Path.Combine(queue,"outbox",id+".json");
   if(!File.Exists(original)||File.Exists(claimed)||File.Exists(outbox))throw new InvalidOperationException("no replay");File.Move(original,claimed);object body;
   try{body=new{id,ok=true,result=Run(d,()=>d,(x,p)=>{},(r,s)=>DeleteReviewCancellation.Requested(queue,r,s))};}
   catch(DeleteRollbackPreview.RollbackUnknownException){body=new{id,ok=false,hostSession=session,error=new{code="DELETE_REVIEW_OUTCOME_UNKNOWN"},transaction=new{outcome="unknown"}};}
   catch(InvalidOperationException){body=new{id,ok=false,hostSession=session,error=new{code="NOT_CONFIRMED"}};}
   File.WriteAllText(outbox,new JavaScriptSerializer().Serialize(body));return outbox;
  }
  static object Field(object x,string n){return x.GetType().GetProperty(n).GetValue(x,null);}
  static void Main(string[] argv){queue=argv[0];Directory.CreateDirectory(Path.Combine(queue,"inbox"));Directory.CreateDirectory(Path.Combine(queue,"processing"));Directory.CreateDirectory(Path.Combine(queue,"outbox"));Directory.CreateDirectory(Path.Combine(queue,"cancel"));
   var d=Doc();Reset();var forged=Args(d);forged["confirmed"]=true;var fakeDoc=d;Fail(()=>DeleteReviewHostAdapter.Run(fakeDoc,id,session,DateTime.UtcNow.AddSeconds(90),forged,()=>fakeDoc,(a,b)=>Object.ReferenceEquals(a,b),(x,p)=>{},(r,s)=>false),"caller confirmed field rejected");Assert(d.DeleteCalls==0,"caller confirmation causes no deletion");Reset();TaskDialog.Replies.Enqueue(TaskDialogResult.No);var result=Run(d,()=>d,(x,p)=>{},(r,s)=>false);Assert((string)Field(result,"status")=="preview_declined"&&d.DeleteCalls==0,"host first native refusal before preview");
   d=Doc();Reset();TaskDialog.Replies.Enqueue(TaskDialogResult.Yes);TaskDialog.Replies.Enqueue(TaskDialogResult.No);result=Run(d,()=>d,(x,p)=>{},(r,s)=>false);Assert((string)Field(result,"status")=="delete_declined"&&d.DeleteCalls==1&&d.Elements.Count==2,"host second native refusal");
   d=Doc();Reset();File.WriteAllText(Path.Combine(queue,"cancel",id+".json"),"{\"schema_version\":1,\"request_id\":\""+id+"\",\"target_session\":\""+session+"\"}");var cancelledDoc=d;Fail(()=>Run(cancelledDoc,()=>cancelledDoc,(x,p)=>{},(r,s)=>DeleteReviewCancellation.Requested(queue,r,s)),"same session cancellation fails closed");Assert(d.DeleteCalls==0,"cancellation prevents preview");File.WriteAllText(Path.Combine(queue,"cancel",id+".json"),"{\"schema_version\":1,\"request_id\":\""+id+"\",\"target_session\":\""+new string('b',32)+"\"}");Assert(DeleteReviewCancellation.Requested(queue,id,session),"wrong-session marker fails closed");File.WriteAllText(Path.Combine(queue,"cancel",id+".json"),"not json");Assert(DeleteReviewCancellation.Requested(queue,id,session),"malformed marker fails closed");File.Delete(Path.Combine(queue,"cancel",id+".json"));
   d=Doc();Reset();bool permitted=true;TaskDialog.Replies.Enqueue(TaskDialogResult.Yes);TaskDialog.OnShow=n=>permitted=false;var accessDoc=d;Fail(()=>Run(accessDoc,()=>accessDoc,(x,p)=>{if(!permitted)throw new InvalidOperationException();},(r,s)=>false),"revoked policy after dialog");Assert(d.DeleteCalls==0,"revoked access prevents preview");
   d=Doc();Reset();var captured=d;var active=d;TaskDialog.Replies.Enqueue(TaskDialogResult.Yes);TaskDialog.Replies.Enqueue(TaskDialogResult.Yes);TaskDialog.OnShow=n=>{if(n==2)active=Doc();};Fail(()=>Run(captured,()=>active,(x,p)=>{},(r,s)=>false),"active document changed");Assert(d.DeleteCalls==1&&d.Elements.Count==2,"document change prevents second deletion");
   d=Doc();d.RollbackUnknown=true;Reset();TaskDialog.Replies.Enqueue(TaskDialogResult.Yes);File.WriteAllText(Path.Combine(queue,"inbox",id+".json"),"original");string receipt=Receipt(d);var parsed=(Dictionary<string,object>)new JavaScriptSerializer().DeserializeObject(File.ReadAllText(receipt));Assert((string)parsed["id"]==id && ((Dictionary<string,object>)parsed["error"])["code"].ToString()=="DELETE_REVIEW_OUTCOME_UNKNOWN" && d.DeleteCalls==1,"unknown bound to original receipt");var unknownDoc=d;Fail(()=>Receipt(unknownDoc),"no replay of claimed request");Assert(d.DeleteCalls==1,"unknown request not repeated");
  }
 }
}
