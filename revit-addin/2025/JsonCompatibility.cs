// Compatibility surface for the legacy serializer used by the shared host.
// Dictionary values must be ordinary CLR values, not JsonElement instances.
using System;
using System.Collections.Generic;
using System.Text.Json;
namespace System.Web.Script.Serialization {
    public sealed class JavaScriptSerializer {
        public int MaxJsonLength { get; set; } = 2097152;
        public int RecursionLimit { get; set; } = 100;
        private JsonSerializerOptions Options() { return new JsonSerializerOptions { MaxDepth = RecursionLimit, IncludeFields = true }; }
        public string Serialize(object value) { var s = JsonSerializer.Serialize(value, Options()); if (s.Length > MaxJsonLength) throw new InvalidOperationException("JSON exceeds maximum length"); return s; }
        public object DeserializeObject(string input) { if (input.Length > MaxJsonLength) throw new ArgumentException("JSON exceeds maximum length"); using (var document = JsonDocument.Parse(input, new JsonDocumentOptions { MaxDepth = RecursionLimit })) return Convert(document.RootElement); }
        public T Deserialize<T>(string input) { if (typeof(T) == typeof(Dictionary<string, object>)) return (T)DeserializeObject(input); if (input.Length > MaxJsonLength) throw new ArgumentException("JSON exceeds maximum length"); return JsonSerializer.Deserialize<T>(input, Options()); }
        private static object Convert(JsonElement value) {
            switch (value.ValueKind) {
                case JsonValueKind.Object: var d = new Dictionary<string, object>(); foreach (var p in value.EnumerateObject()) d[p.Name] = Convert(p.Value); return d;
                case JsonValueKind.Array: var a = new List<object>(); foreach (var i in value.EnumerateArray()) a.Add(Convert(i)); return a.ToArray();
                case JsonValueKind.String: return value.GetString();
                case JsonValueKind.Number: if (value.TryGetInt32(out int i32)) return i32; if (value.TryGetInt64(out long i64)) return i64; if (value.TryGetDecimal(out decimal dec)) return dec; return value.GetDouble();
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                default: return null;
            }
        }
    }
}
