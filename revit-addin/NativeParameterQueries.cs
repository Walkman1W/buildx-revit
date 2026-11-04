using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    // Read-only type resolution. The existing host binds the document and owns
    // the atomic receipt; this service neither starts transactions nor writes.
    internal static class NativeParameterQueries
    {
        internal static bool IsRead(string operation) { return operation == "get_type_parameters"; }

        internal static object Read(UIApplication uiapp, string operation, Dictionary<string, object> args)
        {
            if (!IsRead(operation)) throw new InvalidOperationException("Unknown native parameter query.");
            if (args == null) throw new InvalidOperationException("Native parameter query arguments are required.");
            foreach (string key in args.Keys)
                if (key != "expected_document" && key != "element_id") throw new InvalidOperationException("Unknown argument: " + key);
            var budget = new NativeModelQueries.ReadBudget();
            Document doc = uiapp == null || uiapp.ActiveUIDocument == null ? null : uiapp.ActiveUIDocument.Document;
            if (doc == null) throw new InvalidOperationException("Open a Revit document before this query.");
            long sourceId = NativeModelQueries.ExactId(args, "element_id");
            Element source = doc.GetElement(new ElementId(sourceId));
            if (source == null || !source.IsValidObject || source.Id == null || source.Id.Value != sourceId)
                throw new InvalidOperationException("Source element does not exist in the current document.");
            ElementType type = source as ElementType;
            bool sourceIsType = type != null;
            if (!sourceIsType)
            {
                ElementId typeId = source.GetTypeId();
                if (typeId == null || typeId.Value <= 0) throw new InvalidOperationException("Source element has no valid type.");
                if (typeId.Value == sourceId) throw new InvalidOperationException("An instance cannot identify itself as its type.");
                type = doc.GetElement(typeId) as ElementType;
                if (type == null || !type.IsValidObject || type.Id == null || type.Id.Value != typeId.Value)
                    throw new InvalidOperationException("Source element type is missing or is not an ElementType.");
            }
            object metadata = new { schema_version = 1, element_id = NativeModelQueries.SignedId(source.Id), element_name = source.Name,
                source_is_type = sourceIsType, type_id = NativeModelQueries.SignedId(type.Id), type_name = type.Name };
            budget.Reserve(metadata);
            object[] parameters = NativeModelQueries.ParameterRows(type, budget);
            return new { schema_version = 1, element_id = NativeModelQueries.SignedId(source.Id), element_name = source.Name,
                source_is_type = sourceIsType, type_id = NativeModelQueries.SignedId(type.Id), type_name = type.Name, parameters };
        }
    }
}
