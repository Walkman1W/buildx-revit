using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Web.Script.Serialization;

namespace Autodesk.Revit.DB
{
    internal enum CategoryType { Model, Annotation }
    internal sealed partial class Category
    {
        public CategoryType CategoryType;
        public bool CanAddSubcategory;
    }
    internal sealed partial class Definition
    {
        public ForgeTypeId GetGroupTypeId() { return new ForgeTypeId("group"); }
    }
    internal static class LabelUtils
    {
        public static string GetLabelForGroup(ForgeTypeId group) { return "测试组"; }
    }
    internal sealed class Settings
    {
        public List<Category> Categories = new List<Category>();
    }
    internal sealed partial class Document
    {
        public Settings Settings = new Settings();
        public bool IsWorkshared;
        public List<Phase> Phases = new List<Phase>();
        public List<Workset> Worksets = new List<Workset>();
        public List<FailureMessage> Warnings = new List<FailureMessage>();
        public IList<FailureMessage> GetWarnings() { return Warnings; }
    }
    internal enum FailureSeverity { Warning, Error }
    internal sealed class FailureDefinitionId
    {
        public Guid Guid;
    }
    internal sealed class FailureMessage
    {
        public string Description;
        public FailureDefinitionId Definition;
        public FailureSeverity Severity;
        public List<ElementId> Failing;
        public List<ElementId> Additional;
        public string GetDescriptionText() { return Description; }
        public FailureDefinitionId GetFailureDefinitionId() { return Definition; }
        public FailureSeverity GetSeverity() { return Severity; }
        public ICollection<ElementId> GetFailingElements() { return Failing; }
        public ICollection<ElementId> GetAdditionalElements() { return Additional; }
    }
    internal sealed class RevitLinkType : ElementType
    {
        public bool IsNestedLink;
        public bool Loaded;
        public static bool IsLoaded(Document doc, ElementId id)
        {
            return ((RevitLinkType)doc.GetElement(id)).Loaded;
        }
    }
    internal sealed class RevitLinkInstance : Element
    {
        public Transform Placement;
        public Transform GetTotalTransform() { return Placement; }
    }
    internal sealed class Group : Element
    {
        public List<ElementId> Members = new List<ElementId>();
        public IList<ElementId> GetMemberIds() { return Members; }
    }
    internal sealed class ViewSheet : View
    {
        public string SheetNumber;
        public bool IsPlaceholder;
        public List<ElementId> Viewports = new List<ElementId>();
        public ICollection<ElementId> GetAllViewports() { return Viewports; }
    }
    internal sealed class Viewport : Element { public ElementId ViewId; }
    internal sealed class Family : Element { public Category FamilyCategory; }
    internal sealed class FamilySymbol : ElementType { public Family Family; }
    internal sealed class Phase : Element { }
    internal sealed class PhaseFilter : Element { }
    internal sealed class DesignOption : Element { }
    internal class ParameterElement : Element
    {
        public Definition GetDefinition() { return new Definition { Name = Name }; }
    }
    internal sealed class SharedParameterElement : ParameterElement { public Guid GuidValue; }
    internal enum WorksetKind { UserWorkset, ViewWorkset }
    internal sealed class WorksetId
    {
        public int IntegerValue;
        public WorksetId(int id) { IntegerValue = id; }
    }
    internal sealed class Workset
    {
        public string Name;
        public WorksetId Id;
        public bool IsOpen;
        public WorksetKind Kind;
    }
    internal sealed class FilteredWorksetCollector : IEnumerable<Workset>, IDisposable
    {
        private IEnumerable<Workset> worksets;
        public FilteredWorksetCollector(Document doc) { worksets = doc.Worksets; }
        public FilteredWorksetCollector OfKind(WorksetKind kind)
        {
            worksets = worksets.Where(workset => workset.Kind == kind);
            return this;
        }
        public IEnumerator<Workset> GetEnumerator() { return worksets.GetEnumerator(); }
        IEnumerator IEnumerable.GetEnumerator() { return GetEnumerator(); }
        public void Dispose() { }
    }
}

namespace RevitLocalCodex
{
    using Autodesk.Revit.DB;

    internal static class AecPilotPeerProgram
    {
        private const string SheetId = "9007199254740994";
        private const string GroupId = "9007199254740993";
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        private static readonly string[] Queries = {
            "list_sheets", "get_sheet_info", "list_titleblocks", "get_categories", "get_worksets",
            "get_phases", "get_phase_filters", "get_design_options", "list_shared_parameters", "list_project_parameters",
            "get_warnings", "get_rvt_links", "get_link_instances", "get_group_members", "calculate_material_quantities", "check_clashes"
        };

        private static Document Fixture()
        {
            var doc = new Document { IsWorkshared = true };
            var walls = new Category { Id = new ElementId((long)BuiltInCategory.OST_Walls), Name = "墙", CategoryType = CategoryType.Model, CanAddSubcategory = true };
            var titleblocks = new Category { Id = new ElementId((long)BuiltInCategory.OST_TitleBlocks), Name = "图框", CategoryType = CategoryType.Annotation };
            doc.Settings.Categories.AddRange(new[] { walls, titleblocks });
            doc.Add(new Material { Id = new ElementId(700), Name = "同名" });
            doc.Add(new Material { Id = new ElementId(9007199254740999L), Name = "同名" });
            var wall1 = new Element { Id = new ElementId(701), Name = "wall1", Category = walls };
            wall1.Box = new BoundingBoxXYZ { Min = new XYZ(0, 0, 0), Max = new XYZ(1, 1, 1) };
            wall1.MaterialVolumes.Add(700, 2); wall1.MaterialVolumes.Add(9007199254740999L, 3); doc.Add(wall1);
            var wall2 = new Element { Id = new ElementId(702), Name = "wall2", Category = walls };
            wall2.MaterialVolumes.Add(700, 4); doc.Add(wall2);
            var doors = new Category { Id = new ElementId((long)BuiltInCategory.OST_Doors), Name = "门" };
            doc.Add(new Element { Id = new ElementId(703), Name = "door", Category = doors, Box = new BoundingBoxXYZ { Min = new XYZ(1.005, 0, 0), Max = new XYZ(2, 1, 1) } });
            for (int index = 249; index >= 0; index--)
                doc.Add(new ViewSheet { Id = new ElementId(index + 100), SheetNumber = "A" + index.ToString("000"), Name = "普通图纸" });
            var group = new Group { Id = new ElementId(9007199254740993L), Category = new Category { Id = new ElementId((long)BuiltInCategory.OST_IOSModelGroups) } };
            group.Members.AddRange(new[] { new ElementId(503), new ElementId(502) });
            doc.Add(group);
            var sheet = new ViewSheet { Id = new ElementId(9007199254740994L), SheetNumber = "Z01", Name = "总图" };
            sheet.Viewports.Add(new ElementId(500));
            foreach (int parameterId in new[] { -123, 510 })
                sheet.Parameters.Add(new Parameter { Id = new ElementId(parameterId), Definition = new Definition { Name = "同名参数" }, StorageType = StorageType.String, HasValue = true, Value = "原值" });
            doc.Add(sheet);
            doc.Add(new Viewport { Id = new ElementId(500), ViewId = new ElementId(501) });
            doc.Add(new View { Id = new ElementId(501), Name = "视图一" });
            doc.Add(new FamilySymbol { Id = new ElementId(502), Name = "A1", Category = titleblocks, Family = new Family { Name = "图框族", FamilyCategory = titleblocks } });
            doc.Add(new FamilySymbol { Id = new ElementId(503), Name = "墙类型", Category = walls, Family = new Family { Name = "墙族", FamilyCategory = walls } });
            doc.Worksets.Add(new Workset { Id = new WorksetId(0), Name = "机电", IsOpen = true, Kind = WorksetKind.UserWorkset });
            doc.Worksets.Add(new Workset { Id = new WorksetId(2), Name = "视图", Kind = WorksetKind.ViewWorkset });
            var phase = new Phase { Id = new ElementId(504), Name = "新建" };
            doc.Phases.Add(phase);
            doc.Add(phase);
            doc.Add(new PhaseFilter { Id = new ElementId(505), Name = "全部" });
            doc.Add(new DesignOption { Id = new ElementId(506), Name = "方案一" });
            doc.Add(new SharedParameterElement { Id = new ElementId(507), Name = "共享编号", GuidValue = new Guid("f4eddb63-76e8-427f-bb63-6308ac4ed2b8") });
            doc.Add(new ParameterElement { Id = new ElementId(508), Name = "项目编号" });
            var loaded = new RevitLinkType { Id = new ElementId(600), Name = "建筑", Loaded = true };
            var unloaded = new RevitLinkType { Id = new ElementId(9007199254740995L), Name = "机电", IsNestedLink = true };
            doc.Add(unloaded);
            doc.Add(loaded);
            doc.Add(new RevitLinkInstance { Id = new ElementId(9007199254740997L), Name = "建筑副本", TypeId = loaded.Id, Placement = LinkPlacement(10) });
            doc.Add(new RevitLinkInstance { Id = new ElementId(601), Name = "机电一", TypeId = unloaded.Id, Placement = LinkPlacement(-2.5) });
            doc.Add(new RevitLinkInstance { Id = new ElementId(602), Name = "建筑一", TypeId = loaded.Id });
            var repeatedWarning = Warning(1, "重叠", new long[] { 9007199254740993L, 10, 2, 2 }, new long[] { 12 });
            doc.Warnings.Add(repeatedWarning);
            doc.Warnings.Add(Warning(2, "缺少引用", new long[0], new long[0]));
            doc.Warnings.Add(Warning(1, "重叠", new long[] { 9, 2 }, new long[] { 1 }));
            doc.Warnings.Add(repeatedWarning);
            doc.Warnings.Add(Warning(1, "重叠", new long[] { 9007199254740993L, 10, 2 }, new long[0]));
            return doc;
        }

        private static Transform LinkPlacement(double x)
        {
            return new Transform {
                Origin = new XYZ(x, 3, 4), BasisX = new XYZ(0, 1, 0),
                BasisY = new XYZ(-1, 0, 0), BasisZ = new XYZ(0, 0, 1)
            };
        }

        private static FailureMessage Warning(int definition, string description, IEnumerable<long> failing, IEnumerable<long> additional)
        {
            return new FailureMessage {
                Definition = new FailureDefinitionId { Guid = new Guid(definition, 0, 0, new byte[8]) },
                Description = description, Severity = FailureSeverity.Warning,
                Failing = failing.Select(id => new ElementId(id)).ToList(),
                Additional = additional.Select(id => new ElementId(id)).ToList()
            };
        }

        private static Dictionary<string, object> Arguments(string query)
        {
            return query == "check_clashes" ? new Dictionary<string, object> { { "category1", "Walls" }, { "category2", "Doors" } } : query == "calculate_material_quantities" ? new Dictionary<string, object> { { "category", "Walls" } } : query == "get_group_members" ? new Dictionary<string, object> { { "group_id", GroupId } } : query == "get_sheet_info"
                ? new Dictionary<string, object> { { "sheet_id", SheetId } }
                : new Dictionary<string, object>();
        }

        private static Dictionary<string, object> Read(Document doc, string operation, Dictionary<string, object> args)
        {
            return Json.Deserialize<Dictionary<string, object>>(Json.Serialize(AecPilotQueries.Read(doc, operation, args)));
        }

        private static Dictionary<string, object>[] Rows(Dictionary<string, object> result, string key)
        {
            return ((IEnumerable)result[key]).Cast<Dictionary<string, object>>().ToArray();
        }

        private static void Check(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }

        private static void Reject(Document doc, string operation, Dictionary<string, object> args)
        {
            try { AecPilotQueries.Read(doc, operation, args); }
            catch (InvalidOperationException) { return; }
            throw new InvalidOperationException(operation + " accepted an invalid query");
        }

        private static IEnumerable<string> WarningIds(Dictionary<string, object> row, string key)
        {
            return ((IEnumerable)row[key]).Cast<string>();
        }

        private static void CheckWarningsAndLinks(Document doc, Dictionary<string, Dictionary<string, object>> results)
        {
            var warnings = Rows(results["get_warnings"], "items");
            Check(warnings.Length == 5 && WarningIds(warnings[0], "failing_element_ids").SequenceEqual(new[] { "2", "9" }) &&
                !WarningIds(warnings[1], "additional_element_ids").Any() &&
                WarningIds(warnings[2], "failing_element_ids").SequenceEqual(new[] { "2", "10", GroupId }) &&
                Json.Serialize(warnings[2]) == Json.Serialize(warnings[3]) &&
                (string)warnings[4]["failure_definition_id"] == "00000002-0000-0000-0000-000000000000", "warning order, exact IDs and duplicate rows");
            doc.Warnings.Reverse();
            var reordered = Read(doc, "get_warnings", new Dictionary<string, object> { { "offset", 1 }, { "limit", 2 } });
            Check((int)reordered["total"] == 5 && (bool)reordered["has_more"] &&
                Json.Serialize(Rows(reordered, "items")) == Json.Serialize(warnings.Skip(1).Take(2).ToArray()), "warning pagination independent of API order");

            var types = Rows(results["get_rvt_links"], "items");
            Check(types.Length == 2 && (string)types[0]["id"] == "600" && (bool)types[0]["is_loaded"] &&
                (string)types[1]["id"] == "9007199254740995" && !(bool)types[1]["is_loaded"] &&
                (bool)types[1]["is_nested"] && types.All(row => row.Count == 4), "link type identity and unloaded coverage");
            var instances = Rows(results["get_link_instances"], "items");
            var transform = (Dictionary<string, object>)instances[0]["transform"];
            Check(instances.Length == 3 && !(bool)instances[0]["is_loaded"] &&
                (string)instances[0]["type_id"] == "9007199254740995" && (bool)instances[1]["is_loaded"] &&
                instances[1]["transform"] == null && (string)instances[2]["id"] == "9007199254740997" &&
                ((IEnumerable)transform["origin_feet"]).Cast<object>().Select(value => Convert.ToDouble(value)).SequenceEqual(new[] { -2.5, 3, 4 }) &&
                ((IEnumerable)transform["basis_y"]).Cast<object>().Select(value => Convert.ToDouble(value)).SequenceEqual(new[] { -1.0, 0, 0 }),
                "link placements preserve load state, missing transform and native origin and basis");

            var invalid = new Document();
            invalid.Warnings.Add(Warning(1, "超限", Enumerable.Range(1, 201).Select(id => (long)id), new long[0]));
            Reject(invalid, "get_warnings", Arguments("get_warnings"));
            invalid.Warnings[0] = Warning(1, "无效 ID", new long[0], new long[] { -1 });
            Reject(invalid, "get_warnings", Arguments("get_warnings"));
            var type = new RevitLinkType { Id = new ElementId(1), Name = "类型" };
            invalid.Add(type);
            invalid.Add(new RevitLinkInstance { Id = new ElementId(2), Name = "实例", TypeId = type.Id, Placement = LinkPlacement(Double.NaN) });
            Reject(invalid, "get_link_instances", Arguments("get_link_instances"));
        }

        public static int Main()
        {
            var doc = Fixture();
            var results = Queries.ToDictionary(operation => operation, operation => Read(doc, operation, Arguments(operation)));
            var clashes = results["check_clashes"];
            Check((int)clashes["total"] == 1 && (int)clashes["missing_box_count1"] == 1 && Convert.ToInt32(clashes["pairs_checked"]) == 1 &&
                (string)Rows(clashes, "items").Single()["element1_id"] == "701" && (string)Rows(clashes, "items").Single()["element2_id"] == "703" && !(bool)clashes["solid_intersection_tested"], "expanded AABB and missing boxes");
            var zeroTolerance = Read(doc, "check_clashes", new Dictionary<string, object> { { "category1", "Walls" }, { "category2", "Doors" }, { "tolerance_feet", 0 } });
            Check((int)zeroTolerance["total"] == 0, "tolerance changes candidates");
            var wall2Box = doc.Elements.First(element => element.Id.Value == 702);
            wall2Box.Box = new BoundingBoxXYZ { Min = new XYZ(0, 0, 0), Max = new XYZ(1, 1, 1) };
            var sameClash = Read(doc, "check_clashes", new Dictionary<string, object> { { "category1", "Walls" }, { "category2", "Walls" }, { "limit", 1 } });
            Check((int)sameClash["total"] == 1 && Convert.ToInt32(sameClash["pairs_checked"]) == 1 && (string)Rows(sameClash, "items").Single()["element1_id"] == "701" && (string)Rows(sameClash, "items").Single()["element2_id"] == "702", "same category unordered unique pair");
            wall2Box.Box = null;
            Reject(doc, "check_clashes", new Dictionary<string, object> { { "category1", "Walls" } });
            Reject(doc, "check_clashes", new Dictionary<string, object> { { "category1", "Walls" }, { "category2", "Doors" }, { "tolerance_feet", -1 } });
            var many = new Document();
            var manyCat = new Category { Id = new ElementId((long)BuiltInCategory.OST_Walls) };
            for (int i = 1; i <= 318; i++) many.Add(new Element { Id = new ElementId(i), Category = manyCat, Box = new BoundingBoxXYZ { Min = new XYZ(0, 0, 0), Max = new XYZ(1, 1, 1) } });
            Reject(many, "check_clashes", new Dictionary<string, object> { { "category1", "Walls" }, { "category2", "Walls" } });
            var paged = Read(many, "check_clashes", new Dictionary<string, object> { { "category1", "Walls" }, { "category2", "Doors" }, { "offset", 1 }, { "limit", 1 } });
            Check((int)paged["total"] == 0 && Rows(paged, "items").Length == 0, "empty page after total");
            var door = doc.Elements.First(element => element.Id.Value == 703);
            door.Box.Min = new XYZ(Double.NaN, 0, 0);
            Reject(doc, "check_clashes", Arguments("check_clashes"));
            door.Box.Min = new XYZ(1.005, 0, 0);
            var material = results["calculate_material_quantities"];
            var materialRows = Rows(material, "items");
            Check((int)material["element_count"] == 2 && !(bool)material["includes_paint"] && materialRows.Length == 2 &&
                (string)materialRows[0]["material_id"] == "700" && Convert.ToDouble(materialRows[0]["volume_cubic_feet"]) == 6 &&
                (string)materialRows[1]["material_id"] == "9007199254740999" && materialRows.All(row => row.Count == 2), "material aggregation and exact distinct IDs");
            var materialPage = Read(doc, "calculate_material_quantities", new Dictionary<string, object> { { "category", "Walls" }, { "offset", 1 }, { "limit", 1 }, { "fields", new[] { "name", "element_count" } } });
            Check((string)Rows(materialPage, "items").Single()["name"] == "同名" && (int)Rows(materialPage, "items").Single()["element_count"] == 1 && !(bool)materialPage["has_more"], "material pagination and requested fields");
            Reject(doc, "calculate_material_quantities", new Dictionary<string, object>());
            Reject(doc, "calculate_material_quantities", new Dictionary<string, object> { { "category", "Walls" }, { "fields", new[] { "name", "name" } } });
            var badWall = doc.Elements.First(element => element.Id.Value == 701);
            badWall.MaterialVolumes[700] = Double.NaN;
            Reject(doc, "calculate_material_quantities", Arguments("calculate_material_quantities"));
            badWall.MaterialVolumes[700] = 2;
            badWall.MaterialVolumes.Add(99999, 1);
            Reject(doc, "calculate_material_quantities", Arguments("calculate_material_quantities"));
            badWall.MaterialVolumes.Remove(99999);
            var sheets = results["list_sheets"];
            Check((int)sheets["total"] == 251 && Rows(sheets, "items").Length == 100 && (bool)sheets["has_more"], "sheet pagination");
            var last = Read(doc, "list_sheets", new Dictionary<string, object> { { "offset", 250 }, { "limit", 10 } });
            Check((string)Rows(last, "items").Single()["id"] == SheetId && !(bool)last["has_more"], "last page exact ID");
            var detail = results["get_sheet_info"];
            Check((string)detail["sheet_id"] == SheetId && Rows(detail, "parameters").Length == 2 &&
                (string)Rows(detail, "viewports").Single()["view_name"] == "视图一", "exact sheet detail and duplicate parameter names");
            Check((string)Rows(results["list_titleblocks"], "items").Single()["type_name"] == "A1", "localized title block");
            Check((string)Rows(results["get_categories"], "items").Single()["name"] == "墙", "model category filter");
            Check((bool)results["get_worksets"]["is_workshared"] &&
                (string)Rows(results["get_worksets"], "items").Single()["id"] == "0", "workset kind filter and exact zero ID");
            Check(Rows(results["get_phases"], "items").Length == 1 && Rows(results["get_phase_filters"], "items").Length == 1, "phase queries");
            Check(Rows(results["get_design_options"], "items").Single()["set_id"] == null, "missing design option set");
            Check((string)Rows(results["list_shared_parameters"], "items").Single()["guid"] == "f4eddb63-76e8-427f-bb63-6308ac4ed2b8", "shared parameter GUID");
            Check(Rows(results["list_project_parameters"], "items").Any(row => (string)row["name"] == "项目编号"), "project parameters");
            var standalone = Read(new Document(), "get_worksets", Arguments("get_worksets"));
            Check(!(bool)standalone["is_workshared"] && Rows(standalone, "items").Length == 0, "non-workshared document");
            Reject(doc, "get_sheet_info", new Dictionary<string, object> { { "sheet_id", 503 } });
            Reject(doc, "get_sheet_info", new Dictionary<string, object> { { "sheet_id", 9007199254740993L } });
            Reject(doc, "list_sheets", new Dictionary<string, object> { { "limit", 201 } });
            CheckWarningsAndLinks(doc, results);
            var members = results["get_group_members"];
            Check((string)members["group_id"] == GroupId && Rows(members, "items").Select(row => (string)row["id"]).SequenceEqual(new[] { "503", "502" }) && Rows(members, "items").All(row => row.Count == 1), "group order and default fields");
            var page = Read(doc, "get_group_members", new Dictionary<string, object> { { "group_id", GroupId }, { "offset", 1 }, { "limit", 1 }, { "fields", new[] { "name", "category", "type_id" } } });
            var member = Rows(page, "items").Single();
            Check((string)member["id"] == "502" && (string)member["name"] == "A1" && member["type_id"] == null && (string)((Dictionary<string, object>)member["category"])["built_in_category"] == "OST_TitleBlocks" && !(bool)page["has_more"], "group pagination and requested fields");
            Reject(doc, "get_group_members", new Dictionary<string, object> { { "group_id", "503" } });
            Reject(doc, "get_group_members", new Dictionary<string, object> { { "group_id", GroupId }, { "fields", new[] { "name", "name" } } });
            Reject(doc, "get_group_members", new Dictionary<string, object> { { "group_id", GroupId }, { "limit", 201 } });
            var group = (Group)doc.Elements.First(element => element is Group);
            group.Members.Add(new ElementId(503));
            Reject(doc, "get_group_members", Arguments("get_group_members"));
            group.Members.RemoveAt(group.Members.Count - 1);
            group.Members.Add(new ElementId(9007199254740993L));
            Reject(doc, "get_group_members", Arguments("get_group_members"));
            group.Members.RemoveAt(group.Members.Count - 1);
            group.Members.Add(new ElementId(-1));
            Reject(doc, "get_group_members", Arguments("get_group_members"));
            group.Members.RemoveAt(group.Members.Count - 1);
            var savedCategory = group.Category;
            group.Category = new Category { Id = new ElementId((long)BuiltInCategory.OST_Walls) };
            Reject(doc, "get_group_members", Arguments("get_group_members"));
            group.Category = savedCategory;
            var oversized = new Document();
            var hugeGroup = new Group { Id = new ElementId(1), Category = savedCategory };
            hugeGroup.Members.AddRange(Enumerable.Range(2, 100001).Select(id => new ElementId(id)));
            oversized.Add(hugeGroup);
            Reject(oversized, "get_group_members", new Dictionary<string, object> { { "group_id", "1" } });

            const int repeats = 50;
            var byTool = new Dictionary<string, double[]>();
            foreach (string operation in Queries)
            {
                var times = new double[repeats];
                var args = Arguments(operation);
                string expected = Json.Serialize(AecPilotQueries.Read(doc, operation, args));
                for (int index = 0; index < repeats; index++)
                {
                    var watch = Stopwatch.StartNew();
                    object value = AecPilotQueries.Read(doc, operation, args);
                    watch.Stop();
                    times[index] = watch.Elapsed.TotalMilliseconds;
                    Check(Json.Serialize(value) == expected, operation + " changed during warm repeated reads");
                }
                Array.Sort(times);
                byTool.Add(operation, times);
            }
            var allTimes = byTool.Values.SelectMany(times => times).OrderBy(time => time).ToArray();
            Check(!doc.IsModified && doc.Elements.Count == 271, "fixture model changed");
            Console.WriteLine(Json.Serialize(new {
                tool_count = Queries.Length, repeated_calls = allTimes.Length, failures = 0,
                p50_ms = Percentile(allTimes, 0.50), p95_ms = Percentile(allTimes, 0.95), max_ms = allTimes.Last(),
                per_tool_p95_ms = byTool.ToDictionary(entry => entry.Key, entry => Percentile(entry.Value, 0.95)),
                fixture_results = results,
                scope = "Production C# reads with controlled Revit API peers. Timings exclude Revit, host queue, MCP and serialization after the read."
            }));
            return 0;
        }

        private static double Percentile(double[] sorted, double percentile)
        {
            return sorted[(int)Math.Ceiling(sorted.Length * percentile) - 1];
        }
    }
}
