using System;
using RevitLocalCodex;
class Program {
 static int count; static void Check(bool ok,string name){if(!ok)throw new Exception(name); count++;Console.WriteLine("PASS "+name);} static void Reject(Action a,string name){try{a();}catch(InvalidOperationException){count++;Console.WriteLine("PASS "+name);return;}throw new Exception("Expected rejection: "+name);}
 static object Snapshot(int a,int b,string uid="u2",string category="OST_Walls",string data="text",bool complete=true){return new {schema_version=1,scope="exact_category_type_level_instances",category,type_id="10",level_id="20",parameter_id="-100",complete,total=2,write_authorization="not_granted",items=new[]{new {element_id="101",unique_id="u1",parameter_id="-100",storage_type="Integer",has_value=true,value_internal=a,data_type="text"},new {element_id="102",unique_id=uid,parameter_id="-100",storage_type="Integer",has_value=true,value_internal=b,data_type=data}}};}
 static void Main(){try{Run();}catch(Exception e){Console.WriteLine(e);Environment.Exit(1);}}
 static void Run(){var phases=new BatchFilterWritePhases(Snapshot(1,2),"Integer",null,9);phases.Verify(Snapshot(1,2),false);Check(true,"original state accepted");phases.Verify(Snapshot(9,9),true);Check(true,"complete written values accepted");phases.VerifyProgress(Snapshot(9,2),1);Check(true,"partial progress exact values accepted");Reject(()=>phases.VerifyProgress(Snapshot(9,9),1),"future target changed prematurely");Reject(()=>phases.VerifyProgress(Snapshot(1,2),1),"completed target not updated");Reject(()=>phases.Verify(Snapshot(9,2),true),"one unwritten target rejected");Reject(()=>phases.Verify(Snapshot(1,3),false),"before value drift rejected");Reject(()=>phases.Verify(Snapshot(9,9,"other"),true),"unique id drift rejected");Reject(()=>phases.Verify(Snapshot(9,9,"u2","OST_Floors"),true),"filter drift rejected");Reject(()=>phases.Verify(Snapshot(9,9,"u2","OST_Walls","other"),true),"metadata drift rejected");Reject(()=>phases.Verify(Snapshot(9,9,"u2","OST_Walls","text",false),true),"incomplete snapshot rejected");
 int x=1,y=2;bool committed=false;try{phases.Verify(Snapshot(x,y),false);x=9;y=9;phases.Verify(Snapshot(x,y),true);y=7;phases.Verify(Snapshot(x,y),true);committed=true;}catch(InvalidOperationException){x=1;y=2;}Check(!committed&&x==1&&y==2,"simulated regeneration drift rolls back");
 x=1;y=2;try{phases.Verify(Snapshot(x,y),false);x=9;y=9;phases.Verify(Snapshot(x,y),true);phases.Verify(Snapshot(x,y),true);committed=true;}catch(InvalidOperationException){x=1;y=2;}Check(committed&&x==9&&y==9,"simulated successful transaction validates stages"); int a=1,b=2, writes=0, rolls=0, captures=0; bool inner=false;
 Action run=()=>BatchFilterWriteCoordinator.Execute(phases,2,()=>{captures++;return Snapshot(a,b);},()=>{},i=>{writes++;if(i==0)a=9;else b=9;},()=>{},()=>inner=true,()=>{rolls++;a=1;b=2;});
 run();Check(inner&&writes==2&&rolls==0&&captures==7,"coordinator recaptures every phase");
 a=1;b=2;writes=0;rolls=0;inner=false;
 Reject(()=>BatchFilterWriteCoordinator.Execute(phases,2,()=>Snapshot(a,b),()=>{},i=>{writes++;if(i==0){a=9;b=8;}else b=9;},()=>{},()=>inner=true,()=>{rolls++;a=1;b=2;}),"coordinator detects side effect during first write");
 Check(writes==1&&rolls==1&&!inner&&a==1&&b==2,"failure stops writes and rolls back outer group");
 a=1;b=2;rolls=0;inner=false;
 Reject(()=>BatchFilterWriteCoordinator.Execute(phases,2,()=>Snapshot(a,b),()=>{},i=>{if(i==0)a=9;else b=9;},()=>{},()=>{inner=true;b=7;},()=>{rolls++;a=1;b=2;}),"post inner commit drift detected");
 Check(inner&&rolls==1&&a==1&&b==2,"post commit drift rolls back outer group");
 Console.WriteLine("PASS total="+count);
 }
}
