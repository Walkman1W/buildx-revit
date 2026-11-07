using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using BuildX.FilePreparation;
using P=BuildX.FilePreparation.GuardedSingleArtifactPublisher;
class Program {
 static JavaScriptSerializer json=new JavaScriptSerializer{MaxJsonLength=600000,RecursionLimit=16};
 static Dictionary<string,object> Obj(object x){var d=x as Dictionary<string,object>;if(d==null)throw new InvalidDataException();return d;}
 static string Text(Dictionary<string,object> x,string k){object v;if(!x.TryGetValue(k,out v)||!(v is string))throw new InvalidDataException();return (string)v;}
 static int Number(Dictionary<string,object> x,string k){object v;if(!x.TryGetValue(k,out v)||!(v is int))throw new InvalidDataException();return (int)v;}
 static object Root(P.JournalRoot r){var list=new List<object>();foreach(var e in r.Chain)list.Add(new{path=e.Path,identity=e.Identity});return new{directory=r.Directory,chain=list.ToArray()};}
 static P.JournalRoot ReadRoot(object raw){var r=Obj(raw);var chain=r["chain"] as IList;if(chain==null||chain.Count<1||chain.Count>65)throw new InvalidDataException();var entries=new List<P.Entry>();foreach(object item in chain){var e=Obj(item);entries.Add(new P.Entry(Text(e,"path"),Text(e,"identity")));}return new P.JournalRoot(Text(r,"directory"),entries.ToArray());}
 static object Record(P.JournalRecord r){return new{request_id=r.RequestId,revision=r.Revision,identity=r.Identity,sha256=r.Sha256,bytes=r.Bytes};}
 static P.JournalRecord ReadPrevious(object raw,P.JournalRoot root,string id){if(raw==null)return null;var r=Obj(raw);int rev=Number(r,"revision");if(Text(r,"request_id")!=id)throw new InvalidDataException();long bytes=Convert.ToInt64(r["bytes"]);string path=Path.Combine(root.Directory,id+"."+rev.ToString("D8")+".json");return new P.JournalRecord(id,path,Text(r,"sha256"),Text(r,"identity"),rev,bytes);}
 static int Main(){try{var req=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());string op=Text(req,"operation");object result;
  if(op=="capture")result=Root(P.CaptureJournalRoot(Text(req,"directory")));
  else {var root=ReadRoot(req["root"]);string id=Text(req,"request_id");int revision=Number(req,"revision");
   if(op=="append"){byte[] bytes=Convert.FromBase64String(Text(req,"bytes_base64"));object previous;req.TryGetValue("previous",out previous);result=Record(P.AppendJournal(root,id,revision,ReadPrevious(previous,root,id),bytes));}
   else if(op=="read"){var read=P.ReadJournal(root,id,revision);result=new{receipt=Record(read.Record),bytes_base64=Convert.ToBase64String(read.Contents)};}
   else throw new InvalidDataException();}
  Console.Write(json.Serialize(new{ok=true,value=result}));return 0;
 }catch(P.PublicationFailure failure){Console.Write(json.Serialize(new{ok=false,target_created=failure.TargetCreated}));return 1;}catch(Exception){Console.Write(json.Serialize(new{ok=false}));return 1;}}
}
