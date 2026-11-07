using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
namespace RevitLocalCodex {
 class DeleteQueueTransportPeer {
  static void Main(string[] argv){string queue=argv[0],id=argv[1],scenario=argv[2];var json=new JavaScriptSerializer();
   string inbox=Path.Combine(queue,"inbox",id+".json"),claimed=Path.Combine(queue,"processing",id+".json"),outbox=Path.Combine(queue,"outbox",id+".json");
   if(!File.Exists(inbox)||File.Exists(claimed)||File.Exists(outbox))throw new InvalidOperationException("original request unavailable or already claimed");
   File.Move(inbox,claimed);var request=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(claimed));var args=(Dictionary<string,object>)request["args"];
   string session=(string)request["targetSession"];var access=(Dictionary<string,object>)request["accessPolicy"];var doc=new Document();doc.Elements[3]=new ViewSheet{Id=new ElementId(3),UniqueId="uid-3"};doc.Elements[15]=new Element{Id=new ElementId(15),UniqueId="uid-15"};
   if(scenario=="unknown")doc.RollbackUnknown=true;
   TaskDialog.Replies.Clear();TaskDialog.Replies.Enqueue(scenario=="first_no"?TaskDialogResult.No:TaskDialogResult.Yes);if(scenario=="second_no")TaskDialog.Replies.Enqueue(TaskDialogResult.No);
   object envelope;try{
    if((string)request["id"]!=id||(string)request["operation"]!="internal_delete_review_candidate"||(string)access["accountScope"]!="test")throw new InvalidOperationException("claimed context mismatch");
    DateTime expires=DateTime.Parse((string)request["expiresUtc"],null,System.Globalization.DateTimeStyles.AdjustToUniversal).ToUniversalTime();
    object result=DeleteReviewHostAdapter.Run(doc,id,session,expires,args,()=>doc,(a,b)=>Object.ReferenceEquals(a,b),(d,p)=>{if(p!=d.PathName)throw new InvalidOperationException();},(r,s)=>DeleteReviewCancellation.Requested(queue,r,s));
    envelope=new{id,ok=true,result,completedUtc=DateTime.UtcNow.ToString("o")};
   }catch(DeleteRollbackPreview.RollbackUnknownException){envelope=new{id,ok=false,hostSession=session,error=new{code="DELETE_REVIEW_OUTCOME_UNKNOWN",message="unknown"},execution=new{started=true,phase="dispatch",reason=(string)null},completedUtc=DateTime.UtcNow.ToString("o")};}
   catch(Exception e){envelope=new{id,ok=false,hostSession=session,error=new{code=e.GetType().Name,message=e.Message},execution=new{started=true,phase="dispatch",reason=(string)null},completedUtc=DateTime.UtcNow.ToString("o")};}
   File.WriteAllText(outbox,json.Serialize(envelope));
  }
 }
}
