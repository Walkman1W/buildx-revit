using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
namespace RevitLocalCodex
{
    internal static class DeleteReviewCancellation
    {
        internal static bool Requested(string queue, string claimedRequestId, string hostSession)
        {
            Guid request;
            if (String.IsNullOrWhiteSpace(queue) || !Guid.TryParseExact(claimedRequestId, "D", out request) || claimedRequestId.Length != 36 || claimedRequestId[14] != '4' || "89abAB".IndexOf(claimedRequestId[19]) < 0 || hostSession == null || hostSession.Length != 32 || hostSession.Any(c => !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))) return true;
            string file = Path.Combine(queue, "cancel", claimedRequestId + ".json");
            if (!File.Exists(file)) return false;
            try
            {
                var info = new FileInfo(file);
                if (info.Length < 1 || info.Length > 4096 || (info.Attributes & FileAttributes.ReparsePoint) != 0) return true;
                var serializer = new JavaScriptSerializer { MaxJsonLength = 4096, RecursionLimit = 4 };
                var marker = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
                if (marker == null || marker.Count != 3 || !marker.ContainsKey("schema_version") || !(marker["schema_version"] is int) || (int)marker["schema_version"] != 1 ||
                    !marker.ContainsKey("request_id") || !(marker["request_id"] is string) || (string)marker["request_id"] != claimedRequestId ||
                    !marker.ContainsKey("target_session") || !(marker["target_session"] is string) || (string)marker["target_session"] != hostSession) return true;
                return true;
            }
            catch { return true; }
        }
    }
}
