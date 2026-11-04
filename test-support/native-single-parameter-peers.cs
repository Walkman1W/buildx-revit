namespace Autodesk.Revit.DB
{
    using System;
    using System.Collections.Generic;
    using System.Threading;

    // Deterministic test-only enumeration. Fact snapshots use LINQ's inherited
    // List interface; production foreach uses this counting/delay enumerator.
    internal static class SingleParameterPeerControl { internal static int Scanned, DelayMilliseconds; }
    internal sealed class SingleParameterCollection : List<Parameter>
    {
        public new IEnumerator<Parameter> GetEnumerator()
        {
            foreach (Parameter parameter in (List<Parameter>)this)
            {
                if (SingleParameterPeerControl.DelayMilliseconds > 0) Thread.Sleep(SingleParameterPeerControl.DelayMilliseconds);
                SingleParameterPeerControl.Scanned++;
                yield return parameter;
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

    internal static class NativeSingleParameterPeerProgram
    {
        internal const long SourceId = 9007199254740993L, TypeId = 9223372036854775806L;
        private static bool Flag(Dictionary<string, object> input, string key)
        { object value; return input.TryGetValue(key, out value) && value is bool && (bool)value; }
        private static object Value(Dictionary<string, object> input, string key, object fallback)
        { object value; return input.TryGetValue(key, out value) ? value : fallback; }
        private static Parameter Parameter(long id, string name, StorageType storage, object value, string display, ForgeTypeId dataType, bool readOnly = false)
        { return new Parameter { Id = new ElementId(id), Definition = new Definition { Name = name, DataType = dataType }, StorageType = storage, HasValue = value != null, Value = value, Display = display, IsReadOnly = readOnly }; }
        private static Document Fixture(Dictionary<string, object> input)
        {
            var document = new Document { Title = "Single parameter fixture", PathName = "", IsModified = Flag(input, "modifiedBefore") };
            long selectedSourceId = long.Parse(Convert.ToString(Value(input, "sourceId", SourceId), CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
            var source = new Element { Id = new ElementId(selectedSourceId), Name = Flag(input, "nullName") ? null : "实例中文", TypeId = new ElementId(TypeId), IsValidObject = !Flag(input, "invalidSource") };
            source.Parameters.Add(Parameter(-123, "同名参数", StorageType.Double, 2.0, "609.6 mm", SpecTypeId.Length));
            source.Parameters.Add(Parameter(200, "同名参数", StorageType.String, "", null, new ForgeTypeId("text")));
            source.Parameters.Add(Parameter(201, "未赋值", StorageType.String, null, null, new ForgeTypeId("text")));
            source.Parameters.Add(Parameter(-200, "只读整数", StorageType.Integer, 1, "是", new ForgeTypeId("yesNo"), true));
            source.Parameters.Add(Parameter(-300, "无存储", StorageType.None, null, null, new ForgeTypeId("none")));
            source.Parameters.Add(Parameter(long.MaxValue, "精确正引用", StorageType.ElementId, new ElementId(9007199254740995L), "Reference", new ForgeTypeId("reference")));
            source.Parameters.Add(Parameter(long.MinValue, "精确负参数", StorageType.String, "负ID", null, new ForgeTypeId("text")));
            source.Parameters.Add(Parameter(202, " Name ", StorageType.String, "空格保留", null, new ForgeTypeId("text")));
            source.Parameters.Add(Parameter(203, "name", StorageType.String, "小写", null, new ForgeTypeId("text")));
            if (input.ContainsKey("parameters"))
            {
                source.Parameters.Clear();
                foreach (Dictionary<string, object> raw in (IList)input["parameters"])
                {
                    StorageType storage = (StorageType)Enum.Parse(typeof(StorageType), (string)Value(raw, "storage", "String"));
                    object value = Value(raw, "value", null);
                    if (storage == StorageType.Double && value != null) value = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                    if (storage == StorageType.Integer && value != null) value = Convert.ToInt32(value, CultureInfo.InvariantCulture);
                    if (storage == StorageType.ElementId && value != null) value = new ElementId(long.Parse(Convert.ToString(value, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture));
                    Parameter parameter = Parameter(long.Parse(Convert.ToString(Value(raw, "id", 1), CultureInfo.InvariantCulture), CultureInfo.InvariantCulture), (string)Value(raw, "name", "参数"), storage, value,
                        (string)Value(raw, "display", null), new ForgeTypeId((string)Value(raw, "dataType", storage == StorageType.Double ? "length" : "text")), Flag(raw, "readOnly"));
                    if (raw.ContainsKey("hasValue")) parameter.HasValue = Flag(raw, "hasValue");
                    if (Flag(raw, "nullId")) parameter.Id = null;
                    source.Parameters.Add(parameter);
                }
            }
            if (Flag(input, "unreadableUnrelatedValue")) source.Parameters.Add(Parameter(999, "不相关参数", StorageType.Double, "not a number", "unrelated", SpecTypeId.Length));
            if (input.ContainsKey("parameterCount"))
            {
                int count = Convert.ToInt32(input["parameterCount"], CultureInfo.InvariantCulture);
                source.Parameters.Clear();
                for (int index = 0; index < count; index++) source.Parameters.Add(Parameter(index + 1, "参数" + index, StorageType.String, "值", null, new ForgeTypeId("text")));
            }
            if (Flag(input, "lateDuplicateName")) source.Parameters.Add(Parameter(999, "同名参数", StorageType.String, "尾部", null, new ForgeTypeId("text")));
            if (Flag(input, "lateDuplicateId")) source.Parameters.Add(Parameter(-123, "不同名字", StorageType.String, "尾部", null, new ForgeTypeId("text")));
            if (Flag(input, "lateUnrelatedDuplicateId")) source.Parameters.Add(Parameter(203, "另一个名字", StorageType.String, "尾部", null, new ForgeTypeId("text")));
            var type = new ElementType { Id = new ElementId(TypeId), Name = "类型独有参数" };
            type.Parameters.Add(Parameter(301, "仅类型存在", StorageType.String, "type value", null, new ForgeTypeId("text")));
            document.Add(type);
            if (!Flag(input, "missingSource")) document.Add(source);
            return document;
        }
        private static string Facts(Document doc, JavaScriptSerializer json)
        {
            return doc == null ? "null" : json.Serialize(new { doc.IsModified, elements = doc.Elements.Select(element => new { id = element.Id.Value.ToString(CultureInfo.InvariantCulture), element.Name,
                parameters = element.Parameters.Select(parameter => new { id = parameter.Id == null ? null : parameter.Id.Value.ToString(CultureInfo.InvariantCulture), parameter.Definition.Name, parameter.StorageType, parameter.HasValue, parameter.IsReadOnly,
                    value = parameter.Value is ElementId ? (object)((ElementId)parameter.Value).Value.ToString(CultureInfo.InvariantCulture) : parameter.Value }) }) });
        }
        private static double ForcedDouble(object value, object mode)
        {
            string named = mode as string;
            return named == "nan" ? Double.NaN : named == "infinity" ? Double.PositiveInfinity : named == "negativeInfinity" ? Double.NegativeInfinity : Convert.ToDouble(value, CultureInfo.InvariantCulture);
        }
        public static int Main()
        {
            Console.InputEncoding = new System.Text.UTF8Encoding(false); Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            var json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 40 };
            var input = json.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd());
            Document doc = Flag(input, "noDocument") ? null : Fixture(input);
            var app = new UIApplication { ActiveUIDocument = doc == null ? null : new UIDocument { Document = doc } };
            var args = input.ContainsKey("args") ? input["args"] as Dictionary<string, object> : new Dictionary<string, object>();
            // Explicit runtime-type injection: JSONSerializer normally chooses
            // Int64 for these JSON integers, which would miss a Double-only bug.
            if (input.ContainsKey("parameterIdAsDouble")) args["parameter_id"] = ForcedDouble(Value(args, "parameter_id", 1), input["parameterIdAsDouble"]);
            if (input.ContainsKey("elementIdAsDouble")) args["element_id"] = ForcedDouble(Value(args, "element_id", 1), input["elementIdAsDouble"]);
            SingleParameterPeerControl.DelayMilliseconds = Flag(input, "scanTimeout") ? 5100 : 0;
            string before = Facts(doc, json); object value = null, error = null;
            try
            {
                string operation = input.ContainsKey("operation") ? (string)input["operation"] : "get_parameter_value";
                value = Flag(input, "legacyElementParameters") ? NativeModelQueries.Read(app, "get_element_parameters", args) : NativeParameterQueries.Read(app, operation, args);
            }
            catch (Exception failure) { error = new { type = failure.GetType().Name, message = failure.Message }; }
            string after = Facts(doc, json);
            Console.WriteLine(json.Serialize(new { ok = error == null, value, error, facts = new { sourceFactsUnchanged = before == after, modifiedBefore = doc == null ? (bool?)null : Flag(input, "modifiedBefore"),
                modifiedAfter = doc == null ? (bool?)null : doc.IsModified, scanned = SingleParameterPeerControl.Scanned,
                elementIdRuntimeType = args != null && args.ContainsKey("element_id") && args["element_id"] != null ? args["element_id"].GetType().Name : null,
                parameterIdRuntimeType = args != null && args.ContainsKey("parameter_id") && args["parameter_id"] != null ? args["parameter_id"].GetType().Name : null,
                scope = "Unchanged production single/type parameter query, exact ID parser and descriptor with controlled read-only peers; no Revit/model" } }));
            return 0;
        }
    }
}
