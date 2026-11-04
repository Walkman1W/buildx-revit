using System;
using System.Collections.Generic;
using System.Diagnostics;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    // Read-only, in one Revit API callback. Budgets bound returned data and traversal;
    // a Revit geometry or tessellation call itself cannot be interrupted.
    internal static class ModelViewerSnapshot
    {
        private const int MaxTriangles = 2400, MaxElementTriangles = 300, MaxObjects = 5000, MaxDepth = 12;
        private const long MaxElapsedMs = 2500;
        // FreezeResult counts UTF-16 code units for the whole atomic response.
        // Each string code unit can expand to a six-character JSON escape; 32
        // characters conservatively cover any finite double plus a comma.
        internal const int FreezeLimit = 250000, EnvelopeReserve = 32768, ValueReserve = 2048;
        internal const int ItemReserve = 512, TriangleReserve = 9 * 32;

        internal static object Capture(UIApplication app, int limit)
        {
            if (limit < 1 || limit > 300) throw new ArgumentOutOfRangeException("limit");
            Document document = app.ActiveUIDocument.Document;
            var items = new List<object>();
            int examined = 0, missing = 0, failed = 0, omittedBudget = 0, triangles = 0, meshComplete = 0, meshMissing = 0, meshPartial = 0, meshFailed = 0, meshBudgetLimited = 0;
            bool truncated = false;
            var clock = Stopwatch.StartNew();
            var budget = new Budget(clock, document.Title, document.PathName);
            using (var collector = new FilteredElementCollector(document).WhereElementIsNotElementType())
            {
                foreach (Element element in collector)
                {
                    if (examined == limit) { truncated = true; break; }
                    examined++;
                    try
                    {
                        BoundingBoxXYZ box = element.get_BoundingBox(null);
                        if (box == null) { missing++; continue; }
                        XYZ min = null, max = null;
                        for (int x = 0; x < 2; x++) for (int y = 0; y < 2; y++) for (int z = 0; z < 2; z++)
                        {
                            XYZ p = box.Transform.OfPoint(new XYZ(x == 0 ? box.Min.X : box.Max.X,
                                y == 0 ? box.Min.Y : box.Max.Y, z == 0 ? box.Min.Z : box.Max.Z));
                            min = min == null ? p : new XYZ(Math.Min(min.X,p.X),Math.Min(min.Y,p.Y),Math.Min(min.Z,p.Z));
                            max = max == null ? p : new XYZ(Math.Max(max.X,p.X),Math.Max(max.Y,p.Y),Math.Max(max.Z,p.Z));
                        }
                        string elementId = element.Id.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
                        string uniqueId = element.UniqueId, name = element.Name, category = element.Category == null ? null : element.Category.Name;
                        if (String.IsNullOrEmpty(uniqueId) || uniqueId.Length > 256 || (name != null && name.Length > 1000) || (category != null && category.Length > 1000)) { failed++; continue; }
                        object minPoint = Point(min), maxPoint = Point(max);
                        if (!budget.ReserveItem(elementId, uniqueId, name, category)) { omittedBudget++; continue; }
                        var data = new List<double>();
                        var state = new MeshState();
                        try
                        {
                            if (budget.Exhausted) state.Partial = true;
                            else
                            {
                                var options = new Options { DetailLevel = ViewDetailLevel.Medium, IncludeNonVisibleObjects = false };
                                GeometryElement geometry = element.get_Geometry(options);
                                if (geometry != null) Visit(geometry, Transform.Identity, data, state, budget, 0);
                            }
                        }
                        catch { state.Failed = true; }
                        string meshStatus = state.Failed ? "failed" : state.Partial ? "partial" : data.Count == 0 ? "missing" : "complete";
                        if (meshStatus == "failed") meshFailed++; else if (meshStatus == "partial") meshPartial++;
                        else if (meshStatus == "missing") meshMissing++; else meshComplete++;
                        if (state.BudgetLimited) meshBudgetLimited++;
                        triangles += data.Count / 9;
                        items.Add(new { element_id = elementId, unique_id = uniqueId, name, category,
                            min = minPoint, max = maxPoint, mesh = data.ToArray(), meshStatus });
                    }
                    catch { failed++; }
                }
            }
            return new { schemaVersion = 1, geometry = "triangle_mesh_with_bounds", units = "mm", coordinateSystem = "revit_internal",
                items = items.ToArray(), coverage = new { examined, exported = items.Count, missingBoundingBox = missing, failed, omittedBudget, truncated,
                    enumerationComplete = !truncated, order = "revit_collector", triangles, meshComplete, meshMissing, meshPartial, meshFailed,
                    triangleLimit = MaxTriangles, elementTriangleLimit = MaxElementTriangles, objectLimit = MaxObjects, elapsedLimitMs = MaxElapsedMs, meshBudgetLimited, serializationLimit = FreezeLimit, serializationReserved = budget.Reserved } };
        }
        internal sealed class Budget
        {
            internal readonly Stopwatch Clock;
            internal int Triangles, Objects;
            internal long Reserved;
            internal Budget(Stopwatch clock, string title, string path)
            {
                Clock = clock;
                Reserved = EnvelopeReserve + ValueReserve + StringCost(title) + StringCost(path);
                if (Reserved > FreezeLimit) throw new InvalidOperationException("Document identity exceeds the snapshot response budget.");
            }
            private static long StringCost(string value) { return value == null ? 0 : 6L * value.Length; }
            internal bool ReserveItem(string id, string uniqueId, string name, string category)
            {
                long cost = ItemReserve + StringCost(id) + StringCost(uniqueId) + StringCost(name) + StringCost(category);
                if (cost > FreezeLimit - Reserved) return false;
                Reserved += cost; return true;
            }
            internal bool ReserveTriangle()
            {
                if (TriangleReserve > FreezeLimit - Reserved) return false;
                Reserved += TriangleReserve; return true;
            }
            internal bool Exhausted { get { return Triangles >= MaxTriangles || Objects >= MaxObjects || Clock.ElapsedMilliseconds >= MaxElapsedMs; } }
        }
        private sealed class MeshState { internal bool Partial, Failed, BudgetLimited; }
        private static void Visit(GeometryElement geometry, Transform transform, List<double> data, MeshState state, Budget budget, int depth)
        {
            if (geometry == null) return;
            if (depth > MaxDepth) { state.Partial = true; return; }
            foreach (GeometryObject obj in geometry)
            {
                if (budget.Exhausted || data.Count / 9 >= MaxElementTriangles) { state.Partial = true; return; }
                budget.Objects++;
                var instance = obj as GeometryInstance;
                if (instance != null) { Visit(instance.GetSymbolGeometry(), transform.Multiply(instance.Transform), data, state, budget, depth + 1); continue; }
                var solid = obj as Solid;
                if (solid != null)
                {
                    foreach (Face face in solid.Faces)
                    {
                        if (budget.Exhausted || data.Count / 9 >= MaxElementTriangles) { state.Partial = true; return; }
                        budget.Objects++;
                        AddMesh(face.Triangulate(), transform, data, state, budget);
                    }
                    continue;
                }
                var mesh = obj as Mesh;
                if (mesh != null) { AddMesh(mesh, transform, data, state, budget); continue; }
                // Curves, points and other geometry are not included in this surface preview.
                state.Partial = true;
            }
        }
        private static void AddMesh(Mesh mesh, Transform transform, List<double> data, MeshState state, Budget budget)
        {
            for (int i = 0; i < mesh.NumTriangles; i++)
            {
                if (budget.Exhausted || data.Count / 9 >= MaxElementTriangles) { state.Partial = true; return; }
                if (!budget.ReserveTriangle()) { state.Partial = true; state.BudgetLimited = true; return; }
                MeshTriangle t = mesh.get_Triangle(i);
                var points = new double[9];
                for (int v = 0; v < 3; v++)
                {
                    XYZ p = transform.OfPoint(t.get_Vertex(v));
                    points[v * 3] = Mm(p.X); points[v * 3 + 1] = Mm(p.Y); points[v * 3 + 2] = Mm(p.Z);
                }
                data.AddRange(points);
                budget.Triangles++;
            }
        }
        private static double Mm(double value)
        {
            double mm = UnitUtils.ConvertFromInternalUnits(value, UnitTypeId.Millimeters);
            if (Double.IsNaN(mm) || Double.IsInfinity(mm) || Math.Abs(mm) > 1000000000) throw new InvalidOperationException("Coordinate outside the snapshot range.");
            return Math.Round(mm, 3);
        }
        private static object Point(XYZ p) { return new { x = Mm(p.X), y = Mm(p.Y), z = Mm(p.Z) }; }
    }
}
