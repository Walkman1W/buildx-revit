using System;
using RevitLocalCodex;
class Program {
 static int count; static void Ok(bool v,string label){if(!v)throw new Exception(label);count++;Console.WriteLine("PASS " + label);} static void Fail(Action a,string label){try{a();}catch(InvalidOperationException){count++;Console.WriteLine("PASS " + label);return;}throw new Exception("Expected rejection: " + label);}
 static object Facts(int state=1){return new {schema_version=1,category="OST_Walls",parameter_id="-100",complete=true,total=1,write_authorization="not_granted",items=new[]{new {element_id="101",unique_id="u1",has_value=true,value_internal=state}}};}
 static void Main(){try{Run();}catch(Exception e){Console.WriteLine(e);Environment.Exit(1);}}
 static void Run(){long ticks=0;var doc=new object();var b=new BatchFilterPreparationBook("host",()=>ticks,1);string t=b.Issue(doc,Facts(),"Integer",null,2,"rollback");b.Consume(t,doc,Facts(),"Integer",null,2,"rollback");Ok(true,"matching facts consume once");Fail(()=>b.Consume(t,doc,Facts(),"Integer",null,2,"rollback"),"replay rejected");
 t=b.Issue(doc,Facts(),"Integer",null,2,"rollback");Fail(()=>b.Consume(t,doc,Facts(3),"Integer",null,2,"rollback"),"changed facts rejected");Fail(()=>b.Consume(t,doc,Facts(),"Integer",null,2,"rollback"),"mismatch burns token");
 t=b.Issue(doc,Facts(),"Integer",null,2,"rollback");Fail(()=>b.Consume(t,new object(),Facts(),"Integer",null,2,"rollback"),"different document rejected");
 t=b.Issue(doc,Facts(),"Integer",null,2,"rollback");ticks=120;Fail(()=>b.Consume(t,doc,Facts(),"Integer",null,2,"rollback"),"expiry rejected");ticks=0;t=b.Issue(doc,Facts(),"Integer",null,2,"rollback");ticks=-1;Fail(()=>b.Consume(t,doc,Facts(),"Integer",null,2,"rollback"),"clock regression rejected");
 ticks=0;t=b.Issue(doc,Facts(),"Integer",null,2,"rollback");var restarted=new BatchFilterPreparationBook("host",()=>ticks,1);Fail(()=>restarted.Consume(t,doc,Facts(),"Integer",null,2,"rollback"),"restart loses preparation");
 var capacity=new BatchFilterPreparationBook("host",()=>ticks,1);for(int i=0;i<128;i++)capacity.Issue(doc,Facts(),"Integer",null,2,"rollback");Fail(()=>capacity.Issue(doc,Facts(),"Integer",null,2,"rollback"),"capacity fails closed");ticks=120;capacity.Issue(doc,Facts(),"Integer",null,2,"rollback");Ok(true,"expired entries reclaimed");t=b.Issue(doc,Facts(),"Integer",null,2,"rollback");Fail(()=>b.Consume(t,doc,Facts(),"Integer",null,2,"commit"),"mode drift rejected");Console.WriteLine("PASS total="+count);
 }
}
