namespace RevitLocalCodex
{
    using System;
    using System.Collections.Generic;
    using System.Globalization;
    using System.Linq;
    using System.Web.Script.Serialization;
    using Autodesk.Revit.DB;
    using Autodesk.Revit.UI;

    // Fixtures only. The production query and parameter descriptor are compiled
    // unchanged beside the shared read-only Revit peers, without Autodesk loads.
    internal static class NativeTypeParameterPeerProgram
    {
        private const long SourceId = 9007199254740993L, TypeId = 9223372036854775806L;
        private static bool Flag(Dictionary<string, object> input, string key)
        { object value; return input.TryGetValue(key, out value) && value is bool && (bool)value; }
        private static Parameter Parameter(long id, string name, StorageType storage, object value, string display, ForgeTypeId dataType, bool readOnly = false)
        { return new Parameter { Id = new ElementId(id), Definition = new Definition { Name = name, DataType = dataType }, StorageType = storage, HasValue = value != null, Value = value, Display = display, IsReadOnly = readOnly }; }
        private static Document Fixture(Dictionary<string, object> input)
        {
            var document = new Document { Title = "Type parameter fixture", PathName = "", IsModified = true };
            var type = new ElementType { Id = new ElementId(TypeId), Name = Flag(input, "nullNames") ? null : "共享类型中文" };
            type.Parameters.Add(Parameter(9223372036854775807L, "引用", StorageType.ElementId, new ElementId(9007199254740995L), "Reference", new ForgeTypeId("reference")));
            type.Parameters.Add(Parameter(201, "空值", StorageType.String, null, null, new ForgeTypeId("text")));
            type.Parameters.Add(Parameter(-123, "同名参数", StorageType.Double, 2.0, "609.6 mm", SpecTypeId.Length));
            type.Parameters.Add(Parameter(200, "同名参数", StorageType.String, "", "ignored String display", new ForgeTypeId("text")));
            type.Parameters.Add(Parameter(-200, "只读整数", StorageType.Integer, 1, "是", new ForgeTypeId("yesNo"), true));
            type.Parameters.Add(Parameter(-300, "无存储", StorageType.None, null, null, new ForgeTypeId("none")));
            if (Flag(input, "noParameters")) type.Parameters.Clear();
            if (Flag(input, "parameterOverflow"))
            {
                type.Parameters.Clear();
                for (int index = 0; index < 2001; index++) type.Parameters.Add(Parameter(1000 + index, "重复显示名", StorageType.String, "值", null, new ForgeTypeId("text")));
            }
            if (Flag(input, "responseOverflow"))
            {
                type.Parameters.Clear();
                for (int index = 0; index < 50; index++) type.Parameters.Add(Parameter(1000 + index, "内容", StorageType.String, new string('x', 1000), null, new ForgeTypeId("text")));
            }
            if (Flag(input, "stringOverflow"))
            {
                type.Parameters.Clear(); type.Parameters.Add(Parameter(1000, "长文本", StorageType.String, new string('字', 16001), null, new ForgeTypeId("text")));
            }
            type.IsValidObject = !Flag(input, "invalidType");
            if (!Flag(input, "missingType"))
            {
                if (Flag(input, "wrongTypeKind")) document.Add(new Element { Id = new ElementId(TypeId), Name = type.Name });
                else document.Add(type);
            }
            var source = new Element { Id = new ElementId(SourceId), Name = Flag(input, "nullNames") ? null : "实例参数不同",
                TypeId = Flag(input, "nullType") ? null : new ElementId(Flag(input, "noType") ? -1 : Flag(input, "selfType") ? SourceId : TypeId),
                IsValidObject = !Flag(input, "invalidSource") };
            source.Parameters.Add(Parameter(-123, "同名参数", StorageType.Double, 999.0, "instance only", SpecTypeId.Length));
            document.Add(source);
            return document;
        }
        private static string Facts(Document document, JavaScriptSerializer json)
        {
            if (document == null) return "null";
            return json.Serialize(new { document.IsModified, elements = document.Elements.Select(element => new { id = element.Id.Value.ToString(CultureInfo.InvariantCulture), element.Name,
                type = element.TypeId == null ? null : element.TypeId.Value.ToString(CultureInfo.InvariantCulture), parameters = element.Parameters.Select(parameter => new {
                    id = parameter.Id.Value.ToString(CultureInfo.InvariantCulture), parameter.StorageType, parameter.IsReadOnly, parameter.HasValue,
                    value = parameter.Value is ElementId ? (object)((ElementId)parameter.Value).Value.ToString(CultureInfo.InvariantCulture) : parameter.Value }) }) });
        }
        public static int Main()
        {
            Console.InputEncoding = new System.Text.UTF8Encoding(false); Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            var json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 40 };
            var input = json.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd());
            Document document = Flag(input, "noDocument") ? null : Fixture(input);
            var app = new UIApplication { ActiveUIDocument = document == null ? null : new UIDocument { Document = document } };
            var args = input.ContainsKey("args") ? input["args"] as Dictionary<string, object> : new Dictionary<string, object>();
            string before = Facts(document, json); object value = null, failure = null;
            try
            {
                string operation = input.ContainsKey("operation") ? (string)input["operation"] : "get_type_parameters";
                value = Flag(input, "legacyElementParameters") ? NativeModelQueries.Read(app, "get_element_parameters", args) : NativeParameterQueries.Read(app, operation, args);
            }
            catch (Exception error) { failure = new { type = error.GetType().Name, message = error.Message }; }
            string after = Facts(document, json);
            Console.WriteLine(json.Serialize(new { ok = failure == null, value, error = failure,
                facts = new { sourceFactsUnchanged = before == after, modifiedBefore = document == null ? (bool?)null : true,
                    modifiedAfter = document == null ? (bool?)null : document.IsModified,
                    scope = "Actual C# type/instance query and parameter facts; controlled read-only peers, no Revit process or model" } }));
            return 0;
        }
    }
}
