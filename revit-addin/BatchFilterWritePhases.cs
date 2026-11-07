using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Web.Script.Serialization;

namespace RevitLocalCodex
{
    // Closed candidate: checks producer snapshots around a caller-owned transaction.
    // This type does not authorize, route, commit, or recover a write.
    internal sealed class BatchFilterWritePhases
    {
        private readonly Dictionary<string, object> original;
        private readonly string storage;
        private readonly object target;
        internal int Count { get { return ((object[])original["items"]).Length; } }
        private static Dictionary<string, object> Capture(object snapshot)
        {
            if (snapshot == null) throw new InvalidOperationException("Missing producer snapshot.");
            var serializer = new JavaScriptSerializer { MaxJsonLength = 180000, RecursionLimit = 16 };
            var copy = serializer.DeserializeObject(serializer.Serialize(snapshot)) as Dictionary<string, object>;
            object version, complete, total, items, authority;
            if (copy == null || !copy.TryGetValue("schema_version", out version) || !(version is int) || (int)version != 1 ||
                !copy.TryGetValue("complete", out complete) || !(complete is bool) || !(bool)complete ||
                !copy.TryGetValue("total", out total) || !(total is int) || (int)total < 0 || (int)total > 50 ||
                !copy.TryGetValue("items", out items) || !(items is object[]) || ((object[])items).Length != (int)total ||
                !copy.TryGetValue("write_authorization", out authority) || !Object.Equals(authority, "not_granted"))
                throw new InvalidOperationException("Incomplete producer snapshot.");
            return copy;
        }
        private static object Field(Dictionary<string, object> row, string key)
        {
            object value; if (row == null || !row.TryGetValue(key, out value)) throw new InvalidOperationException("Missing fact: " + key); return value;
        }
        private static bool Equal(object a, object b) { return Object.Equals(a, b); }
        private static object Normalize(string storage, object value)
        {
            if (storage == "String") { if (!(value is string) || ((string)value).Length > 4000) throw new InvalidOperationException("Invalid string target."); return value; }
            if (storage == "Integer") { decimal d; try { if (value == null || value is bool || value is string) throw new Exception(); d = Convert.ToDecimal(value, CultureInfo.InvariantCulture); } catch { throw new InvalidOperationException("Invalid integer target."); } if (d < Int32.MinValue || d > Int32.MaxValue || Decimal.Truncate(d) != d) throw new InvalidOperationException("Invalid integer target."); return (int)d; }
            if (storage == "Double") { double d; try { if (value == null || value is bool || value is string) throw new Exception(); d = Convert.ToDouble(value, CultureInfo.InvariantCulture); } catch { throw new InvalidOperationException("Invalid double target."); } if (Double.IsNaN(d) || Double.IsInfinity(d)) throw new InvalidOperationException("Invalid double target."); return d; }
            throw new InvalidOperationException("Unsupported storage.");
        }
        internal BatchFilterWritePhases(object before, string expectedStorage, string unit, object desired)
        {
            if (expectedStorage == "Double" ? unit != "internal" : unit != null) throw new InvalidOperationException("Invalid unit.");
            storage = expectedStorage; target = Normalize(storage, desired); original = Capture(before);
            ValidateRows(original);
        }
        private void ValidateRows(Dictionary<string, object> snapshot)
        {
            var seenIds = new HashSet<string>(StringComparer.Ordinal); var seenUids = new HashSet<string>(StringComparer.Ordinal); long last = 0;
            foreach (object item in (object[])snapshot["items"])
            {
                var row = item as Dictionary<string, object>; string id = Field(row,"element_id") as string, uid = Field(row,"unique_id") as string; long number;
                if (String.IsNullOrWhiteSpace(id) || !Int64.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out number) || number <= last || id != number.ToString(CultureInfo.InvariantCulture) || String.IsNullOrWhiteSpace(uid) || !seenIds.Add(id) || !seenUids.Add(uid)) throw new InvalidOperationException("Invalid sorted target identity.");
                last = number;
                if (!Equal(Field(row,"parameter_id"), Field(snapshot,"parameter_id")) || !Equal(Field(row,"storage_type"), storage) || !(Field(row,"has_value") is bool)) throw new InvalidOperationException("Invalid target facts.");
                object raw = Field(row,"value_internal"); Field(row,"data_type");
                if (!(bool)row["has_value"] && raw != null) throw new InvalidOperationException("Invalid raw state.");
                if (raw != null) Normalize(storage, raw);
            }
        }
        internal void Verify(object current, bool afterWrite) { VerifyProgress(current, afterWrite ? ((object[])original["items"]).Length : 0); }
        internal void VerifyProgress(object current, int writtenCount)
        {
            var next = Capture(current); ValidateRows(next);
            foreach (string key in new[]{"scope","category","type_id","level_id","parameter_id","total"}) if (!Equal(Field(original,key),Field(next,key))) throw new InvalidOperationException("Filter scope or count changed.");
            var a=(object[])original["items"]; var b=(object[])next["items"];
            if (writtenCount < 0 || writtenCount > a.Length) throw new InvalidOperationException("Invalid write progress.");
            for (int i=0;i<a.Length;i++)
            {
                var oldRow=(Dictionary<string,object>)a[i]; var newRow=(Dictionary<string,object>)b[i];
                foreach (string key in new[]{"element_id","unique_id","parameter_id","storage_type","data_type"}) if (!Equal(Field(oldRow,key),Field(newRow,key))) throw new InvalidOperationException("Membership or metadata changed.");
                if (i < writtenCount)
                {
                    if (!(bool)Field(newRow,"has_value") || !Equal(Normalize(storage,Field(newRow,"value_internal")),target)) throw new InvalidOperationException("Written value not retained.");
                }
                else if (!Equal(Field(oldRow,"has_value"),Field(newRow,"has_value")) || !Equal(Field(oldRow,"value_internal"),Field(newRow,"value_internal"))) throw new InvalidOperationException("Original state changed.");
            }
        }
    }
}
