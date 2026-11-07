using System;
using System.IO;
using System.IO.Pipes;
using System.ServiceProcess;
using System.Text;
using System.Web.Script.Serialization;
using System.Collections.Generic;

// Offline skeleton: OnStart refuses startup. It never listens on IPC, checks
// OS identities, performs file IO, publishes requests, or releases locks.
internal sealed class ProtectedOwnerService : ServiceBase
{
    internal const string PipeName = "BuildX.ProtectedOwner.v1";
    internal const int MaxRequestBytes = 4096;
    internal ProtectedOwnerService() { ServiceName = "BuildXProtectedOwner"; }
    protected override void OnStart(string[] args)
    {
        throw new InvalidOperationException("Protected service identity and IPC are not implemented");
    }
    protected override void OnStop() { }

    // Disabled factory describes the intended OS IPC type without creating
    // a pipe with a default DACL or pretending a caller has authenticated.
    internal static NamedPipeServerStream CreateAuthenticatedPipe()
    {
        throw new InvalidOperationException("Authenticated pipe unavailable");
    }
    internal static string InspectProtocol(byte[] bytes)
    {
        if (bytes == null || bytes.Length == 0 || bytes.Length > MaxRequestBytes) return "invalid";
        try
        {
            var text = new UTF8Encoding(false, true).GetString(bytes);
            var json = new JavaScriptSerializer { MaxJsonLength = MaxRequestBytes };
            var obj = json.DeserializeObject(text) as Dictionary<string, object>;
            if (obj == null || obj.Count != 2 || !obj.ContainsKey("version") || !obj.ContainsKey("operation") ||
                !(obj["version"] is int) || (int)obj["version"] != 1 || !(obj["operation"] is string)) return "invalid";
            switch ((string)obj["operation"])
            {
                case "status": return "unavailable";
                case "reserve": case "settle": case "inspect": return "denied";
                default: return "invalid";
            }
        }
        catch { return "invalid"; }
    }
    private static void Main() { ServiceBase.Run(new ProtectedOwnerService()); }
}
