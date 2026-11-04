using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Web.Script.Serialization;
using RevitLocalCodex;

internal static class ModelViewerBudgetCheck
{
    private static void Main()
    {
        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
            string name = new System.Reflection.AssemblyName(args.Name).Name;
            if (name == "RevitAPI" || name == "RevitAPIUI") return System.Reflection.Assembly.LoadFrom(@"D:\Program Files\Autodesk\Revit 2024\" + name + ".dll");
            return null;
        };
        Check();
    }
    private static void Check()
    {
        string title = new string('\u0001', 1000), path = new string('\u0002', 2000);
        var budget = new ModelViewerSnapshot.Budget(Stopwatch.StartNew(), title, path);
        var items = new List<object>(); int omitted = 0, limited = 0;
        for (int i = 0; i < 300; i++)
        {
            string id=(i+1).ToString(), uid=new string('\u0003', 256), name=new string('\u0004', 1000), category=new string('\u0005', 1000);
            if (!budget.ReserveItem(id, uid, name, category)) { omitted++; continue; }
            var mesh = new List<double>();
            for (int t=0;t<300;t++)
            {
                if (!budget.ReserveTriangle()) { limited++; break; }
                for (int v=0;v<9;v++) mesh.Add(-999999999.999);
            }
            items.Add(new { element_id=id, unique_id=uid, name, category, min=new { x=-999999999.999,y=0,z=0 }, max=new { x=999999999.999,y=0,z=0 }, mesh=mesh.ToArray(),meshStatus="partial" });
        }
        var value = new { schemaVersion=1, geometry="triangle_mesh_with_bounds", units="mm", coordinateSystem="revit_internal", items=items.ToArray(), coverage=new { omittedBudget=omitted,meshBudgetLimited=limited } };
        var whole = new { operation="capture_model_snapshot", hostSession=new string('f',32), snapshot=new { document=new { title,path }, hostSession=new string('f',32), capabilities=new { atomicReadSnapshot=true }, syntheticEnvelopePadding=new string('x',16000) }, value, atomicReadSnapshot=true };
        int actual=new JavaScriptSerializer { MaxJsonLength=1024*1024 }.Serialize(whole).Length;
        if (actual > budget.Reserved || budget.Reserved > ModelViewerSnapshot.FreezeLimit || omitted == 0 || limited == 0) throw new Exception("Serialization reservation did not bound the atomic response.");
        bool rejected=false; try { new ModelViewerSnapshot.Budget(Stopwatch.StartNew(),new string('a',40000),null); } catch (InvalidOperationException) { rejected=true; }
        if (!rejected) throw new Exception("Oversized document identity was not rejected.");
        Console.WriteLine("PASS actual="+actual+" reserved="+budget.Reserved+" omitted="+omitted+" limited="+limited);
    }
}
