using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    // No production lease implementation or command registration exists.
    // The lease must be host-owned; neither models nor tool arguments supply
    // a staging path. Even a successful mock result is never publishable.
    internal interface IUnregisteredDwgStageLease
    {
        string StageId { get; }
        string DirectoryPath { get; }
        IList<DwgStageFileFact> Snapshot();
    }
    internal sealed class DwgStageFileFact
    {
        internal string Name, Identity, Sha256;
        internal long Bytes;
        internal bool Regular;
    }
    internal sealed class DwgStagePrototypeReceipt
    {
        internal string RequestId, StageId, Outcome;
        internal long ViewId;
        internal DwgStageFileFact[] ObservedFiles;
        internal bool ExpectedSingleDwg, ManifestComplete, PublicationAuthorized;
    }
    internal static class UnregisteredDwgStagePrototype
    {
        internal static DwgStagePrototypeReceipt Run(UIApplication uiapp,long viewId,string requestId,IUnregisteredDwgStageLease lease)
        {
            Guid request,stage;
            string stageId=lease==null?null:lease.StageId, directory=lease==null?null:lease.DirectoryPath;
            if(uiapp==null || uiapp.ActiveUIDocument==null || uiapp.ActiveUIDocument.Document==null || viewId<=0
                || !Guid.TryParseExact(requestId,"D",out request) || request==Guid.Empty || lease==null
                || !Guid.TryParseExact(stageId,"D",out stage) || stage==Guid.Empty || String.IsNullOrEmpty(directory))
                throw new InvalidOperationException("A host-owned staging lease and explicit request/view are required.");
            Document doc=uiapp.ActiveUIDocument.Document;
            View view=doc.GetElement(new ElementId(viewId)) as View;
            if(doc.IsFamilyDocument || view==null || !view.IsValidObject || view.Document==null || !view.Document.Equals(doc) || view.IsTemplate || !view.CanBePrinted)
                throw new InvalidOperationException("A printable project view is required.");
            string outcome;
            try
            {
                using(var options=new DWGExportOptions { FileVersion=ACADVersion.R2018, MergedViews=true })
                    outcome=doc.Export(directory,"drawing",new List<ElementId>{view.Id},options)?"exporter_returned_true":"exporter_returned_false";
            }
            catch(Exception){outcome="exporter_threw";}
            // Snapshot failure is not evidence of no output; it propagates as
            // unknown. No files are removed or replayed by this prototype.
            IList<DwgStageFileFact> snapshot=lease.Snapshot();
            if(snapshot==null || snapshot.Count>128 || snapshot.Any(x=>x==null || String.IsNullOrEmpty(x.Name) || x.Name.Length>255))
                throw new InvalidOperationException("Staging output snapshot is unavailable or exceeds its evidence budget.");
            var files=snapshot.Select(x=>new DwgStageFileFact {Name=x.Name,Identity=x.Identity,Sha256=x.Sha256,Bytes=x.Bytes,Regular=x.Regular}).ToArray();
            bool expected=files.Length==1 && files[0].Name=="drawing.dwg" && files[0].Regular && files[0].Bytes>0
                && files[0].Bytes<=64L*1024*1024 && !String.IsNullOrEmpty(files[0].Identity) && files[0].Sha256!=null && files[0].Sha256.Length==64
                && files[0].Sha256.All(c=>(c>='0'&&c<='9')||(c>='a'&&c<='f'));
            return new DwgStagePrototypeReceipt { RequestId=requestId,StageId=stageId,ViewId=viewId,Outcome=outcome,
                ObservedFiles=files,ExpectedSingleDwg=expected,ManifestComplete=false,PublicationAuthorized=false };
        }
    }
}
