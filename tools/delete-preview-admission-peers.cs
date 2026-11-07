using System;
using Autodesk.Revit.DB;
namespace RevitLocalCodex {
 class AdmissionTests {
  static string session=new string('a',32),request="3dd22134-29e8-4b12-a71a-c24503c99139";
  static long tick=100;static object human=new DeletePreviewAdmission.TrustedDecision();static bool issued;
  static DeletePreviewAdmission.Scope Scope(string id=null,string host=null,string path=null,long target=3,string uid=null,string mode="commit") {return new DeletePreviewAdmission.Scope(id??request,host??session,path??"D:\\controlled\\demo.rvt",target,uid??"uid-3",mode);}
  static Document Doc(){var d=new Document();d.Elements[3]=new ViewSheet{Id=new ElementId(3),UniqueId="uid-3"};return d;}
  static DeletePreviewAdmission Owner(){issued=false;tick=100;return new DeletePreviewAdmission(session,(a,b)=>Object.ReferenceEquals(a,b),(v,s)=>{if(!Object.ReferenceEquals(v,human)||issued)return false;issued=true;return true;},()=>tick,10);}
  static void Ok(bool v,string n){if(!v)throw new Exception(n);Console.WriteLine("PASS "+n);}
  static void Reject(Action a,string n){try{a();}catch(InvalidOperationException){Console.WriteLine("PASS "+n);return;}throw new Exception("Expected rejection: "+n);}
  static void Main(){var d=Doc();var permissive=new DeletePreviewAdmission(session,(a,b)=>Object.ReferenceEquals(a,b),(v,s)=>true,()=>tick,10);Reject(()=>permissive.Issue(d,Scope(),true),"caller boolean rejected even with faulty verifier");var o=Owner();Reject(()=>o.Issue(d,Scope(),true),"caller boolean is not trusted decision");string token=o.Issue(d,Scope(),human);Ok(token.Length==32,"native token issued after trusted decision");Reject(()=>o.Issue(d,Scope(),human),"decision is consumed by trusted verifier");o.Claim(d,Scope(),token);Reject(()=>o.Claim(d,Scope(),token),"token is one use");
   d=Doc();o=Owner();token=o.Issue(d,Scope(),human);Reject(()=>o.Claim(d,Scope(id:"11111111-1111-4111-8111-111111111111"),token),"different request rejected");Reject(()=>o.Claim(d,Scope(),token),"mismatch burns token");
   d=Doc();o=Owner();token=o.Issue(d,Scope(),human);tick=400;Reject(()=>o.Claim(d,Scope(),token),"monotonic expiry");
   d=Doc();o=Owner();token=o.Issue(d,Scope(),human);tick=99;Reject(()=>o.Claim(d,Scope(),token),"clock reversal fails closed");
   d=Doc();o=Owner();token=o.Issue(d,Scope(),human);var other=Doc();Reject(()=>o.Claim(other,Scope(),token),"document wrapper mismatch");
   d=Doc();o=Owner();token=o.Issue(d,Scope(),human);((ViewSheet)d.Elements[3]).UniqueId="changed";Reject(()=>o.Claim(d,Scope(),token),"target identity drift rejected");
   d=Doc();o=Owner();Reject(()=>o.Issue(d,Scope(host:new string('b',32)),human),"host drift rejected");Reject(()=>o.Issue(d,Scope(mode:"automatic"),human),"invalid execution mode rejected");
  }
 }
}
