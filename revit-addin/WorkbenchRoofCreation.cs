using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        private sealed class RoofCreationExpectation { internal ElementId Id; internal string UniqueId; internal List<ElementId> Edges; }
        private static XYZ[] RoofCorners(Document doc, Dictionary<string, object> args)
        {
            Level level = RequiredElement(doc, NativeModelQueries.ExactId(args, "level_id")) as Level;
            if (level == null || !level.IsValidObject) throw new InvalidOperationException("level_id must identify a valid level.");
            var xy = Required(args, "origin_xy_mm") as Dictionary<string, object>;
            if (xy == null || xy.Count != 2 || !xy.ContainsKey("x") || !xy.ContainsKey("y")) throw new InvalidOperationException("origin_xy_mm must contain x and y.");
            double x = Feet(FiniteNumber(xy["x"], "x")), y = Feet(FiniteNumber(xy["y"], "y"));
            double width = Feet(FiniteNumber(Required(args, "width_mm"), "width_mm")), depth = Feet(FiniteNumber(Required(args, "depth_mm"), "depth_mm"));
            if (width < Feet(100) || depth < Feet(100) || width > Feet(1000000) || depth > Feet(1000000)) throw new InvalidOperationException("Roof dimensions must be 100..1000000 mm.");
            double z = level.ProjectElevation;
            XYZ[] corners = { new XYZ(x,y,z), new XYZ(x+width,y,z), new XYZ(x+width,y+depth,z), new XYZ(x,y+depth,z) };
            if (corners.Any(p => !XYZ.IsWithinLengthLimits(p))) throw new InvalidOperationException("Roof footprint exceeds Revit coordinate limits.");
            return corners;
        }
        private static RoofCreationExpectation CreateFlatRoof(UIApplication uiapp, Dictionary<string, object> args)
        {
            Document doc = uiapp.ActiveUIDocument.Document;
            Fields(args, "expected_document", "mode", "roof_type_id", "level_id", "origin_xy_mm", "width_mm", "depth_mm");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Roofs require a project document.");
            RoofType type = RequiredElement(doc, NativeModelQueries.ExactId(args, "roof_type_id")) as RoofType;
            Level level = RequiredElement(doc, NativeModelQueries.ExactId(args, "level_id")) as Level;
            if (type == null || !type.IsValidObject || level == null || !level.IsValidObject) throw new InvalidOperationException("A valid roof type and level are required.");
            XYZ[] c = RoofCorners(doc, args); var curves = new CurveArray();
            for (int i = 0; i < 4; i++) { CheckCurveLength(uiapp, c[i], c[(i+1)%4]); curves.Append(Line.CreateBound(c[i], c[(i+1)%4])); }
            ModelCurveArray modelCurves; FootPrintRoof roof = doc.Create.NewFootPrintRoof(curves, level, type, out modelCurves);
            if (roof == null || !roof.IsValidObject || String.IsNullOrEmpty(roof.UniqueId) || modelCurves == null || modelCurves.Size != 4) throw new InvalidOperationException("Roof or footprint identities unavailable.");
            var edges = new List<ElementId>();
            foreach (ModelCurve curve in modelCurves) { if (curve == null || !curve.IsValidObject) throw new InvalidOperationException("Roof edge is invalid."); roof.set_DefinesSlope(curve, false); edges.Add(curve.Id); }
            var expected = new RoofCreationExpectation { Id = roof.Id, UniqueId = roof.UniqueId, Edges = edges };
            doc.Regenerate(); VerifyFlatRoof(doc, args, expected); return expected;
        }
        private static object VerifyFlatRoof(Document doc, Dictionary<string, object> args, RoofCreationExpectation expected)
        {
            FootPrintRoof roof = doc.GetElement(expected.Id) as FootPrintRoof;
            long typeId = NativeModelQueries.ExactId(args, "roof_type_id"), levelId = NativeModelQueries.ExactId(args, "level_id");
            if (roof == null || !roof.IsValidObject || roof.UniqueId != expected.UniqueId || roof.GetTypeId().Value != typeId || roof.LevelId.Value != levelId)
                throw new InvalidOperationException("Roof identity, type or level changed.");
            Parameter offset = roof.get_Parameter(BuiltInParameter.ROOF_LEVEL_OFFSET_PARAM);
            if (offset == null || offset.StorageType != StorageType.Double || !offset.HasValue || Math.Abs(offset.AsDouble()) > Feet(0.001)) throw new InvalidOperationException("Roof level offset is not zero.");
            foreach (ElementId id in expected.Edges) { ModelCurve edge = doc.GetElement(id) as ModelCurve; if (edge == null || !edge.IsValidObject || roof.get_DefinesSlope(edge)) throw new InvalidOperationException("Roof slope-defining edge changed."); }
            var profiles = roof.GetProfiles(); XYZ[] corners = RoofCorners(doc, args);
            if (profiles == null || profiles.Size != 1) throw new InvalidOperationException("Roof footprint must have one loop.");
            var curves = new List<ModelCurve>(); foreach (ModelCurveArray loop in profiles) foreach (ModelCurve curve in loop) curves.Add(curve);
            if (curves.Count != 4 || curves.Any(curve => curve == null || !curve.IsValidObject || roof.get_DefinesSlope(curve))) throw new InvalidOperationException("Roof footprint must have four non-sloped edges.");
            bool[] matched = new bool[4]; XYZ[] observedCorners = new XYZ[4]; double tolerance = Feet(0.001);
            foreach (ModelCurve curve in curves)
            {
                Line line = curve.GeometryCurve as Line; if (line == null || !line.IsBound) throw new InvalidOperationException("Roof footprint edge is not straight.");
                XYZ a = line.GetEndPoint(0), b = line.GetEndPoint(1); int match = -1;
                for (int i=0;i<4;i++) if (!matched[i] && ((a.DistanceTo(corners[i])<=tolerance && b.DistanceTo(corners[(i+1)%4])<=tolerance) || (b.DistanceTo(corners[i])<=tolerance && a.DistanceTo(corners[(i+1)%4])<=tolerance))) { match=i; break; }
                if (match < 0) throw new InvalidOperationException("Roof footprint differs from requested rectangle.");
                matched[match] = true; observedCorners[match] = a.DistanceTo(corners[match]) <= tolerance ? a : b;
            }
            return new { element_id = DescribedId(roof.Id), roof_type_id = DescribedId(roof.GetTypeId()), level_id = DescribedId(roof.LevelId), origin_xy_mm = new { x = Millimeters(observedCorners[0].X), y = Millimeters(observedCorners[0].Y) }, width_mm = Millimeters(observedCorners[0].DistanceTo(observedCorners[1])), depth_mm = Millimeters(observedCorners[1].DistanceTo(observedCorners[2])), slope = 0 };
        }
    }
}
