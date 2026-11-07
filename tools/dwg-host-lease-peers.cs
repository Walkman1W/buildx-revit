using System;
using System.IO;
using RevitLocalCodex;
class LeaseTest {
 static void Check(bool c,string name){if(!c)throw new Exception(name);Console.WriteLine("PASS "+name);}
 static void Main(string[] args){var root=args[0];Directory.CreateDirectory(root);var lease=new UnregisteredDwgHostLease(root);Check(lease.Snapshot().Count==0,"fresh unique empty directory");File.WriteAllText(Path.Combine(lease.DirectoryPath,"drawing.dwg"),"test");var x=lease.Snapshot();Check(x.Count==1&&x[0].Regular&&x[0].Bytes==4&&x[0].Sha256.Length==64,"file identity and hash");File.WriteAllText(Path.Combine(lease.DirectoryPath,"extra.txt"),"x");x=lease.Snapshot();Check(x.Count==2,"extra reported");for(int i=0;i<127;i++)File.WriteAllText(Path.Combine(lease.DirectoryPath,i.ToString()),"x");try{lease.Snapshot();throw new Exception("budget accepted");}catch(InvalidOperationException){Console.WriteLine("PASS bounded entries");}Directory.Move(lease.DirectoryPath,lease.DirectoryPath+"-old");Directory.CreateDirectory(lease.DirectoryPath);try{lease.Snapshot();throw new Exception("replacement accepted");}catch(InvalidOperationException){Console.WriteLine("PASS replaced directory rejected");}}
}
