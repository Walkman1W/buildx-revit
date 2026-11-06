using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    // Explicit, typed Revit operations. All methods are called from ExternalEvent.Execute.
    internal static partial class WorkbenchActions
    {
        internal static readonly string[] ReadOperations = { "get_selection", "search_elements", "list_levels", "list_family_types", "describe_parameters", "capture_model_snapshot", "health", "get_document_info", "list_views", "get_element_parameters", "get_elements_by_type", "get_element_geometry", "get_model_preparation", "get_type_parameters", "get_parameter_value", "list_sheets", "get_sheet_info", "list_titleblocks", "get_categories", "get_worksets", "get_phases", "get_phase_filters", "get_design_options", "list_shared_parameters", "list_project_parameters", "get_warnings", "get_rvt_links", "get_link_instances", "get_pipe_network", "get_revision_sequences", "get_schedule_data", "get_group_members", "calculate_material_quantities", "check_clashes" };
        internal static readonly string[] WriteOperations = { "set_parameters", "set_parameter_value", "set_type_parameter", "move_elements", "copy_elements", "create_wall", "create_pipe", "create_conduit", "create_duct", "create_level", "create_grid", "pin_element", "unpin_element", "create_floor_plan_view", "create_3d_view", "create_sheet", "place_viewport_on_sheet" };
        internal static bool IsRead(string operation) { return ReadOperations.Contains(operation, StringComparer.Ordinal); }
        internal static bool IsWrite(string operation) { return WriteOperations.Contains(operation, StringComparer.Ordinal); }

        internal static object Read(UIApplication uiapp, string operation, Dictionary<string, object> args)
        {
            if (NativeModelQueries.IsRead(operation)) return NativeModelQueries.Read(uiapp, operation, args);
            if (NativeParameterQueries.IsRead(operation)) return NativeParameterQueries.Read(uiapp, operation, args);
            Document doc = uiapp.ActiveUIDocument.Document;
            if (AecPilotQueries.IsRead(operation)) return AecPilotQueries.Read(doc, operation, args);
            if (AecDrawingQueries.IsRead(operation)) return AecDrawingQueries.Read(doc, operation, args);
            if (operation == "get_pipe_network") return SchematicRevitService.ReadPipeNetwork(doc, args);
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
            if (operation == "set_type_parameter") return WriteTypeParameter(uiapp, args);
            Document doc = uiapp.ActiveUIDocument.Document;
            // Each operation owns exactly one transaction. The caller's TransactionGroup
            // decides rollback vs commit; no method saves the document.
            using (var transaction = new Transaction(doc, "Local Codex: " + operation))
            {
                if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Could not start Revit transaction.");
                try
                {
                    object result;
                    BasicCreatedExpectation basicCreated = new BasicCreatedExpectation();
                    bool guardedParameter = operation == "set_parameter_value";
                    var parameterWrites = operation == "set_parameters" || guardedParameter ? new List<ParameterWriteExpectation>() : null;
                    if (parameterWrites != null) result = SetParameters(doc, args, parameterWrites, guardedParameter);
                    else if (operation == "move_elements" || operation == "copy_elements") result = TransformElements(doc, operation, args);
                    else if (operation == "create_wall") result = CreateWall(uiapp, args);
                    else if (operation == "create_pipe") result = CreatePipe(uiapp, args);
                    else if (operation == "create_conduit" || operation == "create_duct" || operation == "create_level" || operation == "create_grid" || operation == "pin_element" || operation == "unpin_element" || operation == "create_floor_plan_view" || operation == "create_3d_view" || operation == "create_sheet" || operation == "place_viewport_on_sheet") result = BasicWrite(uiapp, operation, args, basicCreated);
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
                    if (operation == "pin_element" || operation == "unpin_element") VerifyPinned(doc, args, operation == "pin_element");
                    if (basicCreated.Id != null) result = ReadBasicCreated(doc, operation, args, basicCreated.Id);
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
                    SetParameterValue(parameter, storageType, expected);
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

        private static void SetParameterValue(Parameter parameter, StorageType storage, object value)
        {
            if (storage == StorageType.Double) parameter.Set((double)value);
            else if (storage == StorageType.Integer) parameter.Set((int)value);
            else parameter.Set((string)value);
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

        private sealed class BasicCreatedExpectation { internal ElementId Id; }

        private static object BasicWrite(UIApplication uiapp, string operation, Dictionary<string, object> args, BasicCreatedExpectation created)
        {
            Document doc = uiapp.ActiveUIDocument.Document;
            if (operation == "place_viewport_on_sheet")
            {
                Fields(args, "expected_document", "mode", "sheet_id", "view_id", "x_mm", "y_mm");
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Viewports can only be placed in a project document.");
                ViewSheet sheet = RequiredElement(doc, NativeModelQueries.ExactId(args, "sheet_id")) as ViewSheet;
                View view = RequiredElement(doc, NativeModelQueries.ExactId(args, "view_id")) as View;
                if (sheet == null || !sheet.IsValidObject || sheet.IsPlaceholder) throw new InvalidOperationException("sheet_id must identify a valid non-placeholder sheet.");
                if (view == null || !view.IsValidObject || view.IsTemplate || view is ViewSheet || view is ViewSchedule) throw new InvalidOperationException("view_id must identify a valid viewport-compatible view.");
                double x = FiniteNumber(Required(args, "x_mm"), "x_mm"), y = FiniteNumber(Required(args, "y_mm"), "y_mm");
                if (!Viewport.CanAddViewToSheet(doc, sheet.Id, view.Id)) throw new InvalidOperationException("The view cannot be added to this sheet.");
                Viewport viewport = Viewport.Create(doc, sheet.Id, view.Id, new XYZ(Feet(x), Feet(y), 0));
                created.Id = viewport.Id;
                doc.Regenerate();
                return ReadBasicCreated(doc, operation, args, created.Id);
            }
            if (operation == "create_sheet")
            {
                Fields(args, "expected_document", "mode", "name", "number", "titleblock_id");
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Sheets can only be created in a project document.");
                string name = SheetText(args, "name"), number = SheetText(args, "number");
                ViewSheet sheet;
                if (args.ContainsKey("titleblock_id"))
                {
                    FamilySymbol symbol = RequiredElement(doc, NativeModelQueries.ExactId(args, "titleblock_id")) as FamilySymbol;
                    if (symbol == null || symbol.Category == null || symbol.Category.Id.Value != (long)BuiltInCategory.OST_TitleBlocks)
                        throw new InvalidOperationException("titleblock_id must identify a title block FamilySymbol in the current document.");
                    sheet = ViewSheet.Create(doc, symbol.Id);
                }
                else sheet = ViewSheet.CreatePlaceholder(doc);
                sheet.Name = name;
                sheet.SheetNumber = number;
                created.Id = sheet.Id;
                doc.Regenerate();
                return ReadBasicCreated(doc, operation, args, created.Id);
            }
            if (operation == "create_duct")
            {
                Fields(args, "expected_document", "mode", "duct_type_id", "system_type_id", "level_id", "start_mm", "end_mm");
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Duct can only be created in a project document.");
                DuctType ductType = RequiredElement(doc, NativeModelQueries.ExactId(args, "duct_type_id")) as DuctType;
                MechanicalSystemType systemType = RequiredElement(doc, NativeModelQueries.ExactId(args, "system_type_id")) as MechanicalSystemType;
                Level ductLevel = RequiredElement(doc, NativeModelQueries.ExactId(args, "level_id")) as Level;
                if (ductType == null) throw new InvalidOperationException("duct_type_id must identify a DuctType.");
                if (systemType == null) throw new InvalidOperationException("system_type_id must identify a MechanicalSystemType.");
                if (ductLevel == null) throw new InvalidOperationException("level_id must identify a Level.");
                XYZ ductStart = MillimeterPoint(Required(args, "start_mm"), "start_mm");
                XYZ ductEnd = MillimeterPoint(Required(args, "end_mm"), "end_mm");
                CheckCurveLength(uiapp, ductStart, ductEnd);
                if (ductStart.DistanceTo(ductEnd) < Feet(2.54)) throw new InvalidOperationException("Duct length must be at least 2.54 mm.");
                Duct duct = Duct.Create(doc, systemType.Id, ductType.Id, ductLevel.Id, ductStart, ductEnd);
                created.Id = duct.Id;
                doc.Regenerate();
                return ReadBasicCreated(doc, operation, args, created.Id);
            }
            if (operation == "create_conduit")
            {
                Fields(args, "expected_document", "mode", "conduit_type_id", "level_id", "start_mm", "end_mm", "diameter_mm");
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Conduit can only be created in a project document.");
                ConduitType type = RequiredElement(doc, NativeModelQueries.ExactId(args, "conduit_type_id")) as ConduitType;
                Level level = RequiredElement(doc, NativeModelQueries.ExactId(args, "level_id")) as Level;
                if (type == null) throw new InvalidOperationException("conduit_type_id must identify a ConduitType.");
                if (level == null) throw new InvalidOperationException("level_id must identify a Level.");
                XYZ conduitStart = MillimeterPoint(Required(args, "start_mm"), "start_mm");
                XYZ conduitEnd = MillimeterPoint(Required(args, "end_mm"), "end_mm");
                double diameter = PositiveLength(Required(args, "diameter_mm"), "diameter_mm");
                CheckCurveLength(uiapp, conduitStart, conduitEnd);
                if (conduitStart.DistanceTo(conduitEnd) < Feet(2.54)) throw new InvalidOperationException("Conduit length must be at least 2.54 mm.");
                Conduit conduit = Conduit.Create(doc, type.Id, conduitStart, conduitEnd, level.Id);
                Parameter parameter = conduit.get_Parameter(BuiltInParameter.RBS_CONDUIT_DIAMETER_PARAM);
                if (parameter == null || parameter.StorageType != StorageType.Double || !parameter.HasValue)
                    throw new InvalidOperationException("Created conduit does not have a numeric nominal diameter.");
                double initialDiameter = parameter.AsDouble();
                if (!(initialDiameter > 0 && Math.Abs(initialDiameter - diameter) <= Feet(0.001)))
                {
                    if (parameter.IsReadOnly || !parameter.Set(diameter)) throw new InvalidOperationException("Revit refused the requested conduit diameter.");
                }
                created.Id = conduit.Id;
                doc.Regenerate();
                return ReadBasicCreated(doc, operation, args, created.Id);
            }
            if (operation == "pin_element" || operation == "unpin_element")
            {
                Fields(args, "expected_document", "mode", "element_id");
                Element element = RequiredElement(doc, ElementIdValue(Required(args, "element_id"), "element_id"));
                if (element is ElementType) throw new InvalidOperationException("Element types cannot be pinned.");
                bool before = element.Pinned, desired = operation == "pin_element";
                if (before != desired) element.Pinned = desired;
                doc.Regenerate();
                VerifyPinned(doc, args, desired);
                return new { element_id = DescribedId(element.Id), before_pinned = before, pinned = desired, changed = before != desired };
            }
            if (operation == "create_floor_plan_view" || operation == "create_3d_view")
            {
                bool floor = operation == "create_floor_plan_view";
                if (floor) Fields(args, "expected_document", "mode", "name", "view_family_type_id", "level_id");
                else Fields(args, "expected_document", "mode", "name", "view_family_type_id");
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Views can only be created in a project document.");
                string name = Required(args, "name") as string;
                if (String.IsNullOrWhiteSpace(name) || name != name.Trim() || name.Length > 255)
                    throw new InvalidOperationException("name must be nonblank, at most 255 characters, and have no leading or trailing whitespace.");
                ViewFamilyType type = RequiredElement(doc, NativeModelQueries.ExactId(args, "view_family_type_id")) as ViewFamilyType;
                if (type == null) throw new InvalidOperationException("view_family_type_id must identify a ViewFamilyType.");
                ViewFamily expectedFamily = floor ? ViewFamily.FloorPlan : ViewFamily.ThreeDimensional;
                if (type.ViewFamily != expectedFamily) throw new InvalidOperationException("view_family_type_id has the wrong view family.");
                View view;
                if (floor)
                {
                    Level level = RequiredElement(doc, NativeModelQueries.ExactId(args, "level_id")) as Level;
                    if (level == null) throw new InvalidOperationException("level_id must identify a Level.");
                    view = ViewPlan.Create(doc, type.Id, level.Id);
                }
                else view = View3D.CreateIsometric(doc, type.Id);
                view.Name = name;
                created.Id = view.Id;
                doc.Regenerate();
                return ReadBasicCreated(doc, operation, args, created.Id);
            }
            if (operation == "create_level")
            {
                Fields(args, "expected_document", "mode", "name", "elevation_mm");
                string name = OptionalString(args, "name", "");
                if (String.IsNullOrWhiteSpace(name)) throw new InvalidOperationException("name is required.");
                double elevation = Feet(FiniteNumber(Required(args, "elevation_mm"), "elevation_mm"));
                Level level = Level.Create(doc, elevation);
                level.Name = name;
                created.Id = level.Id;
                doc.Regenerate();
                return ReadBasicCreated(doc, operation, args, created.Id);
            }
            Fields(args, "expected_document", "mode", "name", "start_mm", "end_mm");
            string gridName = OptionalString(args, "name", "");
            if (String.IsNullOrWhiteSpace(gridName)) throw new InvalidOperationException("name is required.");
            XYZ start = MillimeterPoint(Required(args, "start_mm"), "start_mm");
            XYZ end = MillimeterPoint(Required(args, "end_mm"), "end_mm");
            if (Math.Abs(start.Z - end.Z) > Feet(0.001)) throw new InvalidOperationException("Grid line must be horizontal.");
            CheckCurveLength(uiapp, start, end);
            Grid grid = Grid.Create(doc, Line.CreateBound(start, end));
            grid.Name = gridName;
            created.Id = grid.Id;
            doc.Regenerate();
            return ReadBasicCreated(doc, operation, args, created.Id);
        }

        private static object ReadBasicCreated(Document doc, string operation, Dictionary<string, object> args, ElementId id)
        {
            Element element = doc.GetElement(id);
            if (operation == "place_viewport_on_sheet")
            {
                Viewport viewport = element as Viewport;
                long sheetId = NativeModelQueries.ExactId(args, "sheet_id"), viewId = NativeModelQueries.ExactId(args, "view_id");
                if (viewport == null || !viewport.IsValidObject || viewport.SheetId.Value != sheetId || viewport.ViewId.Value != viewId)
                    throw new InvalidOperationException("Created viewport identity changed.");
                XYZ center = viewport.GetBoxCenter();
                double x = Millimeters(center.X), y = Millimeters(center.Y);
                double dx = x - FiniteNumber(Required(args, "x_mm"), "x_mm"), dy = y - FiniteNumber(Required(args, "y_mm"), "y_mm");
                if (Double.IsNaN(x) || Double.IsInfinity(x) || Double.IsNaN(y) || Double.IsInfinity(y) || Math.Sqrt(dx * dx + dy * dy) > 0.001)
                    throw new InvalidOperationException("Created viewport center changed.");
                return new { element_id = DescribedId(viewport.Id), sheet_id = DescribedId(viewport.SheetId), view_id = DescribedId(viewport.ViewId), x_mm = x, y_mm = y };
            }
            if (operation == "create_sheet")
            {
                ViewSheet sheet = element as ViewSheet;
                bool placeholder = !args.ContainsKey("titleblock_id");
                if (sheet == null || !sheet.IsValidObject || !String.Equals(sheet.Name, SheetText(args, "name"), StringComparison.Ordinal)
                    || !String.Equals(sheet.SheetNumber, SheetText(args, "number"), StringComparison.Ordinal) || sheet.IsPlaceholder != placeholder)
                    throw new InvalidOperationException("Created sheet identity, name, number or placeholder state changed.");
                ElementId typeId = null;
                using (var collector = new FilteredElementCollector(doc).OwnedByView(sheet.Id).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsNotElementType())
                {
                    var titleblocks = collector.ToElements();
                    if (placeholder && titleblocks.Count != 0) throw new InvalidOperationException("Placeholder sheet unexpectedly owns a title block.");
                    if (!placeholder)
                    {
                        long expectedId = NativeModelQueries.ExactId(args, "titleblock_id");
                        if (titleblocks.Count != 1 || titleblocks[0].GetTypeId() == null || titleblocks[0].GetTypeId().Value != expectedId)
                            throw new InvalidOperationException("Created sheet title block count or type changed.");
                        typeId = titleblocks[0].GetTypeId();
                    }
                }
                return new { element_id = DescribedId(sheet.Id), name = sheet.Name, number = sheet.SheetNumber, is_placeholder = sheet.IsPlaceholder, titleblock_id = DescribedId(typeId) };
            }
            if (operation == "create_duct")
            {
                Duct duct = element as Duct;
                long typeId = NativeModelQueries.ExactId(args, "duct_type_id"), systemId = NativeModelQueries.ExactId(args, "system_type_id"), levelId = NativeModelQueries.ExactId(args, "level_id");
                if (duct == null || !duct.IsValidObject || duct.GetTypeId().Value != typeId || duct.ReferenceLevel == null || duct.ReferenceLevel.Id.Value != levelId)
                    throw new InvalidOperationException("Created duct identity, type or reference level changed.");
                Parameter systemParameter = duct.get_Parameter(BuiltInParameter.RBS_DUCT_SYSTEM_TYPE_PARAM);
                if (systemParameter == null || systemParameter.StorageType != StorageType.ElementId || !systemParameter.HasValue || systemParameter.AsElementId() == null || systemParameter.AsElementId().Value != systemId)
                    throw new InvalidOperationException("Created duct system type changed.");
                LocationCurve ductLocation = duct.Location as LocationCurve;
                Line ductLine = ductLocation == null ? null : ductLocation.Curve as Line;
                if (ductLine == null || !ductLine.IsBound) throw new InvalidOperationException("Created duct is not a straight bounded line.");
                XYZ requestedStart = MillimeterPoint(Required(args, "start_mm"), "start_mm"), requestedEnd = MillimeterPoint(Required(args, "end_mm"), "end_mm");
                XYZ actualStart = ductLine.GetEndPoint(0), actualEnd = ductLine.GetEndPoint(1);
                bool forward = actualStart.DistanceTo(requestedStart) <= Feet(0.001) && actualEnd.DistanceTo(requestedEnd) <= Feet(0.001);
                bool reverse = actualEnd.DistanceTo(requestedStart) <= Feet(0.001) && actualStart.DistanceTo(requestedEnd) <= Feet(0.001);
                if (!forward && !reverse) throw new InvalidOperationException("Created duct endpoints changed.");
                return new { element_id = DescribedId(duct.Id), duct_type_id = DescribedId(duct.GetTypeId()), system_type_id = DescribedId(systemParameter.AsElementId()), level_id = DescribedId(duct.ReferenceLevel.Id),
                    start_mm = PointDto(forward ? actualStart : actualEnd), end_mm = PointDto(forward ? actualEnd : actualStart) };
            }
            if (operation == "create_conduit")
            {
                Conduit conduit = element as Conduit;
                long typeId = NativeModelQueries.ExactId(args, "conduit_type_id"), levelId = NativeModelQueries.ExactId(args, "level_id");
                if (conduit == null || !conduit.IsValidObject || conduit.GetTypeId().Value != typeId || conduit.ReferenceLevel == null || conduit.ReferenceLevel.Id.Value != levelId)
                    throw new InvalidOperationException("Created conduit identity, type or reference level changed.");
                LocationCurve location = conduit.Location as LocationCurve;
                Line line = location == null ? null : location.Curve as Line;
                if (line == null || !line.IsBound) throw new InvalidOperationException("Created conduit is not a straight bounded line.");
                XYZ start = MillimeterPoint(Required(args, "start_mm"), "start_mm"), end = MillimeterPoint(Required(args, "end_mm"), "end_mm");
                XYZ actualStart = line.GetEndPoint(0), actualEnd = line.GetEndPoint(1);
                bool forward = actualStart.DistanceTo(start) <= Feet(0.001) && actualEnd.DistanceTo(end) <= Feet(0.001);
                bool reverse = actualEnd.DistanceTo(start) <= Feet(0.001) && actualStart.DistanceTo(end) <= Feet(0.001);
                if (!forward && !reverse) throw new InvalidOperationException("Created conduit endpoints changed.");
                Parameter parameter = conduit.get_Parameter(BuiltInParameter.RBS_CONDUIT_DIAMETER_PARAM);
                if (parameter == null || parameter.StorageType != StorageType.Double || !parameter.HasValue)
                    throw new InvalidOperationException("Created conduit does not have a numeric nominal diameter.");
                double actualDiameter = parameter.AsDouble();
                if (!(actualDiameter > 0 && Math.Abs(actualDiameter - PositiveLength(Required(args, "diameter_mm"), "diameter_mm")) <= Feet(0.001)))
                    throw new InvalidOperationException("Created conduit nominal diameter changed.");
                return new { element_id = DescribedId(conduit.Id), conduit_type_id = DescribedId(conduit.GetTypeId()), level_id = DescribedId(conduit.ReferenceLevel.Id),
                    start_mm = PointDto(forward ? actualStart : actualEnd), end_mm = PointDto(forward ? actualEnd : actualStart), diameter_mm = Millimeters(actualDiameter) };
            }
            if (element == null || element.Name != OptionalString(args, "name", "")) throw new InvalidOperationException("Created element name or identity changed.");
            if (operation == "create_floor_plan_view" || operation == "create_3d_view")
            {
                bool floor = operation == "create_floor_plan_view";
                View view = element as View;
                long typeId = NativeModelQueries.ExactId(args, "view_family_type_id");
                if (view == null || view.IsTemplate || view.GetTypeId().Value != typeId)
                    throw new InvalidOperationException("Created view type or template state changed.");
                if (floor)
                {
                    ViewPlan plan = view as ViewPlan;
                    long levelId = NativeModelQueries.ExactId(args, "level_id");
                    if (plan == null || plan.ViewType != ViewType.FloorPlan || plan.GenLevel == null || plan.GenLevel.Id.Value != levelId)
                        throw new InvalidOperationException("Created floor plan view kind or level changed.");
                    return new { element_id = DescribedId(plan.Id), name = plan.Name, view_family_type_id = DescribedId(plan.GetTypeId()), view_kind = "floor_plan", level_id = DescribedId(plan.GenLevel.Id) };
                }
                View3D view3d = view as View3D;
                if (view3d == null || view3d.ViewType != ViewType.ThreeD || view3d.IsPerspective)
                    throw new InvalidOperationException("Created 3D view is not isometric.");
                return new { element_id = DescribedId(view3d.Id), name = view3d.Name, view_family_type_id = DescribedId(view3d.GetTypeId()), view_kind = "isometric_3d" };
            }
            if (operation == "create_level")
            {
                Level level = element as Level;
                if (level == null || Math.Abs(level.ProjectElevation - Feet(FiniteNumber(Required(args, "elevation_mm"), "elevation_mm"))) > Feet(0.001)) throw new InvalidOperationException("Created level project elevation changed.");
                return new { element_id = DescribedId(level.Id), name = level.Name, elevation_mm = Millimeters(level.ProjectElevation) };
            }
            else
            {
                Grid grid = element as Grid;
                Line line = grid == null ? null : grid.Curve as Line;
                XYZ start = MillimeterPoint(Required(args, "start_mm"), "start_mm"), end = MillimeterPoint(Required(args, "end_mm"), "end_mm");
                if (line == null) throw new InvalidOperationException("Created grid is not a straight line.");
                XYZ actualStart = line.GetEndPoint(0), actualEnd = line.GetEndPoint(1);
                bool forward = actualStart.DistanceTo(start) <= Feet(0.001) && actualEnd.DistanceTo(end) <= Feet(0.001);
                bool reverse = actualEnd.DistanceTo(start) <= Feet(0.001) && actualStart.DistanceTo(end) <= Feet(0.001);
                if (!forward && !reverse) throw new InvalidOperationException("Created grid endpoints changed.");
                return new { element_id = DescribedId(grid.Id), name = grid.Name,
                    start_mm = PointDto(forward ? actualStart : actualEnd), end_mm = PointDto(forward ? actualEnd : actualStart) };
            }
        }

        private static string SheetText(Dictionary<string, object> args, string key)
        {
            string value = Required(args, key) as string;
            if (String.IsNullOrWhiteSpace(value) || value.Length > 255 || !String.Equals(value, value.Trim(), StringComparison.Ordinal)
                || value[0] == '\ufeff' || value[value.Length - 1] == '\ufeff'
                || value.Any(c => c <= '\u001f' || (c >= '\u007f' && c <= '\u009f')))
                throw new InvalidOperationException(key + " must be nonblank, at most 255 UTF-16 units, without surrounding whitespace or control characters.");
            return value;
        }

        private static void VerifyPinned(Document doc, Dictionary<string, object> args, bool desired)
        {
            Element element = RequiredElement(doc, ElementIdValue(Required(args, "element_id"), "element_id"));
            if (element.Pinned != desired) throw new InvalidOperationException("Pinned state did not match the requested state.");
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
