using System;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
namespace RevitLocalCodex
{
 // Unregistered: intent must be persisted before any export; no replay or publication.
 internal interface IIfcOriginalRequestJournal { void RecordStarted(string requestId,string stageId,long viewId); void RecordObserved(IfcPrototypeReceipt result); }
 internal sealed class IfcPrototypeReceipt { internal string RequestId,StageId,Outcome,TransactionState; internal DwgStageFileFact[] ObservedFiles; internal bool ExpectedSingleIfc,ManifestComplete,PublicationAuthorized; }
 internal static class UnregisteredIfcStagePrototype
 {
  internal static IfcPrototypeReceipt Run(UIApplication uiapp,long viewId,string requestId,IUnregisteredDwgStageLease lease,IIfcOriginalRequestJournal journal) {
   Guid id,stage; if(uiapp==null||uiapp.ActiveUIDocument==null||uiapp.ActiveUIDocument.Document==null||viewId<=0||!Guid.TryParseExact(requestId,"D",out id)||id==Guid.Empty||lease==null||!Guid.TryParseExact(lease.StageId,"D",out stage)||stage==Guid.Empty||String.IsNullOrEmpty(lease.DirectoryPath)||journal==null)throw new InvalidOperationException("Exact original request, view, host stage and durable intent required.");
   var doc=uiapp.ActiveUIDocument.Document;var view=doc.GetElement(new ElementId(viewId)) as View;
   if(doc.IsFamilyDocument||view==null||!view.IsValidObject||view.Document==null||!view.Document.Equals(doc)||view.IsTemplate)throw new InvalidOperationException("Valid project view required.");
   if(!OptionalFunctionalityUtils.IsIFCAvailable())throw new InvalidOperationException("IFC exporter unavailable; not started.");
   journal.RecordStarted(requestId,lease.StageId,viewId);
   string outcome="unknown",txState="unknown";
   try { using(var tx=new Transaction(doc,"IFC staging preview")) { if(tx.Start()!=TransactionStatus.Started)throw new InvalidOperationException("Transaction start failed."); try { using(var options=new IFCExportOptions { FileVersion=IFCVersion.IFC4,FilterViewId=view.Id,ExportBaseQuantities=false,WallAndColumnSplitting=false,SpaceBoundaryLevel=0 }) outcome=doc.Export(lease.DirectoryPath,"model.ifc",options)?"exporter_returned_true":"exporter_returned_false"; } catch(Exception){outcome="exporter_threw";} finally { try {txState=tx.RollBack()==TransactionStatus.RolledBack?"rolled_back":"unknown";}catch(Exception){txState="unknown";} } } } catch(Exception){outcome="unknown";}
   var observed=lease.Snapshot(); if(observed==null||observed.Count>128||observed.Any(x=>x==null||String.IsNullOrEmpty(x.Name)||x.Name.Length>255))throw new InvalidOperationException("Staging observation unknown; retain original request.");
   var files=observed.ToArray();bool single=files.Length==1&&files[0].Name=="model.ifc"&&files[0].Regular&&files[0].Bytes>0&&files[0].Bytes<=64L*1024*1024&&!String.IsNullOrEmpty(files[0].Identity)&&files[0].Sha256!=null&&files[0].Sha256.Length==64&&files[0].Sha256.All(c=>(c>='0'&&c<='9')||(c>='a'&&c<='f'));
   var r=new IfcPrototypeReceipt {RequestId=requestId,StageId=lease.StageId,Outcome=outcome,TransactionState=txState,ObservedFiles=files,ExpectedSingleIfc=single,ManifestComplete=false,PublicationAuthorized=false};journal.RecordObserved(r);return r;
  }
 }
}
