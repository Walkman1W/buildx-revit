using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        private sealed class BeamCreationExpectation { internal ElementId Id; internal string UniqueId; }
        private static BeamCreationExpectation CreateBeam(UIApplication uiapp, Dictionary<string, object> args)
        {
            Document doc = uiapp.ActiveUIDocument.Document;
            Fields(args, "expected_document", "mode", "symbol_id", "level_id", "start_mm", "end_mm");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Beams require a project document.");
            FamilySymbol symbol = RequiredElement(doc, NativeModelQueries.ExactId(args, "symbol_id")) as FamilySymbol;
            Level level = RequiredElement(doc, NativeModelQueries.ExactId(args, "level_id")) as Level;
            if (symbol == null || !symbol.IsValidObject || symbol.Family == null || symbol.Category == null
                || symbol.Category.Id.Value != (long)BuiltInCategory.OST_StructuralFraming
                || symbol.Family.FamilyPlacementType != FamilyPlacementType.CurveDrivenStructural)
                throw new InvalidOperationException("symbol_id must identify a loaded curve-driven structural framing FamilySymbol.");
            if (level == null || !level.IsValidObject) throw new InvalidOperationException("level_id must identify a valid level.");
            XYZ start = MillimeterPoint(Required(args, "start_mm"), "start_mm"), end = MillimeterPoint(Required(args, "end_mm"), "end_mm");
            if (!XYZ.IsWithinLengthLimits(start) || !XYZ.IsWithinLengthLimits(end)) throw new InvalidOperationException("Beam endpoints exceed Revit coordinate limits.");
            CheckCurveLength(uiapp, start, end);
            if (!symbol.IsActive) { symbol.Activate(); doc.Regenerate(); }
            FamilyInstance beam = doc.Create.NewFamilyInstance(Line.CreateBound(start, end), symbol, level, StructuralType.Beam);
            if (beam == null || !beam.IsValidObject || String.IsNullOrEmpty(beam.UniqueId)) throw new InvalidOperationException("Beam creation did not return a stable instance.");
            var expected = new BeamCreationExpectation { Id = beam.Id, UniqueId = beam.UniqueId };
            doc.Regenerate(); VerifyBeam(doc, args, expected);
            return expected;
        }
        private static object VerifyBeam(Document doc, Dictionary<string, object> args, BeamCreationExpectation expected)
        {
            FamilyInstance beam = doc.GetElement(expected.Id) as FamilyInstance;
            long symbolId = NativeModelQueries.ExactId(args, "symbol_id"), levelId = NativeModelQueries.ExactId(args, "level_id");
            Parameter reference = beam == null ? null : beam.get_Parameter(BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM);
            ElementId actualLevel = reference == null || reference.StorageType != StorageType.ElementId || !reference.HasValue ? null : reference.AsElementId();
            if (beam == null || !beam.IsValidObject || !String.Equals(beam.UniqueId, expected.UniqueId, StringComparison.Ordinal)
                || beam.StructuralType != StructuralType.Beam || beam.Host != null || beam.GetTypeId().Value != symbolId
                || actualLevel == null || actualLevel.Value != levelId)
                throw new InvalidOperationException("Beam identity, type, level, structural role or host changed.");
            LocationCurve location = beam.Location as LocationCurve;
            Line line = location == null ? null : location.Curve as Line;
            if (line == null || !line.IsBound) throw new InvalidOperationException("Beam location is not a bound straight line.");
            XYZ requestedStart = MillimeterPoint(Required(args, "start_mm"), "start_mm"), requestedEnd = MillimeterPoint(Required(args, "end_mm"), "end_mm");
            XYZ a = line.GetEndPoint(0), b = line.GetEndPoint(1); double tolerance = Feet(0.001);
            if (a.DistanceTo(requestedStart) <= tolerance && b.DistanceTo(requestedEnd) <= tolerance) { }
            else if (b.DistanceTo(requestedStart) <= tolerance && a.DistanceTo(requestedEnd) <= tolerance) { XYZ tmp = a; a = b; b = tmp; }
            else throw new InvalidOperationException("Beam centerline readback differs from the requested endpoints.");
            return new { element_id = DescribedId(beam.Id), symbol_id = DescribedId(beam.GetTypeId()), level_id = DescribedId(actualLevel), start_mm = PointDto(a), end_mm = PointDto(b) };
        }
    }
}
