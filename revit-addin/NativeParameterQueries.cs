using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    // Read-only parameter queries. The existing host binds the document and owns
    // the atomic receipt; this service neither starts transactions nor writes.
    internal static class NativeParameterQueries
    {
        internal static bool IsRead(string operation) { return operation == "get_type_parameters" || operation == "get_parameter_value"; }

        internal static object Read(UIApplication uiapp, string operation, Dictionary<string, object> args)
        {
            if (!IsRead(operation)) throw new InvalidOperationException("Unknown native parameter query.");
            if (args == null) throw new InvalidOperationException("Native parameter query arguments are required.");
            bool singleParameter = operation == "get_parameter_value";
            foreach (string key in args.Keys)
                if (key != "expected_document" && key != "element_id" && !(singleParameter && (key == "parameter_id" || key == "parameter_name")))
                    throw new InvalidOperationException("Unknown argument: " + key);
            var budget = new NativeModelQueries.ReadBudget();
            Document doc = uiapp == null || uiapp.ActiveUIDocument == null ? null : uiapp.ActiveUIDocument.Document;
            if (doc == null) throw new InvalidOperationException("Open a Revit document before this query.");
            long sourceId = NativeModelQueries.ExactId(args, "element_id");
            Element source = doc.GetElement(new ElementId(sourceId));
            if (source == null || !source.IsValidObject || source.Id == null || source.Id.Value != sourceId)
                throw new InvalidOperationException("Source element does not exist in the current document.");
            if (singleParameter) return SingleParameter(source, args, budget);
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

        private static object SingleParameter(Element source, Dictionary<string, object> args, NativeModelQueries.ReadBudget budget)
        {
            bool byId = args.ContainsKey("parameter_id"), byName = args.ContainsKey("parameter_name");
            if (byId == byName) throw new InvalidOperationException("Exactly one parameter_id or parameter_name selector is required.");
            long requestedId = byId ? NativeModelQueries.ExactSignedId(args, "parameter_id") : 0;
            string requestedName = null;
            if (byName)
            {
                requestedName = args["parameter_name"] as string;
                if (requestedName == null || requestedName.Length < 1 || requestedName.Length > 1024)
                    throw new InvalidOperationException("parameter_name must be an exact string of 1 to 1024 characters.");
            }
            int scanned = 0, matches = 0;
            var identities = new HashSet<long>();
            Parameter selected = null;
            foreach (Parameter parameter in source.Parameters)
            {
                budget.Scan();
                if (++scanned > 2000) throw new InvalidOperationException("Native parameter query exceeds 2000 parameters; no partial result published.");
                if (parameter == null) throw new InvalidOperationException("Invalid parameter in the selected element.");
                ElementId id = parameter.Id;
                if (id != null && !identities.Add(id.Value)) throw new InvalidOperationException("Duplicate parameter identity in the selected element.");
                bool match = byId ? id != null && id.Value == requestedId : parameter.Definition != null && string.Equals(parameter.Definition.Name, requestedName, StringComparison.Ordinal);
                if (!match) continue;
                if (id == null || id.Value == 0 || id.Value == -1) throw new InvalidOperationException("Matched parameter has no valid parameter identity.");
                selected = parameter;
                matches++;
            }
            if (matches == 0) throw new InvalidOperationException("Parameter was not found on the selected element; no type-parameter fallback is performed.");
            if (matches != 1) throw new InvalidOperationException("Parameter name is ambiguous on the selected element; use a unique parameter_id.");
            object result = new { schema_version = 1, element_id = NativeModelQueries.SignedId(source.Id), element_name = source.Name,
                parameter = WorkbenchActions.DescribeParameter(selected, true) };
            budget.Reserve(result);
            return result;
        }
    }
}
