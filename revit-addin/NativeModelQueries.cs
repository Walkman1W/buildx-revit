using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    // Named read DTOs only. Called on the existing ExternalEvent thread and
    // frozen by WorkbenchHost in the same document/view identity callback.
    internal static class NativeModelQueries
    {
        private const int MaximumScan = 100000;
        private static readonly string[] Operations = { "health", "get_document_info", "list_views", "get_element_parameters", "get_elements_by_type", "get_element_geometry" };
        private static readonly string[] DefaultFields = { "name", "category", "type_id", "level" };
        private static readonly string[] ElementFields = { "name", "category", "type_id", "level", "length", "area", "volume" };
        private static readonly Dictionary<string, string> CategoryAliases = new Dictionary<string, string>(StringComparer.Ordinal) {
            {"Walls","OST_Walls"}, {"Doors","OST_Doors"}, {"Windows","OST_Windows"}, {"Floors","OST_Floors"},
            {"Roofs","OST_Roofs"}, {"Ceilings","OST_Ceilings"}, {"Columns","OST_Columns"}, {"StructuralColumns","OST_StructuralColumns"},
            {"StructuralFraming","OST_StructuralFraming"}, {"Pipes","OST_PipeCurves"}, {"PipeFittings","OST_PipeFitting"},
            {"PipeAccessories","OST_PipeAccessory"}, {"Ducts","OST_DuctCurves"}, {"DuctFittings","OST_DuctFitting"},
            {"DuctAccessories","OST_DuctAccessory"}, {"MechanicalEquipment","OST_MechanicalEquipment"},
            {"PlumbingFixtures","OST_PlumbingFixtures"}, {"Furniture","OST_Furniture"}, {"GenericModels","OST_GenericModel"}
        };
        internal static bool IsRead(string operation) { return Operations.Contains(operation, StringComparer.Ordinal); }
        internal static string SignedId(ElementId id) { return id.Value.ToString(CultureInfo.InvariantCulture); }
        internal static long ExactId(Dictionary<string, object> args, string key) { return RequiredId(args, key); }
        internal static long ExactSignedId(Dictionary<string, object> args, string key)
        {
            long id = RequiredId(args, key, true);
            if (id == 0 || id == -1) throw new InvalidOperationException("Parameter id must not be 0 or -1.");
            return id;
        }
        private static string PositiveId(ElementId id) { return id == null || id.Value <= 0 ? null : SignedId(id); }

        internal static object Read(UIApplication uiapp, string operation, Dictionary<string, object> args)
        {
            var budget = new ReadBudget();
            Document doc = uiapp.ActiveUIDocument == null ? null : uiapp.ActiveUIDocument.Document;
            if (operation == "health")
            {
                Fields(args, "expected_document");
                return new { schema_version = 1, status = doc == null ? "no_document" : "ready", document_open = doc != null };
            }
            if (doc == null) throw new InvalidOperationException("Open a Revit document before this query.");
            if (operation == "get_document_info")
            {
                Fields(args, "expected_document");
                object result = new { schema_version = 1, title = doc.Title, path = doc.PathName, is_family_document = doc.IsFamilyDocument,
                    is_read_only = doc.IsReadOnly, is_modified = doc.IsModified, active_view = doc.ActiveView == null ? null : ViewDto(doc.ActiveView) };
                budget.Reserve(result); return result;
            }
            if (operation == "list_views")
            {
                Fields(args, "expected_document", "offset", "limit");
                int offset = Page(args, "offset", 0, 0, int.MaxValue), limit = Page(args, "limit", 200, 1, 500);
                var matches = new List<ElementId>();
                using (var collector = new FilteredElementCollector(doc).OfClass(typeof(View)))
                    foreach (Element view in collector) { budget.Scan(); matches.Add(view.Id); }
                matches.Sort((a, b) => a.Value.CompareTo(b.Value));
                var items = new List<object>();
                foreach (ElementId id in matches.Skip(offset).Take(limit)) { object item = ViewDto((View)doc.GetElement(id)); budget.Reserve(item); items.Add(item); }
                return PageResult(items, offset, limit, matches.Count, budget.Scanned);
            }
            if (operation == "get_element_parameters")
            {
                Fields(args, "expected_document", "element_id");
                Element element = RequiredElement(doc, RequiredId(args, "element_id"));
                return new { schema_version = 1, element_id = SignedId(element.Id), element_name = element.Name, parameters = ParameterRows(element, budget) };
            }
            if (operation == "get_elements_by_type") return Elements(doc, args, budget);
            if (operation == "get_element_geometry")
            {
                Fields(args, "expected_document", "element_id");
                object result = Geometry(RequiredElement(doc, RequiredId(args, "element_id")));
                budget.Reserve(result); return result;
            }
            throw new InvalidOperationException("Unknown native model query.");
        }

        // Instance/type queries share these exact rows and the existing budget.
        // Parameter identity, raw/display values and units remain owned by the
        // WorkbenchActions descriptor rather than a second DTO interpretation.
        internal static object[] ParameterRows(Element element, ReadBudget budget)
        {
            var parameters = new List<Parameter>();
            foreach (Parameter parameter in element.Parameters) { budget.Scan(); if (parameters.Count >= 2000) throw new InvalidOperationException("Native parameter query exceeds 2000 parameters; no partial result published."); parameters.Add(parameter); }
            parameters.Sort((a, b) => a.Id.Value.CompareTo(b.Id.Value));
            var values = new List<object>();
            foreach (Parameter parameter in parameters) { object value = WorkbenchActions.DescribeParameter(parameter, true); budget.Reserve(value); values.Add(value); }
            return values.ToArray();
        }

        private static object Elements(Document doc, Dictionary<string, object> args, ReadBudget budget)
        {
            Fields(args, "expected_document", "category", "type_id", "level", "level_id", "fields", "offset", "limit");
            int offset = Page(args, "offset", 0, 0, int.MaxValue), limit = Page(args, "limit", 200, 1, 500);
            long? typeId = args.ContainsKey("type_id") ? (long?)RequiredId(args, "type_id") : null;
            if (typeId.HasValue && !(RequiredElement(doc, typeId.Value) is ElementType)) throw new InvalidOperationException("type_id must identify an element type.");
            BuiltInCategory? category = Category(args);
            Level level = ResolveLevel(doc, args, budget);
            string[] fields = FieldsToReturn(args);
            var matches = new List<ElementId>();
            using (var collector = new FilteredElementCollector(doc).WhereElementIsNotElementType())
            {
                if (category.HasValue) collector.OfCategory(category.Value);
                foreach (Element element in collector)
                {
                    budget.Scan();
                    if (typeId.HasValue && element.GetTypeId().Value != typeId.Value || level != null && element.LevelId.Value != level.Id.Value) continue;
                    matches.Add(element.Id);
                }
            }
            matches.Sort((a, b) => a.Value.CompareTo(b.Value));
            var items = new List<object>();
            foreach (ElementId id in matches.Skip(offset).Take(limit))
            {
                Element element = RequiredElement(doc, id.Value);
                var item = new Dictionary<string, object> { {"id", SignedId(element.Id)} };
                foreach (string field in fields)
                {
                    if (field == "name") item[field] = element.Name;
                    else if (field == "category") item[field] = CategoryDto(element.Category);
                    else if (field == "type_id") item[field] = PositiveId(element.GetTypeId());
                    else if (field == "level") item[field] = LevelDto(element);
                    else item[field] = Measure(element, field);
                }
                budget.Reserve(item); items.Add(item);
            }
            return PageResult(items, offset, limit, matches.Count, budget.Scanned);
        }

        private static object PageResult(List<object> items, int offset, int limit, int total, int scanned)
        {
            return new { schema_version = 1, items = items.ToArray(), offset, limit, total, has_more = (long)offset + items.Count < total,
                coverage = new { scanned, complete = true, stop_reason = (string)null } };
        }
        private static object ViewDto(View view) { return new { id = SignedId(view.Id), name = view.Name, view_type = view.ViewType.ToString(), is_template = view.IsTemplate }; }
        private static object CategoryDto(Category category)
        {
            if (category == null) return null;
            long value = category.Id.Value;
            string builtIn = value >= int.MinValue && value <= int.MaxValue && Enum.IsDefined(typeof(BuiltInCategory), (int)value) ? Enum.GetName(typeof(BuiltInCategory), (int)value) : null;
            return new { id = SignedId(category.Id), name = category.Name, built_in_category = builtIn };
        }
        private static object LevelDto(Element element)
        {
            Level level = element.Document.GetElement(element.LevelId) as Level;
            return level == null ? null : new { id = SignedId(level.Id), name = level.Name };
        }
        private static Level ResolveLevel(Document doc, Dictionary<string, object> args, ReadBudget budget)
        {
            Level selected = null;
            if (args.ContainsKey("level_id"))
            {
                selected = RequiredElement(doc, RequiredId(args, "level_id")) as Level;
                if (selected == null) throw new InvalidOperationException("level_id must identify a level.");
            }
            if (!args.ContainsKey("level")) return selected;
            string name = Text(args, "level");
            if (selected != null) { if (selected.Name != name) throw new InvalidOperationException("level and level_id identify different levels."); return selected; }
            using (var collector = new FilteredElementCollector(doc).OfClass(typeof(Level)))
                foreach (Level level in collector)
                {
                    budget.Scan();
                    if (level.Name != name) continue;
                    if (selected != null) throw new InvalidOperationException("Level name is ambiguous; provide level_id.");
                    selected = level;
                }
            if (selected == null) throw new InvalidOperationException("Level name was not found; no fallback name search was performed.");
            return selected;
        }
        private static BuiltInCategory? Category(Dictionary<string, object> args)
        {
            if (!args.ContainsKey("category") || Text(args, "category").Length == 0) return null;
            string name = Text(args, "category"), alias;
            if (CategoryAliases.TryGetValue(name, out alias)) name = alias;
            BuiltInCategory category;
            if (!name.StartsWith("OST_", StringComparison.Ordinal) || !Enum.TryParse<BuiltInCategory>(name, false, out category) || !Enum.IsDefined(typeof(BuiltInCategory), category))
                throw new InvalidOperationException("Unknown category; use an exact OST_ identity or a documented category alias.");
            return category;
        }
        private static string[] FieldsToReturn(Dictionary<string, object> args)
        {
            if (!args.ContainsKey("fields")) return DefaultFields;
            var list = args["fields"] as IList;
            if (list == null || list.Count > ElementFields.Length) throw new InvalidOperationException("fields must be a bounded array.");
            var result = new List<string>();
            foreach (object raw in list)
            {
                string field = raw as string;
                if (field == null || !ElementFields.Contains(field, StringComparer.Ordinal) || result.Contains(field)) throw new InvalidOperationException("Unknown or repeated requested field.");
                result.Add(field);
            }
            return result.ToArray();
        }

        private static object Geometry(Element element)
        {
            object location = null;
            var point = element.Location as LocationPoint;
            var curve = element.Location as LocationCurve;
            if (point != null) location = new { kind = "point", point_mm = Point(point.Point) };
            else if (curve != null && curve.Curve != null && curve.Curve.IsBound) location = new { kind = "curve", start_mm = Point(curve.Curve.GetEndPoint(0)), end_mm = Point(curve.Curve.GetEndPoint(1)) };
            object boxValue = null;
            BoundingBoxXYZ box = element.get_BoundingBox(null);
            if (box != null)
            {
                // Transform all eight corners; transforming only Min/Max is
                // incorrect for a rotated/reflected BoundingBoxXYZ.
                var corners = new List<XYZ>();
                foreach (double x in new[] { box.Min.X, box.Max.X })
                    foreach (double y in new[] { box.Min.Y, box.Max.Y })
                        foreach (double z in new[] { box.Min.Z, box.Max.Z }) corners.Add(box.Transform.OfPoint(new XYZ(x, y, z)));
                boxValue = new { min_mm = Point(new XYZ(corners.Min(p => p.X), corners.Min(p => p.Y), corners.Min(p => p.Z))),
                    max_mm = Point(new XYZ(corners.Max(p => p.X), corners.Max(p => p.Y), corners.Max(p => p.Z))) };
            }
            object level = LevelDto(element), length = Measure(element, "length"), area = Measure(element, "area"), volume = Measure(element, "volume");
            return new { schema_version = 1, element_id = SignedId(element.Id), coordinate_system = "revit_internal", representation = "summary_no_mesh",
                location, bounding_box = boxValue, level, length, area, volume,
                unavailable = new { location = location == null ? "not_available" : null, bounding_box = boxValue == null ? "not_available" : null,
                    level = level == null ? "not_available" : null, length = length == null ? "no_applicable_value" : null,
                    area = area == null ? "no_applicable_value" : null, volume = volume == null ? "no_applicable_value" : null } };
        }
        private static object Measure(Element element, string field)
        {
            BuiltInParameter builtIn = field == "length" ? BuiltInParameter.CURVE_ELEM_LENGTH : field == "area" ? BuiltInParameter.HOST_AREA_COMPUTED : BuiltInParameter.HOST_VOLUME_COMPUTED;
            Parameter parameter = element.get_Parameter(builtIn);
            if (parameter == null || !parameter.HasValue || parameter.StorageType != StorageType.Double) return null;
            ForgeTypeId expected = field == "length" ? SpecTypeId.Length : field == "area" ? SpecTypeId.Area : SpecTypeId.Volume;
            if (parameter.Definition.GetDataType() != expected) return null;
            double value = UnitUtils.ConvertFromInternalUnits(parameter.AsDouble(), field == "length" ? UnitTypeId.Millimeters : field == "area" ? UnitTypeId.SquareMeters : UnitTypeId.CubicMeters);
            if (double.IsNaN(value) || double.IsInfinity(value) || value < 0) throw new InvalidOperationException("Invalid measurement cannot be published.");
            return new { value, unit = field == "length" ? "mm" : field == "area" ? "m2" : "m3" };
        }
        private static object Point(XYZ point)
        {
            double x = UnitUtils.ConvertFromInternalUnits(point.X, UnitTypeId.Millimeters), y = UnitUtils.ConvertFromInternalUnits(point.Y, UnitTypeId.Millimeters), z = UnitUtils.ConvertFromInternalUnits(point.Z, UnitTypeId.Millimeters);
            if (double.IsNaN(x) || double.IsInfinity(x) || double.IsNaN(y) || double.IsInfinity(y) || double.IsNaN(z) || double.IsInfinity(z)) throw new InvalidOperationException("Nonfinite coordinate cannot be published.");
            return new { x, y, z };
        }
        private static long RequiredId(Dictionary<string, object> args, string key, bool signed = false)
        {
            object value; if (!args.TryGetValue(key, out value)) throw new InvalidOperationException("Missing argument: " + key);
            string text = value as string; long parsed;
            if (text != null)
            {
                bool negative = signed && text.Length > 0 && text[0] == '-';
                string digits = negative ? text.Substring(1) : text;
                if (digits.Length == 0 || digits[0] < '1' || digits[0] > '9' || !digits.All(c => c >= '0' && c <= '9') || !long.TryParse(text, negative ? NumberStyles.AllowLeadingSign : NumberStyles.None, CultureInfo.InvariantCulture, out parsed) || !signed && parsed <= 0) throw new InvalidOperationException("Invalid precise ElementId: " + key);
                return parsed;
            }
            if (!(value is int || value is long || value is double || value is decimal)) throw new InvalidOperationException("ElementId must be an integer or decimal string.");
            if (value is double)
            {
                double floating = (double)value;
                if (double.IsNaN(floating) || double.IsInfinity(floating) || floating < (signed ? -9007199254740991d : 1d) || floating > 9007199254740991d || Math.Truncate(floating) != floating) throw new InvalidOperationException("Unsafe numeric ElementId; provide a precise decimal string.");
                return (long)floating;
            }
            decimal number = Convert.ToDecimal(value, CultureInfo.InvariantCulture);
            if (number < (signed ? -9007199254740991m : 1m) || number > 9007199254740991m || decimal.Truncate(number) != number) throw new InvalidOperationException("Unsafe numeric ElementId; provide a precise decimal string.");
            return (long)number;
        }
        private static Element RequiredElement(Document doc, long id)
        {
            Element element = doc.GetElement(new ElementId(id));
            if (element == null || !element.IsValidObject) throw new InvalidOperationException("Element does not exist in current document: " + id);
            return element;
        }
        private static int Page(Dictionary<string, object> args, string key, int fallback, int minimum, int maximum)
        {
            object raw; if (!args.TryGetValue(key, out raw)) return fallback;
            if (!(raw is int || raw is long || raw is double || raw is decimal)) throw new InvalidOperationException("Invalid page argument: " + key);
            decimal value = Convert.ToDecimal(raw, CultureInfo.InvariantCulture);
            if (value < minimum || value > maximum || decimal.Truncate(value) != value) throw new InvalidOperationException("Page argument out of bounds: " + key);
            return (int)value;
        }
        private static string Text(Dictionary<string, object> args, string key)
        {
            object value; if (!args.TryGetValue(key, out value) || !(value is string)) throw new InvalidOperationException("Expected string: " + key);
            if (((string)value).Length > 1024) throw new InvalidOperationException("Query text exceeds budget: " + key);
            return (string)value;
        }
        private static void Fields(Dictionary<string, object> args, params string[] allowed)
        { foreach (string key in args.Keys) if (!allowed.Contains(key, StringComparer.Ordinal)) throw new InvalidOperationException("Unknown argument: " + key); }

        internal sealed class ReadBudget
        {
            private readonly Stopwatch watch = Stopwatch.StartNew();
            private readonly int maximumScanned;
            private int estimatedCharacters = 4096;
            internal int Scanned;
            internal ReadBudget(int maxScanned = MaximumScan)
            {
                if (maxScanned < 1 || maxScanned > MaximumScan) throw new ArgumentOutOfRangeException("maxScanned");
                maximumScanned = maxScanned;
            }
            internal void Scan()
            {
                if (++Scanned > maximumScanned || watch.ElapsedMilliseconds > 5000) throw new InvalidOperationException("Native query scan/time budget exceeded; no partial coverage published.");
            }
            internal void Reserve(object value)
            {
                estimatedCharacters = checked(estimatedCharacters + Estimate(value, 0));
                if (estimatedCharacters > 180000 || watch.ElapsedMilliseconds > 5000) throw new InvalidOperationException("Native query response/time budget exceeded; request fewer fields or a smaller page.");
            }
            private static int Estimate(object value, int depth)
            {
                if (depth > 12) throw new InvalidOperationException("Native DTO nesting exceeds budget.");
                if (value == null) return 4;
                string text = value as string;
                if (text != null) { if (text.Length > 16000) throw new InvalidOperationException("Native DTO string exceeds budget."); return checked(text.Length * 6 + 2); }
                var dictionary = value as IDictionary;
                if (dictionary != null) { int size = 2; foreach (DictionaryEntry entry in dictionary) size = checked(size + Estimate(entry.Key, depth + 1) + Estimate(entry.Value, depth + 1) + 2); return size; }
                if (value.GetType().IsPrimitive || value is decimal) return 32;
                var sequence = value as IEnumerable;
                if (sequence != null) { int size = 2; foreach (object entry in sequence) size = checked(size + Estimate(entry, depth + 1) + 1); return size; }
                int result = 2;
                foreach (var property in value.GetType().GetProperties()) result = checked(result + property.Name.Length * 6 + Estimate(property.GetValue(value, null), depth + 1) + 4);
                return result;
            }
        }
    }
}
