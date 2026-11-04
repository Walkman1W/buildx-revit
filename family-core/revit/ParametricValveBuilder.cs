using System;
using System.Collections.Generic;
using System.Linq;
using System.Globalization;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Plumbing;

namespace BuildX.FamilyRevit
{
    // Independent demonstration geometry. The caller owns the family document
    // and its transaction; this class never saves, loads, closes or switches a
    // project document. Successful compilation is not a Revit runtime test.
    public static class ParametricValveBuilder
    {
        public const string FirstTypeName = "BuildX_Valve_A";
        public const string SecondTypeName = "BuildX_Valve_B";
        private const double MmPerFoot = 304.8;
        private const double GeometryToleranceMm = 0.05;

        public static Dictionary<string, object> Build(Document familyDoc, double lengthMm, double diameterMm)
        { return Build(familyDoc, lengthMm, diameterMm, null); }

        // The observer is trusted host code, not a model-supplied callback. It
        // receives only fixed phase tags; the host owns exception diagnostics.
        public static Dictionary<string, object> Build(Document familyDoc, double lengthMm, double diameterMm,
            Action<string> observeStage)
        {
            Stage(observeStage, "preflight");
            RequireFamily(familyDoc, true);
            if (!familyDoc.IsModifiable) throw new InvalidOperationException("A caller-owned family transaction is required.");
            ValidateDimensions(familyDoc, lengthMm, diameterMm);
            ValidateDimensions(familyDoc, lengthMm * 1.25, diameterMm * 1.5);
            FamilyManager manager = familyDoc.FamilyManager;
            if (manager.get_Parameter("Length") != null || manager.get_Parameter("Diameter") != null ||
                manager.get_Parameter("ConnectorRadius") != null)
                throw new InvalidOperationException("The fresh family template already contains a reserved valve parameter.");
            if (Elements<Extrusion>(familyDoc).Count != 0 || Elements<ConnectorElement>(familyDoc).Count != 0)
                throw new InvalidOperationException("The valve builder requires a fresh family with no existing extrusion or connector.");
            Stage(observeStage, "find_view");
            View planView = FindPlanView(familyDoc);
            Stage(observeStage, "category");
            Category accessory = Category.GetCategory(familyDoc, BuiltInCategory.OST_PipeAccessory);
            if (accessory == null) throw new InvalidOperationException("The family template does not expose the pipe-accessory category.");
            familyDoc.OwnerFamily.FamilyCategory = accessory;
            familyDoc.Regenerate();
            Parameter partType = familyDoc.OwnerFamily.get_Parameter(BuiltInParameter.FAMILY_CONTENT_PART_TYPE);
            if (partType == null || partType.StorageType != StorageType.Integer ||
                (partType.AsInteger() != (int)PartType.ValveNormal && (partType.IsReadOnly || !partType.Set((int)PartType.ValveNormal))) ||
                partType.AsInteger() != (int)PartType.ValveNormal)
                throw new InvalidOperationException("The template cannot configure a pipe-accessory valve part type.");

            Stage(observeStage, "parameters");
            FamilyType first = manager.NewType(FirstTypeName);
            FamilyParameter length = manager.AddParameter("Length", GroupTypeId.Geometry, SpecTypeId.Length, false);
            FamilyParameter diameter = manager.AddParameter("Diameter", GroupTypeId.Geometry, SpecTypeId.Length, false);
            FamilyParameter connectorRadius = manager.AddParameter("ConnectorRadius", GroupTypeId.Geometry, SpecTypeId.Length, false);
            manager.Set(length, ToFeet(lengthMm)); manager.Set(diameter, ToFeet(diameterMm));
            manager.SetFormula(connectorRadius, "Diameter / 2");

            Stage(observeStage, "extrusion");
            double radiusFeet = ToFeet(diameterMm) / 2;
            var loops = new CurveArrArray();
            var profile = new CurveArray();
            profile.Append(Arc.Create(XYZ.Zero, radiusFeet, 0, Math.PI * 2, XYZ.BasisX, XYZ.BasisY));
            loops.Append(profile);
            SketchPlane sketch = SketchPlane.Create(familyDoc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, XYZ.Zero));
            Extrusion body = familyDoc.FamilyCreate.NewExtrusion(true, loops, sketch, ToFeet(lengthMm));
            Associate(manager, body.get_Parameter(BuiltInParameter.EXTRUSION_END_PARAM), length);
            familyDoc.Regenerate();

            Stage(observeStage, "diameter_dimension");
            Reference arcReference = FindSketchArcReference(familyDoc, body);
            Dimension diameterDimension = familyDoc.FamilyCreate.NewDiameterDimension(planView, arcReference,
                new XYZ(radiusFeet * 1.8, radiusFeet * 1.8, 0));
            diameterDimension.FamilyLabel = diameter;
            familyDoc.Regenerate();

            Stage(observeStage, "connectors");
            Reference[] caps = FindCapReferences(body, ToFeet(lengthMm));
            ConnectorElement bottom = ConnectorElement.CreatePipeConnector(familyDoc, PipeSystemType.Fitting, caps[0]);
            ConnectorElement top = ConnectorElement.CreatePipeConnector(familyDoc, PipeSystemType.Fitting, caps[1]);
            BindConnector(manager, bottom, diameter, connectorRadius, "BuildX inlet");
            BindConnector(manager, top, diameter, connectorRadius, "BuildX outlet");
            bottom.SetLinkedConnectorElement(top);
            familyDoc.Regenerate();

            var checks = new List<Dictionary<string, object>>();
            Stage(observeStage, "validate_A");
            checks.Add(ValidateCurrent(familyDoc, body, diameterDimension, length, diameter, lengthMm, diameterMm));
            Stage(observeStage, "validate_B");
            FamilyType second = manager.NewType(SecondTypeName);
            manager.Set(length, ToFeet(lengthMm * 1.25)); manager.Set(diameter, ToFeet(diameterMm * 1.5));
            familyDoc.Regenerate();
            checks.Add(ValidateCurrent(familyDoc, body, diameterDimension, length, diameter, lengthMm * 1.25, diameterMm * 1.5));
            // Revisit A after B. This catches a geometry profile that only appears
            // parameterized because its first values matched initial static data.
            Stage(observeStage, "restore_A");
            manager.CurrentType = first;
            familyDoc.Regenerate();
            ValidateCurrent(familyDoc, body, diameterDimension, length, diameter, lengthMm, diameterMm);
            Stage(observeStage, "inspect_result");
            Dictionary<string, object> result = Inspect(familyDoc);
            result["family_document_changed"] = true;
            result["parameterization_validated"] = true;
            result["type_validation"] = checks;
            result["type_names"] = new List<string> { first.Name, second.Name };
            result["created_element_ids"] = new List<string> { Id(body.Id), Id(sketch.Id), Id(diameterDimension.Id), Id(bottom.Id), Id(top.Id) };
            result["created_element_ids_complete"] = false;
            result["transaction_owned_by_caller"] = true;
            result["family_transaction_committed"] = false;
            result["saved"] = false; result["loaded_into_project"] = false;
            Stage(observeStage, "complete");
            return result;
        }

        // Bounded read-only template facts for the workflow's pre-build record.
        // Presence is not a parameter value, and category/view inventory does
        // not prove that a later category mutation or dimension can succeed.
        public static Dictionary<string, object> InspectTemplate(Document familyDoc)
        {
            RequireFamily(familyDoc, false);
            FamilyManager manager = familyDoc.FamilyManager;
            int planCount = 0;
            foreach (View view in Elements<View>(familyDoc))
                if (IsPlanView(view)) planCount++;
            Category category = familyDoc.OwnerFamily.FamilyCategory;
            return Map("reserved_parameter_presence", Map("Length", manager.get_Parameter("Length") != null,
                    "Diameter", manager.get_Parameter("Diameter") != null,
                    "ConnectorRadius", manager.get_Parameter("ConnectorRadius") != null),
                "plan_view_count", planCount,
                "initial_category_id", category == null ? null : Id(category.Id),
                "initial_category_name", category == null ? null : category.Name,
                "existing_extrusion_count", Elements<Extrusion>(familyDoc).Count,
                "existing_connector_count", Elements<ConnectorElement>(familyDoc).Count,
                "category_mutation_validated", false, "dimension_creation_validated", false);
        }

        // Read-only inspection of the currently regenerated family state. It
        // neither regenerates nor changes CurrentType, and does not certify all
        // type geometries. Build's type_validation supplies the actual flex run.
        public static Dictionary<string, object> Inspect(Document familyDoc)
        {
            RequireFamily(familyDoc, false);
            FamilyManager manager = familyDoc.FamilyManager;
            FamilyParameter length = manager.get_Parameter("Length");
            FamilyParameter diameter = manager.get_Parameter("Diameter");
            FamilyParameter radius = manager.get_Parameter("ConnectorRadius");
            var types = new List<Dictionary<string, object>>();
            foreach (FamilyType type in manager.Types)
                types.Add(Map("name", type.Name, "length_mm", TypeValue(type, length),
                    "diameter_mm", TypeValue(type, diameter), "connector_radius_mm", TypeValue(type, radius)));
            types.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b) { return StringComparer.Ordinal.Compare((string)a["name"], (string)b["name"]); });
            var connectors = new List<Dictionary<string, object>>();
            foreach (ConnectorElement connector in Elements<ConnectorElement>(familyDoc).OrderBy(item => item.Id.Value))
                connectors.Add(ReadConnector(manager, connector));
            List<Extrusion> bodies = Elements<Extrusion>(familyDoc);
            var associations = new List<Dictionary<string, object>>();
            foreach (Dimension dimension in Elements<Dimension>(familyDoc).OrderBy(item => item.Id.Value))
            {
                FamilyParameter label = dimension.FamilyLabel;
                if (label != null) associations.Add(Map("dimension_id", Id(dimension.Id), "family_parameter", label.Definition.Name));
            }
            return Map("builder", "BuildX.ParametricValve.v1", "family_document", true,
                "family_name", familyDoc.OwnerFamily.Name,
                "category_id", Id(familyDoc.OwnerFamily.FamilyCategory.Id),
                "category_name", familyDoc.OwnerFamily.FamilyCategory.Name,
                "part_type", ReadInteger(familyDoc.OwnerFamily.get_Parameter(BuiltInParameter.FAMILY_CONTENT_PART_TYPE)),
                "current_type", manager.CurrentType == null ? null : manager.CurrentType.Name,
                "parameters", Map("length_name", length == null ? null : length.Definition.Name,
                    "diameter_name", diameter == null ? null : diameter.Definition.Name,
                    "radius_formula", radius == null ? null : radius.Formula),
                "types", types, "connector_count", connectors.Count, "connectors", connectors,
                "body_count", bodies.Count, "body", bodies.Count == 1 ? ReadBody(bodies[0]) : null,
                "dimension_associations", associations, "fresh_regeneration_performed", false,
                "demonstration_only", true,
                "limitations", new List<string> { "Simple solid cylindrical valve body; no bore, actuator, pressure rating or manufacturer certification.",
                    "Family-local connector axis is Z. Project placement and pipe connectivity require separate validation.",
                    "Inspection reads current document geometry; a completed caller transaction and project load are separate results." });
        }

        private static Dictionary<string, object> ValidateCurrent(Document doc, Extrusion body, Dimension diameterDimension,
            FamilyParameter length, FamilyParameter diameter, double expectedLengthMm, double expectedDiameterMm)
        {
            FamilyManager manager = doc.FamilyManager;
            Near(TypeValue(manager.CurrentType, length), expectedLengthMm, "Length family value");
            Near(TypeValue(manager.CurrentType, diameter), expectedDiameterMm, "Diameter family value");
            Parameter end = body.get_Parameter(BuiltInParameter.EXTRUSION_END_PARAM);
            FamilyParameter associatedLength = manager.GetAssociatedFamilyParameter(end);
            if (associatedLength == null || associatedLength.Id != length.Id || diameterDimension.FamilyLabel == null ||
                diameterDimension.FamilyLabel.Id != diameter.Id)
                throw new InvalidOperationException("Native body parameter associations were not preserved.");
            Dictionary<string, object> bodyDto = ReadBody(body);
            Near(bodyDto["length_mm"], expectedLengthMm, "Native body length");
            Near(bodyDto["width_mm"], expectedDiameterMm, "Native body X diameter");
            Near(bodyDto["height_mm"], expectedDiameterMm, "Native body Y diameter");
            double expectedVolume = Math.PI * expectedDiameterMm * expectedDiameterMm * expectedLengthMm / 4;
            double actualVolume = (double)bodyDto["solid_volume_mm3"];
            if (Math.Abs(actualVolume - expectedVolume) > Math.Max(1, expectedVolume * 0.00001))
                throw new InvalidOperationException("The native body volume did not follow the cylindrical size.");
            List<ConnectorElement> connectors = Elements<ConnectorElement>(doc);
            if (connectors.Count != 2) throw new InvalidOperationException("Exactly two family connector elements are required.");
            connectors.Sort(delegate(ConnectorElement a, ConnectorElement b) { return a.Origin.Z.CompareTo(b.Origin.Z); });
            for (int index = 0; index < connectors.Count; index++)
            {
                ConnectorElement connector = connectors[index];
                if (connector.Domain != Domain.DomainPiping || connector.Shape != ConnectorProfileType.Round)
                    throw new InvalidOperationException("A valve connector is not a round piping connector.");
                Near(connector.Origin.X * MmPerFoot, 0, "Connector X"); Near(connector.Origin.Y * MmPerFoot, 0, "Connector Y");
                Near(connector.Origin.Z * MmPerFoot, index == 0 ? 0 : expectedLengthMm, "Connector Z");
                Near(connector.Radius * 2 * MmPerFoot, expectedDiameterMm, "Connector diameter");
                XYZ normal = connector.CoordinateSystem.BasisZ.Normalize();
                if (normal.DotProduct(index == 0 ? -XYZ.BasisZ : XYZ.BasisZ) < 0.9999)
                    throw new InvalidOperationException("A valve connector is not directed outwards from its body end.");
                if (ConnectorAssociation(manager, connector) == null)
                    throw new InvalidOperationException("A connector size is not associated to a family parameter.");
            }
            var connectorDtos = new List<Dictionary<string, object>>();
            foreach (ConnectorElement connector in connectors) connectorDtos.Add(ReadConnector(manager, connector));
            return Map("type_name", manager.CurrentType.Name, "expected_length_mm", expectedLengthMm,
                "expected_diameter_mm", expectedDiameterMm, "body", bodyDto,
                "connectors", connectorDtos, "tolerance_mm", GeometryToleranceMm,
                "expected_volume_mm3", expectedVolume, "volume_error_mm3", actualVolume - expectedVolume,
                "regenerated_and_read_back", true, "passed", true);
        }

        private static void BindConnector(FamilyManager manager, ConnectorElement connector, FamilyParameter diameter,
            FamilyParameter radius, string description)
        {
            Parameter size = connector.get_Parameter(BuiltInParameter.CONNECTOR_RADIUS);
            if (size != null && manager.CanElementParameterBeAssociated(size)) Associate(manager, size, radius);
            else Associate(manager, connector.get_Parameter(BuiltInParameter.CONNECTOR_DIAMETER), diameter);
            Parameter text = connector.get_Parameter(BuiltInParameter.RBS_CONNECTOR_DESCRIPTION);
            if (text != null && !text.IsReadOnly) text.Set(description);
            Parameter direction = connector.get_Parameter(BuiltInParameter.RBS_PIPE_FLOW_DIRECTION_PARAM);
            if (direction != null && !direction.IsReadOnly) direction.Set((int)FlowDirectionType.Bidirectional);
        }

        private static void Associate(FamilyManager manager, Parameter elementParameter, FamilyParameter familyParameter)
        {
            if (elementParameter == null || !manager.CanElementParameterBeAssociated(elementParameter))
                throw new InvalidOperationException("A required native parameter cannot be associated to a family parameter.");
            manager.AssociateElementParameterToFamilyParameter(elementParameter, familyParameter);
        }

        private static string ConnectorAssociation(FamilyManager manager, ConnectorElement connector)
        {
            Parameter radius = connector.get_Parameter(BuiltInParameter.CONNECTOR_RADIUS);
            FamilyParameter associated = radius == null ? null : manager.GetAssociatedFamilyParameter(radius);
            if (associated == null)
            {
                Parameter diameter = connector.get_Parameter(BuiltInParameter.CONNECTOR_DIAMETER);
                associated = diameter == null ? null : manager.GetAssociatedFamilyParameter(diameter);
            }
            return associated == null ? null : associated.Definition.Name;
        }

        private static Dictionary<string, object> ReadConnector(FamilyManager manager, ConnectorElement connector)
        {
            ConnectorElement linked = connector.GetLinkedConnectorElement();
            return Map("element_id", Id(connector.Id), "domain", connector.Domain.ToString(),
                "shape", connector.Shape.ToString(), "origin_mm", Vector(connector.Origin, MmPerFoot),
                "outward_normal", Vector(connector.CoordinateSystem.BasisZ.Normalize(), 1),
                "diameter_mm", connector.Shape == ConnectorProfileType.Round ? (object)(connector.Radius * 2 * MmPerFoot) : null,
                "size_family_parameter", ConnectorAssociation(manager, connector),
                "system_classification", connector.SystemClassification.ToString(),
                "flow_direction", connector.Direction.ToString(), "is_primary", connector.IsPrimary,
                "linked_connector_id", linked == null ? null : Id(linked.Id));
        }

        private static Dictionary<string, object> ReadBody(Extrusion body)
        {
            BoundingBoxXYZ box = body.get_BoundingBox(null);
            if (box == null) throw new InvalidOperationException("The native valve body has no bounding box.");
            XYZ min = null, max = null;
            for (int x = 0; x < 2; x++) for (int y = 0; y < 2; y++) for (int z = 0; z < 2; z++)
            {
                XYZ point = box.Transform.OfPoint(new XYZ(x == 0 ? box.Min.X : box.Max.X,
                    y == 0 ? box.Min.Y : box.Max.Y, z == 0 ? box.Min.Z : box.Max.Z));
                min = min == null ? point : new XYZ(Math.Min(min.X, point.X), Math.Min(min.Y, point.Y), Math.Min(min.Z, point.Z));
                max = max == null ? point : new XYZ(Math.Max(max.X, point.X), Math.Max(max.Y, point.Y), Math.Max(max.Z, point.Z));
            }
            double volume = 0;
            var options = new Options { ComputeReferences = false, DetailLevel = ViewDetailLevel.Fine };
            foreach (GeometryObject geometry in body.get_Geometry(options))
            {
                Solid solid = geometry as Solid;
                if (solid != null && solid.Volume > 0) volume += solid.Volume;
            }
            if (volume <= 0) throw new InvalidOperationException("The native valve body has no positive solid volume.");
            return Map("element_id", Id(body.Id), "min_mm", Vector(min, MmPerFoot), "max_mm", Vector(max, MmPerFoot),
                "length_mm", (max.Z - min.Z) * MmPerFoot, "width_mm", (max.X - min.X) * MmPerFoot,
                "height_mm", (max.Y - min.Y) * MmPerFoot, "solid_volume_mm3", volume * MmPerFoot * MmPerFoot * MmPerFoot);
        }

        private static Reference FindSketchArcReference(Document doc, Extrusion body)
        {
            foreach (CurveArray loop in body.Sketch.Profile) foreach (Curve curve in loop)
                if (curve is Arc && curve.Reference != null) return curve.Reference;
            foreach (ElementId id in body.Sketch.GetAllElements())
            {
                ModelCurve model = doc.GetElement(id) as ModelCurve;
                if (model != null && model.GeometryCurve is Arc && model.GeometryCurve.Reference != null)
                    return model.GeometryCurve.Reference;
            }
            throw new InvalidOperationException("The extrusion sketch exposes no native circular reference for a driving diameter label.");
        }

        private static Reference[] FindCapReferences(Extrusion body, double lengthFeet)
        {
            Reference bottom = null, top = null;
            var options = new Options { ComputeReferences = true, DetailLevel = ViewDetailLevel.Fine };
            foreach (GeometryObject geometry in body.get_Geometry(options))
            {
                Solid solid = geometry as Solid; if (solid == null || solid.Volume <= 0) continue;
                foreach (Face face in solid.Faces)
                {
                    PlanarFace planar = face as PlanarFace;
                    if (planar == null || Math.Abs(planar.FaceNormal.DotProduct(XYZ.BasisZ)) < 0.9999) continue;
                    if (Math.Abs(planar.Origin.Z) < GeometryToleranceMm / MmPerFoot) bottom = planar.Reference;
                    if (Math.Abs(planar.Origin.Z - lengthFeet) < GeometryToleranceMm / MmPerFoot) top = planar.Reference;
                }
            }
            if (bottom == null || top == null) throw new InvalidOperationException("The native body does not expose two planar end-face references.");
            return new[] { bottom, top };
        }

        private static View FindPlanView(Document doc)
        {
            View selected = null;
            foreach (View view in Elements<View>(doc))
                if (IsPlanView(view) &&
                    (selected == null || view.Id.Value < selected.Id.Value)) selected = view;
            if (selected == null) throw new InvalidOperationException("The family template has no plan view for a native driving diameter dimension.");
            return selected;
        }

        private static bool IsPlanView(View view)
        { return !view.IsTemplate && (view.ViewType == ViewType.FloorPlan || view.ViewType == ViewType.CeilingPlan) &&
            Math.Abs(view.ViewDirection.Normalize().DotProduct(XYZ.BasisZ)) > 0.9999; }

        private static List<T> Elements<T>(Document doc) where T : Element
        {
            var result = new List<T>();
            foreach (Element element in new FilteredElementCollector(doc).OfClass(typeof(T)))
                result.Add((T)element);
            return result;
        }

        private static object TypeValue(FamilyType type, FamilyParameter parameter)
        { if (type == null || parameter == null) return null; double? value = type.AsDouble(parameter); return value.HasValue ? (object)(value.Value * MmPerFoot) : null; }
        private static object ReadInteger(Parameter parameter)
        { return parameter == null || parameter.StorageType != StorageType.Integer ? null : (object)parameter.AsInteger(); }
        private static double[] Vector(XYZ vector, double scale)
        { return new[] { vector.X * scale, vector.Y * scale, vector.Z * scale }; }
        private static string Id(ElementId id) { return id.Value.ToString(CultureInfo.InvariantCulture); }
        private static double ToFeet(double mm) { return mm / MmPerFoot; }
        private static void Near(object actual, double expected, string field)
        { if (!(actual is double) || Math.Abs((double)actual - expected) > GeometryToleranceMm) throw new InvalidOperationException(field + " did not follow the requested family size."); }
        private static Dictionary<string, object> Map(params object[] pairs)
        { var result = new Dictionary<string, object>(StringComparer.Ordinal); for (int i = 0; i < pairs.Length; i += 2) result.Add((string)pairs[i], pairs[i + 1]); return result; }
        private static void Stage(Action<string> observer, string phase)
        { if (observer != null) observer(phase); }
        private static void RequireFamily(Document doc, bool requireEditable)
        {
            if (doc == null || !doc.IsValidObject || !doc.IsFamilyDocument || doc.IsLinked ||
                (requireEditable && doc.IsReadOnly) || doc.OwnerFamily == null)
                throw new InvalidOperationException("A valid family document in the required edit state is required.");
        }
        private static void ValidateDimensions(Document doc, double lengthMm, double diameterMm)
        {
            if (Double.IsNaN(lengthMm) || Double.IsInfinity(lengthMm) || Double.IsNaN(diameterMm) || Double.IsInfinity(diameterMm) ||
                ToFeet(lengthMm) <= doc.Application.ShortCurveTolerance || ToFeet(diameterMm) / 2 <= doc.Application.ShortCurveTolerance ||
                !XYZ.IsWithinLengthLimits(new XYZ(ToFeet(diameterMm), ToFeet(diameterMm), ToFeet(lengthMm))))
                throw new ArgumentOutOfRangeException("lengthMm", "Valve dimensions must be finite, exceed Revit geometry tolerance and remain within Revit design limits.");
        }
    }
}
