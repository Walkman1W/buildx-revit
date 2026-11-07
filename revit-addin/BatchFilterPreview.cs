using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        // Internal candidate only. This is not registered, grants no write
        // authority, and does not perform a parameter Set or transaction.
        // Complete collector traversal is required before any DTO is returned.
        internal static object PreviewBatchParameterFilter(Document doc, string categoryName, long? typeId, long? levelId, long parameterId)
        {
            if (doc == null || !doc.IsValidObject || doc.IsFamilyDocument || doc.IsLinked || String.IsNullOrWhiteSpace(doc.PathName))
                throw new InvalidOperationException("A valid saved project document is required.");
            BuiltInCategory category;
            if (String.IsNullOrEmpty(categoryName) || !categoryName.StartsWith("OST_", StringComparison.Ordinal) || !Enum.TryParse<BuiltInCategory>(categoryName, false, out category) || !Enum.IsDefined(typeof(BuiltInCategory), category))
                throw new InvalidOperationException("An exact BuiltInCategory name is required.");
            Category actualCategory = Category.GetCategory(doc, category);
            if (actualCategory == null || actualCategory.Id == null || actualCategory.Id.Value != (long)category)
                throw new InvalidOperationException("The selected category is unavailable in this document.");
            if (parameterId == 0 || parameterId == -1) throw new InvalidOperationException("An exact parameter ID is required.");
            if (typeId.HasValue)
            {
                ElementType type = RequiredElement(doc, typeId.Value) as ElementType;
                if (type == null || !type.IsValidObject || type.Category == null || type.Category.Id == null || type.Category.Id.Value != (long)category)
                    throw new InvalidOperationException("type_id must be an actual type of the requested category.");
            }
            if (levelId.HasValue)
            {
                Level level = RequiredElement(doc, levelId.Value) as Level;
                if (level == null || !level.IsValidObject) throw new InvalidOperationException("level_id must identify a current-document level.");
            }
            var budget = new NativeModelQueries.ReadBudget(20000);
            var ids = new SortedDictionary<long, string>(); var uniqueIds = new HashSet<string>(StringComparer.Ordinal);
            using (var collector = new FilteredElementCollector(doc).OfCategory(category).WhereElementIsNotElementType())
            {
                foreach (Element element in collector)
                {
                    budget.Scan();
                    if (element == null || !element.IsValidObject || element is ElementType || element.Id == null || element.Id.Value <= 0 || element.Document == null || !element.Document.Equals(doc) || element.Category == null || element.Category.Id == null || element.Category.Id.Value != (long)category)
                        throw new InvalidOperationException("A filtered instance identity could not be verified.");
                    if (typeId.HasValue && (element.GetTypeId() == null || element.GetTypeId().Value != typeId.Value)) continue;
                    if (levelId.HasValue && (element.LevelId == null || element.LevelId.Value != levelId.Value)) continue;
                    string uid = element.UniqueId;
                    if (String.IsNullOrWhiteSpace(uid) || uid.Length > 256 || ids.ContainsKey(element.Id.Value) || !uniqueIds.Add(uid)) throw new InvalidOperationException("Filtered identities are missing or duplicated.");
                    if (ids.Count >= 50) throw new InvalidOperationException("More than 50 matching instances; no partial impact is returned.");
                    ids.Add(element.Id.Value, uid);
                }
            }
            var rows = new List<object>();
            foreach (var entry in ids)
            {
                Element owner; Parameter parameter = ResolveInstanceParameter(doc, entry.Key, parameterId, out owner);
                if (!String.Equals(owner.UniqueId, entry.Value, StringComparison.Ordinal) || parameter.Definition == null || parameter.IsReadOnly ||
                    (parameter.StorageType != StorageType.Double && parameter.StorageType != StorageType.Integer && parameter.StorageType != StorageType.String))
                    throw new InvalidOperationException("Every matching instance requires the exact writable scalar instance parameter.");
                object value = InternalValue(parameter);
                if (value is double && (Double.IsNaN((double)value) || Double.IsInfinity((double)value)) || value is string && ((string)value).Length > 4000)
                    throw new InvalidOperationException("Parameter raw value exceeds the preview bounds.");
                var row = new { element_id = NativeModelQueries.SignedId(owner.Id), unique_id = owner.UniqueId, parameter_id = NativeModelQueries.SignedId(parameter.Id),
                    storage_type = parameter.StorageType.ToString(), has_value = parameter.HasValue, value_internal = value, data_type = ParameterDataType(parameter) };
                budget.Reserve(row); rows.Add(row);
            }
            return new { schema_version = 1, scope = "exact_category_type_level_instances", category = categoryName, type_id = typeId.HasValue ? NativeModelQueries.SignedId(new ElementId(typeId.Value)) : null,
                level_id = levelId.HasValue ? NativeModelQueries.SignedId(new ElementId(levelId.Value)) : null, parameter_id = NativeModelQueries.SignedId(new ElementId(parameterId)),
                scanned = budget.Scanned, complete = true, total = rows.Count, items = rows.ToArray(), write_authorization = "not_granted" };
        }
    }
}
