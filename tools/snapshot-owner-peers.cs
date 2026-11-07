using System;
using System.Collections.Generic;
using System.Linq;
namespace RevitLocalCodex {
 class SnapshotOwnerPeerProgram {
  static int tests;
  static void Check(bool ok,string message){if(!ok)throw new Exception(message);tests++;Console.WriteLine("PASS " + message);}
  static void Reject(Action action,string message){try{action();}catch(InvalidOperationException){tests++;Console.WriteLine("PASS " + message);return;}throw new Exception("Expected rejection: "+message);}
  static SnapshotChangeOwner.Identity I(long id,string uid){return new SnapshotChangeOwner.Identity(id,uid);}
  static IEnumerable<SnapshotChangeOwner.Identity> Broken(){yield return I(1,"a");throw new InvalidOperationException("interrupted baseline");}
  static SnapshotChangeOwner Make(object doc,int cap=8,int budget=8){return SnapshotChangeOwner.Capture("host-A",doc,new[]{I(1,"a"),I(2,"b")},cap,budget);}
  static void Observe(SnapshotChangeOwner o,object doc,SnapshotChangeOwner.Identity[] add,SnapshotChangeOwner.Identity[] modify,long[] delete){o.Observe("host-A",doc,o.BaselineToken,add,modify,delete);}
  static void Main(){
   object doc=new object(),other=new object();
   Reject(()=>SnapshotChangeOwner.Capture("host-A",doc,Broken(),8,8),"interrupted baseline never published");
   Reject(()=>SnapshotChangeOwner.Capture("host-A",doc,new[]{I(1,"a"),I(2,"b")},1,8),"incomplete over-budget baseline rejected");
   Reject(()=>SnapshotChangeOwner.Capture("host-A",doc,new[]{I(1,"a"),I(1,"b")},8,8),"duplicate baseline ID rejected");
   Reject(()=>SnapshotChangeOwner.Capture("host-A",doc,new[]{I(1,"a"),I(2,"a")},8,8),"duplicate baseline UniqueId rejected");
   var o=Make(doc);var token=o.BaselineToken;
   Reject(()=>o.Read("host-B",doc,token,0,0,1),"different host rejected");Reject(()=>o.Read("host-A",other,token,0,0,1),"different document rejected");Reject(()=>o.Read("host-A",doc,"wrong",0,0,1),"different baseline rejected");
   Observe(o,doc,new[]{I(3,"c")},new[]{I(2,"b")},new long[]{1});
   var first=o.Read("host-A",doc,token,1,0,2);Check(first.Version==1&&first.Total==3&&first.HasMore&&first.Items[0].Kind=="deleted"&&first.Items[0].UniqueId=="a","observed events retain deleted UniqueId and fixed page");
   var second=o.Read("host-A",doc,token,1,2,2);Check(second.Items.Length==1&&!second.HasMore&&second.Items[0].Kind=="modified","next page stable at same version");
   Observe(o,doc,new[]{I(1,"new-a")},new SnapshotChangeOwner.Identity[0],new long[]{3});
   Reject(()=>o.Read("host-A",doc,token,1,2,2),"pagination rejects changed version");
   var later=o.Read("host-A",doc,token,2,3,10);Check(later.Items.Length==2&&later.Items[0].Kind=="deleted"&&later.Items[1].UniqueId=="new-a","delete then ID reuse in later transaction recorded");
   Observe(o,doc,new[]{I(3,"c")},new SnapshotChangeOwner.Identity[0],new long[]{1});
   var undo=o.Read("host-A",doc,token,3,5,10);Check(undo.Items.Length==2&&undo.Items[0].UniqueId=="new-a"&&undo.Items[1].UniqueId=="c","undo-like reversal retained as events");
   var expired=Make(doc,8,1);Reject(()=>Observe(expired,doc,new[]{I(3,"c")},new[]{I(2,"b")},new long[0]),"event overflow rejected");Check(expired.Expiry=="event_incomplete_or_overflow","overflow invalidates baseline");Reject(()=>expired.Read("host-A",doc,expired.BaselineToken,0,0,1),"overflow cannot return incomplete pages");
   var unknown=Make(doc);Reject(()=>Observe(unknown,doc,new SnapshotChangeOwner.Identity[0],new SnapshotChangeOwner.Identity[0],new long[]{99}),"unknown deletion rejected");Check(unknown.Expiry!=null,"unknown deletion expires owner");
   var conflict=Make(doc);Reject(()=>Observe(conflict,doc,new[]{I(1,"other")},new SnapshotChangeOwner.Identity[0],new long[]{1}),"same-event ID overlap rejected");Check(conflict.Expiry!=null,"ambiguous event expires owner");
   var changed=Make(doc);Reject(()=>Observe(changed,doc,new SnapshotChangeOwner.Identity[0],new[]{I(1,"other")},new long[0]),"modified identity drift rejected");
   var closed=Make(doc);closed.Expire("document_closed");Reject(()=>closed.Read("host-A",doc,closed.BaselineToken,0,0,1),"closed document invalidates token");
   var restarted=Make(doc);Reject(()=>restarted.Read("host-A",doc,token,0,0,1),"restarted owner rejects previous token");
   Console.WriteLine("PASS total=" + tests);
  }
 }
}
