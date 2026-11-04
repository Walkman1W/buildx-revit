// Synthetic child for the isolated guard test. It has no model/network access.
using System;
using System.IO;
using System.Diagnostics;
using System.Web.Script.Serialization;

internal static class BuildxGuardFixture {
    static int Main(string[] args) {
        Console.OutputEncoding=new System.Text.UTF8Encoding(false);
        Console.InputEncoding=new System.Text.UTF8Encoding(false);
        var json=new JavaScriptSerializer();
        if(args.Length>0&&args[0]=="--grandchild") { System.Threading.Thread.Sleep(30000);return 0; }
        Console.Error.WriteLine("BUILDX_GUARD_STARTED"); // must not reach guard diagnostics
        int descendant=0;
        if(args.Length>0&&args[0]=="--with-grandchild") {
            var child=Process.Start(new ProcessStartInfo { FileName=Process.GetCurrentProcess().MainModule.FileName,Arguments="--grandchild",UseShellExecute=false,CreateNoWindow=true });
            descendant=child.Id;
        }
        Console.WriteLine(json.Serialize(new {pid=Process.GetCurrentProcess().Id,descendant=descendant,args=args,cwd=Environment.CurrentDirectory,bootstrap=Environment.GetEnvironmentVariable("BUILDX_MCP_GUARD_BOOTSTRAP")}));
        Console.Out.Flush();
        string line;while((line=Console.ReadLine())!=null){Console.WriteLine(line);Console.Out.Flush();if(line=="quit")break;}
        return 0;
    }
}
