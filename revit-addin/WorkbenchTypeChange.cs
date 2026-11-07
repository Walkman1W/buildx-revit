using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        private sealed class TypeChangeExpectation
        {
            internal long ElementId, BeforeTypeId, TargetTypeId;
            internal string UniqueId;
        }

        private static TypeChangeExpectation ChangeElementType(Document doc, Dictionary<string, object> args)
        {
            Fields(args, "expected_document", "mode", "element_id", "target_type_id");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Type changes require a project document.");
            long id = NativeModelQueries.ExactId(args, "element_id"), target = NativeModelQueries.ExactId(args, "target_type_id");
            Element element = RequiredElement(doc, id);
            ElementType type = RequiredElement(doc, target) as ElementType;
            if (element is ElementType || !element.IsValidObject || element.GroupId == null || element.GroupId.Value != ElementId.InvalidElementId.Value)
                throw new InvalidOperationException("element_id must identify an ungrouped valid instance.");
            if (type == null || !type.IsValidObject || !element.IsValidType(type.Id)) throw new InvalidOperationException("target_type_id is not a compatible element type.");
            ElementId before = element.GetTypeId();
            if (before == null || before.Value <= 0 || String.IsNullOrEmpty(element.UniqueId)) throw new InvalidOperationException("Original element identity or type is unavailable.");
            var expected = new TypeChangeExpectation { ElementId = id, BeforeTypeId = before.Value, TargetTypeId = target, UniqueId = element.UniqueId };
            if (before.Value != target)
            {
                ElementId replacement = element.ChangeTypeId(type.Id);
                if (replacement == null || replacement.Value != ElementId.InvalidElementId.Value)
                    throw new InvalidOperationException("Type change replaced the element; this operation does not support replacement and must roll back.");
            }
            VerifyTypeChange(doc, expected);
            return expected;
        }

        private static object VerifyTypeChange(Document doc, TypeChangeExpectation expected)
        {
            Element current = doc.GetElement(new ElementId(expected.ElementId));
            if (current == null || !current.IsValidObject || current is ElementType || current.GroupId == null || current.GroupId.Value != ElementId.InvalidElementId.Value
                || !String.Equals(current.UniqueId, expected.UniqueId, StringComparison.Ordinal) || current.GetTypeId() == null || current.GetTypeId().Value != expected.TargetTypeId)
                throw new InvalidOperationException("Type change identity, grouping or type readback changed.");
            return new { element_id = DescribedId(current.Id), before_type_id = DescribedId(new ElementId(expected.BeforeTypeId)), target_type_id = DescribedId(current.GetTypeId()), changed = expected.BeforeTypeId != expected.TargetTypeId };
        }
    }
}
