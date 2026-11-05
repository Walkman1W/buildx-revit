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
        internal static bool IsRead(string operation) { return operation == "get_type_parameters" || operation == "get_parameter_value" || operation == "get_type_parameter_impact"; }

        internal static object Read(UIApplication uiapp, string operation, Dictionary<string, object> args)
        {
            if (!IsRead(operation)) throw new InvalidOperationException("Unknown native parameter query.");
            if (args == null) throw new InvalidOperationException("Native parameter query arguments are required.");
            bool singleParameter = operation == "get_parameter_value";
            bool typeImpact = operation == "get_type_parameter_impact";
            foreach (string key in args.Keys)
                if (typeImpact ? key != "expected_document" && key != "type_id" && key != "parameter_id" :
                    key != "expected_document" && key != "element_id" && !(singleParameter && (key == "parameter_id" || key == "parameter_name")))
                    throw new InvalidOperationException("Unknown argument: " + key);
            var budget = typeImpact ? new NativeModelQueries.ReadBudget(20000) : new NativeModelQueries.ReadBudget();
            Document doc = uiapp == null || uiapp.ActiveUIDocument == null ? null : uiapp.ActiveUIDocument.Document;
            if (doc == null) throw new InvalidOperationException("Open a Revit document before this query.");
            if (typeImpact) return TypeParameterImpact(doc, args, budget);
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
            Parameter selected = SelectParameter(source, args, budget);
            object result = new { schema_version = 1, element_id = NativeModelQueries.SignedId(source.Id), element_name = source.Name,
                parameter = WorkbenchActions.DescribeParameter(selected, true) };
            budget.Reserve(result);
            return result;
        }

        private static Parameter SelectParameter(Element source, Dictionary<string, object> args, NativeModelQueries.ReadBudget budget)
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
            return selected;
        }

        internal sealed class TypeImpactSnapshot
        {
            internal readonly long TypeId;
            internal readonly string TypeName;
            internal readonly object ParameterFact, Coverage;
            private readonly string[] ids;
            internal TypeImpactSnapshot(long typeId, string typeName, object parameter, string[] instanceIds, object coverage)
            { TypeId = typeId; TypeName = typeName; ParameterFact = parameter; ids = (string[])instanceIds.Clone(); Coverage = coverage; }
            internal string[] InstanceIds { get { return (string[])ids.Clone(); } }
            internal object Dto() { return new { schema_version = 1, type_id = NativeModelQueries.SignedId(new ElementId(TypeId)), type_name = TypeName,
                parameter = ParameterFact, instance_ids = InstanceIds, instance_count = ids.Length, coverage = Coverage, write_authorization = "not_granted" }; }
        }

        private static object TypeParameterImpact(Document doc, Dictionary<string, object> args, NativeModelQueries.ReadBudget budget)
        {
            long typeId = NativeModelQueries.ExactId(args, "type_id");
            if (!args.ContainsKey("parameter_id")) throw new InvalidOperationException("Exactly one parameter_id selector is required.");
            long parameterId = NativeModelQueries.ExactSignedId(args, "parameter_id");
            ElementType type; Parameter selected;
            return CaptureTypeImpact(doc, typeId, parameterId, budget, out type, out selected).Dto();
        }

        internal static TypeImpactSnapshot CaptureTypeImpact(Document doc, long typeId, long parameterId, NativeModelQueries.ReadBudget budget, out ElementType type, out Parameter selected)
        {
            selected = ResolveTypeParameter(doc, typeId, parameterId, budget, out type);
            object parameter = WorkbenchActions.DescribeParameter(selected, true);
            budget.Reserve(new { schema_version = 1, type_id = NativeModelQueries.SignedId(type.Id), type_name = type.Name, parameter });
            var instanceIds = new List<long>();
            var scannedIds = new HashSet<long>();
            int scannedElements = 0;
            using (var collector = new FilteredElementCollector(doc).WhereElementIsNotElementType())
            {
                foreach (Element candidate in collector)
                {
                    budget.Scan();
                    scannedElements++;
                    if (candidate == null || candidate is ElementType || !candidate.IsValidObject || candidate.Id == null || candidate.Id.Value <= 0 || candidate.Id.Value == typeId ||
                        candidate.Document == null || !candidate.Document.Equals(doc))
                        throw new InvalidOperationException("Cannot prove complete type impact: an element source is invalid or belongs to another document.");
                    if (!scannedIds.Add(candidate.Id.Value)) throw new InvalidOperationException("Cannot prove complete type impact: duplicate element identity.");
                    ElementId reference = candidate.GetTypeId();
                    if (reference == null) throw new InvalidOperationException("Cannot prove complete type impact: an element returned a null type reference.");
                    if (reference.Value <= 0 || reference.Value != typeId) continue;
                    if (instanceIds.Count >= 500) throw new InvalidOperationException("Type impact exceeds 500 direct instances; no partial result published.");
                    instanceIds.Add(candidate.Id.Value);
                    budget.Reserve(NativeModelQueries.SignedId(candidate.Id));
                }
            }
            instanceIds.Sort();
            string[] ids = new string[instanceIds.Count];
            for (int index = 0; index < instanceIds.Count; index++) ids[index] = NativeModelQueries.SignedId(new ElementId(instanceIds[index]));
            object coverage = new { complete = true, scope = "current_document_direct_type_references", scanned_elements = scannedElements, indirect_effects = "not_assessed" };
            budget.Reserve(new { instance_count = ids.Length, coverage, write_authorization = "not_granted" });
            return new TypeImpactSnapshot(typeId, type.Name, parameter, ids, coverage);
        }

        internal static Parameter ResolveTypeParameter(Document doc, long typeId, long parameterId, NativeModelQueries.ReadBudget budget, out ElementType type)
        {
            type = doc.GetElement(new ElementId(typeId)) as ElementType;
            if (type == null || !type.IsValidObject || type.Id == null || type.Id.Value != typeId || type.Document == null || !type.Document.Equals(doc))
                throw new InvalidOperationException("type_id must identify the exact valid ElementType in the current document.");
            Parameter selected = SelectParameter(type, new Dictionary<string, object> { { "parameter_id", NativeModelQueries.SignedId(new ElementId(parameterId)) } }, budget);
            RequireTypeOwner(doc, type, selected, typeId, parameterId);
            return selected;
        }
        internal static void RequireTypeOwner(Document doc, ElementType type, Parameter selected, long typeId, long parameterId)
        {
            Element owner = selected.Element;
            if (!type.IsValidObject || type.Id == null || type.Id.Value != typeId || type.Document == null || !type.Document.Equals(doc) || selected.Id == null || selected.Id.Value != parameterId ||
                !(owner is ElementType) || !owner.IsValidObject || owner.Id == null || owner.Id.Value != typeId || owner.Document == null || !owner.Document.Equals(doc))
                throw new InvalidOperationException("Parameter is not owned by the explicitly selected ElementType in the current document.");
        }
    }
}
