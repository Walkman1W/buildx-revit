#if BUILDX_EXPERIMENTAL_NWC_EXPORT || BUILDX_TESTS
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using BuildX.FilePreparation;
namespace RevitLocalCodex
{
    // Not a sandbox: captures filesystem identities as observations only.
    // No exposed request can choose the internal root or a stage path.
    internal sealed class UnregisteredNwcHostLease:IUnregisteredNwcStageLease
    {
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectory(string path,IntPtr attributes);
        readonly GuardedSingleArtifactPublisher.JournalRoot captured;
        readonly object gate=new object();bool used;
        public string StageId {get;private set;} public string DirectoryPath {get;private set;}
        internal UnregisteredNwcHostLease(string internalHostRoot)
        {
            var parent=GuardedSingleArtifactPublisher.CaptureJournalRoot(internalHostRoot);StageId=Guid.NewGuid().ToString("D");DirectoryPath=Path.Combine(parent.Directory,StageId);
            if(!CreateDirectory(DirectoryPath,IntPtr.Zero))throw new IOException("Cannot exclusively create stage directory.");
            captured=GuardedSingleArtifactPublisher.CaptureJournalRoot(DirectoryPath);
            if(captured.Chain.Length!=parent.Chain.Length+1)throw new InvalidOperationException("Stage ancestry mismatch.");
            for(int i=0;i<parent.Chain.Length;i++)if(captured.Chain[i].Identity!=parent.Chain[i].Identity||!String.Equals(captured.Chain[i].Path,parent.Chain[i].Path,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Stage parent changed.");
        }
        public bool TryBegin(string requestId){lock(gate){if(used)return false;used=true;return true;}}
        public IList<NwcStageFileFact> Snapshot()
        {
            var now=GuardedSingleArtifactPublisher.CaptureJournalRoot(DirectoryPath);
            if(now.Chain.Length!=captured.Chain.Length)throw new InvalidOperationException("Stage identity changed.");
            for(int i=0;i<now.Chain.Length;i++)if(now.Chain[i].Identity!=captured.Chain[i].Identity||!String.Equals(now.Chain[i].Path,captured.Chain[i].Path,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Stage identity changed.");
            var facts=new List<NwcStageFileFact>();
            foreach(string path in Directory.EnumerateFileSystemEntries(DirectoryPath))
            {
                if(facts.Count>=128)throw new InvalidOperationException("Stage entry budget exceeded.");string name=Path.GetFileName(path);
                if(!String.Equals(name,"model.nwc",StringComparison.Ordinal)){facts.Add(new NwcStageFileFact{Name=name,Regular=false});continue;}
                var plan=GuardedSingleArtifactPublisher.Prepare(path,DirectoryPath,"inspection.dwg");
                facts.Add(new NwcStageFileFact{Name=name,Identity=plan.SourceIdentity,Sha256=plan.Sha256,Bytes=plan.Bytes,Regular=true});
            }
            return facts;
        }
    }
}
#endif
