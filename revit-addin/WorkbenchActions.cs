using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    // Explicit, typed Revit operations. All methods are called from ExternalEvent.Execute.
    internal static class WorkbenchActions
    {
        internal static readonly string[] ReadOperations = { "get_selection", "search_elements", "list_levels", "list_family_types", "describe_parameters", "capture_model_snapshot", "health", "get_document_info", "list_views", "get_element_parameters", "get_elements_by_type", "get_element_geometry" };
        internal static readonly string[] WriteOperations = { "set_parameters", "move_elements", "copy_elements", "create_wall", "create_pipe" };
        internal static bool IsRead(string operation) { return ReadOperations.Contains(operation, StringComparer.Ordinal); }
        internal static bool IsWrite(string operation) { return WriteOperations.Contains(operation, StringComparer.Ordinal); }

        internal static object Read(UIApplication uiapp, string operation, Dictionary<string, object> args)
        {
            if (NativeModelQueries.IsRead(operation)) return NativeModelQueries.Read(uiapp, operation, args);
            Document doc = uiapp.ActiveUIDocument.Document;
            if (operation == "capture_model_snapshot")
            {
                Fields(args, "expected_document", "limit");
                return ModelViewerSnapshot.Capture(uiapp, (int)OptionalInteger(args, "limit", 200, 1, 300));
            }
            if (operation == "get_selection")
            {
                Fields(args, "expected_document");
                var ids = uiapp.ActiveUIDocument.Selection.GetElementIds().OrderBy(id => id.Value).ToList();
                return new { total = ids.Count, returned = Math.Min(ids.Count, 200), truncated = ids.Count > 200,
                    items = ids.Take(200).Select(id => DescribeElement(RequiredElement(doc, id.Value))).ToArray() };
            }
            if (operation == "search_elements" || operation == "list_family_types")
            {
                Fields(args, "expected_document", "category", "name_contains", "limit", "offset");
                int limit = (int)OptionalInteger(args, "limit", 50, 1, 200);
                int offset = (int)OptionalInteger(args, "offset", 0, 0, int.MaxValue);
                string name = OptionalString(args, "name_contains", "");
                BuiltInCategory? category = CategoryFilter(args);
                using (var collector = new FilteredElementCollector(doc))
                {
                    if (operation == "list_family_types") collector.WhereElementIsElementType();
                    else collector.WhereElementIsNotElementType();
                    if (category.HasValue) collector.OfCategory(category.Value);
                    var matches = collector.Where(element => (element.Name ?? "").IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0)
                        .OrderBy(element => element.Id.Value).ToList();
                    return new { total = matches.Count, offset, limit, has_more = (long)offset + limit < matches.Count,
                        items = matches.Skip(offset).Take(limit).Select(DescribeElement).ToArray() };
                }
            }
            if (operation == "list_levels")
            {
                Fields(args, "expected_document");
                using (var collector = new FilteredElementCollector(doc))
                {
                    return new { items = collector.OfClass(typeof(Level)).Cast<Level>()
                        .OrderBy(level => level.ProjectElevation).ThenBy(level => level.Id.Value)
                        .Select(level => new { element_id = level.Id.Value, name = level.Name,
                            elevation_mm = Millimeters(level.Elevation), project_elevation_mm = Millimeters(level.ProjectElevation) }).ToArray() };
                }
            }
            if (operation == "describe_parameters")
            {
                Fields(args, "expected_document", "element_id");
                Element element = RequiredElement(doc, ElementIdValue(Required(args, "element_id"), "element_id"));
                return new { element_id = element.Id.Value, element_name = element.Name,
                    parameters = element.Parameters.Cast<Parameter>().OrderBy(parameter => parameter.Id.Value)
                        .Select(parameter => DescribeParameter(parameter)).ToArray() };
            }
            throw new InvalidOperationException("Unknown read operation.");
        }

        internal static object Write(UIApplication uiapp, string operation, Dictionary<string, object> args)
        {
            Document doc = uiapp.ActiveUIDocument.Document;
            // Each operation owns exactly one transaction. The caller's TransactionGroup
            // decides rollback vs commit; no method saves the document.
            using (var transaction = new Transaction(doc, "Local Codex: " + operation))
            {
                if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Could not start Revit transaction.");
                try
                {
                    object result;
                    if (operation == "set_parameters") result = SetParameters(doc, args);
                    else if (operation == "move_elements" || operation == "copy_elements") result = TransformElements(doc, operation, args);
                    else if (operation == "create_wall") result = CreateWall(uiapp, args);
                    else if (operation == "create_pipe") result = CreatePipe(uiapp, args);
                    else throw new InvalidOperationException("Unknown write operation.");
                    transaction.SetFailureHandlingOptions(transaction.GetFailureHandlingOptions()
                        .SetFailuresPreprocessor(new RejectErrors()).SetClearAfterRollback(true));
                    if (transaction.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Revit rejected the operation; transaction was rolled back.");
                    return result;
                }
                catch { if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack(); throw; }
            }
        }

        private static object SetParameters(Document doc, Dictionary<string, object> args)
        {
            Fields(args, "expected_document", "mode", "changes");
            IList changes = RequiredList(args, "changes", 1, 50);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var results = new List<object>();
            foreach (object item in changes)
            {
                var change = item as Dictionary<string, object>;
                if (change == null) throw new InvalidOperationException("Each change must be an object.");
                Fields(change, "element_id", "parameter_id", "value", "value_unit");
                long elementId = ElementIdValue(Required(change, "element_id"), "element_id");
                long parameterId = Integer(Required(change, "parameter_id"), "parameter_id", -9007199254740991L, 9007199254740991L);
                if (parameterId == 0 || parameterId == -1) throw new InvalidOperationException("parameter_id must identify an actual parameter, not 0 or -1.");
                if (!seen.Add(elementId.ToString(CultureInfo.InvariantCulture) + ":" + parameterId.ToString(CultureInfo.InvariantCulture)))
                    throw new InvalidOperationException("Duplicate element_id/parameter_id pair in changes.");
                Element element = RequiredElement(doc, elementId);
                Parameter parameter = element.Parameters.Cast<Parameter>().SingleOrDefault(candidate => candidate.Id.Value == parameterId);
                if (parameter == null) throw new InvalidOperationException("Parameter id " + parameterId + " does not belong to element " + elementId + ".");
                if (parameter.IsReadOnly) throw new InvalidOperationException("Parameter is read-only: " + parameterId);
                object value = Required(change, "value");
                string unit = OptionalString(change, "value_unit", "");
                if (change.ContainsKey("value_unit") && unit != "internal") throw new InvalidOperationException("value_unit, when provided, must equal internal.");
                object before = InternalValue(parameter);
                bool changed;
                if (parameter.StorageType == StorageType.Double)
                {
                    if (unit != "internal") throw new InvalidOperationException("Double parameters require value_unit=internal for each change.");
                    double number = FiniteNumber(value, "value");
                    changed = parameter.HasValue && parameter.AsDouble() == number ? false : parameter.Set(number);
                    if ((!parameter.HasValue || parameter.AsDouble() != number) && !changed) throw new InvalidOperationException("Revit refused Double parameter value.");
                }
                else if (parameter.StorageType == StorageType.Integer)
                {
                    int number = (int)Integer(value, "value", int.MinValue, int.MaxValue);
                    if (parameter.Definition.GetDataType() == SpecTypeId.Boolean.YesNo && number != 0 && number != 1)
                        throw new InvalidOperationException("Yes/No parameters require integer 0 or 1.");
                    changed = parameter.HasValue && parameter.AsInteger() == number ? false : parameter.Set(number);
                    if ((!parameter.HasValue || parameter.AsInteger() != number) && !changed) throw new InvalidOperationException("Revit refused Integer parameter value.");
                }
                else if (parameter.StorageType == StorageType.String)
                {
                    if (!(value is string)) throw new InvalidOperationException("String parameter value must be a string, not a converted number or null.");
                    string text = (string)value;
                    changed = parameter.HasValue && parameter.AsString() == text ? false : parameter.Set(text);
                    if ((!parameter.HasValue || parameter.AsString() != text) && !changed) throw new InvalidOperationException("Revit refused String parameter value.");
                }
                else throw new InvalidOperationException("Only Double, Integer and String parameters can be written; ElementId parameters are not supported.");
                results.Add(new { element_id = elementId, parameter_id = parameterId, storage_type = parameter.StorageType.ToString(),
                    data_type = parameter.Definition.GetDataType().TypeId, changed, before_internal = before, after_internal = InternalValue(parameter) });
            }
            return new { updated_count = results.Count, changes = results.ToArray() };
        }

        private static object TransformElements(Document doc, string operation, Dictionary<string, object> args)
        {
            Fields(args, "expected_document", "mode", "element_ids", "delta_mm");
            IList input = RequiredList(args, "element_ids", 1, 50);
            var values = input.Cast<object>().Select(value => ElementIdValue(value, "element_ids")).ToArray();
            if (values.Distinct().Count() != values.Length) throw new InvalidOperationException("element_ids must not contain duplicates.");
            var ids = new List<ElementId>();
            foreach (long value in values)
            {
                Element element = RequiredElement(doc, value);
                if (element is ElementType) throw new InvalidOperationException("Element types cannot be moved or copied as model instances.");
                if (element.Pinned) throw new InvalidOperationException("Pinned element cannot be transformed: " + value);
                ids.Add(element.Id);
            }
            XYZ delta = MillimeterPoint(Required(args, "delta_mm"), "delta_mm");
            if (operation == "move_elements")
            {
                ElementTransformUtils.MoveElements(doc, ids, delta);
                return new { element_ids = values, moved_count = values.Length, delta_mm = PointDto(delta) };
            }
            ICollection<ElementId> created = ElementTransformUtils.CopyElements(doc, ids, delta);
            return new { source_element_ids = values, created_element_ids = created.Select(id => id.Value).OrderBy(id => id).ToArray(),
                created_count = created.Count, delta_mm = PointDto(delta) };
        }

        private static object CreateWall(UIApplication uiapp, Dictionary<string, object> args)
        {
            Fields(args, "expected_document", "mode", "wall_type_id", "level_id", "start_mm", "end_mm", "height_mm", "offset_mm", "structural");
            Document doc = uiapp.ActiveUIDocument.Document;
            WallType type = RequiredType<WallType>(doc, args, "wall_type_id");
            Level level = RequiredType<Level>(doc, args, "level_id");
            XYZ start = MillimeterPoint(Required(args, "start_mm"), "start_mm");
            XYZ end = MillimeterPoint(Required(args, "end_mm"), "end_mm");
            double height = PositiveLength(Required(args, "height_mm"), "height_mm");
            double offset = Feet(OptionalNumber(args, "offset_mm", 0));
            bool structural = OptionalBoolean(args, "structural", false);
            double tolerance = Feet(0.1);
            double baseElevation = level.ProjectElevation + offset;
            if (Math.Abs(start.Z - end.Z) > tolerance || Math.Abs(start.Z - baseElevation) > tolerance || Math.Abs(end.Z - baseElevation) > tolerance)
                throw new InvalidOperationException("Wall baseline must be horizontal. Both point z values must equal list_levels.project_elevation_mm + offset_mm (tolerance 0.1 mm).");
            CheckCurveLength(uiapp, start, end);
            Wall wall = Wall.Create(doc, Line.CreateBound(start, end), type.Id, level.Id, height, offset, false, structural);
            return new { element_id = wall.Id.Value, wall_type_id = type.Id.Value, level_id = level.Id.Value,
                start_mm = PointDto(start), end_mm = PointDto(end), height_mm = Millimeters(height), offset_mm = Millimeters(offset), structural };
        }

        private static object CreatePipe(UIApplication uiapp, Dictionary<string, object> args)
        {
            Fields(args, "expected_document", "mode", "pipe_type_id", "system_type_id", "level_id", "start_mm", "end_mm", "diameter_mm");
            Document doc = uiapp.ActiveUIDocument.Document;
            PipeType type = RequiredType<PipeType>(doc, args, "pipe_type_id");
            PipingSystemType system = RequiredType<PipingSystemType>(doc, args, "system_type_id");
            Level level = RequiredType<Level>(doc, args, "level_id");
            XYZ start = MillimeterPoint(Required(args, "start_mm"), "start_mm");
            XYZ end = MillimeterPoint(Required(args, "end_mm"), "end_mm");
            double diameter = PositiveLength(Required(args, "diameter_mm"), "diameter_mm");
            CheckCurveLength(uiapp, start, end);
            if (start.DistanceTo(end) < Feet(2.54))
                throw new InvalidOperationException("Pipe length must be at least 2.54 mm (Revit MEPCurve minimum of 1/10 inch).");
            Pipe pipe = Pipe.Create(doc, system.Id, type.Id, level.Id, start, end);
            Parameter diameterParameter = pipe.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
            if (diameterParameter == null || diameterParameter.IsReadOnly || diameterParameter.StorageType != StorageType.Double)
                throw new InvalidOperationException("Created pipe does not have a writable Double diameter parameter.");
            if (!diameterParameter.Set(diameter) && diameterParameter.AsDouble() != diameter)
                throw new InvalidOperationException("Revit refused the requested pipe diameter.");
            doc.Regenerate();
            double actual = diameterParameter.AsDouble();
            if (Math.Abs(actual - diameter) > Feet(0.001)) throw new InvalidOperationException("Pipe type did not retain the requested diameter.");
            return new { element_id = pipe.Id.Value, pipe_type_id = type.Id.Value, system_type_id = system.Id.Value, level_id = level.Id.Value,
                start_mm = PointDto(start), end_mm = PointDto(end), diameter_mm = Millimeters(actual) };
        }

        private static object DescribeElement(Element element)
        {
            ElementType type = element as ElementType;
            return new { element_id = element.Id.Value, name = element.Name, class_name = element.GetType().Name,
                category = element.Category == null ? null : element.Category.Name,
                category_id = element.Category == null ? (long?)null : element.Category.Id.Value,
                type_id = element.GetTypeId().Value, level_id = element.LevelId.Value,
                family_name = type == null ? null : type.FamilyName, is_type = type != null };
        }

        internal static object DescribeParameter(Parameter parameter, bool exactIds = false)
        {
            ForgeTypeId dataType = parameter.Definition.GetDataType();
            string unit = UnitUtils.IsMeasurableSpec(dataType) ? parameter.GetUnitTypeId().TypeId : null;
            string display = null;
            if (parameter.HasValue) display = parameter.StorageType == StorageType.String ? parameter.AsString() : parameter.AsValueString();
            return new { parameter_id = exactIds ? (object)NativeModelQueries.SignedId(parameter.Id) : parameter.Id.Value, name = parameter.Definition.Name, storage_type = parameter.StorageType.ToString(),
                is_read_only = parameter.IsReadOnly, has_value = parameter.HasValue, data_type = dataType.TypeId, unit_type = unit,
                value_internal = exactIds && parameter.HasValue && parameter.StorageType == StorageType.ElementId ? (object)NativeModelQueries.SignedId(parameter.AsElementId()) : InternalValue(parameter), value_display = display };
        }

        private static object InternalValue(Parameter parameter)
        {
            if (!parameter.HasValue) return null;
            switch (parameter.StorageType)
            {
                case StorageType.Double: return parameter.AsDouble();
                case StorageType.Integer: return parameter.AsInteger();
                case StorageType.String: return parameter.AsString();
                case StorageType.ElementId: return parameter.AsElementId().Value;
                default: return null;
            }
        }

        private static T RequiredType<T>(Document doc, Dictionary<string, object> args, string key) where T : Element
        {
            Element element = RequiredElement(doc, ElementIdValue(Required(args, key), key));
            T typed = element as T;
            if (typed == null) throw new InvalidOperationException(key + " must identify " + typeof(T).Name + ", received " + element.GetType().Name + ".");
            return typed;
        }
        private static Element RequiredElement(Document doc, long id)
        {
            Element element = doc.GetElement(new ElementId(id));
            if (element == null || !element.IsValidObject) throw new InvalidOperationException("Element does not exist in current document: " + id);
            return element;
        }
        private static void CheckCurveLength(UIApplication uiapp, XYZ start, XYZ end)
        {
            if (start.DistanceTo(end) <= uiapp.Application.ShortCurveTolerance)
                throw new InvalidOperationException("Start and end must be separated by more than Revit ShortCurveTolerance.");
        }
        private static XYZ MillimeterPoint(object raw, string label)
        {
            var point = raw as Dictionary<string, object>;
            if (point == null) throw new InvalidOperationException(label + " must be an object with numeric x, y, z.");
            Fields(point, "x", "y", "z");
            var result = new XYZ(Feet(FiniteNumber(Required(point, "x"), label + ".x")),
                Feet(FiniteNumber(Required(point, "y"), label + ".y")), Feet(FiniteNumber(Required(point, "z"), label + ".z")));
            if (!XYZ.IsWithinLengthLimits(result)) throw new InvalidOperationException(label + " exceeds Revit coordinate limits.");
            return result;
        }
        private static object PointDto(XYZ point) { return new { x = Millimeters(point.X), y = Millimeters(point.Y), z = Millimeters(point.Z) }; }
        private static double Feet(double value) { return UnitUtils.ConvertToInternalUnits(value, UnitTypeId.Millimeters); }
        private static double Millimeters(double value) { return UnitUtils.ConvertFromInternalUnits(value, UnitTypeId.Millimeters); }
        private static double PositiveLength(object value, string label)
        {
            double number = FiniteNumber(value, label);
            if (number <= 0) throw new InvalidOperationException(label + " must be greater than zero.");
            return Feet(number);
        }
        private static BuiltInCategory? CategoryFilter(Dictionary<string, object> args)
        {
            string value = OptionalString(args, "category", "");
            if (value.Length == 0) return null;
            BuiltInCategory category;
            if (!value.StartsWith("OST_", StringComparison.Ordinal) || !Enum.TryParse<BuiltInCategory>(value, false, out category) || !Enum.IsDefined(typeof(BuiltInCategory), category))
                throw new InvalidOperationException("category must be an exact BuiltInCategory name such as OST_PipeCurves, or an empty string.");
            return category;
        }
        private static object Required(Dictionary<string, object> args, string key)
        {
            object value;
            if (!args.TryGetValue(key, out value) || value == null) throw new InvalidOperationException("Missing or null argument: " + key);
            return value;
        }
        private static IList RequiredList(Dictionary<string, object> args, string key, int minimum, int maximum)
        {
            IList value = Required(args, key) as IList;
            if (value == null || value.Count < minimum || value.Count > maximum)
                throw new InvalidOperationException(key + " must contain " + minimum + " to " + maximum + " items.");
            return value;
        }
        private static string OptionalString(Dictionary<string, object> args, string key, string fallback)
        {
            if (!args.ContainsKey(key)) return fallback;
            object value = Required(args, key);
            if (!(value is string)) throw new InvalidOperationException(key + " must be a string.");
            return (string)value;
        }
        private static bool OptionalBoolean(Dictionary<string, object> args, string key, bool fallback)
        {
            if (!args.ContainsKey(key)) return fallback;
            object value = Required(args, key);
            if (!(value is bool)) throw new InvalidOperationException(key + " must be a boolean.");
            return (bool)value;
        }
        private static double OptionalNumber(Dictionary<string, object> args, string key, double fallback) { return args.ContainsKey(key) ? FiniteNumber(Required(args, key), key) : fallback; }
        private static long OptionalInteger(Dictionary<string, object> args, string key, long fallback, long minimum, long maximum)
        { return args.ContainsKey(key) ? Integer(Required(args, key), key, minimum, maximum) : fallback; }
        private static long ElementIdValue(object value, string label) { return Integer(value, label, 1, 9007199254740991L); }
        private static long Integer(object value, string label, long minimum, long maximum)
        {
            double number = FiniteNumber(value, label);
            if (Math.Truncate(number) != number || number < minimum || number > maximum)
                throw new InvalidOperationException(label + " must be an integer in [" + minimum + ", " + maximum + "].");
            return checked((long)number);
        }
        private static double FiniteNumber(object value, string label)
        {
            if (!(value is int || value is long || value is double || value is float || value is decimal || value is short || value is byte))
                throw new InvalidOperationException(label + " must be a JSON number.");
            double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            if (double.IsNaN(number) || double.IsInfinity(number)) throw new InvalidOperationException(label + " must be finite.");
            return number;
        }
        private static void Fields(Dictionary<string, object> args, params string[] allowed)
        {
            foreach (string key in args.Keys) if (!allowed.Contains(key, StringComparer.Ordinal)) throw new InvalidOperationException("Unknown argument: " + key);
        }
        private sealed class RejectErrors : IFailuresPreprocessor
        {
            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                foreach (FailureMessageAccessor failure in accessor.GetFailureMessages())
                    if (failure.GetSeverity() == FailureSeverity.Error) return FailureProcessingResult.ProceedWithRollBack;
                return FailureProcessingResult.Continue;
            }
        }
    }
}
