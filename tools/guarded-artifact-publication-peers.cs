using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using BuildX.FilePreparation;
class Program {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateHardLink(string link,string existing,IntPtr unused);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateSymbolicLink(string link,string target,int flags);
 static void Check(bool ok,string message){if(!ok)throw new Exception(message);Console.WriteLine("PASS "+message);}
 static void Refuse(Action action,string message){try{action();}catch(Exception){Console.WriteLine("PASS "+message);return;}throw new Exception(message);}
 static void Main(string[] args){string root=Path.GetFullPath(args[0]);if(Directory.Exists(root))throw new Exception("new test root required");Directory.CreateDirectory(root);string src=Path.Combine(root,"source"),dst=Path.Combine(root,"destination");Directory.CreateDirectory(src);Directory.CreateDirectory(dst);
  string file=Path.Combine(src,"staged.dwg");File.WriteAllText(file,"controlled drawing bytes",Encoding.UTF8);
  var plan=GuardedSingleArtifactPublisher.Prepare(file,dst,"result.dwg");var receipt=GuardedSingleArtifactPublisher.Publish(plan);Check(receipt.Bytes>0&&File.ReadAllText(receipt.DestinationPath)=="controlled drawing bytes","fresh create and digest");
  byte[] original=File.ReadAllBytes(receipt.DestinationPath);var conflict=GuardedSingleArtifactPublisher.Prepare(file,dst,"result.dwg");try{GuardedSingleArtifactPublisher.Publish(conflict);throw new Exception("overwrite accepted");}catch(GuardedSingleArtifactPublisher.PublicationFailure e){Check(!e.TargetCreated&&Convert.ToBase64String(File.ReadAllBytes(receipt.DestinationPath))==Convert.ToBase64String(original),"existing target never overwritten");}
  var stale=GuardedSingleArtifactPublisher.Prepare(file,dst,"stale.dwg");File.WriteAllText(file,"changed after preparation",Encoding.UTF8);try{GuardedSingleArtifactPublisher.Publish(stale);throw new Exception("source drift accepted");}catch(GuardedSingleArtifactPublisher.PublicationFailure e){Check(!e.TargetCreated&&!File.Exists(Path.Combine(dst,"stale.dwg")),"changed source refused before creation");}
  var replaced=GuardedSingleArtifactPublisher.Prepare(file,dst,"replaced.dwg");File.Move(file,Path.Combine(src,"original-held.dwg"));File.WriteAllText(file,"changed after preparation",Encoding.UTF8);try{GuardedSingleArtifactPublisher.Publish(replaced);throw new Exception("source swap accepted");}catch(GuardedSingleArtifactPublisher.PublicationFailure e){Check(!e.TargetCreated&&!File.Exists(Path.Combine(dst,"replaced.dwg")),"source identity swap refused even for same bytes");}
  var locked=GuardedSingleArtifactPublisher.Prepare(file,dst,"locked.dwg");using(var blocker=new FileStream(file,FileMode.Open,FileAccess.ReadWrite,FileShare.None)){try{GuardedSingleArtifactPublisher.Publish(locked);throw new Exception("locked source accepted");}catch(GuardedSingleArtifactPublisher.PublicationFailure e){Check(!e.TargetCreated&&!File.Exists(Path.Combine(dst,"locked.dwg")),"source locked by another owner refused");}}
  var moved=GuardedSingleArtifactPublisher.Prepare(file,dst,"moved.dwg");Directory.Move(dst,Path.Combine(root,"destination-old"));Directory.CreateDirectory(dst);try{GuardedSingleArtifactPublisher.Publish(moved);throw new Exception("directory swap accepted");}catch(GuardedSingleArtifactPublisher.PublicationFailure e){Check(!e.TargetCreated&&!File.Exists(Path.Combine(dst,"moved.dwg")),"destination identity swap refused");}
  Refuse(()=>GuardedSingleArtifactPublisher.Prepare(file,dst,"../escape.dwg"),"unsafe target name refused");Refuse(()=>GuardedSingleArtifactPublisher.Prepare(file,dst,"CON.dwg"),"reserved target name refused");Refuse(()=>GuardedSingleArtifactPublisher.Prepare(file,dst,"x.dwg:stream"),"alternate stream name refused");
  string redirect=Path.Combine(root,"redirect");if(CreateSymbolicLink(redirect,dst,3))Refuse(()=>GuardedSingleArtifactPublisher.Prepare(file,redirect,"link.dwg"),"reparse directory refused");else Console.WriteLine("SKIP reparse creation unavailable; no privilege changes attempted");
  string hardlink=Path.Combine(src,"hardlink.dwg");if(!CreateHardLink(hardlink,file,IntPtr.Zero))throw new Exception("fixture hardlink creation failed");Refuse(()=>GuardedSingleArtifactPublisher.Prepare(file,dst,"linked.dwg"),"multi-link source refused");
 }
}
