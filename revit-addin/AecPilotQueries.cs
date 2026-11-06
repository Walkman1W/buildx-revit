using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    // Adapted from AEC Model Bridge v1.0.2 (MIT), BridgeCommandFactory.cs.
    // Copyright (c) 2025-2026 AEC Model Bridge Contributors. See THIRD-PARTY-NOTICES.md.
    internal static class AecPilotQueries
    {
        internal static readonly string[] Operations = {
            "list_sheets", "get_sheet_info", "list_titleblocks", "get_categories", "get_worksets",
            "get_phases", "get_phase_filters", "get_design_options", "list_shared_parameters", "list_project_parameters",
            "get_warnings", "get_rvt_links", "get_link_instances", "get_group_members", "calculate_material_quantities", "check_clashes"
        };
        private const int MaximumWarningElementIds = 200;
        private const int MaximumWarningDescriptionLength = 8192;

        internal static bool IsRead(string operation) { return Operations.Contains(operation, StringComparer.Ordinal); }

        internal static object Read(Document doc, string operation, Dictionary<string, object> args)
        {
            var budget = new NativeModelQueries.ReadBudget();
            if (operation == "get_group_members") return GroupMembers(doc, args, budget);
            if (operation == "calculate_material_quantities") return MaterialQuantities(doc, args, budget);
            if (operation == "check_clashes") return CheckClashes(doc, args, budget);
            if (operation == "get_sheet_info")
            {
                NativeModelQueries.Fields(args, "expected_document", "sheet_id");
                return SheetInfo(doc, NativeModelQueries.ExactId(args, "sheet_id"), budget);
            }

            NativeModelQueries.Fields(args, "expected_document", "offset", "limit");
            int offset = NativeModelQueries.Page(args, "offset", 0, 0, int.MaxValue);
            int limit = NativeModelQueries.Page(args, "limit", 100, 1, 200);
            switch (operation)
            {
                case "list_sheets":
                    return Elements<ViewSheet>(doc, sheet => new {
                        id = Id(sheet.Id), sheet_number = sheet.SheetNumber, sheet_name = sheet.Name,
                        is_placeholder = sheet.IsPlaceholder, viewport_count = sheet.GetAllViewports().Count
                    }, offset, limit, budget, sortName: sheet => sheet.SheetNumber);
                case "list_titleblocks":
                    return Elements<FamilySymbol>(doc, symbol => new {
                        id = Id(symbol.Id), family_name = symbol.Family.Name, type_name = symbol.Name,
                        full_name = symbol.Family.Name + ": " + symbol.Name
                    }, offset, limit, budget, BuiltInCategory.OST_TitleBlocks);
                case "get_categories":
                    return Page(doc.Settings.Categories.Cast<Category>(), category => category.Id.Value, CategoryRow,
                        offset, limit, budget, include: category => category.CategoryType == CategoryType.Model && category.CanAddSubcategory);
                case "get_worksets":
                    return Worksets(doc, offset, limit, budget);
                case "get_phases":
                    return Page(doc.Phases.Cast<Phase>(), phase => phase.Id.Value, NameRow, offset, limit, budget);
                case "get_phase_filters":
                    return Elements<PhaseFilter>(doc, NameRow, offset, limit, budget);
                case "get_design_options":
                    return Elements<DesignOption>(doc, DesignOptionRow, offset, limit, budget);
                case "list_shared_parameters":
                    return Elements<SharedParameterElement>(doc, parameter => new {
                        id = Id(parameter.Id), name = parameter.Name, guid = parameter.GuidValue.ToString(),
                        definition_group = DefinitionType(parameter.GetDefinition(), true)
                    }, offset, limit, budget);
                case "list_project_parameters":
                    return Elements<ParameterElement>(doc, parameter => new {
                        id = Id(parameter.Id), name = parameter.Name, parameter_type = DefinitionType(parameter.GetDefinition(), false)
                    }, offset, limit, budget);
                case "get_warnings":
                    return Warnings(doc, offset, limit, budget);
                case "get_rvt_links":
                    return Elements<RevitLinkType>(doc, link => new {
                        id = ExactPositiveId(link.Id), name = link.Name,
                        is_loaded = RevitLinkType.IsLoaded(doc, link.Id), is_nested = link.IsNestedLink
                    }, offset, limit, budget);
                case "get_link_instances":
                    return Elements<RevitLinkInstance>(doc, link => LinkInstanceRow(doc, link), offset, limit, budget);
                default: throw new InvalidOperationException("Unknown AEC pilot query.");
            }
        }

        private sealed class ClashElement
        {
            internal long Id;
            internal BoundingBoxXYZ Box;
        }

        private static List<ClashElement> ClashElements(Document doc, BuiltInCategory category, NativeModelQueries.ReadBudget budget, out int missing)
        {
            var rows = new List<ClashElement>();
            missing = 0;
            using (var collector = new FilteredElementCollector(doc).OfCategory(category).WhereElementIsNotElementType())
            foreach (Element element in collector)
            {
                budget.Scan();
                long id = PositiveIdValue(element.Id);
                BoundingBoxXYZ box = element.get_BoundingBox(null);
                if (box == null) { missing++; continue; }
                if (box.Min == null || box.Max == null || !ValidCoordinate(box.Min.X) || !ValidCoordinate(box.Min.Y) || !ValidCoordinate(box.Min.Z) ||
                    !ValidCoordinate(box.Max.X) || !ValidCoordinate(box.Max.Y) || !ValidCoordinate(box.Max.Z) ||
                    box.Min.X > box.Max.X || box.Min.Y > box.Max.Y || box.Min.Z > box.Max.Z)
                    throw new InvalidOperationException("Invalid bounding box; no partial clash candidates published.");
                rows.Add(new ClashElement { Id = id, Box = box });
            }
            rows.Sort((a, b) => a.Id.CompareTo(b.Id));
            for (int i = 1; i < rows.Count; i++) if (rows[i-1].Id == rows[i].Id) throw new InvalidOperationException("Duplicate element ID.");
            return rows;
        }

        private static bool ValidCoordinate(double x) { return !Double.IsNaN(x) && !Double.IsInfinity(x); }

        private static object CheckClashes(Document doc, Dictionary<string, object> args, NativeModelQueries.ReadBudget budget)
        {
            NativeModelQueries.Fields(args, "expected_document", "category1", "category2", "tolerance_feet", "offset", "limit");
            object c1, c2;
            if (!args.TryGetValue("category1", out c1) || !args.TryGetValue("category2", out c2)) throw new InvalidOperationException("Both categories are required.");
            BuiltInCategory? cat1 = NativeModelQueries.Category(new Dictionary<string, object> { { "category", c1 } });
            BuiltInCategory? cat2 = NativeModelQueries.Category(new Dictionary<string, object> { { "category", c2 } });
            if (!cat1.HasValue || !cat2.HasValue) throw new InvalidOperationException("Both categories are required.");
            double tolerance = 0.01;
            object raw;
            if (args.TryGetValue("tolerance_feet", out raw))
            {
                if (!(raw is int || raw is long || raw is double || raw is float || raw is decimal)) throw new InvalidOperationException("Invalid tolerance.");
                tolerance = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
            }
            if (!ValidCoordinate(tolerance) || tolerance < 0 || tolerance > 10) throw new InvalidOperationException("Tolerance must be between 0 and 10 feet.");
            int offset = NativeModelQueries.Page(args, "offset", 0, 0, int.MaxValue);
            int limit = NativeModelQueries.Page(args, "limit", 100, 1, 200);
            int missing1, missing2 = 0;
            var first = ClashElements(doc, cat1.Value, budget, out missing1);
            bool same = cat1.Value == cat2.Value;
            var second = same ? first : ClashElements(doc, cat2.Value, budget, out missing2);
            if (same) missing2 = missing1;
            long pairCount = same ? (long)first.Count * (first.Count - 1) / 2 : (long)first.Count * second.Count;
            if (pairCount > 50000) throw new InvalidOperationException("Clash pair budget exceeded; no partial candidates published.");
            var matches = new List<object>();
            for (int i = 0; i < first.Count; i++)
            for (int j = same ? i + 1 : 0; j < second.Count; j++)
            {
                var a = first[i]; var b = second[j];
                if (a.Id == b.Id) continue;
                budget.Scan();
                if (!ValidCoordinate(a.Box.Max.X + tolerance) || !ValidCoordinate(a.Box.Max.Y + tolerance) || !ValidCoordinate(a.Box.Max.Z + tolerance) ||
                    !ValidCoordinate(a.Box.Min.X - tolerance) || !ValidCoordinate(a.Box.Min.Y - tolerance) || !ValidCoordinate(a.Box.Min.Z - tolerance))
                    throw new InvalidOperationException("Expanded bounding box is invalid.");
                if (!(a.Box.Max.X + tolerance < b.Box.Min.X || a.Box.Min.X - tolerance > b.Box.Max.X ||
                      a.Box.Max.Y + tolerance < b.Box.Min.Y || a.Box.Min.Y - tolerance > b.Box.Max.Y ||
                      a.Box.Max.Z + tolerance < b.Box.Min.Z || a.Box.Min.Z - tolerance > b.Box.Max.Z))
                    matches.Add(new { element1_id = ExactIdText(a.Id), element2_id = ExactIdText(b.Id) });
            }
            var result = (Dictionary<string, object>)PageResult(matches, row => row, matches.Count, offset, limit, budget);
            result.Add("category1", cat1.Value.ToString()); result.Add("category2", cat2.Value.ToString());
            result.Add("tolerance_feet", tolerance); result.Add("method", "expanded_axis_aligned_bounding_box");
            result.Add("solid_intersection_tested", false);
            result.Add("element_count1", first.Count + missing1); result.Add("element_count2", second.Count + missing2);
            result.Add("missing_box_count1", missing1); result.Add("missing_box_count2", missing2);
            result.Add("pairs_checked", pairCount);
            return result;
        }

        private sealed class MaterialTotal
        {
            internal Material Material;
            internal double Volume;
            internal int Count;
        }

        private static object MaterialQuantities(Document doc, Dictionary<string, object> args, NativeModelQueries.ReadBudget budget)
        {
            NativeModelQueries.Fields(args, "expected_document", "category", "offset", "limit", "fields");
            var fields = new HashSet<string>(StringComparer.Ordinal);
            object raw;
            if (args.TryGetValue("fields", out raw))
            {
                var values = raw as System.Collections.IEnumerable;
                if (values == null || raw is string || raw is System.Collections.IDictionary) throw new InvalidOperationException("fields must be an array.");
                foreach (object value in values)
                {
                    string field = value as string;
                    if (field == null || !new[] { "name", "element_count" }.Contains(field, StringComparer.Ordinal) || !fields.Add(field)) throw new InvalidOperationException("Invalid or duplicate field.");
                }
            }
            BuiltInCategory? category = NativeModelQueries.Category(args);
            if (!category.HasValue) throw new InvalidOperationException("A category is required.");
            int offset = NativeModelQueries.Page(args, "offset", 0, 0, int.MaxValue);
            int limit = NativeModelQueries.Page(args, "limit", 100, 1, 200);
            var totals = new SortedDictionary<long, MaterialTotal>();
            int elementCount = 0;
            using (var collector = new FilteredElementCollector(doc).OfCategory(category.Value).WhereElementIsNotElementType())
            foreach (Element element in collector)
            {
                budget.Scan();
                elementCount++;
                foreach (ElementId materialId in element.GetMaterialIds(false))
                {
                    budget.Scan();
                    long id = PositiveIdValue(materialId);
                    Material material = doc.GetElement(materialId) as Material;
                    if (material == null) throw new InvalidOperationException("A material could not be resolved; no partial quantities published.");
                    double volume = element.GetMaterialVolume(materialId);
                    if (Double.IsNaN(volume) || Double.IsInfinity(volume) || volume < 0) throw new InvalidOperationException("Invalid material volume; no partial quantities published.");
                    MaterialTotal total;
                    if (!totals.TryGetValue(id, out total)) totals.Add(id, total = new MaterialTotal { Material = material });
                    total.Volume += volume;
                    if (Double.IsInfinity(total.Volume)) throw new InvalidOperationException("Material volume overflow.");
                    total.Count++;
                }
            }
            var result = (Dictionary<string, object>)PageResult(totals, pair => {
                var row = new Dictionary<string, object> { { "material_id", ExactIdText(pair.Key) }, { "volume_cubic_feet", pair.Value.Volume } };
                if (fields.Contains("name")) row.Add("name", pair.Value.Material.Name);
                if (fields.Contains("element_count")) row.Add("element_count", pair.Value.Count);
                return row;
            }, totals.Count, offset, limit, budget);
            result.Add("category", category.Value.ToString());
            result.Add("element_count", elementCount);
            result.Add("includes_paint", false);
            return result;
        }

        private static string Id(ElementId value) { return NativeModelQueries.SignedId(value); }

        private static object NameRow(Element element) { return new { id = Id(element.Id), name = element.Name }; }

        private static object CategoryRow(Category category)
        {
            long id = category.Id.Value;
            string builtIn = id >= int.MinValue && id <= int.MaxValue ? Enum.GetName(typeof(BuiltInCategory), (BuiltInCategory)id) : null;
            return new { id = Id(category.Id), name = category.Name, built_in_category = builtIn };
        }

        private static object DesignOptionRow(DesignOption option)
        {
            Parameter parameter = option.get_Parameter(BuiltInParameter.OPTION_SET_ID);
            ElementId setId = parameter != null && parameter.HasValue && parameter.StorageType == StorageType.ElementId ? parameter.AsElementId() : null;
            return new { id = Id(option.Id), name = option.Name, set_id = setId != null && setId.Value > 0 ? Id(setId) : null };
        }

        private static string DefinitionType(Definition definition, bool group)
        {
            if (definition == null) return null;
            ForgeTypeId type = group ? definition.GetGroupTypeId() : definition.GetDataType();
            return type == null || String.IsNullOrEmpty(type.TypeId) ? null : type.TypeId;
        }

        private static object Worksets(Document doc, int offset, int limit, NativeModelQueries.ReadBudget budget)
        {
            if (!doc.IsWorkshared)
                return Page(Enumerable.Empty<Workset>(), workset => workset.Id.IntegerValue, WorksetRow, offset, limit, budget, isWorkshared: false);
            using (var worksets = new FilteredWorksetCollector(doc).OfKind(WorksetKind.UserWorkset))
                return Page(worksets, workset => workset.Id.IntegerValue, WorksetRow, offset, limit, budget, isWorkshared: true);
        }

        private static object WorksetRow(Workset workset)
        {
            return new { id = workset.Id.IntegerValue.ToString(CultureInfo.InvariantCulture), name = workset.Name, is_open = workset.IsOpen };
        }

        private sealed class WarningRow
        {
            internal string FailureDefinitionId;
            internal string Severity;
            internal string Description;
            internal long[] FailingIds;
            internal long[] AdditionalIds;

            internal object ToResult()
            {
                return new {
                    failure_definition_id = FailureDefinitionId, severity = Severity, description = Description,
                    failing_element_ids = FailingIds.Select(ExactIdText).ToArray(),
                    additional_element_ids = AdditionalIds.Select(ExactIdText).ToArray()
                };
            }
        }

        private static object Warnings(Document doc, int offset, int limit, NativeModelQueries.ReadBudget budget)
        {
            var rows = new List<WarningRow>();
            foreach (FailureMessage warning in doc.GetWarnings())
            {
                budget.Scan();
                string description = warning.GetDescriptionText();
                if (description == null || description.Length > MaximumWarningDescriptionLength)
                    throw new InvalidOperationException("Warning description exceeds the read contract.");
                rows.Add(new WarningRow {
                    FailureDefinitionId = warning.GetFailureDefinitionId().Guid.ToString("D"),
                    Severity = warning.GetSeverity().ToString(), Description = description,
                    FailingIds = WarningElementIds(warning.GetFailingElements(), budget),
                    AdditionalIds = WarningElementIds(warning.GetAdditionalElements(), budget)
                });
            }
            rows.Sort(CompareWarnings);
            return PageResult(rows, row => row.ToResult(), rows.Count, offset, limit, budget);
        }

        private static long[] WarningElementIds(IEnumerable<ElementId> elements, NativeModelQueries.ReadBudget budget)
        {
            var ids = new SortedSet<long>();
            foreach (ElementId id in elements)
            {
                budget.Scan();
                ids.Add(PositiveIdValue(id));
                if (ids.Count > MaximumWarningElementIds)
                    throw new InvalidOperationException("A warning references more than 200 element IDs in one list; no partial result published.");
            }
            return ids.ToArray();
        }

        private static int CompareWarnings(WarningRow left, WarningRow right)
        {
            int result = StringComparer.Ordinal.Compare(left.FailureDefinitionId, right.FailureDefinitionId);
            if (result == 0) result = StringComparer.Ordinal.Compare(left.Severity, right.Severity);
            if (result == 0) result = StringComparer.Ordinal.Compare(left.Description, right.Description);
            if (result == 0) result = CompareWarningIds(left.FailingIds, right.FailingIds);
            if (result == 0) result = CompareWarningIds(left.AdditionalIds, right.AdditionalIds);
            return result;
        }

        private static int CompareWarningIds(long[] left, long[] right)
        {
            for (int index = 0; index < Math.Min(left.Length, right.Length); index++)
            {
                int result = left[index].CompareTo(right[index]);
                if (result != 0) return result;
            }
            return left.Length.CompareTo(right.Length);
        }

        private static string ExactIdText(long id) { return id.ToString(CultureInfo.InvariantCulture); }
        private static string ExactPositiveId(ElementId id) { return ExactIdText(PositiveIdValue(id)); }

        private static long PositiveIdValue(ElementId id)
        {
            if (id == null || id.Value <= 0) throw new InvalidOperationException("Revit returned an invalid element ID.");
            return id.Value;
        }

        private static object LinkInstanceRow(Document doc, RevitLinkInstance link)
        {
            ElementId typeId = link.GetTypeId();
            return new {
                id = ExactPositiveId(link.Id), type_id = ExactPositiveId(typeId), name = link.Name,
                is_loaded = RevitLinkType.IsLoaded(doc, typeId), transform = LinkTransform(link)
            };
        }

        private static object LinkTransform(RevitLinkInstance link)
        {
            using (Transform transform = link.GetTotalTransform())
            {
                if (transform == null) return null;
                return new {
                    origin_feet = LinkVector(transform.Origin), basis_x = LinkVector(transform.BasisX),
                    basis_y = LinkVector(transform.BasisY), basis_z = LinkVector(transform.BasisZ)
                };
            }
        }

        private static double[] LinkVector(XYZ vector)
        {
            var coordinates = new[] { vector.X, vector.Y, vector.Z };
            if (coordinates.Any(value => Double.IsNaN(value) || Double.IsInfinity(value)))
                throw new InvalidOperationException("Revit returned a non-finite link transform.");
            return coordinates;
        }

        private static object GroupMembers(Document doc, Dictionary<string, object> args, NativeModelQueries.ReadBudget budget)
        {
            NativeModelQueries.Fields(args, "expected_document", "group_id", "offset", "limit", "fields");
            long groupId = NativeModelQueries.ExactId(args, "group_id");
            int offset = NativeModelQueries.Page(args, "offset", 0, 0, int.MaxValue);
            int limit = NativeModelQueries.Page(args, "limit", 100, 1, 200);
            var fields = new List<string>();
            object raw;
            if (args.TryGetValue("fields", out raw))
            {
                var values = raw as System.Collections.IEnumerable;
                if (values == null || raw is string || raw is System.Collections.IDictionary) throw new InvalidOperationException("fields must be an array.");
                foreach (object value in values)
                {
                    string field = value as string;
                    if (field == null || !new[] { "name", "category", "type_id" }.Contains(field, StringComparer.Ordinal) || fields.Contains(field))
                        throw new InvalidOperationException("Invalid or duplicate field.");
                    fields.Add(field);
                }
            }
            var group = doc.GetElement(new ElementId(groupId)) as Group;
            if (group == null || !group.IsValidObject || group.Category == null || group.Category.Id.Value != (long)BuiltInCategory.OST_IOSModelGroups)
                throw new InvalidOperationException("group_id must identify a model group instance in the current document.");
            IList<ElementId> ids = group.GetMemberIds();
            var seen = new HashSet<long>();
            foreach (ElementId id in ids)
            {
                budget.Scan();
                long memberId = PositiveIdValue(id);
                if (memberId == groupId || !seen.Add(memberId)) throw new InvalidOperationException("Revit returned a self-referencing or duplicate member ID.");
            }
            var items = new List<object>();
            foreach (ElementId id in ids.Skip(offset).Take(limit))
            {
                var row = new Dictionary<string, object> { { "id", ExactPositiveId(id) } };
                if (fields.Count > 0)
                {
                    Element element = doc.GetElement(id);
                    if (element == null || !element.IsValidObject) throw new InvalidOperationException("Could not read a group member.");
                    foreach (string field in fields)
                    {
                        if (field == "name") row[field] = element.Name;
                        else if (field == "category") row[field] = element.Category == null ? null : CategoryRow(element.Category);
                        else { ElementId typeId = element.GetTypeId(); row[field] = typeId != null && typeId.Value > 0 ? Id(typeId) : null; }
                    }
                }
                budget.Reserve(row);
                items.Add(row);
            }
            var coverage = new { scanned = ids.Count, complete = true, stop_reason = (string)null };
            budget.Reserve(coverage);
            return new { schema_version = 1, group_id = ExactIdText(groupId), items = items.ToArray(), offset, limit,
                total = ids.Count, has_more = (long)offset + items.Count < ids.Count, coverage };
        }

        private static object SheetInfo(Document doc, long sheetId, NativeModelQueries.ReadBudget budget)
        {
            var sheet = doc.GetElement(new ElementId(sheetId)) as ViewSheet;
            if (sheet == null) throw new InvalidOperationException("sheet_id must identify a sheet in the current document.");
            ICollection<ElementId> viewportIds = sheet.GetAllViewports();
            if (viewportIds.Count > 2000) throw new InvalidOperationException("Sheet query exceeds 2000 viewports; no partial result published.");
            var viewports = new List<object>();
            foreach (ElementId id in viewportIds.OrderBy(item => item.Value))
            {
                budget.Scan();
                var viewport = doc.GetElement(id) as Viewport;
                if (viewport == null) throw new InvalidOperationException("Could not read a viewport reported by the sheet.");
                Element view = doc.GetElement(viewport.ViewId);
                var row = new { viewport_id = Id(viewport.Id), view_id = Id(viewport.ViewId), view_name = view == null ? null : view.Name };
                budget.Reserve(row);
                viewports.Add(row);
            }
            budget.Reserve(new { sheet_number = sheet.SheetNumber, sheet_name = sheet.Name });
            return new { schema_version = 1, sheet_id = Id(sheet.Id), sheet_number = sheet.SheetNumber, sheet_name = sheet.Name,
                is_placeholder = sheet.IsPlaceholder, viewport_count = viewports.Count, viewports = viewports.ToArray(),
                parameters = NativeModelQueries.ParameterRows(sheet, budget) };
        }

        private static object Elements<T>(Document doc, Func<T, object> row, int offset, int limit,
            NativeModelQueries.ReadBudget budget, BuiltInCategory? category = null, Func<T, string> sortName = null) where T : Element
        {
            using (var collector = new FilteredElementCollector(doc).OfClass(typeof(T)))
            {
                if (category.HasValue) collector.OfCategory(category.Value);
                return Page(collector.Cast<T>(), element => element.Id.Value, row, offset, limit, budget, sortName: sortName);
            }
        }

        private static object Page<T>(IEnumerable<T> source, Func<T, long> id, Func<T, object> row, int offset, int limit,
            NativeModelQueries.ReadBudget budget, Func<T, bool> include = null, Func<T, string> sortName = null, bool? isWorkshared = null)
        {
            var matches = new List<T>();
            foreach (T candidate in source)
            {
                budget.Scan();
                if (include == null || include(candidate)) matches.Add(candidate);
            }
            IOrderedEnumerable<T> ordered = sortName == null ? matches.OrderBy(id) : matches.OrderBy(sortName, StringComparer.Ordinal).ThenBy(id);
            return PageResult(ordered, row, matches.Count, offset, limit, budget, isWorkshared);
        }

        private static object PageResult<T>(IEnumerable<T> ordered, Func<T, object> row, int total, int offset, int limit,
            NativeModelQueries.ReadBudget budget, bool? isWorkshared = null)
        {
            var items = new List<object>();
            foreach (T match in ordered.Skip(offset).Take(limit))
            {
                object item = row(match);
                budget.Reserve(item);
                items.Add(item);
            }
            var coverage = new { scanned = budget.Scanned, complete = true, stop_reason = (string)null };
            budget.Reserve(coverage);
            var result = new Dictionary<string, object> {
                { "schema_version", 1 }, { "items", items.ToArray() }, { "offset", offset }, { "limit", limit },
                { "total", total }, { "has_more", (long)offset + items.Count < total }, { "coverage", coverage }
            };
            if (isWorkshared.HasValue) result.Add("is_workshared", isWorkshared.Value);
            return result;
        }

    }
}
