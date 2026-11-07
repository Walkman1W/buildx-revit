#if BUILDX_EXPERIMENTAL_NWC_EXPORT || BUILDX_TESTS
using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
namespace RevitLocalCodex
{
    // Internal owned stage only. An observed file list does not establish a
    // sandbox, complete manifest, user destination authorization or publication.
    internal interface IUnregisteredNwcStageLease
    {
        string StageId {get;}
        string DirectoryPath {get;}
        bool TryBegin(string requestId);
        IList<NwcStageFileFact> Snapshot();
    }
    internal sealed class NwcStageFileFact {internal string Name,Identity,Sha256;internal long Bytes;internal bool Regular;}
    internal sealed class NwcStageReceipt
    {
        internal string RequestId,StageId,Outcome,ExporterOutcome;internal long ViewId;
        internal NwcStageFileFact[] ObservedFiles;
        internal bool ExpectedSingleNwc,ManifestComplete,PublicationAuthorized,AutoReplay;
    }
    internal static class UnregisteredNwcStagePrototype
    {
        internal static NwcStageReceipt Run(UIApplication uiapp,long viewId,string requestId,IUnregisteredNwcStageLease lease)
        {
            Guid request,stage;
            if(uiapp==null||uiapp.ActiveUIDocument==null||uiapp.ActiveUIDocument.Document==null||viewId<=0||!Guid.TryParseExact(requestId,"D",out request)||request==Guid.Empty||lease==null||!Guid.TryParseExact(lease.StageId,"D",out stage)||stage==Guid.Empty||String.IsNullOrEmpty(lease.DirectoryPath))throw new InvalidOperationException("A host-owned stage and explicit request/view are required.");
            Document doc=uiapp.ActiveUIDocument.Document;View3D view=doc.GetElement(new ElementId(viewId)) as View3D;
            if(doc.IsFamilyDocument||view==null||!view.IsValidObject||view.Document==null||!view.Document.Equals(doc)||view.IsTemplate||!view.CanBePrinted)throw new InvalidOperationException("An exact printable project 3D view is required.");
            string outcome;bool available;
            try{available=OptionalFunctionalityUtils.IsNavisworksExporterAvailable();}
            catch(Exception){return Result(requestId,lease.StageId,viewId,"exporter_availability_unknown",new NwcStageFileFact[0],false);}
            if(!available)return Result(requestId,lease.StageId,viewId,"exporter_unavailable",new NwcStageFileFact[0],false);
            if(!lease.TryBegin(requestId))return Result(requestId,lease.StageId,viewId,"stage_already_used",new NwcStageFileFact[0],false);
            IList<NwcStageFileFact> prior;
            try{prior=lease.Snapshot();}catch(Exception){return Result(requestId,lease.StageId,viewId,"output_observation_unknown",new NwcStageFileFact[0],false);}
            if(prior==null||prior.Count>128||prior.Any(x=>x==null||String.IsNullOrEmpty(x.Name)||x.Name.Length>255))return Result(requestId,lease.StageId,viewId,"output_observation_unknown",new NwcStageFileFact[0],false);
            if(prior.Count>0)return Result(requestId,lease.StageId,viewId,"stage_not_empty",prior.Select(x=>new NwcStageFileFact{Name=x.Name,Identity=x.Identity,Sha256=x.Sha256,Bytes=x.Bytes,Regular=x.Regular}).ToArray(),false);
            try
            {
                using(var options=new NavisworksExportOptions {ExportScope=NavisworksExportScope.View,ViewId=view.Id,Coordinates=NavisworksCoordinates.Internal,ExportLinks=false,ConvertLinkedCADFormats=false})
                    doc.Export(lease.DirectoryPath,"model",options);
                outcome="exporter_returned"; // Export is void: this is not success.
            }
            catch(Exception){outcome="exporter_threw";}
            IList<NwcStageFileFact> snapshot;
            try{snapshot=lease.Snapshot();}
            catch(Exception){return Result(requestId,lease.StageId,viewId,"output_observation_unknown",new NwcStageFileFact[0],false,outcome);}
            if(snapshot==null||snapshot.Count>128||snapshot.Any(x=>x==null||String.IsNullOrEmpty(x.Name)||x.Name.Length>255))return Result(requestId,lease.StageId,viewId,"output_observation_unknown",new NwcStageFileFact[0],false,outcome);
            var files=snapshot.Select(x=>new NwcStageFileFact{Name=x.Name,Identity=x.Identity,Sha256=x.Sha256,Bytes=x.Bytes,Regular=x.Regular}).ToArray();
            bool expected=files.Length==1&&files[0].Name=="model.nwc"&&files[0].Regular&&files[0].Bytes>0&&files[0].Bytes<=64L*1024*1024&&!String.IsNullOrEmpty(files[0].Identity)&&files[0].Sha256!=null&&files[0].Sha256.Length==64&&files[0].Sha256.All(c=>(c>='0'&&c<='9')||(c>='a'&&c<='f'));
            return Result(requestId,lease.StageId,viewId,outcome,files,expected,outcome);
        }
        private static NwcStageReceipt Result(string requestId,string stageId,long viewId,string outcome,NwcStageFileFact[] files,bool expected,string exporterOutcome=null)
        {return new NwcStageReceipt{RequestId=requestId,StageId=stageId,ViewId=viewId,Outcome=outcome,ExporterOutcome=exporterOutcome,ObservedFiles=files,ExpectedSingleNwc=expected,ManifestComplete=false,PublicationAuthorized=false,AutoReplay=false};}
    }
}
#endif
