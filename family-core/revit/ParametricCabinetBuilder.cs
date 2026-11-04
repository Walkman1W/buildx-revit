using System;
using System.Collections.Generic;
using System.Globalization;
using Autodesk.Revit.DB;
using BuildX.FamilyCore;

namespace BuildX.FamilyRevit
{
    // The caller owns the fresh family document and its transaction. This
    // builder never saves, loads, closes or touches a project document.
    // Template-specific reference/constraint support must be proven by the
    // native A -> B -> A geometry readback; otherwise the caller rolls back.
    public static class ParametricCabinetBuilder
    {
        public const string FirstTypeName = "BuildX_Cabinet_A";
        public const string SecondTypeName = "BuildX_Cabinet_B";
        private const double MmPerFoot = 304.8, ToleranceMm = 0.05;
        private const string WidthName = "BuildX_Width", DepthName = "BuildX_Depth", HeightName = "BuildX_Height", ThicknessName = "BuildX_Thickness", GapName = "BuildX_DoorGap";
        private sealed class AxisPlane { internal ReferencePlane Plane; internal double Value; }
        private sealed class Panel { internal string Role; internal Extrusion Geometry; internal FamilyParameter Start, End; }

        public static Dictionary<string, object> Build(Document doc, double width, double depth, double height, double thickness, int shelfCount, Action<string> stage)
        {
            Stage(stage, "preflight");
            RequireFamily(doc, true);
            if (!doc.IsModifiable) throw new InvalidOperationException("A caller-owned family transaction is required.");
            CabinetSpec a = new CabinetSpec(width, depth, height, thickness, shelfCount);
            PlanResult supported = CabinetPlanner.CreateSupported(a);
            if (!supported.Ok) throw new ArgumentOutOfRangeException("dimensions", supported.Code + ": " + supported.Message);
            CabinetSpec b = new CabinetSpec(width * 0.95, depth * 0.95, height * 0.95, thickness * 0.95, shelfCount);
            Plan planA = RequirePlan(doc, a), planB = RequirePlan(doc, b);
            FamilyManager manager = doc.FamilyManager;
            foreach (FamilyParameter p in manager.Parameters)
                if (p.Definition.Name.StartsWith("BuildX_", StringComparison.Ordinal)) throw new InvalidOperationException("The fresh template already contains a reserved parameter.");
            foreach (FamilyType type in manager.Types)
                if (type.Name == FirstTypeName || type.Name == SecondTypeName) throw new InvalidOperationException("The fresh template already contains a reserved type.");
            foreach (Element item in new FilteredElementCollector(doc).OfClass(typeof(Extrusion)))
                throw new InvalidOperationException("The cabinet requires a fresh template without existing extrusions.");
            Category category = doc.OwnerFamily.FamilyCategory;
            if (category == null || category.Id.Value != (long)BuiltInCategory.OST_GenericModel)
                throw new InvalidOperationException("The selected template must already be a generic model family.");
            View view = FindPlanView(doc);
            Stage(stage, "parameters");
            FamilyType first = manager.NewType(FirstTypeName);
            FamilyParameter w = Parameter(manager, WidthName, null), d = Parameter(manager, DepthName, null), h = Parameter(manager, HeightName, null), t = Parameter(manager, ThicknessName, null);
            FamilyParameter gap = Parameter(manager, GapName, "2 mm");
            Set(manager, w, d, h, t, a);
            // Each coordinate is driven once by a native labelled reference
            // plane. Dimensions for negative Y are positive lengths to zero.
            var x = new Dictionary<string, AxisPlane>(StringComparer.Ordinal);
            var y = new Dictionary<string, AxisPlane>(StringComparer.Ordinal);
            Stage(stage, "planes");
            x.Add("zero", Plane(doc, view, true, 0)); y.Add("zero", Plane(doc, view, false, 0));
            AddPlane(doc, view, manager, x, true, "t", Feet(thickness), t);
            AddPlane(doc, view, manager, x, true, "wt", Feet(width - thickness), Parameter(manager, "BuildX_X_WidthMinusThickness", WidthName + " - " + ThicknessName));
            AddPlane(doc, view, manager, x, true, "w", Feet(width), w);
            AddPlane(doc, view, manager, x, true, "dl", Feet((width - 2) / 2), Parameter(manager, "BuildX_X_DoorLeft", "(" + WidthName + " - " + GapName + ") / 2"));
            AddPlane(doc, view, manager, x, true, "dr", Feet((width + 2) / 2), Parameter(manager, "BuildX_X_DoorRight", "(" + WidthName + " + " + GapName + ") / 2"));
            AddPlane(doc, view, manager, y, false, "d", Feet(depth), d);
            AddPlane(doc, view, manager, y, false, "dt", Feet(depth - thickness), Parameter(manager, "BuildX_Y_DepthMinusThickness", DepthName + " - " + ThicknessName));
            AddPlane(doc, view, manager, y, false, "minus_t", -Feet(thickness), t);
            FamilyParameter ht = Parameter(manager, "BuildX_Z_HeightMinusThickness", HeightName + " - " + ThicknessName);
            FamilyParameter hg = Parameter(manager, "BuildX_Z_HeightMinusGap", HeightName + " - " + GapName);
            var shelfStarts = new List<FamilyParameter>(); var shelfEnds = new List<FamilyParameter>();
            for (int i = 0; i < shelfCount; i++)
            {
                string n = (i + 1).ToString(CultureInfo.InvariantCulture);
                string clear = "(" + HeightName + " - 2 * " + ThicknessName + " - " + shelfCount.ToString(CultureInfo.InvariantCulture) + " * " + ThicknessName + ") / " + (shelfCount + 1).ToString(CultureInfo.InvariantCulture);
                FamilyParameter start = Parameter(manager, "BuildX_Z_Shelf" + n + "Start", ThicknessName + " + " + n + " * (" + clear + ") + " + i.ToString(CultureInfo.InvariantCulture) + " * " + ThicknessName);
                shelfStarts.Add(start); shelfEnds.Add(Parameter(manager, "BuildX_Z_Shelf" + n + "End", start.Definition.Name + " + " + ThicknessName));
            }
            doc.Regenerate();
            Stage(stage, "panels");
            var panels = new List<Panel>();
            AddPanel(doc, view, manager, panels, "left", x["zero"], x["t"], y["zero"], y["d"], null, h, planA.Panels[0]);
            AddPanel(doc, view, manager, panels, "right", x["wt"], x["w"], y["zero"], y["d"], null, h, planA.Panels[1]);
            AddPanel(doc, view, manager, panels, "bottom", x["t"], x["wt"], y["zero"], y["d"], null, t, planA.Panels[2]);
            AddPanel(doc, view, manager, panels, "top", x["t"], x["wt"], y["zero"], y["d"], ht, h, planA.Panels[3]);
            AddPanel(doc, view, manager, panels, "back", x["t"], x["wt"], y["dt"], y["d"], t, ht, planA.Panels[4]);
            for (int i = 0; i < shelfCount; i++)
                AddPanel(doc, view, manager, panels, "shelf", x["t"], x["wt"], y["zero"], y["dt"], shelfStarts[i], shelfEnds[i], planA.Panels[5 + i]);
            AddPanel(doc, view, manager, panels, "door_left", x["zero"], x["dl"], y["minus_t"], y["zero"], gap, hg, planA.Panels[5 + shelfCount]);
            AddPanel(doc, view, manager, panels, "door_right", x["dr"], x["w"], y["minus_t"], y["zero"], gap, hg, planA.Panels[6 + shelfCount]);
            doc.Regenerate();
            Stage(stage, "validate_A");
            Dictionary<string, object> checkA = Validate(doc, panels, planA, w, d, h, t);
            Stage(stage, "validate_B");
            FamilyType second = manager.NewType(SecondTypeName); Set(manager, w, d, h, t, b); doc.Regenerate();
            Dictionary<string, object> checkB = Validate(doc, panels, planB, w, d, h, t);
            Stage(stage, "restore_A"); manager.CurrentType = first; doc.Regenerate(); Validate(doc, panels, planA, w, d, h, t);
            var checks = new List<Dictionary<string, object>> { checkA, checkB };
            return Map("builder", "BuildX.ParametricCabinet.v1", "parameterization_validated", true, "type_validation", checks,
                "type_names", new List<string> { first.Name, second.Name }, "panel_count", panels.Count,
                "family_document_changed", true, "transaction_owned_by_caller", true, "family_transaction_committed", false,
                "saved", false, "loaded_into_project", false, "created_element_ids_complete", false,
                "limitations", new[] { "Bounded rectangular cabinet; no doors opening, hardware, material, manufacturing or engineering certification.", "Successful transaction, saving and loading are separate outcomes." });
        }

        private static Plan RequirePlan(Document doc, CabinetSpec spec)
        {
            PlanResult value = CabinetPlanner.Create(spec);
            if (!value.Ok) throw new ArgumentException(value.Code + ": " + value.Message);
            foreach (PanelBox panel in value.Value.Panels)
            {
                if (Feet(Math.Min(panel.X1 - panel.X0, Math.Min(panel.Y1 - panel.Y0, panel.Z1 - panel.Z0))) <= doc.Application.ShortCurveTolerance ||
                    !XYZ.IsWithinLengthLimits(new XYZ(Feet(panel.X0), Feet(panel.Y0), Feet(panel.Z0))) ||
                    !XYZ.IsWithinLengthLimits(new XYZ(Feet(panel.X1), Feet(panel.Y1), Feet(panel.Z1))))
                    throw new ArgumentOutOfRangeException("dimensions", "A panel is below Revit short-curve tolerance or outside design limits.");
            }
            return value.Value;
        }
        private static AxisPlane Plane(Document doc, View view, bool alongX, double value)
        {
            XYZ a = alongX ? new XYZ(value, -1, 0) : new XYZ(-1, value, 0);
            XYZ b = alongX ? new XYZ(value, 1, 0) : new XYZ(1, value, 0);
            // NewReferencePlane expects a cut vector; NewReferencePlane2 takes
            // an absolute third point and would tilt a plane away from zero.
            ReferencePlane plane = doc.FamilyCreate.NewReferencePlane(a, b, XYZ.BasisZ, view);
            if (plane == null || plane.GetReference() == null) throw new InvalidOperationException("The template cannot create a reference plane.");
            return new AxisPlane { Plane = plane, Value = value };
        }
        private static void AddPlane(Document doc, View view, FamilyManager manager, Dictionary<string, AxisPlane> axes, bool alongX, string key, double value, FamilyParameter label)
        {
            AxisPlane plane = Plane(doc, view, alongX, value); axes.Add(key, plane);
            if (value == 0) throw new InvalidOperationException("A driven reference plane must be distinct from zero.");
            ReferenceArray refs = new ReferenceArray();
            if (value < 0) { refs.Append(plane.Plane.GetReference()); refs.Append(axes["zero"].Plane.GetReference()); }
            else { refs.Append(axes["zero"].Plane.GetReference()); refs.Append(plane.Plane.GetReference()); }
            Line line = alongX ? Line.CreateBound(new XYZ(Math.Min(0, value), -2, 0), new XYZ(Math.Max(0, value), -2, 0)) :
                Line.CreateBound(new XYZ(-2, Math.Min(0, value), 0), new XYZ(-2, Math.Max(0, value), 0));
            Dimension dimension = doc.FamilyCreate.NewDimension(view, line, refs);
            if (dimension == null) throw new InvalidOperationException("The template cannot create a driving reference-plane dimension.");
            dimension.FamilyLabel = label;
            if (dimension.FamilyLabel == null || dimension.FamilyLabel.Id != label.Id) throw new InvalidOperationException("The native dimension label was not bound.");
        }
        private static FamilyParameter Parameter(FamilyManager manager, string name, string formula)
        {
            FamilyParameter value = manager.AddParameter(name, GroupTypeId.Geometry, SpecTypeId.Length, false);
            if (formula != null) manager.SetFormula(value, formula);
            return value;
        }
        private static void Set(FamilyManager manager, FamilyParameter w, FamilyParameter d, FamilyParameter h, FamilyParameter t, CabinetSpec spec)
        { manager.Set(w, Feet(spec.WidthMm)); manager.Set(d, Feet(spec.DepthMm)); manager.Set(h, Feet(spec.HeightMm)); manager.Set(t, Feet(spec.ThicknessMm)); }
        private static void Associate(FamilyManager manager, Parameter target, FamilyParameter source)
        {
            if (target == null || !manager.CanElementParameterBeAssociated(target)) throw new InvalidOperationException("A panel extrusion parameter cannot be associated.");
            manager.AssociateElementParameterToFamilyParameter(target, source);
        }
        private static void AddPanel(Document doc, View view, FamilyManager manager, List<Panel> panels, string role,
            AxisPlane x0, AxisPlane x1, AxisPlane y0, AxisPlane y1, FamilyParameter start, FamilyParameter end, PanelBox expected)
        {
            var points = new[] { new XYZ(x0.Value, y0.Value, 0), new XYZ(x1.Value, y0.Value, 0), new XYZ(x1.Value, y1.Value, 0), new XYZ(x0.Value, y1.Value, 0) };
            CurveArray profile = new CurveArray(); for (int i = 0; i < 4; i++) profile.Append(Line.CreateBound(points[i], points[(i + 1) % 4]));
            CurveArrArray loops = new CurveArrArray(); loops.Append(profile);
            SketchPlane sketch = SketchPlane.Create(doc, Autodesk.Revit.DB.Plane.CreateByNormalAndOrigin(XYZ.BasisZ, XYZ.Zero));
            Extrusion extrusion = doc.FamilyCreate.NewExtrusion(true, loops, sketch, Feet(expected.Z1));
            Associate(manager, extrusion.get_Parameter(BuiltInParameter.EXTRUSION_END_PARAM), end);
            if (start != null) Associate(manager, extrusion.get_Parameter(BuiltInParameter.EXTRUSION_START_PARAM), start);
            doc.Regenerate();
            Reference[] edges = Edges(doc, extrusion, x0.Value, x1.Value, y0.Value, y1.Value);
            AxisPlane[] planes = { x0, x1, y0, y1 };
            for (int i = 0; i < 4; i++) if (doc.FamilyCreate.NewAlignment(view, planes[i].Plane.GetReference(), edges[i]) == null)
                throw new InvalidOperationException("The template cannot constrain a panel sketch to its reference plane.");
            panels.Add(new Panel { Role = role, Geometry = extrusion, Start = start, End = end });
        }
        private static Reference[] Edges(Document doc, Extrusion extrusion, double x0, double x1, double y0, double y1)
        {
            if (extrusion.Sketch == null) throw new InvalidOperationException("Panel sketch is unavailable.");
            var result = new Reference[4]; double epsilon = Feet(ToleranceMm);
            foreach (ElementId id in extrusion.Sketch.GetAllElements())
            {
                ModelCurve curve = doc.GetElement(id) as ModelCurve; Line line = curve == null ? null : curve.GeometryCurve as Line;
                if (line == null || line.Reference == null) continue;
                XYZ a = line.GetEndPoint(0), b = line.GetEndPoint(1); int index = -1;
                if (Math.Abs(a.X - b.X) < epsilon && Math.Abs(a.X - x0) < epsilon) index = 0;
                else if (Math.Abs(a.X - b.X) < epsilon && Math.Abs(a.X - x1) < epsilon) index = 1;
                else if (Math.Abs(a.Y - b.Y) < epsilon && Math.Abs(a.Y - y0) < epsilon) index = 2;
                else if (Math.Abs(a.Y - b.Y) < epsilon && Math.Abs(a.Y - y1) < epsilon) index = 3;
                if (index >= 0) { if (result[index] != null) throw new InvalidOperationException("Panel sketch references are ambiguous."); result[index] = line.Reference; }
            }
            foreach (Reference item in result) if (item == null) throw new InvalidOperationException("Panel sketch does not expose all required references.");
            return result;
        }
        private static Dictionary<string, object> Validate(Document doc, List<Panel> panels, Plan expected, FamilyParameter w, FamilyParameter d, FamilyParameter h, FamilyParameter t)
        {
            FamilyManager manager = doc.FamilyManager; FamilyType type = manager.CurrentType;
            if (type == null) throw new InvalidOperationException("The current family type is unknown.");
            Near(Value(type, w), expected.Spec.WidthMm); Near(Value(type, d), expected.Spec.DepthMm); Near(Value(type, h), expected.Spec.HeightMm); Near(Value(type, t), expected.Spec.ThicknessMm);
            if (panels.Count != expected.Panels.Count) throw new InvalidOperationException("The panel count changed.");
            var output = new List<Dictionary<string, object>>();
            for (int i = 0; i < panels.Count; i++)
            {
                Panel panel = panels[i]; PanelBox box = expected.Panels[i];
                if (panel.Role != box.Role) throw new InvalidOperationException("Panel identity changed.");
                Parameter end = panel.Geometry.get_Parameter(BuiltInParameter.EXTRUSION_END_PARAM), start = panel.Geometry.get_Parameter(BuiltInParameter.EXTRUSION_START_PARAM);
                FamilyParameter endAssociated = end == null ? null : manager.GetAssociatedFamilyParameter(end);
                FamilyParameter startAssociated = start == null ? null : manager.GetAssociatedFamilyParameter(start);
                if (endAssociated == null || endAssociated.Id != panel.End.Id || panel.Start != null && (startAssociated == null || startAssociated.Id != panel.Start.Id))
                    throw new InvalidOperationException("A native panel extrusion association changed.");
                double[] bounds = Bounds(panel.Geometry); double[] target = { box.X0, box.Y0, box.Z0, box.X1, box.Y1, box.Z1 };
                for (int j = 0; j < 6; j++) Near(bounds[j], target[j]);
                double volume = Volume(panel.Geometry), wanted = box.VolumeMm3;
                if (Math.Abs(volume - wanted) > Math.Max(1, wanted * 0.00001)) throw new InvalidOperationException("A panel solid volume did not follow its parameters.");
                output.Add(Map("role", panel.Role, "element_id", panel.Geometry.Id.Value.ToString(CultureInfo.InvariantCulture), "bounds_mm", bounds, "volume_mm3", volume));
            }
            return Map("type_name", type.Name, "panels", output, "regenerated_and_read_back", true, "tolerance_mm", ToleranceMm, "passed", true);
        }
        public static Dictionary<string, object> Inspect(Document doc)
        {
            RequireFamily(doc, false); FamilyManager manager = doc.FamilyManager;
            var types = new List<Dictionary<string, object>>();
            foreach (FamilyType type in manager.Types)
                types.Add(Map("name", type.Name, "width_mm", OptionalValue(type, manager.get_Parameter(WidthName)), "depth_mm", OptionalValue(type, manager.get_Parameter(DepthName)),
                    "height_mm", OptionalValue(type, manager.get_Parameter(HeightName)), "thickness_mm", OptionalValue(type, manager.get_Parameter(ThicknessName))));
            int count = 0; foreach (Element item in new FilteredElementCollector(doc).OfClass(typeof(Extrusion))) count++;
            Category category = doc.OwnerFamily.FamilyCategory;
            return Map("builder", "BuildX.ParametricCabinet.v1", "family_document", true, "family_name", doc.OwnerFamily.Name,
                "category_id", category == null ? null : category.Id.Value.ToString(CultureInfo.InvariantCulture), "current_type", manager.CurrentType == null ? null : manager.CurrentType.Name,
                "types", types, "panel_count", count, "fresh_regeneration_performed", false, "parameterization_validated_by_inspection", false);
        }
        // Read-only verification after SaveAs and independent reopen. It never
        // changes CurrentType or claims a second native flex was performed.
        public static void VerifyReopened(Document doc, CabinetSpec spec)
        {
            RequireFamily(doc, false); Plan expected = RequirePlan(doc, spec); FamilyManager manager = doc.FamilyManager;
            if (doc.OwnerFamily.FamilyCategory == null || doc.OwnerFamily.FamilyCategory.Id.Value != (long)BuiltInCategory.OST_GenericModel)
                throw new InvalidOperationException("Reopened cabinet category is not generic model.");
            FamilyParameter w = manager.get_Parameter(WidthName), d = manager.get_Parameter(DepthName), h = manager.get_Parameter(HeightName), t = manager.get_Parameter(ThicknessName);
            if (w == null || d == null || h == null || t == null || manager.CurrentType == null || manager.CurrentType.Name != FirstTypeName)
                throw new InvalidOperationException("Reopened cabinet parameters or current type are missing.");
            FamilyType first = null, second = null;
            foreach (FamilyType type in manager.Types) { if (type.Name == FirstTypeName) first = type; if (type.Name == SecondTypeName) second = type; }
            if (first == null || second == null) throw new InvalidOperationException("Reopened cabinet types are missing.");
            Near(Value(first, w), spec.WidthMm); Near(Value(first, d), spec.DepthMm); Near(Value(first, h), spec.HeightMm); Near(Value(first, t), spec.ThicknessMm);
            Near(Value(second, w), spec.WidthMm * 0.95); Near(Value(second, d), spec.DepthMm * 0.95); Near(Value(second, h), spec.HeightMm * 0.95); Near(Value(second, t), spec.ThicknessMm * 0.95);
            var seen = new bool[expected.Panels.Count]; int count = 0;
            foreach (Element item in new FilteredElementCollector(doc).OfClass(typeof(Extrusion)))
            {
                Extrusion extrusion = item as Extrusion; if (extrusion == null) throw new InvalidOperationException("Unexpected cabinet geometry.");
                double[] observed = Bounds(extrusion); double volume = Volume(extrusion); int match = -1;
                for (int i = 0; i < expected.Panels.Count; i++)
                {
                    if (seen[i]) continue; PanelBox box = expected.Panels[i];
                    double[] target = { box.X0, box.Y0, box.Z0, box.X1, box.Y1, box.Z1 }; bool same = true;
                    for (int j = 0; j < 6; j++) if (Math.Abs(observed[j] - target[j]) > ToleranceMm) { same = false; break; }
                    if (same && Math.Abs(volume - box.VolumeMm3) <= Math.Max(1, box.VolumeMm3 * 0.00001)) { if (match >= 0) throw new InvalidOperationException("Reopened panel identity is ambiguous."); match = i; }
                }
                if (match < 0) throw new InvalidOperationException("Reopened panel does not match saved dimensions.");
                Parameter end = extrusion.get_Parameter(BuiltInParameter.EXTRUSION_END_PARAM);
                if (end == null || manager.GetAssociatedFamilyParameter(end) == null) throw new InvalidOperationException("Reopened panel parameter association is missing.");
                seen[match] = true; count++;
            }
            if (count != expected.Panels.Count) throw new InvalidOperationException("Reopened panel count is incomplete.");
        }
        private static View FindPlanView(Document doc)
        {
            View selected = null;
            foreach (Element item in new FilteredElementCollector(doc).OfClass(typeof(View)))
            {
                View view = item as View;
                if (view != null && !view.IsTemplate && (view.ViewType == ViewType.FloorPlan || view.ViewType == ViewType.CeilingPlan) &&
                    Math.Abs(view.ViewDirection.Normalize().DotProduct(XYZ.BasisZ)) > 0.9999 && (selected == null || view.Id.Value < selected.Id.Value)) selected = view;
            }
            if (selected == null) throw new InvalidOperationException("The template has no suitable plan view."); return selected;
        }
        private static double[] Bounds(Extrusion extrusion)
        {
            BoundingBoxXYZ box = extrusion.get_BoundingBox(null); if (box == null) throw new InvalidOperationException("A panel bounding box is unavailable.");
            XYZ min = null, max = null;
            for (int x = 0; x < 2; x++) for (int y = 0; y < 2; y++) for (int z = 0; z < 2; z++)
            {
                XYZ p = box.Transform.OfPoint(new XYZ(x == 0 ? box.Min.X : box.Max.X, y == 0 ? box.Min.Y : box.Max.Y, z == 0 ? box.Min.Z : box.Max.Z));
                min = min == null ? p : new XYZ(Math.Min(min.X, p.X), Math.Min(min.Y, p.Y), Math.Min(min.Z, p.Z));
                max = max == null ? p : new XYZ(Math.Max(max.X, p.X), Math.Max(max.Y, p.Y), Math.Max(max.Z, p.Z));
            }
            return new[] { min.X * MmPerFoot, min.Y * MmPerFoot, min.Z * MmPerFoot, max.X * MmPerFoot, max.Y * MmPerFoot, max.Z * MmPerFoot };
        }
        private static double Volume(Extrusion extrusion)
        {
            GeometryElement geometry = extrusion.get_Geometry(new Options { DetailLevel = ViewDetailLevel.Fine });
            if (geometry == null) throw new InvalidOperationException("Panel geometry is unavailable.");
            double volume = 0; foreach (GeometryObject item in geometry) { Solid solid = item as Solid; if (solid != null && solid.Volume > 0) volume += solid.Volume; }
            if (volume <= 0) throw new InvalidOperationException("Panel solid volume is unavailable."); return volume * MmPerFoot * MmPerFoot * MmPerFoot;
        }
        private static double Value(FamilyType type, FamilyParameter parameter)
        { double? value = type.AsDouble(parameter); if (!value.HasValue) throw new InvalidOperationException("A family parameter value is unknown."); return value.Value * MmPerFoot; }
        private static object OptionalValue(FamilyType type, FamilyParameter parameter) { return parameter == null || !type.AsDouble(parameter).HasValue ? null : (object)(type.AsDouble(parameter).Value * MmPerFoot); }
        private static void Near(double actual, double expected) { if (Double.IsNaN(actual) || Double.IsInfinity(actual) || Math.Abs(actual - expected) > ToleranceMm) throw new InvalidOperationException("Panel geometry did not follow its family parameters."); }
        private static void RequireFamily(Document doc, bool editable)
        { if (doc == null || !doc.IsValidObject || !doc.IsFamilyDocument || doc.IsLinked || editable && doc.IsReadOnly || doc.OwnerFamily == null) throw new InvalidOperationException("A valid family document in the required edit state is required."); }
        private static double Feet(double mm) { return mm / MmPerFoot; }
        private static Dictionary<string, object> Map(params object[] pairs) { var result = new Dictionary<string, object>(StringComparer.Ordinal); for (int i = 0; i < pairs.Length; i += 2) result.Add((string)pairs[i], pairs[i + 1]); return result; }
        private static void Stage(Action<string> observer, string phase) { if (observer != null) observer(phase); }
    }
}
