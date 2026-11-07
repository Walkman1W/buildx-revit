using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        private sealed class DimensionCreationExpectation { internal ElementId Id; internal string UniqueId; }
        private static Reference DimensionReference(Document doc, Dictionary<string,object> args, string key)
        {
            string stable=Required(args,key) as string;
            if(String.IsNullOrWhiteSpace(stable) || stable.Length>2048 || stable!=stable.Trim() || stable.IndexOfAny(new[]{'\0','\r','\n'})>=0) throw new InvalidOperationException("Reference must be a bounded exact stable representation.");
            Reference reference=Reference.ParseFromStableRepresentation(doc,stable);
            if(reference==null || reference.ElementId==null || reference.ElementId.Value<=0 || reference.LinkedElementId==null || reference.LinkedElementId.Value!=ElementId.InvalidElementId.Value || reference.ElementReferenceType!=ElementReferenceType.REFERENCE_TYPE_SURFACE || reference.ConvertToStableRepresentation(doc)!=stable)
                throw new InvalidOperationException("Reference must be an exact local surface reference.");
            Element element=doc.GetElement(reference.ElementId);
            if(element==null || !element.IsValidObject || element.Document==null || !element.Document.Equals(doc) || !(element.GetGeometryObjectFromReference(reference) is PlanarFace)) throw new InvalidOperationException("Reference does not resolve to a local planar face.");
            return reference;
        }
        private static DimensionCreationExpectation CreateLinearDimension(UIApplication uiapp, Dictionary<string,object> args)
        {
            Document doc=uiapp.ActiveUIDocument.Document; Fields(args,"expected_document","mode","view_id","reference_a","reference_b","start_mm","end_mm");
            if(doc.IsFamilyDocument) throw new InvalidOperationException("Dimensions require a project document.");
            long viewId=NativeModelQueries.ExactId(args,"view_id"); View view=RequiredElement(doc,viewId) as View;
            if(view==null || !view.IsValidObject || view.IsTemplate || uiapp.ActiveUIDocument.ActiveView==null || uiapp.ActiveUIDocument.ActiveView.Id.Value!=viewId
                || !(view.ViewType==ViewType.FloorPlan || view.ViewType==ViewType.CeilingPlan || view.ViewType==ViewType.Section || view.ViewType==ViewType.Elevation)) throw new InvalidOperationException("view_id must identify the active supported plan, section or elevation view.");
            Reference first=DimensionReference(doc,args,"reference_a"), second=DimensionReference(doc,args,"reference_b");
            if(first.ConvertToStableRepresentation(doc)==second.ConvertToStableRepresentation(doc)) throw new InvalidOperationException("Two distinct references are required.");
            XYZ start=MillimeterPoint(Required(args,"start_mm"),"start_mm"), end=MillimeterPoint(Required(args,"end_mm"),"end_mm");
            if(!XYZ.IsWithinLengthLimits(start)||!XYZ.IsWithinLengthLimits(end)) throw new InvalidOperationException("Dimension line exceeds coordinate limits.");
            CheckCurveLength(uiapp,start,end); if(Math.Abs(end.Subtract(start).Normalize().DotProduct(view.ViewDirection.Normalize()))>1e-8) throw new InvalidOperationException("Dimension line must be parallel to the active view plane.");
            var references=new ReferenceArray(); references.Append(first); references.Append(second);
            Dimension dimension=doc.Create.NewDimension(view,Line.CreateBound(start,end),references);
            if(dimension==null || !dimension.IsValidObject || String.IsNullOrEmpty(dimension.UniqueId)) throw new InvalidOperationException("Dimension identity is unavailable.");
            var expected=new DimensionCreationExpectation { Id=dimension.Id,UniqueId=dimension.UniqueId }; doc.Regenerate(); VerifyLinearDimension(doc,args,expected); return expected;
        }
        private static object VerifyLinearDimension(Document doc, Dictionary<string,object> args, DimensionCreationExpectation expected)
        {
            Dimension dimension=doc.GetElement(expected.Id) as Dimension; long viewId=NativeModelQueries.ExactId(args,"view_id");
            if(dimension==null || !dimension.IsValidObject || dimension.UniqueId!=expected.UniqueId || dimension.OwnerViewId==null || dimension.OwnerViewId.Value!=viewId || dimension.DimensionType==null || dimension.DimensionType.StyleType!=DimensionStyleType.Linear)
                throw new InvalidOperationException("Dimension identity, owner view or linear type changed.");
            ReferenceArray references=dimension.References; if(references==null || references.Size!=2) throw new InvalidOperationException("Dimension must retain exactly two references.");
            var observed=new List<string>(); foreach(Reference r in references) { if(r==null)throw new InvalidOperationException("Missing reference."); observed.Add(r.ConvertToStableRepresentation(doc)); }
            string a=(string)Required(args,"reference_a"), b=(string)Required(args,"reference_b");
            if(!((observed[0]==a&&observed[1]==b)||(observed[0]==b&&observed[1]==a))) throw new InvalidOperationException("Dimension references changed.");
            DimensionReference(doc,args,"reference_a"); DimensionReference(doc,args,"reference_b");
            Line line=dimension.Curve as Line; XYZ start=MillimeterPoint(Required(args,"start_mm"),"start_mm"), end=MillimeterPoint(Required(args,"end_mm"),"end_mm");
            if(line==null || line.Direction==null || line.Origin==null) throw new InvalidOperationException("Dimension line geometry is unavailable.");
            XYZ direction=line.Direction.Normalize(), requested=end.Subtract(start).Normalize(), delta=start.Subtract(line.Origin);
            if(Math.Abs(Math.Abs(direction.DotProduct(requested))-1)>1e-8 || delta.CrossProduct(direction).GetLength()>Feet(0.001)) throw new InvalidOperationException("Dimension line differs from requested infinite line.");
            if(direction.DotProduct(requested)<0) direction=direction.Negate();
            double? val=dimension.Value; if(!val.HasValue || Double.IsNaN(val.Value)||Double.IsInfinity(val.Value)||val.Value<=0) throw new InvalidOperationException("Dimension measurement is unavailable.");
            return new { element_id=DescribedId(dimension.Id), view_id=DescribedId(dimension.OwnerViewId), reference_a=a, reference_b=b, line_origin_mm=PointDto(line.Origin), line_direction=new {x=direction.X,y=direction.Y,z=direction.Z}, value_internal=val.Value };
        }
    }
}
