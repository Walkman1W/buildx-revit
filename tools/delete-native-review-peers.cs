using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
namespace Autodesk.Revit.UI {
 [Flags] public enum TaskDialogCommonButtons { Yes=1,No=2 }
 public enum TaskDialogResult { Yes,No }
 public class TaskDialog { public static readonly Queue<TaskDialogResult> Replies=new Queue<TaskDialogResult>();public static readonly List<string> Shown=new List<string>();public string MainInstruction,MainContent;public TaskDialogCommonButtons CommonButtons;public TaskDialogResult DefaultButton;public TaskDialog(string title){} public TaskDialogResult Show(){Shown.Add(MainContent);return Replies.Dequeue();} }
}
namespace RevitLocalCodex {
 class NativeReviewTests {
  static string req="3dd22134-29e8-4b12-a71a-c24503c99139",session=new string('a',32);
  static Document Doc(){var d=new Document();d.Elements[3]=new ViewSheet{Id=new ElementId(3),UniqueId="uid-3"};d.Elements[15]=new Element{Id=new ElementId(15),UniqueId="uid-15"};return d;}
  static void Ok(bool b,string label){if(!b)throw new Exception(label);Console.WriteLine("PASS "+label);}
  static void Fail(Action a,string label,bool unknown=false){try{a();}catch(DeleteRollbackPreview.RollbackUnknownException){if(!unknown)throw;Console.WriteLine("PASS "+label);return;}catch(InvalidOperationException){if(unknown)throw;Console.WriteLine("PASS "+label);return;}throw new Exception("Expected rejection: "+label);}
  static DeleteNativeReviewWorkflow.Result Controlled(Document d,string mode,Func<bool> current,Func<DeleteNativeReviewWorkflow.Stage,Document,long,string,DeleteRollbackPreview.Result,bool> decision){return DeleteNativeReviewWorkflow.ExecuteForTest(d,d.PathName,3,"uid-3",req,session,"sheet",mode,current,decision);}
  static void Main(){var d=Doc();var stages=new List<DeleteNativeReviewWorkflow.Stage>();Func<DeleteNativeReviewWorkflow.Stage,Document,long,string,DeleteRollbackPreview.Result,bool> yes=(s,x,id,u,p)=>{stages.Add(s);return true;};
   var r=Controlled(d,"commit",()=>true,yes);Ok(r.Status=="committed" && stages.Count==2 && stages[0]==DeleteNativeReviewWorkflow.Stage.Preview && stages[1]==DeleteNativeReviewWorkflow.Stage.Delete && d.DeleteCalls==2 && d.Elements.Count==0,"two decisions gate preview and commit");
   d=Doc();r=Controlled(d,"commit",()=>true,(s,x,id,u,p)=>false);Ok(r.Status=="preview_declined"&&d.DeleteCalls==0,"first decline prevents preview");
   d=Doc();r=Controlled(d,"commit",()=>true,(s,x,id,u,p)=>s==DeleteNativeReviewWorkflow.Stage.Preview);Ok(r.Status=="delete_declined"&&d.DeleteCalls==1&&d.Elements.Count==2,"second decline preserves rollback");
   d=Doc();r=Controlled(d,"rollback",()=>true,(s,x,id,u,p)=>true);Ok(r.Status=="preview_rolled_back"&&d.DeleteCalls==1&&d.Elements.Count==2,"rollback mode never commits deletion");
   d=Doc();d.SecondMismatch=true;var bad=d;Fail(()=>Controlled(bad,"commit",()=>true,(s,x,id,u,p)=>true),"second delete cascade mismatch fails");Ok(d.Elements.Count==2,"cascade mismatch rolls back group");
   d=Doc();bool active=true;bad=d;Fail(()=>Controlled(bad,"commit",()=>active,(s,x,id,u,p)=>{if(s==DeleteNativeReviewWorkflow.Stage.Delete)active=false;return true;}),"revoked access after confirmation");Ok(d.DeleteCalls==1&&d.Elements.Count==2,"revocation prevents second deletion");
   d=Doc();bad=d;Fail(()=>Controlled(bad,"commit",()=>bad.DeleteCalls<2,(s,x,id,u,p)=>true),"revocation during delete");Ok(d.Elements.Count==2,"revocation rolls back completed inner transaction");
   d=Doc();d.SecondMismatch=true;bad=d;Fail(()=>Controlled(bad,"commit",()=>true,(s,x,id,u,p)=>{if(s==DeleteNativeReviewWorkflow.Stage.Delete)x.RestoreDrift=true;return true;}),"failed rollback identity verification remains unknown",true);
   d=Doc();bad=d;var outer=Controlled(d,"commit",()=>true,(s,x,id,u,p)=>{Fail(()=>Controlled(bad,"commit",()=>true,(a,b,c,e,f)=>true),"concurrent delete review rejected");return false;});Ok(outer.Status=="preview_declined"&&d.DeleteCalls==0,"concurrent attempt has no effects");
   d=Doc();d.AssimilateUnknown=true;bad=d;Fail(()=>Controlled(bad,"commit",()=>true,(s,x,id,u,p)=>true),"unknown group completion remains unknown",true);
   d=Doc();Autodesk.Revit.UI.TaskDialog.Replies.Enqueue(Autodesk.Revit.UI.TaskDialogResult.Yes);Autodesk.Revit.UI.TaskDialog.Replies.Enqueue(Autodesk.Revit.UI.TaskDialogResult.No);r=DeleteNativeReviewWorkflow.Execute(d,d.PathName,3,"uid-3",req,session,"sheet","commit",()=>true);Ok(r.Status=="delete_declined"&&d.DeleteCalls==1&&d.Elements.Count==2,"native dialog adapter requires second yes");Ok(Autodesk.Revit.UI.TaskDialog.Shown.Count==2&&Autodesk.Revit.UI.TaskDialog.Shown[1].Contains("uid-3")&&Autodesk.Revit.UI.TaskDialog.Shown[1].Contains("uid-15"),"second dialog contains all affected identities");
  }
 }
}
