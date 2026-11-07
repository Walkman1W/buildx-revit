using System;
using System.Globalization;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace RevitLocalCodex
{
    // Internal comparison primitive only: this is not a permit, user decision,
    // transaction or registered tool. Callers must separately own authorization.
    internal sealed class BatchFilterFactsGuard
    {
        private readonly string hostSession, digest;
        private readonly object document;
        private readonly string targetStorage, targetUnit;
        private readonly object targetValue;
        private readonly int managedThread;
        private BatchFilterFactsGuard(string session, object doc, string storage, string unit, object value, string signature)
        {
            hostSession = session; document = doc; targetStorage = storage; targetUnit = unit; targetValue = value; digest = signature;
            managedThread = System.Threading.Thread.CurrentThread.ManagedThreadId;
        }
        private static object Scalar(string storage, string unit, object value)
        {
            if (storage == "Double")
            {
                if (unit != "internal" || !(value is double || value is int || value is long || value is decimal)) throw new InvalidOperationException("Double requires a numeric internal-unit value.");
                double d = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                if (Double.IsNaN(d) || Double.IsInfinity(d)) throw new InvalidOperationException("Double must be finite.");
                return d;
            }
            if (storage == "Integer")
            {
                if (unit != null || !(value is int || value is long || value is double || value is decimal)) throw new InvalidOperationException("Integer requires an integer without unit.");
                decimal n;
                try { n = Convert.ToDecimal(value, CultureInfo.InvariantCulture); } catch { throw new InvalidOperationException("Integer is invalid."); }
                if (n < Int32.MinValue || n > Int32.MaxValue || Decimal.Truncate(n) != n) throw new InvalidOperationException("Integer is outside bounds.");
                return (int)n;
            }
            if (storage == "String")
            {
                string text = value as string;
                if (unit != null || text == null || text.Length > 4000) throw new InvalidOperationException("String value is invalid.");
                return text;
            }
            throw new InvalidOperationException("Only scalar instance parameters are supported.");
        }
        private static string Signature(object snapshot)
        {
            if (snapshot == null) throw new InvalidOperationException("Complete producer snapshot required.");
            var type = snapshot.GetType();
            var schema = type.GetProperty("schema_version"); var complete = type.GetProperty("complete");
            var total = type.GetProperty("total"); var items = type.GetProperty("items"); var authority = type.GetProperty("write_authorization");
            if (schema == null || complete == null || total == null || items == null || authority == null ||
                !(schema.GetValue(snapshot, null) is int) || (int)schema.GetValue(snapshot, null) != 1 ||
                !(complete.GetValue(snapshot, null) is bool) || !(bool)complete.GetValue(snapshot, null) ||
                !(total.GetValue(snapshot, null) is int) || !(items.GetValue(snapshot, null) is IList) ||
                (int)total.GetValue(snapshot, null) < 0 || (int)total.GetValue(snapshot, null) > 50 ||
                ((IList)items.GetValue(snapshot, null)).Count != (int)total.GetValue(snapshot, null) ||
                !String.Equals(authority.GetValue(snapshot, null) as string, "not_granted", StringComparison.Ordinal))
                throw new InvalidOperationException("Only a complete bounded preview is comparable.");
            var serializer = new JavaScriptSerializer { MaxJsonLength = 180000, RecursionLimit = 16 };
            string json = serializer.Serialize(snapshot);
            if (json.Length > 180000) throw new InvalidOperationException("Producer snapshot exceeds budget.");
            string text = Canonical(serializer.DeserializeObject(json), serializer, 0);
            if (text.Length > 180000) throw new InvalidOperationException("Canonical snapshot exceeds budget.");
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant();
        }
        private static string Canonical(object value, JavaScriptSerializer serializer, int depth)
        {
            if (depth > 16) throw new InvalidOperationException("Snapshot nesting exceeds budget.");
            var dictionary = value as IDictionary<string, object>;
            if (dictionary != null)
                return "{" + String.Join(",", dictionary.Keys.OrderBy(key => key, StringComparer.Ordinal).Select(key => serializer.Serialize(key) + ":" + Canonical(dictionary[key], serializer, depth + 1)).ToArray()) + "}";
            var array = value as object[];
            if (array != null) return "[" + String.Join(",", array.Select(item => Canonical(item, serializer, depth + 1)).ToArray()) + "]";
            return serializer.Serialize(value);
        }
        internal static BatchFilterFactsGuard Create(string host, object document, object completeProducerSnapshot, string storage, string unit, object value)
        {
            if (String.IsNullOrWhiteSpace(host) || document == null) throw new InvalidOperationException("Host and document identity required.");
            return new BatchFilterFactsGuard(host, document, storage, unit, Scalar(storage, unit, value), Signature(completeProducerSnapshot));
        }
        internal void Compare(string host, object doc, object currentCompleteProducerSnapshot, string storage, string unit, object value)
        {
            if (System.Threading.Thread.CurrentThread.ManagedThreadId != managedThread || !String.Equals(hostSession, host, StringComparison.Ordinal) || !Object.ReferenceEquals(document, doc)) throw new InvalidOperationException("Host, document or API thread changed.");
            object normalized = Scalar(storage, unit, value);
            if (!String.Equals(targetStorage, storage, StringComparison.Ordinal) || !String.Equals(targetUnit, unit, StringComparison.Ordinal) || !Object.Equals(targetValue, normalized) || !String.Equals(digest, Signature(currentCompleteProducerSnapshot), StringComparison.Ordinal))
                throw new InvalidOperationException("Filter, target, membership or raw state changed.");
        }
    }
}
