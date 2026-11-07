using System;
using System.IO;
using System.Threading;
using BuildX.FilePreparation;
class PublishOwnerTests
{
 static void Check(bool ok,string name){if(!ok)throw new Exception(name);Console.WriteLine("PASS "+name);}
 static string NewFolder(string root,string name){string p=Path.Combine(root,name);Directory.CreateDirectory(p);return p;}
 static void Main(string[] args)
 {
  if(args.Length==3){try{GuardedSingleArtifactPublisher.Prepare(args[0],args[1],"blocked.dwg");throw new Exception("Reparse point admitted");}catch(InvalidDataException){Console.WriteLine("PASS destination junction refused");return;}}
  string root=Path.GetFullPath(args[0]);if(Directory.Exists(root))throw new Exception("Expected new isolated root.");Directory.CreateDirectory(root);
  string stagePath=NewFolder(root,"stage"),dest=NewFolder(root,"destination"),journalPath=NewFolder(root,"journal");string source=Path.Combine(stagePath,"drawing.dwg");File.WriteAllText(source,"synthetic drawing");
  var stage=GuardedSingleArtifactPublisher.CaptureJournalRoot(stagePath);var journal=GuardedSingleArtifactPublisher.CaptureJournalRoot(journalPath);int decisions=0;string digest=new string('a',64);
  string id=Guid.NewGuid().ToString("D");var closed=UnregisteredDwgPublishOwner.Execute(id);Check(closed.Outcome=="not_started"&&!File.Exists(Path.Combine(dest,"result.dwg")),"production entry permanently closed");
  var success=UnregisteredDwgPublishOwner.RunForTest(id,digest,stage,journal,dest,"result.dwg",review=>{decisions++;return review.Contains("SHA-256")&&review.Contains("result.dwg");});
  Check(success.Outcome=="observed_published"&&File.ReadAllText(Path.Combine(dest,"result.dwg"))=="synthetic drawing"&&decisions==1,"synthetic approved single file published and read back");
  var recovery=UnregisteredDwgPublishOwner.InspectOriginal(journal,id,digest,2);Check(recovery.Outcome=="unknown"&&recovery.NoReplay,"restart sees original published record as unknown until reconciled");
  int before=decisions;var replay=UnregisteredDwgPublishOwner.RunForTest(id,digest,stage,journal,dest,"again.dwg",review=>{decisions++;return true;});Check(replay.Outcome=="unknown"&&decisions==before&&!File.Exists(Path.Combine(dest,"again.dwg")),"duplicate original request cannot replay");
  string interruptedId=Guid.NewGuid().ToString("D");UnregisteredDwgPublishOwner.TestBeforePublish=()=>{throw new IOException("controlled interruption");};var interrupted=UnregisteredDwgPublishOwner.RunForTest(interruptedId,digest,stage,journal,dest,"interrupted.dwg",review=>true);UnregisteredDwgPublishOwner.TestBeforePublish=null;
  Check(interrupted.Outcome=="unknown"&&UnregisteredDwgPublishOwner.InspectOriginal(journal,interruptedId,digest,1).Outcome=="unknown"&&!File.Exists(Path.Combine(dest,"interrupted.dwg")),"interruption after publication intent preserves unknown original receipt");
  string concurrentId=Guid.NewGuid().ToString("D");int concurrentDecisions=0;UnregisteredDwgPublishOwner.Result left=null,right=null;
  var threadA=new Thread(()=>left=UnregisteredDwgPublishOwner.RunForTest(concurrentId,digest,stage,journal,dest,"concurrent-a.dwg",review=>{Interlocked.Increment(ref concurrentDecisions);return true;}));
  var threadB=new Thread(()=>right=UnregisteredDwgPublishOwner.RunForTest(concurrentId,digest,stage,journal,dest,"concurrent-b.dwg",review=>{Interlocked.Increment(ref concurrentDecisions);return true;}));
  threadA.Start();threadB.Start();threadA.Join();threadB.Join();Check(concurrentDecisions<=1&&((left.Outcome=="observed_published"?1:0)+(right.Outcome=="observed_published"?1:0))<=1,"concurrent duplicate cannot publish twice");
  string raceId=Guid.NewGuid().ToString("D");UnregisteredDwgPublishOwner.TestBeforePublish=()=>File.WriteAllText(Path.Combine(stagePath,"raced-extra.txt"),"extra");
  var race=UnregisteredDwgPublishOwner.RunForTest(raceId,digest,stage,journal,dest,"raced.dwg",review=>true);UnregisteredDwgPublishOwner.TestBeforePublish=null;
  Check(race.Outcome=="observed_published"&&File.Exists(Path.Combine(stagePath,"raced-extra.txt")),"counterexample: extra output can race final stage enumeration; production remains closed");File.Delete(Path.Combine(stagePath,"raced-extra.txt"));
  string collision=Path.Combine(dest,"existing.dwg");File.WriteAllText(collision,"preserve");var conflict=UnregisteredDwgPublishOwner.RunForTest(Guid.NewGuid().ToString("D"),digest,stage,journal,dest,"existing.dwg",review=>true);Check(conflict.Outcome=="unknown"&&File.ReadAllText(collision)=="preserve","existing destination never overwritten");
  string deniedId=Guid.NewGuid().ToString("D");var denied=UnregisteredDwgPublishOwner.RunForTest(deniedId,digest,stage,journal,dest,"denied.dwg",review=>false);Check(denied.Outcome=="declined"&&!File.Exists(Path.Combine(dest,"denied.dwg"))&&UnregisteredDwgPublishOwner.InspectOriginal(journal,deniedId,digest,1).Outcome=="declined","synthetic decline retained without publication");
  string changedId=Guid.NewGuid().ToString("D");var changed=UnregisteredDwgPublishOwner.RunForTest(changedId,digest,stage,journal,dest,"changed.dwg",review=>{File.WriteAllText(source,"changed drawing");return true;});Check(changed.Outcome=="unknown"&&!File.Exists(Path.Combine(dest,"changed.dwg")),"source byte drift refused");File.WriteAllText(source,"synthetic drawing");
  string addedId=Guid.NewGuid().ToString("D");var added=UnregisteredDwgPublishOwner.RunForTest(addedId,digest,stage,journal,dest,"extra.dwg",review=>{File.WriteAllText(Path.Combine(stagePath,"extra.txt"),"extra");return true;});Check(added.Outcome=="unknown"&&!File.Exists(Path.Combine(dest,"extra.dwg")),"extra stage output blocks publication");
  File.Delete(Path.Combine(stagePath,"extra.txt"));string replacedId=Guid.NewGuid().ToString("D");var replaced=UnregisteredDwgPublishOwner.RunForTest(replacedId,digest,stage,journal,dest,"replacement.dwg",review=>{Directory.Move(dest,dest+"-old");Directory.CreateDirectory(dest);return true;});Check(replaced.Outcome=="unknown"&&!File.Exists(Path.Combine(dest,"replacement.dwg")),"destination directory replacement refused");
 }
}
