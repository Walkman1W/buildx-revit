using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
namespace Autodesk.Revit.DB {
 public class ElementId {public long Value;public ElementId(long x){Value=x;}}
 public class View3D {public ElementId Id;public Document Document;public bool IsValidObject=true,IsTemplate,CanBePrinted=true;}
 public enum NavisworksExportScope {View,Model} public enum NavisworksCoordinates {Internal,Shared}
 public class NavisworksExportOptions:IDisposable {public NavisworksExportScope ExportScope;public ElementId ViewId;public NavisworksCoordinates Coordinates;public bool ExportLinks,ConvertLinkedCADFormats;public void Dispose(){}}
 public static class OptionalFunctionalityUtils {public static bool Available=true,Throw;public static bool IsNavisworksExporterAvailable(){if(Throw)throw new InvalidOperationException();return Available;}}
 public class Document {public bool IsFamilyDocument,Extra,ThrowAfterWrite,WriteNothing;public int Calls;public View3D View;
  public object GetElement(ElementId id){return View!=null&&View.Id.Value==id.Value?View:null;}
  public void Export(string directory,string name,NavisworksExportOptions options){Calls++;if(name!="model"||options.ExportScope!=NavisworksExportScope.View||options.ViewId.Value!=View.Id.Value||options.Coordinates!=NavisworksCoordinates.Internal||options.ExportLinks||options.ConvertLinkedCADFormats)throw new Exception("Invalid options");if(!WriteNothing)File.WriteAllText(Path.Combine(directory,"model.nwc"),"synthetic");if(Extra)File.WriteAllText(Path.Combine(directory,"extra.txt"),"extra");if(ThrowAfterWrite)throw new IOException("controlled exception");}
 }
}
namespace Autodesk.Revit.UI {public class UIDocument {public Document Document;}public class UIApplication {public UIDocument ActiveUIDocument;}}
namespace RevitLocalCodex {
 class FakeLease:IUnregisteredNwcStageLease {public bool ThrowAfterExport,used;public int Snapshots;public string StageId{get;private set;}public string DirectoryPath{get;private set;}
  public FakeLease(string root){StageId=Guid.NewGuid().ToString("D");DirectoryPath=Path.Combine(root,StageId);Directory.CreateDirectory(DirectoryPath);}public bool TryBegin(string id){if(used)return false;used=true;return true;}
  public IList<NwcStageFileFact> Snapshot(){Snapshots++;if(ThrowAfterExport&&Snapshots>1)throw new InvalidOperationException();return Directory.GetFiles(DirectoryPath).Select(p=>new NwcStageFileFact{Name=Path.GetFileName(p),Identity="mock:"+Path.GetFileName(p),Bytes=new FileInfo(p).Length,Regular=true,Sha256=Digest(p)}).ToList();}
  static string Digest(string p){using(var h=SHA256.Create())using(var f=File.OpenRead(p))return BitConverter.ToString(h.ComputeHash(f)).Replace("-","").ToLowerInvariant();}
 }
 class Program {static void Check(bool ok,string message){if(!ok)throw new Exception(message);Console.WriteLine("PASS "+message);}static void Main(string[] args){string root=Path.GetFullPath(args[0]);if(Directory.Exists(root))throw new Exception("Isolated test root must be new");Directory.CreateDirectory(root);string id="5f6ebbc8-a1f8-4446-a879-4b2980d4a3b2";var doc=new Document{View=new View3D{Id=new ElementId(42)}};doc.View.Document=doc;var app=new UIApplication{ActiveUIDocument=new UIDocument{Document=doc}};
  OptionalFunctionalityUtils.Available=false;var lease=new FakeLease(root);var r=UnregisteredNwcStagePrototype.Run(app,42,id,lease);Check(r.Outcome=="exporter_unavailable"&&doc.Calls==0&&lease.Snapshots==0&&!r.PublicationAuthorized,"missing exporter makes zero export calls");
  OptionalFunctionalityUtils.Available=true;OptionalFunctionalityUtils.Throw=true;r=UnregisteredNwcStagePrototype.Run(app,42,id,lease);Check(r.Outcome=="exporter_availability_unknown"&&doc.Calls==0,"unknown exporter availability cannot call exporter");OptionalFunctionalityUtils.Throw=false;
  r=UnregisteredNwcStagePrototype.Run(app,42,id,lease);Check(r.Outcome=="exporter_returned"&&r.ExpectedSingleNwc&&r.ObservedFiles.Length==1&&!r.ManifestComplete&&!r.PublicationAuthorized&&!r.AutoReplay,"single file observed without publishing or claiming exporter success");
  r=UnregisteredNwcStagePrototype.Run(app,42,id,lease);Check(r.Outcome=="stage_already_used"&&doc.Calls==1,"used stage cannot replay");
  doc.Extra=true;lease=new FakeLease(root);r=UnregisteredNwcStagePrototype.Run(app,42,id,lease);Check(r.ObservedFiles.Length==2&&!r.ExpectedSingleNwc&&File.Exists(Path.Combine(lease.DirectoryPath,"extra.txt")),"unexpected outputs retained and refused");
  doc.Extra=false;doc.ThrowAfterWrite=true;lease=new FakeLease(root);r=UnregisteredNwcStagePrototype.Run(app,42,id,lease);Check(r.Outcome=="exporter_threw"&&r.ObservedFiles.Length==1&&!r.PublicationAuthorized,"exception retains observed output and no replay");
  doc.ThrowAfterWrite=false;lease=new FakeLease(root){ThrowAfterExport=true};int before=doc.Calls;r=UnregisteredNwcStagePrototype.Run(app,42,id,lease);Check(r.Outcome=="output_observation_unknown"&&r.ExporterOutcome=="exporter_returned"&&doc.Calls==before+1&&File.Exists(Path.Combine(lease.DirectoryPath,"model.nwc")),"unknown observation keeps original staged output");
  lease=new FakeLease(root);File.WriteAllText(Path.Combine(lease.DirectoryPath,"existing.txt"),"do not overwrite");before=doc.Calls;r=UnregisteredNwcStagePrototype.Run(app,42,id,lease);Check(r.Outcome=="stage_not_empty"&&r.ObservedFiles.Length==1&&doc.Calls==before,"nonempty stage refused before exporter");
  lease=new FakeLease(root);doc.View.CanBePrinted=false;before=doc.Calls;try{UnregisteredNwcStagePrototype.Run(app,42,id,lease);throw new Exception("Invalid view accepted");}catch(InvalidOperationException){Check(doc.Calls==before,"invalid view never calls exporter");}
 }
 }
}
