using System;
using System.IO;
using System.Threading;

namespace RevitLocalCodex
{
    // Experimental only: never register or call in a production host.
    internal interface ISharedParameterPeer
    {
        string Filename { get; set; }
        void CreateAndVerify(string path, string group, string name, Guid guid, string dataType);
    }
    internal sealed class SharedParameterAttempt
    {
        internal string Original, Target, Stage, Error, RestoreStatus, FileIdentity, Group, Name, DataType, Guid;
        internal bool Created, DefinitionVerified;
    }
    internal static class IsolatedSharedParameterPrototype
    {
        private static int busy;
        internal static SharedParameterAttempt Run(ISharedParameterPeer peer, string directory, string filename, string group, string name, Guid guid, string dataType)
        {
            var result = new SharedParameterAttempt { Stage = "validate", RestoreStatus = "not_attempted", Group = group, Name = name, DataType = dataType, Guid = guid.ToString("D") };
            bool acquired = false, settingAttempted = false;
            try
            {
                if (peer == null || !Path.IsPathRooted(directory) || !Directory.Exists(directory) || filename != Path.GetFileName(filename) || String.IsNullOrWhiteSpace(filename) || !filename.EndsWith(".txt", StringComparison.OrdinalIgnoreCase) || String.IsNullOrWhiteSpace(group) || String.IsNullOrWhiteSpace(name) || guid == Guid.Empty || String.IsNullOrWhiteSpace(dataType)) throw new ArgumentException("Invalid explicit input.");
                if (Interlocked.CompareExchange(ref busy, 1, 0) != 0) throw new InvalidOperationException("Reentrant attempt refused.");
                acquired = true;
                result.Target = Path.GetFullPath(Path.Combine(directory, filename));
                result.Original = peer.Filename;
                result.Stage = "create_file";
                using (var file = new FileStream(result.Target, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { result.Created = true; file.Flush(true); }
                // This identity is evidence only, not a durable OS file identity.
                var info = new FileInfo(result.Target);
                result.FileIdentity = info.FullName + "|" + info.CreationTimeUtc.Ticks;
                result.Stage = "switch_setting";
                if (!String.Equals(peer.Filename, result.Original, StringComparison.Ordinal)) throw new InvalidOperationException("Setting drift before switch.");
                settingAttempted = true;
                peer.Filename = result.Target;
                if (!String.Equals(peer.Filename, result.Target, StringComparison.Ordinal)) throw new InvalidOperationException("Setting switch not confirmed.");
                result.Stage = "create_definition";
                peer.CreateAndVerify(result.Target, group, name, guid, dataType);
                result.DefinitionVerified = true;
                result.Stage = "complete";
            }
            catch (Exception ex) { result.Error = ex.GetType().Name + ": " + ex.Message; }
            finally
            {
                if (settingAttempted)
                {
                    try
                    {
                        if (!String.Equals(peer.Filename, result.Target, StringComparison.Ordinal)) result.RestoreStatus = "drift_refused";
                        else { peer.Filename = result.Original; result.RestoreStatus = String.Equals(peer.Filename, result.Original, StringComparison.Ordinal) ? "verified" : "unverified"; }
                    }
                    catch (Exception ex) { result.RestoreStatus = "exception: " + ex.GetType().Name; }
                }
                if (acquired) Interlocked.Exchange(ref busy, 0);
            }
            return result;
        }
    }
}
