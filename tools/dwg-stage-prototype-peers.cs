using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
namespace Autodesk.Revit.DB {
 public class ElementId { public long Value;public ElementId(long x){Value=x;} }
 public class View { public Document Document; public ElementId Id;public bool IsValidObject=true,IsTemplate,CanBePrinted=true; }
 public enum ACADVersion { R2018 }
 public class DWGExportOptions:IDisposable { public ACADVersion FileVersion; public bool MergedViews; public void Dispose(){} }
 public class Document { public bool IsFamilyDocument, ReturnValue=true, ThrowAfterWrite, Extra;public int Calls;public View View;
  public object GetElement(ElementId x){return View!=null&&View.Id.Value==x.Value?View:null;}
  public bool Export(string directory,string name,ICollection<ElementId> views,DWGExportOptions options){Calls++;if(name!="drawing"||views.Count!=1||options.FileVersion!=ACADVersion.R2018||!options.MergedViews)throw new Exception("bad export request");File.WriteAllText(Path.Combine(directory,"drawing.dwg"),"mock");if(Extra)File.WriteAllText(Path.Combine(directory,"extra.txt"),"extra");if(ThrowAfterWrite)throw new IOException("mock");return ReturnValue;}
 }
}
namespace Autodesk.Revit.UI { public class UIDocument { public Document Document; } public class UIApplication { public UIDocument ActiveUIDocument; } }
namespace RevitLocalCodex {
 class FakeLease:IUnregisteredDwgStageLease { public bool ThrowSnapshot; public string StageId {get;private set;} public string DirectoryPath {get;private set;} public FakeLease(string root){StageId=Guid.NewGuid().ToString("D");DirectoryPath=Path.Combine(root,StageId);Directory.CreateDirectory(DirectoryPath);} public IList<DwgStageFileFact> Snapshot(){if(ThrowSnapshot)throw new InvalidOperationException("snapshot failed");return Directory.GetFiles(DirectoryPath).Select(p=>new DwgStageFileFact{Name=Path.GetFileName(p),Identity="mock:"+Path.GetFileName(p),Regular=true,Bytes=new FileInfo(p).Length,Sha256=Digest(p)}).ToList();} static string Digest(string p){using(var h=SHA256.Create())using(var f=File.OpenRead(p))return BitConverter.ToString(h.ComputeHash(f)).Replace("-","").ToLowerInvariant();} }
 class Program { static void Check(bool x,string m){if(!x)throw new Exception(m);Console.WriteLine("PASS "+m);} static void Main(string[] args){string root=Path.GetFullPath(args[0]);if(Directory.Exists(root))throw new Exception("new isolated root required");Directory.CreateDirectory(root);string request="40207aac-335d-4d26-a785-29c384f0559a";var doc=new Document{View=new View{Id=new ElementId(42)}};doc.View.Document=doc;var app=new UIApplication{ActiveUIDocument=new UIDocument{Document=doc}};
  var lease=new FakeLease(root);var r=UnregisteredDwgStagePrototype.Run(app,42,request,lease);Check(r.Outcome=="exporter_returned_true"&&r.ObservedFiles.Length==1&&r.ExpectedSingleDwg&&!r.ManifestComplete&&!r.PublicationAuthorized,"single mock output remains unpublishable");
  doc.Extra=true;lease=new FakeLease(root);r=UnregisteredDwgStagePrototype.Run(app,42,request,lease);Check(r.ObservedFiles.Length==2&&!r.ExpectedSingleDwg&&File.Exists(Path.Combine(lease.DirectoryPath,"extra.txt")),"extra outputs retained and refused");
  doc.Extra=false;doc.ReturnValue=false;lease=new FakeLease(root);r=UnregisteredDwgStagePrototype.Run(app,42,request,lease);Check(r.Outcome=="exporter_returned_false"&&r.ObservedFiles.Length==1&&!r.PublicationAuthorized,"false return retains observed output");
  doc.ThrowAfterWrite=true;lease=new FakeLease(root);r=UnregisteredDwgStagePrototype.Run(app,42,request,lease);Check(r.Outcome=="exporter_threw"&&r.ObservedFiles.Length==1&&!r.PublicationAuthorized,"exception retains observed output");
  doc.ThrowAfterWrite=false;doc.ReturnValue=true;lease=new FakeLease(root);lease.ThrowSnapshot=true;int snapshotCalls=doc.Calls;try{UnregisteredDwgStagePrototype.Run(app,42,request,lease);throw new Exception("unknown snapshot accepted");}catch(InvalidOperationException){Check(doc.Calls==snapshotCalls+1&&File.Exists(Path.Combine(lease.DirectoryPath,"drawing.dwg")),"snapshot failure retains output without replay");}
  int before=doc.Calls;doc.View.CanBePrinted=false;try{UnregisteredDwgStagePrototype.Run(app,42,request,new FakeLease(root));throw new Exception("invalid view accepted");}catch(InvalidOperationException){Check(doc.Calls==before,"invalid view never calls exporter");}
 }
 }
}
