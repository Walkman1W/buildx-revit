using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        private sealed class MirrorExpectation { internal ElementId Source, Copy, Type, Level; internal string SourceUnique, CopyUnique; internal XYZ Origin, X, Y, Z; }
        private static XYZ MirrorNormal(Dictionary<string, object> args)
        {
            var raw = Required(args, "plane_normal") as Dictionary<string, object>;
            if (raw == null || raw.Count != 3 || !raw.ContainsKey("x") || !raw.ContainsKey("y") || !raw.ContainsKey("z")) throw new InvalidOperationException("plane_normal must contain x, y and z.");
            XYZ n = new XYZ(FiniteNumber(raw["x"], "x"), FiniteNumber(raw["y"], "y"), FiniteNumber(raw["z"], "z"));
            if (Math.Abs(n.Z) > 0.000001 || Math.Abs(n.GetLength()-1) > 0.000001) throw new InvalidOperationException("plane_normal must be a horizontal unit vector.");
            return n;
        }
        private static FamilyInstance MirrorCandidate(Document doc, ElementId id)
        {
            FamilyInstance f = doc.GetElement(id) as FamilyInstance;
            if (f == null || !f.IsValidObject || String.IsNullOrEmpty(f.UniqueId) || f.Symbol == null || f.Symbol.Family == null
                || f.Symbol.Family.FamilyPlacementType != FamilyPlacementType.OneLevelBased || f.Host != null || f.GroupId == null || f.GroupId.Value != ElementId.InvalidElementId.Value
                || f.Pinned || !(f.Location is LocationPoint) || f.GetTypeId() == null || f.GetTypeId().Value <= 0 || f.LevelId == null || f.LevelId.Value <= 0
                || f.GetSubComponentIds().Count != 0 || f.SuperComponent != null)
                throw new InvalidOperationException("Only unhosted, ungrouped, unpinned OneLevelBased point family instances without nested components are supported.");
            return f;
        }
        private static XYZ Reflect(XYZ v, XYZ normal) { return v.Subtract(normal.Multiply(2*v.DotProduct(normal))); }
        private static MirrorExpectation MirrorOne(Document doc, Dictionary<string, object> args)
        {
            Fields(args, "expected_document", "mode", "element_id", "plane_origin_mm", "plane_normal");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Mirror requires a project document.");
            FamilyInstance source = MirrorCandidate(doc,new ElementId(NativeModelQueries.ExactId(args,"element_id")));
            XYZ origin=MillimeterPoint(Required(args,"plane_origin_mm"),"plane_origin_mm"), normal=MirrorNormal(args);
            if (!XYZ.IsWithinLengthLimits(origin) || !ElementTransformUtils.CanMirrorElement(doc,source.Id)) throw new InvalidOperationException("Invalid mirror plane origin or element cannot be mirrored.");
            Transform t=source.GetTransform(); if (t == null) throw new InvalidOperationException("Source transform is unavailable.");
            var expected=new MirrorExpectation { Source=source.Id, SourceUnique=source.UniqueId, Type=source.GetTypeId(), Level=source.LevelId, Origin=t.Origin, X=t.BasisX, Y=t.BasisY, Z=t.BasisZ };
            var ids=ElementTransformUtils.MirrorElements(doc,new List<ElementId>{source.Id},Plane.CreateByNormalAndOrigin(normal,origin),true);
            if (ids == null || ids.Count != 1) throw new InvalidOperationException("Mirror did not return exactly one copy; dependencies are unsupported.");
            foreach (ElementId id in ids) expected.Copy=id;
            FamilyInstance copy=MirrorCandidate(doc,expected.Copy);
            if (copy.Id.Value == source.Id.Value || copy.UniqueId == source.UniqueId) throw new InvalidOperationException("Mirror copy identity is not distinct.");
            expected.CopyUnique=copy.UniqueId; doc.Regenerate(); VerifyMirror(doc,args,expected); return expected;
        }
        private static object VerifyMirror(Document doc, Dictionary<string, object> args, MirrorExpectation e)
        {
            FamilyInstance source=MirrorCandidate(doc,e.Source), copy=MirrorCandidate(doc,e.Copy);
            if (source.UniqueId!=e.SourceUnique || copy.UniqueId!=e.CopyUnique || source.GetTypeId().Value!=e.Type.Value || copy.GetTypeId().Value!=e.Type.Value || source.LevelId.Value!=e.Level.Value || copy.LevelId.Value!=e.Level.Value)
                throw new InvalidOperationException("Mirror identity, type or level changed.");
            Transform a=source.GetTransform(), b=copy.GetTransform(); XYZ normal=MirrorNormal(args), plane=MillimeterPoint(Required(args,"plane_origin_mm"),"plane_origin_mm");
            XYZ target=plane.Add(Reflect(e.Origin.Subtract(plane),normal));
            if (a==null || b==null || a.Origin.DistanceTo(e.Origin)>Feet(0.001) || a.BasisX.DistanceTo(e.X)>1e-8 || a.BasisY.DistanceTo(e.Y)>1e-8 || a.BasisZ.DistanceTo(e.Z)>1e-8
                || b.Origin.DistanceTo(target)>Feet(0.001) || b.BasisX.DistanceTo(Reflect(e.X,normal))>1e-8 || b.BasisY.DistanceTo(Reflect(e.Y,normal))>1e-8 || b.BasisZ.DistanceTo(Reflect(e.Z,normal))>1e-8)
                throw new InvalidOperationException("Source or mirrored copy transform did not match reflection.");
            return new { element_id=DescribedId(copy.Id), source_element_id=DescribedId(source.Id), type_id=DescribedId(e.Type), level_id=DescribedId(e.Level), source_position_mm=PointDto(a.Origin), position_mm=PointDto(b.Origin), source_basis_x=VectorDto(a.BasisX), source_basis_y=VectorDto(a.BasisY), source_basis_z=VectorDto(a.BasisZ), basis_x=VectorDto(b.BasisX), basis_y=VectorDto(b.BasisY), basis_z=VectorDto(b.BasisZ) };
        }
        private static object VectorDto(XYZ p) { return new { x=p.X,y=p.Y,z=p.Z }; }
    }
}
