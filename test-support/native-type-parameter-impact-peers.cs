namespace Autodesk.Revit.DB
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Threading;

    internal sealed class ImpactParameterCollection : List<Parameter>
    {
        public new IEnumerator<Parameter> GetEnumerator()
        {
            foreach (Parameter parameter in (List<Parameter>)this)
            {
                if (ImpactPeerControl.ParameterDelay && ImpactPeerControl.ParameterScanned == 0) Thread.Sleep(5100);
                ImpactPeerControl.ParameterScanned++;
                yield return parameter;
            }
        }
    }
    internal static class ImpactPeerControl
    {
        internal static int ParameterScanned, CollectorScanned;
        internal static bool ParameterDelay, CollectorDelay;
        internal static string CollectorFault;
        internal static Element InjectedType, LookupOverride;
        internal static long RequestedTypeId;
        internal static readonly Dictionary<Element, string> TypeBehaviors = new Dictionary<Element, string>();
        internal static Element Lookup(Document doc, ElementId id)
        { return LookupOverride != null && id.Value == RequestedTypeId ? LookupOverride : doc.Elements.FirstOrDefault(element => element != null && element.Id != null && element.Id.Value == id.Value); }
        internal static ElementId GetTypeId(Element source)
        {
            string behavior;
            if (TypeBehaviors.TryGetValue(source, out behavior))
            {
                if (behavior == "throws") throw new InvalidOperationException("Controlled GetTypeId failure.");
                if (behavior == "null") return null;
            }
            return source.TypeId;
        }
        internal static IEnumerable<Element> Enumerate(IEnumerable<Element> values)
        {
            Element first = null;
            foreach (Element element in values)
            {
                if (CollectorDelay && CollectorScanned == 0) Thread.Sleep(5100);
                if (first == null) first = element;
                CollectorScanned++;
                yield return element;
            }
            if (CollectorFault != null)
            {
                CollectorScanned++;
                yield return CollectorFault == "null" ? null : CollectorFault == "type" ? InjectedType : first;
            }
        }
    }
}
namespace RevitLocalCodex
{
    using System;
    using System.Collections;
    using System.Collections.Generic;
    using System.Globalization;
    using System.Linq;
    using System.Web.Script.Serialization;
    using Autodesk.Revit.DB;
    using Autodesk.Revit.UI;

    internal static class NativeTypeParameterImpactPeerProgram
    {
        private static object Value(Dictionary<string, object> input, string key, object fallback)
        { object result; return input.TryGetValue(key, out result) ? result : fallback; }
        private static bool Flag(Dictionary<string, object> input, string key) { return (bool)Value(input, key, false); }
        private static long Id(object value) { return long.Parse(Convert.ToString(value, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture); }
        private static int Count(Dictionary<string, object> input, string key, int fallback) { return Convert.ToInt32(Value(input, key, fallback), CultureInfo.InvariantCulture); }
        private static Parameter Parameter(Element owner, Dictionary<string, object> input)
        {
            StorageType storage = (StorageType)Enum.Parse(typeof(StorageType), (string)Value(input, "storage", "Double"));
            object defaultValue = storage == StorageType.Double ? (object)2.0 : storage == StorageType.Integer ? (object)1 : storage == StorageType.String ? (object)"原值中文" : storage == StorageType.ElementId ? (object)"9007199254740995" : null;
            object value = Value(input, "parameterValue", defaultValue);
            if (value != null) value = storage == StorageType.Double ? (object)Convert.ToDouble(value, CultureInfo.InvariantCulture) : storage == StorageType.Integer ? (object)Convert.ToInt32(value, CultureInfo.InvariantCulture) : storage == StorageType.ElementId ? (object)new ElementId(Id(value)) : value;
            return new Parameter { Id = new ElementId(Id(Value(input, "parameterId", "-123"))), Element = owner, StorageType = storage, Value = value, HasValue = (bool)Value(input, "hasValue", value != null), IsReadOnly = Flag(input, "readOnly"),
                Display = (string)Value(input, "display", "609.6 mm"), Definition = new Definition { Name = (string)Value(input, "parameterName", "类型参数中文"), DataType = new ForgeTypeId((string)Value(input, "dataType", storage == StorageType.Double ? "length" : "text")) } };
        }
        private static Document Fixture(Dictionary<string, object> input)
        {
            var doc = new Document { Title = "Type impact fixture", PathName = "", IsModified = Flag(input, "modifiedBefore") };
            long typeId = Id(Value(input, "typeId", "9223372036854775806"));
            var type = new ElementType { Id = new ElementId(typeId), Name = Flag(input, "nullName") ? null : "类型影响中文", IsValidObject = !Flag(input, "invalidType") };
            var parameter = Parameter(type, input);
            string owner = (string)Value(input, "owner", "type");
            if (owner == "null") parameter.Element = null;
            else if (owner == "instance") parameter.Element = new Element { Id = new ElementId(typeId), Document = doc };
            else if (owner == "otherType") parameter.Element = new ElementType { Id = new ElementId(77), Document = doc };
            else if (owner == "otherDocument") parameter.Element = new ElementType { Id = type.Id, Document = new Document() };
            else if (owner == "invalid") parameter.Element = new ElementType { Id = type.Id, Document = doc, IsValidObject = false };
            type.Parameters.Add(parameter);
            int parameterCount = Count(input, "parameterCount", 1);
            if (parameterCount == 0) type.Parameters.Clear();
            for (int index = 1; index < parameterCount; index++) type.Parameters.Add(new Parameter { Id = new ElementId(index + 1000), Element = type, Definition = new Definition { Name = "不相关参数", DataType = new ForgeTypeId("text") }, StorageType = StorageType.String, HasValue = true, Value = "值" });
            if (Flag(input, "duplicateParameter")) type.Parameters.Add(new Parameter { Id = parameter.Id, Element = type, Definition = parameter.Definition, StorageType = StorageType.String, HasValue = true, Value = "重复" });
            if (!Flag(input, "missingType")) doc.Add(Flag(input, "wrongType") ? new Element { Id = type.Id, Name = type.Name } : type);
            if (Flag(input, "typeWrongDocument")) type.Document = new Document();
            if (Flag(input, "wrongReturnedId")) ImpactPeerControl.LookupOverride = new ElementType { Id = new ElementId(123), Document = doc };
            if (Flag(input, "nullReturnedId")) ImpactPeerControl.LookupOverride = new ElementType { Id = null, Document = doc };
            ImpactPeerControl.RequestedTypeId = typeId;
            ImpactPeerControl.InjectedType = type;
            int instances = Count(input, "instanceCount", 0), candidates = Count(input, "candidateCount", instances);
            if (input.ContainsKey("instanceIds"))
            {
                foreach (object id in (IList)input["instanceIds"]) doc.Add(new Element { Id = new ElementId(Id(id)), TypeId = type.Id, Name = "实例" });
            }
            else
            {
                for (int index = candidates - 1; index >= 0; index--) doc.Add(new Element { Id = new ElementId(9007199254740000L + index), TypeId = new ElementId(index < instances ? typeId : -1), Name = "实例" + index });
            }
            string fault = (string)Value(input, "candidateFault", null);
            if (fault != null)
            {
                var bad = new Element { Id = new ElementId(888), TypeId = type.Id, Name = "错误候选", Document = doc };
                if (fault == "nullId") bad.Id = null;
                if (fault == "zeroId") bad.Id = new ElementId(0);
                if (fault == "negativeId") bad.Id = new ElementId(-7);
                if (fault == "sameAsType") bad.Id = type.Id;
                if (fault == "invalid") bad.IsValidObject = false;
                doc.Elements.Add(bad);
                if (fault == "otherDocument") bad.Document = new Document();
                if (fault == "nullDocument") bad.Document = null;
                if (fault == "nullGetTypeId") ImpactPeerControl.TypeBehaviors[bad] = "null";
                if (fault == "getTypeIdThrows") ImpactPeerControl.TypeBehaviors[bad] = "throws";
            }
            if (input.ContainsKey("nonpositiveReference")) doc.Add(new Element { Id = new ElementId(777), TypeId = new ElementId(Id(input["nonpositiveReference"])), Name = "无类型引用" });
            ImpactPeerControl.ParameterDelay = Flag(input, "parameterTimeout");
            ImpactPeerControl.CollectorDelay = Flag(input, "collectorTimeout");
            ImpactPeerControl.CollectorFault = (string)Value(input, "collectorFault", null);
            return doc;
        }
        private static string Facts(Document doc, JavaScriptSerializer json)
        {
            return doc == null ? "null" : json.Serialize(new { doc.IsModified, elements = doc.Elements.Select(element => new { id = element.Id == null ? null : element.Id.Value.ToString(CultureInfo.InvariantCulture), element.Name,
                type = element.TypeId == null ? null : element.TypeId.Value.ToString(CultureInfo.InvariantCulture), element.IsValidObject, sameDocument = Object.ReferenceEquals(element.Document, doc),
                parameters = element.Parameters.Select(parameter => new { id = parameter.Id.Value.ToString(CultureInfo.InvariantCulture), parameter.StorageType, parameter.HasValue, parameter.IsReadOnly,
                    owner = parameter.Element == null || parameter.Element.Id == null ? null : parameter.Element.Id.Value.ToString(CultureInfo.InvariantCulture),
                    value = parameter.Value is ElementId ? (object)((ElementId)parameter.Value).Value.ToString(CultureInfo.InvariantCulture) : parameter.Value }) }) });
        }
        public static int Main()
        {
            Console.InputEncoding = new System.Text.UTF8Encoding(false); Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            var json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 40 };
            var input = json.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd());
            Document doc = Flag(input, "noDocument") ? null : Fixture(input);
            var app = new UIApplication { ActiveUIDocument = doc == null ? null : new UIDocument { Document = doc } };
            var args = input.ContainsKey("args") ? input["args"] as Dictionary<string, object> : new Dictionary<string, object>();
            string before = Facts(doc, json); object value = null, error = null;
            try { value = Flag(input, "legacySingle") ? NativeParameterQueries.Read(app, "get_parameter_value", args) : NativeParameterQueries.Read(app, (string)Value(input, "operation", "get_type_parameter_impact"), args); }
            catch (Exception failure) { error = new { type = failure.GetType().Name, message = failure.Message }; }
            Console.WriteLine(json.Serialize(new { ok = error == null, value, error, facts = new { sourceFactsUnchanged = before == Facts(doc, json), modifiedBefore = doc == null ? (bool?)null : Flag(input, "modifiedBefore"), modifiedAfter = doc == null ? (bool?)null : doc.IsModified,
                parameterScanned = ImpactPeerControl.ParameterScanned, elementScanned = ImpactPeerControl.CollectorScanned, setterApisAvailable = false, transactionApisAvailable = false,
                scope = "Actual read-only type-impact producer, shared parser/budget/descriptor, controlled API peers; no Autodesk/Revit/model" } }));
            return 0;
        }
    }
}
