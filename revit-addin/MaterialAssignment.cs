using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        private sealed class MaterialAssignmentExpectation
        {
            internal long ElementId, ParameterId, MaterialId;
        }

        private static Parameter MaterialInstanceParameter(Document doc, long elementId, long parameterId, out Element element, bool writable)
        {
            Parameter parameter = ResolveInstanceParameter(doc, elementId, parameterId, out element, writable);
            ForgeTypeId dataType = parameter.Definition.GetDataType();
            if (parameter.StorageType != StorageType.ElementId || dataType == null || dataType != SpecTypeId.Reference.Material)
                throw new InvalidOperationException("The exact instance parameter must have ElementId storage and Material data type.");
            return parameter;
        }

        private static object SetElementMaterial(Document doc, Dictionary<string, object> args, out MaterialAssignmentExpectation expectation)
        {
            Fields(args, "expected_document", "mode", "element_id", "parameter_id", "material_id", "expected_has_value", "expected_value_internal");
            long elementId = NativeModelQueries.ExactId(args, "element_id"), parameterId = NativeModelQueries.ExactSignedId(args, "parameter_id"), materialId = NativeModelQueries.ExactId(args, "material_id");
            if (parameterId == 0 || parameterId == -1) throw new InvalidOperationException("An exact parameter identity is required.");
            object expectedHas = Required(args, "expected_has_value"), raw;
            if (!(expectedHas is bool) || !args.TryGetValue("expected_value_internal", out raw)) throw new InvalidOperationException("The exact prior parameter state is required.");
            bool has = (bool)expectedHas;
            if (!has || raw == null) throw new InvalidOperationException("A populated prior material parameter value is required.");
            long? expectedBefore = has ? (long?)ExactMaterialOldValue(args, raw) : null;
            Material material = RequiredElement(doc, materialId) as Material;
            if (material == null || !material.IsValidObject || material.Document == null || !material.Document.Equals(doc)) throw new InvalidOperationException("material_id must identify a valid material in this document.");
            Element element;
            Parameter parameter = MaterialInstanceParameter(doc, elementId, parameterId, out element, true);
            ElementId previous = parameter.HasValue ? parameter.AsElementId() : null;
            if (parameter.HasValue != has || has && (previous == null || previous.Value != expectedBefore.Value)) throw new InvalidOperationException("Material parameter state changed since the approved read.");
            bool changed = !has || previous.Value != materialId;
            if (changed) parameter.Set(material.Id);
            expectation = new MaterialAssignmentExpectation { ElementId = elementId, ParameterId = parameterId, MaterialId = materialId };
            VerifyElementMaterial(doc, expectation);
            return new { element_id = NativeModelQueries.SignedId(element.Id), parameter_id = NativeModelQueries.SignedId(parameter.Id), material_id = NativeModelQueries.SignedId(material.Id), before_has_value = has, before_value_internal = has ? NativeModelQueries.SignedId(previous) : null, changed = changed };
        }

        private static long ExactMaterialOldValue(Dictionary<string, object> args, object raw)
        {
            if (raw is string && (string)raw == "-1" || raw is int && (int)raw == -1 || raw is long && (long)raw == -1L || raw is double && (double)raw == -1d || raw is decimal && (decimal)raw == -1m) return -1;
            if (raw is string && (string)raw == "0" || raw is int && (int)raw == 0 || raw is long && (long)raw == 0L || raw is double && (double)raw == 0d || raw is decimal && (decimal)raw == 0m) return 0;
            return NativeModelQueries.ExactSignedId(args, "expected_value_internal");
        }

        private static void VerifyElementMaterial(Document doc, MaterialAssignmentExpectation expectation)
        {
            Element element;
            Parameter parameter = MaterialInstanceParameter(doc, expectation.ElementId, expectation.ParameterId, out element, false);
            Material material = RequiredElement(doc, expectation.MaterialId) as Material;
            if (material == null || !material.IsValidObject || !parameter.HasValue || parameter.AsElementId() == null || parameter.AsElementId().Value != expectation.MaterialId)
                throw new InvalidOperationException("Material parameter did not retain the requested material.");
        }
    }
}
