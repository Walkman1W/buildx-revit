using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using BuildX.FilePreparation;
namespace RevitLocalCodex
{
 // Unregistered experiment. Directory checks are observations, not an export sandbox.
 internal sealed class UnregisteredDwgHostLease : IUnregisteredDwgStageLease
 {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectory(string path, IntPtr attributes);
  readonly GuardedSingleArtifactPublisher.JournalRoot captured;
  readonly string expectedName;
  public string StageId {get;private set;} public string DirectoryPath {get;private set;}
  internal UnregisteredDwgHostLease(string hostRoot) : this(hostRoot, "drawing.dwg") { }
  internal UnregisteredDwgHostLease(string hostRoot, string name) {
   if(name!="drawing.dwg" && name!="model.ifc")throw new ArgumentException("Unsupported fixed staging filename."); expectedName=name;
   var parent=GuardedSingleArtifactPublisher.CaptureJournalRoot(hostRoot);
   StageId=Guid.NewGuid().ToString("D"); DirectoryPath=Path.Combine(parent.Directory,StageId);
   if(!CreateDirectory(DirectoryPath,IntPtr.Zero))throw new IOException("Cannot exclusively create stage directory.");
   captured=GuardedSingleArtifactPublisher.CaptureJournalRoot(DirectoryPath);
   if(captured.Chain.Length!=parent.Chain.Length+1)throw new InvalidOperationException("Stage ancestry mismatch.");
   for(int i=0;i<parent.Chain.Length;i++)if(captured.Chain[i].Identity!=parent.Chain[i].Identity || !String.Equals(captured.Chain[i].Path,parent.Chain[i].Path,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Stage parent changed.");
  }
  public IList<DwgStageFileFact> Snapshot() {
   var current=GuardedSingleArtifactPublisher.CaptureJournalRoot(DirectoryPath);
   if(current.Chain.Length!=captured.Chain.Length)throw new InvalidOperationException("Stage identity changed.");
   for(int i=0;i<current.Chain.Length;i++)if(current.Chain[i].Identity!=captured.Chain[i].Identity || !String.Equals(current.Chain[i].Path,captured.Chain[i].Path,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Stage identity changed.");
   var facts=new List<DwgStageFileFact>();
   foreach(string path in Directory.EnumerateFileSystemEntries(DirectoryPath)) {
    if(facts.Count>=128)throw new InvalidOperationException("Stage entry budget exceeded.");
    var name=Path.GetFileName(path);
    if(!String.Equals(name,expectedName,StringComparison.Ordinal)) { facts.Add(new DwgStageFileFact {Name=name,Regular=false}); continue; }
    var plan=GuardedSingleArtifactPublisher.Prepare(path,DirectoryPath,"inspection.dwg");
    facts.Add(new DwgStageFileFact {Name=name,Identity=plan.SourceIdentity,Sha256=plan.Sha256,Bytes=plan.Bytes,Regular=true});
   }
   return facts;
  }
 }
}
