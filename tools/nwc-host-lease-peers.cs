using System;
using System.IO;
using RevitLocalCodex;
class NwcLeaseTest {
 static void Check(bool c,string name){if(!c)throw new Exception(name);Console.WriteLine("PASS "+name);}
 static void Main(string[] args){var root=args[0];Directory.CreateDirectory(root);var lease=new UnregisteredNwcHostLease(root);Check(lease.Snapshot().Count==0,"fresh exclusive stage empty");Check(lease.TryBegin("one")&&!lease.TryBegin("one"),"stage use is one shot within owner lifetime");File.WriteAllText(Path.Combine(lease.DirectoryPath,"model.nwc"),"test");var facts=lease.Snapshot();Check(facts.Count==1&&facts[0].Regular&&facts[0].Bytes==4&&facts[0].Sha256.Length==64,"expected file identity and hash observed");File.WriteAllText(Path.Combine(lease.DirectoryPath,"extra.txt"),"extra");facts=lease.Snapshot();Check(facts.Count==2,"extra entry retained in observed list");Directory.Move(lease.DirectoryPath,lease.DirectoryPath+"-old");Directory.CreateDirectory(lease.DirectoryPath);try{lease.Snapshot();throw new Exception("directory replacement accepted");}catch(InvalidOperationException){Console.WriteLine("PASS replaced stage directory refused");}}
}
