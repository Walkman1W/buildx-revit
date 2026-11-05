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
        internal static readonly string[] ReadOperations = { "get_selection", "search_elements", "list_levels", "list_family_types", "describe_parameters", "capture_model_snapshot", "health", "get_document_info", "list_views", "get_element_parameters", "get_elements_by_type", "get_element_geometry", "get_type_parameters", "get_parameter_value" };
        internal static readonly string[] WriteOperations = { "set_parameters", "set_parameter_value", "move_elements", "copy_elements", "create_wall", "create_pipe" };
        internal static bool IsRead(string operation) { return ReadOperations.Contains(operation, StringComparer.Ordinal); }
        internal static bool IsWrite(string operation) { return WriteOperations.Contains(operation, StringComparer.Ordinal); }

        internal static object Read(UIApplication uiapp, string operation, Dictionary<string, object> args)
        {
            if (NativeModelQueries.IsRead(operation)) return NativeModelQueries.Read(uiapp, operation, args);
            if (NativeParameterQueries.IsRead(operation)) return NativeParameterQueries.Read(uiapp, operation, args);
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
                    bool guardedParameter = operation == "set_parameter_value";
                    var parameterWrites = operation == "set_parameters" || guardedParameter ? new List<ParameterWriteExpectation>() : null;
                    if (parameterWrites != null) result = SetParameters(doc, args, parameterWrites, guardedParameter);
                    else if (operation == "move_elements" || operation == "copy_elements") result = TransformElements(doc, operation, args);
                    else if (operation == "create_wall") result = CreateWall(uiapp, args);
                    else if (operation == "create_pipe") result = CreatePipe(uiapp, args);
                    else throw new InvalidOperationException("Unknown write operation.");
                    transaction.SetFailureHandlingOptions(transaction.GetFailureHandlingOptions()
                        .SetFailuresPreprocessor(new RejectErrors()).SetClearAfterRollback(true));
                    if (parameterWrites != null)
                    {
                        doc.Regenerate();
                        VerifyParameterWrites(doc, parameterWrites);
                    }
                    TransactionStatus completion = transaction.Commit();
                    if (completion != TransactionStatus.Committed) throw new InvalidOperationException("Revit did not commit the operation; transaction status: " + completion + ".");
                    // Commit regenerates again and can run updaters. The host's
                    // outer group is still open, so a changed value must throw
                    // before that group can assimilate or publish success.
                    if (parameterWrites != null) VerifyParameterWrites(doc, parameterWrites);
                    return result;
                }
                catch { if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack(); throw; }
            }
        }

        private static object SetParameters(Document doc, Dictionary<string, object> args, List<ParameterWriteExpectation> expectations = null, bool guarded = false)
        {
            Fields(args, "expected_document", "mode", "changes");
            IList changes = RequiredList(args, "changes", 1, guarded ? 1 : 50);
            ParameterWriteTarget[] targets = PreflightParameterTargets(doc, changes, guarded);
            var results = new List<object>();
            object guardedBefore = null;
            foreach (ParameterWriteTarget target in targets)
            {
                Dictionary<string, object> change = target.CopyChange();
                long elementId = target.ElementId, parameterId = target.ParameterId;
                Element element;
                Parameter parameter = ResolveInstanceParameter(doc, elementId, parameterId, out element);
                object value = Required(change, "value");
                string unit = OptionalString(change, "value_unit", "");
                if (change.ContainsKey("value_unit") && unit != "internal") throw new InvalidOperationException("value_unit, when provided, must equal internal.");
                object before = InternalValue(parameter);
                StorageType storageType = parameter.StorageType;
                string guardedDataType = null;
                if (guarded) guardedBefore = ValidateParameterBefore(parameter, change, before, out guardedDataType);
                if (storageType == StorageType.Double && unit != "internal") throw new InvalidOperationException("Double parameters require value_unit=internal for each change.");
                object expected = NormalizeParameterValue(parameter, value, "value", true);
                bool changed = !object.Equals(before, expected);
                if (changed)
                {
                    // Set's Boolean reports whether Revit changed a value; it
                    // does not establish that the requested value was retained.
                    if (storageType == StorageType.Double) parameter.Set((double)expected);
                    else if (storageType == StorageType.Integer) parameter.Set((int)expected);
                    else parameter.Set((string)expected);
                }
                // Set can replace API wrappers or change another target's owner.
                // Do not verify a cached Parameter that is no longer selected.
                parameter = ResolveInstanceParameter(doc, elementId, parameterId, out element, false);
                object after = VerifyParameterValue(parameter, storageType, expected);
                if (guarded) VerifyInstanceMetadata(element, parameter, guardedDataType);
                if (expectations != null) expectations.Add(new ParameterWriteExpectation(elementId, parameterId, storageType, expected, guarded, guardedDataType));
                results.Add(new { element_id = guarded ? (object)NativeModelQueries.SignedId(element.Id) : elementId,
                    parameter_id = guarded ? (object)NativeModelQueries.SignedId(parameter.Id) : parameterId, storage_type = storageType.ToString(),
                    data_type = guarded ? guardedDataType : parameter.Definition.GetDataType().TypeId, changed, before_internal = before, after_internal = after });
            }
            object batch = new { updated_count = results.Count, changes = results.ToArray() };
            if (guarded) return new { schema_version = 1, target_kind = "instance", before = guardedBefore, result = batch };
            return batch;
        }

        private sealed class ParameterWriteTarget
        {
            internal readonly long ElementId, ParameterId;
            private readonly Dictionary<string, object> change;
            internal ParameterWriteTarget(long elementId, long parameterId, Dictionary<string, object> source)
            {
                ElementId = elementId; ParameterId = parameterId;
                change = new Dictionary<string, object>(source, StringComparer.Ordinal);
                object raw;
                if (change.TryGetValue("expected_state", out raw) && raw is Dictionary<string, object>)
                    change["expected_state"] = new Dictionary<string, object>((Dictionary<string, object>)raw, StringComparer.Ordinal);
            }
            internal Dictionary<string, object> CopyChange() { return new Dictionary<string, object>(change, StringComparer.Ordinal); }
        }

        private static ParameterWriteTarget[] PreflightParameterTargets(Document doc, IList changes, bool guarded)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var targets = new List<ParameterWriteTarget>();
            foreach (object item in changes)
            {
                var change = item as Dictionary<string, object>;
                if (change == null) throw new InvalidOperationException("Each change must be an object.");
                if (guarded) Fields(change, "element_id", "parameter_id", "value", "value_unit", "expected_state");
                else Fields(change, "element_id", "parameter_id", "value", "value_unit");
                long elementId = guarded ? NativeModelQueries.ExactId(change, "element_id") : ElementIdValue(Required(change, "element_id"), "element_id");
                long parameterId = guarded ? NativeModelQueries.ExactSignedId(change, "parameter_id") : Integer(Required(change, "parameter_id"), "parameter_id", -9007199254740991L, 9007199254740991L);
                if (parameterId == 0 || parameterId == -1) throw new InvalidOperationException("parameter_id must identify an actual parameter, not 0 or -1.");
                if (!seen.Add(elementId.ToString(CultureInfo.InvariantCulture) + ":" + parameterId.ToString(CultureInfo.InvariantCulture)))
                    throw new InvalidOperationException("Duplicate element_id/parameter_id pair in changes.");
                Element element;
                ResolveInstanceParameter(doc, elementId, parameterId, out element);
                // Retain only request data, never live Revit objects. Every target
                // is resolved again before its value is examined or Set is called.
                targets.Add(new ParameterWriteTarget(elementId, parameterId, change));
            }
            return targets.ToArray();
        }

        private static Parameter ResolveInstanceParameter(Document doc, long elementId, long parameterId, out Element element, bool requireWritable = true)
        {
            element = RequiredElement(doc, elementId);
            if (element is ElementType || element.Id == null || element.Id.Value != elementId || element.Document == null || !element.Document.Equals(doc))
                throw new InvalidOperationException("Parameter writes require the explicitly selected current-document instance, not an ElementType.");
            Parameter selected = null;
            foreach (Parameter candidate in element.Parameters)
            {
                if (candidate == null || candidate.Id == null) throw new InvalidOperationException("Parameter identity is unavailable on the selected instance.");
                if (candidate.Id.Value != parameterId) continue;
                if (selected != null) throw new InvalidOperationException("Duplicate parameter identity on the selected instance.");
                selected = candidate;
            }
            if (selected == null) throw new InvalidOperationException("Parameter id " + parameterId + " does not belong to element " + elementId + ".");
            RequireInstanceParameter(element, selected);
            if (requireWritable && selected.IsReadOnly) throw new InvalidOperationException("Parameter is read-only: " + parameterId);
            return selected;
        }

        private static object NormalizeParameterValue(Parameter parameter, object value, string label, bool enforceYesNo)
        {
            if (parameter.StorageType == StorageType.Double) return FiniteNumber(value, label);
            if (parameter.StorageType == StorageType.Integer)
            {
                int number = (int)Integer(value, label, int.MinValue, int.MaxValue);
                if (enforceYesNo && parameter.Definition.GetDataType() == SpecTypeId.Boolean.YesNo && number != 0 && number != 1)
                    throw new InvalidOperationException("Yes/No parameters require integer 0 or 1.");
                return number;
            }
            if (parameter.StorageType == StorageType.String)
            {
                if (!(value is string)) throw new InvalidOperationException("String parameter value must be a string, not a converted number or null.");
                return (string)value;
            }
            throw new InvalidOperationException("Only Double, Integer and String parameters can be written; ElementId parameters are not supported.");
        }

        private static string ParameterDataType(Parameter parameter)
        {
            ForgeTypeId dataType = parameter.Definition.GetDataType();
            return dataType == null ? null : dataType.TypeId;
        }

        private static object ValidateParameterBefore(Parameter parameter, Dictionary<string, object> change, object before, out string dataType)
        {
            var state = Required(change, "expected_state") as Dictionary<string, object>;
            if (state == null) throw new InvalidOperationException("expected_state must be an object.");
            Fields(state, "storage_type", "has_value", "value_internal", "data_type");
            object storage = Required(state, "storage_type"), hasValue = Required(state, "has_value"), raw, data;
            if (!(storage is string) || ((string)storage != "Double" && (string)storage != "Integer" && (string)storage != "String") || !(hasValue is bool) ||
                !state.TryGetValue("value_internal", out raw) || !state.TryGetValue("data_type", out data) || data != null && !(data is string))
                throw new InvalidOperationException("expected_state must contain exact storage_type, has_value, value_internal and data_type facts.");
            dataType = ParameterDataType(parameter);
            if ((string)storage != parameter.StorageType.ToString() || (bool)hasValue != parameter.HasValue || !string.Equals((string)data, dataType, StringComparison.Ordinal))
                throw new InvalidOperationException("Parameter state changed since the approved read.");
            object expectedBefore = raw == null ? null : NormalizeParameterValue(parameter, raw, "expected_state.value_internal", false);
            if (!object.Equals(before, expectedBefore)) throw new InvalidOperationException("Parameter state changed since the approved read.");
            return new { storage_type = parameter.StorageType.ToString(), has_value = parameter.HasValue, value_internal = before, data_type = dataType };
        }

        private static void RequireInstanceParameter(Element source, Parameter parameter)
        {
            Element owner = parameter.Element;
            if (source is ElementType || owner == null || owner is ElementType || !owner.IsValidObject || owner.Id == null || source.Id == null ||
                owner.Id.Value != source.Id.Value || owner.Document == null || !owner.Document.Equals(source.Document))
                throw new InvalidOperationException("Parameter is not owned by the explicitly selected instance.");
        }

        private static void VerifyInstanceMetadata(Element source, Parameter parameter, string dataType)
        {
            RequireInstanceParameter(source, parameter);
            if (!string.Equals(ParameterDataType(parameter), dataType, StringComparison.Ordinal))
                throw new InvalidOperationException("Parameter data_type changed during the operation.");
        }

        private sealed class ParameterWriteExpectation
        {
            internal readonly long ElementId;
            internal readonly long ParameterId;
            internal readonly StorageType StorageType;
            internal readonly object Value;
            internal readonly bool Guarded;
            internal readonly string DataType;
            internal ParameterWriteExpectation(long elementId, long parameterId, StorageType storageType, object value, bool guarded = false, string dataType = null)
            { ElementId = elementId; ParameterId = parameterId; StorageType = storageType; Value = value; Guarded = guarded; DataType = dataType; }
        }

        private static object VerifyParameterValue(Parameter parameter, StorageType storageType, object expected)
        {
            if (parameter.StorageType != storageType || !parameter.HasValue)
                throw new InvalidOperationException("Revit did not retain the requested " + storageType + " parameter value.");
            object actual = InternalValue(parameter);
            if (!object.Equals(actual, expected))
                throw new InvalidOperationException("Revit did not retain the requested " + storageType + " parameter value.");
            return actual;
        }

        private static void VerifyParameterWrites(Document doc, List<ParameterWriteExpectation> expectations)
        {
            foreach (ParameterWriteExpectation expected in expectations)
            {
                Element element;
                Parameter parameter = ResolveInstanceParameter(doc, expected.ElementId, expected.ParameterId, out element, false);
                if (expected.Guarded) VerifyInstanceMetadata(element, parameter, expected.DataType);
                VerifyParameterValue(parameter, expected.StorageType, expected.Value);
            }
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

        private static object DescribedId(ElementId id)
        {
            if (id == null) return null;
            return id.Value > 9007199254740991L || id.Value < -9007199254740991L ? (object)NativeModelQueries.SignedId(id) : id.Value;
        }

        private static object DescribeElement(Element element)
        {
            ElementType type = element as ElementType;
            return new { element_id = DescribedId(element.Id), name = element.Name, class_name = element.GetType().Name,
                category = element.Category == null ? null : element.Category.Name,
                category_id = element.Category == null ? null : DescribedId(element.Category.Id),
                type_id = DescribedId(element.GetTypeId()), level_id = DescribedId(element.LevelId),
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
