using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    // Unregistered read-only preparation: no shared-parameter file access,
    // global application setting changes, Revit transaction or write authorization.
    internal static class ProjectParameterPreparation
    {
        internal static object Inspect(Document doc, Guid guid, IList<long> requestedCategories)
        {
            if (doc == null || doc.IsFamilyDocument || guid == Guid.Empty) throw new InvalidOperationException("A project document and nonempty GUID are required.");
            if (requestedCategories == null || requestedCategories.Count < 1 || requestedCategories.Count > 30 || requestedCategories.Distinct().Count() != requestedCategories.Count || requestedCategories.Any(id => id == 0 || id == -1))
                throw new InvalidOperationException("Provide 1..30 distinct explicit category IDs.");
            var categories = new Dictionary<long, Category>();
            foreach (Category c in doc.Settings.Categories)
            {
                if (c == null || c.Id == null) throw new InvalidOperationException("Category identity unavailable.");
                if (categories.ContainsKey(c.Id.Value)) throw new InvalidOperationException("Duplicate category identity.");
                categories.Add(c.Id.Value, c);
                if (categories.Count > 10000) throw new InvalidOperationException("Category scan exceeds budget.");
            }
            var requested = new List<object>();
            foreach (long id in requestedCategories.OrderBy(x => x))
            {
                Category c; if (!categories.TryGetValue(id, out c) || !c.AllowsBoundParameters || String.IsNullOrEmpty(c.Name)) throw new InvalidOperationException("A requested top-level category is unavailable or cannot be bound.");
                requested.Add(new { category_id = id.ToString(CultureInfo.InvariantCulture), category_name = c.Name });
            }
            SharedParameterElement element = SharedParameterElement.Lookup(doc, guid);
            string state = "absent", kind = null, name = null, dataType = null, parameterId = null;
            var bound = new List<string>();
            if (element != null)
            {
                if (!element.IsValidObject || element.Document == null || !element.Document.Equals(doc) || element.GuidValue != guid || element.Id == null || element.Id.Value <= 0) throw new InvalidOperationException("Shared parameter identity is inconsistent.");
                InternalDefinition definition = element.GetDefinition();
                if (definition == null || definition.Id == null || definition.Id.Value != element.Id.Value) throw new InvalidOperationException("Internal definition identity unavailable.");
                name = definition.Name; if (String.IsNullOrEmpty(name)) throw new InvalidOperationException("Definition name unavailable."); var spec = definition.GetDataType(); dataType = spec == null ? null : spec.TypeId;
                parameterId = element.Id.Value.ToString(CultureInfo.InvariantCulture);
                if (!doc.ParameterBindings.Contains(definition)) state = "present_unbound";
                else
                {
                    ElementBinding binding = doc.ParameterBindings.get_Item(definition) as ElementBinding;
                    if (binding == null || binding.Categories == null) throw new InvalidOperationException("Binding category facts unavailable.");
                    if (binding is InstanceBinding) kind = "instance"; else if (binding is TypeBinding) kind = "type"; else throw new InvalidOperationException("Unsupported binding kind.");
                    var seen = new HashSet<long>();
                    foreach (Category c in binding.Categories)
                    {
                        if (c == null || c.Id == null || c.Id.Value == 0 || c.Id.Value == -1 || !seen.Add(c.Id.Value) || seen.Count > 200) throw new InvalidOperationException("Binding category identity is missing, duplicated or exceeds budget.");
                    }
                    bound = seen.OrderBy(x => x).Select(x => x.ToString(CultureInfo.InvariantCulture)).ToList(); state = "bound";
                }
            }
            return new { schema_version = 1, guid = guid.ToString("D"), state, parameter_id = parameterId, name, data_type = dataType,
                binding_kind = kind, bound_category_ids = bound.ToArray(), requested_categories = requested.ToArray(),
                scope = "current_document_top_level_categories", write_authorization = "not_granted", external_definition_verified = false,
                impact_assessed = false, shared_parameter_file_accessed = false };
        }
    }
}
