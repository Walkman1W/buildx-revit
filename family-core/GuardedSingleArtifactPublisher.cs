using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace BuildX.FilePreparation
{
    // Unregistered single-file primitive. Does not perform an export, grant a
    // user approval, validate a directory manifest, or roll back file effects.
    internal static class GuardedSingleArtifactPublisher
    {
        private const uint AttributeAccess=0x80, Read=0x80000000, ReadWrite=0xC0000000, Open=3, CreateNew=1, OpenReparse=0x200000, DirectoryFlag=0x2000000;
        internal const long MaxBytes=64L*1024*1024;
        [StructLayout(LayoutKind.Sequential)] private struct Info { internal uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
        [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder value,uint size,uint flags);
        internal sealed class Entry { internal readonly string Path,Identity; internal Entry(string path,string id){Path=path;Identity=id;} }
        internal sealed class Plan { internal readonly Entry[] SourceChain,DestinationChain; internal readonly string SourcePath,SourceIdentity,DestinationPath,Sha256; internal readonly long Bytes; internal Plan(Entry[] s,Entry[] d,string p,string i,string o,string h,long b){SourceChain=s;DestinationChain=d;SourcePath=p;SourceIdentity=i;DestinationPath=o;Sha256=h;Bytes=b;} }
        internal sealed class Receipt { internal readonly string DestinationPath,Sha256,Identity; internal readonly long Bytes; internal Receipt(string p,string h,string i,long b){DestinationPath=p;Sha256=h;Identity=i;Bytes=b;} }
        internal sealed class PublicationFailure:Exception { internal readonly bool TargetCreated; internal PublicationFailure(bool created,Exception cause):base("Artifact publication failed; if a target was created, retain it for explicit recovery.",cause){TargetCreated=created;} }
        private static void Require(bool value){if(!value)throw new InvalidDataException("Unverified artifact identity or path.");}
        private static bool Same(string a,string b){return String.Equals(a,b,StringComparison.OrdinalIgnoreCase);}
        private static string Local(string value)
        {
            Require(value!=null && value.Length>=3 && value.Length<30000 && Regex.IsMatch(value,@"^[A-Za-z]:\\") && value.IndexOf(':',2)<0 && value.IndexOf('/')<0 && value.IndexOf('\0')<0);
            string full=Path.GetFullPath(value);Require(Same(value.TrimEnd('\\'),full.TrimEnd('\\')));
            foreach(string part in value.Substring(3).Split('\\'))if(part.Length>0)Require(!part.EndsWith(".")&&!part.EndsWith(" ")&&!Regex.IsMatch(part,@"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)",RegexOptions.IgnoreCase));
            var drive=new DriveInfo(Path.GetPathRoot(full));Require(drive.DriveType==DriveType.Fixed && String.Equals(drive.DriveFormat,"NTFS",StringComparison.OrdinalIgnoreCase));return full;
        }
        private static Info Observe(SafeFileHandle h){Info i=default(Info);Require(h!=null&&!h.IsInvalid&&GetFileInformationByHandle(h,out i));return i;}
        private static string Identity(Info i){return i.Volume+":"+(((ulong)i.IndexHigh<<32)|i.IndexLow)+":"+i.CreationHigh+":"+i.CreationLow;}
        private static string Final(SafeFileHandle h){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,b,(uint)b.Capacity,0);Require(n>0&&n<b.Capacity&&b.ToString().StartsWith(@"\\?\",StringComparison.Ordinal)&&!b.ToString().StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase));return b.ToString().Substring(4);}
        private static void Regular(Info i,long max){Require((i.Attributes&0x410)==0&&i.Links==1&&(i.IndexHigh!=0||i.IndexLow!=0)&&(((long)i.SizeHigh<<32)|i.SizeLow)<=max);}
        private static string Digest(Stream stream){stream.Position=0;using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
        private static List<string> Paths(string directory){string end=Local(directory),root=Path.GetPathRoot(end);var list=new List<string>();string p=end;while(!Same(p.TrimEnd('\\'),root.TrimEnd('\\'))){list.Add(p);p=Path.GetDirectoryName(p);Require(p!=null&&list.Count<=64);}list.Add(root);list.Reverse();return list;}
        private static Entry[] LockDirectories(string directory,Entry[] expected,List<SafeFileHandle> handles)
        {
            List<string> paths=Paths(directory);if(expected!=null)Require(paths.Count==expected.Length);var records=new List<Entry>();
            for(int n=0;n<paths.Count;n++)
            {
                string path=paths[n];if(expected!=null)Require(Same(path,expected[n].Path));
                var h=CreateFile(path,AttributeAccess,3,IntPtr.Zero,Open,OpenReparse|DirectoryFlag,IntPtr.Zero);handles.Add(h);Info i=Observe(h);
                Require((i.Attributes&0x400)==0&&(i.Attributes&0x10)!=0&&(i.IndexHigh!=0||i.IndexLow!=0)&&Same(Final(h).TrimEnd('\\'),path.TrimEnd('\\')));
                string identity=Identity(i);if(expected!=null)Require(identity==expected[n].Identity);records.Add(new Entry(path,identity));
            }
            return records.ToArray();
        }
        private static FileStream LockFile(string path,string expected,List<SafeFileHandle> handles)
        {
            var h=CreateFile(path,Read,0,IntPtr.Zero,Open,OpenReparse,IntPtr.Zero);
            try {Info i=Observe(h);Regular(i,MaxBytes);Require(Same(Final(h),path));if(expected!=null)Require(Identity(i)==expected);return new FileStream(h,FileAccess.Read);}
            catch {h.Dispose();throw;}
        }
        private static void Close(List<SafeFileHandle> handles){for(int i=handles.Count-1;i>=0;i--)handles[i].Dispose();}
        internal sealed class JournalRoot { internal readonly string Directory; internal readonly Entry[] Chain; internal JournalRoot(string d,Entry[] c){Directory=d;Chain=c;} }
        internal sealed class JournalRecord { internal readonly string RequestId,Path,Sha256,Identity; internal readonly int Revision; internal readonly long Bytes; internal JournalRecord(string r,string p,string h,string i,int n,long b){RequestId=r;Path=p;Sha256=h;Identity=i;Revision=n;Bytes=b;} }
        internal sealed class JournalReadResult { internal readonly JournalRecord Record; internal readonly byte[] Contents; internal JournalReadResult(JournalRecord r,byte[] b){Record=r;Contents=b;} }
        private static string JournalPath(JournalRoot root,string requestId,int revision)
        {
            Require(root!=null && Regex.IsMatch(requestId??"",@"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$") && revision>=0 && revision<=99999999);
            return Local(Path.Combine(root.Directory,requestId+"."+revision.ToString("D8")+".json"));
        }
        internal static JournalRoot CaptureJournalRoot(string directory)
        {
            string path=Local(directory);var handles=new List<SafeFileHandle>();try{return new JournalRoot(path,LockDirectories(path,null,handles));}finally{Close(handles);}
        }
        internal static JournalReadResult ReadJournal(JournalRoot root,string requestId,int revision)
        {
            string path=JournalPath(root,requestId,revision);var handles=new List<SafeFileHandle>();
            try
            {
                LockDirectories(root.Directory,root.Chain,handles);
                using(var f=LockFile(path,null,handles))
                {
                    Require(f.Length>0&&f.Length<=262144);Info i=Observe(f.SafeFileHandle);byte[] bytes=new byte[(int)f.Length];int used=0;
                    while(used<bytes.Length){int n=f.Read(bytes,used,bytes.Length-used);Require(n>0);used+=n;}Require(f.ReadByte()==-1);
                    string hash;using(var sha=SHA256.Create())hash=BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
                    return new JournalReadResult(new JournalRecord(requestId,path,hash,Identity(i),revision,bytes.Length),bytes);
                }
            }
            finally{Close(handles);}
        }
        internal static JournalRecord InspectJournal(JournalRoot root,string requestId,int revision){return ReadJournal(root,requestId,revision).Record;}
        internal static JournalRecord AppendJournal(JournalRoot root,string requestId,int revision,JournalRecord previous,byte[] bytes)
        {
            string path=JournalPath(root,requestId,revision);Require(bytes!=null&&bytes.Length>0&&bytes.Length<=262144);
            Require(revision==0?previous==null:previous!=null && previous.RequestId==requestId && previous.Revision==revision-1 && previous.Bytes>0 && previous.Bytes<=262144 && Regex.IsMatch(previous.Sha256??"",@"^[a-f0-9]{64}$") && Same(previous.Path,JournalPath(root,requestId,revision-1)));
            var handles=new List<SafeFileHandle>();bool created=false;FileStream prior=null;
            try
            {
                LockDirectories(root.Directory,root.Chain,handles);
                if(previous!=null){prior=LockFile(previous.Path,previous.Identity,handles);Require(prior.Length==previous.Bytes&&Digest(prior)==previous.Sha256);}
                var h=CreateFile(path,ReadWrite,0,IntPtr.Zero,CreateNew,OpenReparse,IntPtr.Zero);
                if(h.IsInvalid){h.Dispose();throw new IOException("Journal revision already exists or is unavailable.");}created=true;
                using(var target=new FileStream(h,FileAccess.ReadWrite))
                {
                    Info initial=Observe(target.SafeFileHandle);Regular(initial,262144);Require(Same(Final(target.SafeFileHandle),path));target.Write(bytes,0,bytes.Length);target.Flush(true);
                    string hash;using(var sha=SHA256.Create())hash=BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
                    Require(target.Length==bytes.Length && Digest(target)==hash);Info final=Observe(target.SafeFileHandle);Regular(final,262144);Require(Identity(final)==Identity(initial));
                    return new JournalRecord(requestId,path,hash,Identity(final),revision,bytes.Length);
                }
            }
            catch(Exception error){throw new PublicationFailure(created,error);}
            finally{if(prior!=null)prior.Dispose();Close(handles);}
        }
        internal static Plan Prepare(string source,string destinationDirectory,string destinationName)
        {
            source=Local(source);string directory=Local(destinationDirectory);
            Require(Regex.IsMatch(destinationName??"",@"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.dwg$",RegexOptions.IgnoreCase));
            Require(!Regex.IsMatch(destinationName,@"^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.",RegexOptions.IgnoreCase));
            string destination=Local(Path.Combine(directory,destinationName));Require(!Same(source,destination));var locks=new List<SafeFileHandle>();
            try {var sourceChain=LockDirectories(Path.GetDirectoryName(source),null,locks);var destChain=LockDirectories(directory,null,locks);
                using(var stream=LockFile(source,null,locks)){Info i=Observe(stream.SafeFileHandle);long bytes=stream.Length;Require(bytes>0&&bytes<=MaxBytes);string hash=Digest(stream);return new Plan(sourceChain,destChain,source,Identity(i),destination,hash,bytes);}}
            finally{Close(locks);}
        }
        internal static Receipt Publish(Plan plan)
        {
            Require(plan!=null);var locks=new List<SafeFileHandle>();bool created=false;
            try
            {
                LockDirectories(Path.GetDirectoryName(plan.SourcePath),plan.SourceChain,locks);LockDirectories(Path.GetDirectoryName(plan.DestinationPath),plan.DestinationChain,locks);
                using(var source=LockFile(plan.SourcePath,plan.SourceIdentity,locks))
                {
                    Require(source.Length==plan.Bytes&&Digest(source)==plan.Sha256);source.Position=0;
                    var h=CreateFile(plan.DestinationPath,ReadWrite,0,IntPtr.Zero,CreateNew,OpenReparse,IntPtr.Zero);
                    if(h.IsInvalid){h.Dispose();throw new IOException("Destination already exists or cannot be created.");}
                    created=true;
                    using(var target=new FileStream(h,FileAccess.ReadWrite))
                    {
                        Info initial=Observe(target.SafeFileHandle);Regular(initial,MaxBytes);Require(Same(Final(target.SafeFileHandle),plan.DestinationPath));
                        source.CopyTo(target);target.Flush(true);Require(target.Length==plan.Bytes&&Digest(target)==plan.Sha256);
                        Info final=Observe(target.SafeFileHandle);Regular(final,MaxBytes);Require(Identity(final)==Identity(initial));
                        return new Receipt(plan.DestinationPath,plan.Sha256,Identity(final),plan.Bytes);
                    }
                }
            }
            catch(Exception error){throw new PublicationFailure(created,error);}
            finally{Close(locks);}
        }
    }
}
