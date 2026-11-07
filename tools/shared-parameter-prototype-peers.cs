using System;
using System.IO;
using RevitLocalCodex;
class Peer : ISharedParameterPeer {
 public string Filename {get;set;} public string Mode; public string DirectoryPath;
 public void CreateAndVerify(string p,string g,string n,Guid id,string t) {
  File.WriteAllText(p,g+"|"+n+"|"+id+"|"+t);
  if(Mode=="throw") throw new InvalidOperationException("partial");
  if(Mode=="drift") { Filename="changed-by-other"; throw new InvalidOperationException("drift"); }
  if(Mode=="reenter") { var inner=IsolatedSharedParameterPrototype.Run(this,DirectoryPath,"inner.txt",g,n,id,t); if(inner.Error==null || File.Exists(Path.Combine(DirectoryPath,"inner.txt"))) throw new Exception("reentry"); }
 }
}
class Test {
 static int count; static void Check(bool x) {if(!x) throw new Exception("check "+count);count++;}
 static void Main(string[] a) {
  string dir=a[0]; var p=new Peer { Filename="original",DirectoryPath=dir }; var id=Guid.NewGuid();
  var r=IsolatedSharedParameterPrototype.Run(p,dir,"ok.txt","group","name",id,"spec");
  Check(r.Error==null && r.DefinitionVerified && r.RestoreStatus=="verified" && p.Filename=="original"); Check(r.FileIdentity!=null && File.ReadAllText(r.Target).Contains(id.ToString()));
  r=IsolatedSharedParameterPrototype.Run(p,dir,"ok.txt","group","name",id,"spec"); Check(r.Error!=null && !r.Created && p.Filename=="original");
  p.Mode="throw"; r=IsolatedSharedParameterPrototype.Run(p,dir,"partial.txt","group","name",id,"spec"); Check(r.Error!=null && r.Stage=="create_definition" && r.RestoreStatus=="verified" && File.Exists(r.Target));
  p.Mode="drift"; r=IsolatedSharedParameterPrototype.Run(p,dir,"drift.txt","group","name",id,"spec"); Check(r.RestoreStatus=="drift_refused" && p.Filename=="changed-by-other" && File.Exists(r.Target));
  p.Filename="original"; p.Mode="reenter"; r=IsolatedSharedParameterPrototype.Run(p,dir,"outer.txt","group","name",id,"spec"); Check(r.Error==null && r.RestoreStatus=="verified");
  r=IsolatedSharedParameterPrototype.Run(p,dir,"../bad.txt","group","name",id,"spec"); Check(r.Error!=null && !r.Created);
  Console.WriteLine("PASS "+count);
 }
}
